import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

test("SimpleFIN uses the deployed Workers runtime for claim and pull without sockets", () => {
  const workerd = require("workerd").default;
  const configPath = join(root, "worker/test/fixtures/simplefin/runtime.capnp");
  const config = readFileSync(configPath, "utf8");
  assert.match(config, /sockets = \[\]/);
  assert.match(config, /globalOutbound = "provider"/);
  // Config embeds reviewed source files directly; no bundles, copies, sockets,
  // disk database, Wrangler, downloads, or inherited desktop credentials.
  const result = spawnSync(workerd, ["test", configPath, "--verbose"], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH || "", BRAIN_NO_WRANGLER_LOGIN: "1" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 0, `native runtime failed: ${output}`);
  assert.match(output, /native manual-mode control passed/);
  assert.match(output, /native claim, pull, auth, staging, redirect and provider-count checks passed/);
});
