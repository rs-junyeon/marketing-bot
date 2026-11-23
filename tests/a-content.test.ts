import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { writeTopicHandoff } from "../src/shared/handoff.ts";
import { EVENTS } from "../src/shared/metrics.ts";
import {
  approve,
  buildLandingUrl,
  generateDrafts,
  listPending,
  listTopics,
  reject,
  validateDraft,
} from "../src/prototypes/a-content/content.ts";
import { createTestContext } from "./helpers.ts";

const validBody = [
  "## 첫 방문에서 기억에 남는 한마디",
  "처음 오신 손님께 메뉴를 고르는 데 도움이 되는 한마디를 건네 보세요. ".repeat(10),
  "## 다시 올 이유 만들기",
  "계산할 때 다음 방문에 쓸 수 있는 작은 혜택을 안내해 드리면 좋습니다. ".repeat(10),
].join("\n\n");

const validResponse = () => JSON.stringify({ title: "단골을 만드는 첫 방문 응대법", body: validBody, summary: "첫 방문 응대 팁" });

const names = (events: { name: string }[]) => events.map((event) => event.name);

describe("a-content", () => {
  it("draft: 승인 대기 + 초안 파일 + generated 지표", async () => {
    const ctx = createTestContext(validResponse);
    const [draft] = await generateDrafts(ctx);
    const pending = listPending(ctx);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, draft.approvalId);
    assert.equal(pending[0].kind, "blog-post");
    assert.equal(pending[0].meta.slug, draft.slug);
    assert.ok(pending[0].meta.topic);
    assert.ok(existsSync(draft.file));
    assert.match(readFileSync(draft.file, "utf8"), /단골을 만드는 첫 방문 응대법/);
    assert.deepEqual(names(ctx.metrics.all()), [EVENTS.generated]);
    // 프롬프트에 금지 규칙이 들어가는지
    assert.match(ctx.llm.calls[0].system, /통계/);
  });

  it("draft: CTA 링크에 UTM 파라미터", async () => {
    const ctx = createTestContext(validResponse);
    const [draft] = await generateDrafts(ctx);
    const expected = buildLandingUrl("https://d-on.coupin.io", draft.slug);
    assert.ok(draft.body.includes(expected));
    const url = new URL(expected);
    assert.equal(url.searchParams.get("utm_source"), "blog");
    assert.equal(url.searchParams.get("utm_medium"), "content");
    assert.equal(url.searchParams.get("utm_campaign"), draft.slug);
  });

  it("draft --count 2: 두 건 생성", async () => {
    const ctx = createTestContext(validResponse);
    const drafts = await generateDrafts(ctx, { topic: "직접 정한 주제", count: 2 });
    assert.equal(drafts.length, 2);
    assert.equal(listPending(ctx).length, 2);
    assert.equal(drafts[0].topic, "직접 정한 주제");
  });

  it("잘못된 LLM 출력 → failed 지표 + throw, 승인 대기 없음", async () => {
    const ctx = createTestContext(() => JSON.stringify({ title: "짧은 글", body: "너무 짧습니다", summary: "" }));
    await assert.rejects(generateDrafts(ctx), /검증 실패/);
    assert.deepEqual(names(ctx.metrics.all()), [EVENTS.failed]);
    assert.equal(listPending(ctx).length, 0);

    const notJson = createTestContext(() => "JSON이 아닌 답변");
    await assert.rejects(generateDrafts(notJson));
    assert.deepEqual(names(notJson.metrics.all()), [EVENTS.failed]);
  });

  it("빈칸 표시가 남은 글은 거부", () => {
    assert.throws(() => validateDraft({ title: "t", body: `${validBody}\n[가게 이름]에 오세요`, summary: "" }), /빈칸/);
    assert.throws(() => validateDraft({ title: "t", body: `${validBody}\nOO카페 사장님`, summary: "" }), /빈칸/);
  });

  it("approve: outbox + published 파일 + approved/sent 지표", async () => {
    const ctx = createTestContext(validResponse);
    const [draft] = await generateDrafts(ctx);
    const result = await approve(ctx, draft.approvalId);
    const outbox = ctx.store.readJsonl<{ channel: string; subject: string; isAdvertising: boolean }>("outbox.jsonl");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].channel, "blog");
    assert.equal(outbox[0].subject, draft.title);
    assert.equal(outbox[0].isAdvertising, false);
    assert.equal(result.file, ctx.store.path("a-content", "published", `${draft.slug}.md`));
    assert.ok(existsSync(result.file));
    assert.deepEqual(names(ctx.metrics.all()), [EVENTS.generated, EVENTS.approved, EVENTS.sent]);
    assert.equal(listPending(ctx).length, 0);
  });

  it("reject: rejected 지표, 발송 없음", async () => {
    const ctx = createTestContext(validResponse);
    const [draft] = await generateDrafts(ctx);
    const item = reject(ctx, draft.id, "톤이 딱딱함");
    assert.equal(item.status, "rejected");
    assert.equal(item.note, "톤이 딱딱함");
    assert.deepEqual(names(ctx.metrics.all()), [EVENTS.generated, EVENTS.rejected]);
    assert.equal(ctx.store.readJsonl("outbox.jsonl").length, 0);
  });

  it("topics: D 전달 주제가 있으면 우선", () => {
    const ctx = createTestContext();
    assert.equal(listTopics(ctx).source, "samples");
    assert.ok(listTopics(ctx).topics.length >= 5);
    writeTopicHandoff(ctx.store, {
      generatedAt: new Date().toISOString(),
      topics: [{ title: "장마철 배달 포장 고민", reason: "커뮤니티 언급 증가", sourceLinks: [] }],
    });
    const { source, topics } = listTopics(ctx);
    assert.equal(source, "handoff");
    assert.equal(topics[0].title, "장마철 배달 포장 고민");
  });
});
