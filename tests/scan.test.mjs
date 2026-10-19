import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivity, createActivityScan, consumeActivityPages, applyAccessResult, nextActivityRequest, applyActivityResult, recordActivityFailure,
  evaluateParticipants, MAX_PROFILE_PAGES } from "../public/lottery-core.js";

const post = { id: "aidevelop", type: "mgallery", no: "3524", url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524" };
const asOf = Date.parse("2026-10-15T12:00:00+09:00");
const context = { post, cutoff: 0, asOf };
const settings = { requirePublicGallog: true, activityMode: "separate", minPosts: 3, minComments: 1, minTotal: 0, periodUnit: "all", periodValue: 0 };
const entry = (id, no = 100 + id, ts = Date.parse("2026-09-01T00:00:00+09:00")) =>
  ({ id: String(id), ts, postNo: String(no), url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=" + no });
const page = (kind, number, entries, changes = {}) => ({ kind, page: number, visibility: "public", entries, nextPage: null, malformed: false,
  paginationKnown: true, boundary: false, fingerprint: kind + number, ...changes });
const person = { key: "p", name: "ㅇㅇ", exclusion: "", status: "pending" };
const verdict = (activity) => evaluateParticipants([person], new Map([["p", activity]]), settings, false)[0];

test("공개 확인 응답의 글·댓글 1페이지를 집계하고 끝 페이지면 범위 확인 완료", () => {
  const scan = createActivityScan(settings);
  const activity = createActivity();
  const consumed = applyAccessResult(scan, activity, { profileStatus: "public", pages: [page("post", 1, [entry(1), entry(2), entry(3)]), page("comment", 1, [entry(4)])] }, context);
  assert.deepEqual(consumed, { post: 1, comment: 1 });
  assert.equal(activity.count, 3);
  assert.equal(activity.comments, 1);
  assert.equal(activity.postsComplete, true);
  assert.equal(activity.commentsComplete, true);
  assert.equal(verdict({ ...activity, profileStatus: "public" }).status, "eligible");
  assert.equal(nextActivityRequest(scan, activity, settings), null);
});

test("공개 확인 응답이 글·댓글 두 목록을 갖추지 않으면 예외로 보류", () => {
  const scan = createActivityScan(settings);
  assert.throws(() => applyAccessResult(scan, createActivity(), { profileStatus: "public", pages: [page("post", 1, [])] }, context), /공개 여부를 확인할 수 없습니다/);
  assert.throws(() => applyAccessResult(scan, createActivity(), { profileStatus: "public", pages: [page("comment", 1, []), page("post", 1, [])] }, context));
  const hidden = createActivity();
  applyAccessResult(scan, hidden, { profileStatus: "private", unavailableReason: "갤로그 비공개 (댓글 목록)", pages: [] }, context);
  assert.equal(hidden.profileError, "갤로그 비공개 (댓글 목록)");
  assert.equal(verdict(hidden).status, "excluded");
});

test("다음 페이지가 있으면 부족한 목록을 번갈아 요청하고 기준을 채우면 멈춤", () => {
  const scan = createActivityScan(settings);
  const activity = createActivity();
  applyAccessResult(scan, activity, { profileStatus: "public", pages: [page("post", 1, [entry(1)], { nextPage: 2 }), page("comment", 1, [], { nextPage: 2 })] }, context);
  assert.equal(verdict({ ...activity, profileStatus: "public" }).status, "pending");
  assert.deepEqual(nextActivityRequest(scan, activity, settings), { kind: "post", startPage: 2, count: 3 });
  assert.deepEqual(nextActivityRequest(scan, activity, settings), { kind: "comment", startPage: 2, count: 3 });
  const outcome = applyActivityResult(scan, activity, "post", { profileStatus: "public", pages: [page("post", 2, [entry(2), entry(3)], { nextPage: 3 })] }, context);
  assert.equal(outcome.action, "continue");
  assert.equal(activity.count, 3);
  assert.equal(scan.states.post.nextPage, 3);
  assert.deepEqual(nextActivityRequest(scan, activity, settings), { kind: "comment", startPage: 2, count: 3 }, "Posts already meet the threshold");
});

test("기간 경계·반복 페이지·불완전 정보·다른 갤러리 기록을 구분해 완료 또는 보류", () => {
  const bounded = createActivityScan(settings);
  const a = createActivity();
  consumeActivityPages(bounded, a, [page("post", 1, [], { nextPage: 2, boundary: true })], context);
  assert.equal(a.postsComplete, true, "Every row older than the cutoff completes the list");
  const repeated = createActivityScan(settings);
  const b = createActivity();
  consumeActivityPages(repeated, b, [page("post", 1, [entry(1)], { nextPage: 2, fingerprint: "same" }), page("post", 2, [entry(2)], { nextPage: 3, fingerprint: "same" })], context);
  assert.match(b.postError, /반복/);
  assert.equal(b.count, 1);
  const malformed = createActivityScan(settings);
  const c = createActivity();
  consumeActivityPages(malformed, c, [page("post", 1, [], { malformed: true, paginationKnown: true })], context);
  assert.equal(c.postsComplete, false);
  assert.match(c.postError, /불완전/);
  const unknownPaging = createActivityScan(settings);
  const d = createActivity();
  consumeActivityPages(unknownPaging, d, [page("post", 1, [], { paginationKnown: false })], context);
  assert.equal(d.postsComplete, false);
  assert.equal(verdict({ ...d, comments: 1, profileStatus: "public", commentsComplete: true }).status, "pending", "Unknown paging holds instead of excluding");
  assert.throws(() => consumeActivityPages(createActivityScan(settings), createActivity(), [page("post", 1, [{ ...entry(1), url: entry(1).url.replace("aidevelop", "other") }])], context), /활동 기록을 확인할 수 없습니다/);
  assert.throws(() => consumeActivityPages(createActivityScan(settings), createActivity(), [page("post", 1, [entry(1, 3524)])], context), "The raffle post itself never counts");
  assert.throws(() => consumeActivityPages(createActivityScan(settings), createActivity(), [page("post", 2, [])], context), /페이지 정보/);
  const unavailable = createActivityScan(settings);
  const e = createActivity();
  consumeActivityPages(unavailable, e, [page("post", 1, [], { unavailableReason: "목록 형식이 다름" })], context);
  assert.equal(e.postError, "목록 형식이 다름");
  assert.equal(unavailable.states.post.nextPage, null);
});

test("일시 오류는 재시도 신호로, 재시도가 끝나면 해당 목록을 보류로 기록", () => {
  const scan = createActivityScan(settings);
  const activity = createActivity();
  applyAccessResult(scan, activity, { profileStatus: "public", pages: [page("post", 1, [entry(1)], { nextPage: 2 }), page("comment", 1, [entry(9)])] }, context);
  const failed = { profileStatus: "unknown", pages: [], error: "갤로그 응답 시간이 초과되었습니다.", retryable: true };
  assert.equal(applyActivityResult(scan, activity, "post", failed, context, { canRetry: true }).action, "retry");
  assert.equal(scan.states.post.nextPage, 2, "A retry keeps the position");
  const partial = { profileStatus: "unknown", pages: [page("post", 2, [entry(2)], { nextPage: 3 })], error: "갤로그 접근 오류로 확인을 보류합니다.", retryable: true };
  assert.equal(applyActivityResult(scan, activity, "post", partial, context, { canRetry: true }).action, "retry");
  assert.equal(activity.count, 2);
  assert.equal(scan.states.post.nextPage, 3, "Pages read before the error are kept");
  assert.equal(applyActivityResult(scan, activity, "post", failed, context, { canRetry: false }).action, "continue");
  assert.equal(activity.postError, "갤로그 응답 시간이 초과되었습니다.");
  assert.equal(verdict({ ...activity, profileStatus: "public" }).status, "pending");
  assert.equal(applyActivityResult(scan, activity, "comment", { profileStatus: "private", unavailableReason: "비공개", pages: [] }, context).action, "stop");
  assert.equal(activity.profileStatus, "private");
});

test("2,000페이지 제한과 실패 기록은 제외가 아닌 미확인으로 남김", () => {
  const scan = createActivityScan(settings);
  const activity = createActivity();
  scan.states.post.nextPage = MAX_PROFILE_PAGES + 1;
  scan.states.comment.nextPage = null;
  assert.equal(nextActivityRequest(scan, activity, settings), null);
  assert.match(activity.postError, /2,000페이지/);
  const unchecked = createActivity();
  recordActivityFailure(unchecked, "네트워크 오류");
  assert.equal(unchecked.profileStatus, "unknown");
  assert.equal(verdict(unchecked).status, "pending");
  const readable = { ...createActivity(), profileStatus: "public" };
  recordActivityFailure(readable, "갤로그 오류");
  assert.equal(readable.postError, "갤로그 오류");
  assert.equal(verdict(readable).status, "pending");
});
