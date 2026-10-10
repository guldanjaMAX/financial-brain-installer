/**
 * Read-only B02/B03/B09 matching seam over authorized immutable R1 snapshots.
 * Hashes bind bytes, not source authority: resolveSnapshot must recheck current
 * source custody, grants and the owner map, as the financial evidence store does.
 * This module has no provider, database-write, clock or credential dependency.
 */
import { booksCandidateComponents } from './books-candidate-graph.js';
import { assertFinancialContract, canonicalFinancialJson, financialHash, verifyFinancialSnapshot,
  validFinancialDate } from './financial-snapshot-contract.js';
import { assertMoney, financialError, moneyFromMinor } from './financial-money.js';

const POLICY = 'books-match-1';
const REPORT = 'BooksTransactions';
const MAX_RECORDS = 500;
const DAY = 86400000;
const nullableFields = new Set(['reference', 'linked_entity_id', 'linked_line_id', 'transfer_ref']);
const dateNumber = date => Date.parse(`${date}T00:00:00.000Z`);
const shiftDate = (date, days) => new Date(dateNumber(date) + days * DAY).toISOString().slice(0, 10);
const same = (a, b) => canonicalFinancialJson(a) === canonicalFinancialJson(b);
const identity = row => canonicalFinancialJson([row.native_entity_id, row.native_line_id]);
const ref = snapshot => ({ snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash });
const ordered = rows => [...rows].sort((a, b) => a.key.localeCompare(b.key));

function cite(snapshot, row) {
  return { schema_version: 'financial-citation-1', ...ref(snapshot), source_id: snapshot.source_id,
    source_doc_ref: snapshot.source_document_ref, row_path: row.row_path, column_key: 'amount',
    native_entity_id: row.native_entity_id, native_entity_version: row.native_entity_version, native_line_id: row.native_line_id };
}

function records(snapshot, scope, side) {
  if (snapshot.rows.length > MAX_RECORDS) throw financialError('books_record_bound');
  const active = new Map(), excluded = [];
  for (const row of snapshot.rows) {
    if (row.kind !== 'detail') continue;
    if (!row.native_entity_id || !row.native_entity_version || row.group_ref?.kind !== 'account' ||
        !scope.account_filter.includes(row.group_ref.id)) throw financialError('books_identity_unproved');
    const cells = new Map(row.cells.map(cell => [cell.column_key, cell]));
    const text = name => {
      const cell = cells.get(name);
      if (nullableFields.has(name) && cell?.state === 'blank' && cell.raw_text === '') return null;
      if (cell?.state !== 'value' || cell.kind !== (name === 'posted_on' ? 'date' : 'text') ||
          typeof cell.text !== 'string' || !cell.text.length || cell.text !== cell.raw_text) throw financialError('books_field_unavailable');
      return cell.text;
    };
    const amount = cells.get('amount');
    if (amount?.kind !== 'money' || amount.state !== 'value') throw financialError('books_amount_unavailable');
    const value = assertMoney(amount.money, { exact: true });
    const record = { key: identity(row), version: row.native_entity_version, side, account_ref: row.group_ref.id,
      posted_on: text('posted_on'), direction: text('direction'), reference: text('reference'),
      linked_entity_id: text('linked_entity_id'), linked_line_id: text('linked_line_id'),
      transfer_ref: text('transfer_ref'), state: text('record_state'), value,
      citations: [cite(snapshot, row)] };
    if (!validFinancialDate(record.posted_on) || record.posted_on < snapshot.scope.period_start ||
        record.posted_on > snapshot.scope.period_end || !['inflow', 'outflow'].includes(record.direction) ||
        amount.role !== record.direction || value.currency !== scope.presentation_currency || BigInt(value.amount_minor) < 0n ||
        (!record.linked_entity_id && record.linked_line_id) || !['settled', 'pending', 'removed', 'superseded'].includes(record.state)) {
      throw financialError('books_record_invalid');
    }
    record.link = record.linked_entity_id === null ? null : canonicalFinancialJson([record.linked_entity_id, record.linked_line_id]);
    if (record.state !== 'settled') { excluded.push({ reason: record.state, record }); continue; }
    const previous = active.get(record.key);
    if (previous) {
      // An identical provider identity/version replay is not another amount.
      // Conflicting active versions are an incomplete inventory, never last-wins.
      const withoutCitations = r => ({ ...r, citations: [] });
      if (!same(withoutCitations(previous), withoutCitations(record))) throw financialError('books_identity_conflict');
      previous.citations.push(...record.citations);
    } else active.set(record.key, record);
  }
  for (const record of active.values()) record.citations.sort((a, b) => a.row_path.localeCompare(b.row_path));
  return { active: ordered([...active.values()]), excluded };
}

