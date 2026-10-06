import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pagesHandler from "../api/pages.js";
import commentsHandler from "../api/comments.js";
import commentActivityHandler from "../api/comment-activity.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/lottery-core.js", ["lottery-core.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/styles-base.css", ["styles-base.css", "text/css; charset=utf-8"]],
]);
const publicRoot = new URL("../public/", import.meta.url);
const port = Number(process.env.PORT || 4387);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  response.on("finish", () => console.log(`${request.method} ${pathname} ${response.statusCode}`));
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (["/api/pages", "/api/comments", "/api/comment-activity"].includes(pathname)) {
      if (request.method === "POST") {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16_384) {
            response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "요청이 너무 큽니다." }));
            return;
          }
          chunks.push(chunk);
        }
        request.body = Buffer.concat(chunks).toString("utf8");
      }
      const handler = pathname === "/api/comments" ? commentsHandler : pathname === "/api/comment-activity" ? commentActivityHandler : pagesHandler;
      await handler(request, response);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const asset = assets.get(pathname);
    if (!asset || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const file = await readFile(new URL(asset[0], publicRoot));
    response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "로컬 서버 오류가 발생했습니다." }));
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`부기 추첨자: http://127.0.0.1:${port}`);
  console.log(`Static files: ${fileURLToPath(publicRoot)}`);
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
