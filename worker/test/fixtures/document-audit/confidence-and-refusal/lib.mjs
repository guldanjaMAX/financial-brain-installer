import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Audit harness. Imports the REAL candidate modules by absolute path; never writes there.
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export const C = auditRootPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
const worker = (await import(auditFileUrl(`${C}/worker/src/index.js`).href)).default;
export const { handleMcp } = await import(auditFileUrl(`${C}/worker/src/lib/mcp-endpoint.js`).href);
const { writeAdminKeyFile } = await import(auditFileUrl(`${C}/operations/admin-key-file.mjs`).href);
export const render = await import(auditFileUrl(`${C}/worker/src/lib/answer-render.js`).href);
export const conf = await import(auditFileUrl(`${C}/worker/src/lib/confidence.js`).href);

// The candidate's own D1/Vectorize/AI fixture, lifted verbatim from its route tests.
const routesSrc = readFileSync(`${C}/worker/test/routes.test.mjs`, "utf8");
const a = routesSrc.indexOf("function mkEnv(");
const b = routesSrc.indexOf("\nconst ROW = {");
if (a < 0 || b < a) throw new Error("mkEnv fixture not found");
export const mkEnv = new Function(`${routesSrc.slice(a, b)}\nreturn mkEnv;`)();

const DAY = 86400000;
export const NOW = Date.parse("2026-11-12T19:00:00Z");
Date.now = () => NOW;
export function row(n, { title, text, daysAgo = 3, reliable = true, source = "drive", kind = "google_drive", textSource = "native", extra = {} } = {}) {
  return {
    chunk_uid: `${source}:doc${n}#0`, doc_uid: `${source}:doc${n}`, text,
    source, source_kind: kind, source_id: `doc${n}`, uri: `${source}://doc${n}`, title,
    document_date: NOW - daysAgo * DAY, client: null, category: "document",
    date_reliable: reliable ? 1 : 0, date_source: reliable ? "fixture:event_date" : "file:modified",
    top_folder: "Records", platform: null, text_source: textSource, text_reliable: textSource === "native" ? 1 : 0,
    ...extra,
  };
}

/** Fake answer provider. draft: string | (attempt)=>string | Error. verdict: object. */
export function aiStub({ draft, verdict = { supported: true, complete: true, evidence: [1], reason: "direct support" }, log = [] }) {
  let attempt = 0;
  return {
    log,
    run: async (model, input) => {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      const sys = String(input?.messages?.[0]?.content || "");
      const all = JSON.stringify(input?.messages || []);
      if (/verify a proposed answer/.test(all)) {
        log.push("verifier");
        const v = typeof verdict === "function" ? verdict(all) : verdict;
        return { response: v, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }
      if (/synthesis|supported items/i.test(sys) && /JSON/.test(sys) && !/second brain/.test(sys)) {
        log.push("synthesis-gate");
        return { response: null, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }
      log.push("answer");
      if (draft instanceof Error) throw draft;
      const d = typeof draft === "function" ? draft(attempt++, all) : draft;
      return { response: d, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
}

export async function think(rows, q, { draft, verdict, owner = "Owner Example", extra = {}, mk = {}, params = {} } = {}) {
  const log = [];
  const { env, seen } = mkEnv(rows, {
    vectorIds: rows.map(r => r.chunk_uid),
    ...mk,
    extra: { BRAIN_OWNER: owner, BRAIN_TIMEZONE: "America/Phoenix", ...(draft !== undefined ? { AI: aiStub({ draft, verdict, log }) } : {}), ...extra },
  });
  const res = await worker.fetch(new Request("https://b.example/api/rag/think", {
    method: "POST", headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, ...params }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const body = await res.json();
  return { status: res.status, body, log, seen };
}
export async function unified(rows, q, { mk = {}, extra = {}, params = {} } = {}) {
  const { env } = mkEnv(rows, { vectorIds: rows.map(r => r.chunk_uid), ...mk, extra: { BRAIN_OWNER: "Owner Example", BRAIN_TIMEZONE: "America/Phoenix", ...extra } });
  const res = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST", headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, ...params }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, body: await res.json() };
}

/** Remote MCP surface (what the Claude app's connector prints), fed the real Worker body. */
export async function remoteAsk(body, question = "fixture question") {
  const url = new URL("https://fixture.invalid/mcp");
  const reply = await (await handleMcp({ DB: { prepare() { throw new Error("unexpected"); } } },
    new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "ask", arguments: { question } } }) }), url, {
      think: async () => body, search: async () => body,
    })).json();
  return { isError: !!reply.result?.isError, text: reply.result?.content?.[0]?.text ?? JSON.stringify(reply) };
}
export async function remoteSearch(body) {
  const url = new URL("https://fixture.invalid/mcp");
  const reply = await (await handleMcp({ DB: { prepare() { throw new Error("unexpected"); } } },
    new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search", arguments: { query: "fixture query" } } }) }), url, {
      think: async () => body, search: async () => body,
    })).json();
  const t = reply.result?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: t, isError: reply.result?.isError }; }
}

