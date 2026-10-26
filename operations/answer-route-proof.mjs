import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { LOCAL_OWNER_AGENT_PROFILE, profileHas } from "../worker/src/lib/agent-authority.js";
import { mcpRegistrationDescriptor } from "../brain.mjs";

export const PART_B_ROUTE_CONTROL = Object.freeze({
  name: "brain_think",
  arguments: Object.freeze({
    q: "What does the Financial Brain first-install smoke proof establish?",
  }),
});
export const CLAUDE_CODE_FULL_EXIT_CARD = Object.freeze({
  title: "Claude Code is still open",
  message: "Close Claude completely, including Claude Code, the Claude desktop app, and any tray or background process, then rerun the same command.",
});
export const PART_B_ROUTE_READINESS_REASONS = Object.freeze([
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

const PART_B_ROUTE_READINESS_REASON_SET = new Set(PART_B_ROUTE_READINESS_REASONS);

export function normalizePartBRouteReadinessReason(reason) {
  return PART_B_ROUTE_READINESS_REASON_SET.has(reason) ? reason : "route_unproven";
}

const CLAUDE_CODE_RUNNING = "CLAUDE_CODE_RUNNING";
const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;
const MCP_CHILD_ENV_ALLOWLIST = Object.freeze([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "USER", "USERNAME", "LOGNAME",
  "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "TZ",
]);

const RECEIPT_KEYS = Object.freeze([
  "answer_calls",
  "answer_errors",
  "answer_model",
  "answer_provider",
  "backend_route",
  "check_calls",
  "check_errors",
  "check_model",
  "check_provider",
  "fallback_search_calls",
  "outcome",
  "route",
  "schema_version",
]);
const GUIDE_KEYS = Object.freeze([
  "answer_route",
  "guide_generation",
  "managed",
  "operation",
  "outcome",
  "schema_version",
]);
const INITIALIZE_PARAMS = Object.freeze({
  protocolVersion: "2025-06-18",
  capabilities: Object.freeze({}),
  clientInfo: Object.freeze({ name: "brain-installer", version: "1" }),
});

const refusal = reason => Object.freeze({ accepted: false, reason });
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

function jsonSyntaxError() {
  const error = new SyntaxError("invalid JSON");
  error.code = "STRICT_JSON_INVALID";
  return error;
}

function parseJsonPreservingMembers(text) {
  let offset = 0;
  const occurrences = [];
  let duplicateMember = false;
  const whitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) offset++;
  };
  const string = () => {
    if (text[offset] !== '"') throw jsonSyntaxError();
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset++;
        try { return JSON.parse(text.slice(start, offset)); }
        catch { throw jsonSyntaxError(); }
      }
      if (code < 0x20) throw jsonSyntaxError();
      if (code === 0x5c) {
        offset++;
        if (offset >= text.length) throw jsonSyntaxError();
        if (text[offset] === "u") {
          if (!/^[0-9a-f]{4}$/iu.test(text.slice(offset + 1, offset + 5))) throw jsonSyntaxError();
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(text[offset])) throw jsonSyntaxError();
      }
      offset++;
    }
    throw jsonSyntaxError();
  };
  const value = (depth) => {
    whitespace();
    if (text[offset] === "{") return object(depth);
    if (text[offset] === "[") return array(depth);
    if (text[offset] === '"') return string();
    const remaining = text.slice(offset);
    const number = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number) {
      offset += number.length;
      return Number(number);
    }
    for (const [token, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (remaining.startsWith(token)) {
        offset += token.length;
        return parsed;
      }
    }
    throw jsonSyntaxError();
  };
  const array = (depth) => {
    const result = [];
    offset++;
    whitespace();
    if (text[offset] === "]") {
      offset++;
      return result;
    }
    for (;;) {
      result.push(value(depth + 1));
      whitespace();
      if (text[offset] === "]") {
        offset++;
        return result;
      }
      if (text[offset++] !== ",") throw jsonSyntaxError();
    }
  };
  const object = (depth) => {
    const result = Object.create(null);
    const keys = new Set();
    offset++;
    whitespace();
    if (text[offset] === "}") {
      offset++;
      return result;
    }
    for (;;) {
      whitespace();
      const key = string();
      if (keys.has(key)) duplicateMember = true;
      keys.add(key);
      whitespace();
      if (text[offset++] !== ":") throw jsonSyntaxError();
      const child = value(depth + 1);
      result[key] = child;
      if (key === "route_receipt") occurrences.push({ value: child, topLevel: depth === 0 });
      whitespace();
      if (text[offset] === "}") {
        offset++;
        return result;
      }
      if (text[offset++] !== ",") throw jsonSyntaxError();
    }
  };
  value(0);
  whitespace();
  if (offset !== text.length) throw jsonSyntaxError();
  return { occurrences, duplicateMember };
}

