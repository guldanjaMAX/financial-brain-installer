import { fileURLToPath as auditRootPath } from "node:url";
// Fable audit harness: drives the REAL candidate answer routes with synthetic
// documents, a fake answer model and a fake verifier. No network, no model.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const C = auditRootPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
const imp = (p) => import(pathToFileURL(join(C, p)).href);
const { createProductFixture } = await imp("worker/test/product-contract-fixture.mjs");
const { handleMcp } = await imp("worker/src/lib/mcp-endpoint.js");
const { writeAdminKeyFile } = await imp("operations/admin-key-file.mjs");
const transport = await imp("test/fixtures/mcp-fetch-transport.mjs");
const MCP = join(C, "components/brain-mcp.mjs");

const realNow = Date.now.bind(Date);
const realFetch = globalThis.fetch;

const { buildEnvelope } = await imp("connectors/google-calendar.mjs");
/** A calendar record built by the REAL Google Calendar connector. */
export const calEvent = (event) => { const built = buildEnvelope(event); if (built.kind !== "upsert") throw new Error("calendar connector did not upsert");
  return { title: built.envelope.title, content: built.envelope.content, source: "calendar_event", kind: "calendar",
    date: built.envelope.occurred_at, dateReliable: true, envelope: built.envelope }; };
export const rec = (title, content, o = {}) => ({
  title, content, source: o.source || "mail", kind: o.kind || "gmail",
  date: o.date === undefined ? "2026-11-10" : o.date, dateReliable: o.dateReliable !== false,
  dateSource: o.dateSource || "fixture:record_date", textSource: o.textSource || "native",
  textReliable: o.textReliable !== false, sweep: o.sweep, metadata: o.metadata,
});

