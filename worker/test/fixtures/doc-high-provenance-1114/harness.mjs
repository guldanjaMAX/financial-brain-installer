// Document-answer probe harness (read-only against the hunt worktree).
// Drives the REAL Worker /api/rag/think route over real in-memory SQLite with
// the shipped migrations and ingest. Only the answer model, the verifier and
// the vector provider are scripted. Synthetic data only; network forbidden.
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
process.env.PRODUCT_CONTRACT_ROOT = ROOT;
const imp = p => import(pathToFileURL(`${ROOT}/${p}`).href);
const { createProductFixture } = await imp('worker/test/product-contract-fixture.mjs');
const { finalizeDocumentAnswer } = await imp('worker/src/lib/document-answer.js');
const { handleMcp } = await imp('worker/src/lib/mcp-endpoint.js');

export const DOC_NOW = Date.parse('2026-11-12T19:00:00Z');
export const prose = body => String(body.answer || '').split('\n\nCoverage:')[0];

// probe.docs: [{key, source, title, content, occurred_at, date_reliable=true, uri, top_folder}]
// probe.draft: string with {key} placeholders replaced by the citation number the
// Worker assigned to that document in the real prompt.
export async function runRoute(probe) {
  const realNow = Date.now;
  Date.now = () => DOC_NOW;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  const stages = [];
  let promptMap = null, draftSent = null, verifierInput = null;
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: 'UTC',
    ADMIN_KEY: randomBytes(24).toString('hex'), SESSION_SIGNING_KEY: randomBytes(32).toString('hex'),
    AI: { async run(model, input) {
      if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
      const all = JSON.stringify(input.messages);
      const verify = all.includes('verify a proposed answer');
      stages.push(verify ? 'verifier' : 'draft');
      if (verify) {
        verifierInput = all.slice(0, 400);
        const cited = [...new Set([...String(draftSent || '').matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))];
        return { response: { supported: true, complete: true, evidence: cited, reason: 'synthetic approval' } };
      }
      // Map source name -> citation number from the real prompt listing.
      const text = input.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      promptMap = {};
      const entries = [...text.matchAll(/\[(\d+)\] \(([^\n]*?)\) ([^\n]*)/g)].map(m => ({ n: Number(m[1]), meta: m[2], title: m[3] }));
      for (const d of probe.docs.filter(x => x.retrieve !== false)) {
        const hit = entries.find(e => e.meta.startsWith(d.source) && e.meta.includes(String(d.occurred_at).slice(0, 10)));
        if (hit) promptMap[d.key] = hit.n;
      }
      draftSent = probe.draft.replace(/\{([^}]+)\}/g, (_, key) => {
        const n = promptMap[key];
        return n ? `[${n}]` : `[99]`;
      });
      return { response: draftSent };
    } } } });
  try {
    const sources = [...new Set(probe.docs.map(d => d.source))];
    for (const s of sources) f.raw(`INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds)
      VALUES (?,'upload','ready',?,?,?,86400)`, s, new Date(DOC_NOW).toISOString(), new Date(DOC_NOW).toISOString(), new Date(DOC_NOW).toISOString());
    const headers = { 'X-Admin-Key': f.env.ADMIN_KEY };
    const ingested = await f.post('/api/admin/brain/ingest/batch', { docs: probe.docs.map(d => ({
      source_type: d.source, source_id: `record-${d.key}`, title: d.title, content: d.content,
      occurred_at: d.occurred_at, date_source: 'fixture:recorded_at', date_reliable: d.date_reliable !== false,
      text_source: 'native', text_reliable: true,
      ...(d.uri ? { uri: d.uri } : {}),
      metadata: { evidence_lineage: { version: 1, kind: 'source_record' }, ...(d.top_folder ? { top_folder: d.top_folder } : {}) } })) }, headers);
    if (ingested.status !== 200) throw new Error(`ingest failed ${ingested.status} ${await ingested.text()}`);
    f.raw('DELETE FROM vector_outbox');
    const count = f.first('SELECT COUNT(*) AS n FROM chunks').n;
    f.raw("UPDATE install_state SET vector_projection_status='verified',vector_projection_bootstrap_base_count=? WHERE id=1", count);
    f.env.VECTORIZE.describe = async () => ({ vectorCount: count, processedUpToMutation: null });
    const hidden = probe.docs.filter(d => d.retrieve === false).map(d => `${d.source}:record-${d.key}`);
    f.env.VECTORIZE.query = async () => ({ matches: f.rows('SELECT chunk_uid AS id, doc_uid FROM chunks ORDER BY document_date DESC')
      .filter(r => !hidden.includes(r.doc_uid)).map(r => ({ id: r.id })) });
    const response = await f.post('/api/rag/think', { q: probe.question }, headers);
    const body = await response.json();
    // Remote MCP ask renders the same body for the owner.
    const url = new URL('https://fixture.invalid/mcp');
    let remoteText = null;
    try {
      const remote = await (await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
        method: 'tools/call', params: { name: 'ask', arguments: { question: probe.question } } }) }), url, { think: async () => body })).json();
      remoteText = (remote.result?.content || []).map(c => c.text || '').join('\n');
    } catch (e) { remoteText = `remote error: ${e.message}`; }
    const remoteConfidence = (remoteText || '').match(/Confidence: \w+ \(\d+%\)/)?.[0] || null;
    return {
      status: response.status, full_reads: f.seen.sql.filter(sql => sql.includes('LIMIT 501')).length, stages, promptMap, draft: draftSent,
      answer:body.answer, contract:body.answer_contract,
      rung: body.answer_contract?.rung, kind: body.answer_contract?.kind,
      percent: body.confidence?.percent, band: body.confidence?.band,
      confidence_text: body.confidence_text, prose: prose(body),
      gaps: (body.gaps || []).map(g => g.type), evidence_gate: body.evidence_gate,
      citations: (body.citations || []).map(c => ({ n: c.n, title: c.title, source: c.source, ts: c.ts, tier: c.authority?.tier })),
      remote_confidence: remoteConfidence,
      remote_has_prose: remoteText ? remoteText.includes(prose(body).slice(0, 60)) : false,
      basis: body.confidence?.basis, missing: body.confidence?.missing,
    };
  } finally { f.close(); Date.now = realNow; globalThis.fetch = realFetch; }
}

