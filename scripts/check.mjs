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
for (const path of ["public/index.html", "public/app.js", "public/lottery-core.js", "public/styles.css",
  "public/styles-base.css", "api/comments.js", "api/pages.js", "lib/dcinside.js"]) await readFile(new URL(path, root));
let checked = 0;
for (const directory of ["api", "lib", "public", "scripts", "tests"]) {
  let entries;
  try { entries = await readdir(new URL(directory + "/", root), { withFileTypes: true }); }
  catch (error) { if (directory === "tests" && error.code === "ENOENT") continue; throw error; }
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
