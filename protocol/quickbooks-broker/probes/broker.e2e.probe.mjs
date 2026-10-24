import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertSchema } from '../../../broker/quickbooks/src/validation.mjs';
import {
  PROTOCOL, BROKER, CALLBACK, OWNER_CALLBACK, START, REFRESH, REVOKE,
  loadImplementation, createRig, jsonRequest, launchRequest, rewriteJson, rejected,
  queryFree, reached, ordered, connected, noExchange, refusedUnchanged, readsDisabled,
} from './harness.mjs';

// The fixed adapter binds actual broker handlers and the offline owner fixture.
// No scenario treats a missing handler or an unobserved decision as a pass.
test('E2E connect: enrollment, owner authentication, signed start and launch', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  reached(control, 'enrollment.challenge.checked');
  reached(control, 'start.signature.checked');
  await control.assertPrivate();

  for (const options of [{ authorized: false }, { challengeValid: false }]) {
    const rig = await createRig(factory);
    rejected(await rig.enroll(0, options));
    noExchange(rig, options.authorized === false ? 'enrollment.access.checked' : 'enrollment.challenge.checked');
    assert.ok(rig.inspect().voucherIssueCount === 0, 'refused enrollment must issue no voucher');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    rejected(await rig.owner('/api/quickbooks/connect/start', { authenticated: false, body: {} }));
    noExchange(rig, 'owner.authentication.checked');
  }
  for (const [mutation, expectInvalidRequest] of [
    [body => { body.signature = (body.signature[0] === 'A' ? 'B' : 'A') + body.signature.slice(1); }, false],
    [body => { body.body.intent = (body.body.intent[0] === 'A' ? 'B' : 'A') + body.body.intent.slice(1); }, false],
    [body => { body.unrecognized = true; }, true],
  ]) {
    const rig = await createRig(factory);
    await rig.enroll();
    rejected(await rig.broker(await rewriteJson(await rig.signed(START), mutation), { expectInvalidRequest }));
    noExchange(rig, 'start.proof.checked');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    const start = await rig.start();
    rig.advance(120_001);
    rejected(await rig.broker(launchRequest({
      protocol: PROTOCOL, launch_capability: start.launch_capability,
      transaction: start.transaction,
    })));
    noExchange(rig, 'launch.expiry.checked');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    const start = await rig.start();
    await rig.adapter.restartBroker();
    const launch = await rig.launch(start);
    await rig.adapter.restartBroker();
    queryFree(await rig.broker(await rig.consent(launch)));
    connected(rig);
    await rig.assertPrivate();
  }
});

test('E2E callback: state, cookie, exact query, expiry and cancellation', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  reached(control, 'callback.binding.checked');
  reached(control, 'callback.cookie.binding.checked');
  for (const attack of ['missing_state', 'wrong_state', 'missing_cookie', 'wrong_cookie', 'duplicate_code', 'extra_query', 'expired']) {
    const rig = await createRig(factory);
    const callback = await rig.consent(await rig.pending());
    const url = new URL(callback.url);
    const headers = new Headers(callback.headers);
    if (attack === 'missing_state') url.searchParams.delete('state');
    if (attack === 'wrong_state') url.searchParams.set('state', rig.provider.opaque('state'));
    if (attack === 'missing_cookie') headers.delete('cookie');
    if (attack === 'wrong_cookie') {
      const [name, value] = callback.headers.get('cookie').split('=');
      const pieces = value.split('.');
      pieces[3] = (pieces[3][0] === 'A' ? 'B' : 'A') + pieces[3].slice(1);
      headers.set('cookie', `${name}=${pieces.join('.')}`);
    }
    if (attack === 'wrong_cookie') {
      assert.ok(headers.get('cookie').startsWith(callback.headers.get('cookie').split('=')[0] + '=') &&
        headers.get('cookie').split('=')[1].split('.').length === 4,
      'wrong-cookie probe must retain the real cookie name and sealed-cookie syntax');
    }
    if (attack === 'duplicate_code') url.searchParams.append('code', url.searchParams.get('code'));
    if (attack === 'extra_query') url.searchParams.set('return_to', 'https://elsewhere.invalid/');
    if (attack === 'expired') rig.advance(600_001);
    queryFree(await rig.broker(new Request(url, { headers, redirect: 'manual' }), {
      expectInvalidRequest: ['missing_state', 'duplicate_code', 'extra_query'].includes(attack),
    }));
    noExchange(rig, 'callback.binding.checked');
    if (attack === 'wrong_cookie') reached(rig, 'callback.cookie.binding.checked');
    await rig.assertPrivate();
  }
  const canceled = await createRig(factory);
  queryFree(await canceled.broker(await canceled.consent(await canceled.pending(), false)));
  noExchange(canceled, 'callback.binding.checked');
  assert.ok(canceled.state().intentStatus === 'canceled', 'consent cancellation must be visible to the owner');
});