// Direct finalizer with the same evidence shape the Worker builds.
export function runDirect(probe, { authority = { tier: 'T1', rank: 1, eligible: true, authoritative: true } } = {}) {
  const visible = probe.docs.filter(d => d.retrieve !== false);
  const docs = visible.map((d, i) => ({ n: i + 1, title: d.title, source: d.source,
    snippet: `[${d.title}]\n\n${d.content}`.replace(/\s+/g, ' '), ts: d.occurred_at, date_reliable: d.date_reliable !== false,
    uri:d.uri || null, top_folder:d.top_folder || null,
    text_source: 'native', text_reliable: true, read_complete: true, authority,
    lineage: { status: 'known', family_tokens: [`independent-${d.key}`] } }));
  const draft = probe.draft.replace(/\{([^}]+)\}/g, (_, key) => `[${visible.findIndex(d => d.key === key) + 1}]`);
  const cited = new Set([...draft.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])));
  const approve = { supported: true, complete: true, evidence: [...cited], reason: 'synthetic approval' };
  const body = finalizeDocumentAnswer({ question: probe.question, draft, docs, approvedDocs: docs.filter(d => cited.has(d.n)),
    checks: [approve], searchComplete: true, asOf:new Date(DOC_NOW).toISOString().slice(0,10) });
  return { rung: body.answer_contract.rung, percent: body.confidence.percent, band: body.confidence.band,
    answer:body.answer, contract:body.answer_contract, prose: prose(body), confidence_text: body.confidence_text };
}
