import type { DeliveryChannel, ServiceAdapter } from "./connectors.ts";
import { TransientError } from "./connectors.ts";
import type { EngineEvent, MessageContent } from "./domain.ts";
import { ContentGenerator, buildVariables } from "./generator.ts";
import { InputError } from "./input.ts";
import type { Logger } from "./logger.ts";
import type { Playbook } from "./playbook.ts";
import { applyAdvertisingNotice, earliestSendTime, firstFailedCondition, validateContent } from "./rules.ts";
import type { ServiceConfig } from "./services.ts";
import { type EngineStore, type JobRow, type MessageRow, eventKey } from "./store.ts";

/**
 * 엔진 7단계: ① 이벤트 수신 → ② 조건 판단 → ③ 문구 생성(모델) → ④ 검증 → ⑤ 승인 → ⑥ 발송 → ⑦ 측정
 * HTTP·워커와 분리된 순수 처리 로직이라 테스트에서 시계와 연결부를 바꿔 끼워 검증한다.
 */

export interface ServiceRuntime {
  config: ServiceConfig;
  adapter: ServiceAdapter;
  channel: DeliveryChannel;
}

export interface EngineDeps {
  store: EngineStore;
  services: ServiceRuntime[];
  playbooks: Playbook[];
  generator: ContentGenerator;
  logger: Logger;
  clock?: () => Date;
}

/** 작업·발송의 최대 시도 횟수. 넘으면 failed로 닫고 사람이 확인한다. */
export const MAX_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function backoffMs(attempt: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempt - 1));
}

export type JobOutcome = { status: "done"; messageId: string } | { status: "skipped" | "failed" | "deferred"; reason: string };

