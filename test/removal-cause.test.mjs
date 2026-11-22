import { currentPartsFixture } from './helpers/current-sync-fixture.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let ambientAttempts = 0;
globalThis.fetch = async () => { ambientAttempts++; throw new Error('Ambient network is forbidden'); };
globalThis.die = message => { throw new Error(message); };
const calendar = await import('../connectors/google-calendar.mjs');
const gmail = await import('../connectors/gmail.mjs');
const { syncMicrosoftGraph } = await import('../connectors/microsoft-graph.mjs');
const { buildDriveRemovalPlan, DriveRemovalReviewRequired } = await import('../operations/drive-removal-plan.mjs');
const { createIngestRemovalReview, removalDigest } = await import('../operations/ingest-removal-plan.mjs');
const { runLoadRemovalLeg, removalReviewFacts, canAutoApplyRemoval, removalOwnerSentence } = await import('../operations/load-removal-review.mjs');
const { markCalendarCancellations } = await import('../operations/calendar-cancellations.mjs');
const ingest = await import('../ingest/run.mjs');
const { credentialScannerFingerprint } = await import('../brain.mjs');
const brain = readFileSync(new URL('../brain.mjs', import.meta.url), 'utf8');
const excerpt = (start, end) => {
  const first = brain.indexOf(start);
  const last = brain.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'the real command branch must exist');
  return brain.slice(first, last);
};
const {sourceModuleHarness} = await import('./helpers/source-module-harness.mjs');
// VM scripts cannot dynamically import without an experimental Node flag.
// Resolve only this module seam to the already imported, real connector;
// leave the command and all of its finalization branches intact.
const sourceHarness = await sourceModuleHarness(new URL('../brain.mjs',import.meta.url), {
  source: brain.replaceAll('await import("./connectors/gmail.mjs")', '__gmailModule'),
});
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const cliModule = (bindings, expression) => sourceHarness({ Date: FixtureDate, __gmailModule: gmail, ...bindings }, expression);
const branch = (code,async=false) => cliModule({ process: { stdout: { write() {} } } },`(${async?'async ':''}function(scope){with(scope){${code}\n}})`).result;
// Calendar refresh no longer has a removal branch. Exercise the whole command
// runner so a newly reachable review cannot hide outside a hand-picked excerpt.
const calendarOutput = [];
const { result: calendarRun } = cliModule({
  info: line => calendarOutput.push(line), warn: line => calendarOutput.push(line), ok: line => calendarOutput.push(line),
  ingestLib: async () => ingest,
  ingestRemovalReview() { throw new Error('Calendar refresh reached removal review'); },
}, 'cmdIngestCalendarRun');
const { runProviderConnector } = await import('../connectors/provider-runtime.mjs');
const providerReview = branch(`return (${excerpt('      reviewRemovals: async ({ uids, targetCauses,', '\n      },\n    });').trim().replace(/^reviewRemovals: /, '')}\n});`);
const secret = randomBytes(24).toString('hex');
const providerText = ['UNTRUSTED', 'PROVIDER', 'DETAIL'].join('_');
const providerFailure = { error: { message: `${providerText} ${secret}` } };
const fixtureRoot = mkdtempSync(join(tmpdir(), 'removal-cause-'));
const manifestPath = join(fixtureRoot, 'fixture.manifest.json');
const keyFile = join(fixtureRoot, '.brain-admin-key');
const launchctl = join(fixtureRoot, 'launchctl-fixture');
writeFileSync(keyFile, secret, { mode: 0o600 });
writeFileSync(manifestPath, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' },
  corpora: { gmail: { enabled: true } } }));
writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
process.on('exit', () => rmSync(fixtureRoot, { recursive: true, force: true }));
const retainedIds = Array.from({ length: 99 }, (_, i) => `retained-${i}`);
const targetId = 'subject-item';
const allIds = [...retainedIds, targetId];
const rows = [];

function removalFixture(id, kind, identities) {
  const stored = new Set(identities);
  const state = { done: Object.fromEntries(identities.map(uid => [uid, 'revision-one'])), skipped: {} };
  let marker = { instance: 'fixture-instance', runtime: 'fixture-runtime', nonce: 'fixture-before', generation: 1 };
  const counters = { preview: 0, apply: 0, saved: 0, applyBoundary: 0, runs: 0, finish: 0 };
  const previewControl = { error: null, invalid: false };
  let saved = null;
  const saveState = () => {
    if (state.ingest_removal_plan) {
      counters.saved++;
      saved = structuredClone(state.ingest_removal_plan);
      const { fingerprint, ...payload } = saved;
      assert.equal(removalDigest(payload), fingerprint);
    }
  };
  const review = createIngestRemovalReview({ state, source: kind, kind,
    manifest: { corpora: { [kind]: { enabled: true } } }, manifestPath: 'fixture/manifest.json',
    base: 'https://fixture.invalid', adminKey: secret, saveState,
    runtime: () => 'fixture-runtime', now: () => NOW,
    request: async ({ body }) => {
      counters[body.action]++;
      if (body.marker) assert.deepEqual(body.marker, marker);
      if (body.action === 'preview') {
        if (previewControl.error) throw previewControl.error;
        if (previewControl.invalid) return {};
        const targets = body.families.map(item => item.base_doc_uid).filter(uid => stored.has(uid)).sort();
        return { marker, targets, documents: targets.length, excluded_documents: 0 };
      }
      assert.equal(body.action, 'apply');
      assert.ok(saved?.targets.length > 0, 'the saved nonempty decision precedes every synthetic write');
      for (const uid of body.targets) assert.equal(stored.delete(uid), true);
      marker = { ...marker, generation: marker.generation + 1, nonce: 'fixture-after' };
      return { documents: body.targets.length, marker };
    },
  });
  return { stored, state, counters, saveState, review, previewControl, saved: () => saved,
    finish: async plan => { counters.finish++; return review.finish({ sourcePlan: plan }); },
    apply: async flags => {
      counters.applyBoundary++;
      assert.equal(flags.from, kind);
      assert.equal(flags.source, kind);
      assert.equal(flags['apply-removals'], saved.fingerprint);
      return review.apply(flags['apply-removals'], undefined, { automatic: true });
    },
  };
}

