import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVENTS } from "../src/shared/metrics.ts";
import {
  approveBrief,
  createBrief,
  createBriefsFromFile,
  listBriefs,
  recordMeeting,
  rejectBrief,
  slugify,
  validateBrief,
} from "../src/prototypes/c-sales-brief/brief.ts";
import { runCli } from "../src/prototypes/c-sales-brief/cli.ts";
import { type FetchResult, type PageFetcher, htmlToText, toResult } from "../src/prototypes/c-sales-brief/fetcher.ts";
import { createTestContext } from "./helpers.ts";

const VALID_BRIEF = {
  summary: "동네 카페입니다.",
  facts: ["시그니처 라떼를 판매한다"],
  assumptions: ["추정: 재방문 고객 관리가 수기일 수 있다"],
  painPoints: ["단골 관리"],
  pitchAngle: "단골 쿠폰으로 재방문 유도",
  recommendedOffering: "쿠핀 ON",
  proposalDraft: "### 제안\n안녕하세요, 알에스팀입니다.",
  meetingQuestions: ["현재 쿠폰은 어떻게 운영하시나요?"],
};

class FakeFetcher implements PageFetcher {
  readonly urls: string[] = [];
  private readonly result: (url: string) => FetchResult;

  constructor(result: (url: string) => FetchResult) {
    this.result = result;
  }

  async fetchPage(url: string): Promise<FetchResult> {
    this.urls.push(url);
    return this.result(url);
  }
}

const okFetcher = () =>
  new FakeFetcher((url) => toResult(url, "<html><head><title>달빛카페</title></head><body><p>시그니처 라떼</p></body></html>"));
const validLlm = () => JSON.stringify(VALID_BRIEF);

describe("c-sales-brief: htmlToText", () => {
  it("script·style·주석·태그를 걷어내고 엔티티를 풀며 title을 따로 뽑는다", () => {
    const html = `<html><head><title> 달빛 &amp; 카페 </title><meta name="description" content="동네 카페"><style>p{color:red}</style></head>
      <body><script>alert("x")</script><!-- 숨김 --><nav>메뉴</nav><p>라떼&nbsp;5,000원</p><div>영업 &lt;10시&gt;</div></body></html>`;
    const { title, text } = htmlToText(html);
    assert.equal(title, "달빛 & 카페");
    assert.ok(text.includes("설명: 동네 카페"));
    assert.ok(text.includes("라떼 5,000원"));
    assert.ok(text.includes("영업 <10시>"));
    assert.ok(!/alert|color:red|숨김|<p>/.test(text));
  });

  it("본문이 없으면 실패, 길면 6000자로 자른다", () => {
    assert.equal(toResult("u", "<script>render()</script>").ok, false);
    const long = toResult("u", `<p>${"가".repeat(7000)}</p>`);
    assert.ok(long.ok && long.truncated && long.text.length === 6000);
  });

  it("slug는 한글을 유지한다", () => {
    assert.equal(slugify("[예시] 성수동 베이커리!"), "예시-성수동-베이커리");
  });
});

describe("c-sales-brief: brief", () => {
  it("브리프 파일 + 승인 대기 + generated 지표를 만든다", async () => {
    const ctx = createTestContext(validLlm);
    const fetcher = okFetcher();
    const result = await createBrief(ctx, { name: "달빛 카페", url: "https://example.com", notes: "사장님 직접 운영" }, { fetcher });

    assert.deepEqual(fetcher.urls, ["https://example.com"]);
    assert.ok(ctx.llm.calls[0].user.includes("시그니처 라떼"), "수집한 페이지 내용이 프롬프트에 들어간다");
    assert.ok(ctx.llm.calls[0].user.includes("쿠핀 ON"), "우리 서비스 정보가 프롬프트에 들어간다");

    assert.equal(result.slug, "달빛-카페");
    const markdown = readFileSync(result.filePath, "utf8");
    assert.ok(result.filePath.endsWith(join("c-sales-brief", "briefs", "달빛-카페.md")));
    for (const section of ["대상 요약", "확인된 사실", "추정(검증 필요)", "예상 고민", "제안 각도", "추천 서비스", "제안서 초안", "미팅 질문", "수집 정보 출처/실패 사유"]) {
      assert.ok(markdown.includes(`## ${section}`), section);
    }
    assert.ok(markdown.includes("수집 결과: 성공"));

    const [item] = listBriefs(ctx, "pending");
    assert.equal(item.id, result.approval.id);
    assert.equal(item.kind, "sales-proposal");
    assert.deepEqual(
      { slug: item.meta.slug, target: item.meta.target, url: item.meta.url },
      { slug: "달빛-카페", target: "달빛 카페", url: "https://example.com" },
    );
    const events = ctx.metrics.all();
    assert.equal(events.length, 1);
    assert.equal(events[0].name, EVENTS.generated);
    assert.equal(events[0].prototype, "c-sales-brief");

    // 같은 이름은 파일을 덮어쓰지 않는다
    const second = await createBrief(ctx, { name: "달빛 카페" }, { fetcher });
    assert.equal(second.slug, "달빛-카페-2");
  });

  it("수집 실패해도 브리프를 만들고 실패 사유를 남긴다", async () => {
    const ctx = createTestContext(validLlm);
    const fetcher = new FakeFetcher((url) => ({ ok: false, url, reason: "10초 안에 응답이 없어 중단했습니다." }));
    const result = await createBrief(ctx, { name: "느린 가게", url: "https://slow.example" }, { fetcher });

    assert.ok(ctx.llm.calls[0].user.includes("페이지 수집 실패"));
    const markdown = readFileSync(result.filePath, "utf8");
    assert.ok(markdown.includes("수집 결과: **실패** — 10초 안에 응답이 없어 중단했습니다."));
    assert.equal(ctx.metrics.all()[0].name, EVENTS.generated);
  });

  it("LLM 응답이 JSON이 아니거나 필드가 빠지면 failed 지표 + 예외, 파일·승인 없음", async () => {
    const ctx = createTestContext(() => "죄송하지만 JSON을 만들 수 없습니다.");
    await assert.rejects(createBrief(ctx, { name: "가게" }, { fetcher: okFetcher() }), /JSON/);
    const missing = createTestContext(() => JSON.stringify({ ...VALID_BRIEF, proposalDraft: "" }));
    await assert.rejects(createBrief(missing, { name: "가게" }, { fetcher: okFetcher() }), /proposalDraft/);

    for (const c of [ctx, missing]) {
      assert.deepEqual(c.metrics.all().map((e) => e.name), [EVENTS.failed]);
      assert.equal(listBriefs(c).length, 0);
      assert.equal(existsSync(c.store.path("c-sales-brief", "briefs")), false);
    }
  });

  it("validateBrief는 배열 타입도 검사한다", () => {
    assert.throws(() => validateBrief({ ...VALID_BRIEF, facts: "문자열" }), /facts/);
    assert.equal(validateBrief({ ...VALID_BRIEF, facts: [] }).facts.length, 0);
  });
});

