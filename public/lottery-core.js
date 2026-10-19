function postUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim().replace(/\\&/g, "&").replace(/&amp;/g, "&")); }
  catch { throw new Error("디시인사이드 게시글 주소를 입력해주세요."); }
  if (!["http:", "https:"].includes(url.protocol) || !["gall.dcinside.com", "m.dcinside.com"].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error("디시인사이드 PC 또는 모바일 게시글 주소를 입력해주세요.");
  }
  return url;
}

export function parsePostInput(value) {
  const url = postUrl(value);
  const shared = url.pathname.match(url.hostname === "m.dcinside.com"
    ? /^\/board\/([\p{L}\p{N}_.-]{1,80})\/([1-9]\d{0,19})\/?$/u
    : /^\/([\p{L}\p{N}_.-]{1,80})\/([1-9]\d{0,19})\/?$/u);
  if (shared) {
    const desktop = new URL("https://gall.dcinside.com/board/view/");
    desktop.searchParams.set("id", shared[1]);
    desktop.searchParams.set("no", shared[2]);
    return parsePostUrl(desktop.href);
  }
  return parsePostUrl(url.href);
}

export function parsePostUrl(value) {
  const url = postUrl(value);
  if (url.hostname !== "gall.dcinside.com") throw new Error("지원하지 않는 모바일 주소 형식입니다. 게시글의 공유 주소를 복사해주세요.");
  const path = url.pathname.match(/^\/(?:(mgallery|mini)\/)?board\/view\/?$/);
  const id = url.searchParams.get("id") || "";
  const no = url.searchParams.get("no") || "";
  if (!path || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(id) || !/^[1-9]\d{0,19}$/.test(no)) {
    throw new Error("갤러리 ID와 게시글 번호가 있는 주소를 입력해주세요.");
  }
  const type = path[1] || "gallery";
  const normalized = new URL(`https://gall.dcinside.com/${type === "gallery" ? "" : `${type}/`}board/view/`);
  normalized.searchParams.set("id", id);
  normalized.searchParams.set("no", no);
  return { id, type, no, url: normalized.href };
}

export function sixMonthCutoff(asOf) {
  const kst = new Date(Number(asOf) + 9 * 3_600_000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() - 6;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(kst.getUTCDate(), lastDay), kst.getUTCHours(), kst.getUTCMinutes(), kst.getUTCSeconds(), kst.getUTCMilliseconds()) - 9 * 3_600_000;
}

export function evaluationCutoff(asOf, value = 6, unit = "months") {
  if (!Number.isFinite(Number(asOf)) || Number(asOf) <= 0) throw new Error("평가 시각을 확인해주세요.");
  if (unit === "all") return 0;
  if (unit !== "months" || !Number.isInteger(value) || value < 1 || value > 24) {
    throw new Error("평가기간은 제한 없음 또는 최근 1~24개월로 설정해주세요.");
  }
  const kst = new Date(Number(asOf) + 9 * 3_600_000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month - value + 1, 0)).getUTCDate();
  return Date.UTC(year, month - value, Math.min(kst.getUTCDate(), lastDay)) - 9 * 3_600_000;
}

export function periodLabel(settings) {
  return settings.periodUnit === "all" ? "기간 제한 없음" : `최근 ${settings.periodValue ?? 6}개월`;
}

export function activityCriteria(settings) {
  return settings.activityMode === "total"
    ? { minPosts: 0, minComments: 0, minTotal: settings.minTotal ?? 0 }
    : { minPosts: settings.minPosts ?? 0, minComments: settings.minComments ?? 0, minTotal: 0 };
}

export function criteriaLabel(settings) {
  const { minPosts, minComments, minTotal } = activityCriteria(settings);
  if (settings.activityMode === "total") return minTotal > 0 ? `글+댓글 합계 ${minTotal}개 이상` : "합계 기준 없음";
  const criteria = [];
  if (minPosts > 0) criteria.push(`글 ${minPosts}개 이상`);
  if (minComments > 0) criteria.push(`댓글 ${minComments}개 이상`);
  return criteria.length ? "개별 기준: " + criteria.join(" · ") + (criteria.length > 1 ? " (모두 충족)" : "") : "개별 기준 없음";
}

