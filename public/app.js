import { parsePostUrl, evaluationCutoff, periodLabel, criteriaLabel, participantLabel, applyParticipantSelection, collectParticipants, evaluateParticipants, pickWinners } from "/lottery-core.js";
import { createRecord, jsonBlob, pngBlob, zipBlob, exportBaseName, downloadBlob } from "/result-export.js";

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 2000;
let controller = null;
let post = null;
let comments = [];
let participants = [];
let counts = new Map();
let scanPages = 0;
let commentScanPages = 0;
let profileScanCount = 0;
let nextRequestAt = 0;
let completed = false;
let drawn = null;
let draws = [];
let progressHistory = [];
let exportBusy = false;
const manualExclusions = new Set();
let settings = null;
let asOf = 0;
let cutoff = 0;
let phase = "idle";
let statusTone = "idle";
let elapsedSeconds = 0;
let lastLog = "";

function number(value) { return Number(value || 0).toLocaleString("ko-KR"); }
function date(value) { return value ? new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "—"; }
function assessmentRange() { return settings.periodUnit === "all" ? "기간 제한 없음 · " + date(asOf) + "까지" : date(cutoff) + " ~ " + date(asOf); }
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
  progressHistory.push({ elapsed: time.textContent, tone, message, detail });
  if (progressHistory.length > 120) progressHistory.shift();
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
  $("coverage-detail").textContent = "갤로그 " + number(profileScanCount) + "명 / 글 " + number(scanPages) + "p / 댓글 " + number(commentScanPages) + "p";
  $("coverage-state").textContent = drawn ? "완료" : statusTone === "stopped" ? "중단"
    : statusTone === "error" ? (completed || participants.some((person) => person.status === "pending") ? "보류" : "오류")
    : controller ? "처리 중" : completed ? "추첨 대기" : "대기";
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
  syncActivityMode();
  syncPeriodMode();
  $("example-button").disabled = value;
  $("start-label").textContent = value ? "확인 중" : "참가자 확인";
  updateExportButtons();
}
function syncActivityMode() {
  const mode = $("analysis-form").querySelector('input[name="activity-mode"]:checked').value;
  document.querySelector(".number-controls").dataset.mode = mode;
  for (const field of document.querySelectorAll("[data-criterion-mode]")) {
    const inactive = field.dataset.criterionMode !== mode;
    field.hidden = inactive;
    for (const input of field.querySelectorAll("input")) input.disabled = Boolean(controller) || inactive;
  }
  $("activity-help").textContent = mode === "total" ? "글+댓글 합계만 평가 / 0 = 활동 검사 끄기" : "글·댓글 모두 충족 / 0 = 해당 기준 끄기";
}
function syncPeriodMode() {
  const unlimited = $("period-unit").value === "all";
  $("period-value").hidden = unlimited;
  $("period-value").disabled = Boolean(controller) || unlimited;
  $("period-value").required = !unlimited;
  $("period-value").parentElement.dataset.periodUnit = $("period-unit").value;
}
function setPhase(value) {
  phase = value;
  document.querySelector(".app-shell").dataset.phase = value;
  for (const step of document.querySelectorAll("[data-step]")) {
    const order = ["comments", "activity", "review", "draw"];
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
  await wait(Math.max(0, nextRequestAt - Date.now()), signal);
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal });
  nextRequestAt = Date.now() + 1100;
  let result;
  try { result = await response.json(); } catch { throw new Error("서버 응답을 읽을 수 없습니다."); }
  if (!response.ok) {
    const error = new Error(result.error || ("요청 실패 (HTTP " + response.status + ")"));
    error.status = response.status;
    throw error;
  }
  return result;
}
function settingsFromForm() {
  const target = parsePostUrl($("post-url").value);
  const activityMode = $("analysis-form").querySelector('input[name="activity-mode"]:checked').value;
  if (!["separate", "total"].includes(activityMode)) throw new Error("활동 기준 모드를 선택해주세요.");
  const minPosts = activityMode === "separate" ? Number($("min-posts").value) : 0;
  const minComments = activityMode === "separate" ? Number($("min-comments").value) : 0;
  const minTotal = activityMode === "total" ? Number($("min-total").value) : 0;
  const periodUnit = $("period-unit").value;
  const periodValue = periodUnit === "all" ? 0 : Number($("period-value").value);
  const winnerCount = Number($("winner-count").value);
  for (const value of [minPosts, minComments]) {
    if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error("최소 글·댓글 수는 0~1,000개로 설정해주세요.");
  }
  if (!Number.isInteger(minTotal) || minTotal < 0 || minTotal > 2000) throw new Error("글+댓글 합계는 0~2,000개로 설정해주세요.");
  evaluationCutoff(Date.now(), periodValue, periodUnit);
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 100) throw new Error("당첨 인원은 1~100명으로 설정해주세요.");
  return { ...target, requirePublicGallog: true, activityMode, minPosts, minComments, minTotal, periodValue, periodUnit, winnerCount, includeGuests: false,
    includeReplies: $("include-replies").checked, excludeAuthor: $("exclude-author").checked, keyword: $("keyword").value.trim() };
}
async function run(event) {
  event.preventDefault();
  if (controller || exportBusy) return;
  let input;
  try { input = settingsFromForm(); } catch (error) { status(error.message, "error"); return; }
  settings = input;
  post = input;
  comments = [];
  participants = [];
  counts = new Map();
  scanPages = 0;
  commentScanPages = 0;
  profileScanCount = 0;
  completed = false;
  drawn = null;
  draws = [];
  progressHistory = [];
  manualExclusions.clear();
  $("participant-search").value = "";
  $("export-feedback").textContent = "";
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
      throw new Error("참가 조건을 통과한 댓글 작성자가 없습니다. 대댓글·키워드 설정을 확인해주세요.");
    }
    await scanProfileActivity(sessionKey, signal, checkable);
    refreshParticipants();
    completed = true;
    setPhase("review");
    render();
    if (participants.some((person) => person.status === "pending")) {
      throw new Error("미확인 " + participants.filter((person) => person.status === "pending").length + "명 / 추첨 보류");
    }
    status("참가자 확인 완료 / 명단을 검토한 뒤 추첨해주세요.", "success", "통과 " + participants.filter((person) => person.status === "eligible").length + "명");
  } catch (error) {
    status(error.name === "AbortError" ? "중단됨 / 추첨 미실행" : error.message,
      error.name === "AbortError" ? "stopped" : "error");
  } finally {
    updateElapsed();
    controller = null;
    if (completed && !drawn) setPhase("review");
    setRunning(false);
    render();
  }
}