// A malformed document may fail before the recursive parser reaches a later
// property. Scan only syntactically valid JSON string tokens followed by a
// colon, then decode the token before deciding whether it claims a receipt.
function decodedReceiptPropertyClaims(text) {
  let claims = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '"') continue;
    let end = start + 1;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end);
      if (code < 0x20) break;
      if (code === 0x5c) {
        end++;
        if (end >= text.length) break;
        if (text[end] === "u") end += 4;
        continue;
      }
      if (code !== 0x22) continue;
      const tokenEnd = end + 1;
      let after = tokenEnd;
      while (after < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[after])) after++;
      if (text[after] === ":") {
        try {
          if (JSON.parse(text.slice(start, tokenEnd)) === "route_receipt") claims++;
        } catch { /* An invalid string token cannot make a decoded property claim. */ }
      }
      start = end;
      break;
    }
  }
  return claims;
}

function recognizedReceipt(receipt) {
  if (!exactKeys(receipt, RECEIPT_KEYS)) return false;
  if (receipt.schema_version !== 1 || receipt.route !== "mcp.brain_think" ||
      receipt.backend_route !== "think" || receipt.outcome !== "ok" ||
      receipt.answer_provider !== "anthropic" || receipt.answer_model !== "claude-opus-5-5" ||
      receipt.check_provider !== "anthropic" || receipt.check_model !== "claude-sonnet-5-5") return false;
  for (const key of ["answer_calls", "answer_errors", "check_calls", "check_errors", "fallback_search_calls"]) {
    if (!safeCount(receipt[key])) return false;
  }
  return receipt.answer_calls > 0 && receipt.check_calls > 0 &&
    receipt.answer_errors === 0 && receipt.check_errors === 0 && receipt.fallback_search_calls === 0;
}

/**
 * Accept one authorized top-level route receipt from actual MCP tool content.
 * Receipt-shaped evidence in malformed JSON is conflicting evidence, even if a
 * different content item carries an otherwise valid receipt.
 */
export function validatePartBRouteReceiptContent(content, { diagnosticsAuthorized } = {}) {
  if (!Array.isArray(content)) return refusal("content_invalid");
  const occurrences = [];
  let malformedEvidence = false;
  let duplicateMember = false;
  for (const item of content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const inspected = parseJsonPreservingMembers(item.text);
      occurrences.push(...inspected.occurrences);
      duplicateMember ||= inspected.duplicateMember;
    }
    catch {
      if (decodedReceiptPropertyClaims(item.text) > 0) malformedEvidence = true;
    }
  }
  if (malformedEvidence) return refusal(occurrences.length ? "receipt_conflicting" : "receipt_malformed");
  if (duplicateMember) return refusal(occurrences.length ? "receipt_conflicting" : "json_duplicate_member");
  if (occurrences.length === 0) return refusal("receipt_missing");
  if (occurrences.length !== 1) return refusal("receipt_conflicting");
  if (!occurrences[0].topLevel) return refusal("receipt_nested");
  if (diagnosticsAuthorized !== true) return refusal("diagnostics_unauthorized");
  if (!recognizedReceipt(occurrences[0].value)) return refusal("receipt_unrecognized");
  return Object.freeze({
    accepted: true,
    reason: "receipt_accepted",
    route_receipt: Object.freeze({ ...occurrences[0].value }),
  });
}

function processNameIsClaudeCode(command) {
  const name = String(command).trim().split(/[\\/]/u).at(-1)?.toLowerCase() || "";
  return /^claude(?:$|[ ._-])/u.test(name);
}

/** Read one current-user process snapshot through one fixed native boundary. */
export function readCurrentUserProcessList({
  platform = process.platform,
  environment = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  run = spawnSync,
} = {}) {
  if (platform === "win32") {
    const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT || environment?.WINDIR;
    if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
      throw new Error("current-user process query unavailable");
    }
    const command = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$current=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$found=0",
      "Get-CimInstance -ClassName Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object {",
      "  $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner",
      "  if ($owner.ReturnValue -eq 0 -and (\"$($owner.Domain)\\$($owner.User)\" -ieq $current)) { $found=1 }",
      "}",
      "[Console]::Out.Write($found)",
    ].join("; ");
    const result = run(command, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-",
    ], {
      input: script,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    });
    if (result?.status !== 0 || !/^[01]$/u.test(String(result.stdout))) {
      throw new Error("current-user process query failed");
    }
    return Object.freeze(result.stdout === "1" ? ["claude"] : []);
  }
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("current-user process query unavailable");
  const result = run("/bin/ps", ["-U", String(uid), "-o", "comm="], {
    encoding: "utf8",
    timeout: 30_000,
    env: { LC_ALL: "C" },
  });
  if (result?.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("current-user process query failed");
  }
  return Object.freeze(result.stdout.split(/\r?\n/u).filter(processNameIsClaudeCode).map(() => "claude"));
}

