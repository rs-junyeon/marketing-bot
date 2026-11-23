/**
 * Qwen 계열 모델은 한국어 문장 중간에 한자(중국어) 토큰을 섞어 내는 경우가 있다.
 * 예: "핵심卖点", "재방문率". 외부로 나가는 글은 이 검사를 통과해야 한다.
 */
export function findHanCharacters(text: string): string | null {
  return text.match(/\p{Script=Han}+/u)?.[0] ?? null;
}
