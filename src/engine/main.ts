import { createEngineApp } from "./app.ts";
import { createEngineServer } from "./http.ts";
import { createLogger } from "./logger.ts";

/** pnpm engine: 마케팅 봇 공용 엔진 서버 (HTTP + 워커) */
const logger = createLogger();
let app: ReturnType<typeof createEngineApp>;
try {
  app = createEngineApp({ logger });
} catch (error) {
  logger.error("startup.config_error", { error: (error as Error).message });
  process.exit(1);
}

const { config, engine, worker } = app;
const server = createEngineServer({ engine, adminToken: config.adminToken, logger });

server.listen(config.port, config.host, () => {
  logger.info("engine.started", {
    url: `http://${config.host}:${config.port}`,
    dryRun: config.shared.dryRun,
    llm: config.shared.llmProvider === "mock" ? "mock" : config.shared.llmModel,
    playbooks: engine.listPlaybooks().filter((p) => p.enabled).map((p) => p.id),
  });
  worker.start();
});

// 종료 신호: 새 요청을 막고, 진행 중인 워커 한 바퀴를 마친 뒤 DB를 닫는다.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info("engine.stopping", { signal });
  server.close();
  server.closeIdleConnections();
  await worker.stop();
  engine.store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
