import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApprovalItem } from "../../shared/approval.ts";
import type { AppContext } from "../../shared/context.ts";
import { type TopicSuggestion, readTopicHandoff } from "../../shared/handoff.ts";
import { parseJsonResponse } from "../../shared/llm.ts";
import { EVENTS } from "../../shared/metrics.ts";
import { loadPrompt } from "../../shared/prompts.ts";
import { newId, nowIso } from "../../shared/store.ts";
import { findHanCharacters } from "../../shared/text.ts";

export const PROTOTYPE = "a-content" as const;
export const APPROVAL_KIND = "blog-post";
/** 본문 최소 길이(공백 포함). 이보다 짧으면 정보 글로 쓰기 어렵다고 본다. */
export const MIN_BODY_LENGTH = 600;

const SAMPLES_DIR = resolve(import.meta.dirname, "samples");

export interface Brand {
  serviceName: string;
  oneLiner: string;
  landingUrl: string;
  tone: string;
  audience: string;
}

export interface TopicList {
  source: "handoff" | "samples";
  topics: TopicSuggestion[];
}

export interface LlmDraft {
  title: string;
  body: string;
  summary: string;
}

export interface Draft {
  id: string;
  approvalId: string;
  slug: string;
  topic: string;
  title: string;
  summary: string;
  /** CTA까지 붙은 최종 본문(마크다운) */
  body: string;
  /** 사람이 검토할 때 볼 경고 (예: 근거 없는 수치 의심) */
  warnings: string[];
  file: string;
}

export function loadBrand(): Brand {
  return JSON.parse(readFileSync(resolve(SAMPLES_DIR, "brand.json"), "utf8")) as Brand;
}

/** D가 넘겨준 주제가 있으면 그것을, 없으면 samples/topics.json 을 쓴다. */
export function listTopics(ctx: AppContext): TopicList {
  const handoff = readTopicHandoff(ctx.store);
  if (handoff && handoff.topics.length > 0) return { source: "handoff", topics: handoff.topics };
  const topics = JSON.parse(readFileSync(resolve(SAMPLES_DIR, "topics.json"), "utf8")) as TopicSuggestion[];
  return { source: "samples", topics };
}

export function pickTopic(ctx: AppContext, title?: string): TopicSuggestion {
  const { topics } = listTopics(ctx);
  if (!title) {
    if (topics.length === 0) throw new Error("사용할 주제가 없습니다.");
    return topics[0];
  }
  // 목록에 없는 주제도 직접 입력할 수 있게 한다.
  return topics.find((topic) => topic.title === title) ?? { title, reason: "직접 입력한 주제", sourceLinks: [] };
}

/** 한글 제목은 URL 슬러그로 쓰기 어려우므로 날짜 + 짧은 id 로 만든다. */
export function makeSlug(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `post-${date}-${newId("x").slice(2, 8)}`;
}

export function buildLandingUrl(landingUrl: string, slug: string): string {
  const url = new URL(landingUrl);
  url.searchParams.set("utm_source", "blog");
  url.searchParams.set("utm_medium", "content");
  url.searchParams.set("utm_campaign", slug);
  return url.toString();
}

/** CTA는 LLM이 아니라 코드가 붙인다. 링크·문구가 항상 일정하게 유지된다. */
export function appendCta(body: string, brand: Brand, slug: string): string {
  const link = buildLandingUrl(brand.landingUrl, slug);
  // 서비스명 받침에 따라 조사(은/는)가 바뀌므로 조사 없이 "이름 — 설명" 형태로 쓴다.
  return `${body.trim()}\n\n---\n\n**${brand.serviceName}** — ${brand.oneLiner}\n\n단골 관리를 조금 더 쉽게 해 보고 싶으시다면 [${brand.serviceName} 알아보기](${link})\n`;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{.*?\}\}/,
  /\bTODO\b/i,
  /lorem ipsum/i,
  /(?<![A-Za-z])(O{2,}|X{2,})(?![A-Za-z])|○○|ㅇㅇ/,
  /\[(가게|매장|상호|브랜드|이름|링크|URL|주소)[^\]]*\]/i,
  // 따옴표로 감싼 빈칸: “고객이름”, "가게 이름" 등
  /[“"'‘](고객\s*이름|고객명|손님\s*이름|가게\s*이름|매장명|상호명)[”"'’]/,
];

/** 실패하면 throw 해서 metrics.track 이 failed 로 기록하게 한다. */
export function validateDraft(raw: unknown): LlmDraft {
  if (!raw || typeof raw !== "object") throw new Error("검증 실패: LLM 응답이 객체가 아닙니다.");
  const draft = raw as Partial<Record<keyof LlmDraft, unknown>>;
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  // 일부 모델은 JSON 안에서 줄바꿈을 이중 이스케이프해 본문에 "\\n" 글자가 그대로 남는다.
  const body = typeof draft.body === "string" ? draft.body.replace(/\\n/g, "\n").trim() : "";
  const summary = typeof draft.summary === "string" ? draft.summary.trim() : "";
  const problems: string[] = [];
  if (!title) problems.push("제목이 비어 있음");
  if (body.length < MIN_BODY_LENGTH) problems.push(`본문이 너무 짧음 (${body.length}자 < ${MIN_BODY_LENGTH}자)`);
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const hit = `${title}\n${body}`.match(pattern);
    if (hit) problems.push(`빈칸 표시가 남아 있음: "${hit[0]}"`);
  }
  // Qwen 계열은 한국어 글에 한자(중국어) 토큰이 섞여 나오는 경우가 있다. 예: "핵심卖点"
  const han = findHanCharacters(`${title}\n${body}`);
  if (han) problems.push(`한자(중국어)가 섞여 있음: "${han}"`);
  if (problems.length > 0) throw new Error(`검증 실패: ${problems.join(", ")}`);
  return { title, body, summary };
}

