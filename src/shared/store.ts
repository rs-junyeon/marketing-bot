import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 프로토타입 단계의 저장소. DB 대신 data/ 아래 파일을 쓴다.
 * 실제 서비스로 옮길 때는 이 모듈만 DB 구현으로 바꾸면 된다.
 */
export class FileStore {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  path(...segments: string[]): string {
    return resolve(this.dataDir, ...segments);
  }

  appendJsonl(file: string, record: unknown): void {
    const target = this.ensureDir(file);
    appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  }

  readJsonl<T>(file: string): T[] {
    const target = this.path(file);
    if (!existsSync(target)) return [];
    return readFileSync(target, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  }

  readJson<T>(file: string, fallback: T): T {
    const target = this.path(file);
    if (!existsSync(target)) return fallback;
    return JSON.parse(readFileSync(target, "utf8")) as T;
  }

  writeJson(file: string, value: unknown): void {
    writeFileSync(this.ensureDir(file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  writeText(file: string, text: string): string {
    const target = this.ensureDir(file);
    writeFileSync(target, text, "utf8");
    return target;
  }

  private ensureDir(file: string): string {
    const target = this.path(file);
    mkdirSync(dirname(target), { recursive: true });
    return target;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
