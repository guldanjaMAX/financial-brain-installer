import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

let ambientAttempts = 0;
globalThis.fetch = async () => { ambientAttempts++; throw new Error('Ambient network is forbidden'); };
globalThis.die = message => { throw new Error(message); };
const calendar = await import('../connectors/google-calendar.mjs');
const gmail = await import('../connectors/gmail.mjs');
const { syncMicrosoftGraph } = await import('../connectors/microsoft-graph.mjs');
const { buildDriveRemovalPlan, DriveRemovalReviewRequired } = await import('../operations/drive-removal-plan.mjs');
const { createIngestRemovalReview, removalDigest } = await import('../operations/ingest-removal-plan.mjs');
const { runLoadRemovalLeg, removalReviewFacts, canAutoApplyRemoval, removalOwnerSentence } = await import('../operations/load-removal-review.mjs');
const { batchStream, prefetch } = await import('../ingest/run.mjs');
const { assertRemoteLimitSafe, gmailRetryMessageIds } = await import('../brain.mjs');
const brain = readFileSync(new URL('../brain.mjs', import.meta.url), 'utf8');
const excerpt = (start, end) => {
  const first = brain.indexOf(start);
  const last = brain.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'the real command branch must exist');
  return brain.slice(first, last);
};
const clearGmailRetry = new Function('gmailRetryMessageIds', excerpt('function clearGmailRetry(', 'export const sourceCursorCanAdvance') + '\nreturn clearGmailRetry;')(gmailRetryMessageIds);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Execute the actual command branches with injected I/O, preserving the reviewer's probes.
const gmailBranch = new AsyncFunction('scope', `with (scope) {\n${excerpt('    const gmail = options.gmail ??', '  } else {\n    const imap = options.imap')}\n}`);
const calendarRemoval = new AsyncFunction('scope', `with (scope) {\n${excerpt('  if (result.deletions.length && !sent.errors.length && !sent.refused.length) {', '  // Provider-level partial failure is tracked per calendar')}\n}`);
const { runProviderConnector } = await import('../connectors/provider-runtime.mjs');
const providerReview = new Function('scope', `with (scope) { return (${excerpt('      reviewRemovals: async ({ uids, targetCauses,', '\n      },\n    });').trim().replace(/^reviewRemovals: /, '')}\n}); }`);
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const secret = randomBytes(24).toString('hex');
const retainedIds = Array.from({ length: 99 }, (_, i) => `retained-${i}`);
const targetId = 'subject-item';
const allIds = [...retainedIds, targetId];
const rows = [];

