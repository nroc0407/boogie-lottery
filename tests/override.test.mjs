import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { applyParticipantSelection, createOverride, evaluateParticipants, pickWinners, rosterCanonical, sha256Hex, verdictCategory } from "../public/lottery-core.js";
import { createRecord } from "../public/result-export.js";

const post = { id: "aidevelop", type: "mgallery", no: "3524", title: "나눔", url: "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524" };
const settings = { winnerCount: 1, periodUnit: "all", periodValue: 0, activityMode: "separate", minPosts: 3, minComments: 0, minTotal: 0,
  requirePublicGallog: true, includeReplies: true, excludeAuthor: true, keyword: "" };
const asOf = Date.parse("2026-10-15T12:00:00+09:00");
const at = Date.parse("2026-10-15T12:30:00+09:00");
const base = { exclusion: "", commentCount: 1, identityType: "uid", postCount: 0, activityCommentCount: 0, totalActivityCount: 0 };
const people = [
  { ...base, key: "pass", name: "통과", identityCode: "pass", firstCommentId: "1", status: "eligible", reason: "활동 기준 충족", profileStatus: "public", listVisibility: { post: "public", comment: "private" } },
  { ...base, key: "short", name: "미달", identityCode: "short", firstCommentId: "2", status: "excluded", reason: "작성글 기준 미달 (1/3개)", profileStatus: "public", listVisibility: { post: "public", comment: "public" } },
  { ...base, key: "hidden", name: "비공개", identityCode: "hidden", firstCommentId: "3", status: "excluded", reason: "갤로그 비공개 (글·댓글 모두)", exclusion: "갤로그 비공개 (글·댓글 모두)", profileStatus: "private", listVisibility: { post: "private", comment: "private" } },
  { ...base, key: "wait", name: "보류", identityCode: "wait", firstCommentId: "4", status: "pending", reason: "갤로그 응답 시간이 초과되었습니다.", profileStatus: "unknown", listVisibility: { post: "", comment: "" } },
  { ...base, key: "author", name: "글쓴이", identityCode: "author", firstCommentId: "5", status: "excluded", reason: "게시글 작성자", exclusion: "게시글 작성자" },
  { ...base, key: "nogallog", name: "없음", identityCode: "", firstCommentId: "6", status: "excluded", reason: "연결할 갤로그가 없는 참가자", exclusion: "연결할 갤로그가 없는 참가자", identityType: "ip" },
];
const byKey = (list) => Object.fromEntries(list.map((person) => [person.key, person]));

test("수동 판정은 자동 판정보다 우선하고 원래 판정을 함께 보존, 삭제하면 자동 판정으로 복귀", () => {
  assert.deepEqual(people.map((person) => verdictCategory(person)[0]), ["eligible", "activity", "private", "pending", "author", "missing"]);
  const overrides = new Map();
  for (const key of ["short", "hidden", "wait", "author", "nogallog"]) overrides.set(key, createOverride(people.find((person) => person.key === key), "include", key === "hidden" ? "  운영자 확인 완료  " : "", at));
  overrides.set("pass", createOverride(people[0], "exclude", "부계정", at));
  const selected = byKey(applyParticipantSelection(people, overrides));
  assert.equal(selected.hidden.status, "eligible");
  assert.equal(selected.hidden.reason, "수동 포함 · 원래: 비공개 · 사유: 운영자 확인 완료");
  assert.equal(selected.hidden.manualOverride.reason, "운영자 확인 완료", "Reasons are trimmed");
  assert.equal(selected.hidden.automaticStatus, "excluded");
  assert.equal(selected.hidden.automaticReason, "갤로그 비공개 (글·댓글 모두)");
  assert.equal(selected.wait.status, "eligible");
  assert.equal(selected.wait.reason, "수동 포함 · 원래: 미확인");
  assert.equal(selected.author.reason, "수동 포함 · 원래: 게시글 작성자");
  assert.equal(selected.nogallog.reason, "수동 포함 · 원래: 갤로그 없음");
  assert.equal(selected.pass.status, "excluded");
  assert.equal(selected.pass.reason, "수동 불포함 · 원래: 통과 · 사유: 부계정");
  assert.equal(selected.pass.manuallyExcluded, true);
  assert.equal(selected.short.manuallyIncluded, true);
  const winners = pickWinners(Object.values(selected), 5, webcrypto);
  assert.deepEqual(winners.map((person) => person.key).sort(), ["author", "hidden", "nogallog", "short", "wait"]);
  overrides.delete("hidden");
  overrides.delete("wait");
  const reverted = byKey(applyParticipantSelection(people, overrides));
  assert.equal(reverted.hidden.status, "excluded");
  assert.equal(reverted.hidden.reason, "갤로그 비공개 (글·댓글 모두)");
  assert.equal(reverted.hidden.manualOverride, null);
  assert.equal(reverted.wait.status, "pending");
  assert.throws(() => pickWinners(Object.values(reverted), 1, webcrypto), /미확인/, "Undoing a decision brings the hold back");
  assert.throws(() => createOverride(people[0], "maybe"), /포함 또는 불포함/);
});

