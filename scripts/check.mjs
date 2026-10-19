import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const config = await readJson("vercel.json");
assert.equal(pkg.type, "module");
assert.equal(pkg.engines.node, "24.x");
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.equal(config.framework, null);
assert.equal(config.outputDirectory, "public");
assert.equal(config.functions["api/*.js"].maxDuration, 30);
assert.ok(config.headers.some((rule) => rule.headers.some((header) => header.key === "Content-Security-Policy")), "vercel.json must set a CSP");
for (const path of ["public/index.html", "public/app.js", "public/lottery-core.js", "public/result-export.js", "public/styles.css",
  "public/styles-base.css", "api/comments.js", "api/comment-activity.js", "lib/dcinside.js"]) await readFile(new URL(path, root));
let checked = 0;
for (const directory of ["api", "lib", "public", "scripts", "tests"]) {
  let entries;
  entries = await readdir(new URL(directory + "/", root), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:m?js)$/.test(entry.name)) continue;
    const filename = fileURLToPath(new URL(directory + "/" + entry.name, root));
    const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    checked += 1;
  }
}
console.log("Deployment configuration, public files, lockfile and " + checked + " JavaScript files checked.");
// The test suite gates the deployment. Tests mock fetch and never reach DCInside.
const testFiles = (await readdir(new URL("tests/", root))).filter((name) => name.endsWith(".test.mjs")).sort()
  .map((name) => fileURLToPath(new URL("tests/" + name, root)));
assert.ok(testFiles.length > 0, "tests/*.test.mjs must be present in the build input");
const tests = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit", windowsHide: true });
if (tests.error) throw tests.error;
assert.equal(tests.status, 0, "Test suite failed");
console.log(testFiles.length + " test files passed.");
