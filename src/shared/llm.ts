import type { AppConfig } from "./config.ts";

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
}

/** 프로토타입은 이 인터페이스에만 의존한다. 모델·공급자 교체는 여기서 끝난다. */
export interface LlmClient {
  complete(request: CompletionRequest): Promise<string>;
}

/** OpenAI Chat Completions 호환 API (OpenAI, Ollama, vLLM, OpenRouter 등) */
export class OpenAICompatibleClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async complete({ system, user, temperature = 0.7 }: CompletionRequest): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature,
        // Qwen3 계열의 사고(thinking) 출력을 끈다. 지원하지 않는 서버는 무시한다.
        reasoning_effort: "none",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM 호출 실패 (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 응답에 content가 없습니다.");
    return stripThinking(content).trim();
  }
}

/** 테스트·오프라인 데모용. 응답 생성 함수를 주입받는다. */
export class MockLlmClient implements LlmClient {
  readonly calls: CompletionRequest[] = [];
  private readonly respond: (request: CompletionRequest) => string;

  constructor(respond: (request: CompletionRequest) => string = defaultMockResponse) {
    this.respond = respond;
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.calls.push(request);
    return this.respond(request);
  }
}

function defaultMockResponse(request: CompletionRequest): string {
  return `[mock 응답] ${request.user.slice(0, 80)}`;
}

/** <think>...</think> 블록이 섞여 오는 모델 대응 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "");
}

export function createLlmClient(config: AppConfig): LlmClient {
  if (config.llmProvider === "mock") return new MockLlmClient();
  return new OpenAICompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
  });
}

/** LLM이 JSON을 코드펜스로 감싸 보내는 경우까지 처리한다. 실패하면 원문과 함께 에러. */
export function parseJsonResponse<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error(`LLM 응답을 JSON으로 해석하지 못했습니다:\n${text}`);
  }
}
