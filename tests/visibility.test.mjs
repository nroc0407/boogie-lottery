import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createActivity, createActivityScan, applyAccessResult, nextActivityRequest, applyActivityResult, evaluateParticipants,
  profileVisibilityLabel, verdictCategory, parsePostUrl } from "../public/lottery-core.js";
import activityHandler, { parseProfileActivity } from "../api/comment-activity.js";
import { parseComments } from "../api/comments.js";
import { resetServerState } from "../lib/dcinside.js";

const post = { id: "aidevelop", type: "mgallery", no: "3524", url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524" };
const asOf = Date.parse("2026-10-15T12:00:00+09:00");
const context = { post, cutoff: 0, asOf };
const separate = (minPosts, minComments) => ({ requirePublicGallog: true, activityMode: "separate", minPosts, minComments, minTotal: 0, periodUnit: "all", periodValue: 0 });
const total = (minTotal) => ({ requirePublicGallog: true, activityMode: "total", minPosts: 0, minComments: 0, minTotal, periodUnit: "all", periodValue: 0 });
const entry = (id, no = 100 + id) => ({ id: String(id), ts: Date.parse("2026-09-01T00:00:00+09:00"), postNo: String(no),
  url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=" + no });
const page = (kind, number, entries, changes = {}) => ({ kind, page: number, visibility: "public", entries, nextPage: null, malformed: false,
  paginationKnown: true, boundary: false, fingerprint: kind + number, ...changes });
const hidden = (kind) => ({ kind, page: 1, visibility: "private", entries: [], nextPage: null, malformed: false, paginationKnown: true, boundary: false,
  fingerprint: "private", unavailableReason: "갤로그 비공개 (" + (kind === "post" ? "글" : "댓글") + " 목록)" });
const person = { key: "p", name: "ㅇㅇ", exclusion: "", status: "pending" };

// Runs the access check the way the browser does and returns the verdict.
function access(settings, response) {
  const scan = createActivityScan(settings);
  const activity = createActivity();
  applyAccessResult(scan, activity, response, context);
  return { scan, activity, verdict: evaluateParticipants([person], new Map([["p", activity]]), settings, false)[0] };
}

test("최소 글·댓글: 댓글 목록만 비공개면 글 목록만으로 통과하고 더 조회하지 않음", () => {
  const settings = separate(3, 0);
  const { scan, activity, verdict } = access(settings, { profileStatus: "public", listVisibility: { post: "public", comment: "private" },
    pages: [page("post", 1, [entry(1), entry(2), entry(3)]), hidden("comment")] });
  assert.equal(verdict.status, "eligible");
  assert.match(verdict.reason, /활동 기준 충족/);
  assert.match(verdict.reason, /댓글 목록 비공개 — 글 목록만으로 판정/);
  assert.deepEqual(verdict.listVisibility, { post: "public", comment: "private" });
  assert.equal(verdict.activityCommentCount, 0);
  assert.equal(nextActivityRequest(scan, activity, settings), null);
  assert.equal(profileVisibilityLabel(verdict), "글 공개 · 댓글 비공개");
});

test("최소 글·댓글: 비공개 쪽 기준이 1개 이상이면 그 목록이 비공개라는 사유로 기준 미달", () => {
  const posts = access(separate(3, 0), { profileStatus: "public", pages: [hidden("post"), page("comment", 1, [entry(9)])] });
  assert.equal(posts.verdict.status, "excluded");
  assert.equal(posts.verdict.reason, "글 목록 비공개로 작성글 기준 미달 (0/3개)");
  assert.equal(verdictCategory({ ...posts.verdict, automaticStatus: "excluded" })[0], "list-private");
  assert.equal(nextActivityRequest(posts.scan, posts.activity, separate(3, 0)), null, "A private list is never requested again");
  const comments = access(separate(1, 2), { profileStatus: "public", pages: [page("post", 1, [entry(1)]), hidden("comment")] });
  assert.equal(comments.verdict.status, "excluded");
  assert.equal(comments.verdict.reason, "댓글 목록 비공개로 작성댓글 기준 미달 (0/2개)");
  const open = access(separate(1, 0), { profileStatus: "public", pages: [page("post", 1, [entry(1)], { nextPage: 2 }), hidden("comment")] });
  assert.equal(open.verdict.status, "eligible", "Posts already meet the threshold on page 1");
});

test("글댓합: 공개된 목록의 합계만 세고 비공개 쪽은 0개", () => {
  const short = access(total(5), { profileStatus: "public", pages: [page("post", 1, [entry(1), entry(2), entry(3)]), hidden("comment")] });
  assert.equal(short.verdict.status, "excluded");
  assert.equal(short.verdict.reason, "글+댓글 합계 미달 (3/5개) · 댓글 목록 비공개 — 글 목록만으로 판정");
  const enough = access(total(3), { profileStatus: "public", pages: [hidden("post"), page("comment", 1, [entry(4), entry(5), entry(6)])] });
  assert.equal(enough.verdict.status, "eligible");
  assert.match(enough.verdict.reason, /글 목록 비공개 — 댓글 목록만으로 판정/);
  const more = access(total(5), { profileStatus: "public", pages: [page("post", 1, [entry(1)], { nextPage: 2 }), hidden("comment")] });
  assert.equal(more.verdict.status, "pending");
  assert.deepEqual(nextActivityRequest(more.scan, more.activity, total(5)), { kind: "post", startPage: 2, count: 3 }, "Only the visible list is read further");
  applyActivityResult(more.scan, more.activity, "post", { profileStatus: "public", pages: [page("post", 2, [entry(2), entry(3), entry(4), entry(5)])] }, context);
  assert.equal(evaluateParticipants([person], new Map([["p", more.activity]]), total(5), false)[0].status, "eligible");
});

test("글·댓글 모두 비공개면 갤로그 비공개로 제외, 일부공개+비공개는 일부공개 쪽으로 판정", () => {
  const both = access(separate(0, 0), { profileStatus: "private", unavailableReason: "갤로그 비공개 (글·댓글 모두)", listVisibility: { post: "private", comment: "private" }, pages: [] });
  assert.equal(both.verdict.status, "excluded");
  assert.equal(both.verdict.reason, "갤로그 비공개 (글·댓글 모두)");
  assert.equal(both.verdict.profileStatus, "private");
  assert.equal(profileVisibilityLabel(both.verdict), "비공개");
  assert.throws(() => access(separate(1, 0), { profileStatus: "public", pages: [hidden("post"), hidden("comment")] }), /공개 여부를 확인할 수 없습니다/,
    "A readable status cannot carry two private lists");
  const mixed = access(separate(1, 0), { profileStatus: "partial", pages: [page("post", 1, [entry(1)], { visibility: "partial" }), hidden("comment")] });
  assert.equal(mixed.verdict.status, "eligible");
  assert.equal(mixed.verdict.profileStatus, "partial");
  assert.deepEqual(mixed.verdict.listVisibility, { post: "partial", comment: "private" });
  assert.equal(profileVisibilityLabel(mixed.verdict), "글 일부공개 · 댓글 비공개");
  const none = access(separate(1, 0), { profileStatus: "partial", pages: [page("post", 1, [], { visibility: "partial" }), hidden("comment")] });
  assert.equal(none.verdict.status, "excluded", "Partial with no visible target records still fails");
});

test("이어서 조회하던 목록이 비공개로 바뀌면 그 목록만 0개로 확정, 나머지도 비공개면 제외", () => {
  const settings = total(4);
  const scan = createActivityScan(settings);
  const activity = createActivity();
  applyAccessResult(scan, activity, { profileStatus: "public", pages: [page("post", 1, [entry(1)], { nextPage: 2 }), page("comment", 1, [entry(2)], { nextPage: 2 })] }, context);
  const turned = applyActivityResult(scan, activity, "comment", { profileStatus: "private", unavailableReason: "갤로그 비공개 (댓글 목록)", listVisibility: { comment: "private" }, pages: [] }, context);
  assert.equal(turned.action, "continue");
  assert.equal(activity.listVisibility.comment, "private");
  assert.equal(activity.comments, 1, "Records read before the list turned private stay in the scan");
  const verdict = evaluateParticipants([person], new Map([["p", activity]]), settings, false)[0];
  assert.equal(verdict.activityCommentCount, 0);
  assert.deepEqual(nextActivityRequest(scan, activity, settings), { kind: "post", startPage: 2, count: 3 });
  const stop = applyActivityResult(scan, activity, "post", { profileStatus: "private", unavailableReason: "갤로그 비공개 (글 목록)", listVisibility: { post: "private" }, pages: [] }, context);
  assert.equal(stop.action, "stop");
  const excluded = evaluateParticipants([person], new Map([["p", activity]]), settings, false)[0];
  assert.equal(excluded.status, "excluded");
  assert.equal(excluded.reason, "갤로그 비공개 (글·댓글 모두)");
});

// Server side: parsing a private list page and continuing to the other list.
const target = parsePostUrl(post.url);
const sessionKey = "c".repeat(64);
const postHtml = '<span class="title_subject">나눔</span><input name="e_s_n_o" value="token">';
const publicList = (kind) => '<span class="bluebox">공개</span><ul class="cont_listbox"><li data-no="77">'
  + '<a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&amp;no=42">활동</a>'
  + '<span class="date">2026.01.02</span></li></ul><div class="bottom_paging_box">1</div><!-- ' + kind + ' -->';
const privateList = '<div class="gallog_cont"><h2 class="tit">게시글</h2><span class="greybox">비공개</span></div>';
const keyFor = (uid) => parseComments({ comments: [{ no: "1", user_id: uid, name: "참가자", memo: "참여" }] }, target, sessionKey)[0].authorKey;
const body = (changes = {}) => ({ postUrl: target.url, sessionKey, cutoff: 0, asOf: Date.now(), periodUnit: "all", ...changes });
async function call(handler, payload) {
  let text = "";
  const res = { setHeader() {}, end(value) { text = value; } };
  await handler({ method: "POST", headers: {}, body: payload }, res, { pauseMs: 0, logger: () => {} });
  return { status: res.statusCode, body: JSON.parse(text) };
}
function mockGallog(t, pages) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const address = String(url);
    if (address.includes("/board/comment/")) return Response.json({ comments: [{ no: "1", user_id: "alpha", name: "참가자", memo: "참여" }], total_cnt: 1 });
    if (address.startsWith("https://gallog.")) {
      calls.push(address);
      return new Response(pages[address.includes("/comment") ? "comment" : "post"]);
    }
    return new Response(postHtml);
  });
  return calls;
}
beforeEach(() => resetServerState());

