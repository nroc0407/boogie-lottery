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
    else if (!settings.includeGuests && comment.identityType === "ip") exclusion = "유동 제외 설정";
    people.set(key, { key, name: comment.authorName, identityType: comment.identityType, authorType: comment.authorType,
      firstCommentId: comment.id, commentCount: 1, content: comment.content, exclusion,
      postCount: 0, lastActivity: 0, evidenceUrl: "", status: exclusion ? "excluded" : "pending", reason: exclusion || "활동 확인 대기" });
  }
  return [...people.values()];
}

export function evaluateParticipants(participants, counts, minimum, complete) {
  return participants.map((person) => {
    if (person.exclusion) return { ...person };
    const activity = counts.get(person.key) || { count: 0, latest: 0, url: "" };
    const enough = activity.count >= minimum;
    return { ...person, postCount: activity.count, lastActivity: activity.latest, evidenceUrl: activity.url,
      status: enough ? "eligible" : complete ? "excluded" : "pending",
      reason: enough ? `활동 기준 충족 (최소 ${minimum}개)` : !complete ? "6개월 활동 확인 중" : activity.count === 0 ? "최근 6개월 작성글 없음" : `활동 기준 미달 (${activity.count}/${minimum}개)` };
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
