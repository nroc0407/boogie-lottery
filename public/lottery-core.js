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

export function applyParticipantSelection(participants, manualExclusions = new Set()) {
  return participants.map((person) => {
    const manuallyExcluded = person.status === "eligible" && manualExclusions.has(person.key);
    return { ...person, automaticStatus: person.status, automaticReason: person.reason, manuallyExcluded,
      included: person.status === "eligible" && !manuallyExcluded,
      status: manuallyExcluded ? "excluded" : person.status,
      reason: manuallyExcluded ? "운영자 수동 불포함" : person.reason };
  });
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
    if (rules.requirePublicGallog && ["private", "missing"].includes(activity.profileStatus)) {
      const reason = activity.profileError || (activity.profileStatus === "private" ? "갤로그 비공개" : "연결할 갤로그 없음");
      return { ...person, profileStatus: activity.profileStatus, exclusion: reason, status: "excluded", reason };
    }
    if (rules.requirePublicGallog && !isReadableProfile(activity.profileStatus)) {
      return { ...person, profileStatus: activity.profileStatus || "unknown", status: "pending", reason: activity.profileError || "갤로그 공개 여부 확인 중" };
    }
    const postsComplete = activity.postsComplete ?? complete;
    const posts = activity.count || 0;
    const commentCount = activity.comments || 0;
    const postsMet = posts >= minPosts;
    const commentsMet = commentCount >= minComments;
    const total = posts + commentCount;
    const totalMet = total >= minTotal;
    const postsFailed = !postsMet && postsComplete;
    const commentsFailed = !commentsMet && activity.commentsComplete;
    const totalFailed = !totalMet && postsComplete && activity.commentsComplete;
    const enough = postsMet && commentsMet && totalMet;
    let reason;
    if (postsFailed) reason = posts === 0 ? `${period} 작성글 없음` : `작성글 기준 미달 (${posts}/${minPosts}개)`;
    else if (commentsFailed) reason = commentCount === 0 ? `${period} 작성댓글 없음` : `작성댓글 기준 미달 (${commentCount}/${minComments}개)`;
    else if (totalFailed) reason = `글+댓글 합계 미달 (${total}/${minTotal}개)`;
    else if (enough) reason = minPosts || minComments || minTotal ? `활동 기준 충족 (${criteriaLabel(rules)})` : "활동 검사 사용 안 함";
    else if (activity.commentError && (!commentsMet || !totalMet)) reason = activity.commentError;
    else if (activity.postError && (!postsMet || !totalMet)) reason = activity.postError;
    else reason = `${period} ${!postsMet ? "작성글" : !commentsMet ? "댓글" : "글+댓글 합계"} 활동 확인 중`;
    return { ...person, postCount: posts, activityCommentCount: commentCount, totalActivityCount: total, commentsChecked: Boolean(activity.commentsChecked),
      postsComplete: Boolean(postsComplete), commentsComplete: Boolean(activity.commentsComplete), profileStatus: activity.profileStatus,
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
  const state = () => ({ nextPage: 1, seen: new Set(), fingerprints: new Set(), malformed: false, complete: false, error: "" });
  return { wants: activityWants(settings), previousKind: "comment", states: { post: state(), comment: state() } };
}

export function createActivity() {
  return { count: 0, comments: 0, latest: 0, url: "" };
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

// First response for a participant: both list pages (post, comment) prove the gallog is readable.
export function applyAccessResult(scan, activity, access, context) {
  if (isReadableProfile(access.profileStatus) && (!Array.isArray(access.pages) || access.pages.length !== 2
    || access.pages[0].kind !== "post" || access.pages[1].kind !== "comment"
    || access.pages.some((page) => !isReadableProfile(page.visibility)))) throw new Error("갤로그 글·댓글 공개 여부를 확인할 수 없습니다.");
  activity.profileStatus = access.profileStatus;
  if (!isReadableProfile(access.profileStatus)) {
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