export function participantLabel(person) {
  return person.name + (person.identityCode ? " (" + person.identityCode + ")" : "");
}

export function isReadableProfile(status) { return status === "public" || status === "partial"; }
export function isListVisibility(value) { return value === "public" || value === "partial" || value === "private"; }

export const BOTH_PRIVATE_REASON = "갤로그 비공개 (글·댓글 모두)";
const LIST_NAMES = { post: "글", comment: "댓글" };
const VISIBILITY_NAMES = { public: "공개", partial: "일부공개", private: "비공개" };

// "글 공개 · 댓글 비공개" when the lists differ, otherwise the gallog's overall state.
export function profileVisibilityLabel(person) {
  const lists = person.listVisibility || {};
  if (person.profileStatus === "private") return "비공개";
  if (person.profileStatus === "missing") return "없음";
  if (isReadableProfile(person.profileStatus) && (lists.post === "private" || lists.comment === "private")) {
    return ["post", "comment"].map((kind) => LIST_NAMES[kind] + " " + (VISIBILITY_NAMES[lists[kind]] || "미확인")).join(" · ");
  }
  return person.profileStatus === "public" ? "공개" : person.profileStatus === "partial" ? "일부공개" : person.exclusion ? "—" : "미확인";
}

// Automatic verdict as [code, group label, short label]. Codes are stable and enter the roster hash.
export function verdictCategory(person) {
  const status = person.automaticStatus || person.status;
  const lists = person.listVisibility || {};
  if (status === "eligible") return ["eligible", "활동 기준 통과", "통과"];
  if (status === "pending") return ["pending", "미확인", "미확인"];
  if (person.profileStatus === "private") return ["private", "갤로그 비공개", "비공개"];
  if (person.exclusion === "게시글 작성자") return ["author", "게시글 작성자", "게시글 작성자"];
  if (person.profileStatus === "missing" || person.exclusion === "연결할 갤로그가 없는 참가자") return ["missing", "연결할 갤로그 없음", "갤로그 없음"];
  if (person.exclusion === "작성자 식별 불가") return ["unidentified", "작성자 식별 불가", "식별 불가"];
  if (person.exclusion === "유동 제외 설정") return ["guest", "유동 제외 설정", "유동"];
  if (lists.post === "private" || lists.comment === "private") return ["list-private", "목록 비공개로 기준 미달", "목록 비공개·기준 미달"];
  return ["activity", "활동 기준 미달", "기준 미달"];
}

// overrides: Map key → { decision: "include" | "exclude", reason, at, automaticAtDecision }.
// A manual decision applies to any participant and replaces the automatic verdict, which is kept alongside.
export function applyParticipantSelection(participants, overrides = new Map()) {
  return participants.map((person) => {
    const [verdict, , verdictLabel] = verdictCategory({ ...person, automaticStatus: person.status });
    const entry = overrides.get(person.key);
    const override = entry && ["include", "exclude"].includes(entry.decision) ? { ...entry } : null;
    const include = override?.decision === "include";
    const status = override ? (include ? "eligible" : "excluded") : person.status;
    return { ...person, automaticStatus: person.status, automaticReason: person.reason, automaticVerdict: verdict, automaticVerdictLabel: verdictLabel,
      manualOverride: override, manuallyIncluded: include, manuallyExcluded: override?.decision === "exclude",
      included: status === "eligible", status,
      reason: override ? (include ? "수동 포함" : "수동 불포함") + " · 원래: " + verdictLabel + (override.reason ? " · 사유: " + override.reason : "") : person.reason };
  });
}

export function createOverride(person, decision, reason = "", at = Date.now()) {
  if (!["include", "exclude"].includes(decision)) throw new Error("수동 판정은 포함 또는 불포함만 지정할 수 있습니다.");
  return { decision, reason: String(reason || "").trim().slice(0, 100), at, automaticAtDecision: verdictCategory({ ...person, automaticStatus: person.automaticStatus || person.status })[0] };
}