test("미확인 참가자를 수동으로 정하면 추첨을 막지 않고, 다시 확인해도 수동 판정은 유지하고 자동 판정만 갱신", () => {
  const waiting = { key: "wait", name: "보류", identityCode: "wait", firstCommentId: "4", exclusion: "", status: "pending", reason: "확인 중" };
  const passer = { ...people[0] };
  const overrides = new Map([["wait", createOverride(waiting, "exclude", "연락 없음", at)]]);
  const before = byKey(applyParticipantSelection([waiting, passer], overrides));
  assert.equal(before.wait.status, "excluded");
  assert.equal(pickWinners(Object.values(before), 1, webcrypto)[0].key, "pass");
  // Recheck: the automatic verdict is recomputed from fresh counts, the override map is untouched.
  const rechecked = evaluateParticipants([waiting], new Map([["wait", { profileStatus: "public", count: 5, comments: 0, postsComplete: true, commentsComplete: true,
    listVisibility: { post: "public", comment: "public" } }]]), settings, false);
  assert.equal(rechecked[0].status, "eligible");
  const after = byKey(applyParticipantSelection(rechecked, overrides));
  assert.equal(after.wait.status, "excluded");
  assert.equal(after.wait.automaticStatus, "eligible");
  assert.equal(after.wait.automaticVerdict, "eligible");
  assert.equal(after.wait.manualOverride.automaticAtDecision, "pending", "The verdict seen when deciding is kept");
  assert.equal(after.wait.reason, "수동 불포함 · 원래: 통과 · 사유: 연락 없음");
});

test("명단 해시는 수동 판정·목록 공개 상태가 바뀌면 달라지고 수집 순서와 판정 입력 순서에는 무관", async () => {
  const hash = async (list, overrides) => sha256Hex(rosterCanonical({ post, settings, participants: applyParticipantSelection(list, overrides), cutoff: 0, asOf }), webcrypto.subtle);
  const decisions = () => [["hidden", createOverride(people[2], "include", "확인", at)], ["pass", createOverride(people[0], "exclude", "", at + 1000)]];
  const original = await hash(people, new Map(decisions()));
  assert.equal(await hash([...people].reverse(), new Map(decisions().reverse())), original, "Order of participants and decisions does not matter");
  const parsed = JSON.parse(rosterCanonical({ post, settings, participants: applyParticipantSelection(people, new Map(decisions())), cutoff: 0, asOf }));
  assert.deepEqual(parsed.roster, [["hidden", "3", "private", "private"]]);
  assert.deepEqual(parsed.overrides, [["hidden", "3", "include", "private", "private", "확인", new Date(at).toISOString()],
    ["pass", "1", "exclude", "eligible", "eligible", "", new Date(at + 1000).toISOString()]]);
  const variants = [
    new Map(),
    new Map([decisions()[0]]),
    new Map([["hidden", createOverride(people[2], "include", "다른 사유", at)], decisions()[1]]),
    new Map([["hidden", createOverride(people[2], "include", "확인", at + 1)], decisions()[1]]),
    new Map([["hidden", createOverride(people[2], "exclude", "확인", at)], decisions()[1]]),
  ];
  for (const variant of variants) assert.notEqual(await hash(people, variant), original);
  const reopened = people.map((person) => person.key === "hidden" ? { ...person, listVisibility: { post: "public", comment: "private" } } : person);
  assert.notEqual(await hash(reopened, new Map(decisions())), original, "Per-list visibility of a roster member enters the hash");
  const plain = await hash(people, new Map());
  const commentsOpen = people.map((person) => person.key === "pass" ? { ...person, listVisibility: { post: "public", comment: "public" } } : person);
  assert.notEqual(await hash(commentsOpen, new Map()), plain);
});

