import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parsePostUrl } from "../public/lottery-core.js";
import commentsHandler, { parseComments, readCommentPage } from "../api/comments.js";
import activityHandler from "../api/comment-activity.js";
import { createBudget, resetServerState } from "../lib/dcinside.js";

const sessionKey = "b".repeat(64);
const target = parsePostUrl("https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524");
const postHtml = '<span class="title_subject">나눔</span><input name="e_s_n_o" value="token">';
const profile = (kind = "posting") => '<span class="bluebox">공개</span><ul class="cont_listbox"><li data-no="77">'
  + '<a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&amp;no=42">활동</a>'
  + '<span class="date">2026.01.02</span></li></ul><div class="bottom_paging_box"><a href="/alpha/' + kind + '?p=2">2</a></div>';
const pageLinks = '<a href="javascript:viewComments(2,\'N\')">2</a>';

export async function call(handler, body, options = {}, headers = {}) {
  let text = "";
  const sent = {};
  const res = { setHeader(key, value) { sent[key.toLowerCase()] = value; }, end(value) { text = value; } };
  await handler({ method: "POST", headers, body }, res, { pauseMs: 0, ...options });
  return { status: res.statusCode, body: JSON.parse(text), headers: sent };
}
// Fake clock that advances on every upstream fetch, so budgets are tested without waiting.
function clockedFetch(t, step, respond) {
  let now = 0;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    now += step;
    return respond(String(url), init);
  });
  return { calls, now: () => now };
}
function keyFor(uid, no = "1") {
  return parseComments({ comments: [{ no, user_id: uid, name: "참가자", memo: "참여" }] }, target, sessionKey)[0].authorKey;
}
function activityBody(changes = {}) {
  return { postUrl: target.url, sessionKey, cutoff: 0, asOf: Date.now(), periodUnit: "all", ...changes };
}
beforeEach(() => resetServerState());

test("댓글 API는 시간 예산을 넘기기 전에 읽은 페이지만 반환하고 다음 페이지를 이어서 조회", async (t) => {
  const clock = clockedFetch(t, 8000, (url) => url.includes("/board/comment/")
    ? Response.json({ comments: [{ no: String(clock.calls.length), user_id: "u" + clock.calls.length, name: "ㅇㅇ", memo: "참여" }], total_cnt: 10, pagination: pageLinks.replace("2", "9") })
    : new Response(postHtml));
  const result = await call(commentsHandler, { postUrl: target.url, sessionKey, startPage: 1, count: 3 }, { budget: createBudget({ now: clock.now }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, true);
  assert.deepEqual(result.body.pages.map((page) => page.page), [1, 2]);
  assert.equal(result.body.pages.at(-1).nextPage, 3, "The last page carries the continuation marker");
  assert.equal(clock.calls.length, 3, "No upstream request starts after the start limit");
  const none = await call(commentsHandler, { postUrl: target.url, sessionKey, startPage: 1, count: 1 }, { budget: createBudget({ startLimit: 0 }) });
  assert.equal(none.status, 503);
  assert.equal(none.body.errorKind, "time_budget");
  assert.equal(none.body.retryable, true);
});

test("예산 안의 각 요청은 남은 시간 안에서 끝나도록 제한 시간을 줄임", () => {
  let now = 0;
  const budget = createBudget({ now: () => now });
  assert.equal(budget.timeout(), 5000);
  now = 19_000;
  assert.equal(budget.canStart(), true);
  assert.equal(budget.timeout(), 5000);
  now = 21_000;
  assert.equal(budget.canStart(), false);
  assert.equal(budget.timeout(), 4000);
});

test("활동 일괄 조회는 시간 예산이 끝나면 남은 참가자를 deferred로 돌려줌", async (t) => {
  const clock = clockedFetch(t, 4000, (url) => url.includes("/board/comment/")
    ? Response.json({ comments: ["alpha", "beta", "gamma"].map((uid, index) => ({ no: String(index + 1), user_id: uid, name: "ㅇㅇ", memo: "참여" })), total_cnt: 3 })
    : url.startsWith("https://gallog.") ? new Response(profile(url.endsWith("/comment") ? "comment" : "posting")) : new Response(postHtml));
  const keys = [keyFor("alpha", "1"), keyFor("beta", "2"), keyFor("gamma", "3")];
  const result = await call(activityHandler, activityBody({ action: "access", targets: keys.map((authorKey) => ({ authorKey, sourcePage: 1 })) }),
    { budget: createBudget({ now: clock.now }) });
  assert.equal(result.status, 200);
  // post + comments (8s) + alpha 2 pages (16s) + beta post page (20s) → beta's comment page cannot start.
  assert.deepEqual(result.body.results.map((item) => item.authorKey), [keys[0]]);
  assert.deepEqual(result.body.deferred, [keys[1], keys[2]]);
  assert.equal(result.body.results[0].profileStatus, "public");
  assert.equal(result.body.results[0].pages.length, 2);
  assert.ok(!JSON.stringify(result.body).includes("alpha"), "The gallog ID never appears in the activity response");
});

test("활동 페이지 조회는 시간이 부족하면 읽은 페이지까지만 반환해 이어서 조회", async (t) => {
  const clock = clockedFetch(t, 5000, (url) => url.includes("/board/comment/")
    ? Response.json({ comments: [{ no: "1", user_id: "alpha", name: "ㅇㅇ", memo: "참여" }], total_cnt: 1 })
    : url.startsWith("https://gallog.") ? new Response(profile().replace("p=2", "p=" + ((Number(new URL(url).searchParams.get("p")) || 1) + 1))) : new Response(postHtml));
  const authorKey = keyFor("alpha");
  const result = await call(activityHandler, activityBody({ targets: [{ authorKey, sourcePage: 1, kind: "post", startPage: 1, count: 3 }] }),
    { budget: createBudget({ now: clock.now }) });
  const [entry] = result.body.results;
  assert.deepEqual(entry.pages.map((page) => page.page), [1, 2]);
  assert.equal(entry.pages.at(-1).nextPage, 3);
  assert.equal(entry.error, undefined);
});

test("갤로그 일시 오류는 미확인으로 두고 재시도 가능 여부를 함께 반환", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("/board/comment/")
    ? Response.json({ comments: [{ no: "1", user_id: "alpha", name: "ㅇㅇ", memo: "참여" }], total_cnt: 1 })
    : String(url).startsWith("https://gallog.") ? new Response("busy", { status: 503 }) : new Response(postHtml));
  const authorKey = keyFor("alpha");
  const result = await call(activityHandler, activityBody({ action: "access", targets: [{ authorKey, sourcePage: 1 }] }));
  assert.equal(result.body.results[0].profileStatus, "unknown");
  assert.equal(result.body.results[0].retryable, true);
  assert.notEqual(result.body.results[0].profileStatus, "private");
});