async function exercise({ id, kind, fixture, run, expected, observations }) {
  let failure = null;
  let result;
  try {
    result = await runLoadRemovalLeg({ kind, source: kind, dryRun: false,
      run: async () => { fixture.counters.runs++; return run(); }, apply: fixture.apply });
  } catch (error) { failure = error; }
  if (failure?.code === 'ERR_ASSERTION') throw failure;
  const saved = fixture.saved();
  if (saved) {
    assert.deepEqual(Object.keys(saved.targetCauses).sort(), saved.targets);
    assert.ok(Object.values(saved.targetCauses).every(cause => [
      'explicit_deletion', 'window_exit', 'scope_or_filter_change',
      'blank_or_quality', 'permission_or_visibility', 'unknown',
    ].includes(cause)));
    if (expected === 'auto') assert.ok(Object.values(saved.targetCauses).every(cause => cause === 'explicit_deletion'));
  }
  if (expected === 'auto') {
    assert.equal(failure, null);
    assert.equal(fixture.counters.apply, 1);
    assert.equal(fixture.counters.applyBoundary, 1);
    assert.equal(fixture.counters.runs, 2);
    assert.equal(fixture.stored.size, 99);
    assert.equal(result.auto_applied_removals[0].readback, 'passed');
    assert.ok(saved?.targets.length > 0);
  } else {
    assert.equal(fixture.counters.apply, 0);
    assert.equal(fixture.counters.applyBoundary, 0);
    assert.equal(fixture.counters.runs, 1);
    assert.equal(fixture.stored.size, 100);
    if (expected === 'held' || expected === 'reviewed') {
      if (expected === 'reviewed') {
        assert.ok(failure === null, 'a proved Gmail owner review never blocks the next refresh');
        assert.ok(saved?.targets.length > 0, 'the nonblocking decision reached a nonempty saved plan');
      } else {
        assert.ok(failure instanceof DriveRemovalReviewRequired, `${id}: expected a proved owner review`);
        assert.ok(saved?.targets.length > 0, 'the rejection reached a real nonempty saved plan');
        assert.equal(canAutoApplyRemoval(removalReviewFacts(failure.removal_review, kind), kind, kind), false);
      }
    } else if (expected === 'error') {
      assert.ok(failure, 'the provider or guard decision must throw');
      assert.notEqual(failure.code, 'ERR_ASSERTION', 'a test assertion is never a provider failure');
    } else assert.ok(failure === null, `${id}: command completes`);
  }
  const observed = observations(failure);
  if (expected === 'error' && kind === 'gmail') assert.equal(observed.commandFailureReached, true);
  assert.ok(observed.providerCalls > 0 || observed.guardRefused, 'negative outcomes must reach the intended decision');
  if (observed.witness) {
    assert.equal(observed.witness.exists, true);
    // Reviewed Gmail recovery has mailbox and stored-proof passes, each bounded
    // to metadata plus body for this identity; it cannot grow with the corpus.
    assert.ok(observed.subjectLookups > 0 && observed.subjectLookups <= 2 * 2, `${id}: stored safety work is bounded to the current identity (${observed.subjectLookups})`);
    assert.equal(observed.tombstones, 0, 'the missing target had no deletion notification');
    assert.equal(observed.witnessCalls, 1, 'the independent fixture existence check ran');
  }
  const row = { id, kind, expected, ...fixture.counters,
    planned: saved?.targets.length || 0, storedAfter: fixture.stored.size,
    reasons: saved?.sourcePlan.counts || null,
    hasPerTargetCause: Boolean(saved?.targetCauses && saved?.sourcePlan?.targetCauses),
    causes: saved ? Object.values(saved.targetCauses) : [],
    failureType: failure?.name || null,
    heldOwnerClaimsDeletion: failure instanceof DriveRemovalReviewRequired
      ? removalOwnerSentence(removalReviewFacts(failure.removal_review, kind)).includes('deleted') : false,
    ...observed };
  if (id === 'microsoft-aged-out' || id === 'microsoft-blanked') {
    assert.equal(row.heldOwnerClaimsDeletion, false);
    if (expected === 'held') assert.match(removalOwnerSentence(removalReviewFacts(failure.removal_review, kind)), armText(id));
    else assert.equal(failure, null, 'window aging completes without removal review');
    assert.equal(observed.tombstones, 0);
  }
  rows.push(row);
  console.log(`PASS ${id}: provider=${observed.providerCalls} planned=${row.planned} apply=${row.apply} outcome=${expected}`);
}

const armText = id => id.endsWith('aged-out') ? /synced window/ : /searchable content/;

function event(id) {
  return { id, status: 'confirmed', summary: 'Synthetic event',
    start: { dateTime: '2026-11-02T09:00:00Z' }, end: { dateTime: '2026-11-02T10:00:00Z' } };
}

