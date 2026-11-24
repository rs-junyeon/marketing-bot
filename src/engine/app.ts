import { resolve } from "node:path";
import { type AppConfig, PROJECT_ROOT, loadConfig } from "../shared/config.ts";
import { type LlmClient, createLlmClient } from "../shared/llm.ts";
import { createAdapter, createDeliveryChannel } from "./connectors.ts";
import { Engine, type ServiceRuntime } from "./engine.ts";
import { ContentGenerator } from "./generator.ts";
import { InputError } from "./input.ts";
import type { Logger } from "./logger.ts";
import { loadPlaybooks } from "./playbook.ts";
import { loadServices } from "./services.ts";
import { EngineStore } from "./store.ts";
import { Worker } from "./worker.ts";

/** 엔진 실행 설정. 모두 환경 변수에서 읽고, 잘못되면 서버를 띄우지 않는다. */
export interface EngineConfig {
  shared: AppConfig;
  host: string;
  port: number;
  dbPath: string;
  configDir: string;
  adminToken: string;
  workerIntervalMs: number;
}

type Env = Record<string, string | undefined>;

export function loadEngineConfig(env: Env = process.env): EngineConfig {
  const shared = loadConfig(env as NodeJS.ProcessEnv);
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 24) throw new InputError("ADMIN_TOKEN 환경 변수가 없거나 24자 미만입니다. (예: openssl rand -hex 24)");
  const port = Number(env.ENGINE_PORT ?? 3200);
  const workerIntervalMs = Number(env.WORKER_INTERVAL_MS ?? 5000);
  if (!Number.isInteger(port) || port < 0) throw new InputError("ENGINE_PORT는 정수여야 합니다.");
  if (!Number.isInteger(workerIntervalMs) || workerIntervalMs < 100) throw new InputError("WORKER_INTERVAL_MS는 100 이상의 정수여야 합니다.");
  return {
    shared,
    host: env.ENGINE_HOST ?? "127.0.0.1",
    port,
    dbPath: env.ENGINE_DB_PATH === ":memory:" ? ":memory:" : resolve(PROJECT_ROOT, env.ENGINE_DB_PATH ?? "data/engine/engine.db"),
    configDir: resolve(PROJECT_ROOT, env.ENGINE_CONFIG_DIR ?? "config"),
    adminToken,
    workerIntervalMs,
  };
}

export interface EngineApp {
  config: EngineConfig;
  engine: Engine;
  worker: Worker;
}

/** 설정 → 서비스·플레이북 로드 → 저장소 → 엔진·워커 조립. 테스트는 llm·clock만 바꿔 끼운다. */
export function createEngineApp(options: { env?: Env; logger: Logger; llm?: LlmClient; clock?: () => Date }): EngineApp {
  const env = options.env ?? process.env;
  const config = loadEngineConfig(env);
  const services = loadServices(resolve(config.configDir, "services.json"), env, (file) => resolve(config.configDir, file));
  const playbooks = loadPlaybooks(resolve(config.configDir, "playbooks"), new Set(services.map((s) => s.id)));
  const runtimes: ServiceRuntime[] = services.map((service) => ({
    config: service,
    adapter: createAdapter(service.adapter),
    channel: createDeliveryChannel(service.delivery, config.shared.dryRun),
  }));
  const store = new EngineStore(config.dbPath);
  const engine = new Engine({
    store,
    services: runtimes,
    playbooks,
    generator: new ContentGenerator(options.llm ?? createLlmClient(config.shared), config.shared.llmModel),
    logger: options.logger,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const worker = new Worker(engine, { intervalMs: config.workerIntervalMs, logger: options.logger });
  return { config, engine, worker };
}
