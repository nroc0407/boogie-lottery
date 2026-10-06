import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
const { chromium } = createRequire(import.meta.url)(options.get("--playwright-package") || "playwright");
const artifacts = resolve(options.get("--artifacts") || "artifacts/comment-raffle-check");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(options.get("--browser-executable") ? { executablePath: options.get("--browser-executable") } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, acceptDownloads: true });
  const pageErrors = [];
  const consoleErrors = [];
  const assetResponses = [];
  const apiResponses = [];
  const pendingResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (["/", "/app.js", "/lottery-core.js", "/styles.css", "/styles-base.css"].includes(path)) assetResponses.push({ path, status: response.status() });
    if (path === "/api/comments" || path === "/api/pages") pendingResponses.push((async () => {
      const body = await response.json();
      apiResponses.push({ path, status: response.status(), pages: body.pages?.length || 0,
        comments: (body.pages || []).reduce((sum, item) => sum + (item.comments?.length || 0), 0),
        posts: (body.pages || []).reduce((sum, item) => sum + (item.posts?.length || 0), 0), error: body.error || "" });
    })());
  });
  const origin = options.get("--url") || "http://127.0.0.1:4387";
  const targetPost = options.get("--post") || "https://gall.dcinside.com/mgallery/board/view/?id=aidevelop&no=3524";
  const response = await page.goto(origin, { waitUntil: "networkidle", timeout: 15_000 });
  assert.equal(response.status(), 200);
  assert.equal(await page.locator("#welcome").isVisible(), true);
  await page.locator("#post-url").fill(targetPost);
  await page.locator("#winner-count").fill("2");
  await page.locator("#min-posts").fill("3");
  await page.locator("#start-button").click();
  console.log("Started actual comment → activity → automatic draw check.");
  await page.waitForFunction(() => !document.getElementById("start-button").disabled, null, { timeout: 180_000 });
  await Promise.all(pendingResponses);
  const message = await page.locator("#status-text").textContent();
  assert.equal(await page.locator("#status-banner").evaluate((node) => node.classList.contains("is-error")), false, message);
  assert.equal(await page.locator("#winner-section").isVisible(), true, message);
  assert.equal(await page.locator("#welcome").isVisible(), false, "Welcome must be hidden after starting a draw");
  assert.equal(await page.locator("#winner-list .winner-card").count(), 2);
  const count = async (id) => Number((await page.locator("#" + id).textContent()).replace(/,/g, ""));
  const commentCount = await count("metric-comments");
  const participantCount = await count("metric-participants");
  const eligibleCount = await count("metric-eligible");
  assert.ok(commentCount > 0);
  assert.ok(participantCount > 0 && participantCount <= commentCount);
  assert.ok(eligibleCount >= 2);
  assert.equal(await count("metric-pending"), 0);
  assert.equal(await page.locator("#participant-table tr").count(), participantCount);
  assert.ok(apiResponses.some((item) => item.path === "/api/comments" && item.status === 200 && item.comments > 0));
  assert.ok(apiResponses.some((item) => item.path === "/api/pages" && item.status === 200 && item.posts > 0));
  const winnerLinks = await page.locator("#winner-list a").evaluateAll((nodes) => nodes.map((node) => node.href));
  assert.equal(new Set(winnerLinks).size, 2);
  assert.ok(winnerLinks.every((link) => new URL(link).searchParams.has("fcno")));
  for (const path of ["/", "/app.js", "/lottery-core.js", "/styles.css", "/styles-base.css"]) {
    assert.ok(assetResponses.some((item) => item.path === path && item.status === 200), path + " must load");
  }
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-csv").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^boogie-result-/);
  const csv = await readFile(await download.path(), "utf8");
  assert.equal(csv.trimEnd().split("\r\n").length, participantCount + 1);
  assert.equal(csv.split("\r\n").slice(1).filter((line) => line.includes(',"Y",')).length, 2);
  await page.screenshot({ path: resolve(artifacts, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#winner-section").isVisible(), true);
  const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(element).position !== "absolute"
      && !element.closest(".table-wrap");
  }).map((element) => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })));
  assert.deepEqual(overflow, [], "Mobile layout must keep overflow inside the table scroller");
  await page.screenshot({ path: resolve(artifacts, "mobile.png"), fullPage: true });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  const evidence = { checkedAt: new Date().toISOString(), url: origin, targetPost, commentCount, participantCount,
    eligibleCount, winnerCount: 2, csvDownload: "passed", finalStatus: message, assetResponses, apiResponses, pageErrors, consoleErrors };
  await writeFile(resolve(artifacts, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
