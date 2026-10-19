import { parsePostInput, parsePostUrl } from "../public/lottery-core.js";
import { requestBody, respond, attr, decode, text, writerIdentity, authorHash, dcFetch, bodyText, pause, createBudget, errorResponse, UpstreamError,
  postSourceCache, commentPageCache, looksBlocked, markBlocked } from "../lib/dcinside.js";

function input(html, name) {
  const tag = html.match(new RegExp("<input\\b[^>]*(?:id|name)=[\"']" + name + "[\"'][^>]*>", "i"))?.[0] || "";
  return decode(attr(tag, "value"));
}
export function parseComments(data, gallery, sessionKey) {
  return (Array.isArray(data.comments) ? data.comments : []).flatMap((raw) => {
    const id = String(raw.no || "");
    if (!/^[1-9]\d*$/.test(id) || raw.del_yn === "Y" || raw.is_delete === "Y" || raw.nicktype === "COMMENT_BOY") return [];
    const name = text(raw.name, 100) || "익명";
    const uid = String(raw.user_id || raw.uid || "").trim();
    const ip = String(raw.ip || "").trim();
    const identity = writerIdentity(uid, ip, name);
    const content = text(raw.memo, 500) || (raw.voice ? "[보이스 댓글]" : /dccon|img/i.test(String(raw.memo)) ? "[디시콘]" : "[내용 미표시]");
    return [{ id, authorKey: authorHash(identity, gallery, sessionKey), authorName: name, authorKnown: Boolean(identity),
      identityCode: /^[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(uid) ? uid : "",
      identityType: uid ? "uid" : ip ? "ip" : "unknown", authorType: uid ? "registered" : ip ? "guest" : "unknown",
      content, depth: Number(raw.depth) || 0 }];
  });
}
export function nextPage(pagination, page) {
  const values = [...String(pagination || "").matchAll(/(?:viewComments|comment_paging|comment_page)\s*\(\s*["']?(\d+)/gi)].map((match) => Number(match[1]));
  const dataValues = [...String(pagination || "").matchAll(/data-ci-pagination-page=["'](\d+)["']/g)].map((match) => Number(match[1]));
  return [...values, ...dataValues].some((value) => value > page) ? page + 1 : null;
}

function withPost(source, sessionKey) {
  const { uid, ip, name } = source.writer;
  return { ...source, post: { ...source.gallery, title: source.title, authorKey: authorHash(writerIdentity(uid, ip, name), source.gallery, sessionKey) } };
}

// The post page gives the comment token, cookie and real gallery path. It is cached briefly per
// instance (keyed by the requested URL); the author key is derived per run from the session key.
export async function loadCommentSource(gallery, sessionKey, { budget, cache = true } = {}) {
  const cached = cache ? postSourceCache.get(gallery.url) : undefined;
  if (cached) return withPost(cached, sessionKey);
  const requested = gallery.url;
  const original = gallery;
  const visited = new Set();
  let detail, html, title, token;
  for (let hop = 0; hop < 3; hop += 1) {
    if (visited.has(gallery.url)) throw new Error("게시글 주소 이동이 반복되어 읽을 수 없습니다.");
    visited.add(gallery.url);
    detail = await dcFetch(gallery.url, { allowRedirect: true, budget });
    html = await bodyText(detail);
    title = text(html.match(/<span\b[^>]*class=["'][^"']*\btitle_subject\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1], 200);
    token = input(html, "e_s_n_o");
    if (detail.ok && title && token) break;
    // DC may send a small script when a shared URL needs the minor/mini path.
    // Read only its literal destination; never execute upstream JavaScript.
    const redirect = detail.headers.get("location") || html.match(/(?:window\.)?location\.replace\(\s*["']([^"']+)["']\s*\)/i)?.[1]
      || html.match(/(?:window\.)?location\.href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!redirect && looksBlocked(html)) throw markBlocked();
    if (!redirect) throw new Error("게시글 또는 댓글 정보를 읽지 못했습니다. 삭제·비공개·접근 제한 여부를 확인하고, 공개 글이라면 잠시 뒤 다시 시도해주세요.");
    const target = new URL(decode(redirect), gallery.url);
    if (target.protocol !== "https:") throw new Error("게시글 이동 주소를 확인할 수 없습니다.");
    const next = parsePostUrl(target.href);
    if (next.id !== original.id || next.no !== original.no) throw new Error("입력한 게시글과 이동 주소가 달라 읽기를 중단했습니다.");
    if (hop === 2) throw new Error("게시글 주소 이동이 너무 많아 읽을 수 없습니다.");
    gallery = next;
  }
  const writerTag = html.match(/<(?:div|span)\b[^>]*class=["'][^"']*\bgall_writer\b[^"']*["'][^>]*>/i)?.[0] || "";
  const name = decode(attr(writerTag, "data-nick")).trim();
  const uid = decode(attr(writerTag, "data-uid")).trim();
  const ip = decode(attr(writerTag, "data-ip")).trim();
  const cookie = detail.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const form = { board_type: input(html, "board_type"), _GALLTYPE_: input(html, "_GALLTYPE_"), secret_article_key: input(html, "secret_article_key") };
  const source = { requested, gallery, title, token, form, cookie, writer: { uid, ip, name } };
  if (cache) postSourceCache.set(requested, source);
  return withPost(source, sessionKey);
}

// fresh: always ask DC (comment collection). Otherwise a page read in the last 30s may be reused.
export async function readCommentPage(source, page, { budget, fresh = true } = {}) {
  const { gallery, token, form: fields, cookie } = source;
  const cacheKey = gallery.url + "#" + page;
  if (!fresh) {
    const cached = commentPageCache.get(cacheKey);
    if (cached) return cached;
  }
  const form = new URLSearchParams({ id: gallery.id, no: gallery.no, cmt_id: gallery.id, cmt_no: gallery.no,
    e_s_n_o: token, comment_page: String(page), sort: "N", prevCnt: "", board_type: fields.board_type,
    _GALLTYPE_: fields._GALLTYPE_, focus_cno: "", focus_pno: "", secret_article_key: fields.secret_article_key, clean: "", nptest: "" });
  const response = await dcFetch("https://gall.dcinside.com/board/comment/", { method: "POST", budget, headers: {
    Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest", Referer: gallery.url, Origin: "https://gall.dcinside.com", Cookie: cookie,
  }, body: form.toString() });
  const raw = await bodyText(response);
  let data;
  try { data = JSON.parse(raw); }
  catch {
    if (looksBlocked(raw)) throw markBlocked();
    // An expired token or cookie also ends here; drop the cached post page so a retry refreshes it.
    if (source.requested) postSourceCache.delete(source.requested);
    throw new UpstreamError("댓글 응답을 읽지 못했습니다. 잠시 뒤 다시 시도해주세요.", "upstream_format", { retryable: true });
  }
  if (data.comments === null && Number(data.total_cnt) === 0) data.comments = [];
  if (!Array.isArray(data.comments)) throw new Error("댓글 응답 형식이 달라 수집을 중단했습니다.");
  const next = nextPage(data.pagination, page);
  // Page 1 without paging links must hold every counted comment; otherwise pages exist we cannot reach.
  if (page === 1 && !next && Number(data.total_cnt) > data.comments.filter((item) => /^[1-9]\d*$/.test(String(item.no || ""))).length) {
    throw new Error("전체 댓글의 페이지 정보를 확인할 수 없어 추첨을 보류합니다.");
  }
  const result = { ...data, nextPage: next };
  commentPageCache.set(cacheKey, result);
  return result;
}

export default async function handler(req, res, options = {}) {
  const body = requestBody(req, res);
  if (!body) return;
  let gallery;
  try { gallery = parsePostInput(body.postUrl); } catch (error) { respond(res, 400, { error: error.message, errorKind: "bad_request" }); return; }
  const startPage = Number(body.startPage || 1);
  const count = Number(body.count || 1);
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > 100 || !Number.isInteger(count) || count < 1 || count > 3 || startPage + count - 1 > 100) { respond(res, 400, { error: "댓글은 한 번에 3페이지, 최대 100페이지까지 조회할 수 있습니다.", errorKind: "bad_request" }); return; }
  const budget = options.budget || createBudget();
  const pauseMs = options.pauseMs ?? 300;
  const pages = [];
  let source;
  try {
    source = await loadCommentSource(gallery, body.sessionKey, { budget });
    for (let offset = 0; offset < count; offset += 1) {
      const page = startPage + offset;
      const data = await readCommentPage(source, page, { budget });
      const comments = parseComments(data, source.gallery, body.sessionKey);
      const next = data.nextPage;
      pages.push({ page, comments, nextPage: next, totalCount: Number(data.total_cnt) || 0 });
      if (!next) break;
      if (offset + 1 < count) await pause(pauseMs, budget);
    }
    respond(res, 200, { post: source.post, pages });
  } catch (error) {
    // Pages already read stay valid; the browser continues from the last page's nextPage.
    if (error?.kind === "time_budget" && pages.length) { respond(res, 200, { post: source.post, pages, partial: true }); return; }
    const failure = errorResponse(error, "댓글 응답 시간이 초과되었습니다.");
    respond(res, failure.status, failure.body, failure.headers);
  }
}
