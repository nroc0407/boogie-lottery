import { parsePostUrl, sixMonthCutoff, collectParticipants, evaluateParticipants, pickWinners } from "/lottery-core.js";

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 2000;
let controller = null;
let post = null;
let comments = [];
let participants = [];
let counts = new Map();
let scanPages = 0;
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
  for (const input of $("analysis-form").querySelectorAll("input")) input.disabled = value;
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
  const winnerCount = Number($("winner-count").value);
  if (!Number.isInteger(minPosts) || minPosts < 1 || minPosts > 100) throw new Error("최소 글 수는 1~100개로 설정해주세요.");
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 100) throw new Error("당첨 인원은 1~100명으로 설정해주세요.");
  return { ...target, minPosts, winnerCount, includeGuests: $("include-guests").checked,
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
  oldest = 0;
  undated = 0;
  activityComplete = false;
  completed = false;
  drawn = null;
  asOf = Date.now();
  cutoff = sixMonthCutoff(asOf);
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
          comments.push(comment);
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
    let emptyStreak = 0;
    let finishReason = "";
    const seenPosts = new Set();
    const checkable = participants.filter((person) => !person.exclusion);
    const checkableKeys = new Set(checkable.map((person) => person.key));
    if (!checkable.length) {
      participants = evaluateParticipants(participants, counts, settings.minPosts, true);
      completed = true;
      throw new Error("참가 조건을 통과한 댓글 작성자가 없습니다. 유동·대댓글·키워드 설정을 확인해주세요.");
    }
    for (let startPage = 1; startPage <= MAX_PAGES; startPage += 5) {
      status("댓글 참가자의 최근 6개월 작성글을 확인하고 있습니다.", "loading", number(scanPages) + "페이지 확인");
      const data = await api("/api/pages", { galleryId: post.id, galleryType: post.type, sessionKey, startPage, count: Math.min(5, MAX_PAGES - startPage + 1) }, signal);
      if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("활동 목록 페이지 정보가 없습니다.");
      let boundary = false;
      for (const page of data.pages) {
        scanPages = page.page;
        emptyStreak = page.posts.length ? 0 : emptyStreak + 1;
        const dated = page.posts.filter((item) => item.ts > 0 && item.ts <= asOf);
        if (dated.length) oldest = oldest ? Math.min(oldest, ...dated.map((item) => item.ts)) : Math.min(...dated.map((item) => item.ts));
        // A pinned old row alone must not terminate a current list page.
        if (dated.length && dated.every((item) => item.ts < cutoff)) boundary = true;
        for (const item of page.posts) {
          if (seenPosts.has(item.postNo)) continue;
          seenPosts.add(item.postNo);
          if (!item.ts) { undated += 1; continue; }
          if (item.postNo === post.no || item.ts < cutoff || item.ts > asOf || !item.authorKey) continue;
          if (!checkableKeys.has(item.authorKey)) continue;
          const current = counts.get(item.authorKey) || { count: 0, latest: 0, url: "" };
          current.count += 1;
          if (item.ts > current.latest) { current.latest = item.ts; current.url = item.url; }
          counts.set(item.authorKey, current);
        }
        if (boundary || emptyStreak >= 2) { activityComplete = undated === 0; finishReason = boundary ? "6개월 경계 확인" : "공개 목록 끝 확인"; }
        participants = evaluateParticipants(participants, counts, settings.minPosts, activityComplete);
        render();
        if (boundary || emptyStreak >= 2 || participants.every((person) => person.status !== "pending")) break;
      }
      if (boundary || emptyStreak >= 2 || participants.every((person) => person.status !== "pending")) break;
      if (startPage + 5 <= MAX_PAGES) await wait(350, signal);
    }
    participants = evaluateParticipants(participants, counts, settings.minPosts, activityComplete);
    completed = true;
    render();
    if (participants.some((person) => person.status === "pending")) {
      throw new Error(undated ? "작성 시각을 확인하지 못한 글이 있어 일부 참가자의 활동이 미확인입니다. 추첨을 보류합니다."
        : "2,000페이지를 확인했지만 6개월 범위를 채우지 못했습니다. 활동이 미확인된 참가자가 있어 추첨을 보류합니다.");
    }
    makeDraw();
    status("댓글 참가자 활동 확인과 자동 추첨을 마쳤습니다.", "success", finishReason || "모든 참가자 기준 충족");
  } catch (error) {
    status(error.name === "AbortError" ? "확인을 중단했습니다. 미확인 참가자가 있어 자동 추첨을 진행하지 않았습니다." : error.message,
      error.name === "AbortError" ? "success" : "error");
  } finally {
    controller = null;
    setRunning(false);
    render();
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
      person.commentCount + "개", number(person.postCount), date(person.lastActivity)];
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
    detail.textContent = "확인된 활동 " + person.postCount + "개 · 참여 댓글 " + person.commentCount + "개";
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
  $("coverage-label").textContent = number(scanPages) + "페이지 · 최소 " + (settings?.minPosts || 0) + "개 기준";
  $("coverage-detail").textContent = activityComplete ? "최근 6개월 공개 목록 범위를 확인했습니다."
    : oldest ? "현재 확인한 가장 오래된 글: " + date(oldest) : "댓글 작성자를 모은 뒤 공개 작성글을 확인합니다.";
  $("coverage-state").textContent = drawn ? "추첨 완료" : phase === "comments" ? "댓글 수집" : pending ? "활동 확인" : completed ? "확인 완료" : "대기";
  $("result-note").textContent = "댓글 여러 개를 남겨도 1명으로 참여합니다. 활동은 선택한 갤러리의 공개 작성글로 확인하며, 이 추첨 게시글 자체는 세지 않습니다. "
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
  const rows = [["name", "comment_no", "comment_count", "confirmed_posts", "status", "reason", "winner", "comment_url"],
    ...participants.map((person) => [person.name, person.firstCommentId, person.commentCount, person.postCount,
      person.status, person.reason, winnerKeys.has(person.key) ? "Y" : "N", commentLink(person)])];
  const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "boogie-result-" + post.id + "-" + post.no + ".csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyResult() {
  if (!drawn) return;
  const message = ["[부기 추첨자]", post.title, post.url, "최근 6개월 작성글 최소 " + settings.minPosts + "개",
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
setRunning(false);