export function collectParticipants(comments, settings, postAuthorKey = "") {
  const people = new Map();
  const keyword = String(settings.keyword || "").trim().toLocaleLowerCase("ko-KR");
  for (const comment of comments) {
    if (!settings.includeReplies && comment.depth > 0) continue;
    if (keyword && !comment.content.toLocaleLowerCase("ko-KR").includes(keyword)) continue;
    const key = comment.authorKey || `unknown:${comment.id}`;
    const existing = people.get(key);
    if (existing) { existing.commentCount += 1; continue; }
    let exclusion = "";
    if (!comment.authorKnown) exclusion = "작성자 식별 불가";
    else if (settings.excludeAuthor && key === postAuthorKey) exclusion = "게시글 작성자";
    else if (settings.requirePublicGallog && comment.identityType !== "uid") exclusion = "연결할 갤로그가 없는 참가자";
    else if (!settings.includeGuests && comment.identityType === "ip") exclusion = "유동 제외 설정";
    people.set(key, { key, name: comment.authorName, identityCode: comment.identityCode || "", identityType: comment.identityType, authorType: comment.authorType,
      firstCommentId: comment.id, firstCommentPage: comment.sourcePage || 1, commentCount: 1, content: comment.content, exclusion,
      postCount: 0, activityCommentCount: 0, totalActivityCount: 0, commentsChecked: false, lastActivity: 0, evidenceUrl: "",
      status: exclusion ? "excluded" : "pending", reason: exclusion || "활동 확인 대기" });
  }
  return [...people.values()];
}

export function evaluateParticipants(participants, counts, minimum, complete) {
  const rules = typeof minimum === "number" ? { minPosts: minimum, minComments: 0, periodValue: 6 } : minimum;
  const { minPosts, minComments, minTotal } = activityCriteria(rules);
  const period = periodLabel(rules);
  return participants.map((person) => {
    if (person.exclusion) return { ...person };
    const activity = counts.get(person.key) || { count: 0, latest: 0, url: "" };
    const lists = activity.listVisibility || {};
    const listVisibility = { post: lists.post || "", comment: lists.comment || "" };
    const postPrivate = lists.post === "private";
    const commentPrivate = lists.comment === "private";
    if (rules.requirePublicGallog && (["private", "missing"].includes(activity.profileStatus) || (postPrivate && commentPrivate))) {
      const missing = activity.profileStatus === "missing";
      const reason = activity.profileError || (missing ? "연결할 갤로그 없음" : postPrivate && commentPrivate ? BOTH_PRIVATE_REASON : "갤로그 비공개");
      return { ...person, profileStatus: missing ? "missing" : "private", listVisibility, exclusion: reason, status: "excluded", reason };
    }
    if (rules.requirePublicGallog && !isReadableProfile(activity.profileStatus)) {
      return { ...person, profileStatus: activity.profileStatus || "unknown", listVisibility, status: "pending", reason: activity.profileError || "갤로그 공개 여부 확인 중" };
    }
    // One private list counts as 0 and is fully known; the verdict uses the visible list only.
    const note = postPrivate ? "글 목록 비공개 — 댓글 목록만으로 판정" : commentPrivate ? "댓글 목록 비공개 — 글 목록만으로 판정" : "";
    const withNote = (text) => note ? text + " · " + note : text;
    const postsComplete = postPrivate || (activity.postsComplete ?? complete);
    const commentsComplete = commentPrivate || Boolean(activity.commentsComplete);
    const posts = postPrivate ? 0 : activity.count || 0;
    const commentCount = commentPrivate ? 0 : activity.comments || 0;
    const postsMet = posts >= minPosts;
    const commentsMet = commentCount >= minComments;
    const total = posts + commentCount;
    const totalMet = total >= minTotal;
    const postsFailed = !postsMet && postsComplete;
    const commentsFailed = !commentsMet && commentsComplete;
    const totalFailed = !totalMet && postsComplete && commentsComplete;
    const enough = postsMet && commentsMet && totalMet;
    let reason;
    if (postsFailed) reason = postPrivate ? `글 목록 비공개로 작성글 기준 미달 (0/${minPosts}개)` : posts === 0 ? `${period} 작성글 없음` : `작성글 기준 미달 (${posts}/${minPosts}개)`;
    else if (commentsFailed) reason = commentPrivate ? `댓글 목록 비공개로 작성댓글 기준 미달 (0/${minComments}개)` : commentCount === 0 ? `${period} 작성댓글 없음` : `작성댓글 기준 미달 (${commentCount}/${minComments}개)`;
    else if (totalFailed) reason = withNote(`글+댓글 합계 미달 (${total}/${minTotal}개)`);
    else if (enough) reason = withNote(minPosts || minComments || minTotal ? `활동 기준 충족 (${criteriaLabel(rules)})` : "활동 검사 사용 안 함");
    else if (activity.commentError && (!commentsMet || !totalMet)) reason = activity.commentError;
    else if (activity.postError && (!postsMet || !totalMet)) reason = activity.postError;
    else reason = withNote(`${period} ${!postsMet ? "작성글" : !commentsMet ? "댓글" : "글+댓글 합계"} 활동 확인 중`);
    return { ...person, postCount: posts, activityCommentCount: commentCount, totalActivityCount: total, commentsChecked: Boolean(activity.commentsChecked) || commentPrivate,
      postsComplete: Boolean(postsComplete), commentsComplete, profileStatus: activity.profileStatus, listVisibility,
      lastActivity: activity.latest, evidenceUrl: activity.url,
      status: postsFailed || commentsFailed || totalFailed ? "excluded" : enough ? "eligible" : "pending", reason };
  });
}

