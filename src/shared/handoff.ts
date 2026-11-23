import type { FileStore } from "./store.ts";

/**
 * 프로토타입 간 데이터 전달 규약.
 * D(커뮤니티 모니터링)가 찾은 주제를 A(콘텐츠 자동화)가 글감으로 쓴다.
 */
export interface TopicSuggestion {
  title: string;
  /** 왜 이 주제를 추천하는지 (근거 키워드·글 요약) */
  reason: string;
  sourceLinks: string[];
}

export interface TopicHandoff {
  generatedAt: string;
  topics: TopicSuggestion[];
}

export const TOPIC_HANDOFF_FILE = "d-community-monitor/latest-topics.json";

export function readTopicHandoff(store: FileStore): TopicHandoff | null {
  return store.readJson<TopicHandoff | null>(TOPIC_HANDOFF_FILE, null);
}

export function writeTopicHandoff(store: FileStore, handoff: TopicHandoff): void {
  store.writeJson(TOPIC_HANDOFF_FILE, handoff);
}
