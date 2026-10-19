import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { parsePostInput, parsePostUrl, sixMonthCutoff, evaluationCutoff, periodLabel, participantLabel, applyParticipantSelection, collectParticipants, evaluateParticipants, pickWinners } from "../public/lottery-core.js";
import commentsHandler, { parseComments, nextPage, loadCommentSource } from "../api/comments.js";
import { parsePosts } from "../api/pages.js";
import activityHandler, { parseProfileActivity } from "../api/comment-activity.js";
import { createRecord } from "../public/result-export.js";
import { resetServerState } from "../lib/dcinside.js";

const gallery = { id: "aidevelop", type: "mgallery" };
const sessionKey = "a".repeat(64);
const options = { includeGuests: false, includeReplies: true, excludeAuthor: true, keyword: "" };
beforeEach(() => resetServerState());

test("게시글 URL은 일반·마이너·미니만 허용하고 다른 호스트와 경로는 거부", () => {
  assert.equal(parsePostUrl("https://gall.dcinside.com/mgallery/board/view/?id=aidevelop\\&no=3524").no, "3524");
  assert.equal(parsePostUrl("https://gall.dcinside.com/mini/board/view/?id=example&no=1").type, "mini");
  assert.equal(parsePostUrl("https://gall.dcinside.com/board/view/?id=example&no=1").type, "gallery");
  for (const value of ["http://127.0.0.1/?id=a&no=1", "https://gall.dcinside.com.evil.test/board/view/?id=a&no=1",
    "https://gall.dcinside.com/board/lists/?id=a&no=1", "https://gall.dcinside.com:444/board/view/?id=a&no=1"]) {
    assert.throws(() => parsePostUrl(value));
  }
});

test("모바일·단축 공유 주소는 PC 조회 주소로 바꾸고 외부 호스트·목록은 거부", () => {
  const expected = parsePostUrl("https://gall.dcinside.com/board/view/?id=aidevelop&no=3524");
  for (const value of ["https://m.dcinside.com/board/aidevelop/3524", "https://m.dcinside.com/board/aidevelop/3524?recommend=1#comment",
    "https://gall.dcinside.com/aidevelop/3524", "http://m.dcinside.com/board/aidevelop/3524/"]) {
    assert.deepEqual(parsePostInput(value), expected);
  }
  const minor = "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524";
  assert.deepEqual(parsePostInput(minor), parsePostUrl(minor));
  for (const value of ["https://m.dcinside.com/board/aidevelop", "https://m.dcinside.com.evil.test/board/aidevelop/3524",
    "https://m.dcinside.com@evil.test/board/aidevelop/3524", "https://user@m.dcinside.com/board/aidevelop/3524",
    "https://m.dcinside.com:444/board/aidevelop/3524", "https://gall.dcinside.com/board/lists/?id=aidevelop&no=3524"]) {
    assert.throws(() => parsePostInput(value));
  }
});

test("공유 주소의 디시 이동 안내를 따라 같은 글의 종류와 참가자 키를 확정", async (t) => {
  const raw = { comments: [{ no: "1", user_id: "alpha", name: "ㅇㅇ", memo: "참여" }], total_cnt: 1 };
  let method = "script";
  let kind = "mgallery";
  t.mock.method(globalThis, "fetch", async (url) => {
    const address = String(url);
    if (address.includes("/board/comment/")) return Response.json(raw);
    if (address.includes("/" + kind + "/board/view/")) return new Response('<span class="title_subject">나눔</span><input name="e_s_n_o" value="token">');
    const destination = `https://gall.dcinside.com/${kind}/board/view/?id=aidevelop&no=3524`;
    return method === "http" ? new Response(null, { status: 302, headers: { location: destination } })
      : new Response('<script>location.replace("' + destination + '");</script>');
  });
  for (const redirectMethod of ["script", "http"]) {
    method = redirectMethod;
    for (const galleryKind of ["mgallery", "mini"]) {
      kind = galleryKind;
      resetServerState();
      let body;
      const res = { setHeader() {}, end(value) { body = JSON.parse(value); } };
      await commentsHandler({ method: "POST", headers: {}, body: {
        postUrl: "https://m.dcinside.com/board/aidevelop/3524", sessionKey, startPage: 1, count: 1,
      } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(body.post.type, kind);
      const expected = parseComments(raw, body.post, sessionKey)[0];
      assert.equal(body.pages[0].comments[0].authorKey, expected.authorKey);
    }
  }
});

test("주소 이동은 다른 호스트·다른 글·반복 이동을 따라가지 않음", async (t) => {
  const target = parsePostUrl("https://gall.dcinside.com/board/view/?id=aidevelop&no=3524");
  let destination;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: destination } });
  });
  for (const redirect of ["https://evil.test/board/view/?id=aidevelop&no=3524",
    "http://gall.dcinside.com/board/view/?id=aidevelop&no=3524", "https://gall.dcinside.com/board/view/?id=other&no=3524",
    "https://gall.dcinside.com/board/view/?id=aidevelop&no=3525", target.url]) {
    destination = redirect;
    calls = 0;
    await assert.rejects(loadCommentSource(target, sessionKey));
    assert.equal(calls, 1, "Do not fetch the rejected destination");
  }
});

