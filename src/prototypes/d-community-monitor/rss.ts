/**
 * 의존성 없는 작은 RSS 2.0 파서.
 * <item> 안의 title/link/pubDate/description/guid 만 읽는다. CDATA와 HTML 엔티티를 처리한다.
 */
export interface RssItem {
  title: string;
  link: string;
  /** ISO 문자열. pubDate가 없거나 해석 불가하면 null */
  publishedAt: string | null;
  /** 태그를 제거한 설명 텍스트 */
  description: string;
  guid: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML 태그 제거 + 공백 정리 */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 태그 내용 하나를 꺼낸다. CDATA면 그 안쪽을, 아니면 엔티티를 풀어서 돌려준다. */
function readTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  const raw = match[1].trim();
  // CDATA 구간은 그대로, 그 밖은 엔티티 디코딩 (CDATA가 여러 조각일 수도 있다)
  let result = "";
  let rest = raw;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/;
  for (let found = rest.match(cdata); found; found = rest.match(cdata)) {
    result += decodeEntities(rest.slice(0, found.index)) + found[1];
    rest = rest.slice((found.index ?? 0) + found[0].length);
  }
  return (result + decodeEntities(rest)).trim();
}

function toIso(value: string): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function parseRss(xml: string, limit = 30): RssItem[] {
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return blocks
    .map((block) => {
      // description은 보통 HTML이라 엔티티를 푼 뒤 태그를 지우고, 남은 엔티티를 한 번 더 푼다.
      const description = decodeEntities(stripTags(readTag(block, "description"))).replace(/\s+/g, " ").trim();
      const guid = readTag(block, "guid");
      return {
        // 제목은 일반 텍스트라 태그 제거 없이 공백만 정리한다 (CDATA 속 "<단골>" 같은 표현 보존).
        title: readTag(block, "title").replace(/\s+/g, " ").trim(),
        link: readTag(block, "link") || (guid.startsWith("http") ? guid : ""),
        publishedAt: toIso(readTag(block, "pubDate")),
        description,
        guid,
      };
    })
    .filter((item) => item.title !== "" || item.link !== "")
    .slice(0, limit);
}