function comparable(a, b) {
  return a.account_ref === b.account_ref && a.direction === b.direction && a.value.currency === b.value.currency;
}
function near(a, b) { return Math.abs(dateNumber(a.posted_on) - dateNumber(b.posted_on)) <= 3 * DAY; }
function heuristic(a, b) {
  if (!comparable(a, b) || !near(a, b)) return false;
  if (a.reference !== null && b.reference !== null && a.reference !== b.reference) return false;
  const documented = a.reference !== null && a.reference === b.reference;
  return documented || a.value.amount_minor === b.value.amount_minor ? (documented ? 'reference' : 'identity_unproved') : false;
}
function linkState(a, b) {
  const points = a.link === b.key || b.link === a.key;
  if (!points) return false;
  return comparable(a, b) && (a.link === null || a.link === b.key) && (b.link === null || b.link === a.key)
    ? 'linked' : 'link_conflict';
}
function pairKind(a, b) {
  if (a.value.amount_minor !== b.value.amount_minor) return 'amount_mismatch';
  return a.posted_on === b.posted_on ? 'exact_unique' : 'timing_candidate';
}
function difference(a, b) {
  return moneyFromMinor(BigInt(a.value.amount_minor) - BigInt(b.value.amount_minor), a.value.currency);
}

function scopeCompatible(snapshot, scope, side) {
  if (snapshot.source_kind !== (side === 'quickbooks' ? 'quickbooks_report' : 'bank_report') ||
      snapshot.report.returned_name !== REPORT || snapshot.report.reporting_type !== 'period') throw financialError('books_report_unproved');
  for (const key of Object.keys(scope)) {
    if (['period_start', 'period_end', 'as_of', 'report_parameters'].includes(key)) continue;
    if (!same(snapshot.scope[key], scope[key])) throw financialError('books_scope_mismatch');
  }
  if (snapshot.scope.period_start > scope.period_start || snapshot.scope.period_end < scope.period_end) throw financialError('books_scope_mismatch');
}
function complete(snapshot, scope) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: scope.company_timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(snapshot.observed_at));
  const part = type => parts.find(p => p.type === type).value;
  const observedDate = `${part('year')}-${part('month')}-${part('day')}`;
  return snapshot.coverage.state === 'complete_for_report_scope' && snapshot.coverage.mutation_check.state === 'stable' &&
    snapshot.scope.period_start <= shiftDate(scope.period_start, -3) && snapshot.scope.period_end >= shiftDate(scope.period_end, 3) &&
    snapshot.scope.period_end < observedDate;
}