async function calendarCase(arm, expected) {
  calendarOutput.length = 0;
  const id = `calendar-${arm}`;
  const fixture = removalFixture(id, 'calendar', allIds.map(value =>
    `calendar:${calendar.sourceIdFor(arm === 'shared-config-removed' && value === targetId ? 'shared' : 'primary', value)}`));
  const config = { calendars: [{ id: 'primary', key: 'primary' }], maxRetries: 0 };
  if (arm === 'sibling-provider-error') config.calendars.push({ id: 'shared', key: 'shared' });
  if (arm === 'window-floor') config.fullSyncSince = '2026-11-01T00:00:00Z';
  if (arm === 'event-type-scope') config.eventTypes = ['default'];
  let providerCalls = 0, itemCalls = 0, tombstones = 0, documents = 0, skipped = 0, failedCalendars = 0, authoritative = false;
  let markingDecisions = 0, markerWrites = 0, removalCalls = 0, cursorSaves = 0;
  const cancelledIds = new Set();
  const run = async () => {
    let page = 0;
    const result = await calendar.syncAll({ config, state: fixture.state,
      getAccessToken: async () => secret, now: () => NOW, sleep: async () => {},
      fetchImpl: async input => {
        providerCalls++; page++;
        const url = new URL(input);
        if (arm === 'sibling-provider-error' && url.pathname.endsWith('/calendars/shared/events')) {
          return Response.json(providerFailure, { status: 403 });
        }
        assert.ok(url.pathname.endsWith('/calendars/primary/events'));
        if (arm === 'window-floor') assert.equal(url.searchParams.get('timeMin'), config.fullSyncSince.replace('Z', '.000Z'));
        if (['permission-403', 'shared-404', 'provider-503'].includes(arm)) {
          return Response.json(providerFailure, { status: Number(arm.slice(-3)) });
        }
        if (arm === 'partial-page-error' && page === 2) return Response.json(providerFailure, { status: 503 });
        if (arm === 'malformed-page') return Response.json({ items: {} });
        const deletionArm = ['deleted', 'partial-no-token', 'partial-page-error', 'tombstone-actor-unknown', 'sibling-provider-error'].includes(arm);
        const items = deletionArm ? [{ id: targetId, status: 'cancelled' }]
          : ['blanked', 'visibility-redacted'].includes(arm) ? [{ ...event(targetId), summary: '' }]
          : ['retained', 'shared-config-removed'].includes(arm) ? [event(targetId)] : [];
        tombstones += items.filter(item => item.status === 'cancelled').length;
        if (arm === 'partial-page-error') return Response.json({ items, nextPageToken: 'fixture-next-page' });
        if (arm === 'partial-no-token') return Response.json({ items });
        return Response.json({ items, nextSyncToken: 'fixture-next-sync' });
      },
    });
    documents = result.documents.length; skipped = result.summary.skipped;
    failedCalendars = result.calendars.filter(item => !item.ok).length;
    authoritative = result.calendars.every(item => item.authoritative_snapshot === true);
    if (['permission-403', 'shared-404', 'provider-503', 'malformed-page', 'partial-page-error', 'sibling-provider-error'].includes(arm)) {
      assert.equal(failedCalendars, 1, 'the provider failure was observed');
    }
    if (arm === 'partial-no-token') assert.equal(authoritative, false);
    if (['blanked', 'visibility-redacted'].includes(arm)) assert.equal(skipped, 1);
    const receipts = [];
    const options = {
      launchctl,
      resolveBaseUrl: async () => 'https://fixture.invalid', resolveAdminKey: () => readFileSync(keyFile, 'utf8'),
      getAccessToken: async () => secret, loadCalendarState: () => fixture.state,
      saveCalendarState: (_path, state) => { cursorSaves++; assert.deepEqual(state, result.state); },
      googleCalendar: { syncAll: async () => result,
        ingestEnvelopes: async ({ envelopes }) => ({ created: 0, updated: 0,
          unchanged: envelopes.length, errors: [], refused: [] }) },
      markCalendarCancellations: async args => { markingDecisions++; return markCalendarCancellations(args); },
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (url.pathname !== '/api/admin/brain/calendar-cancellation') {
          removalCalls++;
          throw new Error('Calendar refresh reached a non-marker write');
        }
        assert.equal(url.origin, 'https://fixture.invalid');
        const body = JSON.parse(init.body);
        assert.equal(body.source, 'calendar');
        assert.ok(fixture.stored.has(`calendar:${body.source_id}`), 'marker targets a retained stored event');
        markerWrites++; cancelledIds.add(body.source_id);
        return Response.json({ ...body, verified: true, action: 'kept_cancelled' });
      },
      listStoredSourceFamilies: async () => { removalCalls++; return fixture.stored; },
      removalPlanRequest: async () => { removalCalls++; throw new Error('Calendar removal review reached'); },
      postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt),
    };
    const outcome = await calendarRun({ brain: { domain: 'fixture.invalid' }, calendar: config },
      'fixture/manifest.json', {}, options,
      { sourceName: 'calendar', dry: false, statePath: join(fixtureRoot, id, 'state.json'), assertLockOwned() {} });
    assert.equal(markingDecisions, 1, 'the real add-only completion decision was reached');
    assert.equal(outcome.removed, 0);
    assert.equal(outcome.removalPending, 0);
    assert.equal(outcome.cancelled, result.deletions.length);
    assert.deepEqual([...cancelledIds].sort(), result.deletions.map(item => item.source_id).sort());
    assert.equal(markerWrites, result.deletions.length, 'cancellations are kept and marked, other arms stay unmarked');
    assert.equal(removalCalls, 0);
    assert.equal(fixture.counters.preview, 0);
    assert.equal(fixture.counters.finish, 0);
    assert.equal(fixture.state.ingest_removal_plan, undefined);
    assert.equal(cursorSaves, 1, 'accepted cancellation markers never hold the sync position for removal');
    assert.equal(receipts.at(-1).status, result.ok ? 'ready' : 'error');
    const publicOutput = [...calendarOutput, JSON.stringify(receipts)].join('\n');
    assert.equal(publicOutput.includes(secret), false, 'Calendar never prints a provider credential');
    assert.equal(publicOutput.includes(providerText), false, 'Calendar never prints provider free text');
    if (!result.ok) {
      assert.ok(calendarOutput.some(line => line.includes('Code: INGEST_FAILED') && line.includes('Help: https://')));
    }
    return { completed: result.ok };
  };
  if (arm === 'shared-config-removed') fixture.state.shared = { sync_token: 'fixture-prior-sync' };
  await exercise({ id, kind: 'calendar', fixture, run, expected,
    observations: () => ({ providerCalls, itemCalls, tombstones, documents, skipped, failedCalendars, authoritative,
      markingDecisions, markerWrites, removalCalls, cursorSaves }) });
}