/** 막지는 않지만 사람이 꼭 확인해야 할 부분 (근거 없는 수치·인용 의심). */
export function findWarnings(body: string): string[] {
  const warnings: string[] = [];
  const percents = body.match(/\d+(\.\d+)?\s?(%|퍼센트)/g);
  if (percents) warnings.push(`수치 표현 확인 필요: ${[...new Set(percents)].join(", ")}`);
  if (/(조사|연구|통계|설문)에\s?(따르면|의하면)/.test(body)) warnings.push("출처 없는 조사·통계 인용 의심");
  return warnings;
}

function renderDraftFile(draft: Omit<Draft, "file">): string {
  return [
    `# ${draft.title}`,
    "",
    `> 요약: ${draft.summary}`,
    `> 주제: ${draft.topic} · slug: ${draft.slug} · 승인 id: ${draft.approvalId}`,
    ...(draft.warnings.length ? [`> ⚠️ 검토 경고: ${draft.warnings.join(" / ")}`] : []),
    "",
    draft.body,
  ].join("\n");
}

/** 주제 하나로 글 초안을 만들고 승인 대기열에 올린다. */
export async function generateDraft(ctx: AppContext, topic: TopicSuggestion, variantIndex = 0): Promise<Draft> {
  const brand = loadBrand();
  const slug = makeSlug();
  const prompt = loadPrompt("a-content-draft", {
    brandName: brand.serviceName,
    brandOneLiner: brand.oneLiner,
    tone: brand.tone,
    audience: brand.audience,
    topic: topic.title,
    topicReason: topic.reason,
    variant: variantIndex > 0 ? `같은 주제로 ${variantIndex + 1}번째 글입니다. 앞의 글과 다른 관점과 예시로 써 주세요.` : "",
  });

  const llmDraft = await ctx.metrics.track(PROTOTYPE, { topic: topic.title, slug }, async () => {
    const text = await ctx.llm.complete({ system: prompt.system, user: prompt.user, temperature: 0.6, json: true });
    return validateDraft(parseJsonResponse<unknown>(text));
  });

  const body = appendCta(llmDraft.body, brand, slug);
  const warnings = findWarnings(llmDraft.body);
  const id = newId("draft");
  const approval = ctx.approvals.submit({
    prototype: PROTOTYPE,
    kind: APPROVAL_KIND,
    title: llmDraft.title,
    body,
    meta: { slug, topic: topic.title, draftId: id, summary: llmDraft.summary, warnings: warnings.join(" / ") },
  });
  const content = { id, approvalId: approval.id, slug, topic: topic.title, title: llmDraft.title, summary: llmDraft.summary, body, warnings };
  const file = ctx.store.writeText(`${PROTOTYPE}/drafts/${id}.md`, renderDraftFile(content));
  return { ...content, file };
}

export async function generateDrafts(ctx: AppContext, options: { topic?: string; count?: number } = {}): Promise<Draft[]> {
  const topic = pickTopic(ctx, options.topic);
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new Error(`--count 는 1 이상의 정수여야 합니다: ${count}`);
  const drafts: Draft[] = [];
  for (let index = 0; index < count; index++) drafts.push(await generateDraft(ctx, topic, index));
  return drafts;
}

export function listPending(ctx: AppContext): ApprovalItem[] {
  return ctx.approvals.list({ prototype: PROTOTYPE, status: "pending" });
}

/** 승인 id 또는 draft id 로 찾는다. */
export function findItem(ctx: AppContext, id: string): ApprovalItem {
  const item = ctx.approvals
    .list({ prototype: PROTOTYPE })
    .find((candidate) => candidate.id === id || candidate.meta.draftId === id);
  if (!item) throw new Error(`a-content 항목을 찾을 수 없습니다: ${id}`);
  return item;
}

export interface PublishResult {
  item: ApprovalItem;
  file: string;
  messageId: string;
}

/** 승인 → (dry-run) 블로그 발행 → published/<slug>.md 저장 */
export async function approve(ctx: AppContext, id: string, note?: string): Promise<PublishResult> {
  const item = ctx.approvals.decide(findItem(ctx, id).id, "approved", note);
  ctx.metrics.record(PROTOTYPE, EVENTS.approved, { meta: { approvalId: item.id, slug: item.meta.slug } });
  const result = await ctx.channel.send({ channel: "blog", to: "blog", subject: item.title, body: item.body, isAdvertising: false });
  const file = ctx.store.writeText(
    `${PROTOTYPE}/published/${item.meta.slug}.md`,
    `# ${item.title}\n\n<!-- published ${nowIso()} · ${result.status} · ${result.id} -->\n\n${item.body}`,
  );
  ctx.metrics.record(PROTOTYPE, EVENTS.sent, { meta: { approvalId: item.id, slug: item.meta.slug, messageId: result.id } });
  return { item, file, messageId: result.id };
}

export function reject(ctx: AppContext, id: string, note?: string): ApprovalItem {
  const item = ctx.approvals.decide(findItem(ctx, id).id, "rejected", note);
  ctx.metrics.record(PROTOTYPE, EVENTS.rejected, { meta: { approvalId: item.id, slug: item.meta.slug, note: note ?? "" } });
  return item;
}
