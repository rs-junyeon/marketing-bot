import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { ApprovalItem } from "../src/shared/approval.ts";
import type { OutboundMessage } from "../src/shared/channel.ts";
import type { AppContext } from "../src/shared/context.ts";
import type { CompletionRequest } from "../src/shared/llm.ts";
import { EVENTS, type MetricEvent } from "../src/shared/metrics.ts";
import { type LeadServer, createLeadServer } from "../src/prototypes/b-lead-followup/app.ts";
import { LEADS_FILE, type Lead } from "../src/prototypes/b-lead-followup/leads.ts";
import { createTestContext } from "./helpers.ts";

const FOLLOW_UP = "사장님, 평일 오후 손님 고민 잘 읽었습니다. 15분 통화로 활용법을 안내드리고 싶습니다.";

const servers: LeadServer[] = [];
after(() => {
  for (const app of servers) {
    app.server.closeAllConnections();
    app.server.close();
  }
});

async function start(respond: (request: CompletionRequest) => string = () => FOLLOW_UP) {
  const ctx = createTestContext(respond);
  const app = createLeadServer(ctx);
  servers.push(app);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { ctx, app, base };
}

function form(fields: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" };
}

const VALID = {
  company: "달빛카페",
  name: "김사장",
  email: "owner@example.com",
  industry: "카페",
  concern: "평일 오후에 손님이 너무 없어요.",
  privacyConsent: "on",
  utm_source: "test",
  utm_medium: "cpc",
  utm_campaign: "winter",
};

const outbox = (ctx: AppContext) => ctx.store.readJsonl<OutboundMessage & { id: string }>("outbox.jsonl");
const events = (ctx: AppContext, name: string) => ctx.metrics.all().filter((e: MetricEvent) => e.name === name);

describe("b-lead-followup 랜딩페이지", () => {
  it("UTM 값을 hidden 필드로 담고 광고 동의는 기본 미체크", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/?utm_source=naver&utm_medium=blog&utm_campaign=open`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<input type="hidden" name="utm_source" value="naver">/);
    assert.match(html, /<input type="hidden" name="utm_medium" value="blog">/);
    assert.match(html, /<input type="hidden" name="utm_campaign" value="open">/);
    assert.match(html, /\[필수\]<\/span> 개인정보 수집·이용/);
    assert.match(html, /\[선택\]<\/span> 광고성 정보 수신/);
    assert.match(html, /name="marketingConsent" value="on">/, "광고 동의 체크박스는 기본 해제");
  });

  it("개인정보 동의 없으면 400 + 한국어 오류, 저장하지 않음", async () => {
    const { ctx, base } = await start();
    const { privacyConsent: _omit, ...withoutConsent } = VALID;
    const res = await fetch(`${base}/leads`, form({ ...withoutConsent, email: "잘못된메일" }));
    const html = await res.text();
    assert.equal(res.status, 400);
    assert.match(html, /개인정보 수집·이용에 동의해야/);
    assert.match(html, /이메일 형식이 올바르지 않습니다/);
    assert.equal(ctx.store.readJsonl(LEADS_FILE).length, 0);

    const jsonRes = await fetch(`${base}/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "a" }),
    });
    assert.equal(jsonRes.status, 400);
    const body = (await jsonRes.json()) as { errors: Record<string, string> };
    assert.ok(body.errors.privacyConsent && body.errors.name);
  });
});