test("비공개 목록 페이지는 라벨 표기가 달라도 비공개로 인식하고 미확인·차단으로 넘기지 않음", () => {
  const read = (html, kind = "post") => parseProfileActivity(html, target, kind, 1, 0, asOf);
  for (const html of [privateList, '<span class="greybox"> 비공개 </span>', '<span class="graybox">&nbsp;비공개&nbsp;</span>',
    '<em class="option greybox"><b>비공개</b></em>', '<span class="greybox">비공개</span><ul class="cont_listbox"></ul>',
    '<div class="no_data">작성자가 게시글을 비공개로 설정했습니다.</div>', '<ul class="cont_listbox"><li class="no_list">비공개 목록입니다.</li></ul>',
    '<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha"></div><span class="greybox">비공개</span>',
    '<p>이 회원은 활동 내역을 공개하지 않습니다.</p><div class="g-recaptcha"></div>']) {
    const parsed = read(html);
    assert.equal(parsed.visibility, "private", html);
    assert.equal(parsed.unavailableReason, "갤로그 비공개 (글 목록)");
    assert.deepEqual([parsed.entries, parsed.nextPage, parsed.paginationKnown], [[], null, true]);
  }
  assert.equal(read(privateList, "comment").unavailableReason, "갤로그 비공개 (댓글 목록)");
  // Words inside activity rows never decide the visibility.
  const rows = '<ul class="cont_listbox"><li data-no="1"><a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=5">비공개로 설정했습니다</a><span class="date">2026.01.02</span></li></ul>';
  assert.equal(read(rows).visibility, "unknown");
  assert.equal(read('<span class="bluebox">공개</span>' + rows).visibility, "public");
  assert.equal(read("<p>응답 형식 변경</p>").visibility, "unknown");
});