/** The CLI never stops a client process. It proves the full-exit precondition once. */
export async function proveClaudeCodeFullyExited({ readProcessList = readCurrentUserProcessList } = {}) {
  const running = await readProcessList();
  if (!Array.isArray(running)) throw new Error("current-user process query failed");
  if (running.length > 0) {
    const error = new Error(CLAUDE_CODE_FULL_EXIT_CARD.message);
    error.code = CLAUDE_CODE_RUNNING;
    error.card = CLAUDE_CODE_FULL_EXIT_CARD;
    throw error;
  }
}

function mcpChildEnvironment(descriptorEnvironment) {
  const environment = {};
  for (const name of MCP_CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value) environment[name] = value;
  }
  for (const [name, value] of Object.entries(descriptorEnvironment)) environment[name] = value;
  return environment;
}

/** Spawn exactly one absolute stdio descriptor and expose only MCP request/close. */
export async function openPartBMcpTransport(descriptor) {
  const expectedKeys = ["args", "command", "env", "name", "type"];
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
      JSON.stringify(Object.keys(descriptor).sort()) !== JSON.stringify(expectedKeys) ||
      descriptor.type !== "stdio" || typeof descriptor.command !== "string" ||
      !isAbsolute(descriptor.command) || !Array.isArray(descriptor.args) ||
      descriptor.args.some((arg) => typeof arg !== "string") ||
      !descriptor.env || typeof descriptor.env !== "object" || Array.isArray(descriptor.env) ||
      Object.entries(descriptor.env).some(([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== "string")) {
    throw new Error("invalid MCP descriptor");
  }

  const child = spawn(descriptor.command, descriptor.args, {
    env: mcpChildEnvironment(descriptor.env),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  let stdout = "";
  let stderrBytes = 0;
  let closed = false;
  let childFailure = null;
  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stderr.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > MAX_MCP_LINE_BYTES) {
      childFailure = new Error("MCP response exceeded its fixed bound");
      rejectPending(childFailure);
      child.kill();
      return;
    }
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let reply;
      try { reply = JSON.parse(line); }
      catch {
        childFailure = new Error("MCP returned invalid JSON");
        rejectPending(childFailure);
        child.kill();
        return;
      }
      const waiter = pending.get(reply?.id);
      if (!waiter) {
        childFailure = new Error("MCP returned an unsolicited reply");
        rejectPending(childFailure);
        child.kill();
        return;
      }
      pending.delete(reply.id);
      waiter.resolve(reply);
    }
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      childFailure = new Error("MCP child could not start", { cause: error });
      rejectPending(childFailure);
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (!childFailure && (code !== 0 || signal || stderrBytes > 0 || pending.size > 0 || stdout.trim())) {
        childFailure = new Error("MCP child did not close cleanly");
      }
      if (childFailure) {
        rejectPending(childFailure);
        reject(childFailure);
      } else resolve();
    });
  });
  // Prevent an early spawn failure from becoming an unhandled rejection before
  // the authority reaches request() or close().
  exit.catch(() => {});

  const request = (method, params = {}) => {
    if (closed || childFailure) return Promise.reject(childFailure || new Error("MCP transport is closed"));
    const id = nextId++;
    const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (!error) return;
      const waiter = pending.get(id);
      pending.delete(id);
      waiter?.reject(new Error("MCP request could not be written", { cause: error }));
    });
    return reply;
  };
  const close = async () => {
    if (!closed) child.stdin.end();
    await exit;
  };
  return Object.freeze({ request, close });
}

function acceptedGuideRefresh(value) {
  return exactKeys(value, GUIDE_KEYS) && value.schema_version === 1 &&
    value.operation === "claude_workspace_guide.refresh" &&
    ["written", "verified"].includes(value.outcome) && value.managed === true &&
    value.answer_route === "brain_think_first" &&
    Number.isSafeInteger(value.guide_generation) && value.guide_generation > 0;
}

