import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileStore } from "../../shared/store.ts";
import { newId, nowIso } from "../../shared/store.ts";

export const PROTOTYPE = "b-lead-followup" as const;
export const LEADS_FILE = "b-lead-followup/leads.jsonl";
export const FOLLOWUPS_FILE = "b-lead-followup/followups.jsonl";

export const INDUSTRIES = ["카페", "음식점", "미용", "학원", "기타"] as const;
export type Industry = (typeof INDUSTRIES)[number];

export interface Brand {
  serviceName: string;
  companyName: string;
  tagline: string;
  description: string;
  valueProps: { title: string; body: string }[];
  senderName: string;
  contactEmail: string;
  unsubscribeGuide: string;
  consentVersion: string;
  privacyConsentText: string;
  marketingConsentText: string;
}

export function loadBrand(): Brand {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "samples/brand.json"), "utf8")) as Brand;
}

export interface Utm {
  source: string;
  medium: string;
  campaign: string;
}

export interface Lead {
  id: string;
  createdAt: string;
  company: string;
  name: string;
  email: string;
  industry: Industry;
  concern: string;
  utm: Utm;
  /** 동의 당시 문구 버전 (brand.json consentVersion). 동의 증빙용 */
  consentVersion: string;
  privacyConsentAt: string;
  /** 광고성 정보 수신 동의 시각. 동의하지 않았으면 null */
  marketingConsentAt: string | null;
}

/** 폼 입력 원본. 폼(urlencoded)과 JSON 모두 문자열로 정규화해서 받는다. */
export interface LeadInput {
  company: string;
  name: string;
  email: string;
  industry: string;
  concern: string;
  privacyConsent: boolean;
  marketingConsent: boolean;
  utm: Utm;
}

export type FieldErrors = Partial<Record<"company" | "name" | "email" | "industry" | "concern" | "privacyConsent", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = { company: 100, name: 50, email: 200, concern: 2000, utm: 100 };

/** 체크박스 값: 폼은 "on", JSON은 true/"true" 등 */
function isChecked(value: unknown): boolean {
  return value === true || value === "on" || value === "true" || value === "1" || value === "yes";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeInput(raw: Record<string, unknown>): LeadInput {
  return {
    company: text(raw.company, MAX.company),
    name: text(raw.name, MAX.name),
    email: text(raw.email, MAX.email),
    industry: text(raw.industry, 20),
    // 길이 초과는 잘라내지 않고 검증에서 알려준다
    concern: typeof raw.concern === "string" ? raw.concern.trim() : "",
    privacyConsent: isChecked(raw.privacyConsent),
    marketingConsent: isChecked(raw.marketingConsent),
    utm: {
      source: text(raw.utm_source, MAX.utm),
      medium: text(raw.utm_medium, MAX.utm),
      campaign: text(raw.utm_campaign, MAX.utm),
    },
  };
}

export function validate(input: LeadInput): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.company) errors.company = "매장/회사명을 입력해 주세요.";
  if (!input.name) errors.name = "담당자명을 입력해 주세요.";
  if (!input.email) errors.email = "이메일을 입력해 주세요.";
  else if (!EMAIL.test(input.email)) errors.email = "이메일 형식이 올바르지 않습니다.";
  if (!(INDUSTRIES as readonly string[]).includes(input.industry)) errors.industry = "업종을 선택해 주세요.";
  if (!input.concern) errors.concern = "고민이나 문의 내용을 적어 주세요.";
  else if (input.concern.length > MAX.concern) errors.concern = `문의 내용은 ${MAX.concern}자 이내로 적어 주세요.`;
  if (!input.privacyConsent) errors.privacyConsent = "개인정보 수집·이용에 동의해야 문의를 접수할 수 있습니다.";
  return errors;
}

export function saveLead(store: FileStore, input: LeadInput, consentVersion: string): Lead {
  const at = nowIso();
  const lead: Lead = {
    id: newId("lead"),
    createdAt: at,
    company: input.company,
    name: input.name,
    email: input.email,
    industry: input.industry as Industry,
    concern: input.concern,
    utm: input.utm,
    consentVersion,
    privacyConsentAt: at,
    marketingConsentAt: input.marketingConsent ? at : null,
  };
  store.appendJsonl(LEADS_FILE, lead);
  return lead;
}

export function listLeads(store: FileStore): Lead[] {
  return store.readJsonl<Lead>(LEADS_FILE);
}

export type FollowUpStatus = "sent-advertising" | "pending-approval" | "sent-after-approval" | "rejected" | "failed";

/** 후속 메시지 상태 변화 기록. 리드별 마지막 기록이 현재 상태다. */
export interface FollowUpRecord {
  at: string;
  leadId: string;
  status: FollowUpStatus;
  messageId?: string;
  approvalId?: string;
  error?: string;
}

export function recordFollowUp(store: FileStore, record: Omit<FollowUpRecord, "at">): void {
  store.appendJsonl(FOLLOWUPS_FILE, { at: nowIso(), ...record } satisfies FollowUpRecord);
}

export function latestFollowUps(store: FileStore): Map<string, FollowUpRecord> {
  const latest = new Map<string, FollowUpRecord>();
  for (const record of store.readJsonl<FollowUpRecord>(FOLLOWUPS_FILE)) latest.set(record.leadId, record);
  return latest;
}
