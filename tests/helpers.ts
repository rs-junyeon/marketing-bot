import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/shared/config.ts";
import { type AppContext, createContext } from "../src/shared/context.ts";
import { type CompletionRequest, MockLlmClient } from "../src/shared/llm.ts";
import { FileStore } from "../src/shared/store.ts";

/** 테스트마다 빈 임시 data 폴더와 mock LLM을 가진 컨텍스트를 만든다. */
export function createTestContext(respond?: (request: CompletionRequest) => string): AppContext & { llm: MockLlmClient } {
  const dataDir = mkdtempSync(join(tmpdir(), "marketing-bot-test-"));
  const config: AppConfig = {
    llmProvider: "mock",
    llmBaseUrl: "http://unused",
    llmApiKey: "unused",
    llmModel: "mock",
    dataDir,
    dryRun: true,
  };
  const llm = new MockLlmClient(respond);
  return { ...createContext({ config, store: new FileStore(dataDir), llm }), llm };
}
