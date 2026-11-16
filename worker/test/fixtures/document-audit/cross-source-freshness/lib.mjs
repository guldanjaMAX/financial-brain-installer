import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Cross-source / freshness audit harness. Imports the REAL candidate by absolute path; never writes there.
// Real Worker fetch handler, real migrations on in-memory SQLite, real ingest route, real FTS search.
// Only the model (env.AI) and the vector index are fakes, exactly as in the candidate's own tests.
export const C = auditRootPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
const { createProductFixture } = await import(auditFileUrl(`${C}/worker/test/product-contract-fixture.mjs`).href);
export const { handleMcp } = await import(auditFileUrl(`${C}/worker/src/lib/mcp-endpoint.js`).href);
export const conf = await import(auditFileUrl(`${C}/worker/src/lib/confidence.js`).href);
export const DAY = 86400000;
export const NOW = Date.parse("2026-11-12T19:00:00Z");
Date.now = () => NOW;
export const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
export const day = (daysAgo) => iso(daysAgo).slice(0, 10);

export const doc = (source, id, title, content, daysAgo, o = {}) => ({
  source_type: source, source_id: id, title, content,
  occurred_at: iso(daysAgo),
  date_source: o.reliable === false ? "file:modified" : "fixture:recorded_at",
  date_reliable: o.reliable !== false,
  text_source: o.textSource || "native",
  text_reliable: (o.textSource || "native") === "native",
  metadata: { evidence_lineage: { version: 1, kind: "source_record" }, ...(o.metadata || {}) },
});

/** sources: [{name, kind, status?, lastIngestDaysAgo?, expectedSeconds?, sweepDaysAgo?, staleReason?}] */
export async function build({ sources = [], docs = [], draft, verdict, owner = "Fixture Owner", env = {}, indexBuilding = false } = {}) {
  const log = [];
  let attempt = 0;
  const fixture = await createProductFixture({
    productRoot: C,
    env: {
      BRAIN_TIMEZONE: "UTC", BRAIN_OWNER: owner,
      AI: {
        async run(model, input) {
          if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          const all = JSON.stringify(input?.messages || []);
          if (all.includes("verify a proposed answer")) {
            log.push("verifier");
            const v = typeof verdict === "function" ? verdict(all) : (verdict ?? { supported: true, complete: true, evidence: [1], reason: "direct support" });
            return { response: v };
          }
          const sys = String(input?.messages?.[0]?.content || "");
          if (!/second brain|answer the question|cite/i.test(sys)) { log.push("other:" + sys.slice(0, 60)); }
          else log.push("draft");
          if (draft instanceof Error) throw draft;
          const d = typeof draft === "function" ? draft(all, attempt++) : draft;
          return { response: d ?? "The documents do not answer the question." };
        },
      },
      ...env,
    },
  });
  for (const s of sources) {
    fixture.raw(
      `INSERT INTO sources(name,kind,status,created_at,last_ingest_at,expected_refresh_seconds,last_complete_sweep_at,stale_reason)
       VALUES (?,?,?,?,?,?,?,?)`,
      s.name, s.kind || "upload", s.status || "ready", iso(400),
      s.lastIngestDaysAgo == null ? null : iso(s.lastIngestDaysAgo),
      s.expectedSeconds ?? null,
      s.sweepDaysAgo == null ? null : iso(s.sweepDaysAgo),
      s.staleReason ?? null,
    );
  }
  const H = { "X-Admin-Key": fixture.env.ADMIN_KEY };
  if (docs.length) {
    const r = await fixture.post("/api/admin/brain/ingest/batch", { docs }, H);
    const b = await r.json();
    const bad = (b.results || []).filter(x => x.status !== "created");
    if (r.status !== 200 || bad.length) throw new Error("ingest failed: " + JSON.stringify(b).slice(0, 600));
    // ingest touches last_ingest_at / status; restore the declared source state so freshness is what the case says
    for (const s of sources) {
      fixture.raw(`UPDATE sources SET status=?, last_ingest_at=?, last_complete_sweep_at=?, stale_reason=?, expected_refresh_seconds=? WHERE name=?`,
        s.status || "ready", s.lastIngestDaysAgo == null ? null : iso(s.lastIngestDaysAgo),
        s.sweepDaysAgo == null ? null : iso(s.sweepDaysAgo), s.staleReason ?? null, s.expectedSeconds ?? null, s.name);
    }
  }
  if (!indexBuilding) {
    // Same synthetic healthy-projection receipt the candidate's money-recall test uses.
    fixture.raw("DELETE FROM vector_outbox");
    const vectorCount = fixture.first("SELECT COUNT(*) AS n FROM chunks").n;
    fixture.raw("UPDATE install_state SET vector_projection_status='verified', vector_projection_bootstrap_base_count=? WHERE id=1", vectorCount);
    fixture.env.VECTORIZE.describe = async () => ({ vectorCount, processedUpToMutation: null });
  }
  fixture.env.VECTORIZE.query = async () => ({ matches: fixture.rows("SELECT chunk_uid AS id FROM chunks ORDER BY document_date DESC") });
  const call = async (path, body) => { const r = await fixture.post(path, body, H); return { http: r.status, body: await r.json() }; };
  return { fixture, log, think: (q, p = {}) => call("/api/rag/think", { q, ...p }), unified: (q, p = {}) => call("/api/rag/unified", { q, ...p }), close: () => fixture.close() };
}

