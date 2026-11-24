/**
 * 엔진 전체가 공유하는 도메인 타입.
 * 엔진은 "PLUS", "ON" 같은 서비스 이름을 모른다. 서비스별 차이는 설정(services.json, playbooks/)과
 * 연결부(ServiceAdapter, DeliveryChannel)에만 있다.
 */

/** 이벤트 payload·대상 facts에 허용하는 값. 중첩 객체는 받지 않는다(조건 판단과 프롬프트 변수를 단순하게 유지). */
export type FactValue = string | number | boolean | null;
export type Facts = Record<string, FactValue>;

/** 서비스가 웹훅으로 보내는 사건. (service, id) 조합으로 중복을 막는다. */
export interface EngineEvent {
  id: string;
  service: string;
  /** 예: "plus.subscription.started", "on.member.signed_up" */
  type: string;
  /** 마케팅 대상(사장님, 회원 등)의 서비스 내부 id */
  subjectId: string;
  occurredAt: string;
  payload: Facts;
}

/**
 * 발송 수단.
 * - inapp: 서비스 화면 안 알림/카드 (서비스가 받아서 보여 줌)
 * - alimtalk: 카카오 알림톡. 정보성 메시지 전용이라 광고에 쓸 수 없다.
 * - brand_message: 카카오 브랜드 메시지(구 친구톡). 광고 가능.
 */
export const CHANNELS = ["inapp", "push", "alimtalk", "brand_message", "sms", "email"] as const;
export type ChannelKind = (typeof CHANNELS)[number];

export interface ConsentRecord {
  /** 동의 근거(서비스 쪽 동의 기록 id 등). 발송 기록에 그대로 남긴다. */
  ref: string;
  grantedAt: string;
}

/** 연결부가 서비스에서 조회해 돌려주는 마케팅 대상의 현재 상태. */
export interface Subject {
  id: string;
  displayName: string;
  contacts: Partial<Record<ChannelKind, string>>;
  consents: {
    /** 광고성 정보 수신 동의 */
    marketing?: ConsentRecord | null;
    /** 야간(21~08시) 광고 수신 별도 동의 */
    nightMarketing?: ConsentRecord | null;
  };
  /** 조건 판단·프롬프트에 쓰는 사실들. 예: couponSentCount, productCount, storeName */
  facts: Facts;
}

export interface MessageContent {
  title?: string;
  body: string;
}

export type JobStatus = "pending" | "running" | "done" | "skipped" | "failed";

export type MessageStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "sent"
  | "dry_run"
  | "failed"
  | "cancelled";
