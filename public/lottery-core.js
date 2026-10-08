export function parsePostUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim().replace(/\\&/g, "&").replace(/&amp;/g, "&")); }
  catch { throw new Error("디시인사이드 게시글 주소를 입력해주세요."); }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "gall.dcinside.com" || url.username || url.password || url.port) {
    throw new Error("gall.dcinside.com의 공개 게시글 주소만 사용할 수 있습니다.");
  }
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
  if (!Number.isFinite(Number(asOf)) || !Number.isInteger(value) || value < 1
    || (unit === "months" ? value > 24 : unit === "days" ? value > 730 : true)) {
    throw new Error("평가기간은 1~24개월 또는 1~730일로 설정해주세요.");
  }
  const kst = new Date(Number(asOf) + 9 * 3_600_000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  if (unit === "days") return Date.UTC(year, month, kst.getUTCDate() - value + 1) - 9 * 3_600_000;
  const lastDay = new Date(Date.UTC(year, month - value + 1, 0)).getUTCDate();
  return Date.UTC(year, month - value, Math.min(kst.getUTCDate(), lastDay)) - 9 * 3_600_000;
}

export function periodLabel(settings) {
  return `최근 ${settings.periodValue ?? 6}${settings.periodUnit === "days" ? "일" : "개월"}`;
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
    people.set(key, { key, name: comment.authorName, identityType: comment.identityType, authorType: comment.authorType,
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
    if (rules.requirePublicGallog && activity.profileStatus !== "public") {
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