test('E2E code exchange: durable fence, required token fields and same-invocation delivery', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  assert.ok(control.provider.snapshot().mutated.exchange === 1, 'control must reach exactly one provider exchange');
  ordered(control, 'broker.exchange.fenced', 'broker.exchange.sent');

  for (const fault of ['reject', 'malformed', 'missing_refresh', 'changed_company', 'loss_after']) {
    const rig = await createRig(factory);
    rig.provider.queueFault('exchange', fault);
    queryFree(await rig.broker(await rig.consent(await rig.pending())));
    reached(rig, 'broker.exchange.sent');
    assert.ok(rig.provider.snapshot().attempted.exchange === 1, 'exchange failure must not cause automatic replay');
    assert.ok(rig.state().status !== 'connected', 'invalid or lost token result must not activate');
    assert.ok(rig.inspect().exchangeFences === 1, 'failed exchange remains consumed');
    await rig.assertPrivate();
  }
  {
    const rig = await createRig(factory);
    const callback = await rig.consent(await rig.pending());
    rig.adapter.armFault('broker.replay.commit');
    queryFree(await rig.broker(callback));
    noExchange(rig, 'broker.exchange.fence.attempted');
  }
  {
    const rig = await createRig(factory);
    rig.deliveryFault('unavailable');
    queryFree(await rig.broker(await rig.consent(await rig.pending())));
    assert.ok(rig.provider.snapshot().attempted.revoke === 1, 'unconfirmed delivery must attempt in-memory revocation');
    assert.ok(rig.state().status !== 'connected', 'unavailable callback cannot be reported connected');
    assert.ok(rig.deliveries.length >= 1 && rig.deliveries.length <= 3, 'delivery retries are bounded to the same invocation');
    for (const delivery of rig.deliveries.slice(1))
      assert.ok(await rig.deliveries[0].clone().text() === await delivery.clone().text(), 'delivery retry must reuse the identical encrypted envelope');
    await rig.assertPrivate();
  }
  {
    const rig = await createRig(factory);
    rig.deliveryFault('lost_receipt_once');
    await rig.connect();
    assert.ok(rig.deliveries.length === 2 && rig.state().connectionCommitCount === 1, 'lost acknowledgement must reuse receipt without a second save');
    assert.ok(rig.provider.snapshot().attempted.revoke === 0, 'confirmed idempotent delivery needs no revocation');
  }
});

test('E2E refresh: rotation, generation lease, lost response and persistent uncertainty', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  control.advance(3_000_000);
  const initial = control.state().tokenGeneration;
  const refreshed = await control.owner('/api/quickbooks/refresh', { body: {} });
  assert.ok(refreshed.ok && control.state().tokenGeneration === initial + 1, 'refresh control replaces and reads back one new generation');
  assert.ok(!control.state().outcomeUnknown, 'only verified replacement readback clears the fence');
  ordered(control, 'owner.refresh.fenced', 'broker.refresh.sent');
  reached(control, 'owner.refresh.readback');
  assert.ok(await control.adapter.runScheduledRead({ owner: 0 }) === true &&
    await control.adapter.runDirectRead({ owner: 0 }) === true, 'connected valid controls must permit both read paths');
  await control.assertPrivate();

  for (const path of ['/api/quickbooks/refresh', '/api/quickbooks/disconnect']) {
    const rig = await createRig(factory);
    await rig.connect();
    rig.advance(3_000_000);
    const checkpoint = rig.events.length;
    rejected(await rig.owner(path, { authenticated: false, body: {} }));
    reached(rig, 'owner.authentication.checked', checkpoint);
    assert.ok(rig.provider.snapshot().attempted.refresh === 0 && rig.provider.snapshot().attempted.revoke === 0,
      'owner authentication must precede every credential mutation');
  }

  for (const fault of ['loss_before', 'loss_after', 'reject', 'malformed', 'missing_refresh', 'changed_company']) {
    const rig = await createRig(factory);
    await rig.connect();
    rig.advance(3_000_000);
    const generation = rig.state().tokenGeneration;
    rig.provider.queueFault('refresh', fault);
    rejected(await rig.owner('/api/quickbooks/refresh', { body: {} }));
    reached(rig, 'broker.refresh.sent');
    assert.ok(rig.state().status === 'reauthorization_required' && rig.state().outcomeUnknown, 'unproven refresh leaves a visible persistent fence');
    assert.ok(rig.state().tokenGeneration === generation, 'failure must not activate a new generation');
    await readsDisabled(rig);
    await refusedUnchanged(rig, () => rig.owner('/api/quickbooks/refresh', { body: {} }));
    assert.ok(rig.provider.snapshot().attempted.refresh === 1, 'old refresh token must never be retried after uncertainty');
    await rig.assertPrivate();
  }
  {
    const rig = await createRig(factory);
    await rig.connect();
    rig.advance(3_000_000);
    rig.adapter.armFault('owner.refresh.readback');
    rejected(await rig.owner('/api/quickbooks/refresh', { body: {} }));
    reached(rig, 'owner.refresh.readback.attempted');
    assert.ok(rig.state().outcomeUnknown, 'failed replacement readback must retain the fence');
    await readsDisabled(rig);
    await refusedUnchanged(rig, () => rig.owner('/api/quickbooks/refresh', { body: {} }));
  }
  {
    const rig = await createRig(factory);
    await rig.connect();
    await rig.owner('/api/quickbooks/refresh', { body: {} });
    reached(rig, 'owner.refresh.due.checked');
    assert.ok(rig.provider.snapshot().attempted.refresh === 0, 'safely valid access token must not cause refresh');
    rig.advance(3_000_000);
    await Promise.all([0, 1].map(() => rig.owner('/api/quickbooks/refresh', { body: {} })));
    assert.ok(rig.provider.snapshot().attempted.refresh === 1, 'per-connection lease permits only one concurrent mutation');
  }
});