function randomBelow(upper, cryptoSource) {
  const bound = Math.floor(0x1_0000_0000 / upper) * upper;
  const word = new Uint32Array(1);
  do { cryptoSource.getRandomValues(word); } while (word[0] >= bound);
  return word[0] % upper;
}

export function pickWinners(participants, count, cryptoSource = globalThis.crypto) {
  if (participants.some((person) => person.status === "pending")) throw new Error("활동이 미확인된 참가자가 있어 추첨을 보류합니다.");
  const eligible = participants.filter((person) => person.status === "eligible");
  if (!Number.isInteger(count) || count < 1 || count > eligible.length) throw new Error(`당첨 인원은 통과 후보 ${eligible.length}명 이하로 설정해주세요.`);
  const keys = new Set(eligible.map((person) => person.key));
  if (keys.size !== eligible.length) throw new Error("중복 참가자가 있습니다. 댓글을 다시 확인해주세요.");
  const pool = [...eligible];
  for (let index = 0; index < count; index += 1) {
    const selected = index + randomBelow(pool.length - index, cryptoSource);
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
  }
  return pool.slice(0, count);
}

// Gallog activity scan state. Pure functions shared by the browser and the tests.
export const MAX_PROFILE_PAGES = 2000;

export function activityWants(settings) {
  return { post: settings.minPosts > 0 || settings.minTotal > 0, comment: settings.minComments > 0 || settings.minTotal > 0 };
}

export function createActivityScan(settings) {
  const state = () => ({ nextPage: 1, seen: new Set(), fingerprints: new Set(), malformed: false, complete: false, private: false, error: "" });
  return { wants: activityWants(settings), previousKind: "comment", states: { post: state(), comment: state() } };
}

export function createActivity() {
  return { count: 0, comments: 0, latest: 0, url: "", listVisibility: { post: "", comment: "" } };
}

// A private list is complete with 0 records: nothing more to read, nothing to hold for.
function markListPrivate(scan, activity, kind) {
  const state = scan.states[kind];
  Object.assign(state, { private: true, complete: true, nextPage: null, error: "" });
  activity.listVisibility ||= { post: "", comment: "" };
  activity.listVisibility[kind] = "private";
  if (activity.listVisibility.post === "private" && activity.listVisibility.comment === "private") {
    activity.profileStatus = "private";
    activity.profileError = BOTH_PRIVATE_REASON;
  }
}

export function syncActivityCoverage(scan, activity) {
  activity.postsComplete = scan.states.post.complete;
  activity.commentsComplete = scan.states.comment.complete;
  activity.postError = scan.states.post.error;
  activity.commentError = scan.states.comment.error;
}

