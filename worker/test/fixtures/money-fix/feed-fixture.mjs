import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, NOW } from './fixture.mjs';
import { createPlaidLinkToken, completePlaidLink, syncPlaidItem } from '../../../src/lib/plaid-bank-feed.js';
import { assignPlaidAccountEntity } from '../../../src/lib/plaid-account-entities.js';

export async function feedFixture({ type = 'loan', subtype = 'unknown', beforePromotion = null } = {}) {
  const f = fixture();
  Object.assign(f.env, {
    BANK_FEED_PROVIDER: 'plaid', BANK_FEED_ENV: 'sandbox',
    BANK_FEED_CLIENT_ID: randomBytes(16).toString('hex'),
    BANK_FEED_SECRET: randomBytes(24).toString('hex'),
    BANK_FEED_WRAPPING_KEY_V2: ['v2', randomBytes(32).toString('base64url')].join('.'),
  });
  const state = { calls: [], now: NOW, current: '250.00', page: {
    added: [], modified: [], removed: [], next_cursor: 'synthetic-cursor', has_more: false,
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  } };
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    state.calls.push(path);
    const responses = {
      '/link/token/create': { link_token: randomBytes(24).toString('hex'), expiration: '2099-10-11T13:00:00.000Z' },
      '/item/public_token/exchange': { item_id: 'synthetic-item', access_token: randomBytes(24).toString('hex') },
      '/item/get': { item: { item_id: 'synthetic-item', error: null } },
      '/accounts/get': { accounts: [{ account_id: 'synthetic-account', name: 'Owner account', type, subtype,
        balances: { current: state.current, iso_currency_code: 'USD' } }] },
      '/transactions/sync': state.page,
    };
    assert.ok(Object.hasOwn(responses, path));
    return new Response(JSON.stringify(responses[path]), { headers: { 'Content-Type': 'application/json' } });
  };
  const link = await createPlaidLinkToken(f.env, {
    url: 'https://brain.invalid/app/connect/bank', sessionRef: 'review-feed-fixture-0001', fetchImpl, now: NOW,
  });
  await completePlaidLink(f.env, { sessionRef: link.session_ref,
    publicToken: randomBytes(24).toString('hex'), fetchImpl, now: NOW });
  const run = () => syncPlaidItem(f.env, 'synthetic-item', { fetchImpl, now: state.now });
  await run();
  const assignment = f.first('SELECT account_ref FROM plaid_account_entity_assignments');
  assert.ok(assignment, 'synthetic sync reached assignment');
  await assignPlaidAccountEntity(f.env, {
    request_id: 'review-feed-assignment-0001', account_ref: assignment.account_ref, entity_slug: 'owner-company',
  }, { now: NOW });
  if (beforePromotion) await beforePromotion(f);
  await run();
  return { f, state, run };
}
