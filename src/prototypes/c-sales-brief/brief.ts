import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApprovalItem } from "../../shared/approval.ts";
import type { AppContext } from "../../shared/context.ts";
import { parseJsonResponse } from "../../shared/llm.ts";
import { EVENTS } from "../../shared/metrics.ts";
import { loadPrompt } from "../../shared/prompts.ts";
import { nowIso } from "../../shared/store.ts";
import type { FetchResult, PageFetcher } from "./fetcher.ts";

export const PROTOTYPE = "c-sales-brief";
export const APPROVAL_KIND = "sales-proposal";
export const BRIEF_DIR = "c-sales-brief/briefs";
export const DEFAULT_OFFERING_PATH = resolve(import.meta.dirname, "samples/offering.json");

export interface SalesTarget {
  name: string;
  url?: string;
  industry?: string;
  notes?: string;
}

/** LLM이 돌려줘야 하는 브리프 구조. facts 와 assumptions 를 반드시 나눈다. */
export interface BriefContent {
  summary: string;
  facts: string[];
  assumptions: string[];
  painPoints: string[];
  pitchAngle: string;
  recommendedOffering: string;
  proposalDraft: string;
  meetingQuestions: string[];
}

export interface BriefResult {
  slug: string;
  filePath: string;
  approval: ApprovalItem;
  content: BriefContent;
  fetch: FetchResult | null;
}

export interface BriefDeps {
  fetcher: PageFetcher;
  /** 우리 회사 서비스·포트폴리오 JSON 경로. 기본은 samples/offering.json */
  offeringPath?: string;
}

/** 대상 1곳: (URL 수집) → LLM 브리프 → 마크다운 저장 → 승인 대기열 제출 */
export async function createBrief(ctx: AppContext, target: SalesTarget, deps: BriefDeps): Promise<BriefResult> {
  const name = target.name?.trim();
  if (!name) throw new Error("대상 이름(name)이 비어 있습니다.");
  const url = target.url?.trim() || undefined;
  const offering = readFileSync(deps.offeringPath ?? DEFAULT_OFFERING_PATH, "utf8");

  const { content, fetch } = await ctx.metrics.track(PROTOTYPE, { target: name, url: url ?? "" }, async () => {
    // 수집 실패는 예외가 아니라 결과값으로 받아, 있는 정보만으로 계속 진행한다.
    const fetched = url ? await deps.fetcher.fetchPage(url) : null;
    const prompt = loadPrompt("c-sales-brief-generate", {
      offering,
      name,
      industry: target.industry?.trim() || "(정보 없음)",
      url: url ?? "(없음)",
      notes: target.notes?.trim() || "(없음)",
      page: describePage(fetched),
    });
    const raw = await ctx.llm.complete({ ...prompt, temperature: 0.3 });
    return { content: validateBrief(parseJsonResponse<unknown>(raw)), fetch: fetched };
  });

  const slug = uniqueSlug(ctx, name);
  const markdown = renderBriefMarkdown({ target: { ...target, name, url }, content, fetch, model: ctx.config.llmModel });
  const file = `${BRIEF_DIR}/${slug}.md`;
  const filePath = ctx.store.writeText(file, markdown);
  const approval = ctx.approvals.submit({
    prototype: PROTOTYPE,
    kind: APPROVAL_KIND,
    title: `영업 제안 브리프: ${name}`,
    body: markdown,
    meta: { slug, target: name, url: url ?? "", file },
  });
  return { slug, filePath, approval, content, fetch };
}

export interface BatchOutcome {
  target: string;
  result?: BriefResult;
  error?: string;
}

