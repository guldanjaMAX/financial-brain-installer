import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { cmdMcpConfig, mcpRegistrationDescriptor, resumeClaudeRouteAfterCommand, successMark } from "../brain.mjs";
import {
  CLAUDE_CODE_FULL_EXIT_CARD,
  openPartBMcpTransport,
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

async function fixture(t, label, { withServer = true, worker = { timing: backendTiming } } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `${label}-`)));
  if (process.platform === "win32") {
    // Exercise the real default writer against a guide inside its scratch profile.
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = root;
    t.after(() => {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    });
  }
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
    if (request.url === "/api/admin/brain/money-query") {
      if (worker.moneyUnavailable) {
        response.end(JSON.stringify({ error: "Synthetic money query failure." }));
        return;
      }
      if (body.sql === "SELECT 1 AS link_probe FROM fin_accounts LIMIT 1" && body.max_rows === 1) {
        response.end(JSON.stringify({ rows: [{ link_probe: 1 }], row_count: 1 }));
        return;
      }
      response.end(JSON.stringify({ rows: [{ amount_cents: 125 }], row_count: 1 }));
      return;
    }
    if (request.url === "/api/admin/brain/document-read") {
      response.end(JSON.stringify({ id: body.id, text: "Synthetic document." }));
      return;
    }
    response.end(JSON.stringify({
      mode: "think",
      answer: "The fixed control completed. [1]",
      status: worker.status,
      citations: [{ n: 1 }],
      results: [],
      evidence_gate: { supported: true },
      timing: worker.timing?.(),
      answer_error: worker.answerError,
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
      version: worker.version ?? "0.4.27",
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
      line === `  ${successMark(false)}    Claude answer route ready: route_receipt_accepted`).length,
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

test("ordinary reconnect retains the money link with partial coverage and no backend route timing", async (t) => {
  const worker = { version: "0.4.31", status: "coverage_incomplete" };
  const state = await fixture(t, "reconnect-missing-receipt", { worker });
  const domain = JSON.parse(readFileSync(state.manifest)).brain.domain;
  const desired = mcpRegistrationDescriptor({ client: { slug: "fixture" } }, state.manifest, { baseUrl: domain });
  const config = join(state.root, ".claude.json");
  const oldLink = JSON.stringify({ mcpServers: {} });
  const newLink = JSON.stringify({ mcpServers: {
    fixture: { type: desired.type, command: desired.command, args: desired.args, env: desired.env },
  } });
  writeFileSync(config, oldLink);
  const apply = await captureConsole(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    processSnapshot: () => [],
    wireAgents: async () => {
      writeFileSync(config, newLink);
      return { wired: ["Claude Code"], failures: [], skipped: [] };
    },
  }));
  // Model the reconnect wrapper's restore-on-nonzero behavior.
  if (apply.error) writeFileSync(config, oldLink);
  assert.equal(apply.error, null);
  assert.equal(readFileSync(config, "utf8"), newLink);
  assert.equal(apply.value.route_readiness.ready, false);
  assert.equal(apply.value.route_readiness.reason, "receipt_missing");
  assert.equal(apply.output.filter(line => line.includes(
    "Claude answers are not proven yet. Update my Brain, then say Check my Brain.",
  )).length, 1);
  assert.deepEqual(state.requests.map(request => request.path), [
    "/api/rag/think", "/api/admin/brain/money-query",
  ]);

  worker.timing = () => ({ ...backendTiming(), route: "unified" });
  const options = {
    processSnapshot: () => [],
    wireOptions: { claudeConfigPath: config },
  };
  const failedRetry = await captureConsole(() => resumeClaudeRouteAfterCommand("health", [state.manifest], options));
  assert.equal(failedRetry.error, null);
  assert.equal(failedRetry.value?.reason, "receipt_unrecognized");
  assert.equal(failedRetry.output.filter(line => line.includes("Claude answer route not ready: receipt_unrecognized.")).length, 1);
  assert.deepEqual(state.requests.map(request => request.path), [
    "/api/rag/think", "/api/admin/brain/money-query", "/api/rag/think",
  ]);

  worker.status = undefined;
  worker.timing = backendTiming;
  const retry = await captureConsole(() => resumeClaudeRouteAfterCommand("health", [state.manifest], options));
  assert.equal(retry.error, null);
  assert.equal(retry.value?.ready, true);
  assert.equal(retry.value.reason, "route_receipt_accepted");
  assert.equal(retry.output.filter(line => line.includes("Claude answer route ready: route_receipt_accepted")).length, 1);
  assert.equal(readFileSync(config, "utf8"), newLink);
});