async function gmailCase(arm, expected) {
  const id = `gmail-${arm}`;
  const fixture = removalFixture(id, 'gmail', allIds.map(value => `gmail:${value}`));
  const fullArms = new Set(['retained', 'full-complete-pages', 'full-label-exclusion', 'full-date-floor', 'full-visibility-subset',
    'full-missing-page-token', 'full-limited', 'full-page-error', 'full-malformed-page',
    'full-permission-403', 'full-provider-503', 'full-empty-body', 'full-profile-error', 'full-omitted-messages']);
  const full = fullArms.has(arm);
  const since = ['full-date-floor', 'incremental-date-floor'].includes(arm) ? '2026-11-01' : null;
  let providerCalls = 0, listCalls = 0, itemCalls = 0, subjectLookups = 0, tombstones = 0, guardRefused = false;
  let providerFailures = 0;
  const providerRejection = status => { providerFailures++; return Response.json(providerFailure, { status }); };
  let sourcePlanCalls = 0, lastQuery = null, witnessMode = false, witnessCalls = 0, witness = null;
  if (arm === 'preview-error') fixture.previewControl.error = new Error(providerFailure.error.message);
  if (arm === 'preview-invalid') fixture.previewControl.invalid = true;
  // Reviewed Gmail restore proof must accompany the 99 already accepted controls.
  // The changed target is deliberately unproved so every policy arm still reads it.
  const parts = currentPartsFixture();
  const scanner = credentialScannerFingerprint(false);
  const policy = gmail.gmailPolicyFingerprint({ since, credentialScannerFingerprint: scanner });
  fixture.state.credential_scanner_fingerprint = scanner;
  fixture.state.gmail_policy_fingerprint = policy;
  for (const item of retainedIds) {
    const envelope = { source_type: 'gmail', source_id: item, content: 'Synthetic accepted control.' };
    parts.accept(envelope);
    fixture.state.gmail_accepted_parts ||= {};
    fixture.state.gmail_accepted_parts[`gmail:${item}`] = { ...await parts.read({ source: 'gmail', envelopes: [envelope] }),
      revision: 'revision-one', policy_fingerprint: policy };
  }
  fixture.state.history_id = 'fixture-history-before';
  if (arm === 'full-empty-body') delete fixture.state.done[`gmail:${targetId}`];
  const fetchImpl = async input => {
    if (witnessMode) witnessCalls++;
    else providerCalls++;
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith('/profile')) {
      if (arm === 'full-profile-error') return providerRejection(503);
      return Response.json({ historyId: 'fixture-history-current' });
    }
    if (path.endsWith('/history')) {
      if (url.searchParams.get('startHistoryId') === 'fixture-history-current') return Response.json({ history: [], historyId: 'fixture-history-current' });
      if (arm === 'expired-history-label-exclusion' && url.searchParams.get('startHistoryId') !== 'fixture-history-current') return Response.json({ error: { message: 'Synthetic expired history' } }, { status: 404 });
      if (arm === 'incremental-page-error' && url.searchParams.has('pageToken')) return providerRejection(503);
      if (['deleted', 'preview-error', 'preview-invalid', 'incremental-page-error'].includes(arm)) {
        tombstones++;
        return Response.json({ history: [{ messagesDeleted: [{ message: { id: targetId } }] }],
          ...(arm === 'incremental-page-error' ? { nextPageToken: 'fixture-page' } : { historyId: 'fixture-history-current' }) });
      }
      return Response.json({ history: [{ labelsAdded: [{ message: { id: targetId } }] }], historyId: 'fixture-history-current' });
    }
    if (path.endsWith('/messages')) {
      listCalls++;
      lastQuery = url.searchParams.get('q');
      if (arm === 'full-date-floor') assert.ok(lastQuery.includes('after:2026/11/01'));
      if (['full-permission-403', 'full-provider-503'].includes(arm)) return providerRejection(Number(arm.slice(-3)));
      if (arm === 'full-page-error' && url.searchParams.has('pageToken')) return providerRejection(503);
      if (arm === 'full-malformed-page') { providerFailures++; return Response.json({ messages: {} }); }
      if (arm === 'full-omitted-messages') return Response.json({ resultSizeEstimate: 99 });
      if (arm === 'full-complete-pages') return Response.json(url.searchParams.has('pageToken')
        ? { messages: [{ id: targetId }], resultSizeEstimate: 100 }
        : { messages: retainedIds.map(value => ({ id: value })), resultSizeEstimate: 100, nextPageToken: 'fixture-next-page' });
      const visible = ['retained', 'full-empty-body', 'full-limited'].includes(arm) ? allIds : retainedIds;
      return Response.json({ messages: visible.map(value => ({ id: value })), resultSizeEstimate: 100,
        ...(arm === 'full-page-error' ? { nextPageToken: 'fixture-next-page' } : {}) });
    }
    assert.ok(path.includes('/messages/'));
    if (!witnessMode) itemCalls++;
    const messageId = path.split('/').at(-1);
    if (!witnessMode && messageId === targetId) subjectLookups++;
    if (arm === 'item-404') return Response.json({ error: { message: 'Synthetic missing item' } }, { status: 404 });
    if (messageId !== targetId) return Response.json({ id: messageId, labelIds: ['INBOX'], internalDate: String(NOW), raw: '' });
    if (['item-403', 'item-410', 'item-503'].includes(arm)) return providerRejection(Number(arm.slice(-3)));
    if (arm === 'missing-labels') return Response.json({ id: messageId });
    if (['incremental-label-exclusion', 'full-label-exclusion', 'expired-history-label-exclusion'].includes(arm)) return Response.json({ id: messageId, labelIds: ['CATEGORY_PROMOTIONS'] });
    if (['incremental-date-floor', 'full-date-floor'].includes(arm)) return Response.json({ id: messageId, labelIds: ['INBOX'], internalDate: String(NOW - 86400000) });
    // Empty raw body is deliberate: no optional parser executes in this lane.
    return Response.json({ id: messageId, labelIds: ['INBOX'], internalDate: String(NOW), raw: '' });
  };
  const opts = { fetchImpl, attempts: 1, sleep: async () => {} };
  if (['full-label-exclusion', 'full-date-floor', 'full-visibility-subset', 'full-missing-page-token', 'expired-history-label-exclusion'].includes(arm)) {
    witnessMode = true;
    const policy = await gmail.messagePolicy(async () => secret, targetId, { ...opts, since });
    assert.notEqual(policy.source_deleted, true);
    witness = { exists: true, policyExcluded: policy.policy_skip === true, allowed: policy.allowed };
    witnessMode = false;
  }
  const adapter = {
    currentHistoryId: token => gmail.currentHistoryId(token, opts),
    listHistory: (token, history) => gmail.listHistory(token, history, opts),
    listMessages: (token, input) => gmail.listMessages(token, { ...input, opts }),
    listMessagePage: (token, input) => gmail.listMessagePage(token, { ...input, opts }),
    messagePolicy: (token, item, input) => gmail.messagePolicy(token, item, { ...input, ...opts }),
    toEnvelope: (token, item, input) => gmail.toEnvelope(token, item, input, opts),
  };
  const output = [], receipts = [];
  let lockChecks = 0, finalizations = 0, completedWindows = 0, commandFailure = null;
  if (full) fixture.state.gmail_policy_fingerprint = 'fixture-prior-policy';
  // Run the complete command: the source branch only stages a plan. The real
  // finalizer runs after checkpoint settlement and keeps proved reviews open
  // without making new mail wait for an owner removal decision.
  const { result: gmailRun } = cliModule({
    info: line => output.push(line), warn: line => output.push(line), ok: line => output.push(line),
    console: { log: (...args) => output.push(args.join(' ')), warn: (...args) => output.push(args.join(' ')) },
    process: { stdout: { write: line => output.push(line) } },
    readGmailCheckpointState: () => ({ verified: true,
      done: Object.keys(fixture.state.done).length, skipped: Object.keys(fixture.state.skipped).length,
      cursorPresent: Boolean(fixture.state.history_id), cursor: fixture.state.history_id || null }),
    ingestRemovalReview: () => ({ ...fixture.review,
      finish: async ({ sourcePlan } = {}) => {
        finalizations++;
        if (sourcePlan) sourcePlanCalls++;
        return fixture.finish(sourcePlan);
      } }),
  }, 'cmdIngestRemote');
  const options = {
    gmail: adapter, readCurrentIngestParts: parts.read, ingestNowMs: () => NOW,
    launchctl,
    withSourceIngestLock: async (_options, task) => task({ assertOwned: () => { lockChecks++; } }),
    resolveBaseUrl: async () => 'https://fixture.invalid', resolveAdminKey: () => readFileSync(keyFile, 'utf8'),
    getAccessToken: async () => secret,
    ingestLib: async () => ({ ...ingest, loadState: () => fixture.state,
      saveState: () => fixture.saveState() }),
    listStoredSourceFamilies: async ({ uids, singlePage }) => singlePage
      ? { families: new Set(fixture.stored), nextCursor: null }
      : new Set([...fixture.stored].filter(uid => !uids || uids.includes(uid))),
    listOwnerRemovedFamilies: async () => new Set(),
    postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt),
    sendBatches: async () => { throw new Error('Unexpected document batch in removal-only harness'); },
  };
  const run = async () => {
    let outcome;
    // Let the real command persist every bounded window, rather than advancing
    // its cursor by hand and omitting the final review/receipt boundary.
    for (let window = 0; window < 32; window++) {
      const lookupsBefore = subjectLookups;
      const flags = { from: 'gmail', source: 'gmail', ...(arm === 'full-limited' ? { limit: '99' } : {}) };
      try {
        outcome = await gmailRun({ brain: { domain: 'fixture.invalid' },
          corpora: { gmail: { enabled: true, ...(since ? { since } : {}) } },
          safety: { credential_scanner: { enabled: false }, ocr: { enabled: false } } },
        manifestPath, flags, options);
      } catch (error) {
        commandFailure = error;
        if (arm === 'full-limited') guardRefused = true;
        throw error;
      }
      assert.ok(subjectLookups - lookupsBefore <= 2,
        'each reached Gmail window bounds the current identity to metadata plus body');
      completedWindows++;
      if (!outcome.more_history || fixture.state.gmail_retry) break;
      if (window === 31) throw new Error('fixture continuation did not make progress');
    }
    assert.ok(lockChecks > 0 && finalizations > 0, 'the real completion and review decisions were reached');
    assert.equal(finalizations, completedWindows, 'every completed window reaches its finalizer');
    assert.equal(outcome.pending_removals, Object.keys(fixture.state.gmail_owner_removals || {}).length);
    if (expected === 'reviewed') {
      assert.ok(sourcePlanCalls > 0, 'an exact source plan reached the real nonblocking finalizer');
      assert.deepEqual(fixture.saved().targets, [`gmail:${targetId}`]);
      assert.ok(fixture.saved()?.targets.length > 0);
      assert.equal(fixture.state.history_id, 'fixture-history-current', 'owner review does not freeze the cursor');
      assert.equal(receipts.at(-1).status, 'ready');
      assert.equal(receipts.at(-1).complete_sweep, false, 'pending review cannot certify full coverage');
      assert.ok(output.some(line => line.includes('kept') || line.includes('Kept')));
    }
    assert.ok(!output.join('\n').includes(secret), 'no credential reaches command output');
    return outcome;
  };
  await exercise({ id, kind: 'gmail', fixture, run, expected,
    observations: failure => ({ providerCalls, listCalls, itemCalls, subjectLookups, tombstones, guardRefused, sourcePlanCalls,
      commandFailureReached: Boolean(commandFailure && failure === commandFailure),
      witnessCalls, witness, queryHasDateFloor: Boolean(lastQuery?.includes('after:')),
      queryExcludesLabels: Boolean(lastQuery?.includes('-category:promotions')) }) });
  const publicOutput = [...output, commandFailure?.ownerMessage || commandFailure?.message || '', JSON.stringify(receipts)].join('\n');
  assert.equal(publicOutput.includes(secret), false, 'no key reaches any command output or receipt');
  assert.equal(publicOutput.includes(providerText), false, 'provider free text never reaches output or receipts');
  if (expected === 'error') {
    assert.ok(providerFailures > 0 || guardRefused || fixture.counters.preview > 0,
      'the injected provider fault, limit guard or failed preview was reached');
    assert.match(commandFailure.message, /Gmail/);
    assert.match(commandFailure.message, /Code: [A-Z_]+/);
    assert.match(commandFailure.message, /Help: https:\/\//);
    assert.equal(commandFailure.ownerMessage, commandFailure.message, 'the CLI renders the fixed public message');
    assert.equal(commandFailure.supportCode, 'INGEST_FAILED');
    if (arm.startsWith('preview-')) {
      assert.equal(fixture.counters.preview, 1, 'the failed authenticated preview decision was reached');
      assert.equal(sourcePlanCalls, 1);
      assert.equal(fixture.saved(), null, 'an unproved preview cannot create an owner approval');
      assert.equal(receipts.at(-1).status, 'error', 'a failed preview never becomes ready');
    }
  }
  if (fixture.saved()) {
    const cause = ['deleted', 'item-404'].includes(arm) ? 'explicit_deletion'
      : ['incremental-label-exclusion', 'incremental-date-floor', 'full-label-exclusion', 'full-date-floor', 'expired-history-label-exclusion'].includes(arm) ? 'scope_or_filter_change' : 'unknown';
    assert.equal(fixture.saved().targetCauses[`gmail:${targetId}`], cause);
  }
}