test('E2E revoke: confirmed, rejected, uncertain and no-contact retry proof', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  const retained = control.state().importedRecordCount;
  assert.ok(retained > 0, 'retention control requires a preexisting synthetic imported record');
  const response = await control.owner('/api/quickbooks/disconnect', { body: {} });
  assert.ok(response.ok && control.state().remoteRevocation === 'confirmed', 'control must confirm remote revocation');
  assert.ok(!control.state().scheduleEnabled && control.state().tokenCiphertextCount === 0, 'confirmed revoke destroys credentials and stops reads');
  assert.ok(control.state().importedRecordCount === retained, 'disconnect must retain imported records');
  ordered(control, 'owner.revoke.fenced', 'broker.revoke.sent');
  ordered(control, 'owner.schedule.disabled', 'broker.revoke.sent');
  await readsDisabled(control);

  {
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const providerEntered = new Promise(resolve => { entered = resolve; });
    const rig = await createRig(dependencies => factory({ ...dependencies, brokerFetch: async request => {
      if (request.url === dependencies.brokerConfig.revokeUrl) { entered(); await gate; }
      return dependencies.brokerFetch(request);
    } }));
    await rig.connect();
    assert.ok(await rig.adapter.runScheduledRead({ owner: 0 }) === true &&
      await rig.adapter.runDirectRead({ owner: 0 }) === true, 'valid connection reads are the in-flight control');
    const pending = rig.owner('/api/quickbooks/disconnect', { body: {} });
    try {
      await providerEntered;
      assert.ok(rig.state().status === 'disconnecting' && rig.state().outcomeUnknown,
        'in-flight disconnect must expose its status and durable fence');
      await readsDisabled(rig);
    } finally { release(); await pending; }
    assert.ok(rig.state().remoteRevocation === 'confirmed');
    await readsDisabled(rig);
  }

  for (const fault of ['reject', 'loss_before', 'loss_after']) {
    const rig = await createRig(factory);
    await rig.connect();
    rig.provider.queueFault('revoke', fault);
    await rig.owner('/api/quickbooks/disconnect', { body: {} });
    reached(rig, 'broker.revoke.sent');
    assert.ok(!rig.state().scheduleEnabled && rig.state().remoteRevocation !== 'confirmed', 'unconfirmed revoke must keep all use disabled');
    await readsDisabled(rig);
    await refusedUnchanged(rig, () => rig.owner('/api/quickbooks/disconnect', { body: {} }));
    assert.ok(rig.provider.snapshot().attempted.revoke === 1, 'unproven provider contact must not be retried');
    await rig.assertPrivate();
  }
  {
    const rig = await createRig(factory);
    await rig.connect();
    rig.adapter.armFault('broker.revoke.before_fence');
    await rig.owner('/api/quickbooks/disconnect', { body: {} });
    reached(rig, 'broker.revoke.fence.attempted');
    assert.ok(rig.provider.snapshot().attempted.revoke === 0 && rig.state().noContactProofVerified, 'safe retry requires verified proof of no provider contact');
    await readsDisabled(rig);
    await rig.owner('/api/quickbooks/disconnect', { body: { retry_same_operation: true } });
    assert.ok(rig.provider.snapshot().attempted.revoke === 1 && rig.state().remoteRevocation === 'confirmed', 'same fenced operation may retry only after proof');
  }
  {
    const rig = await createRig(factory);
    await rig.connect();
    const first = await rig.signed(REVOKE);
    const operation = (await first.clone().json()).body;
    rig.adapter.armFault('broker.revoke.before_fence');
    const notSent = await rig.broker(first);
    assert.ok(notSent.ok, 'no-contact control must return its proof');
    const result = await notSent.json();
    assert.ok(result.provider_contact === 'not_sent' && rig.provider.snapshot().attempted.revoke === 0);
    const original = rig.inspect().brokerRows.find(row => row.route === REVOKE && row.phase === 'not_sent' && 'provider_attempts' in row);
    assert.ok(original, 'no-contact control requires a retained replay row');
    const bodyOverrides = { ...operation, no_contact_proof: result.no_contact_proof };
    const retry = await rig.signed(REVOKE, { bodyOverrides });
    const consumedReplay = await rig.signed(REVOKE, { bodyOverrides });
    assert.ok((await retry.clone().json()).request_id !== (await consumedReplay.clone().json()).request_id,
      'proof replay must reach consumption under a fresh request ID');
    assert.ok((await rig.broker(retry)).ok && rig.provider.snapshot().attempted.revoke === 1,
      'unconsumed proof must authorize exactly one fenced send');
    const consumed = () => rig.inspect().brokerRows.find(row => row.request_id_hash === original.request_id_hash && 'provider_attempts' in row);
    assert.ok(consumed()?.phase === 'proof_consumed' && consumed().provider_attempts === 0,
      'successful retry must durably consume the original no-contact proof');
    const before = JSON.stringify(consumed());
    const replay = await refusedUnchanged(rig, () => rig.broker(consumedReplay));
    assert.ok(replay.status === 409 && (await replay.json()).code === 'replayed', 'consumed proof must be refused');
    assert.ok(consumed()?.phase === 'proof_consumed' && JSON.stringify(consumed()) === before,
      'refusal must preserve proof_consumed and its original no-contact evidence');
    await rig.assertPrivate();
  }
});