/** Remote connector surface (ask/search), fed the real Worker body. */
export async function remote(tool, body, args) {
  const url = new URL("https://fixture.invalid/mcp");
  const reply = await (await handleMcp({ DB: { prepare() { throw new Error("unexpected"); } } },
    new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) }),
    url, { think: async () => body, search: async () => body })).json();
  return { isError: !!reply.result?.isError, text: reply.result?.content?.[0]?.text ?? JSON.stringify(reply) };
}

export const brief = (b) => ({
  answer: b.answer, status: b.status, notice: b.notice, answer_error: b.answer_error, next_action: b.next_action,
  confidence: b.confidence && { percent: b.confidence.percent, band: b.confidence.band, basis: b.confidence.basis },
  gate: b.evidence_gate && { supported: b.evidence_gate.supported, partial: b.evidence_gate.partial, reason: b.evidence_gate.reason },
  citations: (b.citations || []).map(c => `[${c.n}] ${c.title} ${String(c.ts || "").slice(0, 10)}`),
  results: (b.results || []).map(r => `${r.title} ${String(r.ts || "").slice(0, 10)}${r.date_reliable ? "" : " (unreliable date)"}`),
  gaps: (b.gaps || []).map(g => g.type + (g.source ? `:${g.source}` : "")),
  time_window: b.time_window, degraded: b.degraded, ledger: b.ledger ? "present" : undefined,
});

// Local stdio MCP (components/brain-mcp.mjs) run as a child process. Its fetch is replaced by the
// real Worker bodies captured above, so no socket is opened. calls: [{tool, q, body}]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export async function localMcp(calls) {
  const { writeAdminKeyFile } = await import(auditFileUrl(`${C}/operations/admin-key-file.mjs`).href);
  const root = realpathSync.native(mkdtempSync(join(process.env.HOME, "audit-mcp-")));
  const home = join(root, "home"); mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"), { environment: { HOME: home } });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const bodies = {};
  for (const c of calls) bodies[(c.tool === "brain_search" ? "/api/rag/unified" : "/api/rag/think") + "|" + c.q] = c.body;
  const hook = join(root, "fetch-hook.mjs");
  writeFileSync(hook, `
const bodies = ${JSON.stringify(bodies)};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://fixture.invalid") throw new Error("unexpected synthetic fetch target");
  const request = JSON.parse(String(init.body || "{}"));
  const key = url.pathname + "|" + request.q;
  if (!Object.hasOwn(bodies, key)) throw new Error("unexpected synthetic request " + url.pathname);
  return new Response(JSON.stringify(bodies[key]), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
  const env = { HOME: home, TMPDIR: root, BRAIN_URL: "https://fixture.invalid", BRAIN_NAME: "fixture-brain",
    BRAIN_MANIFEST: manifest, BRAIN_AGENT_PROFILE: "", BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, PATH: process.env.PATH, USER: process.env.USER || "x" };
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name: c.tool, arguments: { q: c.q } } })),
  ];
  try {
    const child = spawn(process.execPath, [`${C}/components/brain-mcp.mjs`], { stdio: ["pipe", "pipe", "pipe"], env, timeout: 60000 });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
    child.stdin.end(messages.map(m => JSON.stringify(m)).join("\n") + "\n");
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
    if (code !== 0) throw new Error("local MCP exit " + code + ": " + err.slice(0, 800));
    const replies = out.split("\n").filter(Boolean).map(l => JSON.parse(l));
    return calls.map((c, i) => {
      const r = replies.find(x => x.id === i + 2);
      const t = r?.result?.content?.[0]?.text;
      let parsed; try { parsed = JSON.parse(t); } catch { parsed = { raw: t ?? r }; }
      return { isError: !!r?.result?.isError, out: parsed };
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
