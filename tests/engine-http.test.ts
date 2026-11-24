import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { Server } from "node:http";
import { createEngineServer, signPayload } from "../src/engine/http.ts";
import { silentLogger } from "../src/engine/logger.ts";
import { ADMIN_TOKEN, ON_SECRET, PLUS_SECRET, createTestEngine } from "./engine-helpers.ts";

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

const DEFAULT_REPLY = JSON.stringify({ title: "광주 동네 쿠폰", body: "지민님, 달빛카페 아메리카노 1+1 쿠폰을 만나 보세요." });

async function start(reply = DEFAULT_REPLY) {
  const t = createTestEngine({ now: new Date().toISOString(), respond: () => reply });
  const server = createEngineServer({ engine: t.engine, adminToken: ADMIN_TOKEN, logger: silentLogger });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { t, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function signed(service: string, secret: string, payload: unknown, timestamp = Math.floor(Date.now() / 1000)): RequestInit {
  const body = JSON.stringify(payload);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mb-service": service,
      "x-mb-timestamp": String(timestamp),
      "x-mb-signature": signPayload(secret, timestamp, body),
    },
    body,
  };
}

const SIGNUP = { id: "evt-http-1", type: "on.member.signed_up", subjectId: "member-2001", occurredAt: "2026-11-01T00:00:00Z", payload: {} };
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("HTTP: 웹훅 수신", () => {
  it("올바르게 서명한 이벤트는 202, 같은 이벤트 재전송은 200 duplicate", async () => {
    const { base } = await start();
    const first = await fetch(`${base}/v1/events`, signed("coupin-on", ON_SECRET, SIGNUP));
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { status: "accepted", jobs: 1, conversions: 0 });
    const again = await fetch(`${base}/v1/events`, signed("coupin-on", ON_SECRET, SIGNUP));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, "duplicate");
  });

  it("다른 서비스 시크릿·위조 서명·오래된 서명은 401", async () => {
    const { base } = await start();
    assert.equal((await fetch(`${base}/v1/events`, signed("coupin-on", PLUS_SECRET, SIGNUP))).status, 401);
    const tampered = signed("coupin-on", ON_SECRET, SIGNUP);
    tampered.body = JSON.stringify({ ...SIGNUP, subjectId: "member-2002" });
    assert.equal((await fetch(`${base}/v1/events`, tampered)).status, 401);
    const stale = signed("coupin-on", ON_SECRET, SIGNUP, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await fetch(`${base}/v1/events`, stale)).status, 401);
    assert.equal((await fetch(`${base}/v1/events`, signed("unknown", ON_SECRET, SIGNUP))).status, 401);
  });

  it("형식이 틀린 이벤트는 어떤 필드가 틀렸는지 400으로 알려 준다", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/v1/events`, signed("coupin-on", ON_SECRET, { ...SIGNUP, payload: { nested: { a: 1 } } }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /event.payload.nested/);
  });
});

describe("HTTP: 운영 API와 승인 화면", () => {
  it("관리자 토큰 없이는 운영 API를 쓸 수 없다", async () => {
    const { base } = await start();
    assert.equal((await fetch(`${base}/v1/messages`)).status, 401);
    assert.equal((await fetch(`${base}/v1/messages`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  it("API로 대기열을 보고 승인하면 미리보기에 (광고) 표기가 붙는다", async () => {
    const { t, base } = await start();
    await fetch(`${base}/v1/events`, signed("coupin-on", ON_SECRET, SIGNUP));
    await t.engine.runDueWork();
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const list = await (await fetch(`${base}/v1/messages?status=pending_approval`, { headers: auth })).json();
    assert.equal(list.length, 1);
    assert.match(list[0].preview.title, /^\(광고\) 쿠핀 ON/);

    const approved = await fetch(`${base}/v1/messages/${list[0].id}/approve`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "박동민", note: "좋습니다" }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).decidedBy, "박동민");
    const again = await fetch(`${base}/v1/messages/${list[0].id}/reject`, { method: "POST", headers: auth });
    assert.equal(again.status, 409);
    const metrics = await (await fetch(`${base}/v1/metrics`, { headers: auth })).json();
    assert.equal(metrics.find((m: { playbookId: string }) => m.playbookId === "on-first-purchase").generated, 1);
  });

  it("승인 화면은 HTML을 escape 하고, 다른 사이트에서 보낸 폼은 막는다", async () => {
    // 서비스 데이터에 스크립트가 섞여 들어와 모델이 그대로 옮긴 경우를 흉내 낸다.
    const { t, base } = await start(JSON.stringify({ title: "동네 쿠폰", body: "<script>alert(1)</script> 쿠폰" }));
    t.updateSubject("coupin-on", "member-2001", (s) => {
      s.facts.recommendedCouponName = "<script>alert(1)</script>";
    });
    await fetch(`${base}/v1/events`, signed("coupin-on", ON_SECRET, SIGNUP));
    await t.engine.runDueWork();
    const [pending] = t.engine.store.listMessages({ status: "pending_approval" });
    const auth = { authorization: basic("박동민", ADMIN_TOKEN) };

    const page = await (await fetch(`${base}/admin`, { headers: auth })).text();
    assert.match(page, /승인 대기열/);
    assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt; 쿠폰"), "문구는 보이되 escape 되어야 한다");
    assert.ok(!page.includes("<script>"), "원본 스크립트가 그대로 나오면 안 된다");

    const form = { method: "POST", body: new URLSearchParams({ note: "" }).toString(), redirect: "manual" as const };
    const crossSite = await fetch(`${base}/admin/messages/${pending.id}/approve`, {
      ...form,
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(t.engine.store.getMessage(pending.id).status, "pending_approval");

    const sameSite = await fetch(`${base}/admin/messages/${pending.id}/reject`, {
      ...form,
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded", origin: base },
    });
    assert.equal(sameSite.status, 303);
    const message = t.engine.store.getMessage(pending.id);
    assert.equal(message.status, "rejected");
    assert.equal(message.decidedBy, "박동민");
  });
});