function mcpRuntime(url) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "document-audit-mcp-")));
  const home = join(root, "home"); mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  // Native DPAPI needs the current account and the system executable locations.
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"), process.platform === "win32"
    ? { environment: process.env, username: process.env.USERNAME || process.env.USER }
    : { environment: { HOME: home } });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const env = { HOME: home, BRAIN_URL: url, BRAIN_NAME: "fixture-brain", BRAIN_MANIFEST: manifest,
    BRAIN_AGENT_PROFILE: "owner-assistant", BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "USERNAME", "USER", "LOGNAME", "PATH", "TMPDIR", "TEMP", "TMP"])
    if (process.env[name]) env[name] = process.env[name];
  return { env, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function localMcp(url, messages, profile) {
  const runtime = mcpRuntime(url);
  if (profile !== undefined) runtime.env.BRAIN_AGENT_PROFILE = profile;
  try {
    const child = spawn(process.execPath, ["--import", transport.fixtureFetchHook, MCP], {
      stdio: ["pipe", "pipe", "pipe", "ipc"], env: runtime.env, timeout: 30000 });
    transport.connectFixtureTransport(child, url);
    child.channel?.unref();
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
    if (code !== 0) throw new Error(`MCP exited ${code}: ${stderr.slice(0, 500)}`);
    return stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } finally { runtime.close(); }
}

/**
 * Run one case through: Worker /api/rag/think, Worker /api/rag/unified,
 * local MCP brain_think + brain_search (stdio child -> real Worker), remote MCP ask.
 * draft: string with [r0] markers (record index) or (prompt)=>string. May be an array (attempt 1, 2).
 * verifier: undefined (approve what was cited), object, or array of objects / Errors.
 */
export async function runCase(c) {
  const NOW = Date.parse(c.now || "2026-11-12T18:00:00Z");
  Date.now = () => NOW;
  let network = 0;
  globalThis.fetch = async () => { network++; throw new Error("network forbidden"); };
  const calls = { draft: 0, verifier: 0, prompts: [], verifierPrompts: [] };
  const records = c.records || [];
  const ai = { async run(model, input) {
    if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    const system = String(input.messages?.[0]?.content || "");
    const prompt = String(input.messages?.at(-1)?.content || "");
    if (system.includes("verify a proposed answer")) {
      calls.verifierPrompts.push(prompt);
      const list = Array.isArray(c.verifier) ? c.verifier : c.verifier === undefined ? null : [c.verifier];
      const reply = list ? list[Math.min(calls.verifier, list.length - 1)] : null;
      calls.verifier++;
      if (reply instanceof Error) throw reply;
      if (reply) return { response: reply };
      const proposed = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(prompt)?.[1] || "";
      const evidence = [...new Set([...proposed.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
      return { response: { supported: true, complete: true, evidence, conflicts: [], reason: "synthetic support" } };
    }
    if (system.includes("You verify each synthesis item")) {
      calls.synthesis = (calls.synthesis || 0) + 1;
      if (c.synthesisVerifier !== undefined) return { response: typeof c.synthesisVerifier === "string" ? c.synthesisVerifier : JSON.stringify(c.synthesisVerifier) };
      // Faithful stand-in: approve each cited item with an exact span copied from its cited document.
      const proposal = JSON.parse(prompt);
      return { response: JSON.stringify({ items: proposal.items.map((item) => ({ item: item.item, supported: item.citations.length > 0,
        evidence: item.documents.map((doc) => ({ n: doc.n, quote: String(doc.snippet).replace(/\s+/g, " ").trim().slice(0, 40) })) })) }) };
    }
    calls.systems = calls.systems || []; calls.systems.push(system.slice(0, 80));
    calls.prompts.push(prompt);
    const numbers = new Map();
    records.forEach((row, index) => {
      const at = prompt.indexOf(row.content.split("\n")[0].slice(0, 60));
      const preceding = at < 0 ? [] : [...prompt.slice(0, at).matchAll(/^\[(\d+)\] \(/gm)];
      let n = Number(preceding.at(-1)?.[1]);
      if (!Number.isInteger(n)) { const heading = prompt.split("\n").find((line) => /^\[\d+\]/.test(line) && line.endsWith(row.title)); n = Number(/^\[(\d+)\]/.exec(heading || "")?.[1]); }
      if (Number.isInteger(n)) numbers.set(index, n);
    });
    const drafts = Array.isArray(c.draft) ? c.draft : [c.draft];
    let d = drafts[Math.min(calls.draft, drafts.length - 1)];
    calls.draft++;
    if (d instanceof Error) throw d;
    if (typeof d === "function") d = d(prompt, numbers);
    const text = String(d ?? "The documents do not answer the question.").replace(/\[r(\d+)\]/g, (_, i) =>
      numbers.has(Number(i)) ? `[${numbers.get(Number(i))}]` : `[99]`);
    calls.lastDraft = text; calls.rendered = [...numbers.keys()];
    return { response: text };
  } };
  const fixture = await createProductFixture({ productRoot: C, env: { AI: ai, BRAIN_OWNER: c.owner || "Fixture Owner",
    ...(c.timezone === null ? {} : { BRAIN_TIMEZONE: c.timezone || "America/Phoenix" }), ...(c.env || {}) } });
  const out = { id: c.id, question: c.question };
  try {
    for (const row of records) fixture.raw(
      "INSERT OR IGNORE INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES (?,?, 'ready','2026-01-01',?,?,86400)",
      row.source, row.kind, new Date(NOW).toISOString(), row.sweep === null ? null : new Date(NOW).toISOString());
    for (const s of c.extraSources || []) fixture.raw(
      "INSERT OR IGNORE INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES (?,?,?,'2026-01-01',?,?,86400)",
      s.name, s.kind, s.status || "ready", s.lastIngest ?? null, s.sweep ?? null);
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const doc = { source_type: row.source, source_id: `record-${i}`, title: row.title, content: row.content,
        date_reliable: row.dateReliable, date_source: row.dateSource, text_source: row.textSource, text_reliable: row.textReliable,
        metadata: { evidence_lineage: { version: 1, kind: "source_record" }, ...(row.metadata || {}) } };
      if (row.date) doc.occurred_at = row.date;
      if (row.envelope) { for (const k of Object.keys(doc)) delete doc[k]; Object.assign(doc, row.envelope, { source_type: row.source, source_id: `record-${i}` }); }
      const response = await fixture.post("/api/admin/brain/ingest/batch", { docs: [doc] }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
      const body = await response.json();
      if (response.status !== 200 || body.results?.[0]?.status !== "created") throw new Error(`ingest failed for record ${i}: ${JSON.stringify(body).slice(0, 400)}`);
    }
    if (typeof c.afterIngest === "function") await c.afterIngest(fixture);
    fixture.raw("DELETE FROM vector_outbox");
    const n = fixture.first("SELECT COUNT(*) AS n FROM chunks").n;
    const proj = c.projection || {};
    fixture.raw("UPDATE install_state SET vector_projection_status=?, vector_projection_bootstrap_base_count=?, vector_projection_mutation_id=NULL, vector_projection_submitted_at=NULL WHERE id=1",
      proj.status ?? "verified", proj.expected ?? n);
    fixture.env.VECTORIZE.describe = async () => ({ vectorCount: proj.actual ?? n, processedUpToMutation: null });
    let searches = 0;
    fixture.env.VECTORIZE.query = async () => { searches++; if (c.vectorFails) throw new Error("fixture vector query unavailable");
      return { matches: c.empty ? [] : fixture.rows("SELECT chunk_uid AS id FROM chunks") }; };
    const admin = { "X-Admin-Key": fixture.env.ADMIN_KEY };
    const reset = () => { calls.draft = 0; calls.verifier = 0; calls.synthesis = 0; };

    // 1. Worker think route
    const beforeThinkReads = fixture.seen.sql.length;
    const tr = await fixture.post("/api/rag/think", { q: c.question, ...(c.thinkBody || {}) }, admin);
    out.think_http = tr.status;
    const think = await tr.json();
    out.worker_read_calls = fixture.seen.sql.length - beforeThinkReads;
    out.worker_think = think;
    out.calls = { draft: calls.draft, verifier: calls.verifier, synthesis: calls.synthesis || 0, systems: calls.systems, searches, lastDraft: calls.lastDraft, recordsShownToModel: calls.rendered };
    // 2. Worker unified route
    const ur = await fixture.post("/api/rag/unified", { q: c.searchQuery || c.question, ...(c.searchBody || {}) }, admin);
    out.worker_unified = await ur.json();
    // 3. local MCP (stdio child, real Worker behind the fixture transport)
    if (c.mcp !== false) {
      const endpoint = transport.fixtureTransport(async (req, res) => {
        let raw = ""; for await (const chunk of req) raw += chunk;
        reset();
        const r = await fixture.worker.fetch(new Request(`https://brain.invalid${req.url}`, { method: req.method,
          headers: { "Content-Type": "application/json", ...admin }, ...(req.method === "POST" ? { body: raw } : {}) }),
          fixture.env, { waitUntil() {}, passThroughOnException() {} });
        res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(await r.text());
      });
      try {
        Date.now = realNow; // child timers
        const p = (async () => localMcp(endpoint.url, [
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brain_think", arguments: { q: c.question } } },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "brain_search", arguments: { q: c.searchQuery || c.question, ...(c.searchArgs || {}) } } },
        ], c.profile))();
        // Worker calls must see the frozen clock; the transport handler runs in this process.
        Date.now = () => NOW;
        const replies = await p;
        const parse = (r) => { const t = r?.result?.content?.[0]?.text; try { return { isError: r?.result?.isError === true, body: JSON.parse(t) }; } catch { return { isError: r?.result?.isError === true, text: t, error: r?.error }; } };
        out.mcp_think = parse(replies.find((r) => r.id === 1));
        out.mcp_search = parse(replies.find((r) => r.id === 2));
      } finally { await endpoint.close(); }
    }
    // 4. remote MCP ask (same wiring shape as index.js: think/search deps)
    reset();
    const url = new URL("https://brain.invalid/mcp");
    const remote = await (await handleMcp(fixture.env, new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "ask", arguments: { question: c.question } } }) }), url, {
      think: async (body) => (await fixture.post("/api/rag/think", body, admin)).json(),
      search: async (body) => (await fixture.post("/api/rag/unified", body, admin)).json(),
    })).json();
    out.remote_ask = { isError: remote.result?.isError === true, text: remote.result?.content?.[0]?.text ?? null, error: remote.error };
    out.network_attempts = network;
  } finally {
    fixture.close(); Date.now = realNow; globalThis.fetch = realFetch;
  }
  return out;
}

