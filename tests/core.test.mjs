import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyApiFailure, retryBackoffMs } from "../public/lottery-core.js";

test("API 실패 분류: 네트워크·시간 초과·비JSON·5xx는 재시도, 4xx·형식 오류는 중단", () => {
  assert.deepEqual([classifyApiFailure({ networkError: true })].map(({ kind, retryable }) => [kind, retryable]), [["network", true]]);
  assert.equal(classifyApiFailure({ status: 504, parseError: true }).kind, "timeout");
  assert.equal(classifyApiFailure({ status: 504, parseError: true }).retryable, true);
  assert.equal(classifyApiFailure({ status: 200, parseError: true }).retryable, true);
  assert.equal(classifyApiFailure({ status: 404, parseError: true }).retryable, false);
  for (const status of [502, 503]) assert.equal(classifyApiFailure({ status, body: { error: "x" } }).retryable, true);
  assert.equal(classifyApiFailure({ status: 502, body: { error: "삭제된 글", retryable: false } }).retryable, false);
  assert.equal(classifyApiFailure({ status: 502, body: { error: "삭제된 글", retryable: false } }).message, "삭제된 글");
  assert.equal(classifyApiFailure({ status: 503, body: { errorKind: "time_budget" } }).kind, "time_budget");
  assert.equal(classifyApiFailure({ status: 400, body: { error: "형식" } }).retryable, false);
  const limited = classifyApiFailure({ status: 429, body: { error: "많음" }, retryAfter: "17" });
  assert.equal(limited.kind, "rate_limit");
  assert.equal(limited.retryAfterMs, 17_000);
  assert.match(limited.message, /17초/);
  assert.equal(classifyApiFailure({ status: 429 }).retryAfterMs, 60_000);
  const blocked = classifyApiFailure({ status: 503, body: { errorKind: "upstream_blocked", retryAfter: 90 } });
  assert.equal(blocked.kind, "upstream_blocked");
  assert.equal(blocked.retryAfterMs, 90_000);
  assert.equal(classifyApiFailure({ status: 403, body: { errorKind: "forbidden_origin", error: "출처" } }).kind, "forbidden");
});

test("재시도 대기 시간은 지수적으로 늘고 상한이 있음", () => {
  assert.equal(retryBackoffMs(1, () => 0), 1200);
  assert.equal(retryBackoffMs(2, () => 0), 2400);
  assert.equal(retryBackoffMs(9, () => 0), 6000);
  assert.ok(retryBackoffMs(1, () => 0.99) < 1600);
});

test("명단 해시는 수집·선택 순서와 무관하고 명단·설정이 바뀌면 달라짐", async () => {
  const { rosterCanonical, sha256Hex, shortFingerprint } = await import("../public/lottery-core.js");
  const { createHash, webcrypto } = await import("node:crypto");
  const post = { url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524" };
  const settings = { periodUnit: "months", periodValue: 6, activityMode: "separate", minPosts: 3, minComments: 0, minTotal: 5, winnerCount: 2 };
  const asOf = Date.parse("2026-10-15T12:00:00+09:00");
  const cutoff = Date.parse("2026-04-15T00:00:00+09:00");
  const people = [
    { identityCode: "beta", firstCommentId: "12", status: "eligible", included: true },
    { identityCode: "alpha", firstCommentId: "7", status: "eligible", included: true },
    { identityCode: "gamma", firstCommentId: "3", status: "eligible", included: false, manuallyExcluded: true },
    { identityCode: "delta", firstCommentId: "9", status: "excluded" },
  ];
  const canonical = rosterCanonical({ post, settings, participants: people, cutoff, asOf });
  assert.equal(canonical, rosterCanonical({ post, settings, participants: [...people].reverse(), cutoff, asOf }));
  const parsed = JSON.parse(canonical);
  assert.deepEqual(parsed.roster, [["alpha", "7", "not-checked", "not-checked"], ["beta", "12", "not-checked", "not-checked"]]);
  assert.deepEqual(parsed.overrides, []);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.criteria, { mode: "separate", minPosts: 3, minComments: 0, minTotal: 0, privateList: "visible-only" }, "Only the active mode's thresholds count");
  assert.equal(parsed.period.from, "2026-04-14T15:00:00.000Z");
  const hash = await sha256Hex(canonical, webcrypto.subtle);
  assert.equal(hash, createHash("sha256").update(canonical, "utf8").digest("hex"));
  assert.equal(shortFingerprint(hash), hash.slice(0, 4) + "-" + hash.slice(4, 8) + "-" + hash.slice(8, 12));
  const variants = [
    rosterCanonical({ post, settings, participants: people.slice(1), cutoff, asOf }),
    rosterCanonical({ post, settings, participants: people, cutoff, asOf, winnerCount: 1 }),
    rosterCanonical({ post, settings: { ...settings, minPosts: 4 }, participants: people, cutoff, asOf }),
    rosterCanonical({ post: { url: post.url.replace("3524", "3525") }, settings, participants: people, cutoff, asOf }),
    rosterCanonical({ post, settings: { ...settings, periodUnit: "all" }, participants: people, cutoff: 0, asOf }),
  ];
  for (const variant of variants) assert.notEqual(await sha256Hex(variant, webcrypto.subtle), hash);
});
