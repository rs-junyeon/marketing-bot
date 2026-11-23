import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppContext } from "../../shared/context.ts";
import { type TopicHandoff, writeTopicHandoff } from "../../shared/handoff.ts";
import { parseJsonResponse } from "../../shared/llm.ts";
import { loadPrompt } from "../../shared/prompts.ts";
import { nowIso } from "../../shared/store.ts";
import { type CollectedItem, PROTOTYPE, SAMPLES_DIR, readItems } from "./collect.ts";
import { type KeywordCount, countKeywords, countWatchKeywords } from "./keywords.ts";

export const REPORTS_DIR = "d-community-monitor/reports";
/** C(영업 지원)용 전달 파일. 공용 규약이 아직 없어 D 폴더에 둔다. */
export const SALES_ANGLES_FILE = "d-community-monitor/latest-sales-angles.json";
/** 프롬프트 길이를 제한하기 위해 LLM에 넘기는 최대 글 수 (최신순) */
export const MAX_PROMPT_ITEMS = 120;

export interface EvidenceRef {
  title: string;
  link: string;
  sourceName: string;
  isSample: boolean;
}

export interface Analysis {
  themes: { title: string; whyItMatters: string; evidence: EvidenceRef[] }[];
  painPoints: { text: string; evidence: EvidenceRef[] }[];
  contentIdeas: { title: string; reason: string; evidence: EvidenceRef[] }[];
  salesAngles: { text: string; evidence: EvidenceRef[] }[];
  /** 근거 글 번호가 없거나 잘못돼 버린 항목 수 */
  droppedUnsupported: number;
}

export interface AnalyzeResult {
  reportPath: string;
  reportFile: string;
  itemCount: number;
  sampleCount: number;
  promptItemCount: number;
  durationMs: number;
  topKeywords: KeywordCount[];
  watchKeywords: KeywordCount[];
  analysis: Analysis;
  handoff: TopicHandoff;
}

export interface AnalyzeOptions {
  days?: number;
  now?: Date;
  watchKeywords?: string[];
}

/** LLM이 돌려주는 원본 형태. 근거는 글 번호로만 받는다(링크·제목을 지어내지 못하게). */
interface RawAnalysis {
  themes?: { title?: string; whyItMatters?: string; evidence?: unknown }[];
  painPoints?: { text?: string; evidence?: unknown }[];
  contentIdeas?: { title?: string; reason?: string; evidence?: unknown }[];
  salesAngles?: { text?: string; evidence?: unknown }[];
}

/** 가장 최근 리포트(md) 경로와 요약 JSON. 없으면 null */
export function latestReport(ctx: AppContext): { path: string; summary: LatestSummary | null } | null {
  const dir = ctx.store.path(REPORTS_DIR);
  if (!existsSync(dir)) return null;
  const latest = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().at(-1);
  if (!latest) return null;
  const date = latest.replace(/\.md$/, "");
  return {
    path: ctx.store.path(REPORTS_DIR, latest),
    summary: ctx.store.readJson<LatestSummary | null>(`${REPORTS_DIR}/${date}.json`, null),
  };
}

export interface LatestSummary {
  generatedAt: string;
  days: number;
  itemCount: number;
  sampleCount: number;
  durationMs: number;
  topKeywords: KeywordCount[];
  analysis: Analysis;
}

export function loadWatchKeywords(samplesDir = SAMPLES_DIR): string[] {
  const file = JSON.parse(readFileSync(resolve(samplesDir, "keywords.json"), "utf8")) as { watch: string[] };
  return file.watch;
}

export function selectRecent(items: CollectedItem[], days: number, now: Date): CollectedItem[] {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => Date.parse(item.publishedAt) >= since)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** KST 기준 YYYY-MM-DD */
export function reportDate(now: Date): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

/** Google 뉴스 제목 끝의 " - 언론사명"을 뗀다. 언론사명이 키워드로 잡히지 않게 하기 위함. */
export function stripPublisher(title: string): string {
  return title.replace(/\s+-\s+[^-]+$/, "").trim();
}

