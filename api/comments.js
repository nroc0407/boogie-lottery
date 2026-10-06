import { parsePostUrl } from "../public/lottery-core.js";
import { requestBody, respond, attr, decode, text, writerIdentity, authorHash, dcFetch, delay } from "../lib/dcinside.js";

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
      identityType: uid ? "uid" : ip ? "ip" : "unknown", authorType: uid ? "registered" : ip ? "guest" : "unknown",
      content, depth: Number(raw.depth) || 0 }];
  });
}
export function nextPage(pagination, page) {
  const values = [...String(pagination || "").matchAll(/(?:viewComments|comment_paging|comment_page)\s*\(\s*["']?(\d+)/gi)].map((match) => Number(match[1]));
  const dataValues = [...String(pagination || "").matchAll(/data-ci-pagination-page=["'](\d+)["']/g)].map((match) => Number(match[1]));
  return [...values, ...dataValues].some((value) => value > page) ? page + 1 : null;
}

export async function loadCommentSource(gallery, sessionKey) {
  const detail = await dcFetch(gallery.url);
  const html = await detail.text();
  const title = text(html.match(/<span\b[^>]*class=["'][^"']*\btitle_subject\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1], 200);
  const token = input(html, "e_s_n_o");
  if (!title || !token) throw new Error("공개 게시글 또는 댓글 정보를 찾지 못했습니다. 삭제·비공개·접근 제한 여부를 확인해주세요.");
  const writerTag = html.match(/<(?:div|span)\b[^>]*class=["'][^"']*\bgall_writer\b[^"']*["'][^>]*>/i)?.[0] || "";
  const name = decode(attr(writerTag, "data-nick")).trim();
  const uid = decode(attr(writerTag, "data-uid")).trim();
  const ip = decode(attr(writerTag, "data-ip")).trim();
  const post = { ...gallery, title, authorKey: authorHash(writerIdentity(uid, ip, name), gallery, sessionKey) };
  const cookie = detail.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return { gallery, html, token, cookie, post };
}

export async function readCommentPage(source, page) {
  const { gallery, html, token, cookie } = source;
  const form = new URLSearchParams({ id: gallery.id, no: gallery.no, cmt_id: gallery.id, cmt_no: gallery.no,
    e_s_n_o: token, comment_page: String(page), sort: "N", prevCnt: "", board_type: input(html, "board_type"),
    _GALLTYPE_: input(html, "_GALLTYPE_"), focus_cno: "", focus_pno: "", secret_article_key: input(html, "secret_article_key"), clean: "", nptest: "" });
  const response = await dcFetch("https://gall.dcinside.com/board/comment/", { method: "POST", headers: {
    Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest", Referer: gallery.url, Origin: "https://gall.dcinside.com", Cookie: cookie,
  }, body: form.toString() });
  let data;
  try { data = await response.json(); } catch { throw new Error("댓글 응답을 읽지 못했습니다. 잠시 뒤 다시 시도해주세요."); }
  if (data.comments === null && Number(data.total_cnt) === 0) data.comments = [];
  if (!Array.isArray(data.comments)) throw new Error("댓글 응답 형식이 달라 수집을 중단했습니다.");
  const next = nextPage(data.pagination, page);
  if (page === 1 && !next && Number(data.total_cnt) > data.comments.filter((item) => /^[1-9]\d*$/.test(String(item.no || ""))).length) {
    throw new Error("전체 댓글의 페이지 정보를 확인할 수 없어 추첨을 보류합니다.");
  }
  return { ...data, nextPage: next };
}

export default async function handler(req, res) {
  const body = requestBody(req, res);
  if (!body) return;
  let gallery;
  try { gallery = parsePostUrl(body.postUrl); } catch (error) { respond(res, 400, { error: error.message }); return; }
  const startPage = Number(body.startPage || 1);
  const count = Number(body.count || 1);
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > 100 || !Number.isInteger(count) || count < 1 || count > 3 || startPage + count - 1 > 100) { respond(res, 400, { error: "댓글은 한 번에 3페이지, 최대 100페이지까지 조회할 수 있습니다." }); return; }
  try {
    const source = await loadCommentSource(gallery, body.sessionKey);
    const pages = [];
    for (let offset = 0; offset < count; offset += 1) {
      const page = startPage + offset;
      const data = await readCommentPage(source, page);
      const comments = parseComments(data, gallery, body.sessionKey);
      const next = data.nextPage;
      pages.push({ page, comments, nextPage: next, totalCount: Number(data.total_cnt) || 0 });
      if (!next) break;
      if (offset + 1 < count) await delay(300);
    }
    respond(res, 200, { post: source.post, pages });
  } catch (error) { respond(res, 502, { error: error.name === "TimeoutError" ? "댓글 응답 시간이 초과되었습니다." : error.message }); }
}
