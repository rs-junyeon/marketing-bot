/**
 * 영업 대상 홈페이지 수집기.
 * 지정한 URL 한 페이지만 가져오고(링크를 따라가지 않음), 태그를 걷어낸 평문으로 바꾼다.
 * 테스트에서는 PageFetcher 를 가짜 구현으로 바꿔 끼워 네트워크를 쓰지 않는다.
 */

export type FetchResult =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; url: string; reason: string };

export interface PageFetcher {
  fetchPage(url: string): Promise<FetchResult>;
}

export const MAX_TEXT_CHARS = 6000;
export const FETCH_TIMEOUT_MS = 10_000;
// HTTP 헤더는 ASCII만 허용하므로 영문으로 쓴다. (알에스팀 영업 준비용, 단일 페이지 1회 조회)
export const USER_AGENT = "RSTeam-SalesBriefBot/0.1 (sales research; single page, one request)";

/** 실제 HTTP 수집기: 10초 제한, 식별 가능한 User-Agent, 한 페이지만. */
export class HttpPageFetcher implements PageFetcher {
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  async fetchPage(url: string): Promise<FetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, url, reason: "URL 형식이 올바르지 않습니다." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, url, reason: `http/https 주소만 수집합니다 (${parsed.protocol})` };
    }

    try {
      const response = await fetch(parsed, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { ok: false, url, reason: `HTTP ${response.status} 응답` };
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        return { ok: false, url, reason: `HTML이 아닌 응답입니다 (${contentType})` };
      }
      const html = await response.text();
      return toResult(url, html);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, url, reason: `${this.timeoutMs / 1000}초 안에 응답이 없어 중단했습니다.` };
      }
      return { ok: false, url, reason: `수집 실패: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** HTML 원문을 수집 결과로 바꾼다. 본문이 비면 실패로 본다(자바스크립트로만 그리는 페이지 등). */
export function toResult(url: string, html: string): FetchResult {
  const { title, text } = htmlToText(html);
  if (text.length === 0) {
    return { ok: false, url, reason: "페이지에서 읽을 수 있는 글자를 찾지 못했습니다 (자바스크립트 렌더링 페이지일 수 있음)." };
  }
  const truncated = text.length > MAX_TEXT_CHARS;
  return { ok: true, url, title, text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|aside)\b[^>]*>/gi;

/** script·style 등을 제거하고 태그를 걷어낸 평문을 만든다. title·meta description 은 따로 뽑는다. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "",
  ).trim();

  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");

  const text = [description ? `설명: ${description}` : "", ...lines].filter(Boolean).join("\n");
  return { title, text };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}
