import assert from "node:assert/strict";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { collectMetrics } from "../src/engine/metrics.ts";
import { MAX_ATTEMPTS } from "../src/engine/engine.ts";
import { createTestEngine, event } from "./engine-helpers.ts";

const P3_BODY = JSON.stringify({ title: "첫 쿠폰을 보내 보세요", body: "아메리카노 1+1 쿠폰으로 단골을 만들어 보세요. 매장 QR로 손님을 먼저 모아 주세요." });
const O2_BODY = JSON.stringify({ title: "광주 광산구 동네 쿠폰", body: "지민님, 달빛카페 아메리카노 1+1 쿠폰을 4500원에 만나 보세요." });

describe("엔진: 셀프 가입 SaaS (P3 첫 쿠폰 도우미)", () => {
  it("구독 72시간 뒤 조건을 다시 확인하고, 모델로 문구를 만들어 자동 발송(DRY_RUN)한다", async () => {
    const t = createTestEngine({ respond: () => P3_BODY, now: "2026-11-20T01:00:00Z" });
    const result = t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T01:00:00Z" }));
    assert.deepEqual(result, { status: "accepted", jobs: 1, conversions: 0 });

    assert.deepEqual(await t.engine.runDueWork(), { jobs: 0, deliveries: 0 }, "72시간 전에는 실행하지 않는다");
    assert.equal(t.llm.calls.length, 0);

    t.clock.advanceMinutes(72 * 60);
    assert.deepEqual(await t.engine.runDueWork(), { jobs: 1, deliveries: 1 });
    assert.equal(t.llm.calls.length, 1, "모델은 조건을 통과한 뒤 한 번만 호출된다");
    assert.match(t.llm.calls[0].user, /달빛카페/);
    assert.match(t.llm.calls[0].system, /JSON 객체 하나만/);

    const [message] = t.engine.store.listMessages();
    assert.equal(message.status, "dry_run");
    assert.equal(message.channel, "inapp");
    assert.equal(message.advertising, false);
    assert.equal(message.model, "test-model");
  });

  it("그사이 쿠폰을 이미 보낸 매장은 모델을 부르지 않고 사유를 남긴다", async () => {
    const t = createTestEngine({ respond: () => P3_BODY });
    t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1002", occurredAt: "2026-11-20T00:00:00Z" }));
    await t.engine.runDueWork();
    const [job] = t.engine.store.listJobs();
    assert.equal(job.status, "skipped");
    assert.match(job.reason ?? "", /couponSentCount eq 0 \(실제 5\)/);
    assert.equal(t.llm.calls.length, 0);
  });

  it("같은 이벤트를 두 번 받으면 한 번만 처리한다", () => {
    const t = createTestEngine();
    const e = event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001" });
    assert.equal(t.engine.ingest(e).status, "accepted");
    assert.deepEqual(t.engine.ingest(e), { status: "duplicate", jobs: 0, conversions: 0 });
    assert.equal(t.engine.store.listJobs().length, 1);
  });

  it("같은 대상에게 frequencyDays 안에 다시 보내지 않는다", async () => {
    const t = createTestEngine({ respond: () => P3_BODY });
    for (const id of ["a", "b"]) {
      t.engine.ingest(event({ id, service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T00:00:00Z" }));
    }
    await t.engine.runDueWork();
    const statuses = t.engine.store.listJobs().map((j) => `${j.status}:${j.reason ?? ""}`).sort();
    assert.deepEqual(statuses, ["done:", "skipped:frequency_cap"]);
  });
});

describe("엔진: 문구 검증과 재생성", () => {
  it("지어낸 숫자가 있으면 이유를 알려 주고 한 번 다시 쓰게 한다", async () => {
    const answers = [
      JSON.stringify({ title: "첫 쿠폰", body: "쿠폰을 보내면 매출이 30% 오릅니다." }),
      P3_BODY,
    ];
    const t = createTestEngine({ respond: () => answers.shift() ?? P3_BODY });
    t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T00:00:00Z" }));
    await t.engine.runDueWork();
    assert.equal(t.llm.calls.length, 2);
    assert.match(t.llm.calls[1].user, /입력에 없는 숫자 "30/);
    assert.equal(t.engine.store.listMessages()[0].generationAttempts, 2);
  });

  it("두 번 모두 규칙을 어기면 메시지를 만들지 않고 실패로 남긴다", async () => {
    const t = createTestEngine({ respond: () => JSON.stringify({ title: "보장", body: "무조건 성공을 보장합니다." }) });
    t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T00:00:00Z" }));
    await t.engine.runDueWork();
    const [job] = t.engine.store.listJobs();
    assert.equal(job.status, "failed");
    assert.match(job.reason ?? "", /^validation_failed:.*무조건/);
    assert.equal(t.engine.store.listMessages().length, 0);
  });

  it("모델 서버 오류는 간격을 늘려 재시도하고, 한도를 넘으면 실패로 닫는다", async () => {
    const t = createTestEngine({
      respond: () => {
        throw new Error("LLM 호출 실패 (503)");
      },
    });
    t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T00:00:00Z" }));
    await t.engine.runDueWork();
    let [job] = t.engine.store.listJobs();
    assert.equal(job.status, "pending");
    assert.match(job.reason ?? "", /^retry:LLM 호출 실패/);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      t.clock.advanceMinutes(120);
      await t.engine.runDueWork();
    }
    [job] = t.engine.store.listJobs();
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, MAX_ATTEMPTS);
  });
});

describe("엔진: B2C 광고 (O2 첫 구매 유도)", () => {
  it("운영자 승인을 기다리고, 야간 승인은 오전 8시에 (광고) 표기와 함께 발송한다", async () => {
    const t = createTestEngine({ respond: () => O2_BODY, now: "2026-11-22T03:00:00Z" });
    t.engine.ingest(event({ service: "coupin-on", type: "on.member.signed_up", subjectId: "member-2001", occurredAt: "2026-11-19T03:00:00Z" }));
    await t.engine.runDueWork();
    const [pending] = t.engine.store.listMessages({ status: "pending_approval" });
    assert.ok(pending, "광고성 manual 플레이북은 승인 대기열로 간다");
    assert.equal(pending.consentRef, "on-agreement-2001-marketing");

    t.clock.set("2026-11-22T13:30:00Z"); // 22:30 KST
    t.engine.approve(pending.id, "박동민", { content: { title: "광주 동네 쿠폰", body: "지민님, 달빛카페 쿠폰을 만나 보세요." } });
    assert.deepEqual(await t.engine.runDueWork(), { jobs: 0, deliveries: 1 });
    let message = t.engine.store.getMessage(pending.id);
    assert.equal(message.status, "approved", "밤에는 보내지 않는다");
    assert.equal(message.sendAfter, "2026-11-22T23:00:00.000Z");
    assert.equal(message.edited, true);

    t.clock.set("2026-11-22T23:00:00Z"); // 08:00 KST
    await t.engine.runDueWork();
    message = t.engine.store.getMessage(pending.id);
    assert.equal(message.status, "dry_run");
    assert.deepEqual(t.engine.finalContent(message), {
      title: "(광고) 쿠핀 ON 광주 동네 쿠폰",
      body: "지민님, 달빛카페 쿠폰을 만나 보세요.\n\n수신거부: 쿠핀 ON 앱 > 내 정보 > 알림 설정",
    });
  });

  it("승인 뒤 발송 전에 수신 동의를 철회하면 보내지 않는다", async () => {
    const t = createTestEngine({ respond: () => O2_BODY });
    t.engine.ingest(event({ service: "coupin-on", type: "on.member.signed_up", subjectId: "member-2001", occurredAt: "2026-11-19T03:00:00Z" }));
    await t.engine.runDueWork();
    const [pending] = t.engine.store.listMessages({ status: "pending_approval" });
    t.engine.approve(pending.id, "운영자");
    t.updateSubject("coupin-on", "member-2001", (s) => {
      s.consents.marketing = null;
    });
    await t.engine.runDueWork();
    const message = t.engine.store.getMessage(pending.id);
    assert.equal(message.status, "cancelled");
    assert.equal(message.error, "consent_revoked");
  });

  it("광고 수신 동의가 없는 회원은 모델을 부르기 전에 건너뛴다", async () => {
    const t = createTestEngine({ respond: () => O2_BODY });
    t.engine.ingest(event({ service: "coupin-on", type: "on.member.signed_up", subjectId: "member-2002", occurredAt: "2026-11-19T03:00:00Z" }));
    await t.engine.runDueWork();
    assert.equal(t.engine.store.listJobs()[0].reason, "no_marketing_consent");
    assert.equal(t.llm.calls.length, 0);
  });

  it("이미 처리된 메시지는 다시 승인·반려할 수 없다", async () => {
    const t = createTestEngine({ respond: () => O2_BODY });
    t.engine.ingest(event({ service: "coupin-on", type: "on.member.signed_up", subjectId: "member-2001", occurredAt: "2026-11-19T03:00:00Z" }));
    await t.engine.runDueWork();
    const [pending] = t.engine.store.listMessages({ status: "pending_approval" });
    t.engine.reject(pending.id, "운영자", "톤이 맞지 않음");
    assert.throws(() => t.engine.approve(pending.id, "다른 운영자"), /이미 처리된/);
  });

  it("승인자가 고친 문구도 금지어 검사를 거친다", async () => {
    const t = createTestEngine({ respond: () => O2_BODY });
    t.engine.ingest(event({ service: "coupin-on", type: "on.member.signed_up", subjectId: "member-2001", occurredAt: "2026-11-19T03:00:00Z" }));
    await t.engine.runDueWork();
    const [pending] = t.engine.store.listMessages({ status: "pending_approval" });
    assert.throws(() => t.engine.approve(pending.id, "운영자", { content: { title: "공짜 쿠폰", body: "공짜" } }), /금지 표현/);
    assert.equal(t.engine.store.getMessage(pending.id).status, "pending_approval");
  });
});

describe("엔진: 모델 없는 플레이북 (O1 만료 안내)", () => {
  it("고정 문구로 정보성 알림톡을 보내고 모델을 부르지 않는다", async () => {
    const t = createTestEngine();
    t.engine.ingest(
      event({ service: "coupin-on", type: "on.coupon.expiring", subjectId: "member-2001", payload: { couponName: "아메리카노 1+1", daysLeft: 7, expiresOn: "2026-11-30" } }),
    );
    await t.engine.runDueWork();
    const [message] = t.engine.store.listMessages();
    assert.equal(message.body, "지민님, 보유하신 '아메리카노 1+1' 쿠폰이 7일 후 만료됩니다. (2026-11-30까지)");
    assert.equal(message.channel, "alimtalk");
    assert.equal(message.status, "dry_run");
    assert.equal(t.llm.calls.length, 0);
  });

  it("조건에 맞지 않는 남은 일수(3일)는 보내지 않는다", async () => {
    const t = createTestEngine();
    t.engine.ingest(event({ service: "coupin-on", type: "on.coupon.expiring", subjectId: "member-2001", payload: { couponName: "x", daysLeft: 3, expiresOn: "2026-11-27" } }));
    await t.engine.runDueWork();
    assert.equal(t.engine.store.listJobs()[0].status, "skipped");
  });
});

describe("엔진: 실제 발송 연결과 효과 측정", () => {
  const received: { body: any; idempotencyKey: string | undefined }[] = [];
  let failNext = 0;
  const relay = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(503).end();
        return;
      }
      received.push({ body: JSON.parse(raw), idempotencyKey: req.headers["idempotency-key"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ providerRef: `prov-${received.length}` }));
    });
  });
  after(() => relay.close());

  async function relayUrl(): Promise<string> {
    if (!relay.listening) await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(relay.address() as AddressInfo).port}/deliver`;
  }

  it("DRY_RUN=false면 서비스 발송 API로 보내고, 일시 오류는 재시도하며, 목표 이벤트로 전환을 기록한다", async () => {
    const url = await relayUrl();
    const t = createTestEngine({
      respond: () => P3_BODY,
      extraEnv: { DRY_RUN: "false", PLUS_DELIVERY_TOKEN: "delivery-token-0123456789" },
      mutateServices: (services) => {
        services[0].delivery = { type: "http", url, tokenEnv: "PLUS_DELIVERY_TOKEN" };
      },
    });
    t.engine.ingest(event({ service: "coupin-plus", type: "plus.subscription.started", subjectId: "store-1001", occurredAt: "2026-11-20T00:00:00Z" }));
    failNext = 1;
    await t.engine.runDueWork();
    let [message] = t.engine.store.listMessages();
    assert.equal(message.status, "approved", "503이면 재시도 대기");
    assert.match(message.error ?? "", /503/);

    t.clock.advanceMinutes(5);
    await t.engine.runDueWork();
    [message] = t.engine.store.listMessages();
    assert.equal(message.status, "sent");
    assert.equal(message.providerRef, "prov-1");
    assert.equal(received.at(-1)?.idempotencyKey, message.id);
    assert.equal(received.at(-1)?.body.recipient, "store-1001");

    // 발송 3일 뒤 첫 쿠폰 발송 → P3 목표 달성
    t.clock.advanceMinutes(3 * 24 * 60);
    const conversion = t.engine.ingest(
      event({ service: "coupin-plus", type: "plus.coupon.sent", subjectId: "store-1001", occurredAt: t.clock.now.toISOString() }),
    );
    assert.equal(conversion.conversions, 1);
    const metrics = collectMetrics(t.engine.store).find((m) => m.playbookId === "plus-first-coupon");
    assert.equal(metrics?.sent, 1);
    assert.equal(metrics?.converted, 1);
    assert.equal(metrics?.conversionRate, 1);
  });
});