async function microsoftCase(arm, expected) {
  const id = `microsoft-${arm}`;
  const workload = arm.startsWith('mail-') ? 'message' : 'event';
  const fixture = removalFixture(id, 'microsoft', allIds.map(value => `microsoft:outlook:${workload}:${value}`));
  const graph = 'https://graph.microsoft.com/v1.0';
  let providerCalls = 0, tombstones = 0, calendarCalls = 0;
  const cursor = { mail: { inbox: `${graph}/me/mailFolders/inbox/messages/delta?fixture=prior` }, drives: {},
    calendar: { delta_link: `${graph}/me/calendarView/delta?fixture=prior`,
      window_start: arm === 'aged-out' ? '2026-10-01T00:00:00.000Z' : '2026-10-02T00:00:00.000Z',
      window_end: arm === 'aged-out' ? '2027-01-29T00:00:00.000Z' : '2027-01-30T00:00:00.000Z',
      id_type: 'immutable', event_ids: allIds } };
  const graphEvent = value => ({ id: value, subject: 'Synthetic event',
    start: { dateTime: '2026-11-02T09:00:00', timeZone: 'UTC' },
    end: { dateTime: '2026-11-02T10:00:00', timeZone: 'UTC' },
    body: { contentType: 'text', content: 'Synthetic event body.' } });
  const run = async () => {
    const result = await syncMicrosoftGraph({ accessToken: secret, cursor, now: () => NOW,
      mailFolderIds: ['inbox'], driveIds: [], siteIds: [], includePersonalDrive: false,
      fetchImpl: async input => {
        providerCalls++;
        const url = new URL(input);
        if (url.pathname.includes('mailFolders')) {
          const removed = ['mail-deleted', 'mail-changed'].includes(arm);
          const value = removed ? [{ id: targetId, '@removed': { reason: arm === 'mail-deleted' ? 'deleted' : 'changed' } }]
            : arm === 'mail-retained' ? [{ id: targetId, subject: 'Synthetic message',
              body: { contentType: 'text', content: 'Synthetic message body.' }, receivedDateTime: '2026-11-01T09:00:00Z' }] : [];
          tombstones += removed ? 1 : 0;
          return Response.json({ value, '@odata.deltaLink': `${graph}/me/mailFolders/inbox/messages/delta?fixture=next` });
        }
        assert.equal(url.pathname, '/v1.0/me/calendarView/delta');
        calendarCalls++;
        if (['permission-403', 'provider-503'].includes(arm)) return Response.json({}, { status: Number(arm.slice(-3)) });
        if (arm === 'partial-page-error') return calendarCalls === 1
          ? Response.json({ value: [{ id: targetId, '@removed': { reason: 'deleted' } }],
            '@odata.nextLink': `${graph}/me/calendarView/delta?fixture=partial` })
          : Response.json({}, { status: 503 });
        if (arm === 'expired-history' && calendarCalls === 1) return Response.json({}, { status: 410 });
        const value = ['deleted', 'changed', 'unknown-tombstone'].includes(arm)
          ? [{ id: targetId, '@removed': { reason: arm === 'unknown-tombstone' ? '' : arm } }]
          : ['aged-out', 'expired-history'].includes(arm) ? retainedIds.map(graphEvent)
          : arm === 'blanked' ? [{ ...graphEvent(targetId), subject: '', body: { contentType: 'text', content: '' } }]
          : [graphEvent(targetId)];
        tombstones += value.filter(item => item['@removed']).length;
        return Response.json({ value, '@odata.deltaLink': `${graph}/me/calendarView/delta?fixture=next` });
      },
    });
    assert.equal(result.authoritative_snapshot, false);
    const loadState = async () => ({ cursor, configuration_fingerprint: 'fixture-configuration' });
    const callback = providerReview({ provider: 'microsoft', sourceName: 'microsoft',
      options: { ingestLib: async () => ({ loadState: () => fixture.state, saveState: fixture.saveState }) },
      m: {}, manifestPath: 'fixture/manifest.json', base: 'https://fixture.invalid', adminKey: secret,
      assertLockOwned() {}, loadState, removalDigest, buildDriveRemovalPlan,
      canonicalSourceIngestStatePath: () => 'fixture/state.json',
      ingestRemovalReview: () => fixture.review });
    await runProviderConnector({ provider: 'microsoft', source: 'microsoft', kind: 'microsoft',
      configurationFingerprint: 'fixture-configuration', loadState, saveState() {},
      resolveAccess: async () => ({ accessToken: secret }), sync: async () => result,
      base: 'https://fixture.invalid', adminKey: secret,
      listStoredFamilies: async () => fixture.stored,
      sendBatch: async ({ docs }) => ({ ok: true, results: docs.map(doc => ({
        source_id: doc.source_id, source_type: doc.source_type, status: 'unchanged' })) }),
      postReceipt() {}, reviewRemovals: callback,
      now: () => new Date(NOW) });
    return { completed: true };
  };
  await exercise({ id, kind: 'microsoft', fixture, run, expected,
    observations: () => ({ providerCalls, tombstones }) });
  if (expected === 'held') {
    const cause = ['deleted', 'mail-deleted'].includes(arm) ? 'explicit_deletion'
      : ['changed', 'mail-changed'].includes(arm) ? 'scope_or_filter_change'
      : arm === 'aged-out' ? 'window_exit' : arm === 'blanked' ? 'blank_or_quality' : 'unknown';
    assert.equal(fixture.saved().targetCauses[`microsoft:outlook:${workload}:${targetId}`], cause);
  }
}

