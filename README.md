# marketing-bot

알에스팀 마케팅 봇 조사·프로토타입 저장소입니다.

- `research/` — 시장조사 자료 (HTML/PDF)
- `src/` — 병렬 프로토타입 A~D 코드

## 프로토타입

사수님 기준(**자동화 · 마케팅 효과 · 유지보수성**)으로 4가지 방식을 동시에 작게 만들어 비교합니다. 자세한 배경은 `research/marketing-market-research.pdf` 6~11장을 참고하세요.

| | 이름 | 하는 일 | 실행 |
|---|---|---|---|
| A | 사장님 대상 콘텐츠 자동화 | 장사 정보 글 초안 생성 → 사람 승인 → 발행 | `pnpm a` |
| B | 랜딩페이지 + 문의 후속 자동화 | 문의 접수 → 맞춤 안내 생성 → (동의 확인 후) 발송 | `pnpm b` |
| C | 영업 지원 봇 | 영업 대상 조사 → 맞춤 제안서 초안 → 영업 담당자 검토 | `pnpm c` |
| D | 커뮤니티·트렌드 모니터링 | 사장님 관련 글 수집 → 키워드·고민 요약 → A·C에 소재 전달 | `pnpm d` |

각 프로토타입의 사용법과 검증 결과(Verdict)는 `src/prototypes/<이름>/README.md`에 있습니다.

## 시작하기

```bash
pnpm install
cp .env.example .env   # 필요하면 LLM 설정 변경
pnpm check             # 타입 검사 + 테스트
pnpm report            # 4개 프로토타입 지표 비교표
```

기본 LLM은 로컬 Ollama(`qwen3.8:27b`)입니다. OpenAI 호환 API라면 `.env`의 `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`만 바꾸면 됩니다.

## 구조와 규칙

```
src/shared/        모든 프로토타입이 공유하는 부품
  config.ts        환경 변수 → 설정
  context.ts       의존성 묶음(AppContext). 프로토타입은 이것만 받는다
  llm.ts           LLM 클라이언트 (OpenAI 호환 / mock)
  prompts.ts       prompts/*.md 템플릿 로더
  approval.ts      사람 승인 대기열 (Human-in-the-loop)
  channel.ts       발송 채널. 기본은 DryRun(기록만)
  metrics.ts       비교용 이벤트 기록·요약
  handoff.ts       D → A 주제 전달 규약
src/prototypes/    A~D 각 폴더는 서로 import 하지 않는다
prompts/           LLM 프롬프트 (코드와 분리해 문구만 고칠 수 있게)
tests/             node:test 테스트 (mock LLM 사용)
data/              실행 결과 (git 제외)
```

1. **외부로 나가는 것은 모두 승인 대기열 또는 `channel`을 거친다.** 기본값 `DRY_RUN=true`에서는 아무것도 실제로 보내지 않고 `data/outbox.jsonl`에만 남습니다.
2. **광고성 메시지는 수신 동의 근거 없이 보낼 수 없다.** `channel.ts`가 강제합니다(정보통신망법 제50조).
3. **프로토타입끼리는 직접 의존하지 않는다.** 데이터를 넘길 때는 `shared/handoff.ts` 같은 규약을 둡니다.
4. **지표 이벤트 이름은 `shared/metrics.ts`의 `EVENTS`만 쓴다.** 그래야 `pnpm report`로 같은 기준 비교가 됩니다.
5. 런타임은 Node 24+의 TypeScript 직접 실행(타입 제거 방식)이라 `enum`, 생성자 파라미터 프로퍼티처럼 런타임 코드를 만드는 문법은 쓰지 않습니다.