export class Engine {
  readonly store: EngineStore;
  private readonly services: Map<string, ServiceRuntime>;
  private readonly playbooks: Map<string, Playbook>;
  private readonly generator: ContentGenerator;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.services = new Map(deps.services.map((runtime) => [runtime.config.id, runtime]));
    this.playbooks = new Map(deps.playbooks.map((playbook) => [playbook.id, playbook]));
    this.generator = deps.generator;
    this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
  }

  service(id: string): ServiceRuntime {
    const runtime = this.services.get(id);
    if (!runtime) throw new InputError(`등록되지 않은 서비스입니다: ${id}`);
    return runtime;
  }

  listPlaybooks(): Playbook[] {
    return [...this.playbooks.values()];
  }

  getPlaybook(id: string): Playbook | undefined {
    return this.playbooks.get(id);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  // ① 이벤트 수신 ------------------------------------------------------------

  ingest(event: EngineEvent): { status: "accepted" | "duplicate"; jobs: number; conversions: number } {
    this.service(event.service);
    const now = this.nowIso();
    const key = eventKey(event);
    return this.store.transaction(() => {
      if (!this.store.insertEvent(event, now)) return { status: "duplicate" as const, jobs: 0, conversions: 0 };

      const triggered = this.listPlaybooks().filter((p) => p.enabled && p.service === event.service && p.trigger.event === event.type);
      for (const playbook of triggered) {
        const dueAt = new Date(Date.parse(event.occurredAt) + playbook.trigger.delayMinutes * 60 * 1000).toISOString();
        this.store.insertJob({ eventKey: key, playbookId: playbook.id, service: event.service, subjectId: event.subjectId, dueAt }, now);
      }

      // ⑦ 측정: 이 이벤트가 어떤 플레이북의 목표라면, 기간 안에 보낸 메시지를 전환으로 기록한다.
      const goals = this.listPlaybooks().filter((p) => p.service === event.service && p.goal?.event === event.type);
      const conversions = goals.length
        ? this.store.markConversions({
            service: event.service,
            subjectId: event.subjectId,
            playbookIds: goals.map((p) => p.id),
            sentSince: (id) => new Date(Date.parse(event.occurredAt) - (this.playbooks.get(id)?.goal?.windowDays ?? 0) * DAY_MS).toISOString(),
            eventKey: key,
            at: event.occurredAt,
          })
        : 0;
      this.logger.info("event.accepted", { event: key, type: event.type, jobs: triggered.length, conversions });
      return { status: "accepted" as const, jobs: triggered.length, conversions };
    });
  }

  // ②~⑤ 작업 처리 -----------------------------------------------------------

  async processJob(job: JobRow): Promise<JobOutcome> {
    try {
      const outcome = await this.evaluateAndGenerate(job);
      const now = this.nowIso();
      if (outcome.status === "done") this.store.finishJob(job.id, "done", null, now);
      else if (outcome.status === "skipped" || outcome.status === "failed") this.store.finishJob(job.id, outcome.status, outcome.reason, now);
      this.logger.info("job.processed", { job: job.id, playbook: job.playbookId, subject: job.subjectId, ...outcome });
      return outcome;
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      const now = this.clock();
      // 설정·데이터 오류는 다시 해도 같으므로 바로 실패. 나머지(네트워크·모델 서버)는 간격을 늘려 재시도.
      if (error instanceof InputError || job.attempts >= MAX_ATTEMPTS) {
        this.store.finishJob(job.id, "failed", `error:${message}`, now.toISOString());
        this.logger.error("job.failed", { job: job.id, playbook: job.playbookId, error: message });
        return { status: "failed", reason: `error:${message}` };
      }
      const retryAt = new Date(now.getTime() + backoffMs(job.attempts)).toISOString();
      this.store.rescheduleJob(job.id, retryAt, `retry:${message}`, now.toISOString());
      this.logger.warn("job.retry", { job: job.id, attempts: job.attempts, retryAt, error: message });
      return { status: "deferred", reason: `retry:${message}` };
    }
  }

  private async evaluateAndGenerate(job: JobRow): Promise<JobOutcome> {
    const playbook = this.playbooks.get(job.playbookId);
    if (!playbook || !playbook.enabled) return { status: "skipped", reason: "playbook_disabled" };
    const runtime = this.service(job.service);
    const event = this.store.getEvent(job.eventKey);

    // ② 조건 판단: 서비스에서 최신 상태를 읽어 판단한다 (지연 실행 사이에 상태가 바뀔 수 있음).
    const subject = await runtime.adapter.getSubject(job.subjectId);
    if (!subject) return { status: "skipped", reason: "subject_not_found" };
    const failed = firstFailedCondition(playbook.conditions, subject, event);
    if (failed) return { status: "skipped", reason: failed };
    const recipient = subject.contacts[playbook.channel];
    if (!recipient) return { status: "skipped", reason: `no_contact:${playbook.channel}` };
    if (playbook.advertising && !subject.consents.marketing) return { status: "skipped", reason: "no_marketing_consent" };

    const now = this.clock();
    if (playbook.frequencyDays > 0) {
      const since = new Date(now.getTime() - playbook.frequencyDays * DAY_MS).toISOString();
      if (this.store.countRecentMessages({ service: job.service, subjectId: job.subjectId, playbookId: playbook.id, since }) > 0) {
        return { status: "skipped", reason: "frequency_cap" };
      }
    }
    if (playbook.advertising) {
      const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
      const sent = this.store.countRecentMessages({ service: job.service, subjectId: job.subjectId, since, advertisingOnly: true });
      if (sent >= runtime.config.maxAdsPerSubjectPerWeek) return { status: "skipped", reason: "weekly_ad_cap" };
    }

    // ③ 문구 생성 + ④ 검증 (모델은 여기서만 호출)
    const vars = buildVariables(runtime.config, subject, event);
    const generated = await this.generator.generate(playbook, runtime.config, vars);
    if (!generated.ok) return { status: "failed", reason: `validation_failed:${generated.issues.join(" / ")}` };

    // ⑤ 승인: auto면 바로 발송 대기, manual이면 운영자 대기열로
    const sendAfter = earliestSendTime(now, playbook.advertising, subject).toISOString();
    const message = this.store.insertMessage(
      {
        jobId: job.id,
        service: job.service,
        playbookId: playbook.id,
        subjectId: subject.id,
        channel: playbook.channel,
        recipient,
        content: generated.content,
        advertising: playbook.advertising,
        consentRef: playbook.advertising ? (subject.consents.marketing?.ref ?? null) : null,
        status: playbook.approval === "auto" ? "approved" : "pending_approval",
        generationMode: playbook.generation.mode,
        model: generated.model,
        generationMs: generated.durationMs,
        generationAttempts: generated.attempts,
        sendAfter,
      },
      now.toISOString(),
    );
    return { status: "done", messageId: message.id };
  }

  // ⑤ 승인 ------------------------------------------------------------------

  approve(id: string, by: string, input: { note?: string; content?: MessageContent } = {}): MessageRow {
    const message = this.store.getMessage(id);
    if (input.content) {
      const playbook = this.playbooks.get(message.playbookId);
      if (!playbook) throw new InputError(`플레이북이 없어 수정본을 검증할 수 없습니다: ${message.playbookId}`);
      const issues = validateContent(input.content, playbook.generation.fields, {
        service: this.service(message.service).config,
        inputText: "",
        checkNumbers: false,
      });
      if (issues.length) throw new InputError(`수정한 문구가 규칙에 맞지 않습니다: ${issues.join(" / ")}`);
    }
    const decided = this.store.decideMessage(
      id,
      { status: "approved", by, note: input.note ?? null, ...(input.content ? { content: input.content } : {}) },
      this.nowIso(),
    );
    this.logger.info("message.approved", { message: id, by, edited: decided.edited });
    return decided;
  }

  reject(id: string, by: string, note?: string): MessageRow {
    const decided = this.store.decideMessage(id, { status: "rejected", by, note: note ?? null }, this.nowIso());
    this.logger.info("message.rejected", { message: id, by });
    return decided;
  }

  // ⑥ 발송 ------------------------------------------------------------------

  /** 수신자에게 실제로 나가는 최종 문구 (광고 표기 포함). 승인 화면 미리보기에도 쓴다. */
  finalContent(message: MessageRow): MessageContent {
    const content: MessageContent = { body: message.body, ...(message.title !== null ? { title: message.title } : {}) };
    return message.advertising ? applyAdvertisingNotice(content, this.service(message.service).config) : content;
  }

  async deliver(message: MessageRow): Promise<MessageRow> {
    const runtime = this.service(message.service);
    const now = this.clock();
    try {
      // 승인 대기 사이에 동의를 철회했을 수 있으므로 발송 직전에 다시 확인한다.
      const subject = await runtime.adapter.getSubject(message.subjectId);
      if (!subject) {
        this.store.markMessageClosed(message.id, "cancelled", "subject_not_found", now.toISOString());
        return this.store.getMessage(message.id);
      }
      if (message.advertising && !subject.consents.marketing) {
        this.store.markMessageClosed(message.id, "cancelled", "consent_revoked", now.toISOString());
        this.logger.warn("delivery.cancelled", { message: message.id, reason: "consent_revoked" });
        return this.store.getMessage(message.id);
      }
      const allowedAt = earliestSendTime(now, message.advertising, subject);
      if (allowedAt > now) {
        this.store.markDeliveryRetry(message.id, allowedAt.toISOString(), "deferred_night", now.toISOString());
        return this.store.getMessage(message.id);
      }

      const result = await runtime.channel.deliver({
        messageId: message.id,
        service: message.service,
        playbookId: message.playbookId,
        subjectId: message.subjectId,
        channel: message.channel,
        recipient: subject.contacts[message.channel] ?? message.recipient,
        content: this.finalContent(message),
        advertising: message.advertising,
        consentRef: message.advertising ? (subject.consents.marketing?.ref ?? message.consentRef) : null,
      });
      this.store.markDelivered(message.id, result.status, result.providerRef, now.toISOString());
      this.logger.info("delivery.done", { message: message.id, status: result.status, channel: message.channel });
    } catch (error) {
      const reason = (error as Error).message.slice(0, 300);
      if (error instanceof TransientError && message.sendAttempts < MAX_ATTEMPTS) {
        const retryAt = new Date(now.getTime() + backoffMs(message.sendAttempts)).toISOString();
        this.store.markDeliveryRetry(message.id, retryAt, reason, now.toISOString());
        this.logger.warn("delivery.retry", { message: message.id, attempts: message.sendAttempts, retryAt, error: reason });
      } else {
        this.store.markMessageClosed(message.id, "failed", reason, now.toISOString());
        this.logger.error("delivery.failed", { message: message.id, error: reason });
      }
    }
    return this.store.getMessage(message.id);
  }

  /** 지금 처리할 수 있는 작업과 발송을 모두 처리한다. 워커가 주기적으로 부르고, 테스트에서도 직접 부른다. */
  async runDueWork(limit = 50): Promise<{ jobs: number; deliveries: number }> {
    let jobs = 0;
    let deliveries = 0;
    for (; jobs < limit; jobs++) {
      const job = this.store.claimDueJob(this.nowIso());
      if (!job) break;
      await this.processJob(job);
    }
    for (; deliveries < limit; deliveries++) {
      const now = this.clock();
      const message = this.store.claimDeliverable(now.toISOString(), new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString());
      if (!message) break;
      await this.deliver(message);
    }
    return { jobs, deliveries };
  }
}