if (!process.argv[2] || process.argv[2] === 'calendar') for (const arm of ['deleted', 'retained', 'window-floor', 'event-type-scope', 'blanked',
  'permission-403', 'visibility-omitted', 'visibility-redacted', 'shared-404', 'shared-config-removed',
  'provider-503', 'malformed-page', 'partial-page-error', 'partial-no-token', 'tombstone-actor-unknown', 'sibling-provider-error']) {
  await calendarCase(arm, 'retained');
}
if (!process.argv[2] || process.argv[2] === 'gmail') for (const [arm, expected] of [
  ['deleted', 'reviewed'], ['retained', 'retained'], ['full-complete-pages', 'retained'], ['item-404', 'reviewed'],
  ['full-label-exclusion', 'reviewed'], ['full-date-floor', 'reviewed'], ['full-visibility-subset', 'retained'],
  ['full-missing-page-token', 'retained'], ['expired-history-label-exclusion', 'reviewed'],
  ['incremental-label-exclusion', 'reviewed'], ['incremental-date-floor', 'reviewed'],
  ['full-empty-body', 'retained'], ['incremental-empty-body', 'retained'], ['missing-labels', 'retained'],
  ['item-403', 'error'], ['item-410', 'error'], ['item-503', 'error'],
  ['preview-error', 'error'], ['preview-invalid', 'error'],
  ['full-limited', 'error'], ['full-page-error', 'error'], ['incremental-page-error', 'error'],
  ['full-malformed-page', 'error'], ['full-permission-403', 'error'], ['full-provider-503', 'error'],
  ['full-profile-error', 'error'], ['full-omitted-messages', 'retained'],
]) await gmailCase(arm, expected);
if (!process.argv[2] || process.argv[2] === 'microsoft') for (const arm of ['deleted', 'aged-out', 'blanked', 'retained',
  'changed', 'unknown-tombstone', 'expired-history', 'permission-403', 'provider-503', 'partial-page-error',
  'mail-deleted', 'mail-changed', 'mail-retained']) await microsoftCase(arm,
  arm === 'blanked' ? 'held'
    : ['permission-403', 'provider-503', 'partial-page-error'].includes(arm) ? 'error' : 'retained');