/** Local stdio MCP (components/brain-mcp.mjs) in a child, fetch replaced by canned real Worker bodies. No socket. */
export async function localMcp(bodiesByQ, tool = "brain_think") {
  const root = realpathSync.native(mkdtempSync(join(process.env.HOME, "audit-mcp-")));
  const home = join(root, "home"); mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"), { environment: { HOME: home } });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const hook = join(root, "fetch-hook.mjs");
  writeFileSync(hook, `
const bodies = ${JSON.stringify(bodiesByQ)};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://fixture.invalid") throw new Error("unexpected synthetic fetch target");
  const request = JSON.parse(String(init.body || "{}"));
  if (!Object.hasOwn(bodies, request.q)) throw new Error("unexpected synthetic question " + url.pathname);
  return new Response(JSON.stringify(bodies[request.q]), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
  const env = { HOME: home, TMPDIR: root, BRAIN_URL: "https://fixture.invalid", BRAIN_NAME: "fixture-brain",
    BRAIN_MANIFEST: manifest, BRAIN_AGENT_PROFILE: "", BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, PATH: process.env.PATH, USER: process.env.USER || "x" };
  const names = Object.keys(bodiesByQ);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    ...names.map((q, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name: tool, arguments: { q } } })),
  ];
  try {
    const child = spawn(process.execPath, [`${C}/components/brain-mcp.mjs`], { stdio: ["pipe", "pipe", "pipe"], env, timeout: 30000 });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
    child.stdin.end(messages.map(m => JSON.stringify(m)).join("\n") + "\n");
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
    if (code !== 0) throw new Error("local MCP exit " + code + ": " + err.slice(0, 500));
    const replies = out.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const result = {};
    names.forEach((q, i) => {
      const r = replies.find(x => x.id === i + 2);
      const t = r?.result?.content?.[0]?.text;
      let parsed; try { parsed = JSON.parse(t); } catch { parsed = { raw: t }; }
      result[q] = { isError: !!r?.result?.isError, out: parsed };
    });
    return { instructions: replies.find(x => x.id === 1)?.result?.instructions, result };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export const brief = (b) => ({
  answer: b.answer, status: b.status, notice: b.notice, answer_error: b.answer_error,
  next_action: b.next_action, confidence: b.confidence,
  evidence_gate: b.evidence_gate && { supported: b.evidence_gate.supported, complete: b.evidence_gate.complete, partial: b.evidence_gate.partial, reason: b.evidence_gate.reason, evidence: b.evidence_gate.evidence },
  citations: (b.citations || []).map(c => `[${c.n}] ${c.title}`),
  results: (b.results || []).length,
  gaps: (b.gaps || []).map(g => g.type),
  withheld_documents: b.withheld_documents, time_window: b.time_window, ledger: b.ledger ? "present" : undefined, mode: b.mode,
});