test("JSON 기록은 목록 공개 상태·수동 판정을 담고 howToVerify 절차로 canonical을 재구성할 수 있음", () => {
  const overrides = new Map([["hidden", createOverride(people[2], "include", "확인", at)], ["wait", createOverride(people[3], "exclude", "", at)],
    ["pass", createOverride(people[0], "exclude", "부계정", at)]]);
  const selected = applyParticipantSelection(people, overrides);
  const canonical = rosterCanonical({ post, settings, participants: selected, cutoff: 0, asOf });
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const record = createRecord({ post, settings, participants: selected, commentsCount: 6, cutoff: 0, asOf, completed: true, phase: "done", tone: "success", message: "",
    draws: [{ id: "d1", at, winners: [selected[2]], rosterHash: hash }], logs: [], roster: { canonical, hash },
    drawLog: [{ sequence: 1, drawId: "d1", rosterSha256: hash, manualIncluded: 1, manualExcluded: 2 }] }, at);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.settings.privateListRule, "visible-only");
  assert.deepEqual([record.summary.manualIncluded, record.summary.manualExcluded, record.summary.pending], [1, 2, 0]);
  assert.equal(record.manualOverrides.length, 3);
  const hidden = record.participants.find((person) => person.identityCode === "hidden");
  assert.deepEqual(hidden.listVisibility, { post: "private", comment: "private" });
  assert.deepEqual(hidden.manualOverride, { decision: "include", reason: "확인", decidedAt: new Date(at).toISOString(), automaticAtDecision: "private", automaticVerdict: "private" });
  assert.equal(record.participants.find((person) => person.identityCode === "author").listVisibility.post, "not-checked");
  assert.equal(record.draws[0].winners[0].manuallyIncluded, true);
  assert.equal(record.drawLog.entries[0].rosterSha256, record.rosterHash.sha256);
  assert.match(record.rosterHash.howToVerify, /overrides/);
  // Rebuild the hashed lists from the exported participants, as howToVerify describes.
  const compare = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  const roster = record.participants.filter((person) => person.included)
    .map((person) => [person.identityCode, person.entryCommentId, person.listVisibility.post, person.listVisibility.comment]).sort(compare);
  const decided = record.participants.filter((person) => person.manualOverride).map((person) => [person.identityCode, person.entryCommentId,
    person.manualOverride.decision, person.manualOverride.automaticVerdict, person.manualOverride.automaticAtDecision, person.manualOverride.reason, person.manualOverride.decidedAt]).sort(compare);
  const parsed = JSON.parse(record.rosterHash.canonical);
  assert.deepEqual(parsed.roster, roster);
  assert.deepEqual(parsed.overrides, decided);
  assert.equal(createHash("sha256").update(record.rosterHash.canonical, "utf8").digest("hex"), record.rosterHash.sha256);
});
