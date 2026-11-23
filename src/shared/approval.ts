import { type FileStore, newId, nowIso } from "./store.ts";

export type PrototypeId = "a-content" | "b-lead-followup" | "c-sales-brief" | "d-community-monitor";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalItem {
  id: string;
  prototype: PrototypeId;
  /** 예: "blog-post", "sales-proposal", "follow-up-message" */
  kind: string;
  title: string;
  body: string;
  /** 승인 후 처리에 필요한 부가 정보 (수신자, 원본 리드 id 등) */
  meta: Record<string, string>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  note?: string;
}

const FILE = "approvals.json";

/**
 * Human-in-the-loop 승인 대기열.
 * 외부로 나가는 결과물은 반드시 여기를 거쳐 사람이 승인해야 한다.
 */
export class ApprovalQueue {
  private readonly store: FileStore;

  constructor(store: FileStore) {
    this.store = store;
  }

  submit(input: Pick<ApprovalItem, "prototype" | "kind" | "title" | "body"> & { meta?: Record<string, string> }): ApprovalItem {
    const item: ApprovalItem = {
      id: newId("apv"),
      meta: {},
      ...input,
      status: "pending",
      createdAt: nowIso(),
    };
    this.save([...this.all(), item]);
    return item;
  }

  all(): ApprovalItem[] {
    return this.store.readJson<ApprovalItem[]>(FILE, []);
  }

  list(filter: { prototype?: PrototypeId; status?: ApprovalStatus } = {}): ApprovalItem[] {
    return this.all().filter(
      (item) =>
        (!filter.prototype || item.prototype === filter.prototype) && (!filter.status || item.status === filter.status),
    );
  }

  get(id: string): ApprovalItem {
    const item = this.all().find((candidate) => candidate.id === id);
    if (!item) throw new Error(`승인 항목을 찾을 수 없습니다: ${id}`);
    return item;
  }

  decide(id: string, status: Exclude<ApprovalStatus, "pending">, note?: string): ApprovalItem {
    const items = this.all();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error(`승인 항목을 찾을 수 없습니다: ${id}`);
    if (items[index].status !== "pending") {
      throw new Error(`이미 처리된 항목입니다 (${items[index].status}): ${id}`);
    }
    const updated: ApprovalItem = { ...items[index], status, note, decidedAt: nowIso() };
    items[index] = updated;
    this.save(items);
    return updated;
  }

  private save(items: ApprovalItem[]): void {
    this.store.writeJson(FILE, items);
  }
}