function manifestBaseUrl(manifest) {
  const domain = manifest?.brain?.domain;
  if (typeof domain !== "string" || !domain || domain.trim() !== domain) return null;
  try {
    const explicitLoopback = domain.startsWith("http://") ? new URL(domain) : null;
    if (explicitLoopback) {
      return explicitLoopback.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(explicitLoopback.hostname) &&
        explicitLoopback.pathname === "/" && !explicitLoopback.username && !explicitLoopback.password &&
        !explicitLoopback.search && !explicitLoopback.hash ? explicitLoopback.origin : null;
    }
    const url = new URL(`https://${domain}`);
    return url.protocol === "https:" && url.host === domain && url.pathname === "/" &&
      !url.username && !url.password && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/**
 * Own the only Part B pass decision: exact manifest pair, accepted guide
 * generation, full old-process stop, production descriptor, initialized fresh
 * tool call, closed transport, and strict validation of that call's content.
 */
export async function provePartBRouteReadiness({ manifestPath, guideRefresh, control } = {}, {
  stopMcpProcess,
  openMcpTransport,
} = {}) {
  const routeEvents = [];
  const reject = (reason, extra = {}) => Object.freeze({
    ready: false,
    reason,
    route_events: Object.freeze([...routeEvents]),
    ...extra,
  });
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return reject("manifest_unavailable"); }
  if (manifest?.retrieval?.answer_model !== "claude-opus-5-5" ||
      manifest?.retrieval?.gate_model !== "claude-sonnet-5-5") {
    return reject("model_pair_mismatch");
  }
  if (!acceptedGuideRefresh(guideRefresh)) return reject("guide_refresh_refused");
  if (typeof stopMcpProcess !== "function" || typeof openMcpTransport !== "function") {
    return reject("full_exit_boundary_absent");
  }
  if (control?.name !== "brain_think" || !control.arguments ||
      typeof control.arguments !== "object" || Array.isArray(control.arguments) ||
      typeof control.arguments.q !== "string" || !control.arguments.q.trim()) {
    return reject("control_invalid");
  }
  const baseUrl = manifestBaseUrl(manifest);
  if (!baseUrl) return reject("brain_url_unavailable");

  try {
    routeEvents.push("stop");
    await stopMcpProcess();
  } catch (error) {
    if (error?.code === CLAUDE_CODE_RUNNING) {
      return reject("claude_code_running", { card: CLAUDE_CODE_FULL_EXIT_CARD });
    }
    return reject("process_stop_failed");
  }

  let descriptor;
  try { descriptor = mcpRegistrationDescriptor(manifest, manifestPath, { baseUrl }); }
  catch { return reject("descriptor_invalid"); }

  let transport;
  try {
    transport = await openMcpTransport(descriptor);
    routeEvents.push("open");
  } catch { return reject("transport_open_failed"); }
  if (!transport || JSON.stringify(Object.keys(transport).sort()) !== JSON.stringify(["close", "request"]) ||
      typeof transport.request !== "function" || typeof transport.close !== "function") {
    try { await transport?.close?.(); } catch {}
    return reject("transport_invalid");
  }

  let toolContent = null;
  let operationFailure = null;
  try {
    const initialized = await transport.request("initialize", INITIALIZE_PARAMS);
    routeEvents.push("initialize");
    if (!initialized?.result || initialized.error) operationFailure = "initialize_failed";
    else {
      const freshTool = await transport.request("tools/call", control);
      routeEvents.push("brain_think");
      if (!freshTool?.result || freshTool.result.isError === true || !Array.isArray(freshTool.result.content)) {
        operationFailure = "tool_failed";
      } else toolContent = freshTool.result.content;
    }
  } catch { operationFailure = "transport_request_failed"; }
  try {
    await transport.close();
    routeEvents.push("close");
  } catch { return reject("transport_close_failed"); }
  if (operationFailure) return reject(operationFailure);

  const validation = validatePartBRouteReceiptContent(toolContent, {
    diagnosticsAuthorized: descriptor.env.BRAIN_AGENT_PROFILE === LOCAL_OWNER_AGENT_PROFILE &&
      profileHas(descriptor.env.BRAIN_AGENT_PROFILE, "diagnostics:read"),
  });
  if (!validation.accepted) return reject(validation.reason);
  return Object.freeze({
    ready: true,
    reason: "route_receipt_accepted",
    route_events: Object.freeze([...routeEvents]),
    route_receipt: validation.route_receipt,
  });
}
