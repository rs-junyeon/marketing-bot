import type { EngineStore } from "./store.ts";

/**
 * 플레이북별 성과표. 사수님 평가 기준(자동화 · 효과 · 유지보수)에 맞춰 같은 지표로 비교한다.
 * - 자동화: 생성 수, 승인 없이 나간 비율, 승인자가 고친 비율
 * - 효과: 실제 발송 수, 전환 수, 전환율 (DRY_RUN 발송은 전환 계산에서 제외)
 * - 유지보수: 실패·재생성 비율, 평균 생성 시간
 */
export interface PlaybookMetrics {
  playbookId: string;
  jobs: number;
  skipped: number;
  skipReasons: Record<string, number>;
  failed: number;
  generated: number;
  pendingApproval: number;
  rejected: number;
  edited: number;
  sent: number;
  dryRun: number;
  converted: number;
  conversionRate: number | null;
  regeneratedRate: number | null;
  avgGenerationMs: number | null;
}

function reasonKey(reason: string | null): string {
  if (!reason) return "unknown";
  return reason.split(/[: ]/, 1)[0];
}

export function collectMetrics(store: EngineStore): PlaybookMetrics[] {
  const map = new Map<string, PlaybookMetrics>();
  const get = (id: string): PlaybookMetrics => {
    let entry = map.get(id);
    if (!entry) {
      entry = {
        playbookId: id,
        jobs: 0,
        skipped: 0,
        skipReasons: {},
        failed: 0,
        generated: 0,
        pendingApproval: 0,
        rejected: 0,
        edited: 0,
        sent: 0,
        dryRun: 0,
        converted: 0,
        conversionRate: null,
        regeneratedRate: null,
        avgGenerationMs: null,
      };
      map.set(id, entry);
    }
    return entry;
  };

  for (const row of store.jobStats()) {
    const entry = get(row.playbook_id as string);
    const n = Number(row.n);
    entry.jobs += n;
    if (row.status === "skipped") {
      entry.skipped += n;
      const key = reasonKey(row.reason as string | null);
      entry.skipReasons[key] = (entry.skipReasons[key] ?? 0) + n;
    }
    if (row.status === "failed") entry.failed += n;
  }

  const durations = new Map<string, { total: number; count: number; retried: number }>();
  for (const row of store.messageStats()) {
    const entry = get(row.playbook_id as string);
    const n = Number(row.n);
    entry.generated += n;
    entry.edited += Number(row.edited ?? 0);
    entry.converted += Number(row.converted ?? 0);
    if (row.status === "pending_approval") entry.pendingApproval += n;
    if (row.status === "rejected") entry.rejected += n;
    if (row.status === "sent") entry.sent += n;
    if (row.status === "dry_run") entry.dryRun += n;
    const d = durations.get(entry.playbookId) ?? { total: 0, count: 0, retried: 0 };
    if (row.avg_ms !== null) {
      d.total += Number(row.avg_ms) * n;
      d.count += n;
    }
    d.retried += Number(row.retried ?? 0);
    durations.set(entry.playbookId, d);
  }

  for (const entry of map.values()) {
    entry.conversionRate = entry.sent ? entry.converted / entry.sent : null;
    const d = durations.get(entry.playbookId);
    if (d) {
      entry.avgGenerationMs = d.count ? Math.round(d.total / d.count) : null;
      entry.regeneratedRate = entry.generated ? d.retried / entry.generated : null;
    }
  }
  return [...map.values()].sort((a, b) => a.playbookId.localeCompare(b.playbookId));
}
