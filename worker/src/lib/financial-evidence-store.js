import { assertFinancialContract, canonicalFinancialJson, financialHash, resolveFinancialCell, verifyFinancialSnapshot } from './financial-snapshot-contract.js';
import { financialError } from './financial-money.js';

const utf8 = new TextEncoder();
function boundedJson(value) {
  const json = canonicalFinancialJson(value);
  if (utf8.encode(json).length > 1048576) throw financialError('storage_bound');
  return json;
}
function opaque(value) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw financialError('reference_invalid');
  return value;
}
async function scopeHash(snapshot) {
  return financialHash(canonicalFinancialJson({ source_id: snapshot.source_id, scope: snapshot.scope,
    source_kind: snapshot.source_kind, report_name: snapshot.report.returned_name, reporting_type: snapshot.report.reporting_type }));
}
async function verifyRawBytes(snapshot, raw) {
  if (await financialHash(raw) !== snapshot.raw_payload_hash || raw.length !== snapshot.coverage.byte_count) throw financialError('raw_hash');
  let offset = 0;
  for (const page of snapshot.coverage.pages) {
    if (await financialHash(raw.subarray(offset, offset + page.byte_count)) !== page.payload_hash) throw financialError('raw_hash');
    offset += page.byte_count;
  }
  if (offset !== raw.length) throw financialError('raw_hash');
}
async function sealFinding(input) {
  const finding = structuredClone(input);
  finding.content_hash = '0'.repeat(64);
  assertFinancialContract('finding', finding);
  const { content_hash: ignored, ...payload } = finding;
  finding.content_hash = await financialHash(canonicalFinancialJson(payload));
  return finding;
}