test("receipt-free reconnect checks money for a completed answer with or without a coverage warning", async (t) => {
  let seed = 0x0434c0a7;
  for (const status of [undefined, "coverage_incomplete"]) {
    for (const timing of [undefined, () => ({ ...backendTiming(), models: [] })]) {
      // Use a fixed seed to vary the order of the healthy and unavailable endpoint trials.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      for (const moneyUnavailable of [Boolean(seed & 1), !Boolean(seed & 1)]) {
        await t.test(`${status ?? "covered"} / ${timing ? "partial timing" : "no timing"} / ${moneyUnavailable ? "unavailable" : "healthy"}`, async (t) => {
          const state = await fixture(t, "reconnect-coverage", { worker: { status, timing, moneyUnavailable } });
          const counters = { apply: 0 };
          const apply = await installedDefaults(state.manifest, counters, () => []);
          assert.equal(counters.apply, 1);
          assert.deepEqual(state.requests.map(({ path }) => path), [
            "/api/rag/think", "/api/admin/brain/money-query",
          ]);
          assert.ok(state.requests.every(({ authorized }) => authorized));
          if (moneyUnavailable) {
            assert.match(apply.error?.message ?? "", /Claude answer route not ready: receipt_missing/u);
            assert.doesNotMatch(apply.output.join("\n"), /Claude answers are not proven yet/u);
          } else {
            assert.equal(apply.error, null);
            assert.equal(apply.value.route_readiness.reason, "receipt_missing");
            assert.equal(apply.value.route_readiness.ready, false);
            assert.equal(apply.value.route_readiness.money_link_verified, true);
          }
        });
      }
    }
  }
});

test("ordinary reconnect refuses missing receipts when the money query fails or the answer route reports a fault", async (t) => {
  const cases = [
    ["unavailable money tool", { moneyUnavailable: true }, "receipt_missing"],
    ["unavailable search", { status: "search_unavailable" }, "receipt_missing"],
    ["withheld answer without timing", { status: "answer_withheld" }, "receipt_missing"],
    ["answer error", { answerError: "Synthetic answer error." }, "tool_failed"],
    ["wrong model", { timing: () => {
      const timing = backendTiming();
      timing.models[0].id = "claude-sonnet-5-5";
      return timing;
    } }, "receipt_unrecognized"],
    ["fallback route", { timing: () => ({ ...backendTiming(), route: "unified" }) }, "receipt_unrecognized"],
  ];
  for (const [label, worker, reason] of cases) {
    await t.test(label, async (t) => {
      const state = await fixture(t, "reconnect-route-fault", { worker });
      const apply = await installedDefaults(state.manifest, { apply: 0 }, () => []);
      assert.deepEqual(state.requests.map(({ path }) => path), [
        "/api/rag/think", ...(worker.moneyUnavailable ? ["/api/admin/brain/money-query"] : []),
      ]);
      assert.match(apply.error?.message ?? "", new RegExp(`Claude answer route not ready: ${reason}\\.`));
      assert.doesNotMatch(apply.output.join("\n"), /Claude answers are not proven yet/);
    });
  }
});

test("ordinary reconnect leaves incomplete backend timing pending without evicting the money link", async (t) => {
  const worker = { timing: () => ({ ...backendTiming(), models: [] }) };
  const state = await fixture(t, "reconnect-incomplete-timing", { worker });
  const apply = await installedDefaults(state.manifest, { apply: 0 }, () => []);
  assert.equal(apply.error, null);
  assert.equal(apply.value.route_readiness.ready, false);
  assert.equal(apply.value.route_readiness.reason, "receipt_missing");
  assert.deepEqual(state.requests.map(request => request.path), [
    "/api/rag/think", "/api/admin/brain/money-query",
  ]);
});

