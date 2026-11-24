# 마케팅 봇 공용 엔진

회사의 모든 서비스가 함께 쓰는 마케팅 봇 엔진입니다. 서비스마다 다른 부분은 **연결부(웹훅·조회·발송 API)와 설정**에만 있고, 엔진 코드는 서비스 이름을 모릅니다. 첫 적용 대상은 쿠핀 PLUS·ON입니다.

```
서비스 ──웹훅──▶ ① 수신 ─▶ ② 조건 판단 ─▶ ③ 문구 생성(모델) ─▶ ④ 검증 ─▶ ⑤ 승인 ─▶ ⑥ 발송 ─▶ ⑦ 측정
                  중복 방지    동의·발송 한도      유일한 모델 호출       지어낸 숫자·   auto/   서비스에    목표 이벤트로
                  서명 확인    야간 제한·조건                           금지어·한자    manual  위임        전환 기록
```

## 실행

```bash
cp .env.example .env      # ADMIN_TOKEN, 서비스별 웹훅 시크릿 채우기
pnpm engine               # http://127.0.0.1:3200 (승인 화면: /admin)
pnpm engine:event coupin-plus config/sample-events/plus-subscription-started.json --secret-env COUPIN_PLUS_WEBHOOK_SECRET
```

Docker: `docker build -t marketing-bot-engine . && docker run -p 3200:3200 -v mb-data:/data --env-file .env marketing-bot-engine`

| 주소 | 인증 | 용도 |
|---|---|---|
| `POST /v1/events` | 서비스별 HMAC 서명 | 이벤트 수신 |
| `GET /v1/messages?status=pending_approval` | `Bearer ADMIN_TOKEN` | 승인 대기 목록 (최종 문구 미리보기 포함) |
| `POST /v1/messages/{id}/approve` · `/reject` | `Bearer ADMIN_TOKEN` | 승인(문구 수정 가능)·반려 |
| `GET /v1/metrics` · `/v1/jobs` · `/v1/playbooks` | `Bearer ADMIN_TOKEN` | 성과표·작업 내역·플레이북 |
| `GET /admin` | Basic (아이디=승인자 이름, 비밀번호=ADMIN_TOKEN) | 승인 화면 |
| `GET /healthz` · `/readyz` | 없음 | 상태 확인 |

서비스 쪽 구현 규격은 [integration-contract.md](integration-contract.md)에 있습니다.

## 플레이북 (config/playbooks/*.json)

| id | 서비스 | 언제 | 모델 | 승인 | 채널 |
|---|---|---|---|---|---|
| `plus-first-coupon` (P3) | PLUS | 구독 72시간 뒤, 쿠폰 발송 0건·상품 1개 이상 | O | auto | inapp |
| `plus-report-action` (P4) | PLUS | AI 리포트 생성 시, 동의 손님 30명 이상 | O | auto | inapp |
| `on-first-purchase` (O2) | ON | 가입 72시간 뒤 구매 0건 (광고) | O | manual | push |
| `on-expiry-notice` (O1) | ON | 만료 30·7·1일 전 (정보성) | X (고정 문구) | auto | alimtalk |

필드: `trigger`(이벤트·지연 분), `conditions`(`subject.*`/`event.*` 비교), `advertising`, `frequencyDays`, `generation`(`llm`+프롬프트 / `template`), `approval`, `channel`, `goal`(전환 이벤트·기간). 잘못된 설정은 서버 시작 시 경로와 함께 거부됩니다.

## 엔진이 항상 지키는 규칙