async function repeatedMicrosoftCauses(id, reasons, cause, snapshot) {
  const target = `microsoft:outlook:message:${targetId}`;
  const fixture = removalFixture(id, 'microsoft', allIds.map(value => `microsoft:outlook:message:${value}`));
  let providerCalls = 0, reviews = 0, cursorSaves = 0;
  const folders = ['inbox', 'archive'];
  const run = async () => {
    const result = await syncMicrosoftGraph({ accessToken: secret, now: () => NOW,
      mailFolderIds: folders, driveIds: [], siteIds: [], includePersonalDrive: false, includeCalendar: false,
      cursor: { mail: Object.fromEntries(folders.map(folder =>
        [folder, `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?fixture=prior`])) },
      fetchImpl: async input => {
        providerCalls++;
        const url = new URL(input);
        const folder = url.pathname.match(/\/mailFolders\/([^/]+)\/messages\/delta$/)?.[1];
        assert.ok(folders.includes(folder), 'both configured folder decisions must be reached');
        const reason = reasons[folders.indexOf(folder)];
        return Response.json({ value: [{ id: targetId, '@removed': reason === undefined ? {} : { reason } }],
          '@odata.deltaLink': `${url.origin}${url.pathname}?fixture=next` });
      } });
    assert.equal(result.deletions.length, 0, 'provider observations never request removal');
    assert.equal(result.documents.length, 1, 'the adapter consolidates duplicate status observations');
    assert.equal(result.documents[0].metadata.retained_source_id, `outlook:message:${targetId}`);
    // The common cause-merger and exact owner-removal approval remain tested
    // with explicit owner-requested targets, independent of adapter policy.
    const requested = { ...result, documents: [], deletions: reasons.map(reason => ({
      source_type: 'microsoft', source_id: `outlook:message:${targetId}`,
      removal_cause: reason === 'deleted' ? 'explicit_deletion' : reason === 'changed' ? 'scope_or_filter_change' : 'unknown',
    })) };
    assert.equal(result.authoritative_snapshot, false, 'the adapter fixture must use both existing delta cursors');
    const loadState = async () => ({ cursor: null, configuration_fingerprint: 'fixture-configuration' });
    const callback = providerReview({ provider: 'microsoft', sourceName: 'microsoft',
      options: { ingestLib: async () => ({ loadState: () => fixture.state, saveState: fixture.saveState }) },
      m: {}, manifestPath: 'fixture/manifest.json', base: 'https://fixture.invalid', adminKey: secret,
      assertLockOwned() {}, loadState, removalDigest, buildDriveRemovalPlan,
      canonicalSourceIngestStatePath: () => 'fixture/state.json', ingestRemovalReview: () => fixture.review });
    await runProviderConnector({ provider: 'microsoft', source: 'microsoft', kind: 'microsoft',
      configurationFingerprint: 'fixture-configuration', loadState, saveState() { cursorSaves++; },
      resolveAccess: async () => ({ accessToken: secret }),
      // Exercise the shared runtime's snapshot deduplication as well as the real delta result.
      sync: async () => snapshot ? { ...requested, authoritative_snapshot: true,
        snapshot_source_ids: retainedIds.map(value => `outlook:message:${value}`) } : requested,
      base: 'https://fixture.invalid', adminKey: secret, listStoredFamilies: async () => fixture.stored,
      sendBatch: async () => { throw new Error('This removal-only fixture must not send documents'); },
      postReceipt() {}, reviewRemovals: async input => { reviews++; return callback(input); },
      now: () => new Date(NOW) });
  };
  await exercise({ id, kind: 'microsoft', fixture, run, expected: 'held',
    observations: () => ({ providerCalls, tombstones: providerCalls }) });
  assert.equal(providerCalls, 2);
  assert.equal(reviews, 1);
  assert.equal(cursorSaves, 0);
  assert.deepEqual(fixture.saved().targets, [target], 'duplicate observations must review one physical target');
  assert.equal(fixture.saved().targetCauses[target], cause, id);
  assert.equal(fixture.saved().sourcePlan.targetCauses[target], cause, id);
  assert.equal(rows.at(-1).heldOwnerClaimsDeletion, cause === 'explicit_deletion', id);
  console.log(`PASS ${id}: merged cause=${cause}`);
  return fixture.saved().sourcePlan.fingerprint;
}

