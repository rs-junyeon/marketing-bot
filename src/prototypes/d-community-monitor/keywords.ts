/**
 * 아주 단순한 한국어 키워드 집계.
 * 형태소 분석기 없이 "글자가 아닌 문자로 자르기 → 1글자 제거 → 흔한 조사 떼기 → 불용어 제거" 만 한다.
 */

/** 뉴스·커뮤니티 글에 흔해서 신호가 없는 단어 */
export const STOPWORDS = new Set([
  // 뉴스 상투어
  "기자", "뉴스", "지원", "올해", "내년", "지난해", "오늘", "이번", "최근", "관련", "통해", "위해", "대한", "대해",
  "따르면", "밝혔다", "전했다", "했다", "있다", "없다", "한다", "된다", "이다", "말했다", "강조했다", "예정",
  "진행", "개최", "추진", "실시", "운영", "제공", "가능", "대상", "사업", "확대", "강화", "계획", "발표", "기사",
  "일보", "신문", "방송", "경제", "투데이", "데일리", "뉴시스", "연합뉴스", "머니투데이", "무단", "전재", "배포",
  "금지", "사진", "제공", "기준", "이상", "이하", "가운데", "함께", "등을", "등의", "또한", "그리고", "하지만",
  "그러나", "이후", "현재", "지역", "시장", "정부", "서울", "전국", "국내", "올해도", "위한", "있는", "없는",
  "하는", "되는", "있어", "있고", "에서", "으로", "까지", "부터",
  // 커뮤니티 상투어
  "진짜", "너무", "정말", "그냥", "혹시", "다들", "어떻게", "어떤", "이거", "저거", "그거", "요즘", "저희",
  "여러분", "질문", "궁금", "궁금합니다", "합니다", "입니다", "있나요", "하시나요", "드립니다", "감사합니다",
  "샘플",
  // 영문
  "the", "and", "for", "com", "www", "http", "https", "news", "google",
]);

/** 3글자 이상 토큰 끝에서 떼는 흔한 조사 (긴 것부터) */
const PARTICLES = ["에서는", "에게서", "으로는", "에서", "에게", "으로", "까지", "부터", "보다", "처럼", "은", "는", "이", "가", "을", "를", "의", "에", "도", "로", "와", "과", "만"];

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .map(stripParticle)
    .filter((token) => [...token].length >= 2 && !STOPWORDS.has(token));
}

function stripParticle(token: string): string {
  if ([...token].length < 3 || !/[가-힣]$/.test(token)) return token;
  for (const particle of PARTICLES) {
    if (token.endsWith(particle) && [...token].length - [...particle].length >= 2) {
      return token.slice(0, token.length - particle.length);
    }
  }
  return token;
}

export interface KeywordCount {
  keyword: string;
  /** 이 단어가 나온 글 수 (한 글에서 여러 번 나와도 1) */
  itemCount: number;
}

/** 문서 빈도(글 수) 기준 상위 키워드 */
export function countKeywords(texts: string[], top = 20): KeywordCount[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of new Set(tokenize(text))) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([keyword, itemCount]) => ({ keyword, itemCount }))
    .sort((a, b) => b.itemCount - a.itemCount || a.keyword.localeCompare(b.keyword))
    .slice(0, top);
}

/** 관심 키워드(부분 문자열, 대소문자 무시)가 들어간 글 수. 0건도 그대로 보여준다. */
export function countWatchKeywords(texts: string[], watch: string[]): KeywordCount[] {
  const lowered = texts.map((text) => text.toLowerCase());
  return watch
    .map((keyword) => ({
      keyword,
      itemCount: lowered.filter((text) => text.includes(keyword.toLowerCase())).length,
    }))
    .sort((a, b) => b.itemCount - a.itemCount);
}