test("total_cnt보다 댓글이 적은데 다음 페이지가 없으면 수집을 보류", async (t) => {
  const source = { gallery: target, token: "token", cookie: "", form: { board_type: "", _GALLTYPE_: "", secret_article_key: "" } };
  let payload;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  payload = { comments: [{ no: "1" }, { no: "2" }], total_cnt: 5, pagination: "" };
  await assert.rejects(readCommentPage(source, 1), /페이지 정보를 확인할 수 없어/);
  payload = { comments: [{ no: "1" }, { no: "2" }], total_cnt: 2, pagination: "" };
  assert.equal((await readCommentPage(source, 1)).nextPage, null);
  payload = { comments: [{ no: "1" }], total_cnt: 5, pagination: pageLinks };
  assert.equal((await readCommentPage(source, 1)).nextPage, 2);
  payload = { comments: null, total_cnt: 0 };
  assert.deepEqual((await readCommentPage(source, 1)).comments, []);
});

test("같은 인스턴스의 연속 활동 조회는 게시글·댓글 페이지를 다시 받지 않음", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).includes("/board/comment/")) return Response.json({ comments: ["alpha", "beta"].map((uid, index) => ({ no: String(index + 1), user_id: uid, name: "ㅇㅇ", memo: "참여" })), total_cnt: 2 });
    if (String(url).startsWith("https://gallog.")) return new Response(profile(String(url).includes("/comment") ? "comment" : "posting"));
    return new Response(postHtml);
  });
  const first = await call(activityHandler, activityBody({ action: "access", targets: [{ authorKey: keyFor("alpha", "1"), sourcePage: 1 }, { authorKey: keyFor("beta", "2"), sourcePage: 1 }] }));
  assert.equal(first.body.results.length, 2);
  const second = await call(activityHandler, activityBody({ targets: [{ authorKey: keyFor("beta", "2"), sourcePage: 1, kind: "post", startPage: 2, count: 1 }] }));
  assert.equal(second.body.results[0].pages[0].page, 2);
  assert.equal(calls.filter((url) => url.includes("/board/view/")).length, 1, "Post page fetched once");
  assert.equal(calls.filter((url) => url.includes("/board/comment/")).length, 1, "Comment page fetched once");
  assert.equal(calls.filter((url) => url.startsWith("https://gallog.")).length, 5);
});