test("6개월 경계는 한국 날짜의 월말에 맞춰 계산", () => {
  const asOf = Date.parse("2026-10-31T12:34:56+09:00");
  assert.equal(sixMonthCutoff(asOf), Date.parse("2026-04-30T12:34:56+09:00"));
});

test("평가기간은 제한 없음과 월 단위를 지원하고 일 단위는 거부", () => {
  const asOf = Date.parse("2026-10-31T12:34:56+09:00");
  assert.equal(evaluationCutoff(asOf, 0, "all"), 0);
  assert.equal(periodLabel({ periodUnit: "all", periodValue: 0 }), "기간 제한 없음");
  assert.equal(evaluationCutoff(asOf, 6, "months"), Date.parse("2026-04-30T00:00:00+09:00"));
  assert.equal(evaluationCutoff(asOf, 24, "months"), Date.parse("2024-10-31T00:00:00+09:00"));
  for (const [value, unit] of [[1, "days"], [0, "months"], [25, "months"]]) {
    assert.throws(() => evaluationCutoff(asOf, value, unit));
  }
  assert.throws(() => evaluationCutoff(NaN, 0, "all"));
});

test("활동 API는 기간 제한 없음에서 2년 이전 기록도 집계하고 공개 조건은 유지", async (t) => {
  const target = parsePostUrl("https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524");
  const raw = { comments: [{ no: "1", user_id: "alpha", name: "참가자", memo: "참여" }], total_cnt: 1 };
  const authorKey = parseComments(raw, target, sessionKey)[0].authorKey;
  const oldProfile = '<span class="bluebox">공개</span><ul class="cont_listbox"><li data-no="77">'
    + '<a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&amp;no=42">활동</a>'
    + '<span class="date">2020.01.02</span></li></ul><div class="bottom_paging_box">1</div>';
  let privateProfile = false;
  let partialProfile = false;
  let unknownProfile = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://gallog.dcinside.com/")) {
      if (privateProfile && String(url).endsWith("/comment")) return new Response('<span class="greybox">비공개</span>');
      if (unknownProfile) return new Response('<p>응답 형식 변경</p>');
      return new Response(partialProfile ? oldProfile.replace('class="bluebox">공개', 'class="whitebox">일부공개') : oldProfile);
    }
    if (String(url).includes("/board/comment/")) return Response.json(raw);
    return new Response('<span class="title_subject">나눔</span><input name="e_s_n_o" value="token">');
  });
  const asOf = Date.now();
  const query = { postUrl: target.url, sessionKey, authorKey, sourcePage: 1, kind: "post", startPage: 1, count: 1,
    cutoff: 0, asOf, periodUnit: "all" };
  const request = async (changes = {}) => {
    let body;
    const res = { setHeader() {}, end(value) { body = JSON.parse(value); } };
    await activityHandler({ method: "POST", headers: {}, body: { ...query, ...changes } }, res);
    return { status: res.statusCode, body };
  };
  const unlimited = await request();
  assert.equal(unlimited.status, 200);
  assert.equal(unlimited.body.pages[0].entries[0].ts, Date.parse("2020-01-02T00:00:00+09:00"));
  const bounded = await request({ periodUnit: "months", cutoff: evaluationCutoff(asOf, 6, "months") });
  assert.equal(bounded.status, 200);
  assert.equal(bounded.body.pages[0].entries.length, 0);
  for (const changes of [{ periodUnit: "months" }, { periodUnit: "days" }, { cutoff: 1 }]) {
    assert.equal((await request(changes)).status, 400);
  }
  partialProfile = true;
  const partial = await request({ action: "access" });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.profileStatus, "partial");
  assert.equal(partial.body.pages.length, 2);
  assert.ok(partial.body.pages.every((page) => page.visibility === "partial"));
  privateProfile = true;
  const hidden = await request({ action: "access" });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.profileStatus, "private");
  assert.deepEqual(hidden.body.pages, []);
  privateProfile = false;
  unknownProfile = true;
  const unknown = await request({ action: "access" });
  assert.equal(unknown.body.profileStatus, "unknown");
  assert.deepEqual(unknown.body.pages, []);
});

