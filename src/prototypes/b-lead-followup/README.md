# B. 랜딩페이지 + 문의 후속 자동화 (`b-lead-followup`)

## 목적

사장님(소상공인)이 랜딩페이지에 문의를 남기면

1. 바로 **접수 확인 메일**(정보성)을 보내고,
2. LLM이 업종과 적어 준 고민에 맞춘 **후속 안내 + 15분 통화 제안**을 쓰고,
3. **광고성 정보 수신 동의가 있으면** 자동 발송, **없으면** 사람이 검토해 1:1 답장으로 보냅니다.

영업 중심(B2B) 회사에서 "문의는 들어오는데 답장이 늦어 식는" 구간을 자동화해, **문의 → 미팅 전환**을 늘릴 수 있는지 확인하는 것이 목표입니다.

## 흐름

```
GET /?utm_source=...      랜딩페이지 (UTM을 hidden 필드로 보관)
   │ POST /leads
   ▼
검증 ──실패──▶ 400 + 한국어 오류 (입력값 유지해 다시 표시)
   │ 성공
   ▼
leads.jsonl 저장 + lead_captured ──▶ 즉시 감사 페이지 응답 (LLM을 기다리지 않음)
   │ (백그라운드)
   ├─ 1) 접수 확인 메일 (isAdvertising:false) ──▶ channel ──▶ sent
   └─ 2) LLM 후속 메시지 생성 (metrics.track → generated/failed)
          ├─ 광고 동의 O ──▶ (광고) 제목 + 수신거부 안내 붙여 자동 발송, consentRef=리드 id ──▶ sent
          └─ 광고 동의 X ──▶ 승인 대기열(follow-up-message)
                               └─ /admin 에서 수정·승인 ──▶ 1:1 답장 발송(isAdvertising:false) ──▶ approved, sent
                                                  반려 ──▶ rejected
/admin  리드 표 + "미팅 확정 기록" 버튼 ──▶ meeting_booked
```

백그라운드 작업은 어떤 단계가 실패해도 예외를 밖으로 던지지 않고 `failed` 지표와 후속 상태 `failed`로 남깁니다. LLM이 죽어도 접수와 접수 확인 메일은 정상 처리됩니다.

## 실행법

```bash
pnpm b:lead                       # http://127.0.0.1:3100/  (PORT, HOST 환경 변수로 변경)
LLM_PROVIDER=mock pnpm b:lead     # LLM 없이 화면·흐름만 확인
node --test tests/b-lead-followup.test.ts
```

- 기본 `DRY_RUN=true`: 메일은 실제로 나가지 않고 `data/outbox.jsonl`에만 기록됩니다.
- Ctrl+C 시 진행 중인 후속 처리가 끝난 뒤 종료합니다(한 번 더 누르면 즉시 종료).
- 브랜드·문구·동의 문구는 `samples/brand.json`, LLM 프롬프트는 `prompts/b-lead-followup-message.md`에서 코드 수정 없이 바꿀 수 있습니다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 랜딩페이지. `utm_source`·`utm_medium`·`utm_campaign` 쿼리를 hidden 필드로 담음 |
| POST | `/leads` | 문의 접수. `application/x-www-form-urlencoded`(폼) → HTML, `application/json` → JSON(`201 {ok, leadId}` / `400 {ok:false, errors}`) |
| GET | `/admin` | 리드 표(이름·업종·utm_source·동의·후속 상태·미팅) + 승인 대기 후속 메시지(수정 가능) |
| POST | `/admin/leads/:id/meeting` | `meeting_booked` 기록(리드당 1회) 후 `/admin`으로 이동 |
| POST | `/admin/approvals/:id/approve` | 대기 중인 후속 메시지 승인 → 1:1 답장 발송. 폼 `body`가 있으면 수정본 발송 |
| POST | `/admin/approvals/:id/reject` | 반려(발송 안 함) |

JSON 체크박스 값은 `true` / `"on"` / `"true"`를 모두 동의로 봅니다.

## 동의 처리 설계와 법적 판단 포인트

> ⚠️ 아래는 개발 단계의 판단이며 **실서비스 전 반드시 법무 검토가 필요합니다.**

