import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readTopicHandoff } from "../src/shared/handoff.ts";
import { EVENTS } from "../src/shared/metrics.ts";
import { analyze, itemText, latestReport, normalizeAnalysis } from "../src/prototypes/d-community-monitor/analyze.ts";
import { type SourceConfig, type TextFetcher, collect, readItems } from "../src/prototypes/d-community-monitor/collect.ts";
import { countKeywords, countWatchKeywords, tokenize } from "../src/prototypes/d-community-monitor/keywords.ts";
import { decodeEntities, parseRss } from "../src/prototypes/d-community-monitor/rss.ts";
import { createTestContext } from "./helpers.ts";

const NOW = new Date("2026-11-23T03:00:00Z");

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>테스트</title>
<item>
  <title><![CDATA[소상공인 <단골> 관리 & 쿠폰]]></title>
  <link>https://example.com/a?x=1&amp;y=2</link>
  <pubDate>Mon, 23 Nov 2026 01:00:00 GMT</pubDate>
  <description>&lt;a href="https://example.com/a"&gt;배달수수료 &amp;quot;부담&amp;quot;&lt;/a&gt;&amp;nbsp;&lt;font&gt;한국일보&lt;/font&gt;</description>
</item>
<item>
  <title>사장님 리뷰 &#47196;&#xADF8; &quot;관리&quot;</title>
  <link>https://example.com/b</link>
</item>
<item>
  <description>제목도 링크도 없는 항목</description>
</item>
</channel></rss>`;

function rssWith(entries: { title: string; link: string }[]): string {
  const items = entries
    .map((e) => `<item><title>${e.title}</title><link>${e.link}</link><pubDate>Mon, 23 Nov 2026 01:00:00 GMT</pubDate></item>`)
    .join("");
  return `<rss version="2.0"><channel>${items}</channel></rss>`;
}

const rssSource = (name: string): SourceConfig => ({ name, type: "rss", url: `https://feed.test/${name}` });

describe("d-community-monitor: RSS 파서", () => {
  it("CDATA·엔티티·빠진 필드를 처리한다", () => {
    const items = parseRss(FIXTURE);
    assert.equal(items.length, 2, "제목·링크가 모두 없는 항목은 버린다");
    assert.equal(items[0].title, "소상공인 <단골> 관리 & 쿠폰");
    assert.equal(items[0].link, "https://example.com/a?x=1&y=2");
    assert.equal(items[0].publishedAt, "2026-11-23T01:00:00.000Z");
    assert.equal(items[0].description, '배달수수료 "부담" 한국일보');
    assert.equal(items[1].title, '사장님 리뷰 로그 "관리"');
    assert.equal(items[1].publishedAt, null);
    assert.equal(items[1].description, "");
  });

  it("최대 개수 제한과 숫자 엔티티", () => {
    assert.equal(parseRss(rssWith([1, 2, 3].map((n) => ({ title: `t${n}`, link: `l${n}` }))), 2).length, 2);
    assert.equal(decodeEntities("&#x1F600;&amp;&unknown;"), "😀&&unknown;");
  });
});

describe("d-community-monitor: collect", () => {
  it("두 번 수집하면 링크·제목 기준으로 중복을 거른다", async () => {
    const ctx = createTestContext();
    let round = 0;
    const fetcher: TextFetcher = async () => {
      round += 1;
      return round === 1
        ? rssWith([{ title: "가", link: "https://n/1" }, { title: "나", link: "https://n/2" }])
        : rssWith([
            { title: "가", link: "https://n/1" },
            { title: "나 ", link: "https://n/2-다른링크" },
            { title: "다", link: "https://n/3" },
          ]);
    };
    const first = await collect(ctx, { sources: [rssSource("s")], fetcher, now: NOW });
    const second = await collect(ctx, { sources: [rssSource("s")], fetcher, now: NOW });
    assert.equal(first[0].added, 2);
    assert.deepEqual([second[0].added, second[0].duplicates], [1, 2]);
    assert.deepEqual(readItems(ctx).map((item) => item.title), ["가", "나", "다"]);
  });

  it("실패한 소스는 건너뛰고 failed 지표를 남긴다", async () => {
    const ctx = createTestContext();
    const fetcher: TextFetcher = async (url) => {
      if (url.endsWith("bad")) throw new Error("timeout");
      if (url.endsWith("html")) return "<html>차단 페이지</html>";
      return rssWith([{ title: "정상 글", link: "https://n/ok" }]);
    };
    const results = await collect(ctx, {
      sources: [rssSource("bad"), rssSource("html"), rssSource("good"), { name: "샘플", type: "sample-file", path: "community-sample.json" }],
      fetcher,
      now: NOW,
    });
    assert.match(results[0].error ?? "", /timeout/);
    assert.match(results[1].error ?? "", /RSS/);
    assert.equal(results[2].added, 1);
    assert.ok(results[3].added >= 5);
    const items = readItems(ctx);
    assert.ok(items.filter((item) => item.sourceName === "샘플").every((item) => item.isSample));
    assert.equal(items.find((item) => item.title === "정상 글")?.isSample, false);
    const failed = ctx.metrics.all().filter((event) => event.name === EVENTS.failed);
    assert.deepEqual(failed.map((event) => event.meta?.source), ["bad", "html"]);
  });
});

