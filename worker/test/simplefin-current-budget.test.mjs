import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { claimSimpleFinAccess, assignSimpleFinAccountEntity, runSimpleFinMaintenance } from '../src/lib/simplefin-bank-feed.js';

const NOW = '2026-11-04T12:00:00.000Z';
const DAY = '2026-11-04';

async function fixture(t) {
  const f = await createProductFixture({env:{BANK_FEED_PROVIDER:'simplefin',BANK_FEED_ENV:'production',
    BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
  t.after(() => f.close());
  t.mock.method(globalThis, 'fetch', () => assert.fail('ambient network forbidden'));
  seedOwnedEntity(f, 'owner-business', 'Owner business');
  const access = new URL('https://bridge.invalid/access');
  access.username = 'fixture-user'; access.password = 'fixture-value';
  await claimSimpleFinAccess(f.env,{requestId:'budget-claim-request-0001',now:NOW,
    setupToken:btoa('https://bridge.invalid/claim'),fetchImpl:async () => new Response(access.href)});
  const calls = [];
  let mode = 'complete';
  const fetchImpl = async request => {
    const url = new URL(request.url);
    const start = Number(url.searchParams.get('start-date'));
    const end = Number(url.searchParams.get('end-date'));
    calls.push({start,end});
    if(mode === 'login') return new Response('',{status:401});
    return Response.json({errlist:mode === 'partial' ? ['Synthetic provider gap'] : [], accounts:[{
      id:'synthetic-account',name:'Checking 1234',currency:'USD',balance:'10.00',
      'balance-date':Date.parse(NOW)/1000,transactions:[{
        id:`event-${start}`,posted:start+43200,amount:'-1.00',description:'Fixture purchase',
      }],
    }]});
  };
  await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,maxRequestsPerItem:1});
  await assignSimpleFinAccountEntity(f.env,{request_id:'budget-assign-request-0001',
    account_ref:f.first('SELECT account_ref FROM simplefin_account_assignments').account_ref,
    entity_slug:'owner-business'},{now:NOW});
  calls.length = 0;
  f.raw('UPDATE simplefin_connections SET next_pull_at=?',NOW);
  f.raw('DELETE FROM bank_feed_health');
  return {f,calls,fetchImpl,setMode:value => {mode=value;}};
}

for (const budget of [1,3]) test(`daily current pull leaves all ${budget} historical request slots available`, async t => {
  const {f,calls,fetchImpl} = await fixture(t);
  const start = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  const result = await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,daily:true,maxRequestsPerItem:budget});
  assert.equal(result.items[0].ok,true);
  assert.equal(calls.length,budget+1,'one bounded current request plus the full history budget');
  assert.equal(calls[0].start,Date.parse(`${DAY}T00:00:00Z`)/1000-2*86400,'present activity is requested first');
  assert.equal(calls[1].start,Date.parse(`${start}T00:00:00Z`)/1000,'historical decision reached');
  assert.equal(result.items[0].pulls.filter(p => p.backfill).length,budget);
  assert.ok(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next>start);
  assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,NOW);
  assert.equal(f.first('SELECT requests_today FROM simplefin_connections').requests_today,budget+2);
});

test('ordinary one-request recovery retains its historical interval',async t => {
  const {f,calls,fetchImpl} = await fixture(t);
  const start = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  const result = await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,maxRequestsPerItem:1});
  assert.equal(result.items[0].ok,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].start,Date.parse(`${start}T00:00:00Z`)/1000);
  assert.ok(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next>start);
  assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,null,
    'a historical promotion cannot certify current health');
});

for (const mode of ['partial','login','limit']) test(`daily ${mode} preserves the cursor and a healthy control recovers`,async t => {
  const {f,calls,fetchImpl,setMode} = await fixture(t);
  const start = f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  if(mode === 'limit') f.raw('UPDATE simplefin_connections SET request_day=?,requests_today=24',DAY);
  else setMode(mode);
  const decisionStart = f.seen.sql.length;
  const result = await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,daily:true,maxRequestsPerItem:1});
  assert.ok(f.seen.sql.slice(decisionStart).some(sql => sql.includes('RETURNING request_day,requests_today')),'reservation decision reached');
  assert.equal(calls.length,mode === 'limit' ? 0 : 1);
  assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next,start);
  assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,null);
  if(mode === 'partial') assert.equal(result.items[0].partial,true);
  else assert.equal(result.items[0].ok,false);
  if(mode === 'login') {
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,daily:true,maxRequestsPerItem:1});
    assert.equal(calls.length,1,'sign-in state parks automatic retries');
    // Synthetic owner-repair state, never a live connection.
    f.raw("UPDATE bank_feed_items SET status='connected'");
  }
  const recoveryTime = mode === 'limit' ? '2026-11-05T12:00:00.000Z' : NOW;
  f.raw('UPDATE simplefin_connections SET next_pull_at=?',recoveryTime);
  setMode('complete');
  const recovered = await runSimpleFinMaintenance(f.env,{fetchImpl,now:recoveryTime,daily:true,maxRequestsPerItem:1});
  assert.equal(recovered.items[0].ok,true,'green control');
  assert.ok(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next>start);
});

test('daily current activity uses one request when history is caught up',async t => {
  const {f,calls,fetchImpl} = await fixture(t);
  for(let slice=0;f.first('SELECT backfill_next<=backfill_end AS pending FROM simplefin_connections').pending;slice++) {
    assert.ok(slice<10,'bounded historical green control');
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',NOW);
    assert.equal((await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW})).items[0].ok,true);
  }
  calls.length=0;
  f.raw('UPDATE simplefin_connections SET next_pull_at=?',NOW);
  const result=await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,daily:true,maxRequestsPerItem:1});
  assert.equal(result.items[0].ok,true);
  assert.equal(calls.length,1,'no redundant supplemental request without history debt');
  assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,NOW);
});

test('the final daily reservation cannot spend the next historical slot',async t => {
  const {f,calls,fetchImpl} = await fixture(t);
  const start=f.first('SELECT backfill_next FROM simplefin_connections').backfill_next;
  f.raw('UPDATE simplefin_connections SET request_day=?,requests_today=23',DAY);
  const decisionStart=f.seen.sql.length;
  const result=await runSimpleFinMaintenance(f.env,{fetchImpl,now:NOW,daily:true,maxRequestsPerItem:1});
  assert.equal(calls.length,1,'current read consumes the last durable reservation');
  assert.equal(result.items[0].code,'simplefin_daily_request_limit');
  assert.equal(f.seen.sql.slice(decisionStart).filter(sql=>sql.includes('RETURNING request_day,requests_today')).length,2,
    'both the successful current reservation and refused history decision were reached');
  assert.equal(f.first('SELECT requests_today FROM simplefin_connections').requests_today,24);
  assert.equal(f.first('SELECT backfill_next FROM simplefin_connections').backfill_next,start);
  assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,NOW,
    'the verified current observation survives the historical budget warning');
});
