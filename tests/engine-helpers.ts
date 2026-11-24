import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../src/shared/config.ts";
import { type CompletionRequest, MockLlmClient } from "../src/shared/llm.ts";
import { type EngineApp, createEngineApp } from "../src/engine/app.ts";
import type { EngineEvent } from "../src/engine/domain.ts";
import { silentLogger } from "../src/engine/logger.ts";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
export const PLUS_SECRET = "plus-secret-0123456789";
export const ON_SECRET = "on-secret-0123456789ab";

/** 테스트용 조절 가능한 시계 */
export class TestClock {
  now: Date;
  constructor(iso: string) {
    this.now = new Date(iso);
  }
  set(iso: string): void {
    this.now = new Date(iso);
  }
  advanceMinutes(minutes: number): void {
    this.now = new Date(this.now.getTime() + minutes * 60 * 1000);
  }
  read = (): Date => this.now;
}

export interface TestEngine extends EngineApp {
  llm: MockLlmClient;
  clock: TestClock;
  configDir: string;
  /** 픽스처 대상 정보를 고친다 (서비스 쪽 상태 변화 흉내) */
  updateSubject(file: "coupin-plus" | "coupin-on", id: string, change: (subject: Record<string, any>) => void): void;
}

/**
 * 실제 config/ 폴더를 임시 폴더로 복사해 엔진을 만든다. DB는 메모리, LLM은 mock.
 * extraEnv로 서비스 연결 설정 등을 덮어쓸 수 있다.
 */
export function createTestEngine(options: {
  respond?: (request: CompletionRequest) => string;
  now?: string;
  mutateServices?: (services: any[]) => void;
  extraEnv?: Record<string, string>;
} = {}): TestEngine {
  const configDir = mkdtempSync(join(tmpdir(), "engine-config-"));
  cpSync(resolve(PROJECT_ROOT, "config"), configDir, { recursive: true });
  if (options.mutateServices) {
    const file = join(configDir, "services.json");
    const services = JSON.parse(readFileSync(file, "utf8"));
    options.mutateServices(services);
    writeFileSync(file, JSON.stringify(services));
  }
  const clock = new TestClock(options.now ?? "2026-11-24T03:00:00Z"); // 낮 12시 KST
  const llm = new MockLlmClient(options.respond ?? (() => JSON.stringify({ title: "첫 쿠폰을 보내 보세요", body: "등록하신 상품으로 첫 쿠폰을 만들어 보세요." })));
  const env = {
    LLM_PROVIDER: "mock",
    LLM_MODEL: "test-model",
    DRY_RUN: "true",
    ADMIN_TOKEN,
    ENGINE_DB_PATH: ":memory:",
    ENGINE_CONFIG_DIR: configDir,
    COUPIN_PLUS_WEBHOOK_SECRET: PLUS_SECRET,
    COUPIN_ON_WEBHOOK_SECRET: ON_SECRET,
    ...options.extraEnv,
  };
  const app = createEngineApp({ env, logger: silentLogger, llm, clock: clock.read });
  return {
    ...app,
    llm,
    clock,
    configDir,
    updateSubject(file, id, change) {
      const path = join(configDir, "fixtures", `${file}.json`);
      const all = JSON.parse(readFileSync(path, "utf8"));
      change(all[id]);
      writeFileSync(path, JSON.stringify(all));
    },
  };
}

export function event(partial: Partial<EngineEvent> & Pick<EngineEvent, "service" | "type" | "subjectId">): EngineEvent {
  return { id: `evt-${Math.random().toString(36).slice(2)}`, occurredAt: "2026-11-24T03:00:00Z", payload: {}, ...partial };
}