test("일부공개는 공개된 대상 갤러리 기록만 평가하고 기록이 없으면 기준 미달 처리", () => {
  const target = parsePostUrl("https://gall.dcinside.com/mgallery/board/view/?id=target&no=99");
  const row = (id, gallery, no) => `<li data-no="${id}"><a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=${gallery}&no=${no}">글</a><span class="date">2026.10.01</span></li>`;
  const html = '<span class="whitebox">일부공개</span><ul class="cont_listbox">'
    + row(1, "target", 1) + row(2, "other", 2) + row(3, "target", 99) + '</ul><div class="bottom_paging_box">1</div>';
  const parsed = parseProfileActivity(html, target, "post", 1, 0, Date.parse("2026-10-15T00:00:00+09:00"));
  assert.equal(parsed.visibility, "partial");
  assert.deepEqual(parsed.entries.map((entry) => entry.postNo), ["1"]);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.paginationKnown, true);
  assert.equal(parsed.nextPage, null);
  const person = { key: "p", name: "ㅇㅇ", exclusion: "", status: "pending" };
  const rules = { requirePublicGallog: true, minPosts: 1, minComments: 0, periodUnit: "all" };
  const counts = new Map([["p", { profileStatus: "partial", count: parsed.entries.length, comments: 0,
    postsComplete: true, commentsComplete: true }]]);
  assert.equal(evaluateParticipants([person], counts, rules, true)[0].status, "eligible");
  const absent = parseProfileActivity(html, { ...target, id: "hidden" }, "post", 1, 0, Date.now());
  assert.equal(absent.entries.length, 0);
  counts.get("p").count = absent.entries.length;
  const excluded = evaluateParticipants([person], counts, rules, true)[0];
  assert.equal(excluded.status, "excluded");
  assert.match(excluded.reason, /작성글 없음/);
  const unknown = parseProfileActivity('<ul class="cont_listbox"><li><span class="whitebox">일부공개</span></li></ul>', target, "post", 1, 0, Date.now());
  assert.equal(unknown.visibility, "unknown", "An activity entry must not impersonate the section's visibility label");
});

test("실제 댓글 형식에서 시스템·삭제 댓글 제외, UID 중복 통합, 동명 계정은 분리", () => {
  const raw = [{ no: "1", user_id: "alpha", name: "같은닉", memo: "참여", depth: 0 },
    { no: "2", user_id: "alpha", name: "바뀐닉", memo: "참여", depth: 1 },
    { no: "3", user_id: "beta", name: "같은닉", memo: "참여", depth: 0 },
    { no: "4", ip: "123.45", name: "유동", memo: "참여" },
    { no: "5", user_id: "deleted", name: "삭제", memo: "참여", del_yn: "Y" },
    { no: "0", name: "댓글돌이", memo: "광고", nicktype: "COMMENT_BOY" }];
  const comments = parseComments({ comments: raw }, gallery, sessionKey);
  assert.equal(comments.length, 4);
  assert.ok(!JSON.stringify(comments).includes('"user_id"'));
  assert.ok(!JSON.stringify(comments).includes("123.45"));
  const people = collectParticipants(comments, options);
  assert.equal(people.length, 3);
  assert.equal(people[0].commentCount, 2);
  assert.equal(people[2].exclusion, "유동 제외 설정");
  assert.equal(collectParticipants(comments, { ...options, includeReplies: false })[0].commentCount, 1);
  assert.equal(collectParticipants(comments, { ...options, keyword: "신청" }).length, 0);
});