test('E2E replay: launch, callback, signed request and concurrent exchange', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  {
    const receipt = await control.adapter.owners[0].fetch(control.deliveries[0].clone());
    assert.ok(receipt.ok, 'same delivery retry must return the committed receipt');
    assert.ok(await receipt.text() === await control.receipts[0].clone().text(), 'same delivery retry must return the exact stored receipt');
    const changed = await rewriteJson(control.deliveries[0], body => {
      body.ciphertext = (body.ciphertext[0] === 'A' ? 'B' : 'A') + body.ciphertext.slice(1);
    });
    const checkpoint = control.events.length;
    rejected(await control.adapter.owners[0].fetch(changed));
    reached(control, 'owner.delivery.binding.checked', checkpoint);
    assert.ok(control.state().connectionCommitCount === 1, 'same ID with different bytes must not save or return success');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    const start = await rig.start();
    await rig.launch(start);
    rejected(await rig.broker(launchRequest({ protocol: PROTOCOL, launch_capability: start.launch_capability, transaction: start.transaction })));
    noExchange(rig, 'launch.replay.checked');
  }
  for (const concurrent of [false, true]) {
    const rig = await createRig(factory);
    const callback = await rig.consent(await rig.pending());
    if (concurrent) await Promise.all([rig.broker(callback.clone()), rig.broker(callback.clone())]);
    else { await rig.broker(callback.clone()); await rig.broker(callback.clone()); }
    reached(rig, 'callback.replay.checked');
    assert.ok(rig.provider.snapshot().attempted.exchange === 1, 'state uniqueness must fence one exchange across racing requests');
    connected(rig);
  }
  for (const route of [START, REFRESH, REVOKE]) {
    const rig = await createRig(factory);
    if (route === START) await rig.enroll(); else await rig.connect();
    const request = await rig.signed(route);
    const first = await rig.broker(request.clone());
    assert.ok(first.ok, 'signed request replay control must succeed once');
    const before = rig.provider.snapshot();
    const checkpoint = rig.events.length;
    rejected(await rig.broker(request.clone()));
    reached(rig, 'request.replay.checked', checkpoint);
    const after = rig.provider.snapshot();
    assert.ok(after.attempted.refresh === before.attempted.refresh && after.attempted.revoke === before.attempted.revoke, 'request replay must never repeat provider mutation');
  }
});

