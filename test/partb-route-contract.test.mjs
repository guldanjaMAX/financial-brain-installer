import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import pathApi, { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cmdConnect,
  cmdConnectAnthropic,
  cmdMcpConfig,
  mcpRegistrationDescriptor,
  successMark,
} from "../brain.mjs";
import {
  BUILT_IN_ANSWER_MODEL,
  RECOMMENDED_ANSWER_SETUP,
} from "../operations/answer-setup.mjs";
import {
  CLAUDE_WORKSPACE_MARKER,
  writeClaudeWorkspaceGuide,
} from "../operations/claude-workspace.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import {
  CLAUDE_CODE_FULL_EXIT_CARD,
  PART_B_ROUTE_CONTROL,
  PART_B_ROUTE_READINESS_REASONS,
  normalizePartBRouteReadinessReason,
  proveClaudeCodeFullyExited,
  provePartBRouteReadiness,
  validatePartBRouteReceiptContent,
} from "../operations/answer-route-proof.mjs";
import worker from "../worker/src/index.js";
import {
  PUBLIC_INSTALL_SMOKE_CHUNK,
  PUBLIC_INSTALL_SMOKE_DOC_UID,
  PUBLIC_INSTALL_SMOKE_ID,
  PUBLIC_INSTALL_SMOKE_METADATA,
  PUBLIC_INSTALL_SMOKE_SOURCE,
  PUBLIC_INSTALL_SMOKE_TITLE,
} from "../worker/src/lib/install-smoke.js";
import { applyMoneyVeto, isMoneyQuestion } from "../worker/src/lib/money-veto.js";
import { createQueryTiming } from "../worker/src/lib/query-timing.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PART_B_PROOF_MODULE = new URL("../operations/answer-route-proof.mjs", import.meta.url);
const FIXTURE_ADMIN_KEY = "fixture-admin-key-not-a-credential";
const LEGACY_PART_B_ROUTE_QUESTION =
  "What does the Financial Brain first-install smoke proof establish?";
const EXPECTED_PART_B_ROUTE_QUESTION =
  "What does the first-install smoke proof establish?";
const INSTALL_SMOKE_ANSWER =
  "The Financial Brain first-install smoke proof establishes that the deployed system accepted, stored, and indexed one authenticated installation check [1].";

// Independent contract inventory. Do not derive this from the production
// allowlist: an omitted proof or validator outcome must make this test red.
const EXPECTED_PART_B_ROUTE_READINESS_REASONS = Object.freeze([
  "brain_url_unavailable",
  "claude_apply_required",
  "claude_code_running",
  "content_invalid",
  "control_invalid",
  "descriptor_invalid",
  "diagnostics_unauthorized",
  "full_exit_boundary_absent",
  "guide_refresh_refused",
  "initialize_failed",
  "json_duplicate_member",
  "manifest_unavailable",
  "model_pair_mismatch",
  "process_stop_failed",
  "receipt_accepted",
  "receipt_conflicting",
  "receipt_malformed",
  "receipt_missing",
  "receipt_nested",
  "receipt_unrecognized",
  "route_receipt_accepted",
  "tool_failed",
  "transport_close_failed",
  "transport_invalid",
  "transport_open_failed",
  "transport_request_failed",
]);

// This object is an assertion target only. It is never supplied to product
// code as evidence and therefore cannot make a readiness decision pass.
const EXPECTED_ROUTE_RECEIPT = Object.freeze({
  schema_version: 1,
  route: "mcp.brain_think",
  backend_route: "think",
  outcome: "ok",
  answer_provider: "anthropic",
  answer_model: "claude-opus-5-5",
  answer_calls: 1,
  answer_errors: 0,
  check_provider: "anthropic",
  check_model: "claude-sonnet-5-5",
  check_calls: 1,
  check_errors: 0,
  fallback_search_calls: 0,
});
const ACCEPTED_GUIDE_REFRESH = Object.freeze({
  schema_version: 1,
  operation: "claude_workspace_guide.refresh",
  outcome: "written",
  managed: true,
  answer_route: "brain_think_first",
  guide_generation: 1,
});

function installSmokeThinkEnvironment() {
  const row = {
    chunk_uid: `${PUBLIC_INSTALL_SMOKE_DOC_UID}#0`,
    doc_uid: PUBLIC_INSTALL_SMOKE_DOC_UID,
    text: PUBLIC_INSTALL_SMOKE_CHUNK,
    source: PUBLIC_INSTALL_SMOKE_SOURCE,
    source_kind: PUBLIC_INSTALL_SMOKE_SOURCE,
    source_id: PUBLIC_INSTALL_SMOKE_ID,
    uri: null,
    title: PUBLIC_INSTALL_SMOKE_TITLE,
    document_date: null,
    date_source: null,
    date_reliable: 0,
    text_source: "native",
    text_reliable: 1,
    authority_meta: JSON.stringify(PUBLIC_INSTALL_SMOKE_METADATA),
    authority_document_head: PUBLIC_INSTALL_SMOKE_CHUNK,
    client: null,
    category: null,
    top_folder: null,
    platform: null,
  };
  const calls = { embedding: 0, answer: 0, verifier: 0, d1: 0, vector: 0 };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: FIXTURE_ADMIN_KEY,
    DB: {
      prepare(sql) {
        calls.d1++;
        return {
          bind() { return this; },
          all: async () => {
            if (/unchunked-tax-document-candidates/u.test(sql) ||
                /SELECT name FROM sources/u.test(sql)) return { results: [] };
            return { results: [row] };
          },
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/u.test(sql)) {
              return {
                schema_version: 12,
                mutation_id: null,
                mutation_submitted_at: null,
                projection_status: "verified",
                bootstrap_epoch: 0,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: 1,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/FROM vector_outbox/u.test(sql)) {
              return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
            }
            return /count\(\*\)/iu.test(sql)
              ? { n: 1, stored_documents: 1, logical_documents: 1 }
              : null;
          },
          run: async () => ({}),
        };
      },
    },
    VECTORIZE: {
      query: async () => {
        calls.vector++;
        return { matches: [{ id: row.chunk_uid }] };
      },
      describe: async () => ({ vectorCount: 1, processedUpToMutation: null }),
    },
    AI: {
      run: async (model, input) => {
        if (String(model).includes("bge-")) {
          calls.embedding++;
          return { data: [[0.1, 0.2, 0.3]] };
        }
        const system = String(input?.messages?.[0]?.content || "");
        if (/verify a proposed answer/u.test(system)) {
          calls.verifier++;
          return {
            response: { supported: true, complete: true, evidence: [1], reason: "direct support" },
            usage: {},
          };
        }
        calls.answer++;
        return { response: INSTALL_SMOKE_ANSWER, usage: {} };
      },
    },
  };
  return { env, calls };
}

async function askInstallSmoke(question) {
  const state = installSmokeThinkEnvironment();
  const response = await worker.fetch(new Request("https://fixture.invalid/api/rag/think", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": FIXTURE_ADMIN_KEY,
    },
    body: JSON.stringify({ q: question }),
  }), state.env, { waitUntil() {}, passThroughOnException() {} });
  return { ...state, response, body: await response.json() };
}

function syntheticManifest(answerSetup = "built-in") {
  const retrieval = answerSetup === "opus-sonnet"
    ? { ...RECOMMENDED_ANSWER_SETUP }
    : { answer_model: BUILT_IN_ANSWER_MODEL, gate_model: BUILT_IN_ANSWER_MODEL };
  return {
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Owner", timezone: "UTC" },
    brain: { version: "0.4.21", worker_name: "fixture-brain", domain: "fixture.invalid" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        storage: "d1",
        d1_database_id: "fixture-database",
        vectorize_index: "fixture-index",
      },
    },
    operations: { admin_key_secret: null },
    retrieval,
    safety: { daily_llm_spend_cap_usd: 10 },
  };
}