const confLine = /Confidence: (High|Medium|Low) \((\d+)%\)/;
export function summarize(o) {
  const w = o.worker_think || {}, m = o.mcp_think?.body || {}, s = o.mcp_search?.body || {};
  const ask = o.remote_ask?.text || "";
  return {
    id: o.id, question: o.question,
    model_draft: o.calls?.lastDraft ?? null, draft_calls: o.calls?.draft, verifier_calls: o.calls?.verifier,
    worker: { answer: w.answer ?? null, status: w.status ?? null, notice: w.notice, answer_error: w.answer_error,
      evidence_gate: w.evidence_gate ? { supported: w.evidence_gate.supported, partial: w.evidence_gate.partial, reason: w.evidence_gate.reason } : null,
      confidence: w.confidence ?? null, citations: (w.citations || []).map((x) => `${x.n}:${x.title}`),
      results: (w.results || []).map((x) => `${x.title} (${String(x.ts || "").slice(0, 10) || "no date"}${x.date_reliable ? "" : "; unverified"})`),
      gaps: (w.gaps || []).map((g) => `${g.type}: ${String(g.detail || "").slice(0, 160)}`), next_action: w.next_action },
    local_brain_think: o.mcp_think ? { isError: o.mcp_think.isError, answer: m.answer ?? null, search_status: m.search_status, confidence: m.confidence ? { band: m.confidence.band, percent: m.confidence.percent, basis: m.confidence.basis, missing: m.confidence.missing } : null,
      citations: (m.citations || []).length, results: (m.results || []).length, note: m.note, next_action: m.next_action, answer_error: m.answer_error, text: o.mcp_think.text } : null,
    local_brain_search: o.mcp_search ? { count: s.count, search_status: s.search_status, confidence: s.confidence ? { band: s.confidence.band, percent: s.confidence.percent } : null,
      titles: (s.results || []).map((x) => x.title), note: s.note, gaps: (s.gaps || []).map((g) => g.type) } : null,
    remote_ask: { isError: o.remote_ask?.isError, text: ask, confidence_line: confLine.exec(ask)?.[0] ?? null },
    network_attempts: o.network_attempts,
  };
}
