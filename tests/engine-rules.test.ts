import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Subject } from "../src/engine/domain.ts";
import { parsePlaybook } from "../src/engine/playbook.ts";
import {
  applyAdvertisingNotice,
  earliestSendTime,
  firstFailedCondition,
  isNightInKorea,
  nextDaytimeInKorea,
  validateContent,
} from "../src/engine/rules.ts";
import type { ServiceConfig } from "../src/engine/services.ts";
import { InputError } from "../src/engine/input.ts";

const service: ServiceConfig = {
  id: "svc",
  name: "테스트 서비스",
  type: "b2c",
  brand: { name: "테스트", tone: "존댓말", senderName: "운영팀", landingUrl: "https://example.com" },
  optOutText: "수신거부: 앱 설정",
  bannedWords: ["공짜"],
  maxAdsPerSubjectPerWeek: 2,
  webhookSecret: "x".repeat(16),
  adapter: { type: "fixture", file: "unused" },
  delivery: { type: "dry-run" },
};

const subject: Subject = {
  id: "s1",
  displayName: "지민",
  contacts: { push: "token" },
  consents: { marketing: { ref: "c1", grantedAt: "2026-01-01T00:00:00Z" }, nightMarketing: null },
  facts: { purchaseCount: 0, region: "광주" },
};

const event = { id: "e1", service: "svc", type: "t", subjectId: "s1", occurredAt: "2026-11-24T00:00:00Z", payload: { daysLeft: 7 } };

describe("야간 광고 제한 (KST 21~08시)", () => {
  it("한국 시각 기준으로 야간을 판단한다", () => {
    assert.equal(isNightInKorea(new Date("2026-11-24T11:59:00Z")), false); // 20:59 KST
    assert.equal(isNightInKorea(new Date("2026-11-24T12:00:00Z")), true); // 21:00 KST
    assert.equal(isNightInKorea(new Date("2026-11-24T22:59:00Z")), true); // 07:59 KST
    assert.equal(isNightInKorea(new Date("2026-11-24T23:00:00Z")), false); // 08:00 KST
  });

  it("야간이면 다음 오전 8시(KST)로 미룬다", () => {
    assert.equal(nextDaytimeInKorea(new Date("2026-11-24T13:00:00Z")).toISOString(), "2026-11-24T23:00:00.000Z"); // 22시 → 다음 날 8시
    assert.equal(nextDaytimeInKorea(new Date("2026-11-24T17:00:00Z")).toISOString(), "2026-11-24T23:00:00.000Z"); // 새벽 2시 → 당일 8시
    assert.equal(nextDaytimeInKorea(new Date("2026-11-24T03:00:00Z")).toISOString(), "2026-11-24T03:00:00.000Z");
  });

  it("야간 별도 동의가 있거나 정보성이면 미루지 않는다", () => {
    const night = new Date("2026-11-24T13:00:00Z");
    assert.equal(earliestSendTime(night, false, subject), night);
    const consented = { ...subject, consents: { ...subject.consents, nightMarketing: { ref: "n1", grantedAt: "2026-01-01T00:00:00Z" } } };
    assert.equal(earliestSendTime(night, true, consented), night);
    assert.notEqual(earliestSendTime(night, true, subject), night);
  });
});

describe("조건 판단", () => {
  it("subject·event 값을 비교하고 실패 사유를 남긴다", () => {
    assert.equal(firstFailedCondition([{ fact: "subject.purchaseCount", op: "eq", value: 0 }, { fact: "event.daysLeft", op: "in", value: [30, 7, 1] }], subject, event), null);
    const reason = firstFailedCondition([{ fact: "subject.purchaseCount", op: "gte", value: 1 }], subject, event);
    assert.match(reason ?? "", /^condition_failed:subject.purchaseCount gte 1 \(실제 0\)/);
    assert.notEqual(firstFailedCondition([{ fact: "subject.unknown", op: "exists" }], subject, event), null);
    assert.equal(firstFailedCondition([{ fact: "subject.unknown", op: "missing" }], subject, event), null);
  });
});

describe("문구 검증", () => {
  const rules = { title: { maxLength: 10 }, body: { maxLength: 50 } };
  const ctx = { service, inputText: "쿠폰 가격 4500 원, 동네 광주", checkNumbers: true };

  it("규칙을 지킨 문구는 통과한다", () => {
    assert.deepEqual(validateContent({ title: "동네 쿠폰", body: "광주 동네 쿠폰을 4,500원에 만나 보세요." }, rules, ctx), []);
  });

  it("지어낸 숫자, 한자, 금지어, 남의 링크, 길이 초과를 잡는다", () => {
    const issues = validateContent(
      { title: "아주아주아주긴제목입니다", body: "매출 30% 증가! 공짜 혜택 핵심卖点 https://evil.example 무조건" },
      rules,
      ctx,
    );
    const text = issues.join("\n");
    for (const expected of ["10자를 넘습니다", '입력에 없는 숫자 "30', "한자", '"공짜"', '"무조건"', "허용되지 않은 링크"]) {
      assert.match(text, new RegExp(expected));
    }
  });

  it("(광고) 표기를 모델이 직접 쓰면 막는다 (엔진이 붙임)", () => {
    assert.match(validateContent({ title: "제목", body: "(광고) 쿠폰" }, rules, ctx).join(), /엔진이 붙이므로/);
  });

  it("광고 표기는 엔진이 앞뒤에 붙인다", () => {
    assert.deepEqual(applyAdvertisingNotice({ title: "새 쿠폰", body: "본문" }, service), {
      title: "(광고) 테스트 새 쿠폰",
      body: "본문\n\n수신거부: 앱 설정",
    });
    assert.equal(applyAdvertisingNotice({ body: "본문" }, service).body, "(광고) 테스트\n본문\n\n수신거부: 앱 설정");
  });
});

describe("플레이북 설정 검증", () => {
  const base = {
    id: "ad-test",
    service: "svc",
    name: "광고 테스트",
    enabled: true,
    trigger: { event: "x", delayMinutes: 0 },
    conditions: [],
    advertising: true,
    frequencyDays: 7,
    generation: { mode: "template", body: "안녕하세요", fields: { body: { maxLength: 50 } } },
    approval: "auto",
    channel: "push",
  };

  it("올바른 설정을 읽는다", () => {
    assert.equal(parsePlaybook(base, "pb").channel, "push");
  });

  it("광고를 알림톡으로 보내는 설정은 거부한다", () => {
    assert.throws(() => parsePlaybook({ ...base, channel: "alimtalk" }, "pb"), InputError);
  });

  it("잘못된 조건 형식은 경로와 함께 거부한다", () => {
    assert.throws(() => parsePlaybook({ ...base, conditions: [{ fact: "purchaseCount", op: "eq", value: 0 }] }, "pb"), /pb.conditions\[0\].fact/);
    assert.throws(() => parsePlaybook({ ...base, conditions: [{ fact: "subject.n", op: "gte", value: "1" }] }, "pb"), /숫자가 필요/);
  });
});