/** 여러 대상을 차례로 처리한다. 한 곳이 실패해도 나머지는 계속한다. */
export async function createBriefsFromFile(ctx: AppContext, filePath: string, deps: BriefDeps): Promise<BatchOutcome[]> {
  const targets = readTargets(filePath);
  const outcomes: BatchOutcome[] = [];
  for (const target of targets) {
    try {
      outcomes.push({ target: target.name, result: await createBrief(ctx, target, deps) });
    } catch (error) {
      outcomes.push({ target: target.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

export function readTargets(filePath: string): SalesTarget[] {
  if (!existsSync(filePath)) throw new Error(`대상 파일을 찾을 수 없습니다: ${filePath}`);
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(list) || list.length === 0) throw new Error("대상 파일은 비어 있지 않은 배열(또는 {targets: [...]})이어야 합니다.");
  return list.map((item, index) => {
    const record = item as Partial<Record<keyof SalesTarget, unknown>>;
    if (typeof record.name !== "string" || record.name.trim() === "") {
      throw new Error(`대상 파일 ${index + 1}번째 항목에 name 이 없습니다.`);
    }
    const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
    return { name: record.name, url: optional(record.url), industry: optional(record.industry), notes: optional(record.notes) };
  });
}

function describePage(fetched: FetchResult | null): string {
  if (!fetched) return "(URL이 주어지지 않아 수집한 페이지가 없습니다.)";
  if (!fetched.ok) return `(페이지 수집 실패: ${fetched.reason}) 페이지 내용은 사용할 수 없습니다.`;
  return [`제목: ${fetched.title || "(없음)"}`, fetched.text, fetched.truncated ? "...(이하 생략)" : ""].join("\n").trim();
}

const STRING_FIELDS = ["summary", "pitchAngle", "recommendedOffering", "proposalDraft"] as const;
const LIST_FIELDS = ["facts", "assumptions", "painPoints", "meetingQuestions"] as const;

/** 필수 필드가 모두 있고 형식이 맞는지 확인한다. 하나라도 어긋나면 에러. */
export function validateBrief(value: unknown): BriefContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LLM 응답이 JSON 객체가 아닙니다.");
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of STRING_FIELDS) {
    if (typeof record[key] !== "string" || (record[key] as string).trim() === "") problems.push(`${key}(문자열)`);
  }
  for (const key of LIST_FIELDS) {
    const list = record[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) problems.push(`${key}(문자열 배열)`);
  }
  for (const key of ["painPoints", "meetingQuestions"] as const) {
    if (Array.isArray(record[key]) && (record[key] as unknown[]).length === 0) problems.push(`${key}(최소 1개)`);
  }
  if (problems.length) throw new Error(`LLM 응답에 필수 필드가 없거나 형식이 다릅니다: ${problems.join(", ")}`);

  const clean = (list: unknown) => (list as string[]).map((entry) => entry.trim()).filter(Boolean);
  return {
    summary: (record.summary as string).trim(),
    facts: clean(record.facts),
    assumptions: clean(record.assumptions),
    painPoints: clean(record.painPoints),
    pitchAngle: (record.pitchAngle as string).trim(),
    recommendedOffering: (record.recommendedOffering as string).trim(),
    proposalDraft: (record.proposalDraft as string).trim(),
    meetingQuestions: clean(record.meetingQuestions),
  };
}

export function renderBriefMarkdown(input: {
  target: SalesTarget;
  content: BriefContent;
  fetch: FetchResult | null;
  model: string;
}): string {
  const { target, content, fetch } = input;
  const bullets = (list: string[], empty: string) => (list.length ? list.map((item) => `- ${item}`).join("\n") : `- ${empty}`);

  let source: string;
  if (!target.url) source = "- 홈페이지: 주어지지 않음 (메모만 사용)";
  else if (!fetch || !fetch.ok) source = `- 홈페이지: ${target.url}\n- 수집 결과: **실패** — ${fetch && !fetch.ok ? fetch.reason : "알 수 없음"}`;
  else {
    source = `- 홈페이지: ${target.url} (페이지 1개만 조회)\n- 수집 결과: 성공 — 제목 "${fetch.title || "없음"}", 본문 ${fetch.text.length}자${fetch.truncated ? " (앞부분만 사용)" : ""}`;
  }

  return `# 영업 브리프: ${target.name}

> 내부 영업 준비용 초안입니다. 외부로 자동 발송하지 않으며, 영업 담당자가 확인·수정한 뒤 직접 전달합니다.
> 업종: ${target.industry?.trim() || "정보 없음"} · 생성: ${nowIso()} · 모델: ${input.model}

## 대상 요약

${content.summary}

## 확인된 사실

${bullets(content.facts, "입력 정보에서 확인된 사실이 없습니다.")}

## 추정(검증 필요)

${bullets(content.assumptions, "추정 항목 없음")}

## 예상 고민

${bullets(content.painPoints, "없음")}

## 제안 각도

${content.pitchAngle}

## 추천 서비스

${content.recommendedOffering}

## 제안서 초안

${content.proposalDraft}

## 미팅 질문

${content.meetingQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")}

## 수집 정보 출처/실패 사유

${source}
- 영업 메모: ${target.notes?.trim() || "없음"}
`;
}

/** 대상 이름으로 파일명을 만든다. 한글은 유지하고, 이미 있으면 -2, -3 을 붙인다. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "target";
}

function uniqueSlug(ctx: AppContext, name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; existsSync(ctx.store.path(BRIEF_DIR, `${slug}.md`)); n++) slug = `${base}-${n}`;
  return slug;
}

// ---- 영업 담당자 검토 흐름 ----

export function listBriefs(ctx: AppContext, status?: ApprovalItem["status"]): ApprovalItem[] {
  return ctx.approvals.list({ prototype: PROTOTYPE, status }).filter((item) => item.kind === APPROVAL_KIND);
}

export function getBrief(ctx: AppContext, id: string): ApprovalItem {
  const item = ctx.approvals.get(id);
  if (item.prototype !== PROTOTYPE || item.kind !== APPROVAL_KIND) throw new Error(`영업 브리프 항목이 아닙니다: ${id}`);
  return item;
}

/** 승인 = 영업 담당자가 전달해도 되는 상태로 표시. 실제 전달은 사람이 한다. */
export function approveBrief(ctx: AppContext, id: string, note?: string): ApprovalItem {
  getBrief(ctx, id);
  const item = ctx.approvals.decide(id, "approved", note);
  ctx.metrics.record(PROTOTYPE, EVENTS.approved, { meta: { approvalId: id, target: item.meta.target ?? "" } });
  return item;
}

export function rejectBrief(ctx: AppContext, id: string, note?: string): ApprovalItem {
  getBrief(ctx, id);
  const item = ctx.approvals.decide(id, "rejected", note);
  ctx.metrics.record(PROTOTYPE, EVENTS.rejected, { meta: { approvalId: id, target: item.meta.target ?? "", note: note ?? "" } });
  return item;
}

/** 승인된 브리프로 미팅이 잡혔음을 기록한다(효과 지표). 같은 항목은 한 번만. */
export function recordMeeting(ctx: AppContext, id: string): ApprovalItem {
  const item = getBrief(ctx, id);
  if (item.status !== "approved") throw new Error(`승인된 브리프만 미팅을 기록할 수 있습니다 (현재: ${item.status}): ${id}`);
  const already = ctx.metrics
    .all()
    .some((event) => event.prototype === PROTOTYPE && event.name === EVENTS.meetingBooked && event.meta?.approvalId === id);
  if (already) throw new Error(`이미 미팅이 기록된 항목입니다: ${id}`);
  ctx.metrics.record(PROTOTYPE, EVENTS.meetingBooked, { meta: { approvalId: id, target: item.meta.target ?? "" } });
  return item;
}