if (!process.argv[2] || process.argv[2] === 'microsoft') {
  const failures = [];
  for (const snapshot of [false, true]) {
    const fingerprints = [];
    for (const [id, reasons, cause] of [
      ['matching-deletion-control', ['deleted', 'deleted'], 'explicit_deletion'],
      ['changed-then-deleted', ['changed', 'deleted'], 'unknown'],
      ['deleted-then-changed', ['deleted', 'changed'], 'unknown'],
      ['missing-then-deleted', [undefined, 'deleted'], 'unknown'],
      ['deleted-then-missing', ['deleted', undefined], 'unknown'],
      ['matching-scope-control', ['changed', 'changed'], 'scope_or_filter_change'],
    ]) {
      try {
        const fingerprint = await repeatedMicrosoftCauses(`microsoft-${id}-${snapshot ? 'snapshot' : 'delta'}`,
          reasons, cause, snapshot);
        if (cause === 'unknown') fingerprints.push(fingerprint);
      } catch (error) { failures.push(error); }
    }
    assert.equal(new Set(fingerprints).size, fingerprints.length ? 1 : 0,
      'folder ordering and missing evidence must produce the same conservative source fingerprint');
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} repeated-cause probes failed`);
}

// Automatic arms all preserve. A separate owner-approved exact apply is the
// positive deletion control, so uniformly preserved rows cannot fool the harness.
{
  // Gmail's nonblocking finalizer no longer throws into the load auto-apply
  // leg. Reach the shared writer guard directly with a real, fingerprinted
  // policy plan so restoring that unsafe gate cannot survive the mutation test.
  const control = removalFixture('automatic-policy-control', 'gmail', allIds.map(id => `gmail:${id}`));
  const plan = buildDriveRemovalPlan({ storedFamilies: control.stored,
    policyCandidates: [`gmail:${targetId}`], targetCauses: { [`gmail:${targetId}`]: 'scope_or_filter_change' } });
  await assert.rejects(control.finish(plan), DriveRemovalReviewRequired);
  assert.ok(control.counters.preview > 0 && control.saved().targets.length === 1);
  await assert.rejects(control.review.apply(control.saved().fingerprint, undefined, { automatic: true }), /Automatic removal/);
  assert.equal(control.counters.apply, 0);
  assert.equal(control.stored.size, 100);
  const approved = await control.review.apply(control.saved().fingerprint, plan.fingerprint);
  assert.equal(approved.removed, 1, 'the same policy target can be removed with exact owner approval');
  assert.equal(control.counters.apply, 1);
  assert.equal(control.stored.size, 99);
}
{
  const control = removalFixture('owner-approved-control', 'gmail', allIds.map(id => `gmail:${id}`));
  const plan = buildDriveRemovalPlan({ storedFamilies: control.stored,
    vanishedCandidates: [`gmail:${targetId}`], targetCauses: { [`gmail:${targetId}`]: 'explicit_deletion' } });
  await assert.rejects(control.finish(plan), DriveRemovalReviewRequired);
  assert.ok(control.counters.preview > 0 && control.saved().targets.length === 1);
  const result = await control.review.apply(control.saved().fingerprint);
  assert.equal(result.removed, 1);
  assert.equal(result.readback, 'passed');
  assert.equal(control.stored.size, 99);
  rows.push({ id: 'owner-approved-control', planned: 1, apply: control.counters.apply });
}
assert.equal(ambientAttempts, 0);
assert.ok(rows.some(row => row.planned > 0) && rows.some(row => row.planned === 0));
if (process.argv[2] !== 'microsoft') assert.ok(rows.some(row => row.apply === 1) && rows.some(row => row.apply === 0));
console.log(`TOTAL ${rows.length} safety probes passed; synthetic applies=${rows.reduce((n, row) => n + row.apply, 0)}`);

// Keep the receipt regression in the registered removal-cause suite so both
// test-chain inventories execute it without a separate registration.
if (!process.argv[2] || process.argv[2] === 'gmail') {
  const { test } = await import('node:test');
  const { cmdIngestRemote, postSourceReceipt } = await import('../brain.mjs');
  // Reproducible generated table: vary status, free-text location, opaque material
  // and length independently. Canaries are built at runtime and never printed.
  let seed = 0x1117;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const shapes = ['error', 'nested', 'description', 'message', 'uri', 'ids', 'text',
    'malformed', 'mismatch', 'read-error', 'request-error'];
  const cases = [
    { shape: 'accepted', providerStatus: 403, status: 200 },
    ...Array.from({ length: 33 }, (_, index) => ({
      shape: shapes[index % shapes.length],
      // This probe exercises failed-run receipt handling. Gmail quota
      // responses now reach continuation and have their own regression.
      providerStatus: [401, 403, 502, 503][next() % 4],
      status: [400, 401, 403, 429, 503][next() % 5],
      size: 1 + next() % 257,
      material: next().toString(16),
    })),
    { shape: 'accepted', providerStatus: 503, status: 200 },
  ];

  async function runCase(arm) {
    const root = mkdtempSync(join(tmpdir(), 'receipt-output-'));
    const manifestPath = join(root, 'fixture.manifest.json');
    const keyFile = join(root, '.brain-admin-key');
    const launchctl = join(root, 'launchctl-fixture');
    const statePath = join(root, '.brain-ingest-gmail.json');
    const canary = randomBytes(24).toString('hex');
    const untrusted = [canary, arm.material, 'untrusted'.repeat(arm.size || 1)].join(' ');
    const output = [], receipts = [];
    let providerCalls = 0, receiptCalls = 0, errorReceiptCalls = 0, acceptedReceipts = 0;
    let lockChecks = 0, failure, parserFailures = 0;
    const manifest = { brain: { domain: 'fixture.invalid' },
      corpora: { gmail: { enabled: true } },
      safety: { credential_scanner: { enabled: false }, ocr: { enabled: false } } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(keyFile, canary, { mode: 0o600 });
    writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const scanner = credentialScannerFingerprint(false);
    ingest.saveState(statePath, { version: 1, done: {}, skipped: {}, history_id: 'fixture-prior',
      credential_scanner_fingerprint: scanner,
      gmail_policy_fingerprint: gmail.gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }) });
    const originalLog = console.log, originalWarn = console.warn;
    console.log = console.warn = (...args) => output.push(args.join(' '));
    try {
      await cmdIngestRemote(manifest, manifestPath, { from: 'gmail', source: 'gmail' }, {
        launchctl, ingestNowMs: () => NOW, gmailBatchNow: () => new Date(NOW).toISOString(),
        withSourceIngestLock: async (_options, task) => task({ assertOwned: () => { lockChecks++; } }),
        resolveBaseUrl: async () => 'https://fixture.invalid',
        resolveAdminKey: () => readFileSync(keyFile, 'utf8'),
        getAccessToken: async () => canary,
        gmail: { ...gmail, listHistory: (token, history, options) => gmail.listHistory(token, history, {
          ...options, attempts: 1, sleep: async () => {}, fetchImpl: async () => {
            providerCalls++;
            return Response.json({ error: { message: untrusted, error_description: untrusted,
              errors: [{ reason: untrusted }], request_id: untrusted } }, { status: arm.providerStatus });
          },
        }) },
        listOwnerRemovedFamilies: async () => new Set(),
        postSourceReceipt: async (base, key, receipt) => {
          receipts.push(receipt);
          try {
            const result = await postSourceReceipt(base, key, receipt, async () => {
              receiptCalls++;
              const ack = { source: receipt.source, run_id: receipt.run_id, status: receipt.status };
              if (receipt.status !== 'error') return Response.json(ack);
              errorReceiptCalls++;
              switch (arm.shape) {
                case 'accepted': return Response.json(ack);
                case 'error': return Response.json({ error: untrusted }, { status: arm.status });
                case 'nested': return Response.json({ error: { message: untrusted } }, { status: arm.status });
                case 'description': return Response.json({ error_description: untrusted }, { status: arm.status });
                case 'message': return Response.json({ message: untrusted }, { status: arm.status });
                case 'uri': return Response.json({ error_uri: `https://fixture.invalid/${canary}` }, { status: arm.status });
                case 'ids': return Response.json({ id: untrusted, request_id: untrusted }, { status: arm.status });
                case 'text': return new Response(untrusted, { status: arm.status });
                case 'malformed': return new Response(`{${untrusted}`, { status: arm.status });
                case 'mismatch': return Response.json({ ...ack, source: untrusted }, { status: 200 });
                case 'read-error': return { ok: false, status: arm.status, text: async () => { throw new Error(untrusted); } };
                case 'request-error': throw new Error(untrusted);
                default: assert.fail('unknown generated shape');
              }
            }, { attempts: 1, sleep: async () => {} });
            acceptedReceipts++;
            return result;
          } catch (error) {
            parserFailures++;
            throw error;
          }
        },
      });
    } catch (error) { failure = error; }
    finally {
      console.log = originalLog;
      console.warn = originalWarn;
      rmSync(root, { recursive: true, force: true });
    }
    // Reachability precedes confidentiality: neither early refusal nor omitted
    // error-receipt work can make these negative assertions pass vacuously.
    assert.equal(providerCalls, 1, 'the real provider failure was reached');
    assert.equal(receiptCalls, 2, 'indexing and failure receipt requests were reached');
    assert.equal(errorReceiptCalls, 1, 'the error receipt was attempted');
    assert.ok(lockChecks > 0, 'the source ownership boundary was reached');
    assert.equal(failure?.supportCode, 'INGEST_FAILED', 'the outer public guard was reached');
    assert.equal(failure.ownerMessage, failure.message);
    assert.equal(receipts.at(-1).status, 'error', 'provider failure cannot certify ready');
    assert.equal(receipts.at(-1).walk_complete, false);
    const warnings = output.filter(line => line.includes('error receipt could not be recorded') ||
      line.includes('failure status could not be saved'));
    const accepted = arm.shape === 'accepted';
    assert.equal(parserFailures, accepted ? 0 : 1, 'real receipt parser outcome is observed');
    assert.equal(acceptedReceipts, accepted ? 2 : 1, 'the successful receipt control differs');
    assert.equal(warnings.length, accepted ? 0 : 1, 'failed receipt remains visible exactly once');
    const publicText = [...output, failure.message, failure.ownerMessage, JSON.stringify(receipts)].join('\n');
    assert.equal(publicText.includes(canary), false, 'opaque provider material stays private');
    assert.equal(publicText.includes('untrusted'), false, 'provider free text stays private');
    for (const warning of warnings) {
      assert.match(warning, /Code: INGEST_FAILED\./);
      assert.match(warning, /Help: https:\/\/financialbrain\.ai\/help\/INGEST_FAILED/);
      assert.match(warning, /1\. .+2\. /s, 'failure gives numbered recovery steps');
    }
  }

  for (const [index, arm] of cases.entries()) {
    await test(`receipt output generated case ${index + 1}: ${arm.shape}`, () => runCase(arm));
  }
  test('generated controls differ and ambient transport stays unused', () => {
    assert.equal(cases.filter(arm => arm.shape === 'accepted').length, 2);
    assert.equal(new Set(cases.map(arm => arm.shape)).size, 12);
    assert.equal(ambientAttempts, 0);
  });
}
