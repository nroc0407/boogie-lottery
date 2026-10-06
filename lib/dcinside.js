import { createHmac } from "node:crypto";

export const GALLERIES = Object.freeze({ gallery: "", mgallery: "mgallery/", mini: "mini/" });
const buckets = new Map();
export function respond(res, status, value, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, item] of Object.entries(headers)) res.setHeader(key, item);
  res.end(JSON.stringify(value));
}
export function requestBody(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); respond(res, 405, { error: "POST 요청만 지원합니다." }); return null; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = buckets.get(ip);
  const bucket = !entry || now - entry.start >= 60_000 ? { start: now, count: 0 } : entry;
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (buckets.size > 2000) for (const [key, item] of buckets) if (now - item.start >= 60_000) buckets.delete(key);
  if (bucket.count > 80) { respond(res, 429, { error: "요청이 많습니다. 1분 뒤 다시 시도해주세요." }, { "Retry-After": "60" }); return null; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || !/^[0-9a-f]{64}$/i.test(String(body.sessionKey || ""))) throw new Error();
    return body;
  } catch { respond(res, 400, { error: "요청 형식 또는 추첨 세션이 올바르지 않습니다." }); return null; }
}
export function attr(source, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(`(?:^|\\s)${safe}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}
export function decode(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', hellip: "…", middot: "·" };
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return Number.isFinite(point) ? String.fromCodePoint(point) : whole; } catch { return whole; }
  });
}
export function text(html, limit = 300) {
  return decode(String(html || "").replace(/<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/[\u00a0\s]+/g, " ").trim().slice(0, limit);
}
export function classes(attributes) { return new Set(attr(attributes, "class").split(/\s+/).filter(Boolean)); }
export function timestamp(value) {
  const found = String(value || "").match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return found ? Date.UTC(+found[1], +found[2] - 1, +found[3], +found[4] - 9, +found[5], +(found[6] || 0)) : 0;
}
export function writerIdentity(uid, ip, name) {
  return uid ? `uid:${uid.trim()}` : ip ? `ip:${ip.trim()}:name:${name.trim()}` : "";
}
export function authorHash(identity, gallery, sessionKey) {
  return identity ? createHmac("sha256", sessionKey).update(`${gallery.type}:${gallery.id}:${identity}`).digest("hex") : "";
}
export function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
export async function dcFetch(url, options = {}) {
  const target = new URL(url);
  if (target.hostname !== "gall.dcinside.com" || target.protocol !== "https:") throw new Error("허용되지 않은 주소입니다.");
  const response = await fetch(target, { ...options, cache: "no-store", signal: AbortSignal.timeout(5000), redirect: "manual",
    headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9", ...options.headers } });
  if (!response.ok) throw new Error(`디시인사이드 응답 오류 (HTTP ${response.status})`);
  return response;
}
