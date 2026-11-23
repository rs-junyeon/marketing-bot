import { type FileStore, newId, nowIso } from "./store.ts";

export type ChannelKind = "email" | "alimtalk" | "sms" | "blog" | "sns";

export interface OutboundMessage {
  channel: ChannelKind;
  to: string;
  subject?: string;
  body: string;
  /** 광고성 메시지 여부. true면 수신 동의가 확인된 대상에게만 보낼 수 있다. */
  isAdvertising: boolean;
  /** 광고성일 때 수신 동의 근거(예: 리드 id, 동의 시각) */
  consentRef?: string;
}

export interface SendResult {
  id: string;
  status: "dry-run" | "sent";
}

/** 실제 발송 수단(솔라피, 메일 API, 블로그 API 등)은 이 인터페이스로 붙인다. */
export interface OutboundChannel {
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * 프로토타입 기본 채널: 아무것도 보내지 않고 data/outbox.jsonl 에 기록만 한다.
 * 광고성 메시지의 수신 동의 검사는 실제 채널과 똑같이 수행한다.
 */
export class DryRunChannel implements OutboundChannel {
  private readonly store: FileStore;

  constructor(store: FileStore) {
    this.store = store;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    assertSendable(message);
    const result: SendResult = { id: newId("msg"), status: "dry-run" };
    this.store.appendJsonl("outbox.jsonl", { ...result, at: nowIso(), ...message });
    return result;
  }
}

/** 정보통신망법 제50조: 광고성 정보는 명시적 사전 동의가 있어야 전송할 수 있다. */
export function assertSendable(message: OutboundMessage): void {
  if (message.isAdvertising && !message.consentRef) {
    throw new Error(`광고성 메시지는 수신 동의 근거(consentRef) 없이 보낼 수 없습니다: ${message.to}`);
  }
}
