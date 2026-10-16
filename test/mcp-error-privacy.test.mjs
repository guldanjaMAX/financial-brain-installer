import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeAdminKeyFile } from "../operations/admin-key-file.mjs";
import { ANSWER_ERROR_MESSAGES } from "../worker/src/lib/answer-render.js";

const MCP = fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url));
const CANARY = "Synthetic private title; count=731; incidental private marker";
const keyFixtureOptions = home => process.platform === "win32"
  ? { environment: process.env, username: process.env.USERNAME || process.env.USER }
  : { environment: { HOME: home } };

// Run the shipped entrypoint and credential-file reader, with transport replaced
// before import. The canary is a synthetic body, never an argument or credential.
function runFixture(t, fixture, { name = "brain_think", args = { q: "Synthetic record" }, method = "tools/call" } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-error-privacy-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home-fixture");
  mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"), keyFixtureOptions(home));
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const loader = join(root, "transport.mjs");
  writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(loader, `import { readFileSync, appendFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://fixture.invalid/api/rag/think' && String(url) !== 'https://fixture.invalid/api/admin/brain/owner-notes') throw new Error('Unexpected fixture route');
  if (init.redirect !== 'error') throw new Error('Expected protected transport');
  appendFileSync(new URL('./calls.txt', import.meta.url), 'transport reached\\n');
  if (fixture.mode === 'throw') throw new Error(fixture.body);
  if (fixture.mode === 'body-read') return { ok: true, status: 200, text: async () => { throw new Error(fixture.body); } };
  return new Response(fixture.body, { status: fixture.status || 200 });
};
`);
  const environment = { HOME: home, TMPDIR: root, BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_TEST_LAUNCHCTL: launchctl, BRAIN_URL: "https://fixture.invalid", BRAIN_MANIFEST: manifest,
    BRAIN_AGENT_PROFILE: "owner-assistant" };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "USERNAME", "USER", "LOGNAME", "PATH"])
    if (process.env[name]) environment[name] = process.env[name];
  const run = spawnSync(process.execPath, ["--import", loader, MCP], {
    env: environment, encoding: "utf8", timeout: 15000,
    input: JSON.stringify({ id: 11, jsonrpc: "2.0", method, params: { name, arguments: args } }) + "\n",
  });
  assert.equal(run.status, 0, "the real MCP process completed");
  const replies = run.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 11, "the RPC reply sink was reached");
  if (method === "tools/call") {
    const calls = readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n");
    assert.ok(calls.length >= 1, "the real authenticated transport reached the injected response");
  } else assert.equal(existsSync(join(root, "calls.txt")), false, "metadata requires no transport");
  assert.doesNotMatch(run.stdout + run.stderr, /Synthetic private title|count=731|incidental private marker/);
  return replies[0].result;
}

test("stdio initialization and tool inventory describe the cash-flow refusal honestly", t => {
  const initialized = runFixture(t, {}, { method: "initialize" });
  const inventory = runFixture(t, {}, { method: "tools/list" });
  const think = inventory.tools.find(tool => tool.name === "brain_think");
  assert.ok(think && initialized.serverInfo, "both metadata decisions were reached");
  for (const text of [initialized.instructions, think.description]) {
    assert.match(text, /profit, net income/);
    assert.match(text, /Cash flow is unsupported/);
    assert.match(text, /cash_flow_unsupported/);
    assert.match(text, /no figure/);
    assert.doesNotMatch(text, /profit, net income, cash flow/);
  }
});

for (const status of [400, 401, 403, 429, 503]) {
  test(`stdio HTTP ${status} retains status without relaying a private body`, t => {
    const reply = runFixture(t, { status, body: CANARY });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, new RegExp(`HTTP ${status}`));
    assert.match(reply.content[0].text, /Support code: MCP_/);
  });
}
for (const mode of ["throw", "non-json", "body-read"]) {
  test(`stdio ${mode} uses a reviewed error`, t => {
    const reply = runFixture(t, { mode, body: CANARY });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Support code: MCP_/);
  });
}
test("stdio answer error uses reviewed copy", t => {
  const failed = runFixture(t, { body: JSON.stringify({ answer: null, answer_error: CANARY }) });
  assert.equal(JSON.parse(failed.content[0].text).answer_error, ANSWER_ERROR_MESSAGES.unavailable);
});
test("stdio successful answer stays distinct from errors", t => {
  const passed = runFixture(t, { body: JSON.stringify({ answer: "The amount is 42.", citations: [] }) });
  assert.equal(passed.isError, undefined);
  assert.equal(JSON.parse(passed.content[0].text).answer, "The amount is 42.");
  assert.doesNotMatch(passed.content[0].text, /Support code/);
});
test("stdio failed write retains its uncertain receipt and safe support code", t => {
  const reply = runFixture(t, { mode: "throw", body: CANARY }, { name: "brain_remember", args: {
    title: "Synthetic note", body: "A synthetic record with enough context to preserve its stated conditions.", confidence: "unverified",
  } });
  const receipt = JSON.parse(reply.content[0].text);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.confirmed_count, 0);
  assert.match(receipt.note, /may or may not have reached storage/);
  assert.match(receipt.note, /Support code: MCP_/);
});