test('E2E mix-up: install, callback, environment, key, intent, company and generation', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  for (const bodyOverrides of [
    { callback: 'https://owner-b.invalid/api/quickbooks/connect/callback' },
    { environment: 'production' },
  ]) {
    const rig = await createRig(factory);
    await rig.enroll();
    rejected(await rig.broker(await rig.signed(START, { bodyOverrides })));
    noExchange(rig, 'start.voucher.binding.checked');
  }
  {
    const rig = await createRig(factory);
    const first = await rig.pending(0);
    const second = await rig.pending(1);
    const callback = await rig.consent(first);
    queryFree(await rig.broker(new Request(callback, { headers: { cookie: second.cookie }, redirect: 'manual' })));
    noExchange(rig, 'callback.binding.checked');
  }
  {
    const rig = await createRig(factory);
    await rig.connect(0);
    await rig.pending(1);
    const body = await rig.deliveries[0].clone().json();
    const checkpoint = rig.events.length;
    rejected(await rig.adapter.owners[1].fetch(jsonRequest(rig.origins[1] + OWNER_CALLBACK, body)));
    reached(rig, 'owner.delivery.binding.checked', checkpoint);
    assert.ok(rig.state(1).connectionCommitCount === 0, 'valid envelope for another install must not activate');
  }
  for (const field of ['intent', 'environment', 'delivery_key_fingerprint', 'token_generation', 'key_generation']) {
    const rig = await createRig(factory);
    await rig.connect();
    const delivered = rig.deliveries[0];
    const altered = await rewriteJson(delivered, body => {
      body.header[field] = typeof body.header[field] === 'number' ? body.header[field] + 1 : rig.provider.opaque('binding');
    });
    const checkpoint = rig.events.length;
    rejected(await rig.adapter.owners[0].fetch(altered));
    reached(rig, 'owner.delivery.binding.checked', checkpoint);
    assert.ok(rig.state().connectionCommitCount === 1, 'changed authenticated binding must not overwrite the connection');
  }
  for (const field of ['company_fingerprint', 'token_generation', 'realm_id']) {
    const rig = await createRig(factory);
    await rig.connect();
    const request = await rewriteJson(await rig.signed(REFRESH), body => {
      body.body[field] = typeof body.body[field] === 'number' ? body.body[field] + 1 :
        (body.body[field][0] === 'a' ? 'b' : 'a') + body.body[field].slice(1);
    });
    rejected(await rig.broker(request));
    reached(rig, 'refresh.proof.checked');
    assert.ok(rig.provider.snapshot().attempted.refresh === 0, 'tampered refresh binding must fail proof before contact');
  }
  for (const remove of [true, false]) {
    const rig = await createRig(factory);
    await rig.connect();
    const request = await rewriteJson(rig.deliveries[0], body => {
      if (remove) delete body.broker_authentication_tag;
      else body.broker_authentication_tag = rig.provider.opaque('tag').slice(0, 43);
    });
    const checkpoint = rig.events.length;
    rejected(await rig.adapter.owners[0].fetch(request));
    reached(rig, 'owner.delivery.binding.checked', checkpoint);
    assert.ok(rig.state().connectionCommitCount === 1, 'encryption without the broker sender proof cannot activate');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    rig.adapter.armFault('broker.rotate_generation');
    rejected(await rig.broker(await rig.signed(START)));
    noExchange(rig, 'start.voucher.generation.checked');
  }
});

