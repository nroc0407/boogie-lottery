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
let statusTone = "idle";
let elapsedSeconds = 0;
let lastLog = "";

function number(value) { return Number(value || 0).toLocaleString("ko-KR"); }
function date(value) { return value ? new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "—"; }
function clock(seconds) { return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0"); }
function updateElapsed() {
  if (controller) elapsedSeconds = Math.max(0, Math.floor((Date.now() - asOf) / 1000));
  $("elapsed-time").textContent = clock(elapsedSeconds);
}
function appendLog(message, tone = "info", detail = "") {
  const signature = tone + "|" + message + "|" + detail;
  if (signature === lastLog) return;
  lastLog = signature;
  const log = $("progress-log");
  const output = log.closest(".console-output");
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 28;
  const row = document.createElement("li");
  row.className = "log-" + tone;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = clock(asOf ? Math.max(0, Math.floor((Date.now() - asOf) / 1000)) : 0);
  const content = document.createElement("span");
  content.className = "log-message";
  content.textContent = message;
  if (detail) {
    const extra = document.createElement("span");
    extra.className = "log-detail";
    extra.textContent = " / " + detail;
    content.append(extra);
  }
  row.append(time, content);
  log.append(row);
  while (log.children.length > 120) log.firstElementChild.remove();
  $("welcome").hidden = true;
  if (atBottom) output.scrollTop = output.scrollHeight;
}
function renderProgress() {
  updateElapsed();
  $("coverage-detail").textContent = "글 " + number(scanPages) + "p / 댓글 " + number(commentScanPages) + "p";
  $("coverage-state").textContent = drawn ? "완료" : statusTone === "stopped" ? "중단"
    : statusTone === "error" ? (completed || participants.some((person) => person.status === "pending") ? "보류" : "오류")
    : controller ? "처리 중" : "대기";
}
function status(message, tone = "loading", detail = "") {
  statusTone = tone;
  document.querySelector(".app-shell").dataset.tone = tone;
  $("status-banner").hidden = false;
  $("status-banner").className = "status-banner" + (tone === "error" ? " is-error" : tone === "success" ? " is-success" : "");
  $("status-indicator").textContent = tone === "error" ? "[!]" : tone === "success" ? "[+]" : tone === "stopped" ? "[-]" : "[>]";
  $("status-text").textContent = message;
  $("status-pages").textContent = detail;
  appendLog(message, tone, detail);
  renderProgress();
}
function setRunning(value) {
  $("start-button").disabled = value;
  $("stop-button").hidden = !value;
  $("stop-button").disabled = !value;
  for (const input of $("analysis-form").querySelectorAll("input, select")) input.disabled = value;
  $("example-button").disabled = value;
  $("start-label").textContent = value ? "처리 중" : "추첨 시작";
  $("redraw-button").disabled = value || !completed || participants.some((p) => p.status === "pending")
    || participants.filter((p) => p.status === "eligible").length < (settings?.winnerCount || 1);
}
function setPhase(value) {
  phase = value;
  document.querySelector(".app-shell").dataset.phase = value;
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
  elapsedSeconds = 0;
  lastLog = "";
  statusTone = "loading";
  $("progress-log").replaceChildren();
  cutoff = evaluationCutoff(asOf, settings.periodValue, settings.periodUnit);
  const sessionKey = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  controller = new AbortController();
  const signal = controller.signal;
  $("welcome").hidden = true;
  $("results").hidden = false;
  setRunning(true);
  setPhase("comments");
  appendLog(periodLabel(settings) + " / " + criteriaLabel(settings));
  render();
  try {
    const commentIds = new Set();
    let nextCommentPage = 1;
    while (nextCommentPage) {
      if (nextCommentPage > 100) throw new Error("댓글이 100페이지를 넘어 전체 참가자를 확인할 수 없습니다. 추첨을 보류합니다.");
      status("댓글 수집 중", "loading", nextCommentPage + "p");
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
      appendLog("댓글 " + number(comments.length) + "개 / 참가 " + number(participants.length) + "명", "info", data.pages.at(-1).page + "p 확인");
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
      throw new Error("미확인 " + participants.filter((person) => person.status === "pending").length + "명 / 추첨 보류");
    }
    makeDraw();
    status("추첨 완료", "success", drawn.winners.length + "명 당첨");
  } catch (error) {
    status(error.name === "AbortError" ? "중단됨 / 추첨 미실행" : error.message,
      error.name === "AbortError" ? "stopped" : "error");
  } finally {
    updateElapsed();
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
    status("작성글 조회 중", "loading", startPage + "p부터");
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
    appendLog("작성글 " + number(scanPages) + "p 확인", "info",
      "기준 충족 " + checkable.filter((person) => activityFor(person.key).count >= settings.minPosts).length + "/" + checkable.length + "명"
      + (oldest ? " · " + date(oldest) + "까지" : ""));
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
      appendLog(person.name + " / 댓글 활동 확인 불가", "error");
      refreshParticipants();
      continue;
    }
    let nextPage = 1;
    let malformed = false;
    const seenComments = new Set();
    try {
      while (nextPage && activity.comments < settings.minComments) {
        if (nextPage > MAX_PAGES) { activity.commentError = "갤로그 2,000페이지 제한으로 댓글 활동이 미확인입니다."; break; }
        status(person.name + " / 댓글 조회", "loading", (index + 1) + "/" + candidates.length + "명 · " + nextPage + "p");
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
    appendLog(person.name + " / " + (activity.commentError ? activity.commentError : "댓글 " + activity.comments + "/" + settings.minComments + "개"),
      activity.commentError ? "error" : activity.comments >= settings.minComments ? "success" : "info");
    refreshParticipants();
    if (index + 1 < candidates.length) await wait(650, signal);
  }
}
function makeDraw() {
  setPhase("draw");
  appendLog("당첨자 추첨 / 후보 " + participants.filter((person) => person.status === "eligible").length + "명");
  const winners = pickWinners(participants, settings.winnerCount);
  drawn = { id: crypto.randomUUID(), at: Date.now(), winners };
  setPhase("done");
  render();
}
function redraw() {
  if (controller || !completed) return;
  try { makeDraw(); status("재추첨 완료", "success", drawn.winners.length + "명 당첨"); }
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
    const cells = [person.identityType === "uid" ? "계정" : person.identityType === "ip" ? "유동" : "미식별",
      person.commentCount + "개", settings.minPosts > 0 ? number(person.postCount) : "—",
      person.commentsChecked ? number(person.activityCommentCount) : "—", date(person.lastActivity)];
    row.append(nameCell);
    for (const value of cells) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    const resultCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "result-pill " + person.status;
    pill.textContent = person.status === "eligible" ? "통과" : person.status === "pending" ? "보류" : "제외";
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
  $("draw-detail").textContent = new Date(drawn.at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " / " + drawn.winners.length + "명";
}
function render() {
  renderProgress();
  const eligible = participants.filter((person) => person.status === "eligible").length;
  const excluded = participants.filter((person) => person.status === "excluded").length;
  const pending = participants.filter((person) => person.status === "pending").length;
  $("metric-comments").textContent = number(comments.length);
  $("metric-participants").textContent = number(participants.length);
  $("metric-eligible").textContent = number(eligible);
  $("metric-pending").textContent = number(pending);
  if ($("results").hidden) return;
  document.querySelector(".results-heading").hidden = !post?.title;
  document.querySelector(".participants-panel").hidden = participants.length === 0;
  document.querySelector(".report-actions").hidden = participants.length === 0;
  $("report-title").textContent = post?.title || "";
  $("report-subtitle").textContent = post ? post.id + " / " + date(cutoff) + " ~ " + date(asOf) : "";
  $("source-post").href = post?.url || "#";
  $("participant-count").textContent = number(participants.length) + "명 · 제외 " + excluded + "명";
  $("coverage-label").textContent = periodLabel(settings) + " · " + criteriaLabel(settings);
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
  try { await navigator.clipboard.writeText(message); status("결과 복사 완료", "success"); }
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
setInterval(() => { if (controller) updateElapsed(); }, 1000);
