import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSendable } from "../src/shared/channel.ts";
import { loadConfig } from "../src/shared/config.ts";
import { parseJsonResponse, stripThinking } from "../src/shared/llm.ts";
import { EVENTS, summarize } from "../src/shared/metrics.ts";
import { fill } from "../src/shared/prompts.ts";
import { createTestContext } from "./helpers.ts";

describe("config", () => {
  it("기본값은 로컬 Ollama + dry-run", () => {
    const config = loadConfig({});
    assert.equal(config.llmBaseUrl, "http://localhost:11434/v1");
    assert.equal(config.dryRun, true);
  });

  it("DRY_RUN=false 일 때만 실제 발송 모드", () => {
    assert.equal(loadConfig({ DRY_RUN: "false" }).dryRun, false);
    assert.equal(loadConfig({ DRY_RUN: "0" }).dryRun, true);
  });

  it("알 수 없는 공급자는 거부", () => {
    assert.throws(() => loadConfig({ LLM_PROVIDER: "foo" }));
  });
});

describe("llm helpers", () => {
  it("think 블록 제거", () => {
    assert.equal(stripThinking("<think>고민</think>답"), "답");
  });

  it("코드펜스 JSON 파싱", () => {
    assert.deepEqual(parseJsonResponse<{ a: number }>('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("JSON이 아니면 원문과 함께 에러", () => {
    assert.throws(() => parseJsonResponse("그냥 문장"), /그냥 문장/);
  });
});

describe("prompts.fill", () => {
  it("변수 치환", () => {
    assert.equal(fill("안녕 {{name}}", { name: "사장님" }), "안녕 사장님");
  });

  it("빠진 변수는 에러", () => {
    assert.throws(() => fill("{{missing}}", {}), /missing/);
  });
});

describe("approval queue", () => {
  it("제출 → 승인, 중복 처리 금지", () => {
    const { approvals } = createTestContext();
    const item = approvals.submit({ prototype: "a-content", kind: "blog-post", title: "t", body: "b" });
    assert.equal(approvals.list({ status: "pending" }).length, 1);
    approvals.decide(item.id, "approved");
    assert.equal(approvals.get(item.id).status, "approved");
    assert.throws(() => approvals.decide(item.id, "rejected"), /이미 처리/);
  });
});

describe("channel", () => {
  it("광고성 메시지는 동의 근거 없이 발송 불가", () => {
    assert.throws(() => assertSendable({ channel: "email", to: "a@b.c", body: "x", isAdvertising: true }));
    assert.doesNotThrow(() => assertSendable({ channel: "email", to: "a@b.c", body: "x", isAdvertising: false }));
  });

  it("dry-run은 outbox에만 기록", async () => {
    const { channel, store } = createTestContext();
    const result = await channel.send({ channel: "email", to: "a@b.c", body: "x", isAdvertising: true, consentRef: "lead_1" });
    assert.equal(result.status, "dry-run");
    assert.equal(store.readJsonl("outbox.jsonl").length, 1);
  });
});

describe("metrics", () => {
  it("승인율·실패율 요약", async () => {
    const { metrics } = createTestContext();
    await metrics.track("a-content", {}, async () => "ok");
    await assert.rejects(metrics.track("a-content", {}, async () => Promise.reject(new Error("boom"))));
    metrics.record("a-content", EVENTS.approved);
    const [summary] = summarize(metrics.all());
    assert.equal(summary.counts.generated, 1);
    assert.equal(summary.failureRate, 0.5);
    assert.equal(summary.approvalRate, 1);
  });
});
