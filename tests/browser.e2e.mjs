// 브라우저 회귀 검사: 실제 화면(public/)과 실제 API 처리기를 로컬에 띄우고, 설치된 Chrome 으로 참가자 확인 → 추첨까지 누른다.
// 디시인사이드 응답은 이 파일의 고정 자료로 바꾼다(서버 쪽 fetch 만 바꿈). 실제 갤러리·갤로그에는 요청하지 않는다.
// 사용: npm run test:browser   (Chrome 이 설치돼 있어야 한다. 브라우저를 따로 내려받지 않는다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import commentsHandler from "../api/comments.js";
import commentActivityHandler from "../api/comment-activity.js";

const POST = "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524";
const COMMENTS = { total_cnt: 4, comments: [
  { no: "1", user_id: "alpha01", name: "알파", memo: "참여합니다", depth: 0 },
  { no: "2", user_id: "beta02", name: "베타", memo: "참여", depth: 0 },
  { no: "3", user_id: "gamma03", name: "감마", memo: "참여요", depth: 0 },
  { no: "4", user_id: "beta02", name: "베타", memo: "한 번 더", depth: 0 },
] };
const activity = (uid) => uid === "gamma03"
  ? '<span class="greybox">비공개</span>'
  : '<span class="bluebox">공개</span><ul class="cont_listbox"><li data-no="77">'
    + '<a class="link" href="https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&amp;no=42">활동</a>'
    + '<span class="date">2026.10.01</span></li></ul><div class="bottom_paging_box">1</div>';

function fakeDcinside(realFetch) {
  return async (url, init) => {
    const address = String(url);
    if (address.startsWith("http://127.0.0.1")) return realFetch(url, init);
    if (address.includes("/board/comment/")) return Response.json(COMMENTS);
    const gallog = address.match(/^https:\/\/gallog\.dcinside\.com\/([^/]+)\//);
    if (gallog) return new Response(activity(decodeURIComponent(gallog[1])));
    if (address.includes("/mgallery/board/view/")) return new Response('<span class="title_subject">기프티콘 나눔</span><input name="e_s_n_o" value="token">');
    throw new Error("고정 자료 밖의 요청: " + address);
  };
}

const ASSETS = { "/": "index.html", "/app.js": "app.js", "/lottery-core.js": "lottery-core.js", "/result-export.js": "result-export.js", "/styles.css": "styles.css" };
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

async function startServer() {
  const handlers = { "/api/comments": commentsHandler, "/api/comment-activity": commentActivityHandler };
  // 배포와 같은 응답 헤더(CSP 등)를 붙여 CSP 위반도 페이지 오류로 잡는다.
  const deployHeaders = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")).headers
    .filter((rule) => rule.source === "/(.*)").flatMap((rule) => rule.headers);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    for (const { key, value } of deployHeaders) response.setHeader(key, value);
    if (handlers[pathname]) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      request.body = Buffer.concat(chunks).toString("utf8");
      return handlers[pathname](request, response);
    }
    const file = ASSETS[pathname];
    if (!file) return response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": TYPES[file.split(".").pop()] });
    response.end(await readFile(new URL("../public/" + file, import.meta.url)));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("참가자 확인부터 추첨까지: 비공개 갤로그는 불포함, 공개 참가자 중에서 당첨", { timeout: 120_000 }, async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeDcinside(realFetch);
  t.after(() => { globalThis.fetch = realFetch; });
  const server = await startServer();
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.fill("#post-url", POST);
  await page.fill("#winner-count", "1");
  await page.fill("#min-posts", "1");
  await page.fill("#min-comments", "0");
  await page.click("#start-button");

  const draw = page.locator("#draw-button");
  await draw.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector("#draw-button").disabled, null, { timeout: 60_000 });
  assert.equal(await page.textContent("#included-count"), "2명");
  assert.equal(await page.textContent("#excluded-count"), "1명");
  assert.match(await page.textContent("#excluded-group"), /감마/);
  assert.match(await draw.textContent(), /포함 2명 중 1명 추첨하기/);

  await draw.click();
  await page.locator("#winner-section").waitFor({ state: "visible" });
  const winners = await page.locator("#winner-list").innerText();
  assert.ok(/알파|베타/.test(winners) && !/감마/.test(winners), winners);
  assert.ok(await page.isEnabled("#redraw-button"));
  assert.deepEqual(errors, []);
});
