import { parseArgs } from "node:util";
import { createContext } from "../../shared/context.ts";
import { TOPIC_HANDOFF_FILE } from "../../shared/handoff.ts";
import { SALES_ANGLES_FILE, analyze, latestReport } from "./analyze.ts";
import { ITEMS_FILE, collect, loadSources } from "./collect.ts";

const HELP = `D. 커뮤니티·트렌드 모니터링 (수집·분석만 합니다. 어디에도 글·댓글을 올리지 않습니다)

사용법:
  pnpm d:monitor collect                 samples/sources.json 의 공개 소스를 수집해 새 글만 저장
  pnpm d:monitor analyze [--days 7]      최근 N일 글의 키워드 집계 + LLM 요약 → 리포트·A용 주제 전달
  pnpm d:monitor report                  가장 최근 리포트 경로와 요약 출력

옵션:
  --days <N>   analyze 대상 기간(일). 기본 7
  -h, --help   이 도움말
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: "string", default: "7" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    if (!command && !values.help) process.exitCode = 1;
    return;
  }

  const ctx = createContext();

  if (command === "collect") {
    const results = await collect(ctx, { sources: loadSources() });
    for (const r of results) {
      if (r.error) console.log(`✗ ${r.sourceName}: 실패 — ${r.error} (건너뜀)`);
      else console.log(`✓ ${r.sourceName}: 가져옴 ${r.fetched}건 / 새 글 ${r.added}건 / 중복 ${r.duplicates}건`);
    }
    const added = results.reduce((sum, r) => sum + r.added, 0);
    const failed = results.filter((r) => r.error).length;
    console.log(`\n합계: 새 글 ${added}건 저장 → data/${ITEMS_FILE} (실패 소스 ${failed}/${results.length})`);
    if (failed === results.length) process.exitCode = 1;
    return;
  }

  if (command === "analyze") {
    const days = Number.parseInt(values.days, 10);
    if (!Number.isInteger(days) || days <= 0) throw new Error(`--days 는 1 이상의 정수여야 합니다: ${values.days}`);
    console.log(`최근 ${days}일 글을 분석합니다. LLM(${ctx.config.llmModel}) 응답을 기다리는 중…`);
    const result = await analyze(ctx, { days });
    console.log(`글 ${result.itemCount}건 (샘플 ${result.sampleCount}건), LLM 입력 ${result.promptItemCount}건, 소요 ${(result.durationMs / 1000).toFixed(1)}초`);
    console.log(`상위 키워드: ${result.topKeywords.slice(0, 10).map((k) => `${k.keyword}(${k.itemCount})`).join(", ")}`);
    console.log(
      `테마 ${result.analysis.themes.length} · 고민 ${result.analysis.painPoints.length} · 콘텐츠 아이디어 ${result.analysis.contentIdeas.length} · 영업 포인트 ${result.analysis.salesAngles.length} (근거 없어 제외 ${result.analysis.droppedUnsupported})`,
    );
    console.log(`리포트: ${result.reportPath}`);
    console.log(`A 전달: data/${TOPIC_HANDOFF_FILE} (주제 ${result.handoff.topics.length}개)`);
    console.log(`C 전달: data/${SALES_ANGLES_FILE}`);
    return;
  }

  if (command === "report") {
    const latest = latestReport(ctx);
    if (!latest) throw new Error("아직 리포트가 없습니다. 먼저 pnpm d:monitor analyze 를 실행하세요.");
    console.log(`최근 리포트: ${latest.path}`);
    const s = latest.summary;
    if (s) {
      console.log(`생성 ${s.generatedAt} · 최근 ${s.days}일 · 글 ${s.itemCount}건 (샘플 ${s.sampleCount}건) · 분석 ${(s.durationMs / 1000).toFixed(1)}초`);
      console.log(`상위 키워드: ${s.topKeywords.slice(0, 10).map((k) => `${k.keyword}(${k.itemCount})`).join(", ")}`);
      console.log("테마:");
      for (const theme of s.analysis.themes) console.log(`  - ${theme.title}`);
      console.log("콘텐츠 아이디어:");
      for (const idea of s.analysis.contentIdeas) console.log(`  - ${idea.title}`);
    }
    return;
  }

  throw new Error(`알 수 없는 명령입니다: ${command}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
