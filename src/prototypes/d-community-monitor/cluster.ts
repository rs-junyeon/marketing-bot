import type { CollectedItem } from "./collect.ts";

/**
 * 같은 보도자료가 매체만 바꿔 여러 번 실리는 문제 대응.
 * 제목이 거의 같은 기사를 하나의 "보도"로 묶어, 9개 기사를 9개 사례로 세지 않게 한다.
 */
export interface StoryCluster {
  /** 대표 기사 (가장 최근 기사) */
  representative: CollectedItem;
  /** 대표 기사를 포함한 같은 보도 기사 전체 */
  members: CollectedItem[];
  /** 경쟁사 홍보 보도면 경쟁사 이름, 아니면 null */
  competitor: string | null;
}

/** 두 제목을 같은 보도로 볼 유사도 기준 (글자 2-gram 겹침 비율) */
export const SAME_STORY_THRESHOLD = 0.45;

/** 비교용 제목: 언론사명·괄호·따옴표·기호를 지우고 공백을 없앤다. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+-\s+[^-]+$/, "") // Google 뉴스 " - 언론사명"
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const chars = [...text];
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

/** 두 집합의 겹침 비율. 짧은 쪽 기준이라 한쪽 제목에 수식어가 붙어도 같은 보도로 잡힌다. */
export function titleSimilarity(a: string, b: string): number {
  const ga = bigrams(normalizeTitle(a));
  const gb = bigrams(normalizeTitle(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / Math.min(ga.size, gb.size);
}

export function detectCompetitor(text: string, competitors: string[]): string | null {
  const lowered = text.toLowerCase();
  return competitors.find((name) => lowered.includes(name.toLowerCase())) ?? null;
}

/**
 * 최신순 기사 목록을 보도 단위로 묶는다. 샘플 글은 서로 다른 글로 보고 묶지 않는다.
 * 기사 수가 수백 건 이하인 프로토타입 규모라 단순 비교(O(n²))로 충분하다.
 */
export function clusterItems(items: CollectedItem[], competitors: string[] = [], threshold = SAME_STORY_THRESHOLD): StoryCluster[] {
  const clusters: StoryCluster[] = [];
  for (const item of items) {
    const match = item.isSample
      ? undefined
      : clusters.find(
          (cluster) => !cluster.representative.isSample && titleSimilarity(cluster.representative.title, item.title) >= threshold,
        );
    if (match) {
      match.members.push(item);
      match.competitor ??= detectCompetitor(`${item.title} ${item.snippet}`, competitors);
    } else {
      clusters.push({
        representative: item,
        members: [item],
        competitor: detectCompetitor(`${item.title} ${item.snippet}`, competitors),
      });
    }
  }
  return clusters;
}
