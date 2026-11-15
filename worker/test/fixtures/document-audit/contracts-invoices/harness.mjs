import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Shared harness. Drives the REAL candidate worker.fetch answer routes over the
// candidate's own fake D1 / Vectorize / Workers AI env (brainEnv is lifted
// verbatim, at run time, from worker/test/scanned-evidence.test.mjs).
// Nothing in the candidate is edited; no network; no real model.
import { readFileSync } from "node:fs";
export const CAND = auditRootPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
export const worker = (await import(auditFileUrl(`${CAND}/worker/src/index.js`).href)).default;
const { OCR_BANNER, assembleOcr, pageMarker } = await import(auditFileUrl(`${CAND}/ingest/ocr.mjs`).href);
const src = readFileSync(`${CAND}/worker/test/scanned-evidence.test.mjs`, "utf8");
const a = src.indexOf("function brainEnv({");
const b = src.indexOf("\n/** One private POST", a);
if (a < 0 || b < 0) throw new Error("brainEnv template not found in the candidate test");
const brainEnv = new Function(`${src.slice(a, b)}\nreturn brainEnv;`)();

// Registered, fully swept source: the best case for the code (no coverage excuse).
export const COVERAGE_COMPLETE = (names = ["drive", "gmail"]) => names.map(name => ({
  name, kind: name, zone: null, status: "ready",
  last_ingest_at: new Date(Date.now() - 3600e3).toISOString(),
  last_complete_sweep_at: new Date(Date.now() - 7200e3).toISOString(),
  expected_refresh_seconds: 86400, stale_reason: null, document_count: 40,
  indexing_started_at: null, registered: 1 }));

function storedMeta(r, { ocr = null } = {}) {
  const recorded = r.text_source !== "unknown";
  return JSON.stringify({ evidence_lineage: { version: 1, kind: "source_record", root_ids: [] },
    provenance_receipt: { version: 1, status: recorded ? "complete" : "partial",
      reason: recorded ? "lineage_and_text_recorded" : "text_provenance_unavailable",
      root_ids: [`${r.source}:${r.source_id}`] }, ...(ocr ? { ocr } : {}) });
}
const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
let seq = 0;
export function row({ title, text, date = "2026-03-01", reliable = 1, source = "drive", kind = null,
  category = "contract", state = "native", id = null, client = null, extra = {}, ocrPages = null }) {
  const sid = id || `doc${++seq}`;
  const ts = { native: ["native", 1], ocr: ["ocr", 0], ocr_partial: ["ocr_partial", 0], unknown: ["unknown", 0] }[state];
  const scan = state === "ocr" || state === "ocr_partial";
  const r = { chunk_uid: `${source}:${sid}#0`, doc_uid: `${source}:${sid}`, source, source_kind: kind || source,
    source_id: sid, uri: `${source}://${sid}`, title, client, category,
    document_date: date ? day(date) : null, date_source: reliable ? "document_date" : "file_modified",
    date_reliable: reliable, text_source: ts[0], text_reliable: ts[1],
    text: scan ? `${OCR_BANNER}\n\n${pageMarker(1)}\n${text}` : text, ...extra };
  let ocr = null;
  if (scan) {
    const pages = ocrPages || [text];
    const verdict = assembleOcr(pages.map((p, i) => typeof p === "string" ? { page: i + 1, text: p } : { page: i + 1, ...p }),
      { totalPages: pages.length, model: "fixture-ocr-model" });
    ocr = verdict.provenance || null;
  }
  return { ...r, authority_meta: r.authority_meta || storedMeta(r, { ocr }) };
}

export function envFor(c) {
  const calls = { answer: 0, verify: 0, synthesis: 0, prompts: [] };
  const drafts = Array.isArray(c.draft) ? c.draft : [c.draft];
  const env = brainEnv({ rows: c.rows || [], coverageRows: c.coverage || COVERAGE_COMPLETE() });
  env.BRAIN_OWNER = "Owner Example"; env.BRAIN_TIMEZONE = "America/Phoenix";
  Object.assign(env, c.env || {});
  env.AI = { run: async (model, input) => {
    if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    calls.attempts = (calls.attempts || 0) + 1;
    if (c.aiThrows) throw new Error(c.aiThrows);
    const system = String(input?.messages?.[0]?.content || "");
    if (/verify each synthesis item/.test(system)) { calls.synthesis++;
      return { response: JSON.stringify(c.synthesisVerdict || { items: [] }), usage: {} }; }
    if (/verify a proposed answer/.test(system)) { calls.verify++;
      return { response: c.verdict || { supported: true, complete: true, evidence: c.cites || [1], reason: "the cited record states it", conflicts: [] }, usage: {} }; }
    const text = drafts[Math.min(calls.answer, drafts.length - 1)]; calls.answer++;
    calls.prompts.push(String(input?.messages?.[1]?.content || "").slice(0, 6000));
    return { response: text ?? "", usage: {} };
  } };
  if (c.readiness) {
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => { const s = prepare(sql); const first = s.first;
      s.first = async () => /vector_projection_mutation_id AS mutation_id/.test(sql) ? c.readiness : first(); return s; };
  }
  if (c.vectorCount !== undefined) env.VECTORIZE.describe = async () => ({ vectorCount: c.vectorCount, processedUpToMutation: null });
  return { env, calls };
}
export async function post(env, path, body) {
  const r = await worker.fetch(new Request("https://b.example" + path, { method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const t = await r.text();
  try { const j = JSON.parse(t); delete j.timing; return j; } catch { return { http_status: r.status, raw: t.slice(0, 400) }; }
}