describe("d-community-monitor: 키워드", () => {
  it("1글자·불용어를 버리고 조사를 뗀다", () => {
    assert.deepEqual(tokenize("[기자] 올해 소상공인을 위한 AI 마케팅 지원, 꼭 3번!"), ["소상공인", "ai", "마케팅"]);
  });

  it("Google 뉴스 제목의 언론사명은 집계에서 뺀다", () => {
    const item = { id: "x", sourceName: "s", title: "사장님 쿠폰팩 출시 - 한국경제", link: "l", publishedAt: "", collectedAt: "", snippet: "사장님 쿠폰팩 출시 한국경제", isSample: false };
    assert.equal(itemText(item), "사장님 쿠폰팩 출시");
  });

  it("글 수 기준으로 센다 (한 글에 여러 번 나와도 1)", () => {
    const texts = ["배달수수료 배달수수료 인상", "배달수수료 부담에 폐업", "단골 쿠폰"];
    assert.deepEqual(countKeywords(texts, 2), [
      { keyword: "배달수수료", itemCount: 2 },
      { keyword: "단골", itemCount: 1 },
    ]);
    const watch = countWatchKeywords(texts, ["배달수수료", "AI", "쿠폰"]);
    assert.deepEqual(watch.map((k) => [k.keyword, k.itemCount]), [["배달수수료", 2], ["쿠폰", 1], ["AI", 0]]);
  });
});

async function seed(ctx: ReturnType<typeof createTestContext>): Promise<void> {
  const fetcher: TextFetcher = async () =>
    rssWith([
      { title: "배달수수료 인상에 자영업자 부담", link: "https://n/fee" },
      { title: "동네 가게 단골 쿠폰 앱 확산", link: "https://n/coupon" },
    ]);
  await collect(ctx, {
    sources: [rssSource("news"), { name: "샘플", type: "sample-file", path: "community-sample.json" }],
    fetcher,
    now: NOW,
  });
}

describe("d-community-monitor: analyze", () => {
  it("mock LLM 결과로 리포트와 A용 전달 파일을 쓴다", async () => {
    const ctx = createTestContext(() =>
      JSON.stringify({
        themes: [{ title: "배달 비용 부담", whyItMatters: "마진이 줄어든다", evidence: [1, 99] }],
        painPoints: [{ text: "수수료가 너무 높다", evidence: ["1"] }, { text: "근거 없는 주장", evidence: [] }],
        contentIdeas: [
          { title: "배달수수료 줄이는 포장 할인 가이드", reason: "수수료 부담 기사", evidence: [1] },
          { title: "샘플만 근거인 글감", reason: "샘플 글", evidence: [3] },
        ],
        salesAngles: [{ text: "단골 쿠폰 자동화로 재방문 유도", evidence: [2] }],
      }),
    );
    await seed(ctx);
    const result = await analyze(ctx, { days: 7, now: NOW, watchKeywords: ["배달수수료", "쿠폰"] });

    assert.equal(result.analysis.droppedUnsupported, 1);
    assert.equal(result.analysis.themes[0].evidence.length, 1, "범위 밖 번호(99)는 버린다");
    assert.match(result.reportFile, /reports\/2026-11-23\.md$/);
    assert.equal(latestReport(ctx)?.summary?.itemCount, 12);
    const markdown = readFileSync(result.reportPath, "utf8");
    for (const heading of ["상위 키워드", "주요 테마", "사장님 고민", "콘텐츠 아이디어", "영업 포인트", "수집 소스별", "샘플 데이터 안내"]) {
      assert.ok(markdown.includes(heading), heading);
    }
    assert.ok(markdown.includes("[배달수수료 인상에 자영업자 부담](https://n/fee)"));

    const handoff = readTopicHandoff(ctx.store);
    assert.ok(handoff);
    assert.equal(handoff.topics.length, 2);
    assert.deepEqual(handoff.topics[0].sourceLinks, ["https://n/fee"]);
    assert.match(handoff.topics[1].reason, /샘플/);
    assert.equal(ctx.metrics.all().filter((event) => event.name === EVENTS.generated).length, 1);
    // 프롬프트에 샘플 표시가 들어간다
    assert.match(ctx.llm.calls[0].user, /\(샘플\)/);
  });

  it("LLM이 JSON이 아닌 응답을 주면 failed 지표를 남기고 실패한다", async () => {
    const ctx = createTestContext(() => "죄송하지만 분석할 수 없습니다.");
    await seed(ctx);
    await assert.rejects(analyze(ctx, { now: NOW, watchKeywords: [] }), /JSON/);
    const events = ctx.metrics.all();
    assert.equal(events.filter((event) => event.name === EVENTS.failed).length, 1);
    assert.equal(readTopicHandoff(ctx.store), null);
  });

  it("배열 필드가 빠진 JSON도 실패로 본다", () => {
    assert.throws(() => normalizeAnalysis({ themes: [] }, []), /painPoints/);
  });

  it("최근 글이 없으면 LLM을 부르지 않는다", async () => {
    const ctx = createTestContext();
    await assert.rejects(analyze(ctx, { now: NOW, watchKeywords: [] }), /collect/);
    assert.equal(ctx.llm.calls.length, 0);
  });
});