test("디시 403·429·차단 페이지는 즉시 멈추고 대기 시간을 알려주며 그동안 재요청하지 않음", async (t) => {
  let mode = "gallog429";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (mode === "post403") return new Response("forbidden", { status: 403 });
    if (mode === "postBlockPage") return new Response("<html><body>비정상적인 접근이 감지되었습니다.</body></html>");
    if (String(url).includes("/board/comment/")) return Response.json({ comments: ["alpha", "beta"].map((uid, index) => ({ no: String(index + 1), user_id: uid, name: "ㅇㅇ", memo: "참여" })), total_cnt: 2 });
    if (String(url).startsWith("https://gallog.")) return mode === "gallog429" ? new Response("slow down", { status: 429, headers: { "Retry-After": "90" } })
      : new Response("<p>자동 입력 방지 문자를 입력해주세요</p>");
    return new Response(postHtml);
  });
  const keys = [keyFor("alpha", "1"), keyFor("beta", "2")];
  const body = activityBody({ action: "access", targets: keys.map((authorKey) => ({ authorKey, sourcePage: 1 })) });
  const blocked = await call(activityHandler, body);
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body.results, []);
  assert.deepEqual(blocked.body.deferred, keys);
  assert.equal(blocked.body.blocked.retryAfter, 90);
  const before = calls.length;
  const again = await call(commentsHandler, { postUrl: target.url, sessionKey, startPage: 1, count: 1 });
  assert.equal(again.status, 503);
  assert.equal(again.body.errorKind, "upstream_blocked");
  assert.ok(Number(again.headers["retry-after"]) > 0);
  assert.equal(calls.length, before, "No upstream request during the cool-down");
  for (const [next, endpoint] of [["post403", "comments"], ["postBlockPage", "comments"], ["gallogPage", "activity"]]) {
    resetServerState();
    mode = next;
    const result = endpoint === "comments" ? await call(commentsHandler, { postUrl: target.url, sessionKey, startPage: 1, count: 1 })
      : await call(activityHandler, { ...body, targets: body.targets.slice(0, 1) });
    if (endpoint === "comments") { assert.equal(result.status, 503, next); assert.equal(result.body.errorKind, "upstream_blocked", next); }
    else assert.ok(result.body.blocked, next);
  }
});

test("참여 댓글이 기억한 페이지에 없으면 인접 페이지(±1, ±2)에서 다시 찾음", async (t) => {
  const { candidatePages } = await import("../api/comment-activity.js");
  assert.deepEqual(candidatePages(1), [1, 2, 3]);
  assert.deepEqual(candidatePages(5), [5, 6, 4, 7, 3]);
  assert.deepEqual(candidatePages(100), [100, 99, 98]);
  const pagesRead = [];
  let location = 3;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("/board/comment/")) {
      const page = Number(new URLSearchParams(init.body).get("comment_page"));
      pagesRead.push(page);
      const comments = page === location ? [{ no: "9", user_id: "alpha", name: "ㅇㅇ", memo: "참여" }] : [{ no: String(page * 10), user_id: "other" + page, name: "ㅇㅇ", memo: "참여" }];
      return Response.json({ comments, total_cnt: 40, pagination: page < 4 ? "viewComments(" + (page + 1) + ",'N')" : "" });
    }
    if (String(url).startsWith("https://gallog.")) return new Response(profile(String(url).includes("/comment") ? "comment" : "posting"));
    return new Response(postHtml);
  });
  const authorKey = keyFor("alpha", "9");
  const found = await call(activityHandler, activityBody({ action: "access", targets: [{ authorKey, sourcePage: 2 }] }));
  assert.equal(found.body.results[0].profileStatus, "public");
  assert.equal(found.body.results[0].sourcePage, 3, "The page where the comment now sits is returned");
  assert.deepEqual(pagesRead, [2, 3]);
  resetServerState();
  pagesRead.length = 0;
  location = 0;
  const missing = await call(activityHandler, activityBody({ action: "access", targets: [{ authorKey, sourcePage: 2 }] }));
  assert.equal(missing.body.results[0].profileStatus, "unknown");
  assert.match(missing.body.results[0].unavailableReason, /다시 확인할 수 없어 보류/);
  assert.deepEqual(pagesRead, [2, 3, 1, 4]);
});