// Applies gallog pages in order. Returns how many pages of each kind were counted.
// Throws when the server response does not line up with the scan, so the caller can hold the participant.
export function consumeActivityPages(scan, activity, pages, { post, cutoff, asOf }) {
  const consumed = { post: 0, comment: 0 };
  for (const page of pages) {
    const state = scan.states[page.kind];
    if (!state || page.page !== state.nextPage || !Array.isArray(page.entries)
      || (page.nextPage !== null && page.nextPage !== page.page + 1)) throw new Error("갤로그 페이지 정보를 확인할 수 없습니다.");
    if (page.visibility === "private") {
      markListPrivate(scan, activity, page.kind);
      if (scan.wants[page.kind]) consumed[page.kind] += 1;
      continue;
    }
    if (isReadableProfile(page.visibility)) {
      activity.listVisibility ||= { post: "", comment: "" };
      if (activity.listVisibility[page.kind] !== "partial") activity.listVisibility[page.kind] = page.visibility;
    }
    if (!scan.wants[page.kind]) continue;
    consumed[page.kind] += 1;
    if (page.kind === "comment") activity.commentsChecked = true;
    if (page.unavailableReason) {
      state.error = page.unavailableReason;
      state.nextPage = null;
      continue;
    }
    if (!page.fingerprint || (page.fingerprint !== "empty" && state.fingerprints.has(page.fingerprint))) {
      state.error = "갤로그 페이지가 반복되어 활동 확인을 보류합니다.";
      state.nextPage = null;
      continue;
    }
    state.fingerprints.add(page.fingerprint);
    state.malformed ||= page.malformed;
    for (const item of page.entries) {
      if (state.seen.has(item.id)) continue;
      const target = parsePostUrl(item.url);
      if (target.id !== post.id || target.type !== post.type || target.no === post.no
        || !item.ts || item.ts < cutoff || item.ts > asOf) throw new Error("해당 갤러리의 활동 기록을 확인할 수 없습니다.");
      state.seen.add(item.id);
      if (page.kind === "post") activity.count += 1;
      else activity.comments += 1;
      if (item.ts > activity.latest) { activity.latest = item.ts; activity.url = target.url; }
    }
    state.nextPage = page.nextPage;
    if (page.boundary || !state.nextPage) {
      state.complete = !state.malformed && (page.boundary || page.paginationKnown);
      state.nextPage = null;
      if (!state.complete) state.error = "갤로그 날짜·페이지 정보가 불완전해 활동 확인을 보류합니다.";
    }
  }
  syncActivityCoverage(scan, activity);
  return consumed;
}

// First response for a participant: both list pages (post, comment) show each list's visibility.
// One private list is read as 0 records; both private makes the gallog private.
export function applyAccessResult(scan, activity, access, context) {
  if (isReadableProfile(access.profileStatus) && (!Array.isArray(access.pages) || access.pages.length !== 2
    || access.pages[0].kind !== "post" || access.pages[1].kind !== "comment"
    || access.pages.some((page) => !isListVisibility(page.visibility))
    || access.pages.every((page) => page.visibility === "private"))) throw new Error("갤로그 글·댓글 공개 여부를 확인할 수 없습니다.");
  activity.profileStatus = access.profileStatus;
  activity.listVisibility ||= { post: "", comment: "" };
  if (!isReadableProfile(access.profileStatus)) {
    for (const kind of ["post", "comment"]) if (isListVisibility(access.listVisibility?.[kind])) activity.listVisibility[kind] = access.listVisibility[kind];
    activity.profileError = access.unavailableReason || access.error || "갤로그 공개 여부를 확인할 수 없어 보류합니다.";
    return { post: 0, comment: 0 };
  }
  return consumeActivityPages(scan, activity, access.pages, context);
}

// Next gallog list request, alternating post/comment lists, or null when nothing can change the verdict.
export function nextActivityRequest(scan, activity, settings) {
  for (;;) {
    const available = ["post", "comment"].filter((kind) => scan.wants[kind] && scan.states[kind].nextPage && !scan.states[kind].error
      && (settings.minTotal > 0 || (kind === "post" ? activity.count < settings.minPosts : activity.comments < settings.minComments)));
    if (!available.length) return null;
    const kind = available.find((value) => value !== scan.previousKind) || available[0];
    scan.previousKind = kind;
    const state = scan.states[kind];
    if (state.nextPage > MAX_PROFILE_PAGES) {
      state.error = "갤로그 2,000페이지 제한으로 활동 확인을 보류합니다.";
      state.nextPage = null;
      syncActivityCoverage(scan, activity);
      continue;
    }
    return { kind, startPage: state.nextPage, count: Math.min(3, MAX_PROFILE_PAGES - state.nextPage + 1) };
  }
}

