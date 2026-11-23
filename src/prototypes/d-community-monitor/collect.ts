import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppContext } from "../../shared/context.ts";
import { EVENTS } from "../../shared/metrics.ts";
import { nowIso } from "../../shared/store.ts";
import { parseRss } from "./rss.ts";

export const PROTOTYPE = "d-community-monitor";
export const ITEMS_FILE = "d-community-monitor/items.jsonl";
export const SAMPLES_DIR = resolve(import.meta.dirname, "samples");
export const MAX_ITEMS_PER_SOURCE = 30;
export const FETCH_TIMEOUT_MS = 10_000;
export const USER_AGENT = "marketing-bot-d-community-monitor/0.1 (research prototype; public RSS only)";

export type SourceConfig =
  | { name: string; type: "rss"; url: string }
  /** 로컬 JSON 파일(샘플). path는 samples/ 기준 상대 경로 */
  | { name: string; type: "sample-file"; path: string };

export interface CollectedItem {
  id: string;
  sourceName: string;
  title: string;
  link: string;
  /** 원문 게시 시각. 없으면 수집 시각 */
  publishedAt: string;
  collectedAt: string;
  snippet: string;
  /** true면 실제 글이 아닌 샘플 데이터 */
  isSample: boolean;
}

export interface SamplePost {
  id: string;
  title: string;
  body: string;
  sample: boolean;
  community?: string;
}

/** 네트워크 호출을 주입받는다. 테스트에서는 가짜 함수를 넣는다. */
export type TextFetcher = (url: string) => Promise<string>;

export const defaultFetcher: TextFetcher = async (url) => {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
};

export interface SourceResult {
  sourceName: string;
  fetched: number;
  added: number;
  duplicates: number;
  error?: string;
}

export interface CollectOptions {
  sources: SourceConfig[];
  fetcher?: TextFetcher;
  samplesDir?: string;
  now?: Date;
}

export function loadSources(samplesDir = SAMPLES_DIR): SourceConfig[] {
  return JSON.parse(readFileSync(resolve(samplesDir, "sources.json"), "utf8")) as SourceConfig[];
}

export function googleNewsRssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
}

/** 중복 판정 키: 링크와 제목(공백·대소문자 정규화) 둘 다 본다. */
function dedupeKeys(item: Pick<CollectedItem, "link" | "title">): string[] {
  const keys: string[] = [];
  if (item.link) keys.push(`link:${item.link.trim()}`);
  const title = item.title.replace(/\s+/g, " ").trim().toLowerCase();
  if (title) keys.push(`title:${title}`);
  return keys;
}

function itemId(sourceName: string, link: string, title: string): string {
  return `d_${createHash("sha1").update(link || `${sourceName}:${title}`).digest("hex").slice(0, 10)}`;
}

async function fetchSource(
  source: SourceConfig,
  fetcher: TextFetcher,
  samplesDir: string,
  collectedAt: string,
): Promise<CollectedItem[]> {
  if (source.type === "rss") {
    const xml = await fetcher(source.url);
    if (!/<rss[\s>]|<channel[\s>]/i.test(xml)) throw new Error("RSS 형식이 아닙니다");
    return parseRss(xml, MAX_ITEMS_PER_SOURCE).map((item) => ({
      id: itemId(source.name, item.link, item.title),
      sourceName: source.name,
      title: item.title,
      link: item.link,
      publishedAt: item.publishedAt ?? collectedAt,
      collectedAt,
      snippet: item.description.slice(0, 300),
      isSample: false,
    }));
  }
  if (source.type === "sample-file") {
    const file = JSON.parse(readFileSync(resolve(samplesDir, source.path), "utf8")) as { posts: SamplePost[] };
    return file.posts.slice(0, MAX_ITEMS_PER_SOURCE).map((post) => ({
      id: itemId(source.name, "", `${post.id}:${post.title}`),
      sourceName: source.name,
      title: post.title,
      link: "",
      // 샘플은 날짜가 의미 없으므로 수집 시각을 쓴다.
      publishedAt: collectedAt,
      collectedAt,
      snippet: post.body.slice(0, 300),
      // 샘플 파일에서 온 글은 무조건 샘플로 표시한다.
      isSample: true,
    }));
  }
  throw new Error(`알 수 없는 소스 형식: ${(source as { type: string }).type}`);
}

/**
 * 소스를 하나씩 수집해 items.jsonl 에 새 글만 덧붙인다.
 * 한 소스가 실패해도 나머지는 계속 진행하고, 실패는 지표(failed)로 남긴다.
 */
export async function collect(ctx: AppContext, options: CollectOptions): Promise<SourceResult[]> {
  const fetcher = options.fetcher ?? defaultFetcher;
  const samplesDir = options.samplesDir ?? SAMPLES_DIR;
  const collectedAt = (options.now ?? new Date()).toISOString();
  const seen = new Set(ctx.store.readJsonl<CollectedItem>(ITEMS_FILE).flatMap(dedupeKeys));
  const results: SourceResult[] = [];

  for (const source of options.sources) {
    try {
      const items = await fetchSource(source, fetcher, samplesDir, collectedAt);
      let added = 0;
      for (const item of items) {
        const keys = dedupeKeys(item);
        if (keys.some((key) => seen.has(key))) continue;
        keys.forEach((key) => seen.add(key));
        ctx.store.appendJsonl(ITEMS_FILE, item);
        added += 1;
      }
      results.push({ sourceName: source.name, fetched: items.length, added, duplicates: items.length - added });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.metrics.record(PROTOTYPE, EVENTS.failed, {
        meta: { stage: "collect", source: source.name, error: message.slice(0, 200), at: nowIso() },
      });
      results.push({ sourceName: source.name, fetched: 0, added: 0, duplicates: 0, error: message });
    }
  }
  return results;
}

export function readItems(ctx: AppContext): CollectedItem[] {
  return ctx.store.readJsonl<CollectedItem>(ITEMS_FILE);
}