function transferAllocation(group) {
  const all = [...group.left, ...group.right];
  if (!all.some(r => r.transfer_ref !== null)) return null;
  const validLegs = rows => rows.length === 2 && rows[0].account_ref !== rows[1].account_ref &&
    rows[0].direction !== rows[1].direction && rows[0].value.amount_minor === rows[1].value.amount_minor &&
    BigInt(rows[0].value.amount_minor) > 0n && near(rows[0], rows[1]);
  if (new Set(all.map(r => r.transfer_ref)).size !== 1 || all[0].transfer_ref === null ||
      !validLegs(group.left) || !validLegs(group.right)) return { classification: 'transfer_incomplete', allocations: [] };
  const allocations = [];
  for (const a of group.left) {
    const candidates = group.right.filter(b => comparable(a, b) && near(a, b) &&
      (linkState(a, b) === 'linked' || (!a.link && !b.link && heuristic(a, b) === 'reference')));
    if (candidates.length !== 1 || a.value.amount_minor !== candidates[0].value.amount_minor) {
      return { classification: 'transfer_incomplete', allocations: [] };
    }
    allocations.push({ quickbooks: a.citations, bank: candidates[0].citations, value: a.value,
      classification: pairKind(a, candidates[0]) });
  }
  return { classification: 'transfer_allocation', allocations };
}