test("approved reconnect defers proof until a later ordinary CLI run", async (t) => {
  const state = await fixture(t, "reconnect-proof");
  const domain = JSON.parse(readFileSync(state.manifest)).brain.domain;
  const desired = mcpRegistrationDescriptor({ client: { slug: "fixture" } }, state.manifest, { baseUrl: domain });
  const config = join(state.root, ".claude.json");
  writeFileSync(config, JSON.stringify({ mcpServers: {
    fixture: { type: desired.type, command: desired.command, args: desired.args, env: desired.env },
  } }));
  const applied = await captureConsole(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true, "replace-owner-entry": true },
    wireAgents: async () => ({ wired: ["Claude Code"], failures: [], skipped: [], ownerEntryReplaced: true }),
    processSnapshot: () => ["claude"],
  }));
  assert.equal(applied.error, null);
  assert.equal(applied.value.route_readiness.reason, "claude_code_running");
  assert.equal(state.requests.length, 0);
  assert.equal(applied.output.filter(line => line.includes("Fully quit and reopen Claude Code")).length, 1);

  // A reopened client starts the exact registered runtime. Its tool calls
  // are independent of the deferred brain_think control.
  const reopened = await openPartBMcpTransport(desired);
  try {
    const init = await reopened.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
    });
    assert.equal(init.result.serverInfo.name, "fixture");
    const list = await reopened.request("tools/list", {});
    const names = list.result.tools.map(tool => tool.name);
    assert.equal(names.length, 9);
    assert.ok(names.includes("brain_money_query") && names.includes("brain_fetch"));
    const money = await reopened.request("tools/call", {
      name: "brain_money_query", arguments: { sql: "SELECT amount_cents FROM fin_transactions LIMIT 1" },
    });
    assert.equal(JSON.parse(money.result.content[0].text).rows[0].amount_cents, 125);
    const doc = await reopened.request("tools/call", {
      name: "brain_fetch", arguments: { id: "fixture:one" },
    });
    assert.equal(JSON.parse(doc.result.content[0].text).id, "fixture:one");
  } finally {
    await reopened.close();
  }
  assert.deepEqual(state.requests.map(request => request.path), [
    "/api/admin/brain/money-query", "/api/admin/brain/document-read",
  ]);

  const options = { processSnapshot: () => [], wireOptions: { claudeConfigPath: config } };
  assert.equal(await resumeClaudeRouteAfterCommand("daily", ["status", state.manifest], options), null);
  const stillOpen = await resumeClaudeRouteAfterCommand("health", [state.manifest], {
    ...options, processSnapshot: () => ["claude"],
  });
  assert.ok(stillOpen, "a later invocation finds the pending route proof");
  assert.equal(stillOpen.reason, "claude_code_running");
  assert.equal(state.requests.length, 2);
  const registered = readFileSync(config);
  writeFileSync(config, "{}");
  const failedRetry = await captureConsole(() => resumeClaudeRouteAfterCommand("health", [state.manifest], options));
  assert.equal(failedRetry.error, null);
  assert.equal(failedRetry.value.ready, false);
  assert.equal(failedRetry.value.reason, "transport_open_failed");
  assert.equal(failedRetry.output.filter(line => line.includes("Claude answer route not ready: transport_open_failed.")).length, 1);
  assert.equal(state.requests.length, 2);
  writeFileSync(config, registered);
  const proof = await resumeClaudeRouteAfterCommand("daily", ["run", state.manifest], options);
  assert.equal(proof.ready, true);
  assert.deepEqual(proof.route_events, EXPECTED_EVENTS);
  assert.equal(state.requests.length, 3);
  assert.equal(await resumeClaudeRouteAfterCommand("health", [state.manifest], options), null);
  assert.equal(state.requests.length, 3);
});