test("공개 확인: 글 목록이 비공개여도 댓글 목록을 이어서 읽고 목록별 공개 상태를 반환", async (t) => {
  const calls = mockGallog(t, { post: privateList, comment: publicList("comment") });
  const authorKey = keyFor("alpha");
  const result = await call(activityHandler, body({ action: "access", listRule: "visible-only", targets: [{ authorKey, sourcePage: 1 }] }));
  assert.equal(result.status, 200);
  const [item] = result.body.results;
  assert.equal(item.profileStatus, "public");
  assert.deepEqual(item.listVisibility, { post: "private", comment: "public" });
  assert.deepEqual(item.pages.map((entry) => [entry.kind, entry.visibility]), [["post", "private"], ["comment", "public"]]);
  assert.equal(item.pages[1].entries.length, 1);
  assert.equal(calls.length, 2, "The comment list is still read");
  const scan = createActivityScan(separate(0, 1));
  const activity = createActivity();
  applyAccessResult(scan, activity, item, { post: target, cutoff: 0, asOf: Date.now() });
  assert.equal(evaluateParticipants([person], new Map([["p", activity]]), separate(0, 1), false)[0].status, "eligible");
});

test("공개 확인: 글·댓글 모두 비공개면 private, 차단 화면 판정이나 미확인으로 가지 않음", async (t) => {
  const recaptcha = '<script src="https://www.google.com/recaptcha/api.js"></script>' + privateList;
  const calls = mockGallog(t, { post: recaptcha, comment: '<div class="no_data">댓글을 비공개로 설정했습니다.</div><div class="g-recaptcha"></div>' });
  const result = await call(activityHandler, body({ action: "access", listRule: "visible-only", targets: [{ authorKey: keyFor("alpha"), sourcePage: 1 }] }));
  const [item] = result.body.results;
  assert.equal(result.body.blocked, undefined);
  assert.equal(item.profileStatus, "private");
  assert.equal(item.unavailableReason, "갤로그 비공개 (글·댓글 모두)");
  assert.deepEqual(item.listVisibility, { post: "private", comment: "private" });
  assert.equal(calls.length, 2);
  assert.equal(item.retryable, undefined);
});