test('E2E SSRF and privacy: pinned callback, no redirects and no accounting proxy', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  await control.assertPrivate();
  assert.ok((await control.broker(new Request(BROKER + '/health'))).ok, 'health route is the passing public route control');
  await control.adapter.runScheduledRead({ owner: 0 });
  assert.ok(control.provider.snapshot().accountingReads > 0 && control.outbound.ownerAccounting > 0, 'read control must reach Intuit directly from the owner');
  assert.ok(control.outbound.brokerAccounting === 0, 'direct owner read must bypass the broker');
  for (const [callback, expectInvalidRequest] of [
    ['http://owner-a.invalid/api/quickbooks/connect/callback', true],
    ['https://127.0.0.1/api/quickbooks/connect/callback', false],
    ['https://[::1]/api/quickbooks/connect/callback', true],
    ['https://localhost/api/quickbooks/connect/callback', false],
    ['https://owner-a.invalid:8443/api/quickbooks/connect/callback', true],
    ['https://fixture@owner-a.invalid/api/quickbooks/connect/callback', true],
    ['https://owner-a.invalid/api/quickbooks/connect/callback#fragment', true],
    ['https://owner-a.invalid/wrong-path', true],
  ]) {
    const rig = await createRig(factory);
    rejected(await rig.enroll(0, { callback, expectInvalidRequest }));
    noExchange(rig, 'enrollment.callback.checked');
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1']) {
    const rig = await createRig(factory);
    const callback = await rig.consent(await rig.pending());
    rig.resolveTo(address);
    queryFree(await rig.broker(callback));
    reached(rig, 'delivery.destination.checked');
    assert.ok(rig.outbound.delivery === 0 && rig.state().status !== 'connected', 'private DNS answer must prevent callback delivery');
  }
  {
    const rig = await createRig(factory);
    rig.deliveryFault('redirect');
    queryFree(await rig.broker(await rig.consent(await rig.pending())));
    reached(rig, 'delivery.response.checked');
    assert.ok(rig.outbound.blocked === 0, 'broker must not follow callback redirects');
    assert.ok(rig.provider.snapshot().attempted.revoke === 1, 'redirected delivery must revoke the undelivered token');
  }
  for (const route of ['/v3/company/fixture/query', '/v1/quickbooks/proxy', '/v1/quickbooks/tokens/lookup', '/v1/quickbooks/tokens/recover']) {
    const before = control.provider.snapshot().accountingReads;
    const response = await control.broker(new Request(BROKER + route));
    assert.ok(response.status === 404 || response.status === 405, 'forbidden route must be absent');
    assert.ok(control.provider.snapshot().accountingReads === before, 'forbidden route must not contact provider data APIs');
  }
});

test('E2E abuse: limits, request proof and replay-store failure close before contact', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  for (const fault of ['broker.quota.unavailable', 'broker.replay.unavailable']) {
    const rig = await createRig(factory);
    await rig.enroll();
    rig.adapter.armFault(fault);
    rejected(await rig.broker(await rig.signed(START)));
    noExchange(rig, 'start.admission.checked');
  }
  for (const attack of ['wrong_type', 'oversized', 'expired_proof']) {
    const rig = await createRig(factory);
    await rig.enroll();
    const valid = await rig.signed(START);
    let request = valid;
    if (attack === 'wrong_type') request = new Request(valid, { headers: { 'content-type': 'text/plain' } });
    if (attack === 'oversized') request = jsonRequest(valid.url, { padding: 'x'.repeat(12 * 1024) });
    if (attack === 'expired_proof') rig.advance(60_001);
    rejected(await rig.broker(request, { expectInvalidRequest: attack !== 'expired_proof' }));
    noExchange(rig, 'start.proof.checked');
  }
  {
    const rig = await createRig(factory);
    await rig.enroll();
    for (let count = 0; count < 5; count++) {
      assert.ok((await rig.broker(await rig.signed(START))).ok, 'start quota control must admit the first five');
    }
    const response = await rig.broker(await rig.signed(START));
    assert.ok(response.status === 429, 'sixth start in ten minutes must be limited');
    noExchange(rig, 'start.quota.checked');
  }
  {
    const rig = await createRig(factory);
    await rig.connect();
    const request = await rewriteJson(rig.deliveries[0], body => { body.ciphertext = 'x'.repeat(32 * 1024); });
    const checkpoint = rig.events.length;
    const response = await rig.adapter.owners[0].fetch(request);
    assert.ok(response.status === 413, 'owner delivery must enforce its serialized 32 KiB byte limit');
    reached(rig, 'owner.delivery.binding.checked', checkpoint);
    assert.ok(rig.state().connectionCommitCount === 1, 'oversized envelope must not save a second connection');
  }
});

async function expiredOwnerStatus(rig) {
  const expired = await rig.owner('/api/quickbooks/status');
  assert.ok(expired.ok, 'deadline cleanup must return verified status');
  const status = await expired.json();
  assert.ok(status.intentStatus === 'expired' && status.intentKeyCount === 0 &&
    rig.state().intentStatus === 'expired' && rig.state().temporaryIntentKeyCount === 0,
  'overdue pending intent must visibly expire and destroy both stored keys');
  assert.ok(rig.state().intentExpiryReadbackCount === 1, 'expiry requires one exact stored-record readback');
  reached(rig, 'owner.intent.expiry.readback');
}