| 규칙 | 근거·이유 | 위치 |
|---|---|---|
| 광고성은 수신 동의(`consents.marketing`)가 없으면 모델 호출 전에 건너뜀, 발송 직전에도 다시 확인 | 정보통신망법 제50조 제1항 | `engine.ts` |
| 광고성은 21~08시(KST)에 보내지 않고 오전 8시로 미룸 (야간 별도 동의 시 제외) | 같은 법 제50조 제3항 | `rules.ts` |
| 광고성은 `(광고) 브랜드명` + 수신거부 안내를 엔진이 붙임, 모델이 쓰면 거부 | 같은 법 제50조 제4항 | `rules.ts` |
| 광고성 플레이북에 알림톡 채널 설정 금지 | 알림톡은 정보성 전용 | `playbook.ts` |
| 입력에 없는 숫자, 한자, 금지어, 허용 안 된 링크, 길이 초과 → 1회 재생성 후 실패 | 지어낸 수치·과장 광고 방지 | `rules.ts` |
| 같은 대상 같은 플레이북 `frequencyDays` 안 재발송 금지, 서비스별 주간 광고 한도 | 과다 발송 방지 | `engine.ts` |
| 같은 이벤트·같은 메시지는 한 번만 처리 (이벤트 id, idempotency-key) | 재전송·재시도 안전 | `store.ts` |

## 운영

- **저장소**: SQLite(`ENGINE_DB_PATH`, WAL). 재시작해도 예약 작업·승인 대기·발송 기록이 유지됩니다. SQL은 `store.ts`에만 있어 PostgreSQL 등으로 옮길 때 이 파일만 바꿉니다.
- **워커**: 서버 안에서 `WORKER_INTERVAL_MS`마다 예약 작업과 발송을 처리합니다. 모델·서비스 장애는 1·2·4·8분… 간격으로 최대 5회 재시도 후 `failed`로 닫습니다. 비정상 종료로 `running`에 남은 작업은 다음 시작 때 되살립니다.
- **로그**: 한 줄 JSON(stdout). `job.processed`, `delivery.done`, `delivery.cancelled`, `job.failed` 등.
- **종료**: SIGTERM을 받으면 새 요청을 막고 진행 중인 처리를 마친 뒤 종료합니다.
- **AI 모델**: 운영 모델은 미정입니다. OpenAI 호환 API면 `LLM_BASE_URL`·`LLM_API_KEY`·`LLM_MODEL`만 바꿉니다. 개발·검증은 로컬 `gpt-oss:20b`로 했습니다.
- **단일 인스턴스 기준**입니다. 여러 대로 늘릴 때는 저장소를 PostgreSQL로 옮겨야 합니다(SQLite는 한 서버 파일).

## 검증 기록 (2026-11-24, 로컬 gpt-oss:20b, DRY_RUN)

| 플레이북 | 결과 | 생성 시간 |
|---|---|---|
| P3 첫 쿠폰 도우미 | 생성·검증 통과 → dry_run | 6.6초 |
| P4 리포트 → 실행 | 1차: 모델이 입력에 없는 날짜(11, 05)를 지어내 검증에서 차단 → 프롬프트 수정 후 통과 | 5.0초 |
| O2 첫 구매 유도 | 생성 → 승인 대기, 미리보기에 (광고)·수신거부 표기 | 7.9초 |
| O1 만료 안내 | 모델 없이 고정 문구 → dry_run | 0초 |

같은 매장에 리포트 이벤트를 연달아 보내면 두 번째부터 `frequency_cap`으로 건너뛰는 것, 서버 재시작 후 기록이 남는 것, Docker 이미지 기동·설정 누락 시 시작 거부도 확인했습니다. 자동 테스트는 `tests/engine-*.test.ts` 32개입니다.

## 실제 운영 전에 남은 것

| 항목 | 담당 |
|---|---|
| PLUS·ON에 연동 규격 1~3 구현 (웹훅, 대상 조회 API, 발송 위임 API) | 서비스 개발 (사수님 승인 필요) |
| 운영 AI 모델 결정, 모델 계정 | 미정 |
| 사장님 → 손님 광고 시 동의 책임 주체 확인 | 법무 |
| 배포 위치(서버), `ADMIN_TOKEN`·시크릿 보관 방식 | 인프라 |
| 비용·운영 주체 | 보류 |
