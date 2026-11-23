import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ApprovalItem } from "../../shared/approval.ts";
import { type AppContext, createContext } from "../../shared/context.ts";
import {
  approveBrief,
  type BriefResult,
  createBrief,
  createBriefsFromFile,
  getBrief,
  listBriefs,
  recordMeeting,
  rejectBrief,
} from "./brief.ts";
import { HttpPageFetcher, type PageFetcher } from "./fetcher.ts";

const HELP = `C. 영업 지원 봇 — 영업 대상 조사 → 맞춤 제안서 초안 → 영업 담당자 검토
(이 봇은 아무것도 발송하지 않습니다. 승인된 제안서는 영업 담당자가 직접 전달합니다.)

사용법:
  pnpm c:sales brief --name "대상 이름" [--url https://...] [--industry 업종] [--notes "영업 메모"]
  pnpm c:sales brief --file <targets.json>      여러 대상을 한 번에 (예: src/prototypes/c-sales-brief/samples/targets.json)
  pnpm c:sales review [--all]                   검토 대기 브리프 목록 (--all: 전체)
  pnpm c:sales show <id>                        브리프 내용 보기
  pnpm c:sales approve <id> [--note "메모"]      영업 담당자 전달 준비 완료로 표시
  pnpm c:sales reject <id> [--note "사유"]       반려
  pnpm c:sales meeting <id>                     승인된 브리프로 미팅이 잡혔음을 기록
  pnpm c:sales help                             이 도움말

URL은 해당 페이지 1개만 10초 제한으로 조회합니다. 실패해도 메모만으로 브리프를 만들고 실패 사유를 남깁니다.`;

export async function runCli(argv: string[], ctx: AppContext, fetcher: PageFetcher, log = console.log): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      url: { type: "string" },
      industry: { type: "string" },
      notes: { type: "string" },
      file: { type: "string" },
      note: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id] = positionals;
  const requireId = () => {
    if (!id) throw new Error(`${command} 에는 브리프 id 가 필요합니다. 'pnpm c:sales review' 로 확인하세요.`);
    return id;
  };

  if (!command || command === "help" || values.help) {
    log(HELP);
    return;
  }

  switch (command) {
    case "brief": {
      if (values.file) {
        const outcomes = await createBriefsFromFile(ctx, resolve(values.file), { fetcher });
        for (const outcome of outcomes) {
          if (outcome.result) printCreated(outcome.result, log);
          else log(`✗ ${outcome.target}: ${outcome.error}`);
        }
        const failed = outcomes.filter((outcome) => outcome.error).length;
        log(`\n총 ${outcomes.length}건 중 ${outcomes.length - failed}건 생성, ${failed}건 실패`);
        if (failed) throw new Error(`${failed}건의 브리프 생성에 실패했습니다.`);
        return;
      }
      if (!values.name) throw new Error("--name 또는 --file 이 필요합니다. 'pnpm c:sales help' 를 참고하세요.");
      log(`'${values.name}' 브리프를 만드는 중입니다… (로컬 LLM은 수십 초 걸릴 수 있습니다)`);
      printCreated(
        await createBrief(ctx, { name: values.name, url: values.url, industry: values.industry, notes: values.notes }, { fetcher }),
        log,
      );
      return;
    }
    case "review": {
      const items = listBriefs(ctx, values.all ? undefined : "pending");
      if (items.length === 0) {
        log(values.all ? "아직 만든 브리프가 없습니다." : "검토 대기 중인 브리프가 없습니다.");
        return;
      }
      for (const item of items) log(formatRow(item));
      log(`\n${items.length}건. 'pnpm c:sales show <id>' 로 내용을 확인하세요.`);
      return;
    }
    case "show": {
      const item = getBrief(ctx, requireId());
      log(`${formatRow(item)}\n파일: ${ctx.store.path(item.meta.file ?? "")}\n${"-".repeat(60)}\n${item.body}`);
      return;
    }
    case "approve": {
      const item = approveBrief(ctx, requireId(), values.note);
      log(`✓ 승인: ${item.title}\n  영업 담당자가 내용을 확인한 뒤 직접 전달하세요. 미팅이 잡히면 'pnpm c:sales meeting ${item.id}'`);
      return;
    }
    case "reject": {
      const item = rejectBrief(ctx, requireId(), values.note);
      log(`✓ 반려: ${item.title}${values.note ? ` (사유: ${values.note})` : ""}`);
      return;
    }
    case "meeting": {
      const item = recordMeeting(ctx, requireId());
      log(`✓ 미팅 성사 기록: ${item.meta.target ?? item.title}`);
      return;
    }
    default:
      throw new Error(`알 수 없는 명령입니다: ${command}. 'pnpm c:sales help' 를 참고하세요.`);
  }
}

function printCreated(result: BriefResult, log: (line: string) => void): void {
  const fetchNote = result.fetch ? (result.fetch.ok ? "홈페이지 수집 성공" : `홈페이지 수집 실패: ${result.fetch.reason}`) : "URL 없음";
  log(`✓ ${result.approval.meta.target} → ${result.filePath}\n  승인 id: ${result.approval.id} (${fetchNote})`);
}

function formatRow(item: ApprovalItem): string {
  return `${item.id}  [${item.status}]  ${item.meta.target ?? item.title}  ${item.meta.url || "-"}  ${item.createdAt}`;
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2), createContext(), new HttpPageFetcher());
  } catch (error) {
    console.error(`오류: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
