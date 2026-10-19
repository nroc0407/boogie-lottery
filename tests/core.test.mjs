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