/** All inputs are internal R1 references; resolver authority must not come from request JSON. */
export async function matchBooksSnapshots(input, { resolveSnapshot } = {}) {
  if (typeof resolveSnapshot !== 'function') throw financialError('access_unavailable');
  const { scope } = input;
  assertFinancialContract('scope', scope);
  for (const key of ['entity_ref', 'owner_map_head', 'company_fingerprint', 'basis', 'presentation_currency',
    'company_timezone', 'class_filter', 'department_filter', 'account_filter', 'transaction_currencies']) {
    if (scope[key] === null) throw financialError('books_scope_unknown');
  }
  if (!scope.account_filter.length) throw financialError('books_account_map_required');
  const snapshots = {}, sets = {};
  let checked = 0;
  for (const side of ['quickbooks', 'bank']) {
    assertFinancialContract('snapshot_ref', input[side]);
    const snapshot = structuredClone(await resolveSnapshot(input[side]));
    checked++;
    await verifyFinancialSnapshot(snapshot);
    if (!same(ref(snapshot), input[side])) throw financialError('books_snapshot_binding');
    scopeCompatible(snapshot, scope, side);
    snapshots[side] = snapshot;
    sets[side] = records(snapshot, scope, side);
    checked += snapshot.rows.length;
  }
  const qbo = sets.quickbooks.active, bank = sets.bank.active;
  // A declared or incoming link reserves a record against weaker guesses.
  // All competing explicit links still remain together in one component.
  const qboTargets = new Set(bank.filter(r => r.link).map(r => r.link));
  const bankTargets = new Set(qbo.filter(r => r.link).map(r => r.link));
  const reserved = r => r.link !== null || (r.side === 'quickbooks' ? qboTargets : bankTargets).has(r.key);
  const graph = booksCandidateComponents(qbo, bank, (a, b) => {
    const link = linkState(a, b);
    if (link) return link;
    if (a.transfer_ref !== null && a.transfer_ref === b.transfer_ref) return 'transfer';
    if (reserved(a) || reserved(b)) return false;
    return heuristic(a, b);
  }, (a, b) => {
    if (a.transfer_ref !== null && a.transfer_ref === b.transfer_ref) return 'transfer';
    if (reserved(a) && reserved(b)) return false;
    return comparable(a, b) && near(a, b) && a.value.amount_minor === b.value.amount_minor && a.reference === b.reference
      ? 'duplicate_candidate' : false;
  });
  const excluded = [...sets.quickbooks.excluded, ...sets.bank.excluded];
  const completeSearch = complete(snapshots.quickbooks, scope) && complete(snapshots.bank, scope) && !excluded.length &&
    snapshots.quickbooks.observed_at === snapshots.bank.observed_at && snapshots.quickbooks.generation === snapshots.bank.generation &&
    same(snapshots.quickbooks.coverage.mutation_check, snapshots.bank.coverage.mutation_check);
  const groups = [], boundaryOnly = [];
  for (const group of graph) {
    const all = [...group.left, ...group.right];
    // Margin records participate in matching, but a wholly out-of-period
    // component is not an alleged missing transaction in the requested period.
    if (!all.some(r => r.posted_on >= scope.period_start && r.posted_on <= scope.period_end)) {
      boundaryOnly.push(...all.map(record => ({ reason: 'search_margin_only', record })));
      continue;
    }
    const result = { classification: null, evidence_state: 'candidate', quickbooks: group.left, bank: group.right,
      difference: null, allocations: [], absence_receipt: null,
      candidate_edges: group.edges.map(e => ({ from: e.left.citations[0], to: e.right.citations[0], reason: e.reason })) };
    const transfer = transferAllocation(group);
    if (transfer) {
      Object.assign(result, transfer);
      if (transfer.classification === 'transfer_incomplete') result.evidence_state = 'incomplete';
    } else if (group.left.length && group.right.length) {
      if (group.left.length !== 1 || group.right.length !== 1) result.classification = 'ambiguous_candidates';
      else {
        const a = group.left[0], b = group.right[0];
        const reason = group.edges[0].reason;
        if (reason === 'identity_unproved' || reason === 'link_conflict') {
          result.classification = reason; result.evidence_state = 'incomplete';
        } else {
          result.classification = pairKind(a, b);
          result.difference = difference(a, b);
          if (result.classification === 'exact_unique') result.evidence_state = 'exact';
        }
      }
    } else if (all.length > 1) result.classification = 'possible_duplicates';
    else {
      const present = all[0], opposite = present.side === 'quickbooks' ? 'bank' : 'quickbooks';
      result.classification = `${present.side === 'quickbooks' ? 'qbo' : 'bank'}_only`;
      result.evidence_state = 'incomplete';
      // Allocation to a stronger link does not make a weaker candidate vanish.
      // Absence is over the whole opposite inventory, not remaining free rows.
      const oppositeCandidates = sets[opposite].active.filter(other => linkState(present, other) || heuristic(present, other));
      if (completeSearch && present.link === null && oppositeCandidates.length === 0) {
        // A receipt cites the present row and the actual opposite inventory,
        // never a fabricated absent transaction. Verification reruns the search.
        const predicate = { policy_version: POLICY, scope, present: present.citations[0],
          quickbooks: ref(snapshots.quickbooks), bank: ref(snapshots.bank) };
        result.absence_receipt = { schema_version: 'books-match-search-1', ...predicate,
          predicate_hash: await financialHash(canonicalFinancialJson(predicate)),
          search_start: snapshots[opposite].scope.period_start, search_end: snapshots[opposite].scope.period_end,
          opposite_side: opposite, opposite_coverage: snapshots[opposite].coverage,
          searched_record_count: sets[opposite].active.length, match_count: 0 };
        result.evidence_state = 'complete_search';
      }
    }
    groups.push(result);
  }
  groups.sort((a, b) => canonicalFinancialJson(a).localeCompare(canonicalFinancialJson(b)));
  return { schema_version: POLICY, checked, scope: structuredClone(scope),
    status: !completeSearch || groups.some(g => g.evidence_state === 'incomplete') ? 'incomplete'
      : groups.every(g => g.classification === 'exact_unique') ? 'checks_completed' : 'needs_review',
    groups, excluded, boundary_only: boundaryOnly, financial_authority: false, mutated_source_records: false };
}

/** Re-resolve both current snapshots and recompute, accepting no asserted zero. */
export async function verifyBooksAbsenceReceipt(receipt, dependencies) {
  if (receipt?.schema_version !== 'books-match-search-1' || receipt.policy_version !== POLICY) throw financialError('absence_receipt_version');
  const result = await matchBooksSnapshots({ scope: receipt.scope, quickbooks: receipt.quickbooks, bank: receipt.bank }, dependencies);
  if (!result.groups.some(group => group.absence_receipt && same(group.absence_receipt, receipt))) throw financialError('absence_receipt_mismatch');
  return { ok: true, checked: result.checked };
}
