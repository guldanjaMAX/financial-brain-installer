import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cmdMcpConfig, successMark } from "../brain.mjs";
import {
  CLAUDE_CODE_FULL_EXIT_CARD,
  PART_B_ROUTE_CONTROL,
  readCurrentUserProcessList,
} from "../operations/answer-route-proof.mjs";
import { RECOMMENDED_ANSWER_SETUP } from "../operations/answer-setup.mjs";
import { writeClaudeWorkspaceGuide } from "../operations/claude-workspace.mjs";
import { createQueryTiming } from "../worker/src/lib/query-timing.js";

const FIXTURE_ADMIN_KEY = "fixture-admin-key-not-a-credential";
const EXPECTED_EVENTS = Object.freeze(["stop", "open", "initialize", "brain_think", "close"]);

function backendTiming() {
  let clock = 0;
  const timing = createQueryTiming({ route: "think", now: () => clock });
  const answer = timing.model("answer_llm", "anthropic", "claude-opus-5-5");
  clock += 2;
  answer();
  const check = timing.model("verifier_llm", "anthropic", "claude-sonnet-5-5");
  clock += 1;
  check();
  return timing.finish("ok");
}

async function fixture(t, label, { withServer = true } = {}) {
  assert.ok(process.env.HOME, "the defaults test requires a scratch HOME");
  mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  const parent = realpathSync.native(process.env.HOME);
  const root = realpathSync.native(mkdtempSync(join(parent, `${label}-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const requests = [];
  const server = withServer ? createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push(Object.freeze({
      method: request.method,
      path: request.url,
      authorized: typeof request.headers["x-admin-key"] === "string",
      question: body?.q,
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      mode: "think",
      answer: "The fixed control completed. [1]",
      citations: [{ n: 1 }],
      results: [],
      evidence_gate: { supported: true },
      timing: backendTiming(),
    }));
  }) : null;
  if (server) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())));
  }

  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Owner", timezone: "UTC" },
    brain: {
      version: "0.4.21",
      worker_name: "fixture-brain",
      domain: server ? `http://127.0.0.1:${server.address().port}` : "fixture.invalid",
    },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        storage: "d1",
        d1_database_id: "fixture-database",
        vectorize_index: "fixture-index",
      },
    },
    operations: { admin_key_secret: null },
    retrieval: { ...RECOMMENDED_ANSWER_SETUP },
    safety: { daily_llm_spend_cap_usd: 10 },
  }, null, 2)}\n`);
  writeFileSync(join(root, ".brain-admin-key"), FIXTURE_ADMIN_KEY, { mode: 0o600 });
  assert.equal(writeClaudeWorkspaceGuide(manifest).status, "written");
  return { root, manifest, requests };
}

async function captureConsole(action) {
  const original = console.log;
  const output = [];
  console.log = (...values) => output.push(values.map(String).join(" "));
  try { return { value: await action(), error: null, output }; }
  catch (error) { return { value: null, error, output }; }
  finally { console.log = original; }
}

function installedDefaults(manifest, counters, processSnapshot) {
  return captureConsole(() => cmdMcpConfig(manifest, {
    flags: { apply: true },
    processSnapshot,
    wireAgents: async (_manifest, receivedPath) => {
      counters.apply++;
      assert.equal(receivedPath, manifest);
      return { wired: ["Claude Code"], skipped: [], failures: [] };
    },
  }));
}

test("the real current-user process query returns a frozen array of claude entries", () => {
  const snapshot = readCurrentUserProcessList();
  assert.equal(Array.isArray(snapshot), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.every((entry) => entry === "claude"), true);
});

test("the Windows current-user query sends one complete PowerShell input line", () => {
  const calls = [];
  const snapshot = readCurrentUserProcessList({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    run: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "0" };
    },
  });

  assert.deepEqual(snapshot, [], "the closed control returned no Claude process");
  assert.equal(calls.length, 1, "the native query decision point was reached once");
  const [command, args, options] = calls[0];
  assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-",
  ]);
  assert.doesNotMatch(options.input, /[\r\n]/u,
    "PowerShell stdin is one complete line so its final write is executed");
  assert.match(options.input, /Get-CimInstance -ClassName Win32_Process/u);
  assert.match(options.input, /Invoke-CimMethod -InputObject \$_ -MethodName GetOwner/u);
  assert.equal(options.input.match(/\[Console\]::Out\.Write\(\$found\)/gu)?.length, 1,
    "the script contains one final output write");
});

test("the Windows current-user query accepts only the closed one-byte result protocol", () => {
  const calls = [];
  const query = (stdout) => readCurrentUserProcessList({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    run: (...args) => {
      calls.push(args);
      return { status: 0, stdout };
    },
  });

  const open = query("1");
  assert.deepEqual(open, ["claude"]);
  assert.equal(Object.isFrozen(open), true);
  const closed = query("0");
  assert.deepEqual(closed, []);
  assert.equal(Object.isFrozen(closed), true);
  assert.throws(() => query(""), /current-user process query failed/u);
  assert.throws(() => query("other"), /current-user process query failed/u);
  assert.equal(calls.length, 4,
    "both green controls and both refusals reached the native query decision point");
});

test("installed mcp-config defaults use an empty process snapshot and the real descriptor stdio route", async (t) => {
  const state = await fixture(t, "installed-defaults");
  const counters = { apply: 0, processSnapshots: 0 };
  const result = await installedDefaults(state.manifest, counters, async () => {
    counters.processSnapshots++;
    return Object.freeze([]);
  });

  assert.equal(counters.apply, 1, "the installed apply decision was reached");
  assert.equal(counters.processSnapshots, 1, "the full-exit boundary read exactly one process snapshot");
  assert.equal(result.error, null);
  assert.deepEqual(result.value.route_readiness?.route_events, EXPECTED_EVENTS);
  assert.equal(result.value.route_readiness?.ready, true);
  assert.equal(result.value.route_readiness?.reason, "route_receipt_accepted");
  assert.equal(result.value.route_readiness?.route_receipt?.route, "mcp.brain_think");
  assert.equal(state.requests.length, 1, "the real child made one fixed control request");
  assert.deepEqual(state.requests[0], {
    method: "POST",
    path: "/api/rag/think",
    authorized: true,
    question: PART_B_ROUTE_CONTROL.arguments.q,
  });
  assert.equal(
    result.output.filter((line) =>
      line === `${successMark(false)}    Claude answer route ready: route_receipt_accepted`).length,
    1,
  );
  t.diagnostic("apply=1 process_queries=1 child_spawns=1 route_events=5 strict_receipts=1");
});

test("installed defaults refuse one running Claude Code process without spawn or retry", async (t) => {
  const state = await fixture(t, "full-exit-refusal", { withServer: false });
  const counters = { apply: 0, processSnapshots: 0 };
  const result = await installedDefaults(state.manifest, counters, async () => {
    counters.processSnapshots++;
    return Object.freeze(["claude"]);
  });

  assert.equal(counters.apply, 1, "the installed apply decision was reached");
  assert.equal(counters.processSnapshots, 1, "the refusal read exactly one injected process snapshot");
  assert.equal(result.value, null);
  assert.equal(result.error?.constructor?.name, "Fatal");
  assert.equal(result.error?.message, "Claude answer route not ready: claude_code_running.");
  assert.equal(
    CLAUDE_CODE_FULL_EXIT_CARD.message,
    "Close Claude completely, including Claude Code, the Claude desktop app, and any tray or background process, then rerun the same command.",
  );
  assert.equal(state.requests.length, 0, "the refusal spawned no MCP transport");
  assert.equal(
    result.output.filter((line) => line.includes(CLAUDE_CODE_FULL_EXIT_CARD.message)).length,
    1,
    "the fixed refusal card was emitted once without a retry loop",
  );
  t.diagnostic("apply=1 process_queries=1 child_spawns=0 retries=0 fixed_cards=1");
});