// Internal seam, deliberately not an HTTP route. All dependencies are trusted
// server adapters; grant/custody/map checks must never come from request JSON.
// db.batch must provide D1's all-or-nothing transaction semantics.
export function createFinancialEvidenceStore({ db, authorize, readSource, readMapHead } = {}) {
  if (!db?.prepare || !db?.batch || [authorize, readSource, readMapHead].some(value => typeof value !== 'function')) throw financialError('access_unavailable');
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  async function access(snapshot, action, current) {
    const request = { tenant: snapshot.scope.tenant, entity_ref: snapshot.scope.entity_ref,
      source_id: snapshot.source_id, source_doc_ref: snapshot.source_document_ref, action };
    if (await authorize(request) !== true) throw financialError('access_denied');
    const source = await readSource({ tenant: request.tenant, source_id: request.source_id, source_doc_ref: request.source_doc_ref });
    if (!source || source.available !== true || source.source_id !== snapshot.source_id ||
      source.source_doc_ref !== snapshot.source_document_ref || source.raw_payload_hash !== snapshot.raw_payload_hash) throw financialError('source_unavailable');
    if (current && await readMapHead({ tenant: request.tenant }) !== snapshot.scope.owner_map_head) throw financialError('map_stale');
  }
  async function head(snapshot) {
    return statement('SELECT snapshot_id,content_hash,generation FROM financial_snapshot_heads WHERE tenant_id=? AND scope_hash=?',
      snapshot.scope.tenant, await scopeHash(snapshot)).first();
  }
  async function journalData(snapshot, implementationSha, eventKind) {
    const values = [snapshot.scope.tenant, snapshot.snapshot_id, eventKind, implementationSha, snapshot.observed_at,
      snapshot.raw_payload_hash, canonicalFinancialJson({ content_hash: snapshot.content_hash, owner_map_head: snapshot.scope.owner_map_head, supersedes: snapshot.supersedes })];
    const eventHash = await financialHash(canonicalFinancialJson(values));
    return { values, eventHash };
  }
  async function journal(snapshot, implementationSha, eventKind) {
    const { values, eventHash } = await journalData(snapshot, implementationSha, eventKind);
    return statement(`INSERT INTO financial_run_events
      (tenant_id,snapshot_id,event_kind,implementation_sha,observed_at,input_hash,dependencies_json,event_hash)
      SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM financial_run_events WHERE tenant_id=? AND event_hash=?)`,
    ...values, eventHash, snapshot.scope.tenant, eventHash);
  }
  async function verifyPublication(snapshot, implementationSha) {
    const { values, eventHash } = await journalData(snapshot, implementationSha, 'published');
    const row = await statement(`SELECT tenant_id,snapshot_id,event_kind,implementation_sha,observed_at,input_hash,dependencies_json
      FROM financial_run_events WHERE tenant_id=? AND event_hash=?`, snapshot.scope.tenant, eventHash).first();
    if (!row || canonicalFinancialJson([row.tenant_id, row.snapshot_id, row.event_kind, row.implementation_sha,
      row.observed_at, row.input_hash, row.dependencies_json]) !== canonicalFinancialJson(values)) throw financialError('readback_mismatch');
  }
  async function readSnapshotRecord({ tenant, snapshot_id, current = true }, requirePublication = true) {
    opaque(tenant); opaque(snapshot_id);
    if (typeof current !== 'boolean') throw financialError('reference_invalid');
    const row = await statement('SELECT payload_json,raw_bytes FROM financial_snapshots WHERE tenant_id=? AND snapshot_id=?', tenant, snapshot_id).first();
    if (!row) throw financialError('source_unavailable');
    const snapshot = JSON.parse(row.payload_json);
    await verifyFinancialSnapshot(snapshot);
    if (snapshot.scope.tenant !== tenant || snapshot.snapshot_id !== snapshot_id) throw financialError('snapshot_binding');
    await access(snapshot, 'read', current);
    const raw = row.raw_bytes instanceof ArrayBuffer ? new Uint8Array(row.raw_bytes) : new Uint8Array(row.raw_bytes);
    await verifyRawBytes(snapshot, raw);
    if (current) {
      const latest = await head(snapshot);
      if (!latest || latest.snapshot_id !== snapshot_id || latest.content_hash !== snapshot.content_hash || latest.generation !== snapshot.generation) throw financialError('snapshot_stale');
    }
    if (requirePublication) {
      const publication = await statement(`SELECT implementation_sha FROM financial_run_events
        WHERE tenant_id=? AND snapshot_id=? AND event_kind='published' AND input_hash=? AND dependencies_json=?
        ORDER BY event_hash LIMIT 1`, tenant, snapshot_id, snapshot.raw_payload_hash,
      canonicalFinancialJson({ content_hash: snapshot.content_hash, owner_map_head: snapshot.scope.owner_map_head, supersedes: snapshot.supersedes })).first();
      if (!publication) throw financialError('readback_mismatch');
      await verifyPublication(snapshot, publication.implementation_sha);
    }
    await access(snapshot, 'read', current);
    return snapshot;
  }
  const readSnapshot = input => readSnapshotRecord(input);
  async function readCitation({ tenant, citation, current = true }) {
    assertFinancialContract('citation', citation);
    const snapshot = await readSnapshot({ tenant, snapshot_id: citation.snapshot_id, current });
    return { snapshot, ...resolveFinancialCell(snapshot, citation) };
  }
  async function publishSnapshot({ snapshot: input, rawBytes, implementationSha }) {
    // Clone before the first await: caller mutations cannot change the object
    // after validation while asynchronous custody checks are in progress.
    const snapshot = structuredClone(input);
    if (!(rawBytes instanceof Uint8Array) || !rawBytes.length || rawBytes.length > 524288) throw financialError('storage_bound');
    const raw = rawBytes.slice();
    if (typeof implementationSha !== 'string' || !/^[a-f0-9]{40}$/.test(implementationSha)) throw financialError('implementation_sha');
    await verifyFinancialSnapshot(snapshot);
    await access(snapshot, 'write', true);
    if (snapshot.coverage.state !== 'complete_for_report_scope') {
      await (await journal(snapshot, implementationSha, 'incomplete')).run();
      throw financialError('coverage_incomplete');
    }
    await verifyRawBytes(snapshot, raw);
    const payload = boundedJson(snapshot), scope = await scopeHash(snapshot), tenant = snapshot.scope.tenant;
    const existing = await statement('SELECT payload_json FROM financial_snapshots WHERE tenant_id=? AND snapshot_id=?', tenant, snapshot.snapshot_id).first();
    if (existing) {
      if (existing.payload_json !== payload) throw financialError('immutable_conflict');
      const saved = await readSnapshotRecord({ tenant, snapshot_id: snapshot.snapshot_id }, false);
      await (await journal(snapshot, implementationSha, 'published')).run();
      await verifyPublication(snapshot, implementationSha);
      return saved;
    }
    await (await journal(snapshot, implementationSha, 'started')).run();
    const statements = [
      statement(`INSERT INTO financial_snapshots
        (tenant_id,snapshot_id,scope_hash,generation,content_hash,source_id,source_doc_ref,previous_snapshot_id,previous_content_hash,payload_json,raw_bytes)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM financial_snapshots WHERE tenant_id=? AND snapshot_id=?)`,
      tenant, snapshot.snapshot_id, scope, snapshot.generation, snapshot.content_hash, snapshot.source_id, snapshot.source_document_ref,
      snapshot.supersedes?.snapshot_id ?? null, snapshot.supersedes?.content_hash ?? null, payload, raw, tenant, snapshot.snapshot_id),
      statement(`INSERT INTO financial_snapshot_heads (tenant_id,scope_hash,snapshot_id,content_hash,generation) VALUES (?,?,?,?,?)
        ON CONFLICT(tenant_id,scope_hash) DO UPDATE SET snapshot_id=excluded.snapshot_id,content_hash=excluded.content_hash,generation=excluded.generation
        WHERE financial_snapshot_heads.generation=excluded.generation-1 AND financial_snapshot_heads.snapshot_id=? AND financial_snapshot_heads.content_hash=?`,
      tenant, scope, snapshot.snapshot_id, snapshot.content_hash, snapshot.generation, snapshot.supersedes?.snapshot_id ?? null, snapshot.supersedes?.content_hash ?? null),
      await journal(snapshot, implementationSha, 'published'),
    ];
    try {
      const result = await db.batch(statements);
      if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row.success !== true)) throw financialError('storage_incomplete');
      const saved = await readSnapshot({ tenant, snapshot_id: snapshot.snapshot_id });
      if (canonicalFinancialJson(saved) !== payload) throw financialError('readback_mismatch');
      await verifyPublication(snapshot, implementationSha);
      return saved;
    } catch (error) {
      // A timeout may have committed. The next attempt checks exact bytes and
      // head; neither the journal nor a successful HTTP response substitutes.
      await (await journal(snapshot, implementationSha, 'incomplete')).run();
      throw financialError(error?.code || 'storage_incomplete');
    }
  }
  function findingCitations(finding) {
    return [finding.left, finding.right].flatMap(side => [...side.citations, ...(side.search_receipt ? [side.search_receipt.citation] : [])])
      .concat(finding.candidate_sets.flat());
  }
  async function findingAccess(finding, action, current) {
    if (await authorize({ tenant: finding.scope.tenant, entity_ref: finding.scope.entity_ref, source_id: null, source_doc_ref: null, action }) !== true) throw financialError('access_denied');
    if (current && await readMapHead({ tenant: finding.scope.tenant }) !== finding.scope.owner_map_head) throw financialError('map_stale');
    for (const citation of findingCitations(finding)) {
      const { snapshot } = await readCitation({ tenant: finding.scope.tenant, citation, current });
      if (canonicalFinancialJson(snapshot.scope) !== canonicalFinancialJson(finding.scope)) throw financialError('scope_mismatch');
    }
    for (const side of [finding.left, finding.right]) {
      if (side.value !== null) {
        // An aggregate must cite its own verified report/derived cell. Several
        // citations alone do not authorize summing overlapping evidence.
        if (side.citations.length !== 1) throw financialError('finding_value_mismatch');
        const { cell } = await readCitation({ tenant: finding.scope.tenant, citation: side.citations[0], current });
        if (canonicalFinancialJson(cell.money) !== canonicalFinancialJson(side.value)) throw financialError('finding_value_mismatch');
      }
      if (side.search_receipt) {
        const { snapshot, cell } = await readCitation({ tenant: finding.scope.tenant, citation: side.search_receipt.citation, current });
        // V1 can prove whole-report absence only. A filtered zero-match search
        // needs a separately reviewed search-receipt adapter, not a caller's
        // match_count pasted onto a nonempty report.
        if (!snapshot.report.no_report_data || cell.money?.amount_minor !== '0' ||
          canonicalFinancialJson(snapshot.coverage) !== canonicalFinancialJson(side.search_receipt.coverage)) throw financialError('absence_unproved');
      }
    }
  }
  async function readFinding({ tenant, finding_id, current = true }) {
    opaque(tenant); opaque(finding_id);
    if (typeof current !== 'boolean') throw financialError('reference_invalid');
    const row = await statement('SELECT payload_json FROM financial_findings WHERE tenant_id=? AND finding_id=?', tenant, finding_id).first();
    if (!row) throw financialError('source_unavailable');
    const finding = JSON.parse(row.payload_json), sealed = await sealFinding(finding);
    if (finding.scope.tenant !== tenant || finding.finding_id !== finding_id || sealed.content_hash !== finding.content_hash) throw financialError('finding_hash');
    await findingAccess(finding, 'read', current);
    return finding;
  }
  async function publishFinding(input) {
    const finding = await sealFinding(input), payload = boundedJson(finding), tenant = finding.scope.tenant;
    await findingAccess(finding, 'write', true);
    await statement(`INSERT INTO financial_findings (tenant_id,finding_id,content_hash,payload_json)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM financial_findings WHERE tenant_id=? AND finding_id=?)`,
    tenant, finding.finding_id, finding.content_hash, payload, tenant, finding.finding_id).run();
    const saved = await readFinding({ tenant, finding_id: finding.finding_id });
    if (canonicalFinancialJson(saved) !== payload) throw financialError('immutable_conflict');
    return saved;
  }
  return Object.freeze({ publishSnapshot, readSnapshot, readCitation, publishFinding, readFinding });
}