test("동명 ㅇㅇ 계정은 공개 식별코드로 구분하고 유동의 IP는 노출하지 않음", () => {
  const comments = parseComments({ comments: [
    { no: "1", user_id: "alpha", name: "ㅇㅇ", memo: "참여" },
    { no: "2", user_id: "beta", name: "ㅇㅇ", memo: "참여" },
    { no: "3", user_id: "alpha", name: "새닉", memo: "참여" },
    { no: "4", ip: "123.45", name: "ㅇㅇ", memo: "참여" },
  ] }, gallery, sessionKey);
  const people = collectParticipants(comments, options);
  assert.equal(people.length, 3);
  assert.equal(participantLabel(people[0]), "ㅇㅇ (alpha)");
  assert.equal(participantLabel(people[1]), "ㅇㅇ (beta)");
  assert.equal(people[0].commentCount, 2);
  assert.equal(people[2].identityCode, "");
  assert.ok(!JSON.stringify(comments).includes("123.45"));
});

test("수동 불포함은 통과자에게만 적용하고 비공개·미확인을 포함으로 바꾸지 않음", () => {
  const people = [
    { key: "a", status: "eligible", reason: "활동 기준 충족" },
    { key: "b", status: "eligible", reason: "활동 기준 충족" },
    { key: "c", status: "excluded", reason: "갤로그 비공개" },
    { key: "d", status: "pending", reason: "확인 불가" },
  ];
  const selected = applyParticipantSelection(people, new Set(["a", "c", "d"]));
  assert.equal(selected[0].included, false);
  assert.equal(selected[0].automaticStatus, "eligible");
  assert.equal(selected[0].reason, "운영자 수동 불포함");
  assert.equal(selected[1].included, true);
  assert.equal(selected[2].reason, "갤로그 비공개");
  assert.equal(selected[2].manuallyExcluded, false);
  assert.equal(selected[3].status, "pending");
  assert.throws(() => pickWinners(selected, 1, webcrypto), /미확인/);
  assert.equal(pickWinners(selected.slice(0, 3), 1, webcrypto)[0].key, "b");
  assert.equal(applyParticipantSelection(people)[0].included, true);
  assert.equal(applyParticipantSelection(people)[2].included, false);
  assert.equal(people[0].status, "eligible");
});

test("댓글 UID와 활동 목록 UID는 닉네임이 달라도 같은 키로 연결, 공지 제외", () => {
  const comments = parseComments({ comments: [{ no: "1", user_id: "alpha", name: "오늘닉", memo: "참여" }] }, gallery, sessionKey);
  const row = (type, number) => '<tr class="ub-content us-post" data-type="' + type + '" data-no="' + number + '">'
    + '<td class="gall_num">' + number + '</td><td class="gall_writer" data-uid="alpha" data-nick="옛닉">'
    + '<span class="nickname">옛닉</span></td><td class="gall_date" title="2026-10-05 12:00:00"></td></tr>';
  const posts = parsePosts(row("icon_txt", "42") + row("icon_notice", "41"), gallery, sessionKey, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].authorKey, comments[0].authorKey);
  assert.equal(posts[0].ts, Date.parse("2026-10-05T12:00:00+09:00"));
});

test("전체 활동 확인 전 0개 참가자는 보류, 확인 후에는 활동 없음으로 제외", () => {
  const people = [{ key: "a", exclusion: "" }, { key: "b", exclusion: "" }, { key: "c", exclusion: "유동 제외 설정", status: "excluded" }];
  const counts = new Map([["a", { count: 3, latest: 1, url: "example" }]]);
  const partial = evaluateParticipants(people, counts, 3, false);
  assert.equal(partial[0].status, "eligible");
  assert.equal(partial[1].status, "pending");
  assert.throws(() => pickWinners(partial, 1, webcrypto), /미확인/);
  const complete = evaluateParticipants(people, counts, 3, true);
  assert.equal(complete[1].status, "excluded");
  assert.equal(complete[1].reason, "최근 6개월 작성글 없음");
  assert.deepEqual(pickWinners(complete, 1, webcrypto).map((person) => person.key), ["a"]);
  assert.throws(() => pickWinners(complete, 2, webcrypto), /통과 후보/);
});