describe("b-lead-followup 후속 자동화", () => {
  it("광고 동의 리드: 저장 + 접수확인·후속 메시지 2건 발송, 후속은 광고성+consentRef", async () => {
    const { ctx, app, base } = await start();
    const res = await fetch(`${base}/leads`, form({ ...VALID, marketingConsent: "on" }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /문의가 접수되었습니다/);
    await app.jobs.idle();

    const [lead] = ctx.store.readJsonl<Lead>(LEADS_FILE);
    assert.equal(lead.utm.source, "test");
    assert.ok(lead.privacyConsentAt);
    assert.ok(lead.marketingConsentAt);

    const sent = outbox(ctx);
    assert.equal(sent.length, 2);
    const [receipt, followUp] = sent;
    assert.equal(receipt.isAdvertising, false);
    assert.equal(followUp.isAdvertising, true);
    assert.equal(followUp.consentRef, lead.id);
    assert.match(followUp.subject ?? "", /^\(광고\)/);
    assert.match(followUp.body, /수신거부/);
    assert.ok(followUp.body.includes(FOLLOW_UP));

    // 프롬프트에 업종·고민이 들어갔는지
    assert.match(ctx.llm.calls[0].user, /카페/);
    assert.match(ctx.llm.calls[0].user, /평일 오후에 손님이 너무 없어요/);
    assert.equal(events(ctx, EVENTS.leadCaptured).length, 1);
    assert.equal(events(ctx, EVENTS.generated).length, 1);
    assert.equal(events(ctx, EVENTS.sent).length, 2);
    assert.equal(ctx.approvals.all().length, 0);
  });

  it("광고 미동의 리드: 후속은 승인 대기열로, 승인하면 비광고 1:1 답장 발송", async () => {
    const { ctx, app, base } = await start();
    const res = await fetch(`${base}/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID, privacyConsent: true }),
    });
    assert.equal(res.status, 201);
    const { leadId } = (await res.json()) as { leadId: string };
    await app.jobs.idle();

    assert.equal(ctx.store.readJsonl<Lead>(LEADS_FILE)[0].marketingConsentAt, null);
    assert.equal(outbox(ctx).length, 1, "접수 확인만 발송");
    const [item] = ctx.approvals.list({ prototype: "b-lead-followup", status: "pending" }) as ApprovalItem[];
    assert.equal(item.kind, "follow-up-message");
    assert.equal(item.meta.leadId, leadId);
    assert.equal(item.meta.email, VALID.email);

    const admin = await (await fetch(`${base}/admin`)).text();
    assert.match(admin, /승인 대기/);

    const approve = await fetch(`${base}/admin/approvals/${item.id}/approve`, form({ body: "수정한 답장입니다." }));
    assert.equal(approve.status, 303);
    const sent = outbox(ctx);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].isAdvertising, false);
    assert.match(sent[1].body, /수정한 답장입니다/);
    assert.doesNotMatch(sent[1].subject ?? "", /광고/);
    assert.equal(ctx.approvals.get(item.id).status, "approved");
    assert.equal(events(ctx, EVENTS.approved).length, 1);

    const again = await fetch(`${base}/admin/approvals/${item.id}/approve`, form({}));
    assert.equal(again.status, 409);
  });

  it("반려하면 발송하지 않고 rejected 기록", async () => {
    const { ctx, app, base } = await start();
    await fetch(`${base}/leads`, form(VALID));
    await app.jobs.idle();
    const [item] = ctx.approvals.all();
    const res = await fetch(`${base}/admin/approvals/${item.id}/reject`, form({}));
    assert.equal(res.status, 303);
    assert.equal(outbox(ctx).length, 1);
    assert.equal(events(ctx, EVENTS.rejected).length, 1);
  });

  it("미팅 확정 버튼은 meeting_booked를 리드 id와 함께 한 번만 기록", async () => {
    const { ctx, app, base } = await start();
    await fetch(`${base}/leads`, form({ ...VALID, marketingConsent: "on" }));
    await app.jobs.idle();
    const [lead] = ctx.store.readJsonl<Lead>(LEADS_FILE);

    const res = await fetch(`${base}/admin/leads/${lead.id}/meeting`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin");
    await fetch(`${base}/admin/leads/${lead.id}/meeting`, { method: "POST", redirect: "manual" });
    const meetings = events(ctx, EVENTS.meetingBooked);
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].meta?.leadId, lead.id);
    assert.match(await (await fetch(`${base}/admin`)).text(), /미팅 확정<\/td>/);

    const missing = await fetch(`${base}/admin/leads/lead_nope/meeting`, { method: "POST", redirect: "manual" });
    assert.equal(missing.status, 404);
  });

  it("사용자 입력은 HTML 이스케이프", async () => {
    const { app, base } = await start();
    const evil = `<script>alert("x")</script>`;
    const landing = await (await fetch(`${base}/?utm_source=${encodeURIComponent(`"><script>x</script>`)}`)).text();
    assert.doesNotMatch(landing, /<script>x/);
    assert.match(landing, /value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);

    const rerender = await (await fetch(`${base}/leads`, form({ company: evil }))).text();
    assert.doesNotMatch(rerender, /<script>alert/);
    assert.match(rerender, /&lt;script&gt;alert\(&quot;x&quot;\)/);

    await fetch(`${base}/leads`, form({ ...VALID, company: evil, name: evil }));
    await app.jobs.idle();
    const admin = await (await fetch(`${base}/admin`)).text();
    assert.doesNotMatch(admin, /<script>alert/);
    assert.match(admin, /&lt;script&gt;/);
  });

  it("LLM 실패: failed 지표 기록, 접수 확인은 발송, 서버는 계속 응답", async () => {
    const { ctx, app, base } = await start(() => {
      throw new Error("ollama down");
    });
    const res = await fetch(`${base}/leads`, form({ ...VALID, marketingConsent: "on" }));
    assert.equal(res.status, 200);
    await app.jobs.idle();

    const failed = events(ctx, EVENTS.failed);
    assert.equal(failed.length, 1);
    assert.match(failed[0].meta?.error ?? "", /ollama down/);
    assert.equal(outbox(ctx).length, 1, "접수 확인만 발송, 후속은 미발송");
    assert.equal(ctx.approvals.all().length, 0);

    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.match(await (await fetch(`${base}/admin`)).text(), /생성\/발송 실패/);
  });
});

describe("b-lead-followup 한자 섞임", () => {
  it("한자가 섞이면 한 번 다시 생성해 깨끗한 문장을 보낸다", async () => {
    let calls = 0;
    const { ctx, app, base } = await start(() => (++calls === 1 ? "재방문率을 높입니다." : FOLLOW_UP));
    await fetch(`${base}/leads`, form({ ...VALID, marketingConsent: "on" }));
    await app.jobs.idle();
    assert.equal(calls, 2);
    const followUp = outbox(ctx).find((m) => m.isAdvertising);
    assert.ok(followUp?.body.includes(FOLLOW_UP));
    assert.equal(events(ctx, EVENTS.failed).length, 0);
  });
});
