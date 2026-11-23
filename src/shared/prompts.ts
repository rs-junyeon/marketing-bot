import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.ts";

export interface PromptTemplate {
  system: string;
  user: string;
}

const SECTION = /^##\s+(system|user)\s*$/gim;

/**
 * prompts/<name>.md 를 읽어 {{변수}}를 채운다.
 * 파일은 "## system" 과 "## user" 두 섹션으로 구성한다.
 * 프롬프트를 코드 밖에 두어 비개발자도 문구를 고칠 수 있게 한다.
 */
export function loadPrompt(name: string, vars: Record<string, string>): PromptTemplate {
  const raw = readFileSync(resolve(PROJECT_ROOT, "prompts", `${name}.md`), "utf8");
  const sections = splitSections(raw, name);
  return { system: fill(sections.system, vars, name), user: fill(sections.user, vars, name) };
}

function splitSections(raw: string, name: string): PromptTemplate {
  const matches = [...raw.matchAll(SECTION)];
  const result: Partial<PromptTemplate> = {};
  matches.forEach((match, index) => {
    const key = match[1].toLowerCase() as keyof PromptTemplate;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? raw.length;
    result[key] = raw.slice(start, end).trim();
  });
  if (!result.system || !result.user) {
    throw new Error(`prompts/${name}.md 에 "## system" 과 "## user" 섹션이 모두 있어야 합니다.`);
  }
  return result as PromptTemplate;
}

export function fill(template: string, vars: Record<string, string>, name = "template"): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`${name}: 변수 {{${key}}} 값이 없습니다.`);
    return vars[key];
  });
}
