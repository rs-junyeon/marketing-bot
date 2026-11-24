import { findHanCharacters } from "../shared/text.ts";
import type { EngineEvent, FactValue, MessageContent, Subject } from "./domain.ts";
import type { Condition, FieldRule } from "./playbook.ts";
import type { ServiceConfig } from "./services.ts";

/**
 * 모델 밖에서 결정하는 규칙들. 모두 순수 함수라 테스트로 동작을 고정할 수 있다.
 * "누구에게, 언제 보낼지"는 여기서 정하고, 모델은 "무엇을 말할지"만 맡는다.
 */

// ---------- 조건 판단 ----------

export function resolveFact(fact: string, subject: Subject, event: EngineEvent): FactValue | undefined {
  const [scope, name] = fact.split(".", 2) as ["subject" | "event", string];
  const source = scope === "subject" ? subject.facts : event.payload;
  return Object.hasOwn(source, name) ? source[name] : undefined;
}

export function evaluateCondition(condition: Condition, subject: Subject, event: EngineEvent): boolean {
  const actual = resolveFact(condition.fact, subject, event);
  const expected = condition.value;
  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "missing":
      return actual === undefined || actual === null;
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && actual !== undefined && expected.includes(actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      if (condition.op === "gt") return actual > expected;
      if (condition.op === "gte") return actual >= expected;
      if (condition.op === "lt") return actual < expected;
      return actual <= expected;
    }
  }
}

/** 통과하지 못한 첫 조건을 사람이 읽을 수 있는 사유로 돌려준다. 모두 통과하면 null. */
export function firstFailedCondition(conditions: Condition[], subject: Subject, event: EngineEvent): string | null {
  for (const condition of conditions) {
    if (!evaluateCondition(condition, subject, event)) {
      const actual = resolveFact(condition.fact, subject, event);
      return `condition_failed:${condition.fact} ${condition.op} ${JSON.stringify(condition.value ?? null)} (실제 ${JSON.stringify(actual ?? null)})`;
    }
  }
  return null;
}

// ---------- 야간 광고 제한 ----------

/**
 * 정보통신망법 제50조 제3항: 21시~다음 날 8시에 광고성 정보를 보내려면 별도 동의가 필요하다.
 * 한국은 서머타임이 없어 UTC+9 고정 오프셋으로 계산한다.
 */
export const NIGHT_START_HOUR = 21;
export const NIGHT_END_HOUR = 8;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isNightInKorea(at: Date): boolean {
  const hour = new Date(at.getTime() + KST_OFFSET_MS).getUTCHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** 야간이면 다음 오전 8시(KST)를, 아니면 그대로 돌려준다. */
export function nextDaytimeInKorea(at: Date): Date {
  if (!isNightInKorea(at)) return at;
  const kst = new Date(at.getTime() + KST_OFFSET_MS);
  const morning = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), NIGHT_END_HOUR);
  const target = kst.getUTCHours() >= NIGHT_START_HOUR ? morning + 24 * 60 * 60 * 1000 : morning;
  return new Date(target - KST_OFFSET_MS);
}

/** 광고성이고 야간 동의가 없으면 낮으로 미룬 발송 가능 시각 */
export function earliestSendTime(at: Date, advertising: boolean, subject: Subject): Date {
  if (!advertising || subject.consents.nightMarketing) return at;
  return nextDaytimeInKorea(at);
}

// ---------- 문구 검증 ----------

/** 모든 서비스 공통 금지 표현 (과장·보장 표현은 표시광고법 위반 소지) */
export const COMMON_BANNED_WORDS = ["무조건", "100%", "보장", "최고의", "업계 1위", "완전 무료"];

const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const NUMBER_PATTERN = /\d[\d,.]*/g;

export interface ValidationContext {
  service: ServiceConfig;
  /** 프롬프트에 넣은 값들. 문구의 숫자는 여기에 있는 숫자만 허용한다. */
  inputText: string;
  /** true면 숫자 출처 검사를 한다 (모델 생성 문구). 고정 템플릿은 검사하지 않는다. */
  checkNumbers: boolean;
}

function normalizeNumber(value: string): string {
  return value.replace(/[,.]+$/, "").replaceAll(",", "");
}

export function validateContent(content: MessageContent, rules: { title?: FieldRule; body: FieldRule }, ctx: ValidationContext): string[] {
  const issues: string[] = [];
  const fields: [keyof MessageContent, FieldRule | undefined][] = [
    ["title", rules.title],
    ["body", rules.body],
  ];
  const allowedNumbers = new Set((ctx.inputText.match(NUMBER_PATTERN) ?? []).map(normalizeNumber));
  const banned = [...COMMON_BANNED_WORDS, ...ctx.service.bannedWords];

  for (const [field, rule] of fields) {
    const value = content[field];
    if (!rule) {
      if (value) issues.push(`${field}: 이 플레이북은 ${field}를 쓰지 않습니다.`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      issues.push(`${field}: 비어 있습니다.`);
      continue;
    }
    if ([...value].length > rule.maxLength) issues.push(`${field}: ${rule.maxLength}자를 넘습니다 (${[...value].length}자).`);
    const han = findHanCharacters(value);
    if (han) issues.push(`${field}: 한자가 섞였습니다 (${han}).`);
    if (/\{\{|\}\}/.test(value)) issues.push(`${field}: 채워지지 않은 변수가 있습니다.`);
    for (const word of banned) if (value.includes(word)) issues.push(`${field}: 금지 표현 "${word}"`);
    for (const url of value.match(URL_PATTERN) ?? []) {
      if (!ctx.service.brand.landingUrl || !url.startsWith(ctx.service.brand.landingUrl)) issues.push(`${field}: 허용되지 않은 링크 ${url}`);
    }
    if (ctx.checkNumbers) {
      const withoutUrls = value.replace(URL_PATTERN, "");
      for (const number of withoutUrls.match(NUMBER_PATTERN) ?? []) {
        if (!allowedNumbers.has(normalizeNumber(number))) issues.push(`${field}: 입력에 없는 숫자 "${number}" (지어낸 수치 의심)`);
      }
    }
    if (field === "body" && (value.includes("(광고)") || value.includes(ctx.service.optOutText))) {
      issues.push("body: (광고) 표기와 수신거부 안내는 엔진이 붙이므로 문구에 넣지 않습니다.");
    }
  }
  return issues;
}

/**
 * 광고성 메시지 법정 표기 (정보통신망법 제50조 제4항):
 * 맨 앞에 "(광고)"와 보내는 곳, 끝에 수신거부 방법. 모델이 아니라 엔진이 항상 붙인다.
 */
export function applyAdvertisingNotice(content: MessageContent, service: ServiceConfig): MessageContent {
  const prefix = `(광고) ${service.brand.name}`;
  if (content.title !== undefined) {
    return { title: `${prefix} ${content.title}`, body: `${content.body}\n\n${service.optOutText}` };
  }
  return { body: `${prefix}\n${content.body}\n\n${service.optOutText}` };
}
