import { createHash } from "node:crypto";
import { parsePostUrl } from "../public/lottery-core.js";
import { loadCommentSource, readCommentPage, parseComments } from "./comments.js";
import { requestBody, respond, attr, decode, text, gallogFetch, delay } from "../lib/dcinside.js";

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
  const labels = [...header.matchAll(/<span\b[^>]*class=["'][^"']*\b(?:bluebox|greybox|graybox|redbox)\b[^"']*["'][^>]*>\s*(공개|비공개)\s*<\/span>/gi)].map((match) => match[1]);
  const base = { kind, page, entries: [], nextPage: null, malformed: false, paginationKnown: false, boundary: false };
  if (labels.includes("비공개")) return { ...base, visibility: "private", unavailableReason: `갤로그 비공개 (${LABELS[kind]} 목록)` };
  if (!labels.includes("공개")) return { ...base, visibility: "unknown", unavailableReason: "갤로그 공개 여부를 확인할 수 없어 보류합니다." };
  const result = { ...base, visibility: "public" };
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

async function resolveParticipant(gallery, body) {
  const source = await loadCommentSource(gallery, body.sessionKey);
  const data = await readCommentPage(source, Number(body.sourcePage));
  const validIds = new Set(parseComments(data, gallery, body.sessionKey).filter((item) => item.authorKey === body.authorKey).map((item) => item.id));
  const raw = data.comments.find((item) => validIds.has(String(item.no)));
  if (!raw) return { profileStatus: "unknown", unavailableReason: "참여 댓글의 작성자를 다시 확인할 수 없어 보류합니다." };
  const uid = String(raw.user_id || raw.uid || "").trim();
  if (!uid) return { profileStatus: "missing", unavailableReason: "연결할 갤로그가 없는 참가자" };
  if (!/^[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(uid)) return { profileStatus: "unknown", unavailableReason: "갤로그 주소를 확인할 수 없어 보류합니다." };
  return { uid };
}

export default async function handler(req, res) {
  const body = requestBody(req, res);
  if (!body) return;
  let gallery;
  try { gallery = parsePostUrl(body.postUrl); } catch (error) { respond(res, 400, { error: error.message }); return; }
  const sourcePage = Number(body.sourcePage);
  const startPage = Number(body.startPage || 1);
  const count = Number(body.count || 1);
  const cutoff = Number(body.cutoff);
  const asOf = Number(body.asOf);
  const accessOnly = body.action === "access";
  const kind = body.kind || "comment";
  if (!/^[0-9a-f]{64}$/i.test(String(body.authorKey || "")) || !Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 100
    || !Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(count) || count < 1 || count > 3 || startPage + count - 1 > MAX_PROFILE_PAGES
    || !Object.hasOwn(PATHS, kind) || !Number.isSafeInteger(cutoff) || !Number.isSafeInteger(asOf) || cutoff <= 0 || cutoff > asOf
    || asOf > Date.now() + 60000 || asOf - cutoff > 732 * 86400000 || (body.action && !accessOnly)) {
    respond(res, 400, { error: "갤로그 조회 대상·기간·페이지가 올바르지 않습니다." }); return;
  }
  const pages = [];
  try {
    const participant = await resolveParticipant(gallery, body);
    if (!participant.uid) { respond(res, 200, { ...participant, pages }); return; }
    const requests = accessOnly ? [{ kind: "post", page: 1 }, { kind: "comment", page: 1 }]
      : Array.from({ length: count }, (_, offset) => ({ kind, page: startPage + offset }));
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const url = new URL(`https://gallog.dcinside.com/${encodeURIComponent(participant.uid)}/${PATHS[request.kind]}`);
      if (request.page > 1) url.searchParams.set("p", String(request.page));
      const html = await (await gallogFetch(url)).text();
      const result = parseProfileActivity(html, gallery, request.kind, request.page, cutoff, asOf);
      pages.push(result);
      if (result.visibility === "private") { respond(res, 200, { profileStatus: "private", unavailableReason: result.unavailableReason, pages: [] }); return; }
      if (result.visibility === "unknown") { respond(res, 200, { profileStatus: "unknown", unavailableReason: result.unavailableReason, pages: [] }); return; }
      if (!accessOnly && (result.unavailableReason || result.boundary || !result.nextPage)) break;
      if (index + 1 < requests.length) await delay(300);
    }
    respond(res, 200, { profileStatus: "public", pages });
  } catch (error) {
    // Never infer a private profile from an HTTP error or reveal a raw UID in an error.
    respond(res, pages.length && !accessOnly ? 200 : 502, { profileStatus: "unknown", pages: accessOnly ? [] : pages,
      error: error.name === "TimeoutError" ? "갤로그 응답 시간이 초과되었습니다." : "갤로그 접근 오류로 확인을 보류합니다." });
  }
}