test("일부공개 글 목록 + 비공개 댓글 목록은 partial로 반환", async (t) => {
  mockGallog(t, { post: publicList("post").replace('class="bluebox">공개', 'class="whitebox">일부공개'), comment: privateList });
  const [item] = (await call(activityHandler, body({ action: "access", listRule: "visible-only", targets: [{ authorKey: keyFor("alpha"), sourcePage: 1 }] }))).body.results;
  assert.equal(item.profileStatus, "partial");
  assert.deepEqual(item.listVisibility, { post: "partial", comment: "private" });
});

test("이전 클라이언트(목록 규칙 없음·단일 대상 형식)는 기존처럼 한쪽 비공개를 private로 받음", async (t) => {
  const calls = mockGallog(t, { post: privateList, comment: publicList("comment") });
  const batch = await call(activityHandler, body({ action: "access", targets: [{ authorKey: keyFor("alpha"), sourcePage: 1 }] }));
  assert.equal(batch.body.results[0].profileStatus, "private");
  assert.equal(batch.body.results[0].unavailableReason, "갤로그 비공개 (글 목록)");
  assert.deepEqual(batch.body.results[0].pages, []);
  assert.equal(calls.length, 1, "The previous rule stops at the first private list");
  const single = await call(activityHandler, body({ action: "access", authorKey: keyFor("alpha"), sourcePage: 1 }));
  assert.equal(single.status, 200);
  assert.equal(single.body.profileStatus, "private");
  assert.equal((await call(activityHandler, body({ action: "access", listRule: "other", targets: [{ authorKey: keyFor("alpha"), sourcePage: 1 }] }))).status, 400);
});

test("이어서 조회한 목록이 비공개면 해당 목록만 private로 표시해 반환", async (t) => {
  mockGallog(t, { post: privateList, comment: publicList("comment") });
  const [item] = (await call(activityHandler, body({ listRule: "visible-only", targets: [{ authorKey: keyFor("alpha"), sourcePage: 1, kind: "post", startPage: 2, count: 2 }] }))).body.results;
  assert.equal(item.profileStatus, "private");
  assert.deepEqual(item.listVisibility, { post: "private" });
  assert.deepEqual(item.pages, []);
});
