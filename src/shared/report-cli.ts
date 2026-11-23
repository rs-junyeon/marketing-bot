import { createContext } from "./context.ts";
import { summarize } from "./metrics.ts";

/** pnpm report: 4개 프로토타입의 자동화·효과·유지보수 지표를 한 표로 출력한다. */
const context = createContext();
const summaries = summarize(context.metrics.all());

if (summaries.length === 0) {
  console.log("아직 기록된 지표가 없습니다. 각 프로토타입을 먼저 실행하세요.");
} else {
  const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
  console.table(
    summaries.map((s) => ({
      프로토타입: s.prototype,
      "생성(자동화)": s.counts.generated ?? 0,
      승인: s.counts.approved ?? 0,
      반려: s.counts.rejected ?? 0,
      승인율: percent(s.approvalRate),
      "리드·문의": s.counts.lead_captured ?? 0,
      발송: s.counts.sent ?? 0,
      미팅: s.counts.meeting_booked ?? 0,
      "평균 생성(ms)": s.avgGenerateMs ?? "-",
      실패율: percent(s.failureRate),
    })),
  );
}
