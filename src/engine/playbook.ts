import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS, type ChannelKind, type FactValue } from "./domain.ts";
import { InputError, bool, isFactValue, num, obj, oneOf, optStr, str } from "./input.ts";

/**
 * 플레이북 = 마케팅 시나리오 하나. 코드가 아니라 config/playbooks/*.json 설정으로 정의한다.
 * 새 시나리오를 추가할 때 엔진 코드는 바뀌지 않는다.
 */

export const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "missing", "in"] as const;
export type Operator = (typeof OPERATORS)[number];

/** fact는 "subject.<이름>" 또는 "event.<이름>" 형식. 예: subject.couponSentCount */
export interface Condition {
  fact: string;
  op: Operator;
  value?: FactValue | FactValue[];
}

export interface FieldRule {
  maxLength: number;
}

export type Generation =
  /** 모델이 JSON {title?, body}를 만든다. prompt는 prompts/<prompt>.md */
  | { mode: "llm"; prompt: string; fields: { title?: FieldRule; body: FieldRule } }
  /** 모델을 부르지 않고 고정 문구에 변수만 채운다. */
  | { mode: "template"; title?: string; body: string; fields: { title?: FieldRule; body: FieldRule } };

export interface Playbook {
  id: string;
  service: string;
  name: string;
  enabled: boolean;
  trigger: { event: string; delayMinutes: number };
  conditions: Condition[];
  /** 광고성 정보 여부. true면 수신 동의·야간 제한·(광고) 표기·수신거부 안내가 자동 적용된다. */
  advertising: boolean;
  /** 같은 대상에게 이 플레이북을 다시 보내기까지 최소 일수 */
  frequencyDays: number;
  generation: Generation;
  /** auto: 검증 통과 시 바로 발송 대기, manual: 운영자 승인 후 발송 */
  approval: "auto" | "manual";
  channel: ChannelKind;
  /** 효과 측정: 발송 후 windowDays 안에 이 이벤트가 오면 전환으로 기록 */
  goal?: { event: string; windowDays: number };
}

function parseFieldRules(raw: unknown, path: string): { title?: FieldRule; body: FieldRule } {
  const o = obj(raw, path);
  const rule = (key: string): FieldRule => ({ maxLength: num(obj(o[key], `${path}.${key}`), "maxLength", `${path}.${key}`, { min: 1, integer: true }) });
  return { body: rule("body"), ...(o.title !== undefined ? { title: rule("title") } : {}) };
}

function parseGeneration(raw: unknown, path: string): Generation {
  const o = obj(raw, path);
  const mode = oneOf(o, "mode", path, ["llm", "template"] as const);
  const fields = parseFieldRules(o.fields, `${path}.fields`);
  if (mode === "llm") return { mode, prompt: str(o, "prompt", path), fields };
  const title = optStr(o, "title", path);
  if (title !== undefined && !fields.title) throw new InputError(`${path}: title 문구가 있으면 fields.title 규칙도 필요합니다.`);
  return { mode, body: str(o, "body", path), fields, ...(title !== undefined ? { title } : {}) };
}

function parseCondition(raw: unknown, path: string): Condition {
  const o = obj(raw, path);
  const fact = str(o, "fact", path);
  if (!/^(subject|event)\.\w+$/.test(fact)) throw new InputError(`${path}.fact: "subject.<이름>" 또는 "event.<이름>" 형식이어야 합니다.`);
  const op = oneOf(o, "op", path, OPERATORS);
  if (op === "exists" || op === "missing") return { fact, op };
  const value = o.value;
  if (op === "in") {
    if (!Array.isArray(value) || !value.every(isFactValue)) throw new InputError(`${path}.value: in 연산자는 값 배열이 필요합니다.`);
    return { fact, op, value };
  }
  if (!isFactValue(value)) throw new InputError(`${path}.value: 문자열·숫자·true/false·null이어야 합니다.`);
  if (["gt", "gte", "lt", "lte"].includes(op) && typeof value !== "number") throw new InputError(`${path}.value: ${op} 연산자는 숫자가 필요합니다.`);
  return { fact, op, value };
}

export function parsePlaybook(raw: unknown, path: string): Playbook {
  const o = obj(raw, path);
  const trigger = obj(o.trigger, `${path}.trigger`);
  const conditions = o.conditions ?? [];
  if (!Array.isArray(conditions)) throw new InputError(`${path}.conditions: 배열이어야 합니다.`);
  const goalRaw = o.goal;
  const playbook: Playbook = {
    id: str(o, "id", path),
    service: str(o, "service", path),
    name: str(o, "name", path),
    enabled: bool(o, "enabled", path),
    trigger: {
      event: str(trigger, "event", `${path}.trigger`),
      delayMinutes: num(trigger, "delayMinutes", `${path}.trigger`, { min: 0, integer: true }),
    },
    conditions: conditions.map((c, i) => parseCondition(c, `${path}.conditions[${i}]`)),
    advertising: bool(o, "advertising", path),
    frequencyDays: num(o, "frequencyDays", path, { min: 0, integer: true }),
    generation: parseGeneration(o.generation, `${path}.generation`),
    approval: oneOf(o, "approval", path, ["auto", "manual"] as const),
    channel: oneOf(o, "channel", path, CHANNELS),
  };
  if (goalRaw !== undefined) {
    const goal = obj(goalRaw, `${path}.goal`);
    playbook.goal = { event: str(goal, "event", `${path}.goal`), windowDays: num(goal, "windowDays", `${path}.goal`, { min: 1, integer: true }) };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(playbook.id)) throw new InputError(`${path}.id: 영문 소문자·숫자·하이픈만 씁니다.`);
  // 알림톡은 정보성 메시지 전용이다. 광고는 브랜드 메시지·문자 등으로 보내야 한다.
  if (playbook.advertising && playbook.channel === "alimtalk") {
    throw new InputError(`${path}: 광고성 플레이북은 alimtalk 채널을 쓸 수 없습니다 (brand_message, sms, push 등 사용).`);
  }
  return playbook;
}

/** 폴더 안의 *.json을 모두 읽는다. 하나라도 잘못되면 서버를 띄우지 않는다(fail fast). */
export function loadPlaybooks(dir: string, knownServices: ReadonlySet<string>): Playbook[] {
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  const playbooks = files.map((file) => parsePlaybook(JSON.parse(readFileSync(join(dir, file), "utf8")), `playbooks/${file}`));
  const seen = new Set<string>();
  for (const playbook of playbooks) {
    if (seen.has(playbook.id)) throw new InputError(`플레이북 id가 중복됩니다: ${playbook.id}`);
    seen.add(playbook.id);
    if (!knownServices.has(playbook.service)) throw new InputError(`플레이북 ${playbook.id}: services.json에 없는 서비스입니다 (${playbook.service}).`);
  }
  return playbooks;
}