/** 키워드 집계용 텍스트. 스니펫이 제목 반복(Google 뉴스)이면 제목만 쓴다. */
export function itemText(item: CollectedItem): string {
  if (item.isSample) return `${item.title} ${item.snippet}`;
  const title = stripPublisher(item.title);
  return item.snippet.startsWith(title.slice(0, 20)) ? title : `${title} ${item.snippet}`;
}

function formatItemsForPrompt(items: CollectedItem[]): string {
  return items
    .map((item, index) => {
      // Google 뉴스 description은 제목 반복이라 제목과 겹치면 생략한다.
      const snippet = item.snippet && !item.snippet.startsWith(item.title.slice(0, 20)) ? ` — ${item.snippet.slice(0, 120)}` : "";
      return `[${index + 1}]${item.isSample ? " (샘플)" : ""} ${item.title}${snippet}`;
    })
    .join("\n");
}

function toEvidence(raw: unknown, items: CollectedItem[]): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const indexes = new Set(
    raw
      .map((value) => (typeof value === "number" ? value : Number.parseInt(String(value).replace(/\D/g, ""), 10)))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= items.length),
  );
  return [...indexes].map((index) => {
    const item = items[index - 1];
    return { title: item.title, link: item.link, sourceName: item.sourceName, isSample: item.isSample };
  });
}

/** LLM 응답을 검증하고, 실제 글 번호로 뒷받침되지 않는 항목은 버린다. */
export function normalizeAnalysis(raw: RawAnalysis, items: CollectedItem[]): Analysis {
  for (const key of ["themes", "painPoints", "contentIdeas", "salesAngles"] as const) {
    if (!Array.isArray(raw[key])) throw new Error(`LLM 응답에 ${key} 배열이 없습니다.`);
  }
  let dropped = 0;
  const keep = <T extends { evidence: EvidenceRef[] }>(entry: T, text: string): T | null => {
    if (entry.evidence.length === 0 || text.trim() === "") {
      dropped += 1;
      return null;
    }
    return entry;
  };
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  const themes = (raw.themes ?? [])
    .map((t) => keep({ title: str(t.title), whyItMatters: str(t.whyItMatters), evidence: toEvidence(t.evidence, items) }, str(t.title)))
    .filter((t) => t !== null);
  const painPoints = (raw.painPoints ?? [])
    .map((p) => keep({ text: str(p.text), evidence: toEvidence(p.evidence, items) }, str(p.text)))
    .filter((p) => p !== null);
  const contentIdeas = (raw.contentIdeas ?? [])
    .map((c) => keep({ title: str(c.title), reason: str(c.reason), evidence: toEvidence(c.evidence, items) }, str(c.title)))
    .filter((c) => c !== null);
  const salesAngles = (raw.salesAngles ?? [])
    .map((s) => keep({ text: str(s.text), evidence: toEvidence(s.evidence, items) }, str(s.text)))
    .filter((s) => s !== null);
  return { themes, painPoints, contentIdeas, salesAngles, droppedUnsupported: dropped };
}

const onlySample = (evidence: EvidenceRef[]) => evidence.length > 0 && evidence.every((e) => e.isSample);
const SAMPLE_NOTE = " (⚠ 샘플 데이터만 근거 — 실제 커뮤니티 근거 아님)";

