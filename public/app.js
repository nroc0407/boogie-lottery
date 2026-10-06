import { parsePostUrl, evaluationCutoff, periodLabel, criteriaLabel, collectParticipants, evaluateParticipants, pickWinners } from "/lottery-core.js";

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 2000;
let controller = null;
let post = null;
let comments = [];
let participants = [];
let counts = new Map();
let scanPages = 0;
let commentScanPages = 0;
let oldest = 0;
let undated = 0;
let activityComplete = false;
let completed = false;
let drawn = null;
let settings = null;
let asOf = 0;
let cutoff = 0;
let phase = "idle";

function number(value) { return Number(value || 0).toLocaleString("ko-KR"); }
function date(value) { return value ? new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "—"; }
function status(message, tone = "loading", detail = "") {
  $("status-banner").hidden = false;
  $("status-banner").className = "status-banner" + (tone === "error" ? " is-error" : tone === "success" ? " is-success" : "");
  $("status-text").textContent = message;
  $("status-pages").textContent = detail;
}
function setRunning(value) {
  $("start-button").disabled = value;
  $("stop-button").hidden = !value;
  $("stop-button").disabled = !value;
  for (const input of $("analysis-form").querySelectorAll("input, select")) input.disabled = value;
  $("example-button").disabled = value;
  $("start-label").textContent = value ? "댓글 확인 · 활동 검사 중" : "자동 추첨 시작";
  $("redraw-button").disabled = value || !completed || participants.some((p) => p.status === "pending")
    || participants.filter((p) => p.status === "eligible").length < (settings?.winnerCount || 1);
}
function setPhase(value) {
  phase = value;
  for (const step of document.querySelectorAll("[data-step]")) {
    const order = ["comments", "activity", "draw"];
    const index = order.indexOf(value);
    step.classList.toggle("is-active", step.dataset.step === value);
    step.classList.toggle("is-done", order.indexOf(step.dataset.step) < index || value === "done");
  }
}
async function wait(ms, signal) {
  if (signal.aborted) throw new DOMException("중단", "AbortError");
  await new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException("중단", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function api(path, body, signal) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal });
  let result;
  try { result = await response.json(); } catch { throw new Error("서버 응답을 읽을 수 없습니다."); }
  if (!response.ok) throw new Error(result.error || ("요청 실패 (HTTP " + response.status + ")"));
  return result;
}
function settingsFromForm() {
  const target = parsePostUrl($("post-url").value);
  const minPosts = Number($("min-posts").value);
  const minComments = Number($("min-comments").value);
  const periodValue = Number($("period-value").value);
  const periodUnit = $("period-unit").value;
  const winnerCount = Number($("winner-count").value);
  for (const value of [minPosts, minComments]) {
    if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error("최소 글·댓글 수는 0~1,000개로 설정해주세요.");
  }
  evaluationCutoff(Date.now(), periodValue, periodUnit);
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 100) throw new Error("당첨 인원은 1~100명으로 설정해주세요.");
  return { ...target, minPosts, minComments, periodValue, periodUnit, winnerCount, includeGuests: $("include-guests").checked,
    includeReplies: $("include-replies").checked, excludeAuthor: $("exclude-author").checked, keyword: $("keyword").value.trim() };
}
async function run(event) {
  event.preventDefault();
  if (controller) return;
  let input;
  try { input = settingsFromForm(); } catch (error) { status(error.message, "error"); return; }
  settings = input;
  post = input;
  comments = [];
  participants = [];
  counts = new Map();
  scanPages = 0;
  commentScanPages = 0;
  oldest = 0;
  undated = 0;
  activityComplete = false;
  completed = false;
  drawn = null;
  asOf = Date.now();
  cutoff = evaluationCutoff(asOf, settings.periodValue, settings.periodUnit);
  const sessionKey = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  controller = new AbortController();
  const signal = controller.signal;
  $("welcome").hidden = true;
  $("results").hidden = false;
  setRunning(true);
  setPhase("comments");
  render();
  try {
    const commentIds = new Set();
    let nextCommentPage = 1;
    while (nextCommentPage) {
      if (nextCommentPage > 100) throw new Error("댓글이 100페이지를 넘어 전체 참가자를 확인할 수 없습니다. 추첨을 보류합니다.");
      status("게시글의 댓글 작성자를 모으고 있습니다.", "loading", "댓글 " + nextCommentPage + "페이지");
      const data = await api("/api/comments", { postUrl: settings.url, sessionKey, startPage: nextCommentPage, count: Math.min(3, 101 - nextCommentPage) }, signal);
      post = data.post;
      if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("댓글 페이지 정보가 없습니다.");
      for (const page of data.pages) {
        for (const comment of page.comments) {
          if (commentIds.has(comment.id)) continue;
          commentIds.add(comment.id);
          comments.push({ ...comment, sourcePage: page.page });
        }
        nextCommentPage = page.nextPage;
      }
      participants = collectParticipants(comments, settings, post.authorKey);
      render();
      if (nextCommentPage) await wait(350, signal);
    }
    if (!comments.length) throw new Error("이 게시글에는 수집 가능한 댓글이 없습니다.");
    if (!participants.length) throw new Error("댓글 포함 조건에 맞는 참가자가 없습니다.");
    setPhase("activity");
    const checkable = participants.filter((person) => !person.exclusion);
    if (!checkable.length) {
      participants = evaluateParticipants(participants, counts, settings, true);
      completed = true;
      throw new Error("참가 조건을 통과한 댓글 작성자가 없습니다. 유동·대댓글·키워드 설정을 확인해주세요.");
    }
    if (settings.minPosts > 0) await scanPostActivity(sessionKey, signal, checkable);
    refreshParticipants();
    if (settings.minComments > 0) await scanCommentActivity(sessionKey, signal);
    refreshParticipants();
    completed = true;
    render();
    if (participants.some((person) => person.status === "pending")) {
      throw new Error("선택한 기간의 글·댓글 활동을 확인하지 못한 참가자가 있어 추첨을 보류합니다. 참가자 표의 사유를 확인해주세요.");
    }
    makeDraw();
    status("댓글 참가자 활동 확인과 자동 추첨을 마쳤습니다.", "success", periodLabel(settings) + " · " + criteriaLabel(settings));
  } catch (error) {
    status(error.name === "AbortError" ? "확인을 중단했습니다. 미확인 참가자가 있어 자동 추첨을 진행하지 않았습니다." : error.message,
      error.name === "AbortError" ? "success" : "error");
  } finally {
    controller = null;
    setRunning(false);
    render();
  }
}

