import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { parsePostUrl, sixMonthCutoff, collectParticipants, evaluateParticipants, pickWinners } from "../public/lottery-core.js";
import { parseComments, nextPage } from "../api/comments.js";
import { parsePosts } from "../api/pages.js";

const gallery = { id: "aidevelop", type: "mgallery" };
const sessionKey = "a".repeat(64);
const options = { includeGuests: false, includeReplies: true, excludeAuthor: true, keyword: "" };

test("게시글 URL은 일반·마이너·미니만 허용하고 다른 호스트와 경로는 거부", () => {
  assert.equal(parsePostUrl("https://gall.dcinside.com/mgallery/board/view/?id=aidevelop\\&no=3524").no, "3524");
  assert.equal(parsePostUrl("https://gall.dcinside.com/mini/board/view/?id=example&no=1").type, "mini");
  assert.equal(parsePostUrl("https://gall.dcinside.com/board/view/?id=example&no=1").type, "gallery");
  for (const value of ["http://127.0.0.1/?id=a&no=1", "https://gall.dcinside.com.evil.test/board/view/?id=a&no=1",
    "https://gall.dcinside.com/board/lists/?id=a&no=1", "https://gall.dcinside.com:444/board/view/?id=a&no=1"]) {
    assert.throws(() => parsePostUrl(value));
  }
});

test("6개월 경계는 한국 날짜의 월말에 맞춰 계산", () => {
  const asOf = Date.parse("2026-10-31T12:34:56+09:00");
  assert.equal(sixMonthCutoff(asOf), Date.parse("2026-04-30T12:34:56+09:00"));
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
