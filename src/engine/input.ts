import type { FactValue, Facts } from "./domain.ts";

/**
 * 외부 입력(설정 파일, 웹훅 본문)을 검사하는 작은 도우미.
 * 런타임 의존성을 늘리지 않으려고 스키마 라이브러리 대신 직접 쓴다.
 * 에러 메시지에는 항상 어느 파일·어느 필드인지 경로를 넣는다.
 */
export class InputError extends Error {
  override name = "InputError";
}

export type Obj = Record<string, unknown>;

export function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${path}: 객체여야 합니다.`);
  }
  return value as Obj;
}

export function str(o: Obj, key: string, path: string): string {
  const value = o[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${path}.${key}: 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

export function optStr(o: Obj, key: string, path: string): string | undefined {
  if (o[key] === undefined) return undefined;
  return str(o, key, path);
}

export function num(o: Obj, key: string, path: string, opts: { min?: number; integer?: boolean } = {}): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputError(`${path}.${key}: 숫자여야 합니다.`);
  if (opts.integer && !Number.isInteger(value)) throw new InputError(`${path}.${key}: 정수여야 합니다.`);
  if (opts.min !== undefined && value < opts.min) throw new InputError(`${path}.${key}: ${opts.min} 이상이어야 합니다.`);
  return value;
}

export function bool(o: Obj, key: string, path: string): boolean {
  const value = o[key];
  if (typeof value !== "boolean") throw new InputError(`${path}.${key}: true/false 여야 합니다.`);
  return value;
}

export function oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[]): T {
  const value = o[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(`${path}.${key}: ${allowed.join(" | ")} 중 하나여야 합니다. (받은 값: ${JSON.stringify(value)})`);
  }
  return value as T;
}

export function strArray(o: Obj, key: string, path: string): string[] {
  const value = o[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InputError(`${path}.${key}: 문자열 배열이어야 합니다.`);
  }
  return value as string[];
}

export function isFactValue(value: unknown): value is FactValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** payload·facts는 1단계 깊이의 원시값만 허용한다. */
export function facts(value: unknown, path: string): Facts {
  const o = obj(value ?? {}, path);
  for (const [key, item] of Object.entries(o)) {
    if (!isFactValue(item)) throw new InputError(`${path}.${key}: 문자열·숫자·true/false·null만 허용합니다.`);
  }
  return o as Facts;
}

export function isoDate(o: Obj, key: string, path: string): string {
  const value = str(o, key, path);
  if (Number.isNaN(Date.parse(value))) throw new InputError(`${path}.${key}: ISO 8601 날짜여야 합니다.`);
  return new Date(value).toISOString();
}
