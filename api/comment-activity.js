import { createHash } from "node:crypto";
import { parsePostUrl } from "../public/lottery-core.js";
import { loadCommentSource, readCommentPage, parseComments } from "./comments.js";
import { requestBody, respond, attr, decode, text, gallogFetch, bodyText, pause, createBudget, errorResponse, looksBlocked, markBlocked, instrument } from "../lib/dcinside.js";

const MAX_PROFILE_PAGES = 2000;
const PATHS = { post: "posting", comment: "comment" };
const LABELS = { post: "글", comment: "댓글" };

function profileDate(value) {
  const found = String(value || "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!found) return 0;
  const result = Date.UTC(+found[1], +found[2] - 1, +found[3], -9);
  const date = new Date(result + 9 * 3600000);
  return date.getUTCFullYear() === +found[1] && date.getUTCMonth() === +found[2] - 1 && date.getUTCDate() === +found[3] ? result : 0;
}

export function parseProfileActivity(html, gallery, kind, page, cutoff, asOf) {
  const listMatch = html.match(/<ul\b[^>]*class=["'][^"']*\bcont_listbox\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  // Read the section's visibility label before its list, never words inside activity entries.
  const header = listMatch ? html.slice(0, listMatch.index) : html;
  const labels = [...header.matchAll(/<span\b[^>]*class=["'][^"']*\b(?:bluebox|greybox|graybox|redbox|whitebox)\b[^"']*["'][^>]*>\s*(공개|비공개|일부공개)\s*<\/span>/gi)].map((match) => match[1]);
  const base = { kind, page, entries: [], nextPage: null, malformed: false, paginationKnown: false, boundary: false };
  if (labels.includes("비공개")) return { ...base, visibility: "private", unavailableReason: `갤로그 비공개 (${LABELS[kind]} 목록)` };
  if (!labels.some((label) => ["공개", "일부공개"].includes(label))) return { ...base, visibility: "unknown", unavailableReason: "갤로그 공개 여부를 확인할 수 없어 보류합니다." };
  const result = { ...base, visibility: labels.includes("일부공개") ? "partial" : "public" };
  const emptyMessage = kind === "post" ? /게시글이 없습니다|등록된 게시글이 없습니다|작성한 게시글이 없습니다/ : /댓글이 없습니다|댓글 내역이 없습니다|등록된 댓글이 없습니다|작성한 댓글이 없습니다/;
  if (!listMatch && emptyMessage.test(text(html, html.length))) return { ...result, paginationKnown: true, fingerprint: "empty" };
  if (!listMatch) return { ...result, unavailableReason: "공개 갤로그 목록 형식이 달라 활동 확인을 보류합니다." };
  const list = listMatch[1];
  const rows = [...list.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
  const emptyRows = rows.length === 1 && !attr(rows[0][1], "data-no")
    && /^(?:게시글|댓글|댓글 내역|등록된 댓글|작성한 댓글|등록된 게시글|작성한 게시글)(?:이|에)? 없습니다\.?$/.test(text(list, list.length));
  if ((!rows.length && emptyMessage.test(text(html, html.length))) || emptyRows) return { ...result, paginationKnown: true, fingerprint: "empty" };
  if (!rows.length) return { ...result, unavailableReason: "갤로그 목록을 읽을 수 없어 활동 확인을 보류합니다." };
  const dates = [];
  const rowIds = [];
  for (const row of rows) {
    const id = attr(row[1], "data-no");
    if (!/^[1-9]\d*$/.test(id)) { result.malformed = true; dates.push(0); continue; }
    rowIds.push(id);
    const dateText = text(row[2].match(/<span\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const ts = profileDate(dateText);
    dates.push(ts);
    if (!ts) result.malformed = true;
    const linkTag = row[2].match(/<a\b[^>]*class=["'][^"']*\blink\b[^"']*["'][^>]*>/i)?.[0] || "";
    let target;
    try { target = parsePostUrl(decode(attr(linkTag, "href"))); }
    catch { result.malformed = true; continue; }
    // Gallery type and ID must both match. Other galleries never enter the activity response.
    if (target.id !== gallery.id || target.type !== gallery.type || target.no === gallery.no || !ts || ts < cutoff || ts > asOf) continue;
    result.entries.push({ id, ts, postNo: target.no, url: target.url });
  }
  result.fingerprint = createHash("sha256").update(rowIds.join("|")).digest("hex");
  result.boundary = dates.length > 0 && dates.every((ts) => ts > 0 && ts < cutoff);
  const paging = html.match(/<div\b[^>]*class=["'][^"']*\bbottom_paging_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const pageNumbers = [...paging.matchAll(/href=["']([^"']+)["']/gi)].flatMap((match) => {
    try {
      const url = new URL(decode(match[1]), "https://gallog.dcinside.com/_profile/" + PATHS[kind]);
      if (url.hostname !== "gallog.dcinside.com" || !url.pathname.replace(/\/$/, "").endsWith("/" + PATHS[kind])) return [];
      const value = Number(url.searchParams.get("p"));
      return Number.isInteger(value) && value > 0 ? [value] : [];
    } catch { return []; }
  });
  result.nextPage = pageNumbers.some((value) => value > page) ? page + 1 : null;
  result.paginationKnown = pageNumbers.length > 0 || /^\d+(?:\s+\d+)*$/.test(text(paging, 300));
  return result;
}

// New comments shift older ones to later pages, deletions to earlier ones. Try the remembered
// page first, then its neighbours, before holding the participant.
export function candidatePages(page, last = 100) {
  return [page, page + 1, page - 1, page + 2, page - 2].filter((value) => value >= 1 && value <= last);
}

// The browser sends only the HMAC author key and the comment page. The server re-reads that
// comment to find the gallog ID, so this endpoint cannot be used to scan arbitrary gallogs.
async function resolveParticipant(context, target) {
  context.source ||= await loadCommentSource(context.gallery, context.sessionKey, { budget: context.budget });
  let last = 100;
  for (const page of candidatePages(target.sourcePage)) {
    if (page > last) continue;
    let data;
    try { data = await readCommentPage(context.source, page, { budget: context.budget, fresh: false }); }
    catch (error) {
      if (page === target.sourcePage || ["time_budget", "upstream_blocked"].includes(error?.kind)) throw error;
      continue;
    }
    if (!data.nextPage) last = Math.min(last, page);
    const validIds = new Set(parseComments(data, context.source.gallery, context.sessionKey).filter((item) => item.authorKey === target.authorKey).map((item) => item.id));
    const raw = data.comments.find((item) => validIds.has(String(item.no)));
    if (!raw) continue;
    const uid = String(raw.user_id || raw.uid || "").trim();
    if (!uid) return { profileStatus: "missing", unavailableReason: "연결할 갤로그가 없는 참가자", sourcePage: page };
    if (!/^[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(uid)) return { profileStatus: "unknown", unavailableReason: "갤로그 주소를 확인할 수 없어 보류합니다.", sourcePage: page };
    return { uid, sourcePage: page };
  }
  return { profileStatus: "unknown", unavailableReason: "참여 댓글의 작성자를 다시 확인할 수 없어 보류합니다." };
}

async function checkTarget(context, target, pages) {
  const participant = await resolveParticipant(context, target);
  if (!participant.uid) return { ...participant, pages };
  const sourcePage = participant.sourcePage;
  const requests = context.accessOnly ? [{ kind: "post", page: 1 }, { kind: "comment", page: 1 }]
    : Array.from({ length: target.count }, (_, offset) => ({ kind: target.kind, page: target.startPage + offset }));
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const url = new URL(`https://gallog.dcinside.com/${encodeURIComponent(participant.uid)}/${PATHS[request.kind]}`);
    if (request.page > 1) url.searchParams.set("p", String(request.page));
    let html;
    try {
      if (index > 0) await pause(context.pauseMs, context.budget);
      html = await bodyText(await gallogFetch(url, { budget: context.budget }));
    } catch (error) {
      // Out of time after some pages: return them; their nextPage is the continuation marker.
      if (error?.kind === "time_budget" && pages.length && !context.accessOnly) break;
      throw error;
    }
    const result = parseProfileActivity(html, context.gallery, request.kind, request.page, context.cutoff, context.asOf);
    if (result.visibility === "unknown" && looksBlocked(html)) throw markBlocked();
    pages.push(result);
    if (result.visibility === "private") return { profileStatus: "private", unavailableReason: result.unavailableReason, pages: [], sourcePage };
    if (result.visibility === "unknown") return { profileStatus: "unknown", unavailableReason: result.unavailableReason, pages: [], sourcePage };
    if (!context.accessOnly && (result.unavailableReason || result.boundary || !result.nextPage)) break;
  }
  return { profileStatus: pages.some((page) => page.visibility === "partial") ? "partial" : "public", pages, sourcePage };
}

function validTarget(target, accessOnly) {
  const sourcePage = Number(target.sourcePage);
  const startPage = Number(target.startPage || 1);
  const count = Number(target.count || 1);
  const kind = target.kind || "comment";
  if (!/^[0-9a-f]{64}$/i.test(String(target.authorKey || "")) || !Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 100
    || !Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(count) || count < 1 || count > 3 || startPage + count - 1 > MAX_PROFILE_PAGES
    || !Object.hasOwn(PATHS, kind)) return null;
  return { authorKey: String(target.authorKey), sourcePage, startPage: accessOnly ? 1 : startPage, count: accessOnly ? 1 : count, kind };
}

export default async function handler(req, res, options = {}) {
  const budget = options.budget || createBudget();
  instrument(res, "comment-activity", budget, options.logger);
  const body = requestBody(req, res);
  if (!body) return;
  let gallery;
  try { gallery = parsePostUrl(body.postUrl); } catch (error) { respond(res, 400, { error: error.message, errorKind: "bad_request" }); return; }
  const cutoff = Number(body.cutoff);
  const asOf = Number(body.asOf);
  const periodUnit = body.periodUnit || "months";
  const validPeriod = periodUnit === "all" ? cutoff === 0
    : periodUnit === "months" && cutoff > 0 && asOf - cutoff <= 732 * 86400000;
  const accessOnly = body.action === "access";
  const batch = Array.isArray(body.targets);
  const targets = (batch ? body.targets : [body]).map((target) => target && typeof target === "object" ? validTarget(target, accessOnly) : null);
  if (!targets.length || targets.length > 5 || targets.some((target) => !target)
    || !Number.isSafeInteger(cutoff) || !Number.isSafeInteger(asOf) || !validPeriod || cutoff > asOf
    || asOf <= 0 || asOf > Date.now() + 60000 || (body.action && !accessOnly)) {
    respond(res, 400, { error: "갤로그 조회 대상·기간·페이지가 올바르지 않습니다.", errorKind: "bad_request" }); return;
  }
  const context = { gallery, sessionKey: body.sessionKey, cutoff, asOf, accessOnly, source: null,
    budget, pauseMs: options.pauseMs ?? 300 };
  if (!batch) {
    // Single-participant form kept for open tabs from the previous release.
    const pages = [];
    try { respond(res, 200, await checkTarget(context, targets[0], pages)); }
    catch (error) {
      const failure = errorResponse(error, "갤로그 응답 시간이 초과되었습니다.");
      if (error?.kind === "time_budget" || error?.kind === "upstream_blocked") { respond(res, failure.status, failure.body, failure.headers); return; }
      // Never infer a private profile from an HTTP error or reveal a raw UID in an error.
      respond(res, pages.length && !accessOnly ? 200 : 502, { profileStatus: "unknown", pages: accessOnly ? [] : pages,
        error: failure.body.errorKind === "upstream_timeout" ? "갤로그 응답 시간이 초과되었습니다." : "갤로그 접근 오류로 확인을 보류합니다.",
        errorKind: failure.body.errorKind, retryable: failure.body.retryable });
    }
    return;
  }
  const results = [];
  const deferred = [];
  let blocked = null;
  for (const target of targets) {
    if (blocked || deferred.length) { deferred.push(target.authorKey); continue; }
    const pages = [];
    try {
      if (results.length) await pause(context.pauseMs, context.budget);
      results.push({ authorKey: target.authorKey, ...(await checkTarget(context, target, pages)) });
    } catch (error) {
      const failure = errorResponse(error, "갤로그 응답 시간이 초과되었습니다.");
      if (error?.kind === "time_budget") { deferred.push(target.authorKey); continue; }
      if (error?.kind === "upstream_blocked") { blocked = { error: failure.body.error, retryAfter: failure.body.retryAfter || 60 }; deferred.push(target.authorKey); continue; }
      results.push({ authorKey: target.authorKey, profileStatus: "unknown", pages: accessOnly ? [] : pages,
        error: failure.body.errorKind === "upstream_timeout" ? "갤로그 응답 시간이 초과되었습니다." : failure.body.errorKind === "upstream_format" && !failure.body.retryable ? failure.body.error : "갤로그 접근 오류로 확인을 보류합니다.",
        errorKind: failure.body.errorKind, retryable: failure.body.retryable });
    }
  }
  respond(res, 200, { results, deferred, ...(blocked ? { blocked } : {}) });
}
