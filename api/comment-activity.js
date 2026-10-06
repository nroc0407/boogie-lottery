import { parsePostUrl } from "../public/lottery-core.js";
import { loadCommentSource, readCommentPage, parseComments } from "./comments.js";
import { requestBody, respond, attr, decode, text, gallogFetch, delay } from "../lib/dcinside.js";

const MAX_PROFILE_PAGES = 2000;

export function parseCommentActivity(html, gallery, page) {
  const list = html.match(/<ul\b[^>]*class=["'][^"']*\bcont_listbox\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1];
  const publicSection = /<span\b[^>]*class=["'][^"']*\bbluebox\b[^"']*["'][^>]*>\s*공개\s*<\/span>/i.test(html);
  if (list === undefined || !publicSection) return { page, comments: [], unavailableReason: "공개 갤로그 댓글 목록을 확인할 수 없어 보류합니다." };
  const rows = [...list.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
  const comments = [];
  let malformed = false;
  for (const row of rows) {
    const id = attr(row[1], "data-no");
    if (!/^\d+$/.test(id)) continue;
    const dateText = text(row[2].match(/<span\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const date = dateText.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
    const ts = date ? Date.UTC(+date[1], +date[2] - 1, +date[3], -9) : 0;
    if (!ts) malformed = true;
    const linkTag = row[2].match(/<a\b[^>]*class=["'][^"']*\blink\b[^"']*["'][^>]*>/i)?.[0] || "";
    let sameGallery = false;
    let postNo = "";
    try {
      const target = parsePostUrl(decode(attr(linkTag, "href")));
      sameGallery = target.id === gallery.id && target.type === gallery.type;
      postNo = target.no;
    } catch { malformed = true; }
    comments.push({ id, ts, sameGallery, postNo });
  }
  // An unfamiliar empty response must never be treated as zero activity.
  if (!comments.length && !/댓글이 없습니다|댓글 내역이 없습니다|등록된 댓글이 없습니다|작성한 댓글이 없습니다/.test(text(html, html.length))) {
    return { page, comments, unavailableReason: "갤로그 댓글 목록 형식이 달라 활동 확인을 보류합니다." };
  }
  const paging = html.match(/<div\b[^>]*class=["'][^"']*\bbottom_paging_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const pageNumbers = [...paging.matchAll(/href=["']([^"']+)["']/gi)].flatMap((match) => {
    try {
      const url = new URL(decode(match[1]), "https://gallog.dcinside.com");
      if (url.hostname !== "gallog.dcinside.com") return [];
      const value = Number(url.searchParams.get("p"));
      return Number.isInteger(value) && value > 0 ? [value] : [];
    } catch { return []; }
  });
  return { page, comments, nextPage: pageNumbers.some((value) => value > page) ? page + 1 : null,
    malformed, paginationKnown: Boolean(paging) || comments.length === 0 };
}

export default async function handler(req, res) {
  const body = requestBody(req, res);
  if (!body) return;
  let gallery;
  try { gallery = parsePostUrl(body.postUrl); } catch (error) { respond(res, 400, { error: error.message }); return; }
  const sourcePage = Number(body.sourcePage);
  const startPage = Number(body.startPage);
  const count = Number(body.count || 3);
  if (!/^[0-9a-f]{64}$/i.test(String(body.authorKey || "")) || !Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 100
    || !Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(count) || count < 1 || count > 3 || startPage + count - 1 > MAX_PROFILE_PAGES) {
    respond(res, 400, { error: "댓글 활동 조회 대상 또는 페이지가 올바르지 않습니다." }); return;
  }
  try {
    // Resolve the public UID on the server; no UID or profile URL is returned to the browser.
    const source = await loadCommentSource(gallery, body.sessionKey);
    const data = await readCommentPage(source, sourcePage);
    const validIds = new Set(parseComments(data, gallery, body.sessionKey).filter((item) => item.authorKey === body.authorKey).map((item) => item.id));
    const raw = data.comments.find((item) => validIds.has(String(item.no)));
    if (!raw) { respond(res, 200, { pages: [], unavailableReason: "참여 댓글의 작성자를 다시 확인할 수 없어 보류합니다." }); return; }
    const uid = String(raw.user_id || raw.uid || "").trim();
    if (!/^[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(uid)) {
      respond(res, 200, { pages: [], unavailableReason: "유동·미식별 참가자는 갤로그 댓글 활동을 확인할 수 없어 보류합니다." }); return;
    }
    const pages = [];
    for (let offset = 0; offset < count; offset += 1) {
      const page = startPage + offset;
      const url = new URL(`https://gallog.dcinside.com/${encodeURIComponent(uid)}/comment`);
      if (page > 1) url.searchParams.set("p", String(page));
      const html = await (await gallogFetch(url)).text();
      const result = parseCommentActivity(html, gallery, page);
      pages.push(result);
      if (result.unavailableReason || !result.nextPage) break;
      if (offset + 1 < count) await delay(300);
    }
    respond(res, 200, { pages });
  } catch (error) {
    // Avoid exposing an upstream URL or identifier in an error string.
    respond(res, 502, { error: error.name === "TimeoutError" ? "댓글 활동 응답 시간이 초과되었습니다." : "댓글 활동을 조회하지 못했습니다. 비공개·접근 제한·삭제 여부를 확인해주세요." });
  }
}