for (const scenario of ['connect', 'canceled', 'failed', 'expired', 'refresh']) {
  test(`E2E terminal intent rows: ${scenario} retains only schema-valid receipt replay material`, async () => {
    const rig = await createRig(await loadImplementation());
    if (scenario === 'connect' || scenario === 'refresh') {
      await rig.connect();
      connected(rig);
      if (scenario === 'refresh') {
        rig.advance(3_000_000);
        assert.ok((await rig.owner('/api/quickbooks/refresh', { body: {} })).ok,
          'refresh control must save its replacement before terminal inspection');
        reached(rig, 'owner.refresh.readback');
      }
    } else if (scenario === 'expired') {
      await rig.pending();
      assert.ok(rig.state().intentStatus === 'pending' && rig.state().intentKeyCount === 2,
        'expiry control starts with both active delivery keys');
      rig.advance(600_000);
      await expiredOwnerStatus(rig);
    } else {
      if (scenario === 'failed') rig.provider.queueFault('exchange', 'reject');
      queryFree(await rig.broker(await rig.consent(await rig.pending(), scenario !== 'canceled')));
      assert.ok(rig.state().intentStatus === scenario,
        'verified completion control must persist its terminal outcome');
    }
    const rows = rig.adapter.owners[0].inspectIntents();
    assert.ok(rows.length === (scenario === 'refresh' ? 2 : 1), 'terminal inspection must read every actual stored intent');
    for (const row of rows) {
      assert.doesNotThrow(() => assertSchema('ownerIntent', row),
        'actual terminal row must satisfy the closed ownerIntent schema');
      assert.deepEqual(Object.keys(row).sort(), ['protocol', 'intent', 'status', 'delivery_id', 'envelope_hash', 'receipt'].sort(),
        'terminal storage must omit every active field and both key placeholders');
      if (scenario !== 'expired') {
        assert.ok(row.delivery_id === row.receipt.claims.delivery_id && row.envelope_hash === row.receipt.claims.envelope_hash,
          'terminal row retains the exact accepted delivery receipt binding');
      }
    }
    if (['connect', 'canceled', 'failed'].includes(scenario)) {
      rig.advance(600_000);
      assert.ok((await rig.owner('/api/quickbooks/status')).ok, 'terminal status control remains readable after the old deadline');
      const replay = await rig.adapter.owners[0].fetch(rig.deliveries[0].clone());
      assert.ok(replay.ok && await replay.text() === JSON.stringify(rows[0].receipt),
        'identical delivery after key destruction and deadline must return the exact stored receipt');
      const changed = await rewriteJson(rig.deliveries[0], body => {
        body.ciphertext = (body.ciphertext[0] === 'A' ? 'B' : 'A') + body.ciphertext.slice(1);
      });
      rejected(await rig.adapter.owners[0].fetch(changed));
      assert.ok(JSON.stringify(rig.adapter.owners[0].inspectIntents()) === JSON.stringify(rows),
        'changed delivery must preserve terminal replay rows');
    }
  });
}

test('E2E pending intents: unavailable delivery and invalid callback expire at the deadline', async () => {
  const factory = await loadImplementation();
  const control = await createRig(factory);
  await control.connect();
  connected(control);
  for (const scenario of ['unavailable_delivery', 'invalid_callback']) {
    const rig = await createRig(factory);
    const callback = await rig.consent(await rig.pending());
    if (scenario === 'unavailable_delivery') rig.deliveryFault('unavailable');
    const request = scenario === 'invalid_callback'
      ? new Request(callback, { headers: {}, redirect: 'manual' }) : callback;
    queryFree(await rig.broker(request));
    if (scenario === 'invalid_callback') noExchange(rig, 'callback.binding.checked');
    else assert.ok(rig.provider.snapshot().attempted.exchange === 1 && rig.provider.snapshot().attempted.revoke === 1,
      'unavailable delivery must reach exchange and in-memory revoke before owner cleanup');
    assert.ok(rig.state().intentStatus === 'pending' && rig.state().connectionCommitCount === 0,
      'an undelivered or invalid callback must leave a pending intent without a connection');
    const providerBefore = JSON.stringify(rig.provider.snapshot());
    const outboundBefore = JSON.stringify(rig.outbound);
    rig.advance(599_999);
    const beforeDeadline = await rig.owner('/api/quickbooks/status');
    assert.ok(beforeDeadline.ok, 'status must admit a pending intent before the deadline');
    assert.ok(rig.state().intentStatus === 'pending' && rig.state().intentKeyCount === 2 &&
      rig.state().intentExpiryReadbackCount === 0, 'pending control keeps both keys before the deadline');
    rig.advance(1);
    await expiredOwnerStatus(rig);
    assert.ok(JSON.stringify(rig.provider.snapshot()) === providerBefore && JSON.stringify(rig.outbound) === outboundBefore,
      'status cleanup must not enter any outbound transport');
    await rig.assertPrivate();
  }
});

