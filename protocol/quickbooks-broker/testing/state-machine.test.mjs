import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// This is an executable specification oracle, never an owner or broker handler.
const machineURL = new URL('../v1/state-machine.json', import.meta.url);
const modelURL = new URL('./state-machine-model.mjs', import.meta.url);
let specification;
let model;
test('state specification and test-only interpreter exist', async () => {
  specification = JSON.parse(readFileSync(machineURL, 'utf8'));
  model = await import(modelURL);
  assert.equal(specification.protocol, 'qbo-broker/1');
});

test('every transition has a passing control and rejects every missing prerequisite', async () => {
  specification ??= JSON.parse(readFileSync(machineURL, 'utf8'));
  model ??= await import(modelURL);
  for (const [name, machine] of Object.entries(specification.machines)) {
    for (const edge of machine.transitions) {
      const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
      assert.equal(model.transition(specification, name, edge.from, edge.event, facts), edge.to);
      for (const guard of edge.requires) {
        assert.throws(() => model.transition(specification, name, edge.from, edge.event,
          { ...facts, [guard]: false }), /transition_refused/);
        const missing = { ...facts };
        delete missing[guard];
        assert.throws(() => model.transition(specification, name, edge.from, edge.event, missing), /transition_refused/);
      }
    }
  }
});

test('terminal states never restart consumed provider mutations', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  for (const [name, machine] of Object.entries(spec.machines)) {
    for (const state of machine.terminal) {
      for (const edge of machine.transitions) {
        const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
        assert.throws(() => transition(spec, name, state, edge.event, facts), /transition_refused/);
      }
    }
  }
});

test('connect cannot succeed before exact owner readback and signed receipt', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const edge = spec.machines.authorization.transitions.find(row => row.event === 'accept_receipt');
  const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
  assert.equal(transition(spec, 'authorization', edge.from, edge.event, facts), 'delivered');
  for (const guard of ['receipt_signature_valid', 'receipt_binding_exact', 'owner_readback_confirmed']) {
    assert.ok(edge.requires.includes(guard));
    assert.throws(() => transition(spec, 'authorization', edge.from, edge.event, { ...facts, [guard]: false }), /transition_refused/);
  }
});

test('lost refresh and unverified commit cannot restore the old generation', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const machine = spec.machines.owner_connection;
  for (const event of ['refresh_lost', 'refresh_invalid', 'refresh_commit_unverified']) {
    const edge = machine.transitions.find(row => row.event === event);
    assert.equal(transition(spec, 'owner_connection', edge.from, event,
      Object.fromEntries(edge.requires.map(key => [key, true]))), 'reauthorization_required');
  }
  assert.ok(!machine.transitions.some(row => row.from === 'reauthorization_required' && row.event === 'refresh'));
  const commit = machine.transitions.find(row => row.event === 'commit_refresh');
  for (const guard of ['replacement_present', 'company_binding_exact', 'generation_compare_and_swap', 'owner_readback_confirmed']) {
    assert.ok(commit.requires.includes(guard));
  }
});

test('revoke retry requires broker-verifiable not-sent proof; local destruction is honest', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const edges = spec.machines.owner_connection.transitions;
  const retry = edges.find(row => row.event === 'retry_revoke_not_sent');
  const facts = Object.fromEntries(retry.requires.map(key => [key, true]));
  assert.equal(transition(spec, 'owner_connection', retry.from, retry.event, facts), 'revoke_fenced');
  assert.ok(retry.requires.includes('not_sent_proof_verified'));
  assert.throws(() => transition(spec, 'owner_connection', retry.from, retry.event,
    { ...facts, not_sent_proof_verified: false }), /transition_refused/);
  const destroy = edges.find(row => row.event === 'destroy_local');
  assert.equal(transition(spec, 'owner_connection', destroy.from, destroy.event,
    Object.fromEntries(destroy.requires.map(key => [key, true]))), 'locally_destroyed');
  assert.notEqual(destroy.to, 'revoked');
});

test('unknown machines, states, events and nonboolean guard values fail closed with a valid control', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const edge = spec.machines.authorization.transitions[0];
  const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
  assert.equal(transition(spec, 'authorization', edge.from, edge.event, facts), edge.to);
  assert.throws(() => transition(spec, 'absent', edge.from, edge.event, facts), /transition_refused/);
  assert.throws(() => transition(spec, 'authorization', 'absent', edge.event, facts), /transition_refused/);
  assert.throws(() => transition(spec, 'authorization', edge.from, 'absent', facts), /transition_refused/);
  assert.throws(() => transition(spec, 'authorization', edge.from, edge.event,
    { ...facts, [edge.requires[0]]: 'true' }), /transition_refused/);
});

