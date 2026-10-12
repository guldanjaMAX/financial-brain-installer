import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeAdminKeyFile } from "../operations/admin-key-file.mjs";

test("local MCP preserves a bounded ledger absence without declaring the brain empty", t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ledger-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home-fixture");
  mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"), {
    environment: { HOME: home },
    // Windows binds the key file to the current account by name.
    ...(process.platform === "win32" ? { username: process.env.USERNAME || process.env.USER } : {}),
  });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const answer = "No matching deposit in account ****4321 between 2026-09-08 and 2026-09-22; the bank feed covers through 2026-10-11.";
  const ledger = { kind: "payment", found: false, from: "2026-09-08", to: "2026-09-22", accounts: [{ account_mask: "4321", covered_to: "2026-10-11" }] };
  writeFileSync(join(root, "responses.json"), JSON.stringify({
    ledger: { answer, ledger, citations: [], results: [], gaps: [], evidence_gate: { supported: true, complete: true } },
    empty: { answer: null, citations: [], results: [], gaps: [] },
  }));
  // The real stdio CLI and credential-file reader run. Fetch is injected before
  // loading the CLI, so no socket, endpoint or host credential is reachable.
  const loader = join(root, "fetch-fixture.mjs");
  writeFileSync(loader, `import { readFileSync, appendFileSync } from 'node:fs';
const replies = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://brain.invalid/api/rag/think') throw new Error('unexpected fixture route');
  const body = JSON.parse(init.body);
  appendFileSync(new URL('./calls.txt', import.meta.url), body.q + '\\n');
  return new Response(JSON.stringify(replies[body.q]), { headers: { 'Content-Type': 'application/json' } });
};\n`);
  const env = { HOME: home, TMPDIR: root, BRAIN_URL: "https://brain.invalid", BRAIN_NAME: "fixture",
    BRAIN_MANIFEST: manifest, BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "USERNAME", "USER", "LOGNAME", "PATH"])
    if (process.env[name]) env[name] = process.env[name];
  const input = ["ledger", "empty"].map((q, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1,
    method: "tools/call", params: { name: "brain_think", arguments: { q } } })).join("\n") + "\n";
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(loader).href,
    fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url))], {
    env, input, encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, "fixture CLI must complete without credential lookup or network");
  assert.deepEqual(readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n").sort(), ["empty", "ledger"]);
  const messages = child.stdout.trim().split("\n").map(JSON.parse);
  const result = id => JSON.parse(messages.find(m => m.id === id).result.content[0].text);
  assert.match(result(2).note, /brain has nothing/, "normal empty-document control still reaches absence wording");
  assert.equal(result(1).answer, answer);
  assert.doesNotMatch(result(1).note || "", /brain has nothing/);
  assert.deepEqual(result(1).ledger, ledger);
});