function refreshParticipants() {
  participants = evaluateParticipants(participants, counts, settings, false);
  render();
}
function activityFor(key) {
  if (!counts.has(key)) counts.set(key, { count: 0, comments: 0, latest: 0, url: "" });
  return counts.get(key);
}
async function scanProfileActivity(sessionKey, signal, checkable) {
  for (let index = 0; index < checkable.length; index += 1) {
    const person = checkable[index];
    const activity = activityFor(person.key);
    const states = Object.fromEntries(["post", "comment"].map((kind) => [kind, {
      nextPage: 1, seen: new Set(), fingerprints: new Set(), malformed: false, complete: false, error: "",
    }]));
    const wants = { post: settings.minPosts > 0 || settings.minTotal > 0, comment: settings.minComments > 0 || settings.minTotal > 0 };
    const body = { postUrl: post.url, sessionKey, authorKey: person.key, sourcePage: person.firstCommentPage, cutoff, asOf, periodUnit: settings.periodUnit };
    const syncCoverage = () => {
      activity.postsComplete = states.post.complete;
      activity.commentsComplete = states.comment.complete;
      activity.postError = states.post.error;
      activity.commentError = states.comment.error;
      refreshParticipants();
    };
    const consume = (pages) => {
      for (const page of pages) {
        const state = states[page.kind];
        if (!state || page.page !== state.nextPage || !Array.isArray(page.entries)
          || (page.nextPage !== null && page.nextPage !== page.page + 1)) throw new Error("갤로그 페이지 정보를 확인할 수 없습니다.");
        if (!wants[page.kind]) continue;
        if (page.kind === "post") scanPages += 1;
        else { commentScanPages += 1; activity.commentsChecked = true; }
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
      syncCoverage();
    };
    const pending = () => participants.find((entry) => entry.key === person.key)?.status === "pending";
    try {
      status(participantLabel(person) + " / 갤로그 공개 확인", "loading", (index + 1) + "/" + checkable.length + "명");
      const access = await api("/api/comment-activity", { ...body, action: "access" }, signal);
      if (access.profileStatus === "public" && (!Array.isArray(access.pages) || access.pages.length !== 2
        || access.pages[0].kind !== "post" || access.pages[1].kind !== "comment"
        || access.pages.some((page) => page.visibility !== "public"))) throw new Error("갤로그 글·댓글 공개 여부를 확인할 수 없습니다.");
      activity.profileStatus = access.profileStatus;
      if (access.profileStatus !== "public") {
        activity.profileError = access.unavailableReason || access.error || "갤로그 공개 여부를 확인할 수 없어 보류합니다.";
      } else {
        consume(access.pages);
        let previousKind = "comment";
        while (pending()) {
          const available = ["post", "comment"].filter((kind) => wants[kind] && states[kind].nextPage && !states[kind].error
            && (settings.minTotal > 0 || (kind === "post" ? activity.count < settings.minPosts : activity.comments < settings.minComments)));
          if (!available.length) break;
          const kind = available.find((value) => value !== previousKind) || available[0];
          previousKind = kind;
          const state = states[kind];
          if (state.nextPage > MAX_PAGES) {
            state.error = "갤로그 2,000페이지 제한으로 활동 확인을 보류합니다.";
            state.nextPage = null;
            syncCoverage();
            continue;
          }
          status(participantLabel(person) + " / " + (kind === "post" ? "글" : "댓글") + " 활동 확인", "loading", post.id + " · " + state.nextPage + "p");
          const data = await api("/api/comment-activity", { ...body, kind, startPage: state.nextPage,
            count: Math.min(3, MAX_PAGES - state.nextPage + 1) }, signal);
          if (["private", "missing"].includes(data.profileStatus)) {
            activity.profileStatus = data.profileStatus;
            activity.profileError = data.unavailableReason;
            refreshParticipants();
            break;
          }
          if (!Array.isArray(data.pages) || !data.pages.length) {
            state.error = data.unavailableReason || data.error || "갤로그 활동 목록을 읽지 못해 보류합니다.";
            state.nextPage = null;
            syncCoverage();
            continue;
          }
          consume(data.pages);
          if (data.error || data.profileStatus === "unknown") {
            state.error = data.error || data.unavailableReason || "갤로그 접근 오류로 확인을 보류합니다.";
            state.complete = false;
            state.nextPage = null;
            syncCoverage();
          }
        }
      }
    } catch (error) {
      if (error.name === "AbortError" || error.status === 429) throw error;
      if (activity.profileStatus !== "public") {
        activity.profileStatus = "unknown";
        activity.profileError = error.message;
      } else {
        activity.postError ||= error.message;
        activity.commentError ||= error.message;
      }
    }
    profileScanCount += 1;
    refreshParticipants();
    const assessed = participants.find((entry) => entry.key === person.key);
    appendLog(participantLabel(person) + " / " + assessed.reason,
      assessed.status === "eligible" ? "success" : assessed.status === "pending" ? "error" : "info");
  }
}
function selectedParticipants() { return applyParticipantSelection(participants, manualExclusions); }
function reviewState(people = selectedParticipants()) {
  let input = null;
  try { input = settingsFromForm(); } catch { /* Incomplete inputs keep drawing disabled. */ }
  const keys = ["url", "activityMode", "minPosts", "minComments", "minTotal", "periodUnit", "periodValue", "includeReplies", "excludeAuthor", "keyword"];
  const matches = Boolean(input && settings && keys.every((key) => input[key] === settings[key]));
  const included = people.filter((person) => person.status === "eligible").length;
  const pending = people.filter((person) => person.status === "pending").length;
  const winnerCount = input?.winnerCount || settings?.winnerCount || 0;
  return { matches, included, pending, winnerCount,
    canDraw: completed && !controller && !exportBusy && matches && !pending && included >= winnerCount && winnerCount > 0 };
}
function makeDraw() {
  const review = reviewState();
  if (!review.canDraw) throw new Error("포함 대상과 당첨 인원을 확인해주세요. 설정을 바꿨다면 참가자를 다시 확인해야 합니다.");
  settings.winnerCount = review.winnerCount;
  $("export-feedback").textContent = "";
  setPhase("draw");
  appendLog("당첨자 추첨 / 포함 " + review.included + "명");
  const winners = pickWinners(selectedParticipants(), settings.winnerCount);
  drawn = { id: crypto.randomUUID(), at: Date.now(), winners };
  draws.push(drawn);
  setPhase("done");
  render();
}
function confirmDraw() {
  if (controller || exportBusy || !completed || drawn) return;
  try { makeDraw(); status("추첨 완료", "success", drawn.winners.length + "명 당첨"); }
  catch (error) { status(error.message, "error"); }
  render();
}
function redraw() {
  if (controller || exportBusy || !completed) return;
  try { makeDraw(); status("재추첨 완료", "success", drawn.winners.length + "명 당첨"); }
  catch (error) { status(error.message, "error"); }
}
function commentLink(person) {
  const link = new URL(post.url);
  link.searchParams.set("fcno", person.firstCommentId);
  return link.href;
}
function updateReviewControls(review) {
  const editable = completed && !controller && !drawn && !exportBusy && participants.some((person) => person.status === "eligible");
  $("include-all").disabled = !editable;
  $("exclude-all").disabled = !editable;
  for (const button of $("preview-panel").querySelectorAll("button[data-select-key]")) button.disabled = !editable;
  $("draw-button").hidden = Boolean(drawn);
  $("draw-button").disabled = !review.canDraw || Boolean(drawn);
  $("draw-button").textContent = "포함 " + number(review.included) + "명 중 " + number(review.winnerCount) + "명 추첨하기";
  let message;
  if (controller) message = "참가자와 활동 내역을 확인하고 있습니다. 아직 추첨하지 않습니다.";
  else if (!completed) message = "참가자 확인이 끝나지 않았습니다. 참가자 확인을 다시 실행해주세요.";
  else if (!review.matches) message = "설정이 변경되었거나 입력이 올바르지 않습니다. 조건을 바꿨다면 참가자를 다시 확인해주세요.";
  else if (review.pending) message = "미확인 " + number(review.pending) + "명이 있어 추첨을 보류합니다. 확인되지 않은 참가자를 포함할 수 없습니다.";
  else if (drawn) message = "포함 " + number(review.included) + "명의 명단으로 추첨했습니다. 명단을 바꾸려면 참가자를 다시 확인해주세요.";
  else if (!review.included) message = "포함된 참가자가 없습니다. 통과자를 포함하거나 설정을 조정해 다시 확인해주세요.";
  else if (review.included < review.winnerCount) message = "당첨 인원 " + number(review.winnerCount) + "명이 포함 대상 " + number(review.included) + "명보다 많습니다. 위 설정에서 당첨 인원을 줄여주세요.";
  else message = "포함 " + number(review.included) + "명 중 " + number(review.winnerCount) + "명을 뽑습니다. 명단을 확인한 뒤 추첨 버튼을 눌러주세요.";
  $("review-message").textContent = message;
}
function renderPreview(people) {
  $("preview-panel").hidden = !people.length;
  if (!people.length) return;
  const query = $("participant-search").value.trim().toLocaleLowerCase("ko-KR");
  const editable = completed && !controller && !drawn && !exportBusy;
  for (const [group, state] of [["included", "eligible"], ["excluded", "excluded"], ["pending", "pending"]]) {
    const members = people.filter((person) => person.status === state);
    const visible = members.filter((person) => !query || participantLabel(person).toLocaleLowerCase("ko-KR").includes(query));
    $(group + "-count").textContent = number(members.length) + "명";
    if (group === "pending") $("pending-group").hidden = members.length === 0;
    const list = $(group + "-list");
    const scrollTop = list.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const person of visible) {
      const item = document.createElement("li");
      item.className = "preview-person";
      item.dataset.status = person.status;
      const head = document.createElement("div");
      head.className = "preview-person-head";
      const link = document.createElement("a");
      link.className = "participant-name";
      link.href = commentLink(person); link.target = "_blank"; link.rel = "noopener noreferrer";
      link.textContent = participantLabel(person);
      head.append(link);
      if (person.automaticStatus === "eligible") {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.dataset.selectKey = person.key;
        toggle.textContent = person.included ? "불포함" : "포함";
        toggle.setAttribute("aria-label", participantLabel(person) + (person.included ? " 불포함으로 변경" : " 포함으로 변경"));
        toggle.disabled = !editable;
        head.append(toggle);
      }
      const profile = document.createElement("small");
      const visibility = person.profileStatus === "public" ? "공개" : person.profileStatus === "private" ? "비공개" : person.profileStatus === "missing" ? "없음" : "미확인";
      profile.textContent = "갤로그 " + visibility + " · 참여 댓글 " + person.commentCount + "개 · 댓글 #" + person.firstCommentId;
      const reason = document.createElement("small");
      reason.textContent = person.reason;
      item.append(head, profile, reason);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    list.scrollTop = scrollTop;
    $(group + "-empty").hidden = visible.length > 0;
    $(group + "-empty").textContent = query ? "검색 결과가 없습니다." : group === "included" ? "포함된 참가자가 없습니다." : group === "excluded" ? "불포함 참가자가 없습니다." : "미확인 참가자가 없습니다.";
  }
}
function changeSelection(key) {
  if (!completed || controller || exportBusy || drawn) return;
  const person = participants.find((candidate) => candidate.key === key);
  if (person?.status !== "eligible") return;
  if (manualExclusions.has(key)) manualExclusions.delete(key);
  else manualExclusions.add(key);
  appendLog(participantLabel(person) + (manualExclusions.has(key) ? " / 수동 불포함" : " / 수동 포함"));
  render();
  [...$("preview-panel").querySelectorAll("button[data-select-key]")].find((button) => button.dataset.selectKey === key)?.focus({ preventScroll: true });
}
function selectAll(include) {
  if (!completed || controller || exportBusy || drawn) return;
  for (const person of participants) if (person.status === "eligible") {
    if (include) manualExclusions.delete(person.key);
    else manualExclusions.add(person.key);
  }
  appendLog(include ? "활동 기준 통과자 전체 포함" : "활동 기준 통과자 전체 불포함");
  render();
}
function renderRows(people) {
  const tbody = $("participant-table");
  tbody.replaceChildren();
  for (const person of people) {
    const row = document.createElement("tr");
    row.dataset.status = person.status;
    const nameCell = document.createElement("td");
    const nameLink = document.createElement("a");
    nameLink.href = commentLink(person);
    nameLink.target = "_blank";
    nameLink.rel = "noopener noreferrer";
    nameLink.className = "participant-name";
    nameLink.textContent = participantLabel(person);
    nameCell.append(nameLink);
    const cells = [person.identityType === "uid" ? "계정" : person.identityType === "ip" ? "유동" : "미식별",
      person.profileStatus === "public" ? "공개" : person.profileStatus === "private" ? "비공개" : person.exclusion ? "—" : "미확인",
      person.commentCount + "개", !person.exclusion && (settings.minPosts > 0 || settings.minTotal > 0) ? number(person.postCount) : "—",
      person.commentsChecked ? number(person.activityCommentCount) : "—",
      !person.exclusion && (settings.minPosts > 0 || settings.minComments > 0 || settings.minTotal > 0) ? number(person.totalActivityCount) : "—",
      date(person.lastActivity)];
    row.append(nameCell);
    for (const value of cells) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    const resultCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "result-pill " + person.status;
    pill.textContent = person.status === "eligible" ? "포함" : person.status === "pending" ? "미확인" : "불포함";
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
    link.textContent = participantLabel(person);
    link.href = commentLink(person);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const detail = document.createElement("small");
    detail.textContent = (settings.minPosts > 0 || settings.minTotal > 0 ? "글 " + person.postCount + "개 · " : "")
      + (person.commentsChecked ? "댓글 " + person.activityCommentCount + "개 · " : "")
      + (settings.minTotal > 0 ? "합계 " + person.totalActivityCount + "개 · " : "") + "참여 " + person.commentCount + "개";
    article.append(place, link, detail);
    list.append(article);
  });
  $("draw-detail").textContent = new Date(drawn.at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " / " + drawn.winners.length + "명";
}
function render() {
  renderProgress();
  const people = selectedParticipants();
  const eligible = people.filter((person) => person.status === "eligible").length;
  const excluded = people.filter((person) => person.status === "excluded").length;
  const pending = people.filter((person) => person.status === "pending").length;
  $("metric-comments").textContent = number(comments.length);
  $("metric-participants").textContent = number(participants.length);
  $("metric-eligible").textContent = number(eligible);
  $("metric-pending").textContent = number(pending);
  if ($("results").hidden) return;
  document.querySelector(".results-heading").hidden = !post?.title;
  document.querySelector(".participants-panel").hidden = participants.length === 0;
  document.querySelector(".report-actions").hidden = !asOf;
  $("report-title").textContent = post?.title || "";
  $("report-subtitle").textContent = post ? post.id + " / " + assessmentRange() : "";
  $("source-post").href = post?.url || "#";
  $("participant-count").textContent = number(participants.length) + "명 · 포함 " + eligible + "명 · 불포함 " + excluded + "명";
  $("coverage-label").textContent = periodLabel(settings) + " · " + criteriaLabel(settings) + " · 공개 갤로그 필수 / " + post.id + " 갤러리만 집계";
  $("export-csv").disabled = participants.length === 0;
  $("copy-result").disabled = !drawn;
  updateExportButtons();
  renderPreview(people);
  renderRows(people);
  renderWinners();
}
function exportCsv() {
  const winnerKeys = new Set(drawn?.winners.map((person) => person.key) || []);
  const safe = (value) => {
    let str = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return '"' + str.replace(/"/g, '""') + '"';
  };
  const rows = [["name", "comment_no", "entry_comment_count", "confirmed_posts", "confirmed_comments", "confirmed_total", "status", "reason", "winner", "comment_url",
    "assessment_start", "assessment_end", "period_value", "period_unit", "activity_mode", "min_posts", "min_comments", "min_total",
    "profile_status", "gallery_id", "gallery_type", "posts_complete", "comments_complete", "date_precision", "identity_code", "included", "automatic_status", "manual_excluded"],
    ...selectedParticipants().map((person) => [person.name, person.firstCommentId, person.commentCount,
      !person.exclusion && (settings.minPosts > 0 || settings.minTotal > 0) ? person.postCount : "",
      person.commentsChecked ? person.activityCommentCount : "",
      !person.exclusion && (settings.minPosts > 0 || settings.minComments > 0 || settings.minTotal > 0) ? person.totalActivityCount : "",
      person.status, person.reason, winnerKeys.has(person.key) ? "Y" : "N", commentLink(person),
      settings.periodUnit === "all" ? "" : new Date(cutoff).toISOString(), new Date(asOf).toISOString(), settings.periodUnit === "all" ? "" : settings.periodValue, settings.periodUnit, settings.activityMode, settings.minPosts, settings.minComments, settings.minTotal,
      person.profileStatus || "not-checked", post.id, post.type,
      !person.exclusion && (settings.minPosts > 0 || settings.minTotal > 0) ? person.postsComplete : "",
      !person.exclusion && (settings.minComments > 0 || settings.minTotal > 0) ? person.commentsComplete : "", "day", person.identityCode || "", person.included, person.automaticStatus, person.manuallyExcluded])];
  const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "boogie-result-" + post.id + "-" + post.no + ".csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function updateExportButtons() {
  const busy = exportBusy || Boolean(controller);
  const review = reviewState();
  $("start-button").disabled = busy;
  $("redraw-button").disabled = busy || !drawn || !review.canDraw;
  $("export-png").disabled = busy || !drawn;
  $("export-json").disabled = busy || !asOf;
  $("export-zip").disabled = busy || !drawn;
  updateReviewControls(review);
}
async function exportFiles(format) {
  if (exportBusy || controller || !asOf || (format !== "json" && !drawn)) return;
  const record = createRecord({ post, settings, participants: selectedParticipants(), commentsCount: comments.length, cutoff, asOf, completed,
    phase, tone: statusTone, message: $("status-text").textContent, draws, logs: progressHistory });
  const name = exportBaseName(record);
  exportBusy = true;
  updateExportButtons();
  $("export-feedback").className = "export-feedback";
  $("export-feedback").textContent = format.toUpperCase() + " 만드는 중…";
  try {
    let blob;
    if (format === "json") blob = jsonBlob(record);
    else {
      const png = await pngBlob(record);
      blob = format === "png" ? png : await zipBlob([
        { name: name + ".png", blob: png }, { name: name + ".json", blob: jsonBlob(record) },
      ], record.exportedAt);
    }
    downloadBlob(blob, name + "." + format);
    $("export-feedback").textContent = format.toUpperCase() + " 다운로드를 시작했습니다.";
    appendLog(format.toUpperCase() + " 저장", "success");
  } catch (error) {
    $("export-feedback").className = "export-feedback is-error";
    $("export-feedback").textContent = error.message || "파일 저장에 실패했습니다.";
  }
  finally { exportBusy = false; updateExportButtons(); }
}
async function copyResult() {
  if (!drawn) return;
  const message = ["[부기 추첨자]", post.title, post.url, periodLabel(settings) + " · " + criteriaLabel(settings),
    "평가기간: " + assessmentRange(),
    "공개 갤로그 필수 / " + post.id + " 갤러리의 글·댓글만 평가",
    "참가 " + participants.length + "명 / 포함 " + selectedParticipants().filter((p) => p.status === "eligible").length + "명",
    "", "당첨자", ...drawn.winners.map((person, index) => (index + 1) + ". " + participantLabel(person) + " (참여 댓글 " + person.firstCommentId + ")"),
    "", "추첨 번호: " + drawn.id].join("\n");
  try { await navigator.clipboard.writeText(message); status("결과 복사 완료", "success"); }
  catch { status("복사 권한이 없습니다. 결과 CSV를 저장해주세요.", "error"); }
}
$("analysis-form").addEventListener("submit", run);
$("usage-button").addEventListener("click", () => $("usage-guide").showModal());
$("usage-close").addEventListener("click", () => $("usage-guide").close());
$("stop-button").addEventListener("click", () => controller?.abort());
$("redraw-button").addEventListener("click", redraw);
$("draw-button").addEventListener("click", confirmDraw);
$("include-all").addEventListener("click", () => selectAll(true));
$("exclude-all").addEventListener("click", () => selectAll(false));
$("participant-search").addEventListener("input", () => renderPreview(selectedParticipants()));
$("preview-panel").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-select-key]");
  if (button) changeSelection(button.dataset.selectKey);
});
$("export-csv").addEventListener("click", exportCsv);
$("export-png").addEventListener("click", () => exportFiles("png"));
$("export-json").addEventListener("click", () => exportFiles("json"));
$("export-zip").addEventListener("click", () => exportFiles("zip"));
$("copy-result").addEventListener("click", copyResult);
$("example-button").addEventListener("click", () => { $("post-url").value = "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524"; });
for (const input of $("analysis-form").querySelectorAll('input[name="activity-mode"]')) input.addEventListener("change", syncActivityMode);
$("period-unit").addEventListener("change", syncPeriodMode);
for (const event of ["input", "change"]) $("analysis-form").addEventListener(event, () => { if (settings) render(); });
setRunning(false);
setInterval(() => { if (controller) updateElapsed(); }, 1000);