function fixture(t, label, answerSetup = "built-in") {
  assert.ok(process.env.HOME, "the focused test requires an isolated HOME");
  mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  const home = realpathSync.native(process.env.HOME);
  const parent = join(home, "partb-route-contract-fixtures");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = realpathSync.native(mkdtempSync(join(parent, `${label}-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, `${JSON.stringify(syntheticManifest(answerSetup), null, 2)}\n`);
  writeFileSync(join(root, ".brain-admin-key"), FIXTURE_ADMIN_KEY, { mode: 0o600 });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  chmodSync(launchctl, 0o700);
  const priorLaunchctl = process.env.BRAIN_TEST_LAUNCHCTL;
  process.env.BRAIN_TEST_LAUNCHCTL = launchctl;
  t.after(() => {
    if (priorLaunchctl === undefined) delete process.env.BRAIN_TEST_LAUNCHCTL;
    else process.env.BRAIN_TEST_LAUNCHCTL = priorLaunchctl;
  });
  return { root, manifest, launchctl };
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function writeAnswerSetup(manifestPath, answerSetup) {
  const manifest = readManifest(manifestPath);
  manifest.retrieval = answerSetup === "opus-sonnet"
    ? { ...RECOMMENDED_ANSWER_SETUP }
    : { answer_model: BUILT_IN_ANSWER_MODEL, gate_model: BUILT_IN_ANSWER_MODEL };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function remoteTiming() {
  let clock = 0;
  const timing = createQueryTiming({ route: "think", now: () => clock });
  const answer = timing.model("answer_llm", "anthropic", "claude-opus-5-5");
  clock += 3;
  answer();
  const check = timing.model("verifier_llm", "anthropic", "claude-sonnet-5-5");
  clock += 2;
  check();
  return timing.finish("ok");
}

function descriptorFor(state) {
  return mcpRegistrationDescriptor(readManifest(state.manifest), state.manifest, {
    baseUrl: "https://fixture.invalid",
    serverPath: join(ROOT, "components", "brain-mcp.mjs"),
    nodePath: process.execPath,
  });
}

function startMcpFromDescriptor(t, state, timing, label, descriptor, { profile } = {}) {
  const preload = join(state.root, `${label}-preload.mjs`);
  writeFileSync(preload, `
    globalThis.fetch = async (url, options) => {
      if (url !== "https://fixture.invalid/api/rag/think" || options?.method !== "POST") {
        throw new Error("unexpected synthetic request");
      }
      return Response.json({
        mode: "think",
        answer: "The synthetic control value is seven units. [1]",
        citations: [{ n: 1 }],
        results: [],
        evidence_gate: { supported: true },
        timing: ${JSON.stringify(timing)}
      });
    };
  `);

  const child = spawn(descriptor.command, [
    "--import",
    pathToFileURL(preload).href,
    ...descriptor.args,
  ], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TZ: "UTC",
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: state.launchctl,
      ...descriptor.env,
      BRAIN_AGENT_PROFILE: profile ?? descriptor.env.BRAIN_AGENT_PROFILE,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const counters = { initialize: 0, tool: 0 };
  const calls = [];
  const pending = [];
  let output = "";
  let errors = "";
  let closed = false;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (!waiter) throw new Error("MCP returned an unsolicited reply");
      try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
    }
  });
  const exit = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      const failure = code === 0 && errors === "" && pending.length === 0
        ? null
        : new Error(`synthetic MCP exit=${code} stderr_bytes=${Buffer.byteLength(errors)} pending=${pending.length}`);
      if (failure) {
        while (pending.length) pending.shift().reject(failure);
        reject(failure);
      } else resolve();
    });
  });

  const request = (method, params = {}) => {
    if (closed) throw new Error("synthetic MCP process is closed");
    if (method === "initialize") counters.initialize++;
    if (method === "tools/call") counters.tool++;
    calls.push(method === "tools/call" ? params.name : method);
    const id = calls.length;
    const reply = new Promise((resolve, reject) => pending.push({ resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  };

  const close = async () => {
    if (!closed) child.stdin.end();
    await exit;
  };
  t.after(async () => {
    if (!closed) {
      child.stdin.end();
      await exit;
    }
  });
  return { request, close, counters, calls, descriptor };
}

function startMcp(t, state, timing, label, options = {}) {
  return startMcpFromDescriptor(t, state, timing, label, descriptorFor(state), options);
}

function initializeParams() {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  };
}

async function callThink(mcp) {
  return mcp.request("tools/call", {
    name: "brain_think",
    arguments: { q: "What is the synthetic control value?" },
  });
}

function guideWriterOptions(root, counters, { nativeSafe = true } = {}) {
  return {
    platformName: "win32",
    brainCliPath: join(root, "brain.mjs"),
    nodePath: process.execPath,
    ownership: {
      platform: "win32",
      pathApi,
      profile: root,
      windowsAttributesSafe: (paths) => {
        counters.ownershipDecisions++;
        assert.ok(paths.length > 0, "the real Windows guide decision inspected a path");
        return nativeSafe;
      },
    },
  };
}

function isWorkspaceStagingPath(value) {
  return typeof value === "string" &&
    value.includes(".financial-brain-pending-") && value.endsWith(".tmp");
}

function transientReadLock() {
  const error = new Error("synthetic transient Windows staging read lock");
  error.code = "EACCES";
  return error;
}

function setupOptions(state, counters, writerOptions) {
  return {
    platform: "win32",
    stdinIsTTY: false,
    withBrainLifecycleLock: async (_input, action) => {
      counters.setupLocks++;
      return action();
    },
    verifyVersion: async () => { counters.versionChecks++; },
    verifyDeploy: async () => { counters.deployChecks++; },
    preflight: async () => { throw new Error("dashboard mode must not run provider preflight"); },
    listSecretNames: async () => {
      counters.secretInventories++;
      return ["ANTHROPIC_API_KEY"];
    },
    putSecret: async () => { throw new Error("dashboard mode must not write a provider secret"); },
    deleteSecret: async () => { throw new Error("the success path must not delete a provider secret"); },
    prepareDaily: async () => { counters.dailyPrepares++; },
    reconcileDaily: async () => { counters.dailyReconciles++; },
    deploy: async () => { counters.deploys++; },
    checkWorker: async () => {
      counters.workerChecks++;
      return {
        answer: { model: RECOMMENDED_ANSWER_SETUP.answer_model, status: "ok" },
        check: { model: RECOMMENDED_ANSWER_SETUP.gate_model, status: "ok" },
      };
    },
    sleep: async () => { throw new Error("the accepted model check must not retry"); },
    now: () => new Date("2026-10-24T12:00:00.000Z"),
    writeClaudeWorkspaceGuide: (manifestPath, options = writerOptions) => {
      counters.automaticGuideCalls++;
      return writeClaudeWorkspaceGuide(manifestPath, options);
    },
    claudeWorkspaceOptions: writerOptions,
  };
}

async function captureConsole(action) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.map(String).join(" "));
  try {
    return { value: await action(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

async function captureConsoleOutcome(action) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.map(String).join(" "));
  try {
    return { value: await action(), error: null, output: lines.join("\n") };
  } catch (error) {
    return { value: null, error, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

const ROUTE_RETRY_GUIDANCE =
  "Nothing was removed. Close Claude completely, including Claude Code, the Claude desktop app, and any tray or background process, then rerun the same command. If it stops again, send this line to your setup partner.";

function acceptedRouteContent() {
  return [{
    type: "text",
    text: JSON.stringify({ route_receipt: EXPECTED_ROUTE_RECEIPT }),
  }];
}

async function runExitContractArm(t, label, reason = "route_receipt_accepted", { claudeWireFailure = false } = {}) {
  const guideRefusal = reason === "guide_refresh_refused";
  const state = fixture(t, label, guideRefusal ? "built-in" : "opus-sonnet");
  const counters = {
    apply: 0,
    ownershipDecisions: 0,
    stops: 0,
    openAttempts: 0,
    requests: [],
    closes: 0,
  };
  const safeWriter = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, safeWriter).status, "written");
  if (guideRefusal) writeAnswerSetup(state.manifest, "opus-sonnet");

  const noClaude = reason === "claude_apply_required";
  const outcome = await captureConsoleOutcome(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    wireAgents: async () => {
      counters.apply++;
      return {
        wired: noClaude ? [] : ["Claude Code"],
        skipped: [],
        failures: claudeWireFailure ? ["Claude Code"] : [],
      };
    },
    routeReadinessOptions: {
      claudeWorkspaceOptions: guideRefusal
        ? guideWriterOptions(state.root, counters, { nativeSafe: false })
        : safeWriter,
      stopMcpProcess: async () => {
        counters.stops++;
        if (reason === "claude_code_running") {
          await proveClaudeCodeFullyExited({ readProcessList: async () => ["claude"] });
        }
      },
      openMcpTransport: async () => {
        counters.openAttempts++;
        if (reason === "transport_open_failed") throw new Error("synthetic open refusal");
        return {
          request: async (method) => {
            counters.requests.push(method);
            if (method === "initialize") return { result: {} };
            if (reason === "tool_failed") return { result: { isError: true, content: [] } };
            if (reason === "receipt_conflicting") {
              return { result: { content: [...acceptedRouteContent(), ...acceptedRouteContent()] } };
            }
            return { result: { content: acceptedRouteContent() } };
          },
          close: async () => { counters.closes++; },
        };
      },
    },
  }));
  return { counters, outcome };
}

async function runPartialWiringArm(t, label, wiringResult) {
  const state = fixture(t, label, "opus-sonnet");
  const counters = { apply: 0, ownershipDecisions: 0, proofAttempts: 0, routeDecisions: 0 };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const outcome = await captureConsoleOutcome(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    onPartBRouteDecision: () => { counters.routeDecisions++; },
    wireAgents: async () => {
      counters.apply++;
      return wiringResult;
    },
    routeReadinessOptions: {
      claudeWorkspaceOptions: writerOptions,
      stopMcpProcess: async () => {},
      openMcpTransport: async () => {
        counters.proofAttempts++;
        return {
          request: async (method) => method === "initialize"
            ? { result: {} }
            : { result: { content: acceptedRouteContent() } },
          close: async () => {},
        };
      },
    },
  }));
  return { counters, outcome };
}

async function runWiringSettlementArm(t, label, row, settlement, answerSetup = "opus-sonnet") {
  const state = fixture(t, label, answerSetup);
  const counters = { apply: 0, ownershipDecisions: 0, proofAttempts: 0, routeDecisions: 0 };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const fulfilled = { wired: ["Claude Code"], skipped: [], failures: [] };
  const outcome = await captureConsoleOutcome(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    wireOptions: { platform: row.platform },
    onPartBRouteDecision: () => { counters.routeDecisions++; },
    wireAgents: (_manifest, _manifestPath, wireOptions) => {
      counters.apply++;
      assert.equal(wireOptions.platform, row.platform, "the selected wiring surface was reached");
      if (row.delivery === "throw") {
        if (settlement === "rejected") throw row.rejection;
        return fulfilled;
      }
      return settlement === "rejected"
        ? Promise.reject(row.rejection)
        : Promise.resolve(fulfilled);
    },
    routeReadinessOptions: {
      claudeWorkspaceOptions: writerOptions,
      stopMcpProcess: async () => {},
      openMcpTransport: async () => {
        counters.proofAttempts++;
        return {
          request: async (method) => method === "initialize"
            ? { result: {} }
            : { result: { content: acceptedRouteContent() } },
          close: async () => {},
        };
      },
    },
  }));
  return { counters, outcome };
}

async function applyMcpRegistration(state, counters) {
  const expected = descriptorFor(state);
  const run = await captureConsole(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    wireAgents: async (manifest, manifestPath) => {
      counters.applyDecisions++;
      assert.equal(manifestPath, state.manifest);
      assert.deepEqual(
        mcpRegistrationDescriptor(manifest, manifestPath, {
          baseUrl: "https://fixture.invalid",
          serverPath: expected.args[0],
          nodePath: expected.command,
        }),
        expected,
      );
      return { wired: ["Claude Code"], skipped: [], failures: [] };
    },
    routeReadinessOptions: {
      stopMcpProcess: async () => {},
      openMcpTransport: async (descriptor) => {
        assert.deepEqual(descriptor, expected);
        return {
          request: async (method) => method === "initialize"
            ? { result: {} }
            : { result: { content: acceptedRouteContent() } },
          close: async () => {},
        };
      },
    },
  }));
  assert.deepEqual(run.value.wired, ["Claude Code"]);
  return expected;
}

async function loadPartBProofModule() {
  try {
    return await import(PART_B_PROOF_MODULE.href);
  } catch {
    assert.fail(
      "NAMED GAP: sealed code has no production partb-route-readiness module; a test-local substitute is forbidden",
    );
  }
}

test("CONTROL: production MCP descriptor, Windows renderer, and apply decision agree", async (t) => {
  const state = fixture(t, "registration", "opus-sonnet");
  const counters = { applyDecisions: 0 };
  const descriptor = await applyMcpRegistration(state, counters);
  const manual = await captureConsole(() => cmdMcpConfig(state.manifest, {
    flags: {},
    platform: "win32",
  }));

  assert.equal(counters.applyDecisions, 1, "the real --apply branch reached external agent wiring");
  assert.equal(descriptor.type, "stdio");
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.args, [join(ROOT, "components", "brain-mcp.mjs")]);
  assert.equal(descriptor.env.BRAIN_MANIFEST, state.manifest);
  assert.equal(descriptor.env.BRAIN_AGENT_PROFILE, "owner-assistant");
  assert.match(manual.output, /PowerShell/);
  assert.ok(manual.output.includes(descriptor.command));
  assert.doesNotMatch(manual.output, / \\\n/, "the Windows registration is one PowerShell line");
  t.diagnostic("descriptor=1 mcp_apply=1 windows_renderer=1");
});

test("mcp-config Part B route status is one exact success line or a fatal closed refusal", async (t) => {
  const refusals = [
    "claude_code_running",
    "guide_refresh_refused",
    "transport_open_failed",
    "tool_failed",
    "receipt_conflicting",
    "claude_apply_required",
  ];
  const readyLine = `${successMark(false)}    Claude answer route ready: route_receipt_accepted`;

  for (const reason of refusals) {
    await t.test(`${reason} has a paired ready control`, async (t) => {
      const green = await runExitContractArm(t, `green-${reason}`);
      assert.equal(green.outcome.error, null);
      assert.equal(green.outcome.value.route_readiness?.ready, true);
      assert.equal(green.outcome.value.route_readiness?.reason, "route_receipt_accepted");
      assert.equal(
        green.outcome.output.split("\n").filter((line) => line === readyLine).length,
        1,
        "the exact ready line was emitted once",
      );
      assert.equal(green.counters.apply, 1);
      assert.ok(green.counters.ownershipDecisions > 0);
      assert.equal(green.counters.stops, 1);
      assert.equal(green.counters.openAttempts, 1);
      assert.deepEqual(green.counters.requests, ["initialize", "tools/call"]);
      assert.equal(green.counters.closes, 1);

      const refused = await runExitContractArm(t, `refused-${reason}`, reason);
      const expected = `Claude answer route not ready: ${reason}.` +
        (reason === "claude_code_running" ? "" : `\n      ${ROUTE_RETRY_GUIDANCE}`);
      assert.equal(refused.outcome.error?.constructor?.name, "Fatal", "die() made the command nonzero");
      assert.equal(refused.outcome.error?.message, expected);
      assert.equal(refused.counters.apply, 1, "the apply decision point was reached");

      if (reason === "claude_code_running") {
        assert.equal(refused.counters.stops, 1, "the full-exit decision point was reached");
        assert.equal(refused.counters.openAttempts, 0);
        assert.equal(
          refused.outcome.output.split("\n").filter((line) =>
            line.includes(CLAUDE_CODE_FULL_EXIT_CARD.message)).length,
          1,
          "the existing close card remained the only retry guidance",
        );
      } else if (reason === "guide_refresh_refused") {
        assert.ok(refused.counters.ownershipDecisions > 1, "the guide ownership refusal was reached");
        assert.equal(refused.counters.stops, 0);
      } else if (reason === "transport_open_failed") {
        assert.equal(refused.counters.stops, 1);
        assert.equal(refused.counters.openAttempts, 1, "the transport-open refusal was reached");
        assert.deepEqual(refused.counters.requests, []);
      } else if (reason === "tool_failed" || reason === "receipt_conflicting") {
        assert.deepEqual(refused.counters.requests, ["initialize", "tools/call"]);
        assert.equal(refused.counters.closes, 1, "the transport close decision was reached");
      } else {
        assert.equal(refused.counters.stops, 0, "no Claude route was falsely attempted");
        assert.match(refused.outcome.output, /no supported assistant found/);
        const wireFailure = await runExitContractArm(
          t,
          "refused-claude-wire-failure",
          reason,
          { claudeWireFailure: true },
        );
        assert.equal(wireFailure.counters.apply, 1, "the failed wiring decision point was reached");
        assert.equal(wireFailure.outcome.error?.constructor?.name, "Fatal");
        assert.equal(wireFailure.outcome.error?.message, expected);
      }
    });
  }
});

test("mcp-config Part B partial wiring always reaches one closed route decision", async (t) => {
  const partialResults = [
    {
      label: "Claude wired while Codex failed",
      wired: ["Claude Code"],
      skipped: [],
      failures: ["Codex"],
    },
    {
      label: "Claude wired while Codex was skipped and failed",
      wired: ["Claude Code"],
      skipped: ["Codex"],
      failures: ["Codex"],
    },
    {
      label: "ambiguous duplicate Claude result",
      wired: ["Claude Code"],
      skipped: [],
      failures: ["Claude Code"],
    },
    {
      label: "ambiguous all-wired result with a failure",
      wired: ["Claude Code", "Codex"],
      skipped: [],
      failures: ["Codex"],
    },
  ];

  for (const [index, partial] of partialResults.entries()) {
    await t.test(partial.label, async () => {
      const refused = await runPartialWiringArm(t, `partial-refused-${index}`, partial);
      assert.equal(refused.outcome.error?.constructor?.name, "Fatal");
      assert.equal(
        refused.outcome.error?.message,
        `Claude answer route not ready: route_unproven.\n      ${ROUTE_RETRY_GUIDANCE}`,
      );
      assert.equal(refused.counters.apply, 1, "the partial wiring decision was reached");
      assert.equal(refused.counters.proofAttempts, 0, "an ambiguous partial result cannot start route proof");
      assert.equal(refused.counters.routeDecisions, 1, "the partial result reached the closed route gate");

      const green = await runPartialWiringArm(t, `partial-green-${index}`, {
        ...partial,
        failures: [],
      });
      assert.equal(green.outcome.error, null);
      assert.equal(green.outcome.value.route_readiness?.reason, "route_receipt_accepted");
      assert.equal(green.counters.apply, 1);
      assert.equal(green.counters.proofAttempts, 1);
      assert.equal(green.counters.routeDecisions, 1, "the paired ready decision was reached");
    });
  }
});

test("mcp-config Part B converts every rejected wiring settlement into one closed route decision", async (t) => {
  const rejectedWiringCases = [
    {
      label: "POSIX synchronous unsafe configuration read",
      platform: "darwin",
      delivery: "throw",
      rejection: new Error("Codex's user configuration could not be read safely"),
    },
    {
      label: "POSIX asynchronous ownership refusal",
      platform: "linux",
      delivery: "promise",
      rejection: new TypeError("synthetic ownership refusal"),
    },
    {
      label: "Windows asynchronous unreadable configuration",
      platform: "win32",
      delivery: "promise",
      rejection: "synthetic unreadable configuration",
    },
    {
      label: "adapter rejection without an Error instance",
      platform: "win32",
      delivery: "promise",
      rejection: Object.freeze({ kind: "synthetic_adapter_refusal" }),
    },
  ];

  for (const [index, row] of rejectedWiringCases.entries()) {
    await t.test(row.label, async () => {
      const refused = await runWiringSettlementArm(t, `wiring-rejected-${index}`, row, "rejected");
      assert.equal(refused.outcome.error?.constructor?.name, "Fatal");
      assert.equal(
        refused.outcome.error?.message,
        `Claude answer route not ready: route_unproven.\n      ${ROUTE_RETRY_GUIDANCE}`,
      );
      assert.equal(refused.counters.apply, 1, "the rejected wiring decision was reached");
      assert.equal(refused.counters.proofAttempts, 0, "rejected wiring cannot start route proof");
      assert.equal(refused.counters.routeDecisions, 1, "rejected wiring reached one closed route gate");
      assert.doesNotMatch(refused.outcome.output, /synthetic/i, "rejection details stayed private");

      const green = await runWiringSettlementArm(t, `wiring-fulfilled-${index}`, row, "fulfilled");
      assert.equal(green.outcome.error, null);
      assert.equal(green.outcome.value.route_readiness?.reason, "route_receipt_accepted");
      assert.equal(green.counters.apply, 1);
      assert.equal(green.counters.proofAttempts, 1);
      assert.equal(green.counters.routeDecisions, 1, "the paired fulfilled result reached one ready gate");
    });
  }

  for (const [index, row] of rejectedWiringCases.entries()) {
    const preserved = await runWiringSettlementArm(
      t,
      `non-part-b-wiring-rejected-${index}`,
      row,
      "rejected",
      "built-in",
    );
    assert.equal(preserved.outcome.error, row.rejection, "non-Part-B keeps the original rejection");
    assert.equal(preserved.counters.apply, 1);
    assert.equal(preserved.counters.proofAttempts, 0);
    assert.equal(preserved.counters.routeDecisions, 0, "non-Part-B adds no route decision");
  }
});

test("Part B route reason display is a closed allowlist with a nondisclosing fallback", () => {
  assert.deepEqual(PART_B_ROUTE_READINESS_REASONS, EXPECTED_PART_B_ROUTE_READINESS_REASONS);
  assert.equal(new Set(PART_B_ROUTE_READINESS_REASONS).size, PART_B_ROUTE_READINESS_REASONS.length);
  for (const reason of EXPECTED_PART_B_ROUTE_READINESS_REASONS) {
    assert.equal(normalizePartBRouteReadinessReason(reason), reason);
  }
  for (const value of [undefined, null, "", "provider text must not pass through"]) {
    assert.equal(normalizePartBRouteReadinessReason(value), "route_unproven");
  }
});

test("Part B control survives the real Worker evidence, premise, and money gates", async (t) => {
  const directDoc = {
    n: 1,
    title: PUBLIC_INSTALL_SMOKE_TITLE,
    source: PUBLIC_INSTALL_SMOKE_SOURCE,
    snippet: PUBLIC_INSTALL_SMOKE_CHUNK,
    ts: null,
    date_reliable: false,
    text_source: "native",
    text_reliable: true,
  };
  const initialGate = { supported: true, complete: true, evidence: [1], reason: "direct support" };
  const oldVeto = applyMoneyVeto({
    question: LEGACY_PART_B_ROUTE_QUESTION,
    answer: INSTALL_SMOKE_ANSWER,
    evidenceGate: initialGate,
    docs: [directDoc],
  });
  const newVeto = applyMoneyVeto({
    question: EXPECTED_PART_B_ROUTE_QUESTION,
    answer: INSTALL_SMOKE_ANSWER,
    evidenceGate: initialGate,
    docs: [directDoc],
  });

  assert.equal(isMoneyQuestion(LEGACY_PART_B_ROUTE_QUESTION), true);
  assert.equal(oldVeto.answer, null);
  assert.equal(oldVeto.gap?.rule, "unreliable_date");
  assert.equal(isMoneyQuestion(EXPECTED_PART_B_ROUTE_QUESTION), false);
  assert.equal(newVeto.answer, INSTALL_SMOKE_ANSWER);
  assert.equal(newVeto.evidenceGate, initialGate, "the non-money control leaves the accepted gate unchanged");

  const red = await askInstallSmoke(LEGACY_PART_B_ROUTE_QUESTION);
  const green = await askInstallSmoke(PART_B_ROUTE_CONTROL.arguments.q);
  for (const [label, result] of [["red", red], ["green", green]]) {
    assert.equal(result.response.status, 200, `${label} reached the real think response`);
    assert.equal(result.calls.embedding, 1, `${label} reached semantic retrieval`);
    assert.equal(result.calls.answer, 1, `${label} reached answer generation`);
    assert.equal(result.calls.verifier, 1, `${label} reached the evidence verifier`);
    assert.ok(result.calls.d1 > 0 && result.calls.vector > 0,
      `${label} used the D1 and Vectorize retrieval modules`);
    assert.equal(result.body.results.length, 1, `${label} had exactly one evidence result`);
    assert.equal(result.body.results[0].doc_uid, PUBLIC_INSTALL_SMOKE_DOC_UID);
    assert.ok(result.body.timing.stages.evidence_gate.calls > 0,
      `${label} exercised the evidence gate`);
    assert.ok(result.body.timing.stages.premise_temporal.calls > 0,
      `${label} exercised the premise and temporal gates`);
    assert.equal(result.body.timing.stages.evidence_gate.errors, 0);
    assert.equal(result.body.timing.stages.premise_temporal.errors, 0);
  }
  assert.equal(red.body.answer, null);
  assert.equal(red.body.evidence_gate.supported, false);
  assert.equal(red.body.timing.outcome, "refused");
  assert.equal(red.body.gaps.find((gap) => gap.type === "money_veto")?.rule, "unreliable_date");

  assert.equal(PART_B_ROUTE_CONTROL.arguments.q, EXPECTED_PART_B_ROUTE_QUESTION);
  assert.equal(green.body.answer, INSTALL_SMOKE_ANSWER);
  assert.equal(green.body.evidence_gate.supported, true, green.body.evidence_gate.reason);
  assert.equal(green.body.timing.outcome, "ok");
  assert.equal(green.body.citations.length, 1);
  assert.equal(green.body.gaps.some((gap) =>
    ["money_veto", "money_recall", "temporal_conflict"].includes(gap.type)), false);
  t.diagnostic(
    `red_evidence=${red.body.timing.stages.evidence_gate.calls} ` +
    `red_premise=${red.body.timing.stages.premise_temporal.calls} ` +
    `green_evidence=${green.body.timing.stages.evidence_gate.calls} ` +
    `green_premise=${green.body.timing.stages.premise_temporal.calls}`,
  );
});

test("Part B proof and receipt-validator outcomes match the independent reason inventory", async (t) => {
  const acceptedContent = acceptedRouteContent();
  const unrecognizedReceipt = { ...EXPECTED_ROUTE_RECEIPT, outcome: "refused" };
  const validatorCases = [
    ["content_invalid", null, true],
    ["receipt_malformed", [{ type: "text", text: '{"route_receipt":' }], true],
    ["json_duplicate_member", [{ type: "text", text: '{"other":1,"other":2}' }], true],
    ["receipt_missing", [], true],
    ["receipt_conflicting", [...acceptedContent, ...acceptedContent], true],
    ["receipt_nested", [{
      type: "text",
      text: JSON.stringify({ nested: { route_receipt: EXPECTED_ROUTE_RECEIPT } }),
    }], true],
    ["diagnostics_unauthorized", acceptedContent, false],
    ["receipt_unrecognized", [{
      type: "text",
      text: JSON.stringify({ route_receipt: unrecognizedReceipt }),
    }], true],
    ["receipt_accepted", acceptedContent, true],
  ];
  for (const [reason, content, diagnosticsAuthorized] of validatorCases) {
    const result = validatePartBRouteReceiptContent(content, { diagnosticsAuthorized });
    assert.equal(result.reason, reason, `validator reason ${reason}`);
    assert.equal(result.accepted, reason === "receipt_accepted");
  }

  const validTransport = () => ({
    request: async (method) => method === "initialize"
      ? { result: {} }
      : { result: { content: acceptedRouteContent() } },
    close: async () => {},
  });
  const proofCases = [
    { reason: "manifest_unavailable", missingManifest: true },
    { reason: "model_pair_mismatch", answerSetup: "built-in" },
    { reason: "guide_refresh_refused", guideRefresh: {} },
    { reason: "full_exit_boundary_absent", stopMcpProcess: null },
    { reason: "control_invalid", control: { name: "brain_think", arguments: { q: "" } } },
    {
      reason: "brain_url_unavailable",
      mutateManifest: (manifest) => { manifest.brain.domain = "fixture.invalid/path"; },
    },
    {
      reason: "claude_code_running",
      stopMcpProcess: async () => proveClaudeCodeFullyExited({ readProcessList: async () => ["claude"] }),
    },
    { reason: "process_stop_failed", stopMcpProcess: async () => { throw new Error("synthetic stop failure"); } },
    {
      reason: "descriptor_invalid",
      mutateManifest: (manifest) => { manifest.client.slug = "fixture\u0000slug"; },
    },
    { reason: "transport_open_failed", openMcpTransport: async () => { throw new Error("synthetic open failure"); } },
    { reason: "transport_invalid", openMcpTransport: async () => ({}) },
    {
      reason: "initialize_failed",
      openMcpTransport: async () => ({ request: async () => ({ error: {} }), close: async () => {} }),
    },
    {
      reason: "tool_failed",
      openMcpTransport: async () => ({
        request: async (method) => method === "initialize" ? { result: {} } : { result: { isError: true } },
        close: async () => {},
      }),
    },
    {
      reason: "transport_request_failed",
      openMcpTransport: async () => ({ request: async () => { throw new Error("synthetic request failure"); }, close: async () => {} }),
    },
    {
      reason: "transport_close_failed",
      openMcpTransport: async () => ({
        ...validTransport(),
        close: async () => { throw new Error("synthetic close failure"); },
      }),
    },
    { reason: "route_receipt_accepted" },
  ];

  for (const [index, arm] of proofCases.entries()) {
    await t.test(arm.reason, async (t) => {
      const state = fixture(t, `proof-reason-${index}`, arm.answerSetup ?? "opus-sonnet");
      if (arm.mutateManifest) {
        const manifest = readManifest(state.manifest);
        arm.mutateManifest(manifest);
        writeFileSync(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const result = await provePartBRouteReadiness({
        manifestPath: arm.missingManifest ? join(state.root, "missing.manifest.json") : state.manifest,
        guideRefresh: arm.guideRefresh ?? ACCEPTED_GUIDE_REFRESH,
        control: arm.control ?? { name: "brain_think", arguments: { q: "synthetic route proof" } },
      }, {
        stopMcpProcess: arm.stopMcpProcess === null ? undefined : (arm.stopMcpProcess ?? (async () => {})),
        openMcpTransport: arm.openMcpTransport ?? (async () => validTransport()),
      });
      assert.equal(result.reason, arm.reason);
      assert.equal(result.ready, arm.reason === "route_receipt_accepted");
    });
  }
});

test("mcp-config non-Part-B apply keeps its prior exact output and successful return", async (t) => {
  const state = fixture(t, "non-part-b", "built-in");
  const counters = { apply: 0, ownershipDecisions: 0, stops: 0 };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const applied = await captureConsoleOutcome(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    wireAgents: async () => {
      counters.apply++;
      return { wired: ["Claude Code"], skipped: [], failures: [] };
    },
    routeReadinessOptions: {
      claudeWorkspaceOptions: writerOptions,
      stopMcpProcess: async () => { counters.stops++; },
      openMcpTransport: async () => { throw new Error("a non-Part-B route must stop before transport"); },
    },
  }));
  assert.equal(applied.error, null);
  assert.equal(applied.value.route_readiness?.reason, "model_pair_mismatch");
  assert.equal(counters.apply, 1, "the non-Part-B apply decision was reached");
  assert.equal(counters.stops, 0);
  assert.equal(
    applied.output,
    `${successMark(false)}    connected with Owner assistant access: Claude Code\n` +
      "      It can read, add or correct information, check the connection, and review a financial map. It cannot activate that map, delete records, or change access.",
  );
  assert.doesNotMatch(applied.output, /Claude answer route (?:ready|not ready):/);
});

test("CONTROL: real Windows guide ownership accepts safe managed refresh and preserves refused bytes", (t) => {
  const safeState = fixture(t, "guide-safe", "built-in");
  const safeCounters = { ownershipDecisions: 0 };
  const safeOptions = guideWriterOptions(safeState.root, safeCounters);
  const initialSafe = writeClaudeWorkspaceGuide(safeState.manifest, safeOptions);
  assert.equal(initialSafe.status, "written");
  writeAnswerSetup(safeState.manifest, "opus-sonnet");
  const refreshed = writeClaudeWorkspaceGuide(safeState.manifest, safeOptions);
  const refreshedText = readFileSync(join(dirname(safeState.manifest), "CLAUDE.md"), "utf8");
  assert.equal(refreshed.status, "written");
  assert.ok(refreshedText.startsWith(CLAUDE_WORKSPACE_MARKER));
  assert.match(refreshedText, /For every non-money question, use brain_think first\./);

  const refusedState = fixture(t, "guide-refused", "built-in");
  const createCounters = { ownershipDecisions: 0 };
  const createOptions = guideWriterOptions(refusedState.root, createCounters);
  assert.equal(writeClaudeWorkspaceGuide(refusedState.manifest, createOptions).status, "written");
  const guidePath = join(dirname(refusedState.manifest), "CLAUDE.md");
  const before = readFileSync(guidePath);
  writeAnswerSetup(refusedState.manifest, "opus-sonnet");
  const refusedCounters = { ownershipDecisions: 0 };
  const refused = writeClaudeWorkspaceGuide(
    refusedState.manifest,
    guideWriterOptions(refusedState.root, refusedCounters, { nativeSafe: false }),
  );
  assert.equal(refused.status, "preserved_unsafe_existing_file");
  assert.deepEqual(readFileSync(guidePath), before, "the refused managed guide stayed byte-identical");
  assert.ok(safeCounters.ownershipDecisions > 0 && refusedCounters.ownershipDecisions > 0);
  t.diagnostic(
    `safe_ownership=${safeCounters.ownershipDecisions} refused_ownership=${refusedCounters.ownershipDecisions}`,
  );
});

test("CONTROL P3: real workspace writer refuses a same-inode staging content mismatch", (t) => {
  const state = fixture(t, "guide-staging-mismatch", "built-in");
  const counters = { ownershipDecisions: 0 };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const guidePath = join(dirname(state.manifest), "CLAUDE.md");
  const before = readFileSync(guidePath);
  writeAnswerSetup(state.manifest, "opus-sonnet");

  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalReadFileSync = fs.readFileSync;
  const originalReadSync = fs.readSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalLstatSync = fs.lstatSync;
  const stagingDescriptors = new Map();
  const creationDescriptors = new Set();
  const stagedIdentities = new Map();
  let contentMismatches = 0;
  let stagedContentReads = 0;
  let sameInode = false;
  fs.openSync = (path, flags, ...rest) => {
    const descriptor = originalOpenSync(path, flags, ...rest);
    if (isWorkspaceStagingPath(path)) {
      stagingDescriptors.set(descriptor, path);
      if (flags === "wx") creationDescriptors.add(descriptor);
    }
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    const stagingPath = stagingDescriptors.get(descriptor);
    stagingDescriptors.delete(descriptor);
    const created = creationDescriptors.delete(descriptor);
    if (created) {
      stagedIdentities.set(stagingPath, {
        number: originalLstatSync(stagingPath),
        bigint: originalLstatSync(stagingPath, { bigint: true }),
      });
    }
    const result = originalCloseSync(descriptor);
    if (created && contentMismatches === 0) {
      const changed = originalReadFileSync(stagingPath);
      if (changed.length === 0) return result;
      changed[0] ^= 1;
      originalWriteFileSync(stagingPath, changed);
      const identity = stagedIdentities.get(stagingPath).number;
      const changedIdentity = originalLstatSync(stagingPath);
      sameInode = changedIdentity.dev === identity.dev &&
        changedIdentity.ino === identity.ino && changedIdentity.size === identity.size;
      contentMismatches++;
    }
    return result;
  };
  fs.lstatSync = (path, options) => {
    const identity = contentMismatches > 0 && isWorkspaceStagingPath(path)
      ? stagedIdentities.get(path)
      : null;
    if (identity) return options?.bigint ? identity.bigint : identity.number;
    return originalLstatSync(path, options);
  };
  fs.readFileSync = (path, ...rest) => {
    if (contentMismatches > 0 && isWorkspaceStagingPath(path)) stagedContentReads++;
    return originalReadFileSync(path, ...rest);
  };
  fs.readSync = (descriptor, ...rest) => {
    if (contentMismatches > 0 && stagingDescriptors.has(descriptor)) stagedContentReads++;
    return originalReadSync(descriptor, ...rest);
  };
  syncBuiltinESMExports();

  let refused;
  try {
    refused = writeClaudeWorkspaceGuide(state.manifest, writerOptions);
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }

  assert.equal(contentMismatches, 1, "the content mismatch reached the real staging inode");
  assert.equal(sameInode, true, "the physical content change preserved the staging inode and size");
  assert.ok(stagedContentReads > 0, "the real staged-byte decision observed the changed inode");
  assert.equal(refused.status, "not_written");
  assert.deepEqual(readFileSync(guidePath), before, "a changed staging file cannot replace the managed guide");
  assert.ok(counters.ownershipDecisions > 0, "the real Windows ownership decision ran");
  t.diagnostic(
    `staging_content_mismatches=${contentMismatches} staged_content_reads=${stagedContentReads} ` +
    `outcome=${refused.status}`,
  );
});

test("RED P3: real workspace refresh retries a transient staging read lock", (t) => {
  const state = fixture(t, "guide-staging-read-lock", "built-in");
  const counters = { ownershipDecisions: 0 };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const guidePath = join(dirname(state.manifest), "CLAUDE.md");
  writeAnswerSetup(state.manifest, "opus-sonnet");

  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  let proofReadOpens = 0;
  let stagingRevalidateReads = 0;
  let lockInjections = 0;
  fs.openSync = (path, flags, ...rest) => {
    const readOnly = typeof flags === "number" &&
      (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
    if (isWorkspaceStagingPath(path) && readOnly) {
      proofReadOpens++;
      if (proofReadOpens === 2 && lockInjections === 0) {
        lockInjections++;
        throw transientReadLock();
      }
    }
    return originalOpenSync(path, flags, ...rest);
  };
  fs.readFileSync = (path, ...rest) => {
    if (isWorkspaceStagingPath(path)) {
      stagingRevalidateReads++;
      if (lockInjections === 0) {
        lockInjections++;
        throw transientReadLock();
      }
    }
    return originalReadFileSync(path, ...rest);
  };
  syncBuiltinESMExports();

  let refreshed;
  try {
    refreshed = writeClaudeWorkspaceGuide(state.manifest, writerOptions);
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }

  assert.equal(lockInjections, 1, "the real staging decision received one transient read lock");
  assert.ok(
    proofReadOpens + stagingRevalidateReads > 0,
    "the fault boundary reached the real staged-byte decision",
  );
  assert.ok(counters.ownershipDecisions > 0, "the real Windows ownership decision ran");
  t.diagnostic(
    `lock_injections=${lockInjections} proof_read_opens=${proofReadOpens} ` +
    `staging_revalidate_reads=${stagingRevalidateReads} outcome=${refreshed.status}`,
  );
  assert.equal(
    refreshed.status,
    "written",
    "RED: a transient Windows staging read lock ends the refresh before the shared retry can run",
  );
  assert.match(readFileSync(guidePath, "utf8"), /use brain_think first\./);
});

test("CONTROL: real brain_think omits diagnostics receipt for an unauthorized profile", async (t) => {
  const state = fixture(t, "unauthorized", "opus-sonnet");
  const mcp = startMcp(t, state, remoteTiming(), "unauthorized", { profile: "librarian" });
  const initialized = await mcp.request("initialize", initializeParams());
  assert.match(initialized.result.instructions, /use brain_think first/);
  const reply = await callThink(mcp);
  await mcp.close();

  assert.deepEqual(mcp.calls, ["initialize", "brain_think"]);
  assert.equal(mcp.counters.initialize, 1);
  assert.equal(mcp.counters.tool, 1);
  assert.notEqual(reply.result.isError, true);
  const body = JSON.parse(reply.result.content[0].text);
  assert.equal(Object.hasOwn(body, "route_receipt"), false);
  assert.equal(reply.result._meta, undefined);
  t.diagnostic("profile=librarian initialize=1 brain_think=1 visible_receipt=0");
});

test("RED PB-05/PB-06: registered diagnostics brain_think exposes the exact visible route receipt", async (t) => {
  const state = fixture(t, "authorized", "opus-sonnet");
  const applyCounters = { applyDecisions: 0 };
  const descriptor = await applyMcpRegistration(state, applyCounters);
  const mcp = startMcp(t, state, remoteTiming(), "authorized");
  assert.deepEqual(mcp.descriptor, descriptor, "the child uses the production registration descriptor");
  const initialized = await mcp.request("initialize", initializeParams());
  assert.match(initialized.result.instructions, /use brain_think first/);
  const reply = await callThink(mcp);
  await mcp.close();

  assert.deepEqual(mcp.calls, ["initialize", "brain_think"]);
  assert.equal(applyCounters.applyDecisions, 1);
  assert.equal(mcp.counters.initialize, 1);
  assert.equal(mcp.counters.tool, 1);
  assert.notEqual(reply.result.isError, true);
  const body = JSON.parse(reply.result.content[0].text);
  assert.equal(body.answer, "The synthetic control value is seven units. [1]");
  assert.equal(body.timing, undefined, "backend timing remains outside visible answer data");

  const local = reply.result._meta.timing;
  assert.equal(local.route, "mcp.brain_think");
  assert.equal(local.outcome, "ok");
  assert.equal(local.stages.mcp_backend.calls, 1);
  assert.equal(local.backend.length, 1);
  assert.equal(local.backend[0].route, "think");
  assert.equal(local.backend[0].outcome, "ok");
  assert.deepEqual(
    local.backend[0].models.map(({ stage, provider, id, calls, errors }) => ({ stage, provider, id, calls, errors })),
    [
      { stage: "answer_llm", provider: "anthropic", id: "claude-opus-5-5", calls: 1, errors: 0 },
      { stage: "verifier_llm", provider: "anthropic", id: "claude-sonnet-5-5", calls: 1, errors: 0 },
    ],
  );
  assert.equal(mcp.calls.filter((name) => name === "brain_search").length, 0);
  t.diagnostic(
    "route=mcp.brain_think backend_route=think answer_calls=1 check_calls=1 fallback_search_calls=0 " +
    `visible_receipt=${Number(Object.hasOwn(body, "route_receipt"))}`,
  );

  assert.deepEqual(
    body.route_receipt,
    EXPECTED_ROUTE_RECEIPT,
    "RED: the real authorized stdio result does not expose its complete route proof",
  );
});

test("RED PB-04/PB-05: real answer setup refreshes the managed guide before a fresh process", async (t) => {
  const state = fixture(t, "lifecycle", "built-in");
  const counters = {
    setupLocks: 0,
    versionChecks: 0,
    deployChecks: 0,
    secretInventories: 0,
    dailyPrepares: 0,
    dailyReconciles: 0,
    deploys: 0,
    workerChecks: 0,
    automaticGuideCalls: 0,
    ownershipDecisions: 0,
  };
  const writerOptions = guideWriterOptions(state.root, counters);
  const initialGuide = writeClaudeWorkspaceGuide(state.manifest, writerOptions);
  assert.equal(initialGuide.status, "written");
  const guidePath = join(dirname(state.manifest), "CLAUDE.md");
  const builtInGuide = readFileSync(guidePath);
  assert.match(builtInGuide.toString("utf8"), /use brain_search first\./);

  const timing = remoteTiming();
  const oldMcp = startMcp(t, state, timing, "old");
  const oldInitial = await oldMcp.request("initialize", initializeParams());
  assert.match(oldInitial.result.instructions, /use brain_search first/);

  const setupResult = await cmdConnectAnthropic(
    state.manifest,
    { "key-set-in-dashboard": true },
    setupOptions(state, counters, writerOptions),
  );
  const configured = readManifest(state.manifest);
  assert.equal(configured.retrieval.answer_model, RECOMMENDED_ANSWER_SETUP.answer_model);
  assert.equal(configured.retrieval.gate_model, RECOMMENDED_ANSWER_SETUP.gate_model);
  assert.equal(setupResult.answer_model, RECOMMENDED_ANSWER_SETUP.answer_model);
  assert.equal(setupResult.gate_model, RECOMMENDED_ANSWER_SETUP.gate_model);
  assert.equal(counters.setupLocks, 1, "the real answer-setup transaction ran");
  assert.equal(counters.workerChecks, 1, "the real model-pair acceptance decision ran");

  const guideAfterConnect = readFileSync(guidePath);
  assert.notDeepEqual(guideAfterConnect, builtInGuide, "successful connect refreshed the managed guide");
  assert.match(guideAfterConnect.toString("utf8"), /use brain_think first\./,
    "successful connect left the managed guide ask-first");
  const oldAfterSetup = await oldMcp.request("initialize", initializeParams());
  assert.match(oldAfterSetup.result.instructions, /use brain_search first/);
  const oldTool = await callThink(oldMcp);
  assert.notEqual(oldTool.result.isError, true);

  const directRefresh = writeClaudeWorkspaceGuide(state.manifest, writerOptions);
  assert.equal(directRefresh.status, "verified", "the real writer finds connect's ask-first bytes already exact");
  const refreshedGuide = readFileSync(guidePath, "utf8");
  assert.match(refreshedGuide, /use brain_think first\./);

  await oldMcp.close();
  const freshMcp = startMcp(t, state, timing, "fresh");
  const freshInitial = await freshMcp.request("initialize", initializeParams());
  assert.match(freshInitial.result.instructions, /use brain_think first/);
  const freshTool = await callThink(freshMcp);
  assert.notEqual(freshTool.result.isError, true);
  await freshMcp.close();

  assert.ok(counters.ownershipDecisions > 0, "the Windows guide ownership decision ran");
  assert.ok(oldMcp.counters.initialize > 0 && freshMcp.counters.initialize > 0);
  assert.ok(oldMcp.counters.tool > 0 && freshMcp.counters.tool > 0);
  assert.ok(oldMcp.calls.length > 0 && freshMcp.calls.length > 0);
  assert.notEqual(oldInitial.result.instructions, freshInitial.result.instructions);
  t.diagnostic(
    `setup=${counters.setupLocks} guide_ownership=${counters.ownershipDecisions} ` +
    `initialize=${oldMcp.counters.initialize + freshMcp.counters.initialize} ` +
    `tool=${oldMcp.counters.tool + freshMcp.counters.tool} automatic_guide_refresh=${counters.automaticGuideCalls}`,
  );

  assert.equal(
    counters.automaticGuideCalls,
    1,
    "RED: the successful real connect path never reaches the managed guide refresh dependency",
  );
  assert.equal(setupResult.guide_refresh?.schema_version, 1);
  assert.equal(setupResult.guide_refresh?.operation, "claude_workspace_guide.refresh");
  assert.ok(["written", "verified"].includes(setupResult.guide_refresh?.outcome));
  assert.equal(setupResult.guide_refresh?.managed, true);
  assert.equal(setupResult.guide_refresh?.answer_route, "brain_think_first");
  assert.ok(Number.isInteger(setupResult.guide_refresh?.guide_generation));
});

test("NAMED GAP PB-07: production receipt collector rejects duplicate and conflicting real evidence", async (t) => {
  const state = fixture(t, "duplicates", "opus-sonnet");
  const mcp = startMcp(t, state, remoteTiming(), "duplicates");
  await mcp.request("initialize", initializeParams());
  const reply = await callThink(mcp);
  await mcp.close();
  assert.equal(mcp.counters.initialize, 1);
  assert.equal(mcp.counters.tool, 1);

  const proof = await loadPartBProofModule();
  assert.equal(
    typeof proof.validatePartBRouteReceiptContent,
    "function",
    "NAMED GAP: the strict production collector is not exported",
  );
  const single = proof.validatePartBRouteReceiptContent(reply.result.content, {
    diagnosticsAuthorized: true,
  });
  assert.equal(single.accepted, true, "one receipt produced by the real MCP is the green control");

  let validatorDecisions = 1;
  const duplicateMemberContent = [{
    type: "text",
    text: `{"route_receipt":${JSON.stringify(EXPECTED_ROUTE_RECEIPT)},` +
      `"route_receipt":${JSON.stringify(EXPECTED_ROUTE_RECEIPT)}}`,
  }];
  const duplicateMember = proof.validatePartBRouteReceiptContent(duplicateMemberContent, {
    diagnosticsAuthorized: true,
  });
  validatorDecisions++;
  assert.equal(
    duplicateMember.accepted,
    false,
    "two route_receipt members in one JSON object are conflicting evidence",
  );

  const duplicateOtherMember = proof.validatePartBRouteReceiptContent([{
    type: "text",
    text: `{"route_receipt":${JSON.stringify(EXPECTED_ROUTE_RECEIPT)},` +
      '"answer":"first","answer":"second"}',
  }], {
    diagnosticsAuthorized: true,
  });
  validatorDecisions++;
  assert.equal(
    duplicateOtherMember.accepted,
    false,
    "a duplicate non-receipt member also makes the JSON evidence ambiguous",
  );

  const escapedMalformed = proof.validatePartBRouteReceiptContent([
    ...reply.result.content,
    { type: "text", text: '{"\\u0072oute_receipt":' },
  ], {
    diagnosticsAuthorized: true,
  });
  validatorDecisions++;
  assert.equal(
    escapedMalformed.accepted,
    false,
    "a decoded receipt property in malformed JSON conflicts with canonical evidence",
  );
  assert.equal(validatorDecisions, 4, "all strict-validator decision arms were reached");
  assert.ok(
    [single, duplicateMember, duplicateOtherMember, escapedMalformed].every((decision) =>
      typeof decision.reason === "string" && decision.reason.length > 0),
    "every reached validator decision returned a closed reason",
  );

  const duplicateContent = [
    ...reply.result.content,
    ...structuredClone(reply.result.content),
  ];
  const duplicate = proof.validatePartBRouteReceiptContent(duplicateContent, {
    diagnosticsAuthorized: true,
  });
  assert.equal(duplicate.accepted, false);

  const staleContent = structuredClone(reply.result.content);
  const staleBody = JSON.parse(staleContent[0].text);
  staleBody.route_receipt.answer_model = BUILT_IN_ANSWER_MODEL;
  staleContent[0].text = JSON.stringify(staleBody);
  const stale = proof.validatePartBRouteReceiptContent(
    [...reply.result.content, ...staleContent],
    { diagnosticsAuthorized: true },
  );
  assert.equal(stale.accepted, false);

  const malformedContent = structuredClone(reply.result.content);
  malformedContent[0].text = malformedContent[0].text.slice(0, -1);
  const malformed = proof.validatePartBRouteReceiptContent(
    [...reply.result.content, ...malformedContent],
    { diagnosticsAuthorized: true },
  );
  assert.equal(malformed.accepted, false);
  t.diagnostic(
    `validator_decisions=${validatorDecisions} single=accepted duplicate_member=refused ` +
    "duplicate_other_member=refused escaped_malformed=refused duplicate_item=refused " +
    "stale=refused malformed=refused",
  );
});

async function runInstalledRouteArm(t, label, { duplicateActualContent = false } = {}) {
  const state = fixture(t, label, "built-in");
  const counters = {
    connectControls: 0,
    setupLocks: 0,
    versionChecks: 0,
    deployChecks: 0,
    secretInventories: 0,
    dailyPrepares: 0,
    dailyReconciles: 0,
    deploys: 0,
    workerChecks: 0,
    automaticGuideCalls: 0,
    ownershipDecisions: 0,
  };
  const writerOptions = guideWriterOptions(state.root, counters);
  assert.equal(writeClaudeWorkspaceGuide(state.manifest, writerOptions).status, "written");
  const oldMcp = startMcp(t, state, remoteTiming(), `${label}-old`);
  const oldInitial = await oldMcp.request("initialize", initializeParams());
  assert.match(oldInitial.result.instructions, /use brain_search first/);
  const connected = await captureConsole(() => cmdConnect("anthropic", {
    argv: [
      process.execPath,
      join(ROOT, "brain.mjs"),
      "connect",
      "anthropic",
      state.manifest,
      "--key-set-in-dashboard",
    ],
    withManifestControl: async (manifestPath, action) => {
      counters.connectControls++;
      assert.equal(manifestPath, state.manifest);
      return action();
    },
    anthropicOptions: setupOptions(state, counters, writerOptions),
  }));
  const setupResult = connected.value;
  const plainConnectLines = connected.output.split("\n").map((line) =>
    line.replace(/\x1b\[[0-9;]*m/gu, "").replace(/^·\s+/, ""));
  const renderedApplyCommand = renderCliCommands(
    `brain mcp-config ${JSON.stringify(state.manifest)} --apply`,
  );
  const routeGuidance = plainConnectLines.filter((line) =>
    line.startsWith("Close Claude completely") || line === "With Claude closed, run:" ||
    line === renderedApplyCommand || line === "Then start Claude Code again.");
  assert.deepEqual(routeGuidance, [
    "Close Claude completely, including Claude Code, the Claude desktop app, and any tray or background process.",
    "With Claude closed, run:",
    renderedApplyCommand,
    "Then start Claude Code again.",
  ]);
  assert.doesNotMatch(connected.output, /Then relaunch it and run/);
  assert.equal(counters.connectControls, 1, "the installed connect route reached credential control");
  assert.equal(counters.setupLocks, 1);
  assert.equal(counters.workerChecks, 1);

  const directRefresh = writeClaudeWorkspaceGuide(state.manifest, writerOptions);
  assert.ok(
    ["written", "verified"].includes(directRefresh.status),
    "the real writer establishes the same-boundary ask-first control",
  );

  const order = [];
  let freshMcp = null;
  let actualFreshReply = null;
  let returnedToolContentCount = 0;
  const applyCounters = { applyDecisions: 0 };
  const ownershipDecisionsBeforeApply = counters.ownershipDecisions;
  const expectedDescriptor = descriptorFor(state);
  const receivedDescriptors = [];
  const applied = await captureConsoleOutcome(() => cmdMcpConfig(state.manifest, {
    flags: { apply: true },
    wireAgents: async (manifest, manifestPath) => {
      applyCounters.applyDecisions++;
      assert.equal(manifestPath, state.manifest);
      assert.deepEqual(manifest.retrieval, RECOMMENDED_ANSWER_SETUP);
      return { wired: ["Claude Code"], skipped: [], failures: [] };
    },
    routeReadinessOptions: {
      claudeWorkspaceOptions: writerOptions,
      control: {
        name: "brain_think",
        arguments: { q: "What is the synthetic control value?" },
      },
      stopMcpProcess: async () => {
        order.push("stop");
        await oldMcp.close();
      },
      openMcpTransport: async (...descriptors) => {
        assert.equal(
          descriptors.length,
          1,
          "the production route authority supplies exactly one registration descriptor",
        );
        const [receivedDescriptor] = descriptors;
        assert.deepEqual(
          receivedDescriptor,
          expectedDescriptor,
          "the transport boundary receives the production MCP registration descriptor",
        );
        receivedDescriptors.push(receivedDescriptor);
        order.push("open");
        freshMcp = startMcpFromDescriptor(
          t,
          state,
          remoteTiming(),
          `${label}-fresh`,
          receivedDescriptor,
        );
        return {
          request: async (method, params) => {
            order.push(method === "tools/call" ? params.name : method);
            const reply = await freshMcp.request(method, params);
            if (method === "tools/call") {
              actualFreshReply = reply;
              const forwarded = duplicateActualContent
                ? {
                    ...reply,
                    result: {
                      ...reply.result,
                      content: [
                        ...reply.result.content,
                        ...structuredClone(reply.result.content),
                      ],
                    },
                  }
                : reply;
              returnedToolContentCount = forwarded.result.content.length;
              return forwarded;
            }
            return reply;
          },
          close: async () => {
            order.push("close");
            await freshMcp.close();
          },
        };
      },
    },
  }));

  assert.equal(applyCounters.applyDecisions, 1, "the real mcp-config apply decision ran");
  t.diagnostic(
    `connect_control=${counters.connectControls} setup=${counters.setupLocks} ` +
    `mcp_apply=${applyCounters.applyDecisions} route_events=${order.length} ` +
    `descriptors=${receivedDescriptors.length} duplicate=${Number(duplicateActualContent)}`,
  );
  assert.deepEqual(
    order,
    ["stop", "open", "initialize", "brain_think", "close"],
    "NAMED GAP: installed cmdMcpConfig --apply never calls the route-ready authority",
  );
  assert.ok(
    counters.ownershipDecisions > ownershipDecisionsBeforeApply,
    "the installed caller obtains its guide receipt from the real workspace writer",
  );
  assert.equal(receivedDescriptors.length, 1);
  assert.equal(setupResult.route_readiness?.ready, false);
  assert.equal(setupResult.route_readiness?.reason, "client_restart_required");
  assert.equal(setupResult.route_readiness?.next_operation, "mcp-config.apply_after_full_exit");
  assert.equal(freshMcp.counters.initialize, 1);
  assert.equal(freshMcp.counters.tool, 1);
  const actualBody = JSON.parse(actualFreshReply.result.content[0].text);
  assert.deepEqual(actualBody.route_receipt, EXPECTED_ROUTE_RECEIPT);
  return {
    actualBody,
    actualFreshReply,
    applied,
    returnedToolContentCount,
  };
}

test("NAMED GAP R2-02/PB-04: installed route accepts one actual receipt from the production descriptor", async (t) => {
  const arm = await runInstalledRouteArm(t, "ordered-proof-single");
  assert.equal(arm.returnedToolContentCount, arm.actualFreshReply.result.content.length);
  assert.equal(arm.applied.error, null);
  assert.equal(arm.applied.value.route_readiness?.ready, true);
  assert.deepEqual(arm.applied.value.route_readiness.route_receipt, arm.actualBody.route_receipt,
    "the installed caller returns the receipt from the actual fresh tool result");
  assert.equal(
    arm.applied.output.split("\n").filter((line) =>
      line === `${successMark(false)}    Claude answer route ready: route_receipt_accepted`).length,
    1,
  );
});

test("NAMED GAP R3-01/PB-07: installed route refuses duplicated actual receipt content", async (t) => {
  const arm = await runInstalledRouteArm(t, "ordered-proof-duplicate", {
    duplicateActualContent: true,
  });
  assert.equal(
    arm.returnedToolContentCount,
    arm.actualFreshReply.result.content.length * 2,
    "the transport duplicated the actual fresh tool content before returning it",
  );
  assert.equal(arm.applied.value, null);
  assert.equal(arm.applied.error?.constructor?.name, "Fatal");
  assert.equal(
    arm.applied.error?.message,
    "Claude answer route not ready: receipt_conflicting.\n" +
      `      ${ROUTE_RETRY_GUIDANCE}`,
    "the installed production decision must use the strict collector and fail duplicates",
  );
});
