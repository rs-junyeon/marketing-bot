import { createContext } from "../../shared/context.ts";
import { createLeadServer } from "./app.ts";

/** pnpm b: 랜딩페이지 + 문의 후속 자동화 서버 */
const ctx = createContext();
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";
const { server, jobs } = createLeadServer(ctx);

server.listen(port, host, () => {
  console.log(`B 리드 후속 서버: http://${host}:${port}/  (관리: /admin, LLM: ${ctx.config.llmModel}, DRY_RUN=${ctx.config.dryRun})`);
});

// 종료 신호를 받으면 새 요청을 막고, 진행 중인 후속 처리가 끝난 뒤 종료한다.
let stopping = false;
function shutdown(): void {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("종료 중: 진행 중인 후속 처리를 기다립니다...");
  server.close();
  void jobs.idle().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
