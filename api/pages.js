import { GALLERIES, requestBody, respond, attr, decode, text, classes, timestamp, writerIdentity, authorHash, dcFetch, delay } from "../lib/dcinside.js";

function cell(row, className) {
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi;
  let match;
  while ((match = re.exec(row))) if (classes(match[1]).has(className)) return { attrs: match[1], html: match[2] };
  return null;
}
export function parsePosts(html, gallery, key, page) {
  const posts = [];
  const rows = /<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi;
  let row;
  while ((row = rows.exec(html))) {
    if (!classes(row[1]).has("us-post")) continue;
    const writer = cell(row[2], "gall_writer");
    const date = cell(row[2], "gall_date");
    const no = attr(row[1], "data-no") || text(cell(row[2], "gall_num")?.html || "", 30);
    if (/icon_notice|icon_survey/i.test(attr(row[1], "data-type")) || /공지|설문|AD/.test(text(cell(row[2], "gall_num")?.html || "", 30))) continue;
    if (!/^\d{1,20}$/.test(no) || !writer) continue;
    const nameTag = writer.html.match(/<span\b[^>]*class=["'][^"']*\bnickname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const name = decode(attr(writer.attrs, "data-nick")).trim() || text(nameTag?.[1] || "", 100);
    const uid = decode(attr(writer.attrs, "data-uid")).trim();
    const ip = decode(attr(writer.attrs, "data-ip")).trim();
    const ts = timestamp(decode(attr(date?.attrs, "title"))) || timestamp(text(date?.html || "", 40));
    const url = new URL("https://gall.dcinside.com/" + GALLERIES[gallery.type] + "board/view/");
    url.searchParams.set("id", gallery.id);
    url.searchParams.set("no", no);
    posts.push({ page, postNo: no, authorKey: authorHash(writerIdentity(uid, ip, name), gallery, key), ts, url: url.href });
  }
  return posts;
}

export default async function handler(req, res) {
  const body = requestBody(req, res);
  if (!body) return;
  const galleryId = String(body.galleryId || "").trim();
  const galleryType = String(body.galleryType || "");
  const startPage = Number(body.startPage);
  const count = Number(body.count);
  if (!Object.hasOwn(GALLERIES, galleryType) || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(galleryId)) { respond(res, 400, { error: "갤러리 종류 또는 ID를 확인해주세요." }); return; }
  if (!Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(count) || count < 1 || count > 5 || startPage + count - 1 > 2000) { respond(res, 400, { error: "최대 2,000페이지 범위에서 한 번에 5페이지까지 조회할 수 있습니다." }); return; }
  const gallery = { id: galleryId, type: galleryType };
  const pages = [];
  for (let offset = 0; offset < count; offset += 1) {
    const page = startPage + offset;
    const url = new URL("https://gall.dcinside.com/" + GALLERIES[gallery.type] + "board/lists/");
    for (const [name, value] of Object.entries({ id: gallery.id, page, list_num: "100", sort_type: "N" })) url.searchParams.set(name, String(value));
    try {
      const html = await (await dcFetch(url)).text();
      if (!/gall_list|gall_num/.test(html)) throw new Error("공개 목록을 확인할 수 없습니다. 접근 제한 또는 갤러리 주소를 확인해주세요.");
      const posts = parsePosts(html, gallery, body.sessionKey, page);
      pages.push({ page, posts, empty: posts.length === 0 });
    } catch (error) { pages.push({ page, posts: [], error: error.name === "TimeoutError" ? "목록 응답 시간이 초과되었습니다." : error.message }); break; }
    if (offset + 1 < count) await delay(300);
  }
  const error = pages.find((page) => page.error)?.error || "";
  respond(res, error ? 502 : 200, { pages, error });
}
