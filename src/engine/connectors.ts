import { readFileSync } from "node:fs";
import { CHANNELS, type ChannelKind, type ConsentRecord, type MessageContent, type Subject } from "./domain.ts";
import { InputError, facts, obj, str } from "./input.ts";
import type { AdapterConfig, DeliveryConfig } from "./services.ts";

/**
 * 연결부(서비스마다 다른 부분). 엔진은 이 두 인터페이스로만 서비스와 대화한다.
 * 새 서비스를 붙일 때는 서비스 쪽에서 integration-contract.md의 API 두 개를 구현하고 services.json에 등록하면 된다.
 */

/** 대상 조회: 조건 판단 직전과 발송 직전에 매번 최신 상태를 읽는다(동의 철회 반영). */
export interface ServiceAdapter {
  getSubject(subjectId: string): Promise<Subject | null>;
}

export interface Delivery {
  messageId: string;
  service: string;
  playbookId: string;
  subjectId: string;
  channel: ChannelKind;
  recipient: string;
  content: MessageContent;
  advertising: boolean;
  consentRef: string | null;
}

export interface DeliveryResult {
  status: "sent" | "dry_run";
  providerRef: string | null;
}

export interface DeliveryChannel {
  deliver(delivery: Delivery): Promise<DeliveryResult>;
}

/** 재시도하면 성공할 수 있는 오류(네트워크, 5xx). 그 외는 바로 실패 처리한다. */
export class TransientError extends Error {
  override name = "TransientError";
}

function parseConsent(value: unknown, path: string): ConsentRecord | null {
  if (value === undefined || value === null) return null;
  const o = obj(value, path);
  return { ref: str(o, "ref", path), grantedAt: str(o, "grantedAt", path) };
}

/** 서비스 응답·픽스처를 같은 규칙으로 검사한다. 잘못된 응답이 엔진 안으로 들어오지 않게 한다. */
export function parseSubject(raw: unknown, path: string): Subject {
  const o = obj(raw, path);
  const contactsRaw = obj(o.contacts ?? {}, `${path}.contacts`);
  const contacts: Partial<Record<ChannelKind, string>> = {};
  for (const [key, value] of Object.entries(contactsRaw)) {
    if (!(CHANNELS as readonly string[]).includes(key)) throw new InputError(`${path}.contacts.${key}: 알 수 없는 채널입니다.`);
    if (typeof value !== "string" || value === "") throw new InputError(`${path}.contacts.${key}: 문자열이어야 합니다.`);
    contacts[key as ChannelKind] = value;
  }
  const consents = obj(o.consents ?? {}, `${path}.consents`);
  return {
    id: str(o, "id", path),
    displayName: str(o, "displayName", path),
    contacts,
    consents: {
      marketing: parseConsent(consents.marketing, `${path}.consents.marketing`),
      nightMarketing: parseConsent(consents.nightMarketing, `${path}.consents.nightMarketing`),
    },
    facts: facts(o.facts, `${path}.facts`),
  };
}

/** 개발·데모용: { "<subjectId>": Subject } 형태의 JSON 파일. 매 조회마다 다시 읽어 수정이 바로 반영된다. */
export class FixtureAdapter implements ServiceAdapter {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async getSubject(subjectId: string): Promise<Subject | null> {
    const all = obj(JSON.parse(readFileSync(this.file, "utf8")), this.file);
    return all[subjectId] === undefined ? null : parseSubject(all[subjectId], `${this.file}#${subjectId}`);
  }
}

/** 운영용: GET {baseUrl}/subjects/{id} (Bearer 토큰). 404는 대상 없음. */
export class HttpAdapter implements ServiceAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; token: string; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getSubject(subjectId: string): Promise<Subject | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/subjects/${encodeURIComponent(subjectId)}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TransientError(`대상 조회 실패: ${(error as Error).message}`);
    }
    if (response.status === 404) return null;
    if (response.status >= 500 || response.status === 429) throw new TransientError(`대상 조회 실패 (${response.status})`);
    if (!response.ok) throw new Error(`대상 조회 실패 (${response.status}): ${(await response.text()).slice(0, 200)}`);
    return parseSubject(await response.json(), `subject ${subjectId}`);
  }
}

/** 아무것도 보내지 않는다. 메시지는 DB에 dry_run 상태로 남는다. */
export class DryRunChannel implements DeliveryChannel {
  async deliver(): Promise<DeliveryResult> {
    return { status: "dry_run", providerRef: null };
  }
}

/**
 * 서비스에 발송을 위임한다. 알림톡·푸시 계정과 발신 번호는 서비스가 이미 갖고 있으므로 엔진은 계정을 따로 두지 않는다.
 * Idempotency-Key로 같은 메시지를 두 번 받아도 서비스가 한 번만 보내게 한다.
 */
export class HttpDeliveryChannel implements DeliveryChannel {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: { url: string; token: string; timeoutMs?: number }) {
    this.url = options.url;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async deliver(delivery: Delivery): Promise<DeliveryResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "idempotency-key": delivery.messageId,
        },
        body: JSON.stringify(delivery),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TransientError(`발송 요청 실패: ${(error as Error).message}`);
    }
    if (response.status >= 500 || response.status === 429) throw new TransientError(`발송 요청 실패 (${response.status})`);
    if (!response.ok) throw new Error(`발송 거절 (${response.status}): ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json().catch(() => ({}))) as { providerRef?: unknown };
    return { status: "sent", providerRef: typeof data.providerRef === "string" ? data.providerRef : null };
  }
}

export function createAdapter(config: AdapterConfig): ServiceAdapter {
  return config.type === "fixture" ? new FixtureAdapter(config.file) : new HttpAdapter(config);
}

/** DRY_RUN=true면 서비스 설정과 관계없이 실제로 보내지 않는다. */
export function createDeliveryChannel(config: DeliveryConfig, dryRun: boolean): DeliveryChannel {
  return dryRun || config.type === "dry-run" ? new DryRunChannel() : new HttpDeliveryChannel(config);
}
