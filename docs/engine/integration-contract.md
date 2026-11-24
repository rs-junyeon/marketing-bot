# 서비스 연동 규격 (v1)

마케팅 봇 엔진에 서비스를 붙이려면 서비스 쪽에서 아래 **3가지**를 구현하고 `config/services.json`에 등록합니다. 엔진은 서비스의 DB에 직접 접근하지 않고, 이 규격으로만 주고받습니다.

| 방향 | 내용 | 필수 |
|---|---|---|
| 서비스 → 엔진 | 이벤트 웹훅 `POST /v1/events` | 필수 |
| 엔진 → 서비스 | 대상 조회 `GET {baseUrl}/subjects/{id}` | 필수 |
| 엔진 → 서비스 | 발송 위임 `POST {deliveryUrl}` | 실제 발송 시 |

## 1. 이벤트 웹훅 (서비스 → 엔진)

```http
POST /v1/events
content-type: application/json
x-mb-service: coupin-plus
x-mb-timestamp: 1763946000
x-mb-signature: v1=<hex(HMAC-SHA256(secret, "{timestamp}.{raw body}"))>

{
  "id": "evt-8f2c...",                    // 서비스 안에서 고유. 같은 id 재전송은 무시됨(중복 방지)
  "type": "plus.subscription.started",     // 플레이북 trigger.event 와 맞춘다
  "subjectId": "store-1001",               // 마케팅 대상 id (사장님, 회원 등)
  "occurredAt": "2026-11-20T01:00:00Z",    // 지연 실행(delayMinutes)의 기준 시각
  "payload": { "plan": "basic" }           // 1단계 원시값만 (문자열·숫자·true/false·null)
}
```

- 응답: `202 accepted`(새 이벤트), `200 duplicate`(이미 받음), `400`(형식 오류, 어떤 필드인지 표시), `401`(서명 오류)
- 서명 시각은 ±5분 안이어야 합니다. 시크릿은 서비스마다 다릅니다(`webhookSecretEnv`).
- 실패(네트워크·5xx) 시 같은 `id`로 재전송하면 됩니다. 중복 처리되지 않습니다.
- 서명 예시와 시험 전송: `pnpm engine:event <service> <event.json> --secret-env <변수명>` (`src/engine/send-event-cli.ts`)

### 첫 적용 서비스가 보낼 이벤트

| 서비스 | type | 언제 | payload |
|---|---|---|---|
| 쿠핀 PLUS | `plus.subscription.started` | 구독 결제 완료 | `plan` |
| 쿠핀 PLUS | `plus.report.generated` | AI 월간 리포트 생성 | `period`, `nextPeriod`, `summary`, `nextAction` |
| 쿠핀 PLUS | `plus.coupon.sent` | 사장님이 쿠폰 발송 (효과 측정용) | - |
| 쿠핀 ON | `on.member.signed_up` | 회원 가입 | `channel` (유입 경로) |
| 쿠핀 ON | `on.coupon.expiring` | 만료 30·7·1일 전 (기존 expiry-notice 배치) | `couponName`, `daysLeft`, `expiresOn` |
| 쿠핀 ON | `on.order.paid` | 결제 완료 (효과 측정용) | - |
| 쿠핀 ON | `on.coupon.redeemed` | 쿠폰 사용 (효과 측정용) | - |

## 2. 대상 조회 (엔진 → 서비스)

```http
GET {baseUrl}/subjects/{subjectId}
authorization: Bearer <tokenEnv 값>
```

```json
{
  "id": "member-2001",
  "displayName": "지민",
  "contacts": { "push": "device-token", "alimtalk": "01000000000" },
  "consents": {
    "marketing": { "ref": "on-agreement-2001-marketing", "grantedAt": "2026-11-10T03:00:00Z" },
    "nightMarketing": null
  },
  "facts": { "region": "광주 광산구", "purchaseCount": 0, "recommendedCouponName": "달빛카페 아메리카노 1+1" }
}
```

- 엔진은 **조건 판단 직전과 발송 직전에 매번** 호출합니다. 동의 철회·상태 변화가 바로 반영되도록 캐시하지 않은 최신 값을 주세요.
- `404`는 "대상 없음"(건너뜀), `429`/`5xx`는 재시도, 그 외 4xx는 실패로 처리합니다.
- `consents.marketing`: 광고성 정보 수신 동의. 없으면 광고성 플레이북은 모델을 부르기 전에 건너뜁니다. `ref`는 발송 기록에 동의 근거로 남습니다.
- `consents.nightMarketing`: 21~08시 광고 수신 별도 동의. 없으면 야간 광고는 오전 8시로 미뤄집니다.
- `contacts` 키: `inapp`, `push`, `alimtalk`, `brand_message`, `sms`, `email`
- `facts`: 플레이북 조건(`subject.<이름>`)과 프롬프트 변수(`{{subject_<이름>}}`)에 쓰입니다. **필요한 값만** 주세요(개인정보 최소화).

## 3. 발송 위임 (엔진 → 서비스)

알림톡·푸시 계정과 발신 번호는 서비스가 이미 갖고 있으므로, 엔진은 발송을 서비스에 위임합니다.

```http
POST {deliveryUrl}
authorization: Bearer <tokenEnv 값>
idempotency-key: msg_1a2b3c...       // 같은 키는 한 번만 보내 주세요
content-type: application/json

{
  "messageId": "msg_1a2b3c...",
  "service": "coupin-on",
  "playbookId": "on-first-purchase",
  "subjectId": "member-2001",
  "channel": "push",
  "recipient": "device-token",
  "content": { "title": "(광고) 쿠핀 ON ...", "body": "...\n\n수신거부: ..." },
  "advertising": true,
  "consentRef": "on-agreement-2001-marketing"
}
```

- 응답 `2xx` + `{ "providerRef": "..." }`(선택)이면 발송 완료로 기록합니다.
- `429`/`5xx`/네트워크 오류는 최대 5회까지 간격을 늘려 재시도합니다. 그래서 **idempotency-key 처리가 필수**입니다.
- 광고성 메시지의 `(광고)` 표기와 수신거부 안내는 엔진이 이미 붙여 보냅니다. 서비스는 그대로 보내면 됩니다.
- `inapp`은 서비스 화면(콘솔 카드, 앱 알림함)에 보여 주는 용도입니다.

## 새 서비스를 붙이는 순서

1. 위 1~3을 서비스에 구현합니다 (1회).
2. `config/services.json`에 서비스를 추가합니다. 유형(`b2b-sales` / `self-serve-saas` / `b2c`), 브랜드, 수신거부 문구, 주간 광고 한도, 시크릿 환경 변수 이름.
3. `config/playbooks/`에 플레이북 JSON을, `prompts/engine/`에 프롬프트를 추가합니다. 엔진 코드는 바꾸지 않습니다.
4. `DRY_RUN=true`로 이벤트를 보내 승인 화면(`/admin`)에서 문구를 확인한 뒤, 서비스 담당자와 함께 `DRY_RUN=false`로 전환합니다.