test('E2E pending cleanup: bounded backlog and failed readback remain recoverable', async () => {
  const factory = await loadImplementation();
  const rig = await createRig(factory);
  await rig.enroll();
  for (let count = 0; count < 33; count++) await rig.signed(START);
  assert.ok(rig.state().pendingIntentCount === 33 && rig.state().temporaryIntentKeyCount === 66,
    'backlog control requires distinct pending intents with both stored keys');
  rig.advance(600_000);
  const checkpoint = rig.events.length;
  rig.adapter.armFault('owner.intent.expiry.readback');
  rejected(await rig.owner('/api/quickbooks/status'));
  reached(rig, 'owner.intent.expiry.readback.attempted', checkpoint);
  assert.ok(rig.state().intentExpiryReadbackAttemptCount === 1,
    'failed cleanup must reach exactly one stored-row comparison before rollback');
  assert.ok(rig.state().pendingIntentCount === 33 && rig.state().temporaryIntentKeyCount === 66 &&
    rig.state().intentExpiryReadbackCount === 0, 'unproven expiry must roll back and remain recoverable');
  assert.ok((await rig.owner('/api/quickbooks/status')).ok, 'cleanup retry must recover after the readback fault');
  assert.ok(rig.state().pendingIntentCount === 1 && rig.state().temporaryIntentKeyCount === 2 &&
    rig.state().intentExpiryReadbackCount === 32 && rig.state().intentExpiryReadbackAttemptCount === 33,
    'one status decision cleans at most 32 overdue records after the failed comparison');
  assert.ok((await rig.owner('/api/quickbooks/status')).ok, 'next bounded cleanup must finish the backlog');
  assert.ok(rig.state().pendingIntentCount === 0 && rig.state().temporaryIntentKeyCount === 0 &&
    rig.state().intentExpiryReadbackCount === 33 && rig.state().intentExpiryReadbackAttemptCount === 34,
    'older intents must not retain orphaned keys');
  assert.ok((await rig.owner('/api/quickbooks/status')).ok && rig.state().intentExpiryReadbackCount === 33 &&
    rig.state().intentExpiryReadbackAttemptCount === 34,
    'repeated status must not rewrite terminal records');
});

test('OVERDUE_INTENT_KEEPS_KEYS mutant is killed by the stored-key expiry invariant', async () => {
  const ownerUrl = new URL('../testing/owner-runtime.mjs', import.meta.url);
  const adapterUrl = new URL('../implementation-adapter.mjs', import.meta.url);
  const ownerSource = await readFile(ownerUrl, 'utf8');
  const target = "const expired = terminalIntent(JSON.parse(row.value), 'expired');";
  assert.ok(ownerSource.split(target).length === 2, 'mutant must alter exactly the expiry key destruction');
  const absoluteImports = (source, base, replaceOwner) => source.replace(/from '([^']+)'/g, (statement, specifier) => {
    if (!specifier.startsWith('.')) return statement;
    return `from '${specifier === './testing/owner-runtime.mjs' && replaceOwner
      ? replaceOwner : new URL(specifier, base).href}'`;
  });
  const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const mutantOwner = dataModule(absoluteImports(ownerSource.replace(target,
    "const expired = { ...JSON.parse(row.value), ...terminalIntent(JSON.parse(row.value), 'expired') };"), ownerUrl));
  const mutantAdapter = await import(dataModule(absoluteImports(await readFile(adapterUrl, 'utf8'), adapterUrl, mutantOwner)));
  const exercise = async factory => {
    const rig = await createRig(factory);
    await rig.pending();
    rig.advance(599_999);
    assert.ok((await rig.owner('/api/quickbooks/status')).ok && rig.state().intentStatus === 'pending' &&
      rig.state().intentKeyCount === 2, 'valid pending intent is the mutant control');
    rig.advance(1);
    await expiredOwnerStatus(rig);
  };
  await exercise(await loadImplementation());
  await assert.rejects(() => exercise(mutantAdapter.createProbeAdapter),
    error => error.code === 'ERR_ASSERTION' && error.message === 'deadline cleanup must return verified status');
});