- **개인정보 수집·이용 동의([필수])와 광고성 정보 수신 동의([선택])를 별도 체크박스로 분리**했습니다. 광고 동의는 기본 해제 상태이고, 동의하지 않아도 문의는 접수된다고 적었습니다.
- 리드에 `privacyConsentAt`, `marketingConsentAt`(미동의 시 `null`), `consentVersion`(동의 당시 문구 버전)을 남겨 동의 증빙으로 씁니다. 문구를 바꾸면 `brand.json`의 `consentVersion`도 올리세요.
- **접수 확인 메일**: 본인이 요청한 문의에 대한 사실 안내만 담은 정보성 메시지로 보고 동의 없이 보냅니다(LLM 미사용, 홍보 문구 없음).
- **광고 동의자 자동 후속 메일**: 서비스 활용 제안이 들어가므로 광고성으로 취급합니다. 제목에 `(광고)`, 본문 끝에 발신자 정보와 수신거부 방법을 **코드가 고정으로 붙입니다**(LLM에 맡기지 않음). `consentRef`=리드 id로 보내며, `shared/channel.ts`가 근거 없는 광고 발송을 막습니다.
- **광고 미동의자 후속 메일 (판단이 필요한 지점)**: 자동 발송하지 않고 승인 대기열에 넣어, 담당자가 읽고 고쳐서 **본인 문의에 대한 1:1 답장**으로 보냅니다. 이때 `isAdvertising:false`로 보냅니다. 근거는 "수신자가 먼저 요청한 상담에 대한 개별 회신은 광고성 정보 전송과 다르다"는 해석입니다. 다만
  - 답장 안에 서비스 홍보·혜택 안내 비중이 크면 광고성으로 볼 여지가 있고,
  - 사람이 승인해도 LLM 초안이 영업 문구 위주라면 결국 광고와 다를 바 없을 수 있습니다.

  그래서 미동의자 답장은 **문의 내용에 대한 답변 중심**으로 고쳐 보내도록 담당자 가이드가 필요하고, 이 경계는 **법무 확인 전까지 확정이 아닙니다.** 법무가 "광고성"으로 판단하면 미동의자에게는 접수 확인 + 전화 상담 연결만 하도록 바꾸면 됩니다(`processLead`의 분기 한 곳).
- 수신거부 처리(회신 `수신거부` → 동의 철회 기록)와 야간(21시~8시) 전송 제한은 아직 구현하지 않았습니다. 이메일은 야간 제한 대상이 아닌 것으로 알려져 있지만 문자·알림톡으로 확장할 때는 필요합니다.

## 저장 파일 (`data/`)

| 파일 | 내용 |
|---|---|
| `b-lead-followup/leads.jsonl` | 리드: id, createdAt, 매장/담당자/이메일/업종/문의, utm, consentVersion, privacyConsentAt, marketingConsentAt |
| `b-lead-followup/followups.jsonl` | 후속 상태 변화 기록(리드별 마지막 줄이 현재 상태): sent-advertising / pending-approval / sent-after-approval / rejected / failed |
| `outbox.jsonl` | (공용) dry-run 발송 기록 |
| `approvals.json` | (공용) 승인 대기열, `kind: follow-up-message`, meta `leadId`·`email` |
| `metrics.jsonl` | (공용) 지표 이벤트 |

## 지표

| 기준 | 이벤트 | 보는 법 |
|---|---|---|
| 자동화 | `generated`(durationMs), `sent`(meta.kind: receipt / follow-up-advertising / follow-up-approved), `approved`(meta.edited) | 사람 손 없이 나간 비율 = follow-up-advertising ÷ 전체 후속, 승인 시 수정 비율 |
| 효과 | `lead_captured`(meta: industry, utmSource, marketingConsent), `meeting_booked`(meta.leadId) | **문의 → 미팅 전환율** = meeting_booked ÷ lead_captured, utm_source·업종·동의 여부별로 나눠 비교 |
| 유지보수 | `failed`(meta.step: follow-up / receipt / follow-up-send / http) | 실패율, 실패 단계 |

`pnpm report`로 다른 프로토타입과 같은 표에서 비교됩니다.

## 한계와 다음 단계

- **실제 발송 채널**: `OutboundChannel` 구현만 추가하면 됩니다. 이메일은 SES·SendGrid 등, 알림톡/문자는 솔라피(Solapi) API로 `send()`를 구현하고 `createContext({ channel })`로 주입합니다. 알림톡은 템플릿 사전 승인이 필요해 LLM 자유 문장은 "친구톡/이메일"이나 승인 후 1:1 발송에만 맞습니다.
- **기존 랜딩페이지에 폼만 붙이기**: 이미 있는 페이지(아임웹·워드프레스 등)의 폼 `action`을 이 서버의 `POST /leads`로 바꾸고, 같은 필드 이름(`company, name, email, industry, concern, privacyConsent, marketingConsent, utm_*`)을 쓰면 됩니다. 자바스크립트로 보낼 때는 `fetch('/leads', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(...)})` → `201 {leadId}`. 다른 도메인이면 CORS 허용을 추가해야 합니다(미구현).
- `/admin`에 인증이 없습니다. 기본으로 `127.0.0.1`에만 바인딩합니다. 외부 공개 전 로그인 필수.
- 스팸 방지(허니팟·reCAPTCHA·요청 제한), 수신거부·동의 철회 처리, CRM(세일즈포스·HubSpot·노션) 연동 없음.
- 파일 저장소라 동시 쓰기에 약합니다(공용 `approvals.json`은 읽고-쓰기 방식이라 여러 프로세스가 동시에 쓰면 덮어쓸 수 있음).
- 광고 동의자 메일은 사람 검토 없이 나갑니다. 숫자·과장 표현 자동 검사 후 의심되면 승인 대기로 돌리는 안전장치가 다음 단계 후보입니다.

