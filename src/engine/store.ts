import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChannelKind, EngineEvent, JobStatus, MessageContent, MessageStatus } from "./domain.ts";

/**
 * 엔진의 영속 저장소 (SQLite, Node 내장 node:sqlite).
 * - 서버가 죽었다 살아나도 예약된 작업·승인 대기·발송 기록이 남는다.
 * - SQL은 이 파일에만 둔다. 나중에 PostgreSQL 등으로 옮길 때 이 파일만 바꾸면 된다.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE events (
     key TEXT PRIMARY KEY,               -- service:id, 중복 수신 방지
     service TEXT NOT NULL,
     type TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     payload TEXT NOT NULL,
     received_at TEXT NOT NULL
   );
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     event_key TEXT NOT NULL REFERENCES events(key),
     playbook_id TEXT NOT NULL,
     service TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     due_at TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     reason TEXT,                        -- skipped/failed 사유
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (event_key, playbook_id)
   );
   CREATE INDEX jobs_due ON jobs (status, due_at);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     service TEXT NOT NULL,
     playbook_id TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     recipient TEXT NOT NULL,
     title TEXT,
     body TEXT NOT NULL,
     advertising INTEGER NOT NULL,
     consent_ref TEXT,
     status TEXT NOT NULL,
     generation_mode TEXT NOT NULL,
     model TEXT,
     generation_ms INTEGER,
     generation_attempts INTEGER NOT NULL,
     edited INTEGER NOT NULL DEFAULT 0,  -- 승인자가 문구를 고쳤는지 (자동화 품질 지표)
     send_after TEXT,
     send_attempts INTEGER NOT NULL DEFAULT 0,
     provider_ref TEXT,
     error TEXT,
     decided_by TEXT,
     decided_at TEXT,
     note TEXT,
     sent_at TEXT,
     converted_at TEXT,
     conversion_event_key TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX messages_status ON messages (status, send_after);
   CREATE INDEX messages_subject ON messages (service, subject_id, created_at);`,
];

export interface JobRow {
  id: string;
  eventKey: string;
  playbookId: string;
  service: string;
  subjectId: string;
  dueAt: string;
  status: JobStatus;
  attempts: number;
  reason: string | null;
}

export interface MessageRow {
  id: string;
  jobId: string;
  service: string;
  playbookId: string;
  subjectId: string;
  channel: ChannelKind;
  recipient: string;
  title: string | null;
  body: string;
  advertising: boolean;
  consentRef: string | null;
  status: MessageStatus;
  generationMode: "llm" | "template";
  model: string | null;
  generationMs: number | null;
  generationAttempts: number;
  edited: boolean;
  sendAfter: string | null;
  sendAttempts: number;
  providerRef: string | null;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  sentAt: string | null;
  convertedAt: string | null;
  createdAt: string;
}

export interface NewMessage {
  jobId: string;
  service: string;
  playbookId: string;
  subjectId: string;
  channel: ChannelKind;
  recipient: string;
  content: MessageContent;
  advertising: boolean;
  consentRef: string | null;
  status: "pending_approval" | "approved";
  generationMode: "llm" | "template";
  model: string | null;
  generationMs: number | null;
  generationAttempts: number;
  sendAfter: string;
}

type Row = Record<string, unknown>;

const toJob = (r: Row): JobRow => ({
  id: r.id as string,
  eventKey: r.event_key as string,
  playbookId: r.playbook_id as string,
  service: r.service as string,
  subjectId: r.subject_id as string,
  dueAt: r.due_at as string,
  status: r.status as JobStatus,
  attempts: Number(r.attempts),
  reason: (r.reason as string | null) ?? null,
});

const toMessage = (r: Row): MessageRow => ({
  id: r.id as string,
  jobId: r.job_id as string,
  service: r.service as string,
  playbookId: r.playbook_id as string,
  subjectId: r.subject_id as string,
  channel: r.channel as ChannelKind,
  recipient: r.recipient as string,
  title: (r.title as string | null) ?? null,
  body: r.body as string,
  advertising: Number(r.advertising) === 1,
  consentRef: (r.consent_ref as string | null) ?? null,
  status: r.status as MessageStatus,
  generationMode: r.generation_mode as "llm" | "template",
  model: (r.model as string | null) ?? null,
  generationMs: r.generation_ms === null ? null : Number(r.generation_ms),
  generationAttempts: Number(r.generation_attempts),
  edited: Number(r.edited) === 1,
  sendAfter: (r.send_after as string | null) ?? null,
  sendAttempts: Number(r.send_attempts),
  providerRef: (r.provider_ref as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: (r.decided_at as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  sentAt: (r.sent_at as string | null) ?? null,
  convertedAt: (r.converted_at as string | null) ?? null,
  createdAt: r.created_at as string,
});

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export class EngineStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ping(): boolean {
    return (this.db.prepare("SELECT 1 AS ok").get() as Row).ok === 1;
  }

  close(): void {
    this.db.close();
  }

  // ---------- events ----------

  /** 새 이벤트면 true, 이미 받은 이벤트면 false */
  insertEvent(event: EngineEvent, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (key, service, type, subject_id, occurred_at, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(eventKey(event), event.service, event.type, event.subjectId, event.occurredAt, JSON.stringify(event.payload), now);
    return Number(result.changes) === 1;
  }

  getEvent(key: string): EngineEvent {
    const r = this.db.prepare("SELECT * FROM events WHERE key = ?").get(key) as Row | undefined;
    if (!r) throw new Error(`이벤트를 찾을 수 없습니다: ${key}`);
    return {
      id: key.slice((r.service as string).length + 1),
      service: r.service as string,
      type: r.type as string,
      subjectId: r.subject_id as string,
      occurredAt: r.occurred_at as string,
      payload: JSON.parse(r.payload as string) as EngineEvent["payload"],
    };
  }

  // ---------- jobs ----------

  insertJob(input: { eventKey: string; playbookId: string; service: string; subjectId: string; dueAt: string }, now: string): JobRow {
    const id = newId("job");
    this.db
      .prepare(
        `INSERT INTO jobs (id, event_key, playbook_id, service, subject_id, due_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, input.eventKey, input.playbookId, input.service, input.subjectId, input.dueAt, now, now);
    return this.getJob(id);
  }

  getJob(id: string): JobRow {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new Error(`작업을 찾을 수 없습니다: ${id}`);
    return toJob(r);
  }

  /** 실행할 때가 된 작업 하나를 running으로 바꾸고 가져온다. 여러 워커가 같은 작업을 잡지 않는다. */
  claimDueJob(now: string): JobRow | null {
    return this.transaction(() => {
      const r = this.db
        .prepare("SELECT id FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1")
        .get(now) as Row | undefined;
      if (!r) return null;
      this.db
        .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now, r.id as string);
      return this.getJob(r.id as string);
    });
  }

  finishJob(id: string, status: Exclude<JobStatus, "pending" | "running">, reason: string | null, now: string): void {
    this.db.prepare("UPDATE jobs SET status = ?, reason = ?, updated_at = ? WHERE id = ?").run(status, reason, now, id);
  }

  rescheduleJob(id: string, dueAt: string, reason: string, now: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'pending', due_at = ?, reason = ?, updated_at = ? WHERE id = ?")
      .run(dueAt, reason, now, id);
  }

  /** 서버가 처리 도중 죽어 running으로 남은 작업을 다시 대기로 돌린다. */
  recoverStaleJobs(olderThan: string, now: string): number {
    const result = this.db
      .prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running' AND updated_at < ?")
      .run(now, olderThan);
    return Number(result.changes);
  }

  listJobs(filter: { status?: JobStatus; limit?: number } = {}): JobRow[] {
    const rows = filter.status
      ? this.db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(filter.status, filter.limit ?? 100)
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(filter.limit ?? 100);
    return (rows as Row[]).map(toJob);
  }

  // ---------- messages ----------

  insertMessage(input: NewMessage, now: string): MessageRow {
    const id = newId("msg");
    this.db
      .prepare(
        `INSERT INTO messages (id, job_id, service, playbook_id, subject_id, channel, recipient, title, body, advertising,
           consent_ref, status, generation_mode, model, generation_ms, generation_attempts, send_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.service,
        input.playbookId,
        input.subjectId,
        input.channel,
        input.recipient,
        input.content.title ?? null,
        input.content.body,
        input.advertising ? 1 : 0,
        input.consentRef,
        input.status,
        input.generationMode,
        input.model,
        input.generationMs,
        input.generationAttempts,
        input.sendAfter,
        now,
        now,
      );
    return this.getMessage(id);
  }

  getMessage(id: string): MessageRow {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`메시지를 찾을 수 없습니다: ${id}`);
    return toMessage(r);
  }

  listMessages(filter: { status?: MessageStatus; service?: string; limit?: number } = {}): MessageRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.service) {
      where.push("service = ?");
      params.push(filter.service);
    }
    const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, filter.limit ?? 100) as Row[]).map(toMessage);
  }

  /** 승인·반려는 pending_approval 상태에서만 가능하다 (동시에 두 사람이 눌러도 한 번만 반영). */
  decideMessage(
    id: string,
    decision: { status: "approved" | "rejected"; by: string; note: string | null; content?: MessageContent; sendAfter?: string },
    now: string,
  ): MessageRow {
    const current = this.getMessage(id);
    if (current.status !== "pending_approval") throw new ConflictError(`이미 처리된 메시지입니다 (${current.status}).`);
    const edited = decision.content !== undefined && (decision.content.body !== current.body || (decision.content.title ?? null) !== current.title);
    const result = this.db
      .prepare(
        `UPDATE messages SET status = ?, decided_by = ?, decided_at = ?, note = ?, title = ?, body = ?, edited = ?,
           send_after = COALESCE(?, send_after), updated_at = ?
         WHERE id = ? AND status = 'pending_approval'`,
      )
      .run(
        decision.status,
        decision.by,
        now,
        decision.note,
        decision.content ? (decision.content.title ?? null) : current.title,
        decision.content ? decision.content.body : current.body,
        edited ? 1 : 0,
        decision.sendAfter ?? null,
        now,
        id,
      );
    if (Number(result.changes) !== 1) throw new ConflictError("이미 처리된 메시지입니다.");
    return this.getMessage(id);
  }

  /** 발송할 때가 된 승인 메시지 하나를 가져온다. 발송 중 표시로 send_after를 잠시 미룬다(중복 발송 방지). */
  claimDeliverable(now: string, leaseUntil: string): MessageRow | null {
    return this.transaction(() => {
      const r = this.db
        .prepare("SELECT id FROM messages WHERE status = 'approved' AND send_after <= ? ORDER BY send_after LIMIT 1")
        .get(now) as Row | undefined;
      if (!r) return null;
      this.db
        .prepare("UPDATE messages SET send_after = ?, send_attempts = send_attempts + 1, updated_at = ? WHERE id = ?")
        .run(leaseUntil, now, r.id as string);
      return this.getMessage(r.id as string);
    });
  }

  markDelivered(id: string, status: "sent" | "dry_run", providerRef: string | null, now: string): void {
    this.db
      .prepare("UPDATE messages SET status = ?, provider_ref = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(status, providerRef, now, now, id);
  }

  markDeliveryRetry(id: string, sendAfter: string, error: string, now: string): void {
    this.db.prepare("UPDATE messages SET send_after = ?, error = ?, updated_at = ? WHERE id = ?").run(sendAfter, error, now, id);
  }

  markMessageClosed(id: string, status: "failed" | "cancelled", error: string, now: string): void {
    this.db.prepare("UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now, id);
  }

  /** 같은 대상에게 since 이후 만들어진(반려·취소·실패 제외) 메시지 수 */
  countRecentMessages(filter: { service: string; subjectId: string; since: string; playbookId?: string; advertisingOnly?: boolean }): number {
    const conditions = ["service = ?", "subject_id = ?", "created_at >= ?", "status NOT IN ('rejected', 'cancelled', 'failed')"];
    const params: string[] = [filter.service, filter.subjectId, filter.since];
    if (filter.playbookId) {
      conditions.push("playbook_id = ?");
      params.push(filter.playbookId);
    }
    if (filter.advertisingOnly) conditions.push("advertising = 1");
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${conditions.join(" AND ")}`).get(...params) as Row;
    return Number(r.n);
  }

  /** 실제로 발송된 메시지 중 목표 이벤트를 아직 못 받은 것을 전환으로 표시한다. */
  markConversions(input: { service: string; subjectId: string; playbookIds: string[]; sentSince: (playbookId: string) => string; eventKey: string; at: string }): number {
    let changed = 0;
    for (const playbookId of input.playbookIds) {
      const result = this.db
        .prepare(
          `UPDATE messages SET converted_at = ?, conversion_event_key = ?, updated_at = ?
           WHERE service = ? AND subject_id = ? AND playbook_id = ? AND status = 'sent'
             AND converted_at IS NULL AND sent_at >= ? AND sent_at <= ?`,
        )
        .run(input.at, input.eventKey, input.at, input.service, input.subjectId, playbookId, input.sentSince(playbookId), input.at);
      changed += Number(result.changes);
    }
    return changed;
  }

  // ---------- metrics ----------

  jobStats(): Row[] {
    return this.db.prepare("SELECT playbook_id, status, reason, COUNT(*) AS n FROM jobs GROUP BY playbook_id, status, reason").all() as Row[];
  }

  messageStats(): Row[] {
    return this.db
      .prepare(
        `SELECT playbook_id, status, COUNT(*) AS n, SUM(edited) AS edited, SUM(converted_at IS NOT NULL) AS converted,
           AVG(generation_ms) AS avg_ms, SUM(generation_attempts > 1) AS retried
         FROM messages GROUP BY playbook_id, status`,
      )
      .all() as Row[];
  }
}

export function eventKey(event: Pick<EngineEvent, "service" | "id">): string {
  return `${event.service}:${event.id}`;
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}
