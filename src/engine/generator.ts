import type { LlmClient } from "../shared/llm.ts";
import { parseJsonResponse } from "../shared/llm.ts";
import { fill, loadPrompt } from "../shared/prompts.ts";
import type { EngineEvent, MessageContent, Subject } from "./domain.ts";
import { InputError } from "./input.ts";
import type { Playbook } from "./playbook.ts";
import { validateContent } from "./rules.ts";
import type { ServiceConfig } from "./services.ts";

/**
 * 엔진에서 모델을 부르는 유일한 곳 (③ 문구 생성).
 * 모델은 미정이므로 OpenAI 호환 API라면 무엇이든 LLM_* 환경 변수만 바꿔 교체한다.
 */

export const MAX_GENERATION_ATTEMPTS = 2;

export type GenerationOutcome =
  | { ok: true; content: MessageContent; model: string | null; durationMs: number; attempts: number }
  | { ok: false; issues: string[]; model: string | null; durationMs: number; attempts: number };

/** 프롬프트·템플릿에서 쓰는 변수. 이름 규칙: service_*, subject_*, event_* */
export function buildVariables(service: ServiceConfig, subject: Subject, event: EngineEvent): Record<string, string> {
  const vars: Record<string, string> = {
    service_name: service.name,
    brand_name: service.brand.name,
    brand_tone: service.brand.tone,
    sender_name: service.brand.senderName,
    landing_url: service.brand.landingUrl ?? "",
    subject_name: subject.displayName,
  };
  for (const [key, value] of Object.entries(subject.facts)) vars[`subject_${key}`] = value === null ? "" : String(value);
  for (const [key, value] of Object.entries(event.payload)) vars[`event_${key}`] = value === null ? "" : String(value);
  return vars;
}

export class ContentGenerator {
  private readonly llm: LlmClient;
  private readonly model: string;

  constructor(llm: LlmClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  async generate(playbook: Playbook, service: ServiceConfig, vars: Record<string, string>): Promise<GenerationOutcome> {
    const started = performance.now();
    const inputText = Object.values(vars).join("\n");
    const elapsed = () => Math.round(performance.now() - started);
    const generation = playbook.generation;

    if (generation.mode === "template") {
      const content: MessageContent = configError(() => ({
        body: fill(generation.body, vars, playbook.id),
        ...(generation.title !== undefined ? { title: fill(generation.title, vars, playbook.id) } : {}),
      }));
      const issues = validateContent(content, generation.fields, { service, inputText, checkNumbers: false });
      return issues.length
        ? { ok: false, issues, model: null, durationMs: elapsed(), attempts: 1 }
        : { ok: true, content, model: null, durationMs: elapsed(), attempts: 1 };
    }

    const prompt = configError(() => loadPrompt(generation.prompt, vars));
    const shape = generation.fields.title
      ? `{"title": "${generation.fields.title.maxLength}자 이내", "body": "${generation.fields.body.maxLength}자 이내"}`
      : `{"body": "${generation.fields.body.maxLength}자 이내"}`;
    const system = `${prompt.system}\n\n출력은 JSON 객체 하나만: ${shape}`;
    let user = prompt.user;
    let issues: string[] = [];

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      // 모델 서버 장애(네트워크·5xx)는 여기서 삼키지 않고 위로 올려 작업 단위로 재시도한다.
      const text = await this.llm.complete({ system, user, json: true, temperature: 0.6 });
      let content: MessageContent;
      try {
        const raw = parseJsonResponse<Record<string, unknown>>(text);
        content = {
          body: typeof raw.body === "string" ? raw.body.trim() : "",
          ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}),
        };
      } catch (error) {
        issues = [`모델 응답 오류: ${(error as Error).message.slice(0, 200)}`];
        continue;
      }
      issues = validateContent(content, generation.fields, { service, inputText, checkNumbers: true });
      if (issues.length === 0) return { ok: true, content, model: this.model, durationMs: elapsed(), attempts: attempt };
      // 한 번은 무엇이 틀렸는지 알려 주고 다시 쓰게 한다.
      user = `${prompt.user}\n\n이전 답변이 다음 규칙을 어겼습니다. 고쳐서 다시 쓰세요:\n- ${issues.join("\n- ")}`;
    }
    return { ok: false, issues, model: this.model, durationMs: elapsed(), attempts: MAX_GENERATION_ATTEMPTS };
  }
}

/** 프롬프트 파일 없음·변수 누락은 설정 오류다. 재시도하지 않도록 InputError로 바꾼다. */
function configError<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new InputError(`문구 설정 오류: ${(error as Error).message}`);
  }
}