test('a finalized owner intent returns its saved receipt for the same delivery after key destruction', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const facts = { delivery_id_exact: true, envelope_digest_exact: true, stored_receipt_exact: true };
  assert.equal(transition(spec, 'owner_intent', 'complete', 'duplicate_delivery', facts), 'complete');
  assert.throws(() => transition(spec, 'owner_intent', 'complete', 'duplicate_delivery',
    { ...facts, envelope_digest_exact: false }), /transition_refused/);
});

test('deadline, delivery target, request binding and source retention obligations are explicit', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  for (const [machine, event, guards] of [
    ['authorization', 'exchange_success', ['callback_origin_pinned', 'no_redirects']],
    ['token_request', 'fence', ['environment_exact', 'response_delivery_key_valid']],
    ['owner_connection', 'destroy_local', ['source_reservation_retained']],
  ]) {
    const edge = spec.machines[machine].transitions.find(row => row.event === event);
    const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
    assert.equal(transition(spec, machine, edge.from, event, facts), edge.to);
    for (const guard of guards) {
      assert.ok(edge.requires.includes(guard), `required guard ${guard}`);
      assert.throws(() => transition(spec, machine, edge.from, event, { ...facts, [guard]: false }), /transition_refused/);
    }
  }
  for (const [event, state] of [['refresh_deadline_expired', 'active'], ['refresh_rejected', 'refresh_fenced']]) {
    const edge = spec.machines.owner_connection.transitions.find(row => row.event === event);
    assert.ok(edge, `required transition ${event}`);
    const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
    assert.equal(transition(spec, 'owner_connection', state, event, facts), 'reauthorization_required');
    assert.throws(() => transition(spec, 'owner_connection', state, event, {}), /transition_refused/);
  }
});

test('MUTANT UNFENCED_EXCHANGE is killed by the passing provider-contact invariant', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  function assertFenceRequired(candidate) {
    const edge = candidate.machines.authorization.transitions.find(row => row.event === 'exchange');
    const facts = Object.fromEntries(edge.requires.map(key => [key, true]));
    assert.equal(transition(candidate, 'authorization', edge.from, edge.event, facts), 'exchange_started');
    assert.throws(() => transition(candidate, 'authorization', edge.from, edge.event,
      { ...facts, exchange_fence_committed: false }), /transition_refused/);
  }
  assertFenceRequired(spec);
  const mutant = structuredClone(spec);
  const edge = mutant.machines.authorization.transitions.find(row => row.event === 'exchange');
  edge.requires = edge.requires.filter(guard => guard !== 'exchange_fence_committed');
  assert.throws(() => assertFenceRequired(mutant), { code: 'ERR_ASSERTION' });
});

test('no-contact proof is consumed once and completion receipts survive key destruction', async () => {
  const spec = JSON.parse(readFileSync(machineURL, 'utf8'));
  const { transition } = await import(modelURL);
  const retry = spec.machines.token_request.transitions.find(edge => edge.event === 'authorize_retry');
  assert.ok(retry, 'proof consumption is a durable decision');
  const facts = Object.fromEntries(retry.requires.map(key => [key, true]));
  assert.equal(transition(spec, 'token_request', 'not_sent', 'authorize_retry', facts), 'proof_consumed');
  assert.throws(() => transition(spec, 'token_request', 'proof_consumed', 'authorize_retry', facts), /transition_refused/);
  assert.throws(() => transition(spec, 'token_request', 'not_sent', 'authorize_retry',
    { ...facts, retry_decision_atomic: false }), /transition_refused/);
  for (const state of ['canceled', 'failed']) {
    const receiptFacts = { delivery_id_exact: true, envelope_digest_exact: true, stored_receipt_exact: true };
    assert.equal(transition(spec, 'owner_intent', state, 'duplicate_delivery', receiptFacts), state);
    assert.throws(() => transition(spec, 'owner_intent', state, 'duplicate_delivery',
      { ...receiptFacts, envelope_digest_exact: false }), /transition_refused/);
  }
});