describe("c-sales-brief: 검토 흐름", () => {
  it("승인 → 미팅 기록, 반려·대기 항목은 미팅 불가, 중복 미팅 불가", async () => {
    const ctx = createTestContext(validLlm);
    const deps = { fetcher: okFetcher() };
    const a = await createBrief(ctx, { name: "A 가게" }, deps);
    const b = await createBrief(ctx, { name: "B 가게" }, deps);
    const c = await createBrief(ctx, { name: "C 가게" }, deps);

    assert.throws(() => recordMeeting(ctx, c.approval.id), /승인된 브리프만/);
    approveBrief(ctx, a.approval.id);
    rejectBrief(ctx, b.approval.id, "타깃 아님");
    assert.throws(() => recordMeeting(ctx, b.approval.id), /승인된 브리프만/);
    recordMeeting(ctx, a.approval.id);
    assert.throws(() => recordMeeting(ctx, a.approval.id), /이미 미팅/);
    assert.throws(() => approveBrief(ctx, a.approval.id), /이미 처리/);

    assert.equal(ctx.approvals.get(b.approval.id).note, "타깃 아님");
    const names = ctx.metrics.all().map((e) => e.name);
    assert.equal(names.filter((n) => n === EVENTS.approved).length, 1);
    assert.equal(names.filter((n) => n === EVENTS.rejected).length, 1);
    const meeting = ctx.metrics.all().find((e) => e.name === EVENTS.meetingBooked);
    assert.equal(meeting?.meta?.approvalId, a.approval.id);
  });

  it("다른 프로토타입의 승인 항목은 다루지 않는다", () => {
    const ctx = createTestContext();
    const other = ctx.approvals.submit({ prototype: "a-content", kind: "blog-post", title: "t", body: "b" });
    assert.throws(() => approveBrief(ctx, other.id), /영업 브리프 항목이 아닙니다/);
  });
});

describe("c-sales-brief: 일괄 처리와 CLI", () => {
  it("대상 파일을 차례로 처리하고 실패한 대상만 따로 보고한다", async () => {
    let call = 0;
    const ctx = createTestContext(() => (++call === 2 ? "깨진 응답" : validLlm()));
    const file = ctx.store.path("targets.json");
    writeFileSync(file, JSON.stringify([{ name: "첫째", url: "https://a.example" }, { name: "둘째" }, { name: "셋째", url: "" }]));
    const fetcher = okFetcher();
    const outcomes = await createBriefsFromFile(ctx, file, { fetcher });

    assert.deepEqual(outcomes.map((o) => [o.target, Boolean(o.result)]), [["첫째", true], ["둘째", false], ["셋째", true]]);
    assert.deepEqual(fetcher.urls, ["https://a.example"], "빈 url 은 수집하지 않는다");
    assert.equal(listBriefs(ctx, "pending").length, 2);
  });

  it("샘플 targets.json 을 읽을 수 있다", async () => {
    const ctx = createTestContext(validLlm);
    const outcomes = await createBriefsFromFile(ctx, "src/prototypes/c-sales-brief/samples/targets.json", { fetcher: okFetcher() });
    assert.ok(outcomes.length >= 2 && outcomes.every((o) => o.result));
  });

  it("CLI: brief → review → approve → meeting, 잘못된 입력은 예외", async () => {
    const ctx = createTestContext(validLlm);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const fetcher = okFetcher();

    await runCli(["brief", "--name", "달빛 카페", "--industry", "카페"], ctx, fetcher, log);
    const [item] = listBriefs(ctx, "pending");
    await runCli(["review"], ctx, fetcher, log);
    assert.ok(lines.some((line) => line.includes(item.id)));
    await assert.rejects(runCli(["meeting", item.id], ctx, fetcher, log), /승인된 브리프만/);
    await runCli(["approve", item.id], ctx, fetcher, log);
    await runCli(["meeting", item.id], ctx, fetcher, log);
    assert.ok(ctx.metrics.all().some((e) => e.name === EVENTS.meetingBooked));

    await assert.rejects(runCli(["brief"], ctx, fetcher, log), /--name/);
    await assert.rejects(runCli(["approve"], ctx, fetcher, log), /id/);
    await assert.rejects(runCli(["unknown"], ctx, fetcher, log), /알 수 없는 명령/);
  });
});