export function buildHandoff(analysis: Analysis, generatedAt: string): TopicHandoff {
  return {
    generatedAt,
    topics: analysis.contentIdeas.map((idea) => ({
      title: idea.title,
      reason: `${idea.reason}${onlySample(idea.evidence) ? SAMPLE_NOTE : ""}`,
      sourceLinks: [...new Set(idea.evidence.map((e) => e.link).filter((link) => link !== ""))],
    })),
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function evidenceLines(evidence: EvidenceRef[]): string {
  return evidence
    .map((e) => `  - ${e.isSample ? "[샘플] " : ""}${e.link ? `[${e.title}](${e.link})` : e.title}`)
    .join("\n");
}

export function renderReport(input: {
  date: string;
  days: number;
  items: CollectedItem[];
  promptItemCount: number;
  topKeywords: KeywordCount[];
  watchKeywords: KeywordCount[];
  analysis: Analysis;
  durationMs: number;
  model: string;
}): string {
  const { analysis, items } = input;
  const sampleCount = items.filter((item) => item.isSample).length;
  const bySource = Map.groupBy(items, (item) => item.sourceName);
  const lines: string[] = [];
  lines.push(`# 사장님 커뮤니티·트렌드 리포트 (${input.date})`, "");
  lines.push(
    `- 분석 범위: 최근 ${input.days}일, 글 ${items.length}건 (그중 샘플 ${sampleCount}건, LLM 입력 ${input.promptItemCount}건)`,
    `- 모델: ${input.model} · 분석 소요 ${(input.durationMs / 1000).toFixed(1)}초`,
    `- 근거 글 번호가 없어 버린 LLM 항목: ${analysis.droppedUnsupported}개`,
    "",
  );
  if (sampleCount > 0) {
    lines.push(
      `> ⚠ **샘플 데이터 안내**: \`[샘플]\` 표시 글 ${sampleCount}건은 커뮤니티 글 형태를 흉내 낸 가상의 예시입니다. 실제 사장님 글이 아니므로 근거로 인용하지 마세요.`,
      "",
    );
  }

  lines.push("## 상위 키워드", "", "| 순위 | 키워드 | 글 수 |", "|---|---|---|");
  input.topKeywords.forEach((k, i) => lines.push(`| ${i + 1} | ${cell(k.keyword)} | ${k.itemCount} |`));
  lines.push("", "## 관심 키워드", "", "| 키워드 | 글 수 |", "|---|---|");
  input.watchKeywords.forEach((k) => lines.push(`| ${cell(k.keyword)} | ${k.itemCount} |`));

  lines.push("", "## 주요 테마", "");
  if (analysis.themes.length === 0) lines.push("- (없음)");
  for (const theme of analysis.themes) {
    lines.push(`### ${theme.title}${onlySample(theme.evidence) ? " [샘플 근거만]" : ""}`, "", `왜 중요한가: ${theme.whyItMatters}`, "", "근거 글:", evidenceLines(theme.evidence), "");
  }

  lines.push("## 사장님 고민(Pain points)", "");
  if (analysis.painPoints.length === 0) lines.push("- (없음)");
  for (const pain of analysis.painPoints) {
    lines.push(`- ${pain.text}${onlySample(pain.evidence) ? " [샘플 근거만]" : ""}`, evidenceLines(pain.evidence).replace(/^ {2}/gm, "    "));
  }

  lines.push("", "## 콘텐츠 아이디어 (→ A 콘텐츠 자동화)", "");
  if (analysis.contentIdeas.length === 0) lines.push("- (없음)");
  analysis.contentIdeas.forEach((idea, i) => {
    lines.push(`${i + 1}. **${idea.title}**${onlySample(idea.evidence) ? " [샘플 근거만]" : ""} — ${idea.reason}`, evidenceLines(idea.evidence).replace(/^ {2}/gm, "    "));
  });

  lines.push("", "## 영업 포인트 (→ C 영업 지원)", "");
  if (analysis.salesAngles.length === 0) lines.push("- (없음)");
  for (const angle of analysis.salesAngles) {
    lines.push(`- ${angle.text}${onlySample(angle.evidence) ? " [샘플 근거만]" : ""}`, evidenceLines(angle.evidence).replace(/^ {2}/gm, "    "));
  }

  lines.push("", "## 수집 소스별 글 목록", "");
  for (const [source, list] of bySource) {
    lines.push(`### ${source} (${list.length}건)`, "");
    for (const item of list) {
      lines.push(`- ${item.isSample ? "[샘플] " : ""}${item.link ? `[${item.title}](${item.link})` : item.title} (${item.publishedAt.slice(0, 10)})`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "이 리포트는 공개 소스(Google 뉴스 RSS)와 샘플 파일만으로 만들었습니다. 로그인이 필요한 카페·커뮤니티는 수집하지 않습니다.",
    "",
  );
  return lines.join("\n");
}

/**
 * 최근 글로 키워드를 코드로 집계하고, LLM으로 테마·고민·콘텐츠·영업 포인트를 뽑아
 * 리포트(md/json)와 A용 주제 전달 파일, C용 영업 포인트 파일을 쓴다.
 */
export async function analyze(ctx: AppContext, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const days = options.days ?? 7;
  const now = options.now ?? new Date();
  const items = selectRecent(readItems(ctx), days, now);
  if (items.length === 0) throw new Error(`최근 ${days}일 안에 수집된 글이 없습니다. 먼저 collect 를 실행하세요.`);

  const texts = items.map(itemText);
  const watch = options.watchKeywords ?? loadWatchKeywords();
  const topKeywords = countKeywords(texts, 20);
  const watchKeywords = countWatchKeywords(texts, watch);
  // 실제 글을 먼저, 샘플은 뒤에 둔다 (각각 최신순).
  const promptItems = [...items.filter((item) => !item.isSample), ...items.filter((item) => item.isSample)].slice(0, MAX_PROMPT_ITEMS);

  const prompt = loadPrompt("d-community-monitor-analyze", {
    days: String(days),
    itemCount: String(promptItems.length),
    items: formatItemsForPrompt(promptItems),
    topKeywords: topKeywords.map((k) => `${k.keyword}(${k.itemCount})`).join(", "),
    watchKeywords: watchKeywords.map((k) => `${k.keyword}(${k.itemCount})`).join(", "),
  });

  const started = performance.now();
  // JSON 해석·검증까지 track 안에서 해야 잘못된 응답이 failed 지표로 남는다.
  const analysis = await ctx.metrics.track(
    PROTOTYPE,
    { stage: "analyze", kind: "trend-report", items: String(promptItems.length) },
    async () => {
      const text = await ctx.llm.complete({ ...prompt, temperature: 0.3 });
      return normalizeAnalysis(parseJsonResponse<RawAnalysis>(text), promptItems);
    },
  );
  const durationMs = Math.round(performance.now() - started);

  const date = reportDate(now);
  const reportFile = `${REPORTS_DIR}/${date}.md`;
  const report = renderReport({
    date,
    days,
    items,
    promptItemCount: promptItems.length,
    topKeywords,
    watchKeywords,
    analysis,
    durationMs,
    model: ctx.config.llmModel,
  });
  const reportPath = ctx.store.writeText(reportFile, report);
  const generatedAt = nowIso();
  ctx.store.writeJson(`${REPORTS_DIR}/${date}.json`, {
    generatedAt,
    days,
    itemCount: items.length,
    sampleCount: items.filter((item) => item.isSample).length,
    durationMs,
    topKeywords,
    watchKeywords,
    analysis,
  });

  const handoff = buildHandoff(analysis, generatedAt);
  writeTopicHandoff(ctx.store, handoff);
  ctx.store.writeJson(SALES_ANGLES_FILE, {
    generatedAt,
    angles: analysis.salesAngles.map((angle) => ({
      text: `${angle.text}${onlySample(angle.evidence) ? SAMPLE_NOTE : ""}`,
      sourceLinks: angle.evidence.map((e) => e.link).filter((link) => link !== ""),
    })),
  });

  return {
    reportPath,
    reportFile,
    itemCount: items.length,
    sampleCount: items.filter((item) => item.isSample).length,
    promptItemCount: promptItems.length,
    durationMs,
    topKeywords,
    watchKeywords,
    analysis,
    handoff,
  };
}