function refreshParticipants() {
  participants = evaluateParticipants(participants, counts, settings, activityComplete);
  render();
}
function activityFor(key) {
  if (!counts.has(key)) counts.set(key, { count: 0, comments: 0, latest: 0, url: "" });
  return counts.get(key);
}
async function scanPostActivity(sessionKey, signal, checkable) {
  let emptyStreak = 0;
  const seenPosts = new Set();
  const keys = new Set(checkable.map((person) => person.key));
  const allMet = () => checkable.every((person) => activityFor(person.key).count >= settings.minPosts);
  for (let startPage = 1; startPage <= MAX_PAGES; startPage += 5) {
    status("댓글 참가자의 " + periodLabel(settings) + " 작성글을 확인하고 있습니다.", "loading", number(scanPages) + "페이지 확인");
    const data = await api("/api/pages", { galleryId: post.id, galleryType: post.type, sessionKey, startPage, count: Math.min(5, MAX_PAGES - startPage + 1) }, signal);
    if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("활동 목록 페이지 정보가 없습니다.");
    let boundary = false;
    for (const page of data.pages) {
      scanPages = page.page;
      emptyStreak = page.posts.length ? 0 : emptyStreak + 1;
      const dated = page.posts.filter((item) => item.ts > 0 && item.ts <= asOf);
      if (dated.length) oldest = oldest ? Math.min(oldest, ...dated.map((item) => item.ts)) : Math.min(...dated.map((item) => item.ts));
      if (dated.length && dated.every((item) => item.ts < cutoff)) boundary = true;
      for (const item of page.posts) {
        if (seenPosts.has(item.postNo)) continue;
        seenPosts.add(item.postNo);
        if (!item.ts) { undated += 1; continue; }
        if (item.postNo === post.no || item.ts < cutoff || item.ts > asOf || !keys.has(item.authorKey)) continue;
        const current = activityFor(item.authorKey);
        current.count += 1;
        if (item.ts > current.latest) { current.latest = item.ts; current.url = item.url; }
      }
      if (boundary || emptyStreak >= 2) activityComplete = undated === 0;
      refreshParticipants();
      if (boundary || emptyStreak >= 2 || allMet()) break;
    }
    if (boundary || emptyStreak >= 2 || allMet()) break;
    if (startPage + 5 <= MAX_PAGES) await wait(350, signal);
  }
}
async function scanCommentActivity(sessionKey, signal) {
  const candidates = participants.filter((person) => !person.exclusion && person.status !== "excluded");
  for (let index = 0; index < candidates.length; index += 1) {
    const person = candidates[index];
    const activity = activityFor(person.key);
    if (person.identityType !== "uid") {
      activity.commentError = "유동·미식별 참가자의 댓글 활동을 확인할 수 없어 보류합니다.";
      refreshParticipants();
      continue;
    }
    let nextPage = 1;
    let malformed = false;
    const seenComments = new Set();
    try {
      while (nextPage && activity.comments < settings.minComments) {
        if (nextPage > MAX_PAGES) { activity.commentError = "갤로그 2,000페이지 제한으로 댓글 활동이 미확인입니다."; break; }
        status(person.name + "님의 " + periodLabel(settings) + " 댓글 활동을 확인하고 있습니다.", "loading", (index + 1) + "/" + candidates.length + "명 · " + nextPage + "페이지");
        const data = await api("/api/comment-activity", { postUrl: post.url, sessionKey, authorKey: person.key,
          sourcePage: person.firstCommentPage, startPage: nextPage,
          count: Math.min(settings.minComments - activity.comments > 40 ? 3 : 1, MAX_PAGES - nextPage + 1) }, signal);
        if (data.unavailableReason) { activity.commentError = data.unavailableReason; break; }
        if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("댓글 활동 페이지 정보가 없습니다.");
        for (const page of data.pages) {
          commentScanPages += 1;
          if (page.unavailableReason) { activity.commentError = page.unavailableReason; nextPage = null; break; }
          activity.commentsChecked = true;
          malformed ||= page.malformed;
          const dated = page.comments.filter((item) => item.ts > 0 && item.ts <= asOf);
          const boundary = dated.length > 0 && dated.every((item) => item.ts < cutoff);
          for (const item of page.comments) {
            if (seenComments.has(item.id)) continue;
            seenComments.add(item.id);
            if (!item.sameGallery || item.postNo === post.no || !item.ts || item.ts < cutoff || item.ts > asOf) continue;
            activity.comments += 1;
            if (item.ts > activity.latest) activity.latest = item.ts;
          }
          nextPage = page.nextPage;
          if (boundary || !nextPage) {
            activity.commentsComplete = !malformed && (boundary || page.paginationKnown);
            if (!activity.commentsComplete) activity.commentError = "댓글 날짜·페이지 정보를 확인할 수 없어 보류합니다.";
            nextPage = null;
          }
          refreshParticipants();
          if (!nextPage || activity.comments >= settings.minComments) break;
        }
        if (nextPage && activity.comments < settings.minComments) await wait(650, signal);
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      activity.commentError = error.message;
    }
    refreshParticipants();
    if (index + 1 < candidates.length) await wait(650, signal);
  }
}
function makeDraw() {
  const winners = pickWinners(participants, settings.winnerCount);
  drawn = { id: crypto.randomUUID(), at: Date.now(), winners };
  setPhase("done");
  render();
}
function redraw() {
  if (controller || !completed) return;
  try { makeDraw(); status("같은 통과 후보에서 다시 추첨했습니다.", "success"); }
  catch (error) { status(error.message, "error"); }
}
function commentLink(person) {
  const link = new URL(post.url);
  link.searchParams.set("fcno", person.firstCommentId);
  return link.href;
}
function renderRows() {
  const tbody = $("participant-table");
  tbody.replaceChildren();
  for (const person of participants) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const nameLink = document.createElement("a");
    nameLink.href = commentLink(person);
    nameLink.target = "_blank";
    nameLink.rel = "noopener noreferrer";
    nameLink.className = "participant-name";
    nameLink.textContent = person.name;
    nameCell.append(nameLink);
    const cells = [person.identityType === "uid" ? "로그인 계정" : person.identityType === "ip" ? "유동" : "미식별",
      person.commentCount + "개", settings.minPosts > 0 ? number(person.postCount) : "—",
      person.commentsChecked ? number(person.activityCommentCount) : "—", date(person.lastActivity)];
    row.append(nameCell);
    for (const value of cells) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    const resultCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "result-pill " + person.status;
    pill.textContent = person.status === "eligible" ? "통과" : person.status === "pending" ? "확인 중" : "제외";
    const reason = document.createElement("small");
    reason.className = "result-reason";
    reason.textContent = person.reason;
    resultCell.append(pill, reason);
    row.append(resultCell);
    tbody.append(row);
  }
  $("participants-empty").hidden = participants.length > 0;
}
function renderWinners() {
  $("winner-section").hidden = !drawn;
  const list = $("winner-list");
  list.replaceChildren();
  if (!drawn) return;
  drawn.winners.forEach((person, index) => {
    const article = document.createElement("article");
    article.className = "winner-card";
    const place = document.createElement("span");
    place.className = "winner-rank";
    place.textContent = String(index + 1).padStart(2, "0");
    const link = document.createElement("a");
    link.textContent = person.name;
    link.href = commentLink(person);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const detail = document.createElement("small");
    detail.textContent = (settings.minPosts > 0 ? "작성글 " + person.postCount + "개 · " : "")
      + (settings.minComments > 0 ? "작성댓글 " + person.activityCommentCount + "개 · " : "") + "참여 댓글 " + person.commentCount + "개";
    article.append(place, link, detail);
    list.append(article);
  });
  $("draw-detail").textContent = new Date(drawn.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " · 추첨 번호 " + drawn.id.slice(0, 8);
}
function render() {
  if ($("results").hidden) return;
  const eligible = participants.filter((person) => person.status === "eligible").length;
  const excluded = participants.filter((person) => person.status === "excluded").length;
  const pending = participants.filter((person) => person.status === "pending").length;
  $("report-title").textContent = post?.title || "댓글 참가자 확인";
  $("report-subtitle").textContent = post ? post.id + " 갤러리 · " + post.no + "번 글 · " + date(cutoff) + " ~ " + date(asOf) : "";
  $("source-post").href = post?.url || "#";
  $("metric-comments").textContent = number(comments.length);
  $("metric-participants").textContent = number(participants.length);
  $("metric-eligible").textContent = number(eligible);
  $("metric-pending").textContent = number(pending);
  $("participant-count").textContent = number(participants.length) + "명 · 제외 " + excluded + "명";
  $("coverage-label").textContent = periodLabel(settings) + " · " + criteriaLabel(settings);
  $("coverage-detail").textContent = "작성글 목록 " + number(scanPages) + "페이지 · 갤로그 댓글 " + number(commentScanPages) + "페이지 확인"
    + (activityComplete ? " · 작성글 기간 확인 완료" : oldest ? " · 가장 오래된 작성글 " + date(oldest) : "");
  $("coverage-state").textContent = drawn ? "추첨 완료" : phase === "comments" ? "댓글 수집" : pending ? "활동 확인" : completed ? "확인 완료" : "대기";
  $("result-note").textContent = "댓글 여러 개를 남겨도 1명으로 참여합니다. 활동은 선택한 갤러리의 공개 작성글·댓글로 확인하며, 나눔 글과 그 글의 참여 댓글은 활동에서 제외합니다. 0개로 설정한 항목은 조회하지 않습니다. "
    + (settings?.includeGuests ? "유동은 공개 IP 대역과 닉네임 조합으로 묶으므로 같은 사람인지 확정할 수 없습니다. " : "유동은 현재 설정에서 제외합니다. ")
    + (pending ? "아직 활동을 확인하지 못한 " + pending + "명이 있어 추첨을 보류합니다." : "통과 후보는 모두 같은 확률로 추첨됩니다.");
  $("export-csv").disabled = participants.length === 0;
  $("copy-result").disabled = !drawn;
  renderRows();
  renderWinners();
}
function exportCsv() {
  const winnerKeys = new Set(drawn?.winners.map((person) => person.key) || []);
  const safe = (value) => {
    let str = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return '"' + str.replace(/"/g, '""') + '"';
  };
  const rows = [["name", "comment_no", "entry_comment_count", "confirmed_posts", "confirmed_comments", "status", "reason", "winner", "comment_url",
    "assessment_start", "assessment_end", "period_value", "period_unit", "min_posts", "min_comments"],
    ...participants.map((person) => [person.name, person.firstCommentId, person.commentCount, person.postCount,
      person.commentsChecked ? person.activityCommentCount : "", person.status, person.reason, winnerKeys.has(person.key) ? "Y" : "N", commentLink(person),
      new Date(cutoff).toISOString(), new Date(asOf).toISOString(), settings.periodValue, settings.periodUnit, settings.minPosts, settings.minComments])];
  const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "boogie-result-" + post.id + "-" + post.no + ".csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyResult() {
  if (!drawn) return;
  const message = ["[부기 추첨자]", post.title, post.url, periodLabel(settings) + " · " + criteriaLabel(settings),
    "평가기간: " + date(cutoff) + " ~ " + date(asOf),
    "참가 " + participants.length + "명 / 통과 " + participants.filter((p) => p.status === "eligible").length + "명",
    "", "당첨자", ...drawn.winners.map((person, index) => (index + 1) + ". " + person.name + " (참여 댓글 " + person.firstCommentId + ")"),
    "", "추첨 번호: " + drawn.id].join("\n");
  try { await navigator.clipboard.writeText(message); status("당첨 결과를 복사했습니다.", "success"); }
  catch { status("복사 권한이 없습니다. 결과 CSV를 저장해주세요.", "error"); }
}
$("analysis-form").addEventListener("submit", run);
$("stop-button").addEventListener("click", () => controller?.abort());
$("redraw-button").addEventListener("click", redraw);
$("export-csv").addEventListener("click", exportCsv);
$("copy-result").addEventListener("click", copyResult);
$("example-button").addEventListener("click", () => { $("post-url").value = "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524"; });
$("period-unit").addEventListener("change", () => {
  const maximum = $("period-unit").value === "days" ? 730 : 24;
  $("period-value").max = String(maximum);
  if (Number($("period-value").value) > maximum) $("period-value").value = String(maximum);
});
setRunning(false);