// action: "stop" (verdict fixed by profile state), "retry" (transient failure; request again from state.nextPage) or "continue".
export function applyActivityResult(scan, activity, kind, data, context, { canRetry = false } = {}) {
  // The requested list turned private: it counts as 0 and the other list keeps its verdict.
  if (data.profileStatus === "private" && data.listVisibility?.[kind] === "private") {
    markListPrivate(scan, activity, kind);
    syncActivityCoverage(scan, activity);
    return { action: activity.profileStatus === "private" ? "stop" : "continue", consumed: { post: 0, comment: 0 } };
  }
  if (["private", "missing"].includes(data.profileStatus)) {
    activity.profileStatus = data.profileStatus;
    activity.profileError = data.unavailableReason;
    return { action: "stop", consumed: { post: 0, comment: 0 } };
  }
  const state = scan.states[kind];
  const transient = canRetry && data.retryable === true;
  const consumed = { post: 0, comment: 0 };
  if (!Array.isArray(data.pages) || !data.pages.length) {
    if (transient) return { action: "retry", consumed };
    state.error = data.unavailableReason || data.error || "갤로그 활동 목록을 읽지 못해 보류합니다.";
    state.nextPage = null;
    syncActivityCoverage(scan, activity);
    return { action: "continue", consumed };
  }
  if (data.profileStatus === "partial") activity.profileStatus = "partial";
  Object.assign(consumed, consumeActivityPages(scan, activity, data.pages, context));
  if (data.error || data.profileStatus === "unknown") {
    if (transient && state.nextPage) return { action: "retry", consumed };
    state.error = data.error || data.unavailableReason || "갤로그 접근 오류로 확인을 보류합니다.";
    state.complete = false;
    state.nextPage = null;
    syncActivityCoverage(scan, activity);
  }
  return { action: "continue", consumed };
}

// A failed check never turns into an exclusion: the participant stays unverified with the reason.
export function recordActivityFailure(activity, message) {
  if (!isReadableProfile(activity.profileStatus)) {
    activity.profileStatus = "unknown";
    activity.profileError = message;
  } else {
    activity.postError ||= message;
    activity.commentError ||= message;
  }
}

// Classifies a failed call to our own API. retryable: try again with backoff.
// rate_limit and upstream_blocked carry the wait the server asked for.
export function classifyApiFailure({ status = 0, body = null, networkError = false, parseError = false, retryAfter = "" } = {}) {
  const hint = Number(body?.retryAfter ?? retryAfter);
  const retryAfterMs = Number.isFinite(hint) && hint > 0 ? Math.min(hint, 300) * 1000 : 0;
  if (networkError) return { kind: "network", retryable: true, retryAfterMs: 0,
    message: "네트워크 연결이 끊겨 서버에 요청하지 못했습니다. 연결 상태를 확인해주세요." };
  if (status === 429) return { kind: "rate_limit", retryable: true, retryAfterMs: retryAfterMs || 60_000,
    message: "요청이 많아 서버가 잠시 제한했습니다. " + Math.ceil((retryAfterMs || 60_000) / 1000) + "초 뒤 다시 시도해주세요." };
  if (body?.errorKind === "upstream_blocked") return { kind: "upstream_blocked", retryable: false, retryAfterMs: retryAfterMs || 60_000,
    message: "디시인사이드가 요청을 일시적으로 제한했습니다. 몇 분 뒤 다시 시도해주세요." };
  if (parseError) {
    const timeout = status === 504 || status === 0 || status >= 500;
    return { kind: timeout ? "timeout" : "invalid_response", retryable: timeout || status === 200,
      message: timeout ? "서버 처리 시간이 초과되었거나 응답이 중간에 끊겼습니다 (HTTP " + status + ")."
        : "서버 응답 형식을 읽을 수 없습니다 (HTTP " + status + ")." };
  }
  if (body?.errorKind === "time_budget") return { kind: "time_budget", retryable: true, retryAfterMs: 0,
    message: "서버 처리 시간이 길어 이어서 조회합니다." };
  if (status === 504) return { kind: "timeout", retryable: true, retryAfterMs: 0,
    message: body?.error || "서버 처리 시간이 초과되었습니다." };
  if (status === 502 || status === 503) return { kind: "server", retryable: body?.retryable !== false, retryAfterMs: 0,
    message: body?.error || "서버가 일시적으로 응답하지 못했습니다 (HTTP " + status + ")." };
  if (status === 403 && body?.errorKind === "forbidden_origin") return { kind: "forbidden", retryable: false, retryAfterMs: 0,
    message: body.error || "허용되지 않은 요청 출처입니다." };
  return { kind: status >= 500 ? "server" : "client", retryable: false, retryAfterMs: 0,
    message: body?.error || "요청 실패 (HTTP " + status + ")" };
}