## Verdict: PARTIAL

실행: 2026-11-23, 로컬 Ollama `qwen3.8:27b`, `pnpm b:lead` + curl, DRY_RUN.
리드 2건(`utm_source=test`): 카페 "골목커피"(광고 동의 O), 학원 "수학공감학원"(광고 동의 X) + 잘못된 입력 1건.

### What worked
- 흐름 전체가 의도대로 동작: 접수 응답 **1~5ms**(LLM 대기 없음), 접수 확인 메일 2건 즉시 기록, 광고 동의자는 `(광고)` 제목 + 수신거부 안내 + `consentRef`로 자동 발송, 미동의자는 승인 대기 → `/admin`에서 승인 → `isAdvertising:false` 1:1 발송, 미팅 버튼 → `meeting_booked`. 잘못된 입력은 400 + 필드별 한국어 오류.
- 생성 문장 품질은 "담당자가 한두 군데 고치면 보낼 수 있는 수준". 고민을 첫 문단에서 다시 짚고, 15분 통화를 제안하고, **지어낸 숫자·사례·할인율은 없었음**(숫자는 사장님이 적은 "2~5시"와 서비스 소개의 "1분"만). 존댓말 유지, 본문 길이 342~446자.
  - 카페: "쿠폰을 사용한 손님이 언제 다시 왔는지 기록으로 남기 때문에, 어떤 고객층이 특정 시간대에 반응하는지 파악하는 데 도움이 됩니다."
  - 학원: "체험 수업을 마친 후 다음 단계 수업이나 상담을 위한 쿠폰을 바로 발행해 드릴 수 있습니다."
- 테스트 8개(mock LLM) 통과: UTM hidden, 필수 동의 400, 광고 동의 2건 발송, 미동의 → 승인, 반려, 미팅 1회 기록, HTML 이스케이프, LLM 실패 시 failed + 서버 정상.

### What didn't
- **생성 시간이 길다**: 150.1초, 179.3초(두 건 동시 처리, 다른 에이전트와 Ollama 공유). "문의 직후 몇 분 안에 맞춤 답장"이라는 가치는 지켰지만, 실서비스에서는 더 빠른 모델이나 API가 필요.
- 문장에 어색한 곳이 있어 **자동 발송분도 결국 한 번은 사람이 봐야 할 수준**: 카페 메일의 "단골 고객들의 발길을 다시 돌릴 수 있는 방법"(발길을 *돌리다*는 '떠나다'는 뜻이라 반대 의미), 학원 메일에서 학생/학부모를 "손님", 등원을 "방문"이라고 씀(서비스 소개 문구를 그대로 가져옴). "카페 업종에서는 재방문율을 높이는 것이 특히 중요합니다" 같은 일반론도 섞임.
- 실제 효과(문의 → 미팅 전환)는 실제 트래픽 없이는 잴 수 없음. 이번 실행의 미팅 1건은 버튼 동작 확인용.

### Surprises
- 프롬프트에 "숫자를 지어내지 말 것"을 넣으니 두 건 모두 숫자를 전혀 만들지 않았음. 반면 업종 어휘(학원 = 학생·학부모)는 서비스 소개 문구에 끌려가 틀림 → 업종별 용어를 `brand.json`/프롬프트에 넣는 편이 효과적일 듯.
- 동의 분기 자체보다 "미동의자에게 사람이 보내는 1:1 답장이 광고인가"라는 법적 판단이 이 방식의 핵심 리스크로 드러남.

### Recommendation
**조건부 채택.** 접수 즉시 확인 + 맞춤 답장 초안 + 동의 기반 분기 구조는 유지보수하기 쉽고, 영업팀이 "답장 쓰는 시간"을 줄이는 데 바로 쓸 만합니다. 다만 처음에는 **광고 동의자도 자동 발송 대신 승인 대기로 보내는 반자동 모드**로 시작해 수정 비율(`approved.meta.edited`)을 보고, 수정이 거의 없어질 때 자동 발송을 켜는 것을 권합니다. 실서비스 전 필요한 것: 법무 확인(미동의자 1:1 답장, 동의 문구), 업종별 용어 보강, 빠른 모델, 관리자 인증, 실제 메일/솔라피 채널.