test("추첨은 중복 없는 동일 확률 표본이며 모듈로 편향 값은 재추출", () => {
  const pool = ["a", "b", "c"].map((key) => ({ key, status: "eligible" }));
  let calls = 0;
  const cryptoSource = { getRandomValues: (buffer) => { buffer[0] = calls++ === 0 ? 0xffff_ffff : 0; return buffer; } };
  const winners = pickWinners(pool, 3, cryptoSource);
  assert.equal(new Set(winners.map((person) => person.key)).size, 3);
  assert.equal(calls, 4);
  assert.deepEqual(pool.map((person) => person.key), ["a", "b", "c"]);
});

test("댓글 페이지 이동은 DC viewComments와 마지막 페이지를 구분", () => {
  assert.equal(nextPage('<em>1</em><a href="javascript:viewComments(2,\'N\')">2</a>', 1), 2);
  assert.equal(nextPage('<a onclick="viewComments(1,\'N\')">1</a><em>2</em>', 2), null);
});

test("JSON 기록은 공개 식별코드와 재추첨 내역을 보존하고 IP·본문·세션 키는 내보내지 않음", () => {
  const at = Date.parse("2026-10-15T12:00:00+09:00");
  const person = { key: "internal-author-key", uid: "private-user-id", ip: "private-ip", content: "private-comment-body",
    name: "참가자", identityCode: "public_alpha", identityType: "uid", firstCommentId: "123", commentCount: 2, profileStatus: "public",
    status: "eligible", reason: "활동 기준 충족", postCount: 3, activityCommentCount: 0, totalActivityCount: 3, lastActivity: at, exclusion: "" };
  const record = createRecord({ post: { id: "aidevelop", type: "mgallery", no: "3524", title: "나눔", url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524", authorKey: "private-post-key" },
    settings: { winnerCount: 1, periodUnit: "all", periodValue: 0, activityMode: "separate", minPosts: 3, minComments: 0, minTotal: 0, requirePublicGallog: true, includeReplies: true, excludeAuthor: true, keyword: "", sessionKey: "private-session-key" },
    participants: [person, { ...person, firstCommentId: "456", exclusion: "갤로그 비공개", status: "excluded" }], commentsCount: 3,
    cutoff: 0, asOf: at, completed: true, phase: "done", tone: "success", message: "추첨 완료",
    draws: [{ id: "first", at, winners: [person], rosterHash: "f".repeat(64) }, { id: "second", at: at + 1000, winners: [person], type: "reroll", reason: "당첨자 연락 불가", rosterHash: "f".repeat(64) }],
    roster: { canonical: '{"roster":[["public_alpha","123"]]}', hash: "f".repeat(64) },
    drawLog: [{ sequence: 1, drawId: "older-run", type: "draw", reason: "", winners: [{ rank: 1, displayName: "다른 참가자", identityCode: "x", entryCommentId: "1" }] }],
    logs: [{ elapsed: "00:01", tone: "success", message: "추첨 완료", detail: "" }] }, at + 2000);
  assert.equal(record.latestDrawId, "second");
  assert.equal(record.participants[0].displayName, "참가자 (public_alpha)");
  assert.deepEqual(record.draws.map((draw) => draw.sequence), [1, 2]);
  assert.equal(record.assessment.from, null);
  assert.equal(record.participants[1].confirmedPosts, null);
  assert.equal(new URL(record.draws[1].winners[0].entryCommentUrl).searchParams.get("fcno"), "123");
  assert.equal(record.summary.excluded, 1);
  assert.equal(record.rosterHash.sha256, "f".repeat(64));
  assert.equal(record.rosterHash.algorithm, "SHA-256");
  assert.match(record.rosterHash.howToVerify, /SHA-256/);
  assert.deepEqual(record.draws.map((draw) => [draw.type, draw.reason, draw.rosterSha256]), [["draw", "", "f".repeat(64)], ["reroll", "당첨자 연락 불가", "f".repeat(64)]]);
  assert.equal(record.drawLog.entries[0].drawId, "older-run", "The tab's draw log keeps earlier runs");
  const serialized = JSON.stringify(record);
  for (const secret of ["internal-author-key", "private-user-id", "private-ip", "private-comment-body", "private-post-key", "private-session-key"]) {
    assert.ok(!serialized.includes(secret));
  }
});