export function retryBackoffMs(attempt, random = Math.random) {
  return Math.min(6000, 1200 * 2 ** Math.max(0, attempt - 1)) + Math.floor(random() * 400);
}

// Canonical text of the final included roster, its per-list gallog visibility, every manual decision and the draw
// settings. Hashing it with SHA-256 gives a fingerprint anyone can recompute from the exported JSON: same roster,
// decisions and settings, same hash, regardless of the order participants were collected or selected in.
export function listVisibilityCode(person, kind) {
  const value = person.listVisibility?.[kind];
  return isListVisibility(value) ? value : "not-checked";
}
export function overrideRecord(person) {
  const override = person.manualOverride;
  if (!override) return null;
  return { decision: override.decision, reason: override.reason || "", decidedAt: new Date(override.at).toISOString(),
    automaticAtDecision: override.automaticAtDecision || "", automaticVerdict: person.automaticVerdict || verdictCategory(person)[0] };
}
export function rosterCanonical({ post, settings, participants, cutoff, asOf, winnerCount = settings.winnerCount }) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byIdentity = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]);
  const roster = participants.filter((person) => person.included ?? person.status === "eligible")
    .map((person) => [String(person.identityCode || ""), String(person.firstCommentId), listVisibilityCode(person, "post"), listVisibilityCode(person, "comment")])
    .sort(byIdentity);
  const overrides = participants.filter((person) => person.manualOverride).map((person) => {
    const record = overrideRecord(person);
    return [String(person.identityCode || ""), String(person.firstCommentId), record.decision, record.automaticVerdict, record.automaticAtDecision, record.reason, record.decidedAt];
  }).sort(byIdentity);
  const { minPosts, minComments, minTotal } = activityCriteria(settings);
  const unlimited = settings.periodUnit === "all";
  return JSON.stringify({
    format: "boogie-roster", version: 2, post: post.url,
    period: { unit: settings.periodUnit, months: unlimited ? null : settings.periodValue,
      from: unlimited ? null : new Date(cutoff).toISOString(), through: new Date(asOf).toISOString() },
    criteria: { mode: settings.activityMode, minPosts, minComments, minTotal, privateList: "visible-only" },
    winnerCount, roster, overrides,
  });
}

export async function sha256Hex(value, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("이 브라우저에서는 SHA-256을 계산할 수 없습니다.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function shortFingerprint(hash) {
  return hash ? hash.slice(0, 12).match(/.{4}/g).join("-") : "";
}

export const ROSTER_VERIFY_NOTE = "포함(included: true) 참가자의 [identityCode, entryCommentId, listVisibility.post, listVisibility.comment] 목록을 정렬한 값이 canonical의 roster와, "
  + "manualOverride가 있는 참가자의 [identityCode, entryCommentId, decision, automaticVerdict, automaticAtDecision, reason, decidedAt] 목록을 정렬한 값이 canonical의 overrides와 같은지 확인합니다. "
  + "목록 공개 상태가 없으면 not-checked입니다. 그다음 canonical 문자열을 UTF-8 그대로 SHA-256으로 계산하면 sha256 값과 같아야 합니다.";
