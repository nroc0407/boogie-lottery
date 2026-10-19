import { createHmac } from "node:crypto";

export const GALLERIES = Object.freeze({ gallery: "", mgallery: "mgallery/", mini: "mini/" });
const buckets = new Map();
// Short-lived per-instance cache. Vercel may reuse a warm instance for consecutive calls of one
// raffle run, so the post page and comment pages are not refetched for every participant.
// Nothing here is shared across instances or persisted.
export function createTtlCache(ttlMs, maxEntries) {
  const entries = new Map();
  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now - entry.at >= ttlMs) { entries.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value, now = Date.now()) {
      entries.delete(key);
      entries.set(key, { at: now, value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    delete(key) { entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
export const postSourceCache = createTtlCache(60_000, 50);
export const commentPageCache = createTtlCache(30_000, 200);

// When DC answers 403/429 or a block page, this instance pauses all upstream requests.
let blockedUntil = 0;
export function markBlocked(retryAfterSeconds = 60) {
  const seconds = Math.min(300, Math.max(30, Math.round(Number(retryAfterSeconds) || 60)));
  blockedUntil = Math.max(blockedUntil, Date.now() + seconds * 1000);
  return blockedError(seconds);
}
function blockedError(seconds) {
  return new UpstreamError("디시인사이드가 요청을 일시적으로 제한했습니다. 잠시 뒤 다시 시도해주세요.", "upstream_blocked", { retryAfter: seconds });
}
// Checked only on pages that failed to parse, so words inside normal content cannot trigger it.
export function looksBlocked(html) {
  return /비정상적인\s*(?:접근|요청|트래픽)|접근이\s*차단|차단된\s*(?:IP|아이피)|자동\s*입력\s*방지|g-recaptcha|hcaptcha|cf-chl|Too Many Requests|Access Denied|요청이\s*너무\s*많/i.test(String(html || "").slice(0, 20_000));
}

// Clears per-instance memory (rate-limit buckets, caches, upstream cool-down). Used by tests.
export function resetServerState() {
  buckets.clear();
  postSourceCache.clear();
  commentPageCache.clear();
  blockedUntil = 0;
}
export function respond(res, status, value, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, item] of Object.entries(headers)) res.setHeader(key, item);
  res.end(JSON.stringify(value));
}
// Browsers send Origin (or at least Referer) with these POST requests. A page on another site must not be
// able to use this deployment as a DC proxy, so a present Origin/Referer has to name this host.
// Requests without either header (non-browser clients) are left to the rate limit.
export function originAllowed(headers = {}) {
  if (String(headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
  const source = headers.origin ?? headers.referer;
  if (source === undefined || source === "") return true;
  const hosts = new Set([headers["x-forwarded-host"], headers.host].flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toLowerCase()).filter(Boolean));
  try {
    const url = new URL(String(source));
    return ["http:", "https:"].includes(url.protocol) && hosts.has(url.host.toLowerCase());
  } catch { return false; }
}
export function requestBody(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); respond(res, 405, { error: "POST 요청만 지원합니다." }); return null; }
  if (!originAllowed(req.headers)) { respond(res, 403, { error: "허용되지 않은 요청 출처입니다. 부기 추첨자 페이지에서 다시 시도해주세요.", errorKind: "forbidden_origin" }); return null; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = buckets.get(ip);
  const bucket = !entry || now - entry.start >= 60_000 ? { start: now, count: 0 } : entry;
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (buckets.size > 2000) for (const [key, item] of buckets) if (now - item.start >= 60_000) buckets.delete(key);
  if (bucket.count > 80) {
    const retryAfter = Math.max(1, Math.ceil((bucket.start + 60_000 - now) / 1000));
    respond(res, 429, { error: "요청이 많습니다. " + retryAfter + "초 뒤 다시 시도해주세요.", errorKind: "rate_limit", retryAfter }, { "Retry-After": String(retryAfter) });
    return null;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || !/^[0-9a-f]{64}$/i.test(String(body.sessionKey || ""))) throw new Error();
    return body;
  } catch { respond(res, 400, { error: "요청 형식 또는 추첨 세션이 올바르지 않습니다.", errorKind: "bad_request" }); return null; }
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

// Vercel stops a function at maxDuration (30s). Never start an upstream request after
// START_LIMIT_MS, and cap each request so the last one ends by FINISH_LIMIT_MS.
export const START_LIMIT_MS = 20_000;
export const FINISH_LIMIT_MS = 25_000;
export const UPSTREAM_TIMEOUT_MS = 5_000;
export function createBudget({ startLimit = START_LIMIT_MS, finishLimit = FINISH_LIMIT_MS, now = Date.now } = {}) {
  const startedAt = now();
  return {
    elapsed: () => now() - startedAt,
    canStart: (extra = 0) => now() + extra - startedAt < startLimit,
    timeout: () => Math.max(1, Math.min(UPSTREAM_TIMEOUT_MS, finishLimit - (now() - startedAt))),
  };
}

export class UpstreamError extends Error {
  constructor(message, kind, { status = 0, retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}
export function budgetError() {
  return new UpstreamError("처리 시간이 길어 이어서 조회합니다.", "time_budget", { retryable: true });
}
export async function pause(ms, budget) {
  if (budget && !budget.canStart(ms)) throw budgetError();
  await delay(ms);
}

// One place maps internal failures to the JSON body and status the browser understands.
export function errorResponse(error, timeoutMessage = "디시인사이드 응답 시간이 초과되었습니다.") {
  if (error?.name === "TimeoutError") error = new UpstreamError(timeoutMessage, "upstream_timeout", { retryable: true });
  if (!(error instanceof UpstreamError)) {
    return { status: 502, body: { error: error?.message || "디시인사이드 응답을 처리하지 못했습니다.", errorKind: "upstream_format", retryable: false } };
  }
  const message = error.kind === "upstream_timeout" ? timeoutMessage : error.message;
  const status = error.kind === "time_budget" || error.kind === "upstream_blocked" ? 503 : 502;
  const body = { error: message, errorKind: error.kind, retryable: error.retryable };
  const headers = {};
  if (error.retryAfter) { body.retryAfter = error.retryAfter; headers["Retry-After"] = String(error.retryAfter); }
  return { status, body, headers };
}

export async function bodyText(response) {
  try { return await response.text(); }
  catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UpstreamError("디시인사이드 응답 시간이 초과되었습니다.", "upstream_timeout", { retryable: true });
    throw new UpstreamError("디시인사이드 응답이 중간에 끊겼습니다.", "upstream_network", { retryable: true });
  }
}
export async function dcFetch(url, options = {}) {
  const { allowRedirect = false, budget, ...fetchOptions } = options;
  return upstreamFetch(url, "gall.dcinside.com", fetchOptions, allowRedirect, budget);
}
export async function gallogFetch(url, options = {}) {
  return upstreamFetch(url, "gallog.dcinside.com", {}, false, options.budget);
}
async function upstreamFetch(url, host, options = {}, allowRedirect = false, budget = null) {
  const target = new URL(url);
  if (target.hostname !== host || target.protocol !== "https:" || target.username || target.password || target.port) throw new Error("허용되지 않은 주소입니다.");
  if (Date.now() < blockedUntil) throw blockedError(Math.ceil((blockedUntil - Date.now()) / 1000));
  if (budget && !budget.canStart()) throw budgetError();
  let response;
  try {
    response = await fetch(target, { ...options, cache: "no-store", signal: AbortSignal.timeout(budget ? budget.timeout() : UPSTREAM_TIMEOUT_MS), redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9", ...options.headers } });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UpstreamError("디시인사이드 응답 시간이 초과되었습니다.", "upstream_timeout", { retryable: true });
    throw new UpstreamError("디시인사이드에 연결하지 못했습니다.", "upstream_network", { retryable: true });
  }
  if (response.status === 403 || response.status === 429) throw markBlocked(response.headers.get("retry-after"));
  if (!response.ok && !(allowRedirect && [301, 302, 303, 307, 308].includes(response.status))) {
    throw new UpstreamError(`디시인사이드 응답 오류 (HTTP ${response.status})`, "upstream_http", { status: response.status, retryable: response.status >= 500 });
  }
  return response;
}
