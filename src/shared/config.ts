import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** 모든 프로토타입이 공유하는 실행 설정. 값은 환경 변수(.env)에서만 읽는다. */
export interface AppConfig {
  /** "openai-compatible": 실제 LLM 호출, "mock": 테스트·오프라인용 고정 응답 */
  llmProvider: "openai-compatible" | "mock";
  /** OpenAI 호환 Chat Completions 엔드포인트. 기본값은 로컬 Ollama. */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** 실행 결과(초안, 리드, 발송 기록, 지표)가 쌓이는 폴더 */
  dataDir: string;
  /** true면 외부로 아무것도 보내지 않고 outbox 파일에만 기록한다. */
  dryRun: boolean;
}

export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

let envLoaded = false;

function loadEnvFileOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadEnvFileOnce();

  const provider = env.LLM_PROVIDER ?? "openai-compatible";
  if (provider !== "openai-compatible" && provider !== "mock") {
    throw new Error(`LLM_PROVIDER는 openai-compatible 또는 mock 이어야 합니다: ${provider}`);
  }

  return {
    llmProvider: provider,
    llmBaseUrl: env.LLM_BASE_URL ?? "http://localhost:11434/v1",
    llmApiKey: env.LLM_API_KEY ?? "ollama",
    llmModel: env.LLM_MODEL ?? "qwen3.8:27b",
    dataDir: resolve(PROJECT_ROOT, env.DATA_DIR ?? "data"),
    // 안전 기본값: 명시적으로 "false"라고 하지 않는 한 실제 발송하지 않는다.
    dryRun: env.DRY_RUN !== "false",
  };
}
