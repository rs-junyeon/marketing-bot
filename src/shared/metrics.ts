import type { PrototypeId } from "./approval.ts";
import { type FileStore, nowIso } from "./store.ts";

/**
 * 4개 프로토타입을 같은 기준(자동화 · 효과 · 유지보수)으로 비교하기 위한 이벤트 기록.
 * 이벤트 이름은 아래 상수만 쓴다. 새 이벤트가 필요하면 여기에 먼저 추가한다.
 */
export const EVENTS = {
  /** 자동화: 사람 개입 없이 만들어진 결과물 */
  generated: "generated",
  /** 사람 개입: 승인/반려 */
  approved: "approved",
  rejected: "rejected",
  /** 효과: 외부 반응 (리드 유입, 문의, 미팅 등) */
  leadCaptured: "lead_captured",
  sent: "sent",
  meetingBooked: "meeting_booked",
  /** 유지보수: 실패·예외 */
  failed: "failed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface MetricEvent {
  at: string;
  prototype: PrototypeId;
  name: EventName;
  /** LLM 호출 등 소요 시간(ms) */
  durationMs?: number;
  meta?: Record<string, string>;
}

const FILE = "metrics.jsonl";

export class Metrics {
  private readonly store: FileStore;

  constructor(store: FileStore) {
    this.store = store;
  }

  record(prototype: PrototypeId, name: EventName, extra: Omit<MetricEvent, "at" | "prototype" | "name"> = {}): void {
    this.store.appendJsonl(FILE, { at: nowIso(), prototype, name, ...extra } satisfies MetricEvent);
  }

  /** 시간 측정 + 성공/실패 이벤트 기록을 한 번에 처리한다. */
  async track<T>(prototype: PrototypeId, meta: Record<string, string>, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      this.record(prototype, EVENTS.generated, { durationMs: Math.round(performance.now() - started), meta });
      return result;
    } catch (error) {
      this.record(prototype, EVENTS.failed, {
        durationMs: Math.round(performance.now() - started),
        meta: { ...meta, error: error instanceof Error ? error.message.slice(0, 200) : String(error) },
      });
      throw error;
    }
  }

  all(): MetricEvent[] {
    return this.store.readJsonl<MetricEvent>(FILE);
  }
}

export interface PrototypeSummary {
  prototype: PrototypeId;
  counts: Partial<Record<EventName, number>>;
  /** 생성 대비 승인 비율: 사람이 손대지 않고 통과한 정도 */
  approvalRate: number | null;
  avgGenerateMs: number | null;
  failureRate: number | null;
}

export function summarize(events: MetricEvent[]): PrototypeSummary[] {
  const byPrototype = Map.groupBy(events, (event) => event.prototype);
  return [...byPrototype.entries()]
    .map(([prototype, list]) => {
      const counts: Partial<Record<EventName, number>> = {};
      for (const event of list) counts[event.name] = (counts[event.name] ?? 0) + 1;
      const decided = (counts.approved ?? 0) + (counts.rejected ?? 0);
      const attempts = (counts.generated ?? 0) + (counts.failed ?? 0);
      const durations = list.filter((e) => e.name === EVENTS.generated && e.durationMs !== undefined);
      return {
        prototype,
        counts,
        approvalRate: decided ? (counts.approved ?? 0) / decided : null,
        avgGenerateMs: durations.length
          ? Math.round(durations.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / durations.length)
          : null,
        failureRate: attempts ? (counts.failed ?? 0) / attempts : null,
      };
    })
    .sort((a, b) => a.prototype.localeCompare(b.prototype));
}