function removalFixture(id, kind, identities) {
  const stored = new Set(identities);
  const state = { done: Object.fromEntries(identities.map(uid => [uid, 'revision-one'])), skipped: {} };
  let marker = { instance: 'fixture-instance', runtime: 'fixture-runtime', nonce: 'fixture-before', generation: 1 };
  const counters = { preview: 0, apply: 0, saved: 0, applyBoundary: 0, runs: 0, finish: 0 };
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
  return { stored, state, counters, saveState, review, saved: () => saved,
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
    if (expected === 'held') {
      assert.ok(failure instanceof DriveRemovalReviewRequired);
      assert.ok(saved?.targets.length > 0, 'the rejection reached a real nonempty saved plan');
      assert.equal(canAutoApplyRemoval(removalReviewFacts(failure.removal_review, kind), kind, kind), false);
    } else if (expected === 'error') assert.ok(failure, 'the provider or guard decision must throw');
    else assert.equal(failure, null);
  }
  const observed = observations();
  assert.ok(observed.providerCalls > 0 || observed.guardRefused, 'negative outcomes must reach the intended decision');
  if (observed.witness) {
    assert.equal(observed.witness.exists, true);
    assert.equal(observed.subjectLookups, 0, 'the product did not query the missing target');
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
    assert.match(removalOwnerSentence(removalReviewFacts(failure.removal_review, kind)), armText(id));
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
  const id = `calendar-${arm}`;
  const fixture = removalFixture(id, 'calendar', allIds.map(value =>
    `calendar:${calendar.sourceIdFor(arm === 'shared-config-removed' && value === targetId ? 'shared' : 'primary', value)}`));
  const config = { calendars: [{ id: 'primary', key: 'primary' }], maxRetries: 0 };
  if (arm === 'sibling-provider-error') config.calendars.push({ id: 'shared', key: 'shared' });
  if (arm === 'window-floor') config.fullSyncSince = '2026-11-01T00:00:00Z';
  if (arm === 'event-type-scope') config.eventTypes = ['default'];
  let providerCalls = 0, itemCalls = 0, tombstones = 0, documents = 0, skipped = 0, failedCalendars = 0, authoritative = false;
  const run = async () => {
    let page = 0;
    const result = await calendar.syncAll({ config, state: fixture.state,
      getAccessToken: async () => secret, now: () => NOW, sleep: async () => {},
      fetchImpl: async input => {
        providerCalls++; page++;
        const url = new URL(input);
        if (arm === 'sibling-provider-error' && url.pathname.endsWith('/calendars/shared/events')) {
          return Response.json({ error: { message: 'Synthetic sibling refusal' } }, { status: 403 });
        }
        assert.ok(url.pathname.endsWith('/calendars/primary/events'));
        if (arm === 'window-floor') assert.equal(url.searchParams.get('timeMin'), config.fullSyncSince.replace('Z', '.000Z'));
        if (['permission-403', 'shared-404', 'provider-503'].includes(arm)) {
          return Response.json({ error: { message: 'Synthetic provider refusal' } }, { status: Number(arm.slice(-3)) });
        }
        if (arm === 'partial-page-error' && page === 2) return Response.json({ error: { message: 'Synthetic provider refusal' } }, { status: 503 });
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
    const scope = { result, sent: { errors: [], refused: [] }, sourceName: 'calendar', state: fixture.state,
      m: {}, manifestPath: 'fixture/manifest.json', statePath: 'fixture/state.json',
      base: 'https://fixture.invalid', adminKey: secret, options: {}, assertLockOwned() {},
      saveState: fixture.saveState, buildDriveRemovalPlan,
      listFamilies: async () => fixture.stored,
      ingestRemovalReview: () => ({ finish: async ({ sourcePlan }) => fixture.finish(sourcePlan) }),
      removalError: null, removalPending: 0 };
    await calendarRemoval(scope);
    if (scope.removalError) throw scope.removalError;
    return { completed: result.ok };
  };
  if (arm === 'shared-config-removed') fixture.state.shared = { sync_token: 'fixture-prior-sync' };
  await exercise({ id, kind: 'calendar', fixture, run, expected,
    observations: () => ({ providerCalls, itemCalls, tombstones, documents, skipped, failedCalendars, authoritative }) });
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
  let sourcePlanCalls = 0, lastQuery = null, witnessMode = false, witnessCalls = 0, witness = null;
  fixture.state.history_id = 'fixture-history-before';
  if (arm === 'full-empty-body') delete fixture.state.done[`gmail:${targetId}`];
  const fetchImpl = async input => {
    if (witnessMode) witnessCalls++;
    else providerCalls++;
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith('/profile')) {
      if (arm === 'full-profile-error') return Response.json({ error: { message: 'Synthetic refusal' } }, { status: 503 });
      return Response.json({ historyId: 'fixture-history-current' });
    }
    if (path.endsWith('/history')) {
      if (arm === 'expired-history-label-exclusion') return Response.json({ error: { message: 'Synthetic expired history' } }, { status: 404 });
      if (arm === 'incremental-page-error' && url.searchParams.has('pageToken')) return Response.json({ error: { message: 'Synthetic refusal' } }, { status: 503 });
      if (['deleted', 'incremental-page-error'].includes(arm)) {
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
      if (['full-permission-403', 'full-provider-503'].includes(arm)) return Response.json({ error: { message: 'Synthetic refusal' } }, { status: Number(arm.slice(-3)) });
      if (arm === 'full-page-error' && url.searchParams.has('pageToken')) return Response.json({ error: { message: 'Synthetic refusal' } }, { status: 503 });
      if (arm === 'full-malformed-page') return Response.json({ messages: {} });
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
    if (['item-403', 'item-410', 'item-503'].includes(arm)) return Response.json({ error: { message: 'Synthetic item refusal' } }, { status: Number(arm.slice(-3)) });
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
    messagePolicy: (token, item, input) => gmail.messagePolicy(token, item, { ...input, ...opts }),
    toEnvelope: (token, item, input) => gmail.toEnvelope(token, item, input, opts),
  };
  const run = async () => {
    const limit = arm === 'full-limited' ? 99 : Infinity;
    try { assertRemoteLimitSafe({ source: 'Gmail', limit, dryRun: false, incremental: !full }); }
    catch (error) { guardRefused = true; throw error; }
    const scope = { options: { gmail: adapter }, incremental: !full, state: fixture.state, sourceName: 'gmail',
      getToken: async () => secret, limit, gmailFullQuery: gmail.gmailQuery({ since }), gmailSince: since,
      gmailRetriesAtStart: new Set(), gmailHistoryMarkerMissing: 0, gmailOperationalFailure: null,
      gmailLabelGaps: 0, gmailPendingRemovalGaps: 0, lane: full ? 'sweep' : 'incremental',
      policyFingerprint: gmail.gmailPolicyFingerprint({ since }), dry: false,
      base: 'https://fixture.invalid', adminKey: secret, GMAIL_FETCH_CONCURRENCY: 8,
      scannerPolicyChanged: false, scannerFingerprint: 'fixture-scanner', scannerOn: false,
      statePath: 'fixture/state.json', scanned: 0, unchanged: 0, policySkipped: 0, sourceResolvedSkipped: 0,
      localRefused: 0, scannerProgressCanCommit: true, pendingCursor: null,
      countedPreparationErrors: new Set(), intentionalRemovalUids: [], skips: [], tally: { failed: 0 },
      info() {}, warn() {}, assertLockOwned() {}, saveState: fixture.saveState,
      prefetch, batchStream, gmailRetryMessageIds, clearGmailRetry, buildDriveRemovalPlan,
      listPreparedSourceFamilies: async () => new Set(fixture.stored),
      recordRemovalSafetyBaseline: ({ inventory }) => inventory.size,
      recordAcceptedDocumentState: (state, { stateKey, hash }) => { state.done[stateKey] = hash; delete state.skipped[stateKey]; },
      hasCredentialScannerProgress: () => false,
      makeRemotePreparationErrorIsolator: () => error => { throw error; },
      consumeGroup: () => { throw Error('Unexpected document batch in removal-only harness'); },
      removalReview: { finish: async ({ sourcePlan }) => { sourcePlanCalls++; return fixture.finish(sourcePlan); } },
    };
    await gmailBranch(scope);
    return { completed: true };
  };
  await exercise({ id, kind: 'gmail', fixture, run, expected,
    observations: () => ({ providerCalls, listCalls, itemCalls, subjectLookups, tombstones, guardRefused, sourcePlanCalls,
      witnessCalls, witness, queryHasDateFloor: Boolean(lastQuery?.includes('after:')),
      queryExcludesLabels: Boolean(lastQuery?.includes('-category:promotions')) }) });
  if (fixture.saved()) {
    const cause = ['deleted', 'item-404'].includes(arm) ? 'explicit_deletion'
      : ['incremental-label-exclusion', 'incremental-date-floor'].includes(arm) ? 'scope_or_filter_change' : 'unknown';
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
  await calendarCase(arm, ['deleted', 'partial-no-token', 'tombstone-actor-unknown', 'sibling-provider-error'].includes(arm) ? 'auto' : 'retained');
}
if (!process.argv[2] || process.argv[2] === 'gmail') for (const [arm, expected] of [
  ['deleted', 'auto'], ['retained', 'retained'], ['full-complete-pages', 'retained'], ['item-404', 'auto'],
  ['full-label-exclusion', 'held'], ['full-date-floor', 'held'], ['full-visibility-subset', 'held'],
  ['full-missing-page-token', 'held'], ['expired-history-label-exclusion', 'held'],
  ['incremental-label-exclusion', 'held'], ['incremental-date-floor', 'held'],
  ['full-empty-body', 'retained'], ['incremental-empty-body', 'retained'], ['missing-labels', 'retained'],
  ['item-403', 'error'], ['item-410', 'error'], ['item-503', 'error'],
  ['full-limited', 'error'], ['full-page-error', 'error'], ['incremental-page-error', 'error'],
  ['full-malformed-page', 'error'], ['full-permission-403', 'error'], ['full-provider-503', 'error'],
  ['full-profile-error', 'retained'], ['full-omitted-messages', 'held'],
]) await gmailCase(arm, expected);
if (!process.argv[2] || process.argv[2] === 'microsoft') for (const arm of ['deleted', 'aged-out', 'blanked', 'retained',
  'changed', 'unknown-tombstone', 'expired-history', 'permission-403', 'provider-503', 'partial-page-error',
  'mail-deleted', 'mail-changed', 'mail-retained']) await microsoftCase(arm,
  ['retained', 'mail-retained'].includes(arm) ? 'retained'
    : ['permission-403', 'provider-503', 'partial-page-error'].includes(arm) ? 'error' : 'held');

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
    assert.equal(result.deletions.length, 2, 'the real adapter must retain both observations');
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
      sync: async () => snapshot ? { ...result, authoritative_snapshot: true,
        snapshot_source_ids: retainedIds.map(value => `outlook:message:${value}`) } : result,
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

assert.equal(ambientAttempts, 0);
assert.ok(rows.some(row => row.planned > 0) && rows.some(row => row.planned === 0));
if (process.argv[2] !== 'microsoft') assert.ok(rows.some(row => row.apply === 1) && rows.some(row => row.apply === 0));
console.log(`TOTAL ${rows.length} safety probes passed; synthetic applies=${rows.reduce((n, row) => n + row.apply, 0)}`);
