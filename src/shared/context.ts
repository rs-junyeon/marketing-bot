import { ApprovalQueue } from "./approval.ts";
import { type OutboundChannel, DryRunChannel } from "./channel.ts";
import { type AppConfig, loadConfig } from "./config.ts";
import { type LlmClient, createLlmClient } from "./llm.ts";
import { Metrics } from "./metrics.ts";
import { FileStore } from "./store.ts";

/**
 * 프로토타입이 쓰는 의존성 묶음. 각 프로토타입은 이것만 받아서 동작하고,
 * 테스트에서는 mock LLM·임시 폴더로 바꿔 끼운다.
 */
export interface AppContext {
  config: AppConfig;
  store: FileStore;
  llm: LlmClient;
  approvals: ApprovalQueue;
  channel: OutboundChannel;
  metrics: Metrics;
}

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const config = overrides.config ?? loadConfig();
  const store = overrides.store ?? new FileStore(config.dataDir);
  if (!config.dryRun && !overrides.channel) {
    throw new Error("DRY_RUN=false 이지만 실제 발송 채널이 아직 구현되지 않았습니다. 채널을 주입하세요.");
  }
  return {
    config,
    store,
    llm: overrides.llm ?? createLlmClient(config),
    approvals: overrides.approvals ?? new ApprovalQueue(store),
    channel: overrides.channel ?? new DryRunChannel(store),
    metrics: overrides.metrics ?? new Metrics(store),
  };
}
