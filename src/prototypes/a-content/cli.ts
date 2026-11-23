import { parseArgs } from "node:util";
import { createContext } from "../../shared/context.ts";
import { approve, findItem, generateDrafts, listPending, listTopics, reject } from "./content.ts";

const USAGE = `사용법: pnpm a:content <명령> [옵션]

명령:
  topics                              글감 후보 보기 (D 전달 주제 우선, 없으면 샘플)
  draft [--topic "주제"] [--count N]  LLM으로 블로그 글 초안 생성 → 승인 대기열 등록
  review                              승인 대기 중인 초안 목록
  show <id>                           초안 내용 보기 (승인 id 또는 draft id)
  approve <id> [--note "메모"]        승인 → 블로그 발행(dry-run) 
  reject <id> [--note "사유"]         반려
  help                                이 도움말`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      topic: { type: "string" },
      count: { type: "string" },
      note: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id] = positionals;
  if (!command || command === "help" || values.help) {
    console.log(USAGE);
    return;
  }

  const ctx = createContext();
  const requireId = () => {
    if (!id) throw new Error(`${command} 명령에는 <id>가 필요합니다. 'pnpm a:content review'로 id를 확인하세요.`);
    return id;
  };

  switch (command) {
    case "topics": {
      const { source, topics } = listTopics(ctx);
      console.log(source === "handoff" ? "📥 D(커뮤니티 모니터링)가 전달한 주제" : "📄 샘플 주제 (D 전달 주제 없음)");
      topics.forEach((topic, index) => console.log(`${index + 1}. ${topic.title}\n   └ ${topic.reason}`));
      return;
    }
    case "draft": {
      const count = values.count === undefined ? 1 : Number(values.count);
      console.log(`✍️  초안 생성 중... (모델: ${ctx.config.llmModel}, 로컬 모델은 1분 이상 걸릴 수 있습니다)`);
      const drafts = await generateDrafts(ctx, { topic: values.topic, count });
      for (const draft of drafts) {
        console.log(`\n✅ 승인 대기 등록: ${draft.approvalId}`);
        console.log(`   제목: ${draft.title}`);
        console.log(`   요약: ${draft.summary}`);
        console.log(`   본문: ${draft.body.length}자 · 파일: ${draft.file}`);
        for (const warning of draft.warnings) console.log(`   ⚠️  ${warning}`);
      }
      console.log(`\n다음 단계: pnpm a:content show <id> 로 확인 후 pnpm a:content approve <id> 또는 pnpm a:content reject <id>`);
      return;
    }
    case "review": {
      const pending = listPending(ctx);
      if (pending.length === 0) {
        console.log("승인 대기 중인 초안이 없습니다.");
        return;
      }
      console.table(pending.map((item) => ({ id: item.id, 제목: item.title, 주제: item.meta.topic, 생성: item.createdAt })));
      return;
    }
    case "show": {
      const item = findItem(ctx, requireId());
      console.log(`[${item.status}] ${item.id} · slug: ${item.meta.slug} · 주제: ${item.meta.topic}`);
      if (item.meta.warnings) console.log(`⚠️  ${item.meta.warnings}`);
      console.log(`\n# ${item.title}\n\n${item.body}`);
      return;
    }
    case "approve": {
      const result = await approve(ctx, requireId(), values.note);
      console.log(`✅ 승인 및 발행(${ctx.config.dryRun ? "dry-run" : "실제"}) 완료: ${result.item.title}`);
      console.log(`   발송 기록: ${result.messageId} · 파일: ${result.file}`);
      return;
    }
    case "reject": {
      const item = reject(ctx, requireId(), values.note);
      console.log(`🛑 반려했습니다: ${item.title}${values.note ? ` (사유: ${values.note})` : ""}`);
      return;
    }
    default:
      console.error(`알 수 없는 명령입니다: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
