import { bankRowHarness } from './bank-row-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { encryptAccessReference, handleBankFeed } from '../src/lib/bank-feed.js';
import { transactionUid } from '../src/lib/fin-import.js';
import { runPlaidFeedSlice, syncPlaidItem } from '../src/lib/plaid-bank-feed.js';
import { assignPlaidAccountEntity } from '../src/lib/plaid-account-entities.js';
import { sourceModuleHarness } from '../../test/helpers/source-module-harness.mjs';
const localMcp = await sourceModuleHarness(new URL('../../components/brain-mcp.mjs',import.meta.url));
import { queryMoney } from '../src/lib/money-query.js';
import { overviewMoney } from '../src/lib/money-overview.js';
import { handleMcp } from '../src/lib/mcp-endpoint.js';
import { waitForQuietFile } from './quiet-file.mjs';

const ambientFetch=globalThis.fetch;
let unexpectedFetches=0;
test.before(()=>{globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('ambient network forbidden');};});
test.after(()=>{globalThis.fetch=ambientFetch;assert.equal(unexpectedFetches,0);});

const START = '2026-10-28T12:00:00.000Z';
const DAY = '2026-10-29T12:00:00.000Z';
const OVERDUE = '2026-10-30T13:00:00.000Z';
const json = (body, status=200) => new Response(JSON.stringify(body), {status});
const dailyRequest=sync=>async(url,init)=>new URL(url).pathname==='/health' ? json({status:'ok'})
  : init.method==='GET' ? json({configured:true,connections:[]}) : sync(url,init);

async function bankOutcomeHarness() {
  const {transformSync}=await import('esbuild');
  const {runInNewContext}=await import('node:vm');
  const source=readFileSync(new URL('../../frontend/src/lib/bank-outcome.ts',import.meta.url),'utf8');
  const module={exports:{}};
  runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports});
  return module.exports.bankRowOutcome;
}

async function connected({fixture=null,itemRef='synthetic-item',accountId='synthetic-account',mask='1234',environment='sandbox'}={}) {
  const f = fixture || await createProductFixture({env:{ BANK_FEED_PROVIDER:'plaid', BANK_FEED_ENV:environment,
    BRAIN_TIMEZONE:'Etc/UTC',
    BANK_FEED_CLIENT_ID:'fixture-client', BANK_FEED_SECRET:'fixture-secret',
    BANK_FEED_WRAPPING_KEY_V2:['v2.', 'A'.repeat(43)].join('') }});
  const encrypted = await encryptAccessReference(f.env, ['fixture','access'].join('-'));
  f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
    VALUES ('primary',?,?,?,?,?,?)`,itemRef,encrypted.ciphertext,encrypted.iv,encrypted.keyVersion,environment,START);
  if (!f.first("SELECT id FROM fin_entities WHERE entity_slug='owner-business'")) seedOwnedEntity(f,'owner-business','Owner business');
  let login = false; const calls=[];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname; calls.push(path);
    if(login) return json({error_code:'ITEM_LOGIN_REQUIRED'},400);
    if(path==='/accounts/get') return json({accounts:[{account_id:accountId,name:'Checking',mask,
      type:'depository',subtype:'checking',balances:{current:'100.00',iso_currency_code:'USD'}}]});
    assert.equal(path,'/transactions/sync');
    return json({added:[{transaction_id:`${itemRef}-payment`,account_id:accountId,amount:'10.00',
      iso_currency_code:'USD',date:'2026-10-28',pending:false,name:'Fixture purchase'}],modified:[],removed:[],
      next_cursor:'synthetic-cursor',has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE'});
  };
  const held = await syncPlaidItem(f.env,itemRef,{fetchImpl,now:START});
  assert.equal(held.status,'assignment_required','real provider and assignment guard reached');
  const account = f.first('SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref=?',itemRef);
  await assignPlaidAccountEntity(f.env,{request_id:`assignment-${itemRef}`,account_ref:account.account_ref,entity_slug:'owner-business'},{now:START});
  await syncPlaidItem(f.env,itemRef,{fetchImpl,now:START});
  const ready=await syncPlaidItem(f.env,itemRef,{fetchImpl,now:START});
  assert.equal(ready.ok,true,'green control: committed current provider window');
  assert.equal(f.first('SELECT state FROM plaid_reconciliation WHERE item_ref=?',itemRef).state,'pending',
    'shipped successful sync rebooks pending work without a later webhook');
  assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_transactions WHERE source_feed=?',`bank-feed:${itemRef}`).n,1);
  return {f,fetchImpl,calls,setLogin:()=>{login=true;}};
}

test('promoted Plaid account has verified connection evidence in both money tools', async t => {
  const {f} = await connected({environment:'production'});
  t.after(() => f.close());
  const ledger = f.first('SELECT account_slug,external_ref,source_feed FROM fin_accounts');
  const assignment = f.first('SELECT account_ref,provider_account_id,item_ref FROM plaid_account_entity_assignments');
  assert.equal(ledger.external_ref, assignment.provider_account_id);
  assert.notEqual(ledger.external_ref, assignment.account_ref);
  assert.equal(ledger.source_feed, 'bank-feed:' + assignment.item_ref);
  assert.equal(f.first('SELECT last_synced_at FROM bank_feed_items').last_synced_at, START);

  const options = {now: () => Date.parse(START)};
  const missingConnection = /not connected|no verified successful sync time|discovered feed accounts/;
  const readOverview = () => overviewMoney(f.env, options);
  const query = {
    sql: "SELECT SUM(amount_minor) AS figure FROM txn WHERE posted_on BETWEEN '2026-10-28' AND '2026-10-28'",
    from: '2026-10-28', through: '2026-10-28',
  };
  const readQuery = () => queryMoney(f.env, query, options);
  await t.test('money overview', async () => {
    assert.equal((await readOverview()).accounts[0].last_observed_at, START);
    const observed = '2026-10-28T11:30:00.000Z';
    f.raw('UPDATE plaid_account_entity_assignments SET last_seen_at=?', observed);
    const overview = await readOverview();
    f.raw('UPDATE plaid_account_entity_assignments SET last_seen_at=?', START);
    assert.equal(overview.accounts.length, 1);
    assert.equal(overview.accounts[0].connected, true);
    assert.equal(overview.accounts[0].last_observed_at, observed);
    assert.equal(overview.accounts[0].last_sync, START);
    assert.doesNotMatch(overview.confidence_text, missingConnection);
  });
  await t.test('saved sync receipt is independent of connection status', async () => {
    try {
      f.raw('UPDATE plaid_account_entity_assignments SET last_seen_at=?', DAY);
      assert.equal((await readOverview()).accounts[0].last_sync, START);
    } finally {
      f.raw('UPDATE plaid_account_entity_assignments SET last_seen_at=?', START);
    }
  });

  await t.test('hosted tools preserve the promoted account and its connection evidence', async () => {
    const url = new URL('https://brain.invalid/mcp');
    const call = async (name, args) => {
      const response = await handleMcp(f.env, new Request(url, {
        method: 'POST',
        body: JSON.stringify({ id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }), url, { grant: { profile: 'librarian' } });
      const { result } = await response.json();
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    };
    const overview = await call('brain_money_overview', {});
    assert.equal(overview.accounts[0].account_slug, ledger.account_slug);
    assert.equal(overview.accounts[0].connected, true);
    assert.equal(overview.accounts[0].last_sync, START);
    assert.doesNotMatch(overview.confidence_text, missingConnection);
    assert.doesNotMatch((await call('brain_money_query', query)).confidence_text, missingConnection);
    try {
      f.raw("UPDATE bank_feed_items SET status='permission_revoked',status_detail='Permission revoked'");
      assert.equal((await call('brain_money_overview', {})).accounts[0].connected, false);
      assert.match((await call('brain_money_query', query)).confidence_text, /not connected/);
    } finally {
      f.raw("UPDATE bank_feed_items SET status='connected',status_detail=NULL");
    }
  });

  await t.test('money query', async () => {
    const result = await readQuery();
    assert.equal(result.rows[0].figure, 1000);
    assert.doesNotMatch(result.confidence_text, missingConnection);
  });

  await t.test('assignment observation cannot stand in for a sync receipt', async () => {
    f.raw('UPDATE bank_feed_items SET last_synced_at=NULL');
    try {
      const overview = await readOverview();
      assert.equal(overview.accounts[0].connected, true);
      assert.equal(overview.accounts[0].last_observed_at, START);
      assert.equal(overview.accounts[0].last_sync, null);
      assert.match(overview.confidence_text, /no verified successful sync time/);
      assert.match((await readQuery()).confidence_text, /no verified successful sync time/);
    } finally {
      f.raw('UPDATE bank_feed_items SET last_synced_at=?', START);
    }
  });

  await t.test('public Plaid replacement reference still connects', async () => {
    f.raw('UPDATE fin_accounts SET external_ref=?', assignment.account_ref);
    try {
      assert.equal((await readOverview()).accounts[0].connected, true);
      assert.doesNotMatch((await readQuery()).confidence_text, missingConnection);
    } finally {
      f.raw('UPDATE fin_accounts SET external_ref=?', ledger.external_ref);
    }
  });

  for (const [state, change, restore] of [
    ['disconnected', "SET status='removed',removed_at=last_synced_at,status_detail='Disconnected'",
      "SET status='connected',removed_at=NULL,status_detail=NULL"],
    ['revoked', "SET status='permission_revoked',status_detail='Permission revoked'", "SET status='connected',status_detail=NULL"],
    ['needs sign-in', "SET status='reauth_required',status_detail='Sign-in required'", "SET status='connected',status_detail=NULL"],
    ['another owner', "SET tenant_id='other'", "SET tenant_id='primary'"],
  ]) {
    await t.test(state, async () => {
      assert.equal((await readOverview()).accounts[0].connected, true);
      assert.doesNotMatch((await readQuery()).confidence_text, missingConnection);
      f.raw(`UPDATE bank_feed_items ${change}`);
      try {
        assert.equal((await readOverview()).accounts[0].connected, false);
        const result = await readQuery();
        assert.equal(result.rows[0].figure, 1000);
        assert.match(result.confidence_text, /not connected/);
        assert.match(result.confidence_text, /no verified successful sync time/);
      } finally {
        f.raw(`UPDATE bank_feed_items ${restore}`);
      }
    });
  }

  await t.test('provider ID from another connection cannot supply evidence', async () => {
    assert.equal((await readOverview()).accounts[0].connected, true);
    assert.doesNotMatch((await readQuery()).confidence_text, missingConnection);
    f.raw("UPDATE fin_accounts SET source_feed='bank-feed:other-connection'");
    assert.equal((await readOverview()).accounts[0].connected, false);
    const result = await readQuery();
    assert.match(result.confidence_text, /not connected/);
    assert.match(result.confidence_text, /no verified successful sync time/);
    assert.match(result.confidence_text, /1 discovered feed accounts have no current ledger account/);
    assert.equal(result.rows[0].figure, 1000);
  });
});

test('cross-Item Plaid reference collisions cannot lend connection or sync evidence', async t => {
  const {f} = await connected({itemRef:'collision-b',environment:'production',mask:'5678'});
  t.after(() => f.close());
  const other = f.first("SELECT account_ref,provider_account_id FROM plaid_account_entity_assignments WHERE item_ref='collision-b'");
  const seed = 297413;
  for (const [index, reference] of ['account_ref', 'provider_account_id'].entries()) {
    await t.test(reference, async () => {
      const item = `collision-${seed + index}`;
      const mask = String(4100 + index);
      // For the raw-ID sibling, switch B's test ID after promoting A so both
      // ledger accounts keep separate slugs and retained postings.
      const id = index ? item : other[reference];
      await connected({fixture:f,itemRef:item,accountId:id,mask,environment:'production'});
      if (index) {
        f.raw("UPDATE fin_accounts SET external_ref=? WHERE source_feed='bank-feed:collision-b'", other.account_ref);
        f.raw("UPDATE plaid_account_entity_assignments SET provider_account_id=? WHERE item_ref='collision-b'", id);
      }
      const account = f.first('SELECT account_slug,external_ref,source_feed FROM fin_accounts WHERE mask=?', mask);
      assert.equal(account.external_ref, id);
      assert.equal(account.source_feed, 'bank-feed:' + item);
      const options = {now: () => Date.parse(START)};
      const read = async () => {
        const overview = await overviewMoney(f.env, options);
        const query = await queryMoney(f.env, {
          sql: `SELECT SUM(amount_minor) AS figure FROM txn WHERE account_slug='${account.account_slug}' AND posted_on='2026-10-28'`,
          from:'2026-10-28',through:'2026-10-28',
        }, options);
        assert.equal(query.rows[0].figure, 1000);
        return {account:overview.accounts.find(a => a.account_slug === account.account_slug), query, overview};
      };
      const control = await read();
      assert.equal(control.account.connected, true);
      assert.equal(control.account.last_sync, START);
      assert.doesNotMatch(control.query.confidence_text, new RegExp(`Account ending ${mask} (?:is not connected|has no verified successful sync)`));
      f.raw("UPDATE bank_feed_items SET status='permission_revoked',status_detail='Permission revoked' WHERE item_ref=?", item);
      const challenged = await read();
      assert.equal(challenged.overview.accounts.find(a => a.last4 === '5678').connected, true);
      assert.equal(challenged.account.connected, false);
      assert.equal(challenged.account.last_sync, null);
      assert.match(challenged.query.confidence_text, new RegExp(`Account ending ${mask} is not connected`));
      assert.match(challenged.query.confidence_text, new RegExp(`Account ending ${mask} has no verified successful sync`));
    });
  }
});

test('R1B pending work over twelve hours late is visible without cron, then the laptop wakes sync',async()=>{
  const {f,fetchImpl,calls}=await connected();
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  try {
    f.raw("UPDATE plaid_reconciliation SET state='pending',due_at=?",'2026-10-28T23:00:00.000Z');
    const before=f.seen.sql.length;
    const status=await handleBankFeed(f.env,new Request('https://brain.invalid/api/bank-feed/status',{
      headers:{'X-Admin-Key':f.env.ADMIN_KEY}}),null,'/api/bank-feed/status',{bankFeedNow:DAY});
    const body=await status.json();
    assert.equal(body.connections.length,1,'read-only status decision reached');
    assert.equal(body.connections[0].health.overdue,true,'recent success cannot conceal twelve-hour queue stall');
    assert.equal(body.connections[0].health.pending_overdue,true);
    assert.match(body.connections[0].status_line,/12 hours/);
    assert.ok(f.seen.sql.slice(before).every(sql=>/^\s*(SELECT|WITH)/i.test(sql)),'status never writes');
    const paths=[];const providerBefore=calls.length;
    const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:f.env.ADMIN_KEY,now:()=>Date.parse(DAY),
      request:async(url,init)=>{
        const path=new URL(url).pathname;paths.push(path);
        if(path==='/health') return json({status:'ok'});
        return handleBankFeed(f.env,new Request(url,init),new URL(url),path,{bankFeedNow:DAY,bankFeedFetchImpl:fetchImpl});
      }});
    assert.ok(paths.includes('/api/bank-feed/status'),'laptop independently reads health');
    assert.ok(calls.length>providerBefore,'bounded wake reaches provider with cron never invoked');
    assert.equal(result.overdue_detected,1);
    assert.match(result.message,/overdue/i);
    assert.equal(result.complete,true,'verified recovery control');
    assert.ok(f.seen.sql.slice(before).some(sql=>sql.includes('INSERT INTO fin_exceptions')),'wake records stall before recovery');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
  } finally {f.close();}
});

test('R1B laptop reports paused Worker and stale data without attempting a write',async()=>{
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  for(const paused of [true,false]) {
    const paths=[];
    const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:['fixture','key'].join('-'),now:()=>Date.parse(OVERDUE),
      request:async(url,init)=>{
        const path=new URL(url).pathname;paths.push([path,init.method]);
        if(path==='/health') return json({status:paused ? 'paused-for-upgrade':'ok'});
        if(path==='/api/bank-feed/status') return json({configured:true,connections:[{institution_label:'Fixture bank',status:'connected',
          connected_at:START,health:{last_successful_sync_at:paused ? START : OVERDUE,data_through:paused ? '2026-10-28':'2026-10-30'},
          reconciliation:{state:'pending',due_at:'2026-10-30T18:00:00.000Z'}}]});
        return json({ran:0,items:[]});
      }});
    assert.ok(paths.some(([path])=>path==='/health'),'health decision reached');
    assert.equal(result.complete,!paused);
    if(paused) {
      assert.equal(paths.filter(([,method])=>method==='POST').length,0);
      assert.match(result.message,/paused-for-upgrade/);
      assert.equal(result.overdue_detected,1);
    } else assert.equal(paths.filter(([,method])=>method==='POST').length,1,'healthy control wakes sync');
  }
});

test('R1B bank status uses durable custody and outputs only the safe read-only projection',async()=>{
  const {cmdBankStatus,runCliCommandWithCredentialBoundary}=await import('../../brain.mjs');
  const output=[],calls=[],custody=[];
  const key=['fixture', 'private', 'key'].join('-');
  const result=await cmdBankStatus(['status','synthetic.manifest.json'],{
    loadManifest:()=>({m:{brain:{domain:'brain.invalid'},operations:{admin_key_secret:'keychain://fixture-brain-admin/owner'}}}),
    resolveAdminKey:(path,options)=>{custody.push([path,options]);return key;},
    now:()=>Date.parse(OVERDUE),write:line=>output.push(line),request:async(url,init)=>{
      calls.push([new URL(url).pathname,init.method]);
      assert.equal(init.headers['X-Admin-Key'],key);
      if(new URL(url).pathname==='/health') return json({status:'paused-for-upgrade',internal_id:'must-stay-private'});
      return json({configured:true,connections:[{item_ref:'must-stay-private',institution_label:'Fixture bank',status:'reauth_required',
        connected_at:START,health:{last_successful_sync_at:START,data_through:'2026-10-28',last_error_code:'ITEM_LOGIN_REQUIRED'},
        reconciliation:{state:'retryable',due_at:DAY},accounts_needing_owner:2}]});
    }});
  assert.equal(custody.length,1,'declared durable-key resolution reached');
  assert.equal(custody[0][1].ignoreEnvironment,true);
  assert.deepEqual(calls,[['/health','GET'],['/api/bank-feed/status','GET']]);
  const text=output.join('\n');
  for(const pattern of [/Fixture bank/,/reauth_required/,/2026-10-28T12:00/,/2026-10-29T12:00/,/overdue: yes/i,/needs sign-in: yes/i,/owner: 2/i,/paused-for-upgrade/]) assert.match(text,pattern);
  assert.equal(text.includes(key),false);assert.equal(text.includes('must-stay-private'),false);
  assert.equal(JSON.stringify(result).includes('must-stay-private'),false);
  let boundary=0;
  await runCliCommandWithCredentialBoundary('bank',()=>{boundary++;},{withWranglerSession:()=>{throw new Error('credential helper forbidden');}});
  assert.equal(boundary,1,'CLI entry bypasses control-plane credentials');
});

test('R1B failed wake keeps the laptop overdue warning and failure receipt',async()=>{
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  for(const failure of ['http','transport']) {
    let writes=0;
    const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:['fixture','key'].join('-'),now:()=>Date.parse(OVERDUE),
      request:async(url,init)=>{
        if(new URL(url).pathname==='/health') return json({status:'ok'});
        if(init.method==='GET') return json({configured:true,connections:[{status:'connected',connected_at:START,
          health:{last_successful_sync_at:START,overdue:false},reconciliation:{state:'pending',due_at:DAY}}]});
        writes++;
        if(failure==='transport') throw new Error('synthetic transport failure');
        return json({error:'synthetic unavailable'},503);
      }});
    assert.equal(writes,1,'failed bounded wake decision reached');
    assert.equal(result.complete,false);
    assert.equal(result.overdue_detected,1,'laptop clock overrides a stale server flag');
    assert.match(result.message,/48 hours/);
    assert.match(result.message,/could not complete/);
  }
  const green=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:['fixture','key'].join('-'),
    request:dailyRequest(async()=>json({ran:0,items:[]}))});
  assert.equal(green.complete,true,'healthy readback control');
});

test('R1B CLI dispatcher reads synthetic file-backed status without host credentials',async()=>{
  const {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync}=await import('node:fs');
  const {join,resolve}=await import('node:path');
  const {randomBytes}=await import('node:crypto');
  const {spawnSync}=await import('node:child_process');
  const {pathToFileURL}=await import('node:url');
  const {tmpdir}=await import('node:os');
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'bank-status-')));
  mkdirSync(join(root,'bin'));
  const launchctl=join(root,'bin','launchctl');
  writeFileSync(launchctl,'#!/bin/sh\nexit 99\n',{mode:0o700});
  const manifest=join(root,'manifest.json');
  writeFileSync(manifest,JSON.stringify({brain:{domain:'brain.invalid'},operations:{}}));
  const key=randomBytes(24).toString('hex');
  writeFileSync(join(root,'.brain-admin-key'),key,{mode:0o600});
  const hook=join(root,'offline.mjs');
  writeFileSync(hook,`import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,appendFileSync} from 'node:fs';
const deny=()=>{throw new Error('host helper forbidden');};
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[method]=deny;
syncBuiltinESMExports();
const key=readFileSync(new URL('./.brain-admin-key',import.meta.url),'utf8');
globalThis.fetch=async(url,options)=>{
 const path=new URL(url).pathname;
 if(new URL(url).origin!=='https://brain.invalid' || options.method!=='GET' ||
   new Headers(options.headers).get('X-Admin-Key')!==key) throw new Error('unexpected request');
 appendFileSync(new URL('./calls.txt',import.meta.url),path+'\\n');
 if(path==='/health') return new Response(JSON.stringify({status:'ok'}));
 if(path!=='/api/bank-feed/status') throw new Error('network forbidden');
 return new Response(JSON.stringify({configured:true,connections:[
 {item_ref:'private-connection-marker',institution_label:'Bank 1111',status:'reauth_required',connected_at:'2026-10-28T12:00:00.000Z',
  health:{last_successful_sync_at:'2026-10-28T12:00:00.000Z',last_error_code:'ITEM_LOGIN_REQUIRED'},accounts_needing_owner:0},
 {institution_label:'Bank 2222',status:'connected',connected_at:'2026-10-28T12:00:00.000Z',
  health:{last_successful_sync_at:'2026-10-28T12:00:00.000Z'},accounts_needing_owner:1},
 {institution_label:'Bank 3333',status:'connected',connected_at:'2026-10-28T12:00:00.000Z',
  health:{last_successful_sync_at:'2026-10-28T12:00:00.000Z'},accounts_needing_owner:0}]}));
};`);
  waitForQuietFile();
  const child=spawnSync(process.execPath,['--import',pathToFileURL(hook).href,resolve('brain.mjs'),'bank','status',manifest,'--json'],{
    encoding:'utf8',timeout:8000,env:{HOME:root,USERPROFILE:root,PATH:join(root,'bin'),TMPDIR:root,TMP:root,TEMP:root,
      BRAIN_NO_WRANGLER_LOGIN:'1',BRAIN_TEST_LAUNCHCTL:launchctl,
      ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),
      ...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{})},
  });
  assert.equal(child.status,0,'real dispatcher completes with all host helpers forbidden');
  assert.deepEqual(readFileSync(join(root,'calls.txt'),'utf8').trim().split('\n'),['/health','/api/bank-feed/status']);
  const result=JSON.parse(child.stdout);
  assert.equal(result.connections.length,3,'real CLI prints all three synthetic logins');
  assert.equal(result.connections[0].bank,'Bank 1111');
  assert.match(result.connections[0].health_line,/sign in again.*Repair connection/i);
  assert.match(result.connections[1].health_line,/choose.*owner.*on the Connect a bank page/i);
  assert.match(result.connections[2].health_line,/48 hours.*Wait for the next sync/i);
  assert.doesNotMatch(child.stdout,/contact support|Disconnect/i);
  assert.equal(child.stdout.includes(key),false);
  assert.equal(child.stdout.includes('private-connection-marker'),false);
});

test('R1B Repair preserves accounts and catch-up uses the stored cursor without duplicate money',async()=>{
  const {createPlaidLinkToken,completePlaidLink}=await import('../src/lib/plaid-bank-feed.js');
  const {f,fetchImpl}=await connected();
  try {
    const accounts=f.rows('SELECT account_slug,source_feed,mask FROM fin_accounts ORDER BY account_slug');
    assert.equal(accounts.length,1,'existing ledger account control');
    const failure=await syncPlaidItem(f.env,'synthetic-item',{now:DAY,
      fetchImpl:async()=>json({error_code:'ITEM_LOGIN_REQUIRED'},400)});
    assert.equal(failure.ok,false,'real sign-in failure reached');
    const paths=[];
    const repair=async(url,init)=>{
      const path=new URL(url).pathname;paths.push(path);
      if(path==='/link/token/create') return json({link_token:['fixture','link'].join('-'),expiration:OVERDUE});
      assert.equal(path,'/item/get');
      return json({item:{item_id:'synthetic-item',error:null}});
    };
    const link=await createPlaidLinkToken(f.env,{url:'https://brain.invalid/app/connect/bank',mode:'reauthorise',
      itemRef:'synthetic-item',sessionRef:'synthetic-owner-repair-0001',fetchImpl:repair,now:DAY});
    const repaired=await completePlaidLink(f.env,{sessionRef:link.session_ref,fetchImpl:repair,now:DAY});
    assert.equal(repaired.health_verified,true);
    assert.equal(repaired.exchanged,false);
    assert.deepEqual(paths,['/link/token/create','/item/get']);
    assert.deepEqual(f.rows('SELECT account_slug,source_feed,mask FROM fin_accounts ORDER BY account_slug'),accounts);
    const cursors=[];
    const catchup=async(url,init)=>{
      if(new URL(url).pathname!=='/transactions/sync') return fetchImpl(url,init);
      cursors.push(JSON.parse(init.body).cursor);
      return json({added:[{transaction_id:'synthetic-item-payment',account_id:'synthetic-account',amount:'10.00',
        iso_currency_code:'USD',date:'2026-10-28',pending:false,name:'Fixture purchase'},
        {transaction_id:'synthetic-gap-payment',account_id:'synthetic-account',amount:'20.00',
        iso_currency_code:'USD',date:'2026-10-29',pending:false,name:'Fixture purchase'}],modified:[],removed:[],
        next_cursor:'synthetic-catchup-cursor',has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE'});
    };
    for(let i=0;i<2;i++) assert.equal((await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:catchup,now:OVERDUE})).ok,true);
    assert.deepEqual(cursors,['synthetic-cursor','synthetic-catchup-cursor'],'stored cursor advances only after committed catch-up');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_transactions').n,2,'txn_uid upsert keeps replay unique');
    assert.deepEqual(f.rows('SELECT account_slug,source_feed,mask FROM fin_accounts ORDER BY account_slug'),accounts);
    const money=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-11-01'},
      {now:()=>Date.parse(OVERDUE)});
    assert.equal(money.rows[0].total,3000);
    assert.equal(money.confidence.percent,40,'candidate selection score remains the stricter ceiling');
    assert.match(money.confidence.reasons.join(' '),/2026-10-30.*1234/);
  } finally {f.close();}
});

test('R1B bank status failures retain the existing content-free support record',async()=>{
  const {previewSupportEvent}=await import('../../support-journal.mjs');
  const options={now:()=>new Date(DAY)};
  const control=previewSupportEvent({command:'health',source:'brain-data-plane',errorCode:'HEALTH_CHECK_FAILED'},options);
  assert.equal(control.command,'health','existing support decision reached');
  const event=previewSupportEvent({command:'bank',source:'brain-data-plane',errorCode:'HEALTH_CHECK_FAILED'},options);
  assert.equal(event.command,'bank');
  const projected=previewSupportEvent({command:'bank',source:'brain-data-plane',errorCode:'HEALTH_CHECK_FAILED',content:'fixture content'},options);
  assert.equal('content' in projected,false,'projection cannot retain caller content');
  assert.equal(JSON.stringify(projected).includes('fixture content'),false);
});

test('R1B missing provider settings retain saved health and the laptop stall warning',async()=>{
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  for(const setting of ['BANK_FEED_SECRET','BANK_FEED_PROVIDER']) {
    const {f,fetchImpl}=await connected();
    try {
      delete f.env[setting];
      f.raw("UPDATE plaid_reconciliation SET state='pending',due_at=?",'2026-10-28T23:00:00.000Z');
      const paths=[];
      const request=async(url,init)=>{
        const path=new URL(url).pathname;paths.push(path);
        if(path==='/health') return json({status:'ok'});
        return handleBankFeed(f.env,new Request(url,init),new URL(url),path,{bankFeedNow:DAY,bankFeedFetchImpl:fetchImpl});
      };
      const response=await request('https://brain.invalid/api/bank-feed/status',{method:'GET',headers:{'X-Admin-Key':f.env.ADMIN_KEY}});
      const status=await response.json();
      assert.equal(response.status,200,'stored status decision reached with missing settings');
      assert.equal(status.connections.length,1,setting);
      assert.equal(status.connections[0].health.overdue,true,setting);
      const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:f.env.ADMIN_KEY,request,now:()=>Date.parse(DAY)});
      assert.ok(paths.includes('/api/bank-feed/sync'),'bounded wake decision reached');
      assert.equal(result.overdue_detected,1,setting);
      assert.equal(status.configured,false);
      assert.equal(result.complete,false);
      assert.match(result.message,/not configured/);
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1,
        'authenticated daily wake records the stall even when provider settings prevent sync');
    } finally {f.close();}
  }
});

test('R1B Banks renders plain health and sign-in text for the owner',async()=>{
  const {readFileSync}=await import('node:fs');
  const {transformSync}=await import('esbuild');
  const {runInNewContext}=await import('node:vm');
  const source=readFileSync(new URL('../../frontend/src/components/Settings.tsx',import.meta.url),'utf8');
  const start=source.indexOf('export function BankConnectionsSection(');
  const end=source.indexOf('\nexport function ',start+1);
  const jsx=source.slice(start,end);
  const compiled=transformSync(jsx,{loader:'tsx',format:'cjs',jsx:'transform'}).code;
  const module={exports:{}};
  runInNewContext(compiled,{module,exports:module.exports,
    ...bankRowHarness({Date:class extends Date {static now(){return Date.parse(OVERDUE);}}}),
    bankRowOutcome:await bankOutcomeHarness(),Date:class extends Date {static now(){return Date.parse(OVERDUE);}},
    Section:'section',Note:'note',Attention:'attention',Empty:'empty',Row:'row',Chip:'chip',Confirm:'confirm',
    agoISO:value=>value,DISCONNECT_BANK_QUESTION:'Disconnect this bank?'});
  for(const [signIn,configured] of [[true,true],[false,true],[true,false]]) {
    const tree=module.exports.BankConnectionsSection({readState:'ready',busy:false,onDisconnect:()=>{},banks:{configured,
      connections:[{item_ref:'synthetic-item',institution_label:'Fixture bank',status:signIn?'reauth_required':'connected',
        health:{state:signIn?'login_required':'healthy',needs_sign_in:signIn},status_line:signIn ? 'Your bank needs you to sign in again.' : 'Bank connection is up to date.'}],needs_attention:[]}});
    const text=JSON.stringify(tree);
    assert.match(text,/Fixture bank/,'real component rendering reached');
    assert.equal(text.includes('Your bank needs you to sign in again.'),signIn);
    assert.equal(text.includes('Bank connection is up to date.'),!signIn);
    assert.equal(text.includes('PROBLEM'),signIn,'health itself drives attention');
  }
});

test('R2 the app shell serves the generated Banks health UI',async()=>{
  const { handleOwnerAuth }=await import('../src/lib/owner-auth.js');
  const { APP_BUNDLE_ID, APP_JS }=await import('../src/lib/app-assets.js');
  const pageUrl=new URL('https://brain.invalid/app');
  const shell=await handleOwnerAuth({},new Request(pageUrl),pageUrl,pageUrl.pathname);
  assert.equal(shell.status,200,'real app shell decision reached');
  assert.ok((await shell.text()).includes(APP_BUNDLE_ID),'shell selects the reviewed bundle');
  const assetUrl=new URL('/app/assets/app.js',pageUrl);
  const asset=await handleOwnerAuth({},new Request(assetUrl),assetUrl,assetUrl.pathname);
  assert.equal(asset.status,200,'real served asset decision reached');
  assert.equal(await asset.text(),APP_JS,'green control: exact generated bytes served');
  assert.ok(APP_JS.includes('Repair connection'),'existing Banks view control');
  assert.ok(APP_JS.includes('status_line'),'served Banks view reads the health line');
  assert.ok(APP_JS.includes('.overdue'),'served Banks view recognizes the overdue state');
  assert.ok(APP_JS.includes('answer_contract'),'F4 completed-answer branch remains in the served bytes');
  assert.ok(APP_JS.includes('Missing:') && APP_JS.includes('Confidence:'),'F4 confidence and missing-evidence rendering remains served');
  assert.ok(APP_JS.includes('Bank syncing is not configured.'),'served missing-settings state');
  assert.ok(APP_JS.includes('/app/connect/bank#accounts') && APP_JS.includes('Choose owners'),'served owner-choice next step');
  assert.ok(APP_JS.includes('Your bank needs you to sign in again.') && APP_JS.includes('Repair connection'));
});

test('R2 CLI prerequisite has no POSIX shell or machine quiet-file default',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(import.meta.filename,'utf8');
  const start=source.indexOf("test('R1B CLI dispatcher");
  const end=source.indexOf("\ntest(",start+1);
  const dispatcher=source.slice(start,end);
  assert.ok(dispatcher.includes('real dispatcher completes'),'real dispatcher assertion reached');
  assert.ok(dispatcher.includes('BRAIN_NO_WRANGLER_LOGIN'),'credential isolation control');
  assert.equal(/spawnSync\(['"]\/bin\/sh/.test(dispatcher),false,'no unportable shell prerequisite');
  assert.equal(/while \[ -e \/Users\//.test(dispatcher),false,'no machine-specific quiet locator');
  assert.equal(/join\(process\.env\.HOME/.test(dispatcher),false,'scratch creation supports hosts without a POSIX HOME');
});

test('R2 quiet-file prerequisite uses only the environment and portable waits',()=>{
  const prior=process.env.BRAIN_TEST_QUIET_FILE;
  try {
    delete process.env.BRAIN_TEST_QUIET_FILE;
    let reads=0;
    waitForQuietFile({exists:()=>{reads++;return true;},wait:()=>{throw new Error('unexpected wait');}});
    assert.equal(reads,0,'no machine default when environment is absent');
    process.env.BRAIN_TEST_QUIET_FILE='synthetic quiet file';
    const paths=[],waits=[];
    waitForQuietFile({exists:path=>{paths.push(path);return paths.length<3;},wait:ms=>waits.push(ms)});
    assert.deepEqual(paths,['synthetic quiet file','synthetic quiet file','synthetic quiet file'],'environment decision reached');
    assert.deepEqual(waits,[60_000,60_000],'green control: wait until quiet file disappears without a shell');
  } finally {
    if(prior===undefined)delete process.env.BRAIN_TEST_QUIET_FILE;else process.env.BRAIN_TEST_QUIET_FILE=prior;
  }
});

test('R2 signed webhook retains provider cooldown and debt through expiry',async()=>{
  const {handlePlaidWebhook}=await import('../src/lib/plaid-bank-feed.js');
  const {f,fetchImpl}=await connected();
  let attempts=0;
  const throttle=async()=>{attempts++;return new Response(JSON.stringify({error_code:'RATE_LIMIT_EXCEEDED'}),{
    status:429,headers:{'Retry-After':'600'}});};
  try {
    const failed=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:throttle,now:DAY});
    assert.equal(failed.ok,false);assert.equal(attempts,1,'real rate-limited provider call reached');
    const floor=f.first('SELECT due_at FROM plaid_reconciliation').due_at;
    assert.ok(floor>='2026-10-29T12:10:00.000Z');
    const quiet=await runPlaidFeedSlice(f.env,{fetchImpl:throttle,now:'2026-10-29T12:00:30.000Z'});
    assert.equal(quiet.ran,0,'green control: no webhook, no early call');
    const at='2026-10-29T12:01:00.000Z';
    const raw=JSON.stringify({item_id:'synthetic-item',webhook_type:'TRANSACTIONS',webhook_code:'SYNC_UPDATES_AVAILABLE'});
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='synthetic-webhook-key';
    const b64=value=>Buffer.from(value).toString('base64url');
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))).toString('hex');
    const signed=[b64(JSON.stringify({alg:'ES256',kid:jwk.kid,typ:'JWT'})),
      b64(JSON.stringify({iat:Date.parse(at)/1000,request_body_sha256:hash}))].join('.');
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(signed));
    let keyReads=0;
    const webhook=await handlePlaidWebhook(f.env,new Request('https://brain.invalid/api/webhooks/plaid',{
      method:'POST',body:raw,headers:{'Plaid-Verification':`${signed}.${b64(signature)}`}}),{
      now:at,fetchImpl:async url=>{assert.equal(new URL(url).pathname,'/webhook_verification_key/get');keyReads++;return json({key:jwk});}});
    assert.equal(webhook.status,200,'signed webhook accepted through production path');
    assert.equal(keyReads,1);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_webhook_events').n,1);
    assert.equal(f.first('SELECT state FROM plaid_reconciliation').state,'pending','webhook work remains durable');
    const statusUrl=new URL('https://brain.invalid/api/bank-feed/status');
    const statusResponse=await handleBankFeed(f.env,new Request(statusUrl,{headers:await f.ownerHeaders()}),statusUrl,
      statusUrl.pathname,{bankFeedNow:at});
    assert.equal(statusResponse.status,200,'status readback decision reached');
    const statusBody=await statusResponse.json();
    assert.equal(statusBody.connections[0].reconciliation.due_at,floor,'status exposes the effective cooldown');
    assert.equal(statusBody.connections[0].health.next_due_at,floor,'health uses the same provider floor');
    const after=await runPlaidFeedSlice(f.env,{fetchImpl:throttle,now:at,daily:true});
    assert.equal(after.ran,0,'webhook cannot shorten provider cooldown');
    assert.equal(attempts,1,'no early second provider call');
    const manual=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:throttle,now:at});
    assert.equal(manual.code,'PLAID_SYNC_COOLDOWN','final call boundary also enforces cooldown');
    assert.equal(attempts,1);
    const resumed=await runPlaidFeedSlice(f.env,{fetchImpl,now:floor});
    assert.equal(resumed.ran,1,'green control: webhook debt runs after expiry');
    assert.equal(resumed.items[0].ok,true);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,1,'no duplicate money after catch-up');
  } finally {f.close();}
});

for(const status of [401,403]) test(`R2 SimpleFIN ${status} owner Repair resumes the saved connection`,async()=>{
  const {runSimpleFinMaintenance}=await import('../src/lib/simplefin-bank-feed.js');
  const f=await createProductFixture({env:{BANK_FEED_PROVIDER:'simplefin',BANK_FEED_ENV:'production',
    BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
  let broken=false,catchup=false,pulls=0,claims=0,repairFault='';
  const claimUrl=new URL('https://bridge.invalid/claim');claimUrl.username='fixture';claimUrl.password='fixture-value';
  const accessUrl=new URL('https://bridge.invalid/access');accessUrl.username='fixture';accessUrl.password='fixture-value';
  const fetchImpl=async input=>{
    const request=new Request(input);
    if(request.method==='POST'){claims++;return new Response(accessUrl.href);}
    pulls++;
    if(broken)return new Response('',{status});
    if(repairFault==='disconnect')f.raw("UPDATE bank_feed_items SET status='removed',removed_at=?",OVERDUE);
    if(repairFault==='omitted')return json({errors:[],accounts:[]});
    return json({errors:repairFault==='partial'?['Synthetic provider warning']:[],accounts:[{id:'synthetic-sf-account',
      conn_id:repairFault==='identity'?'different-bridge':'synthetic-bridge',name:'Checking 5678',
      currency:'USD',balance:'100.00','balance-date':Math.floor(Date.parse(DAY)/1000),transactions:[
        {id:'synthetic-sf-purchase',posted:Math.floor(Date.parse(START)/1000),amount:'-10.00',description:'Fixture purchase'},
        ...(catchup?[{id:'synthetic-sf-catchup',posted:Math.floor(Date.parse(DAY)/1000),amount:'-20.00',description:'Fixture purchase'}]:[])]
        .filter(row=>row.posted>=Number(new URL(request.url).searchParams.get('start-date')) &&
          row.posted<Number(new URL(request.url).searchParams.get('end-date')))}]});
  };
  const route=async(path,body,at,headers=null)=>{
    if(headers===null)headers=await f.ownerHeaders();
    const url=new URL(path,'https://brain.invalid');
    return handleBankFeed(f.env,new Request(url,{method:body?'POST':'GET',headers,
      ...(body?{body:JSON.stringify(body)}:{})}),url,url.pathname,{bankFeedNow:at,bankFeedFetchImpl:fetchImpl});
  };
  try {
    seedOwnedEntity(f,'owner-business','Owner business');
    const claim=await route('/api/bank-feed/simplefin/claim',{request_id:`synthetic-sf-repair-${status}`,setup_token:Buffer.from(claimUrl.href).toString('base64')},START);
    assert.equal(claim.status,201,'green control: original owner claim works');
    const itemRef=(await claim.json()).item_ref;
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,maxRequestsPerItem:1,daily:true});
    const account=f.first('SELECT account_ref FROM simplefin_account_assignments');assert.ok(account);
    const assigned=await route('/api/bank-feed/accounts/assign',{request_id:`synthetic-sf-owner-${status}`,account_ref:account.account_ref,entity_slug:'owner-business'},START);
    assert.equal(assigned.status,201);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,1,'saved transaction control');
    const priorSync=f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at;
    const accounts=f.rows('SELECT account_slug,external_ref,entity_slug,source_feed FROM fin_accounts');
    const assignments=f.rows('SELECT account_ref,provider_account_id,entity_slug,connection_id,source_account_id FROM simplefin_account_assignments');
    const ids=f.rows('SELECT id,txn_uid,amount_minor FROM fin_transactions');
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
    broken=true;const before=pulls;
    const failed=await runSimpleFinMaintenance(f.env,{fetchImpl,now:DAY,maxRequestsPerItem:1,daily:true});
    assert.equal(failed.items[0].code,'simplefin_login_required','real sign-in failure reached');
    assert.equal(pulls,before+1);
    assert.equal((await runSimpleFinMaintenance(f.env,{fetchImpl,now:OVERDUE})).ran,0);
    assert.equal(pulls,before+1,'stored sign-in state prevents another automatic provider attempt');
    const repairPath='/api/bank-feed/simplefin/repair';
    const beforeUnauthorised=pulls;
    const unauthorized=await route(repairPath,{item_ref:itemRef},OVERDUE,{});
    assert.equal(unauthorized.status,401,'owner authorization is enforced');
    assert.equal(pulls,beforeUnauthorised,'unauthorised route reaches no provider');
    const repairFail=await route(repairPath,{item_ref:itemRef},OVERDUE);
    assert.equal(repairFail.status,502,'failed access check cannot resume polling');
    assert.equal(f.first('SELECT status FROM bank_feed_items').status,'reauth_required');
    broken=false;catchup=true;
    const page=await route(`/app/connect/bank?mode=reauthorise&item_ref=${encodeURIComponent(itemRef)}`,null,OVERDUE);
    assert.equal(page.status,200);
    const html=await page.text();
    assert.ok(html.includes('/api/bank-feed/simplefin/repair'),'Repair page targets saved-connection route');
    for(const fault of ['partial','omitted','identity','disconnect']) {
      repairFault=fault;const beforeFault=pulls;
      const rejected=await route(repairPath,{item_ref:itemRef},OVERDUE);
      assert.equal(pulls,beforeFault+1,`${fault}: access-verification decision reached`);
      assert.equal(rejected.status,409,`${fault}: incomplete or superseded access cannot reactivate`);
      assert.equal(f.first('SELECT status FROM bank_feed_items').status,fault==='disconnect'?'removed':'reauth_required');
      assert.deepEqual(f.rows('SELECT id,txn_uid,amount_minor FROM fin_transactions'),ids);
      if(fault==='disconnect')f.raw("UPDATE bank_feed_items SET status='reauth_required',removed_at=NULL");
    }
    repairFault='';
    const budget=f.first('SELECT request_day,requests_today FROM simplefin_connections');
    f.raw('UPDATE simplefin_connections SET request_day=?,requests_today=24',OVERDUE.slice(0,10));
    const beforeBudget=pulls;
    assert.equal((await route(repairPath,{item_ref:itemRef},OVERDUE)).status,429);
    assert.equal(pulls,beforeBudget,'daily provider budget applies to owner Repair');
    f.raw('UPDATE simplefin_connections SET request_day=?,requests_today=?',budget.request_day,budget.requests_today);
    f.env.VECTOR_DRAIN_MODE='paused-for-upgrade';
    assert.equal((await route(repairPath,{item_ref:itemRef},OVERDUE)).status,503);
    assert.equal(pulls,beforeBudget,'upgrade pause applies to owner Repair');
    delete f.env.VECTOR_DRAIN_MODE;
    const repaired=await route(repairPath,{item_ref:itemRef},OVERDUE);
    assert.equal(repaired.status,200,'owner-authorized saved-access verification recovers connection');
    assert.equal((await repaired.json()).health_verified,true);
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,priorSync,
      'access verification cannot claim that missing bank days have synced');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_exceptions WHERE resolved_at IS NULL').n,1,
      'access verification preserves the operational exception until a current sync');
    assert.equal(claims,1,'Repair never claims another item');
    assert.equal(f.first('SELECT COUNT(*) n FROM bank_feed_items').n,1);
    assert.deepEqual(f.rows('SELECT account_slug,external_ref,entity_slug,source_feed FROM fin_accounts'),accounts);
    assert.deepEqual(f.rows('SELECT account_ref,provider_account_id,entity_slug,connection_id,source_account_id FROM simplefin_account_assignments'),assignments);
    assert.deepEqual(f.rows('SELECT id,txn_uid,amount_minor FROM fin_transactions'),ids,'access check does not rewrite money');
    const resumed=await runSimpleFinMaintenance(f.env,{fetchImpl,now:OVERDUE,maxRequestsPerItem:1,daily:true});
    assert.equal(resumed.ran,1,'bounded current catch-up resumes');assert.equal(resumed.items[0].ok,true);
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,OVERDUE);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_exceptions WHERE resolved_at IS NULL').n,0,
      'green control: verified current catch-up resolves the exception');
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',OVERDUE);
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:OVERDUE,maxRequestsPerItem:1,daily:true});
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,2,'replayed catch-up stays unique');
    assert.equal(f.first('SELECT SUM(amount_minor) n FROM fin_transactions').n,3000);
    assert.deepEqual(f.rows('SELECT id,txn_uid,amount_minor FROM fin_transactions ORDER BY id LIMIT 1'),ids);
  } finally {f.close();}
});

test('defence in depth only: a synthetic settled receipt is pulled after 24 hours',async()=>{
  const {f,fetchImpl,calls}=await connected();
  try {
    // No shipped writer creates this state. Exercise only the defensive fallback.
    f.raw("UPDATE plaid_reconciliation SET state='complete',due_at='2099-01-01T00:00:00.000Z'");
    assert.equal(f.first('SELECT COUNT(*) AS n FROM plaid_webhook_events').n,0);
    const before=calls.length;
    const report=await runPlaidFeedSlice(f.env,{fetchImpl,now:DAY});
    assert.equal(report.ran,1,'idle reconciliation must reach real sync');
    assert.ok(calls.length>before);
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,DAY);
  } finally {f.close();}
});

test('login required records plain health and exception without a retry loop',async()=>{
  const {f,fetchImpl,calls,setLogin}=await connected();
  try {
    setLogin();
    const failed=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl,now:DAY});
    assert.equal(failed.code,'ITEM_LOGIN_REQUIRED','real provider failure reached');
    assert.ok(calls.length>0);
    const status=await handleBankFeed(f.env,new Request('https://brain.invalid/api/bank-feed/status',{
      headers:await f.ownerHeaders()}),new URL('https://brain.invalid/api/bank-feed/status'),'/api/bank-feed/status',{bankFeedNow:DAY});
    const body=await status.json(); assert.equal(status.status,200);
    assert.match(body.connections[0].status_line,/sign in again/i);
    assert.equal(body.connections[0].health.last_error_code,'ITEM_LOGIN_REQUIRED');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1);
    const before=calls.length;
    const skipped=await runPlaidFeedSlice(f.env,{fetchImpl,now:OVERDUE});
    assert.equal(skipped.ran,0,'inactive Item is selected out after the login failure');
    assert.equal(calls.length,before);
  } finally {f.close();}
});

test('49 hours without sync warns; healthy control has no warning',async()=>{
  const {f,fetchImpl}=await connected();
  try {
    await runPlaidFeedSlice(f.env,{fetchImpl,now:START});
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
    f.raw("UPDATE plaid_reconciliation SET state='retryable',due_at='2099-01-01T00:00:00.000Z'");
    const report=await runPlaidFeedSlice(f.env,{fetchImpl,now:OVERDUE});
    assert.equal(report.ran,0,'backoff decision reached; safety net must not bypass it');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1);
    const source=f.first("SELECT expected_refresh_seconds,stale_reason FROM sources WHERE name='bank_activity'");
    assert.equal(source.expected_refresh_seconds,86400);
    assert.match(source.stale_reason,/48 hours/);
  } finally {f.close();}
});

test('money still answers but lowers confidence for dates beyond the last bank sync',async()=>{
  const {f}=await connected();
  try {
    const result=await queryMoney(f.env,{sql:"SELECT SUM(amount_minor) AS total FROM txn WHERE posted_on BETWEEN '2026-10-01' AND '2026-11-01'",period_end:'2026-11-01'}, {now:()=>Date.parse(OVERDUE)});
    assert.equal(result.rows[0].total,1000,'best supported figure remains available');
    assert.ok(result.confidence.percent<90);
    assert.match(result.confidence.line,/^Confidence: (Medium|Low) \(\d+%\)$/);
    assert.match(result.confidence.reasons.join(' '),/no bank data after .*2026.*1234/i);
    assert.match(result.confidence.missing.join(' '),/next sync|sign in/i);
  } finally {f.close();}
});

test('daily status uses the bank activity source receipt, not the manifest corpus key', async()=>{
  const { dailyFreshnessRows }=await import('../../brain.mjs');
  const rows=dailyFreshnessRows({sources:[{key:'bank_feed',source_names:['bank_feed'],class:'server-managed',owner:'worker-cron'}]},
    {as_of:OVERDUE,sources:[{name:'bank_activity',freshness:{state:'stale'},receipt:{last_successful_run_at:START}}]});
  assert.equal(rows.length,1,'real daily renderer reached');
  assert.equal(rows[0].current_state,'stale');
  assert.equal(rows[0].last_successful_run_at,START);
});

test('daily runner invokes the server-managed bank safety net under its lock', async()=>{
  const { runDailyRefresh }=await import('../../operations/daily-refresh-run.mjs');
  const calls=[];
  await runDailyRefresh({plan:{ready:true,enabled:true,identity:{id:'v1-fixture'},manifest_path:'synthetic.invalid',
      sources:[{key:'bank_feed',enabled:true,class:'server-managed',owner:'worker-cron'}]},
    acquireLock:()=>({assertOwned(){calls.push('lock');},release(){calls.push('release');}}),
    runSource:async()=>{throw Error('no laptop ingest');},readFreshness:async()=>({}),writeReceipt:async()=>{},
    runBankFeed:async()=>{calls.push('bank-sync');return {ran:1,complete:true};},now:()=>new Date(DAY)});
  assert.ok(calls.includes('lock'),'lock decision point reached');
  assert.ok(calls.includes('bank-sync'));
});

test('SimpleFIN daily polling records complete health, login errors and backoff', async()=>{
  const { runSimpleFinMaintenance,claimSimpleFinAccess,assignSimpleFinAccountEntity,simpleFinFeedStatus }=await import('../src/lib/simplefin-bank-feed.js');
  const f=await createProductFixture({env:{BANK_FEED_PROVIDER:'simplefin',BANK_FEED_ENV:'production',
    BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
  let fail=false;const calls=[];
  const claimUrl=new URL('https://bridge.invalid/claim');claimUrl.username='fixture';claimUrl.password='fixture-value';
  const accessUrl=new URL('https://bridge.invalid/access');accessUrl.username='fixture';accessUrl.password='fixture-value';
  const fetchImpl=async(input)=>{
    const request=new Request(input);calls.push(request.method);
    if(request.method==='POST') return new Response(accessUrl.href);
    if(fail) return new Response('',{status:401});
    return json({errors:[],accounts:[{id:'synthetic-sf-account',name:'Checking 5678',currency:'USD',balance:'100.00',
      'balance-date':Math.floor(Date.parse(DAY)/1000),transactions:[]}]});
  };
  try {
    seedOwnedEntity(f,'owner-business','Owner business');
    const claim=await claimSimpleFinAccess(f.env,{requestId:'synthetic-sf-claim-0001',setupToken:Buffer.from(claimUrl.href).toString('base64'),fetchImpl,now:START});
    // The claim writes encrypted connection custody through the real provider path.
    assert.ok(claim,'claim decision point reached');
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,maxRequestsPerItem:1,daily:true});
    const account=f.first('SELECT account_ref FROM simplefin_account_assignments');assert.ok(account);
    await assignSimpleFinAccountEntity(f.env,{request_id:'synthetic-sf-assignment-0001',account_ref:account.account_ref,entity_slug:'owner-business'},{now:START});
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:DAY,maxRequestsPerItem:1,daily:true});
    assert.ok(calls.filter(method=>method==='GET').length>=2,'real scheduled provider pulls reached');
    const healthy=await simpleFinFeedStatus(f.env,{now:DAY});
    assert.equal(healthy.connections[0].health.last_successful_sync_at,DAY);
    assert.equal(healthy.needs_attention.length,0);
    fail=true;
    const failed=await runSimpleFinMaintenance(f.env,{fetchImpl,now:OVERDUE,maxRequestsPerItem:1,daily:true});
    assert.equal(failed.items[0].code,'simplefin_login_required');
    const before=calls.length;
    await runSimpleFinMaintenance(f.env,{fetchImpl,now:OVERDUE,maxRequestsPerItem:1,daily:true});
    assert.equal(calls.length,before,'login state prevents a crash loop');
    const status=await simpleFinFeedStatus(f.env,{now:OVERDUE});
    assert.match(status.connections[0].status_line,/sign in again/i);
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1);
  } finally {f.close();}
});

test('daily sync reaches the existing provider route before the 24-hour safety deadline',async()=>{
  const {f,fetchImpl,calls}=await connected();
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  const at='2026-10-28T18:00:00.000Z';
  let requests=0;
  try {
    const before=calls.length;
    const report=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:'fixture-admin-key',now:()=>Date.parse(at),request:async(url,init)=>{
      requests++;
      if(new URL(url).pathname==='/health') return json({status:'ok'});
      const request=new Request(url,init);
      return handleBankFeed(f.env,request,new URL(url),new URL(url).pathname,{bankFeedFetchImpl:fetchImpl,bankFeedNow:at});
    }});
    assert.equal(report.complete,true);
    assert.ok(requests>=2,'bounded drain ends at a zero-work readback');
    assert.ok(calls.length>before,'daily request reaches provider sync');
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,at);
  } finally {f.close();}
});

test('document writes cannot conceal stale bank data and recovery resolves the warning',async()=>{
  const {f,fetchImpl}=await connected();
  try {
    f.raw("UPDATE plaid_reconciliation SET state='retryable',due_at='2099-01-01T00:00:00.000Z'");
    await runPlaidFeedSlice(f.env,{fetchImpl,now:OVERDUE});
    f.raw("UPDATE sources SET last_ingest_at=?,expected_refresh_seconds=NULL,stale_reason=NULL WHERE name='bank_activity'",OVERDUE);
    const source=f.first("SELECT last_ingest_at,expected_refresh_seconds FROM sources WHERE name='bank_activity'");
    assert.equal(source.last_ingest_at,START,'database guard reached despite a fresh projection write');
    assert.equal(source.expected_refresh_seconds,86400);
    const response=await f.post('/api/admin/brain/sources',{mode:'freshness'},{'X-Admin-Key':f.env.ADMIN_KEY});
    assert.equal(response.status,200);
    const inventory=await response.json();
    const bank=inventory.sources.find(row=>row.name==='bank_activity');assert.ok(bank);
    assert.equal(bank.receipt.last_successful_run_at,START);
    f.raw("UPDATE plaid_reconciliation SET due_at=?",OVERDUE);
    await runPlaidFeedSlice(f.env,{fetchImpl,now:OVERDUE});
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NOT NULL').n,1);
  } finally {f.close();}
});

test('local money dispatch carries the asked period to the real data-plane route',async()=>{
  const calls=[];
  const {result:run}=localMcp({PROFILE:'owner-assistant',call:async(path,request)=>{
    calls.push({path,request});return {rows:[{amount:1000}]};}},'runTool');
  const result=await run('brain_money_query',{sql:'SELECT 1000 AS amount',period_end:'2026-10-28'});
  assert.equal(result.rows[0].amount,1000);
  assert.equal(calls.length,1,'production dispatcher reached');
  assert.equal(calls[0].request.body.period_end,'2026-10-28');
});

test('bank health promotion uses an atomic proof, with a green control',async()=>{
  const {bankSuccessStatement}=await import('../src/lib/bank-feed-health.js');
  const f=await createProductFixture();
  try {
    const statement=bankSuccessStatement(f.env,'primary','synthetic-item',DAY,'2026-10-29',{sql:'SELECT 1 WHERE ?=1',binds:[0]});
    await statement.run();
    assert.ok(f.seen.sql.some(sql=>sql.includes('INSERT INTO bank_feed_health')),'health write decision point reached');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM bank_feed_health').n,0,'expired or replaced revision cannot prove a sync');
    await bankSuccessStatement(f.env,'primary','synthetic-item',DAY,'2026-10-29',{sql:'SELECT 1 WHERE ?=1',binds:[1]}).run();
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,DAY);
  } finally {f.close();}
});

test('daily bank drain continues to healthy connections after another connection fails',async()=>{
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  let calls=0;
  const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:'fixture-admin-key',request:dailyRequest(async()=>{
    calls++;
    return json(calls===1 ? {ran:1,items:[{ok:false}]} : calls===2 ? {ran:1,items:[{ok:true}]} : {ran:0,items:[]});
  })});
  assert.equal(result.complete,false);
  assert.equal(calls,3,'failed and healthy arms are both reached before the final readback');
  assert.equal(result.ran,2);
});

test('schema 63 is restart-safe and projection guards terminate with recursive triggers',async()=>{
  const {readFileSync}=await import('node:fs');
  const {f}=await connected();
  try {
    const migration=readFileSync(new URL('../../migrations/d1/0063_bank_feed_health.sql',import.meta.url),'utf8');
    const before=f.first('SELECT COUNT(*) AS n FROM bank_feed_health').n;assert.ok(before>0);
    f.sqlite.exec(migration);f.sqlite.exec(migration);
    assert.equal(f.first('SELECT COUNT(*) AS n FROM bank_feed_health').n,before);
    f.raw('PRAGMA recursive_triggers=ON');
    f.raw("UPDATE sources SET last_ingest_at=?,expected_refresh_seconds=NULL WHERE name='bank_activity'",OVERDUE);
    assert.equal(f.first("SELECT last_ingest_at FROM sources WHERE name='bank_activity'").last_ingest_at,START);
  } finally {f.close();}
});

test('R2 schema 64 preserves legacy cooldowns and resumes without duplicate ALTER',async()=>{
  const {readFileSync}=await import('node:fs');
  const {splitStatements,runRestartSafeMigrationStatements}=await import('../../brain.mjs');
  const f=await createProductFixture({migrationThrough:63});
  try {
    f.raw(`INSERT INTO plaid_reconciliation (tenant_id,item_ref,reason,state,due_at,attempts,last_error_code,updated_at)
      VALUES ('primary','synthetic-item','sync_failure','retryable',?,1,'RATE_LIMIT_EXCEEDED',?)`,DAY,START);
    const sql=readFileSync(new URL('../../migrations/d1/0064_plaid_retry_floor.sql',import.meta.url),'utf8');
    let alters=0;
    const query=async statement=>{
      if(/^ALTER TABLE/i.test(statement.trim()))alters++;
      const compiled=f.sqlite.prepare(statement);
      return compiled.columns().length?{results:compiled.all()}:{results:[],meta:{changes:Number(compiled.run().changes)}};
    };
    await runRestartSafeMigrationStatements(splitStatements(sql),query);
    assert.equal(f.first('SELECT provider_retry_not_before FROM plaid_reconciliation').provider_retry_not_before,DAY,
      'legacy throttled queue is the reached migration decision');
    f.raw('UPDATE plaid_reconciliation SET provider_retry_not_before=?',OVERDUE);
    await runRestartSafeMigrationStatements(splitStatements(sql),query);
    assert.equal(alters,1,'restart uses verified column readback');
    assert.equal(f.first('SELECT provider_retry_not_before FROM plaid_reconciliation').provider_retry_not_before,OVERDUE,
      'green control: repeat migration preserves a newer floor');
  } finally {f.close();}
});

test('health read failure preserves the money figure with Low confidence',async()=>{
  const {f}=await connected();
  try {
    const before=f.seen.sql.length;
    f.control.failOn=/FROM bank_feed_items i LEFT JOIN bank_feed_health h/;
    const result=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-10-27'},{now:()=>Date.parse(DAY)});
    assert.ok(f.seen.sql.slice(before).some(sql=>f.control.failOn.test(sql)),'failed health decision point reached');
    assert.equal(result.rows[0].total,1000);
    assert.equal(result.confidence.band,'Low');
    assert.match(result.confidence.reasons.join(' '),/freshness could not be verified/);
    f.control.failOn=null;
    const green=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-10-27'},{now:()=>Date.parse(DAY)});
    assert.equal(green.rows[0].total,1000);
    assert.ok(green.confidence.percent>result.confidence.percent);
  } finally {f.close();}
});

test('money schema accepts a calendar period and native runtime embeds its new dependency',async()=>{
  const {MONEY_TOOLS}=await import('../src/lib/money-query-contract.js');
  const {readFileSync}=await import('node:fs');
  assert.ok(new RegExp(MONEY_TOOLS[0].inputSchema.properties.period_end.pattern).test('2026-10-28'));
  const native=readFileSync(new URL('./fixtures/simplefin/runtime.capnp',import.meta.url),'utf8');
  assert.match(native,/name = "worker\/src\/lib\/bank-feed-health.js"/);
  const {TEST_COMMANDS,POST_LAUNCHER_TEST_COMMANDS}=await import('../../scripts/run-test-chain.mjs');
  const command='node --test worker/test/bank-feed-safety-net-1112.test.mjs';
  assert.equal(TEST_COMMANDS.filter(value=>value===command).length,1);
  assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(command));
});

test('a partial Plaid refresh cannot report healthy current data',async()=>{
  const {f,fetchImpl}=await connected();
  try {
    const partialFetch=async(url,init)=>{
      const response=await fetchImpl(url,init);
      if(new URL(url).pathname!=='/transactions/sync') return response;
      const body=await response.json();body.transactions_update_status='INITIAL_UPDATE_COMPLETE';return json(body);
    };
    const result=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:partialFetch,now:DAY});
    assert.equal(result.partial,true,'real partial provider promotion reached');
    const {plaidFeedStatus}=await import('../src/lib/plaid-bank-feed.js');
    const status=await plaidFeedStatus(f.env,{now:DAY});
    assert.equal(status.connections[0].health.last_successful_sync_at,START);
    assert.equal(status.connections[0].health.state,'error');
    assert.equal(status.connections[0].health.last_error_code,'BANK_SYNC_PARTIAL');
  } finally {f.close();}
});

test('L2 a real partial first download stays Working while server health remains incomplete',async()=>{
  const f=await createProductFixture({env:{BANK_FEED_PROVIDER:'plaid',BANK_FEED_ENV:'sandbox',BRAIN_TIMEZONE:'Etc/UTC',
    BANK_FEED_CLIENT_ID:'fixture-client',BANK_FEED_SECRET:'fixture-secret',BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
  try {
    const sealed=await encryptAccessReference(f.env,['fixture','access'].join('-'));
    f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
      VALUES ('primary','synthetic-first-partial',?,?,?,'sandbox',?)`,sealed.ciphertext,sealed.iv,sealed.keyVersion,START);
    seedOwnedEntity(f,'owner-business','Owner business');
    const calls=[];
    const fetchImpl=async url=>{
      const path=new URL(url).pathname;calls.push(path);
      if(path==='/accounts/get')return json({accounts:[{account_id:'synthetic-first-account',name:'Checking',mask:'1234',
        type:'depository',subtype:'checking',balances:{current:'100.00',iso_currency_code:'USD'}}]});
      assert.equal(path,'/transactions/sync');
      return json({added:[],modified:[],removed:[],next_cursor:'synthetic-first-cursor',has_more:false,
        transactions_update_status:'INITIAL_UPDATE_COMPLETE'});
    };
    const held=await syncPlaidItem(f.env,'synthetic-first-partial',{fetchImpl,now:START});
    assert.equal(held.assignment_required,true,'real owner-choice guard reached before any sync succeeds');
    const account=f.first("SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='synthetic-first-partial'");
    await assignPlaidAccountEntity(f.env,{request_id:'synthetic-first-assignment',account_ref:account.account_ref,entity_slug:'owner-business'},{now:START});
    const partial=await syncPlaidItem(f.env,'synthetic-first-partial',{fetchImpl,now:START});
    assert.equal(partial.partial,true,'real incomplete provider window promoted');
    assert.ok(calls.includes('/transactions/sync'),'provider decision reached');
    const {plaidFeedStatus}=await import('../src/lib/plaid-bank-feed.js');
    const status=await plaidFeedStatus(f.env,{now:START});
    assert.equal(status.connections.length,1);
    const bank=status.connections[0];
    assert.equal(bank.last_synced_at,START,'legacy timestamp advances for a partial download');
    assert.equal(bank.health.last_successful_sync_at,null,'no verified complete sync');
    assert.equal(bank.health.last_error_code,'BANK_SYNC_PARTIAL');
    assert.notEqual(bank.health.state,'healthy','server incomplete-data guard stays authoritative');
    const outcome=await bankOutcomeHarness();
    assert.equal(outcome(bank,Date.parse(START)),'WORKING');
    assert.equal(outcome(bank,Date.parse(OVERDUE)),'PROBLEM','49-hour control still escalates');
  } finally {f.close();}
});

test('provider daily request-budget failures have a plain rate-limit meaning',async()=>{
  const {bankSyncError}=await import('../src/lib/bank-feed-health.js');
  const result=bankSyncError('simplefin_daily_request_limit');
  assert.match(result.meaning,/limit/);
  assert.match(result.action,/resets/);
});

test('a verified webhook records receipt health and remains the immediate sync path',async()=>{
  const {f,fetchImpl,calls}=await connected();
  try {
    const at='2026-10-28T13:00:00.000Z';
    const encoder=new TextEncoder();
    const b64=bytes=>Buffer.from(bytes).toString('base64url');
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='synthetic-webhook-key';
    const body=JSON.stringify({webhook_type:'TRANSACTIONS',webhook_code:'SYNC_UPDATES_AVAILABLE',item_id:'synthetic-item'});
    const digest=Buffer.from(await crypto.subtle.digest('SHA-256',encoder.encode(body))).toString('hex');
    const unsigned=[b64(JSON.stringify({alg:'ES256',kid:jwk.kid,typ:'JWT'})),b64(JSON.stringify({iat:Math.floor(Date.parse(at)/1000),request_body_sha256:digest}))].join('.');
    const signed=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encoder.encode(unsigned));
    const {handlePlaidWebhook}=await import('../src/lib/plaid-bank-feed.js');
    const response=await handlePlaidWebhook(f.env,new Request('https://brain.invalid/api/webhooks/plaid',{
      method:'POST',headers:{'Plaid-Verification':[unsigned,b64(signed)].join('.')},body}),{
      now:at,fetchImpl:async(url)=>{assert.equal(new URL(url).pathname,'/webhook_verification_key/get');return json({key:jwk});}});
    assert.equal(response.status,200,'verified webhook decision point reached');
    assert.equal(f.first('SELECT last_webhook_at FROM bank_feed_health').last_webhook_at,at);
    const before=calls.length;
    const report=await runPlaidFeedSlice(f.env,{fetchImpl,now:at});
    assert.equal(report.ran,1);
    assert.ok(calls.length>before,'webhook wakes the provider before the daily fallback deadline');
  } finally {f.close();}
});

test('daily sync cannot claim completion when inactive connections still need attention',async()=>{
  const {refreshDailyBankFeed}=await import('../../operations/bank-feed-daily.mjs');
  let calls=0;
  const result=await refreshDailyBankFeed({base:'https://brain.invalid',adminKey:'fixture-admin-key',request:dailyRequest(async()=>{
    calls++;return json({ran:0,items:[],health_attention:1});
  })});
  assert.equal(calls,1,'zero-work health readback decision reached');
  assert.equal(result.complete,false);
});

test('implicit money freshness uses the configured owner calendar at a UTC boundary',async()=>{
  const {f}=await connected();
  try {
    f.env.BRAIN_TIMEZONE='America/Phoenix';
    const result=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn'}, {now:()=>Date.parse('2026-10-29T01:00:00.000Z')});
    assert.equal(result.rows[0].total,1000);
    assert.equal(result.confidence.period_end,'2026-10-28');
  } finally {f.close();}
});

test('daily status distinguishes a connection awaiting its first sync from unknown health',async()=>{
  const {dailyFreshnessRows}=await import('../../brain.mjs');
  const rows=dailyFreshnessRows({sources:[{key:'bank_feed',class:'server-managed',owner:'worker-cron'}]},
    {as_of:DAY,sources:[{name:'bank_activity',freshness:{state:'never_synced'},receipt:{last_successful_run_at:null}}]});
  assert.equal(rows.length,1,'daily state decision point reached');
  assert.equal(rows[0].current_state,'never_synced');
  assert.equal(rows[0].last_successful_run_at,null);
});

// Start at the real pre-health schema. A legacy pull timestamp is deliberately
// recent while the connection itself is old and its next pull is tomorrow.
async function simpleFinHealthUpgrade() {
  const f=await createProductFixture({migrationThrough:62,env:{BANK_FEED_PROVIDER:'simplefin',
    BANK_FEED_ENV:'production',BRAIN_TIMEZONE:'UTC',BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
  const access=new URL('https://bridge.invalid/access');access.username='fixture';access.password='fixture-value';
  const sealed=await encryptAccessReference(f.env,access.href);
  const ref=`sfa_${'0'.repeat(32)}`,slug=`simplefin-${ref.slice(4)}`;
  const identity=JSON.stringify(['','synthetic-upgrade-account']);
  seedOwnedEntity(f,'owner-business','Owner business');
  f.raw(`INSERT INTO bank_feed_items
    (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at,last_synced_at)
    VALUES ('primary','synthetic-upgrade',?,?,?,'production','2026-09-01T12:00:00.000Z',?)`,
    sealed.ciphertext,sealed.iv,sealed.keyVersion,START);
  f.raw(`INSERT INTO simplefin_connections
    (tenant_id,item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,updated_at)
    VALUES ('primary','synthetic-upgrade','2026-10-01','2026-10-29','2026-10-28',?,?)`,DAY,START);
  f.raw(`INSERT INTO simplefin_account_assignments
    (tenant_id,item_ref,provider_account_id,account_ref,currency,entity_slug,first_seen_at,last_seen_at,assigned_at,connection_id,source_account_id)
    VALUES ('primary','synthetic-upgrade',?,?,'USD','owner-business',?,?,?,'','synthetic-upgrade-account')`,
    identity,ref,START,START,START);
  f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,label,mask,account_kind,balance_role,currency,feed_mode,status,external_ref,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,'owner-business','Checking 5678','5678','checking','asset','USD','live','open',?,'feed','bank-feed:synthetic-upgrade','confirmed',?)`,slug,ref,START);
  f.raw(`INSERT INTO fin_transactions
    (txn_uid,external_id,account_slug,posted_on,amount_minor,direction,currency,description,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,'synthetic-upgrade-payment',?,'2026-10-28',1000,'inflow','USD','Payroll income','feed','bank-feed:synthetic-upgrade','confirmed',?)`,
    transactionUid(slug,{externalId:'synthetic-upgrade-payment'}),slug,START);
  f.raw(`INSERT INTO fin_account_coverage
    (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES (?,'complete','2026-10-01','2026-10-28',?,'owner_stated','confirmed',?)`,slug,START,START);
  assert.equal(f.first("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='bank_feed_health'").n,0,'base schema has no health table');
  assert.equal(f.first('SELECT SUM(amount_minor) AS total FROM fin_transactions').total,1000,'seeded legacy figure control');
  const migration=readFileSync(new URL('../../migrations/d1/0063_bank_feed_health.sql',import.meta.url),'utf8');
  const upgrade=()=>{for(const sql of f.splitStatements(migration)) f.sqlite.exec(sql);};
  upgrade();
  f.sqlite.exec(readFileSync(new URL('../../migrations/d1/0064_plaid_retry_floor.sql',import.meta.url),'utf8'));
  assert.equal(f.first('SELECT COUNT(*) AS n FROM bank_feed_health').n,0,'legacy pull timestamps never manufacture successful health');
  const calls=[];
  const fetchImpl=async request=>{
    assert.equal(new Request(request).method,'GET');calls.push(new URL(request.url).pathname);
    return json({errlist:[],accounts:[{id:'synthetic-upgrade-account',name:'Checking 5678',currency:'USD',balance:'100.00',
      'balance-date':Math.floor(Date.parse(START)/1000),transactions:[{id:'synthetic-upgrade-payment',
        posted:Math.floor(Date.parse(START)/1000),amount:'10.00',description:'Payroll income'}]}]});
  };
  const money=()=>queryMoney(f.env,{sql:"SELECT SUM(income_minor) AS total FROM txn WHERE posted_on BETWEEN '2026-10-28' AND '2026-10-28'",period_end:'2026-10-28'},
    {now:()=>Date.parse(START)});
  return {f,upgrade,calls,fetchImpl,money};
}

test('schema 63 upgrade waits for unobserved SimpleFIN health instead of declaring an old connection overdue',async t=>{
  const {f}=await simpleFinHealthUpgrade();
  try {
    const {simpleFinFeedStatus}=await import('../src/lib/simplefin-bank-feed.js');
    const status=await simpleFinFeedStatus(f.env,{now:START});
    assert.equal(status.connections.length,1,'owner status reached the seeded connection');
    t.diagnostic(`upgrade health before first pull: ${status.connections[0].health.state}`);
    assert.equal(status.connections[0].health.state,'waiting');
    assert.equal(status.connections[0].health.overdue,false);
    assert.match(status.connections[0].status_line,/Waiting for the first complete bank sync/);
    const {reconcileBankFeedHealth}=await import('../src/lib/bank-feed-health.js');
    await reconcileBankFeedHealth(f.env,START);
    assert.ok(f.seen.sql.some(sql=>sql.includes('FROM bank_feed_items i LEFT JOIN bank_feed_health h')),'health reconciliation decision reached');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
  } finally {f.close();}
});

test('schema 63 schedules unseeded SimpleFIN immediately and replay preserves observed retry timing',async()=>{
  const {f,upgrade}=await simpleFinHealthUpgrade();
  try {
    assert.ok(f.first('SELECT next_pull_at FROM simplefin_connections').next_pull_at<START,'actual migration makes the first verified pull due');
    upgrade();
    assert.ok(f.first('SELECT next_pull_at FROM simplefin_connections').next_pull_at<START,'unobserved migration replay remains due');
    f.raw('INSERT INTO bank_feed_health(tenant_id,item_ref,last_attempt_at,last_error_code) VALUES (?,?,?,?)',
      'primary','synthetic-upgrade',START,'BANK_SYNC_FAILED');
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
    upgrade();
    assert.equal(f.first('SELECT next_pull_at FROM simplefin_connections').next_pull_at,DAY,'replay cannot bypass an observed failure backoff');
  } finally {f.close();}
});

test('schema 63 upgrade verifies a current SimpleFIN pull and removes the false Low confidence cap',async t=>{
  const {f,calls,fetchImpl,money}=await simpleFinHealthUpgrade();
  try {
    const before=await money();
    assert.equal(before.rows[0].total,1000,'available money remains answerable before verification');
    assert.equal(before.confidence.percent,69,'unverified current health still caps confidence');
    assert.ok(before.confidence.reasons.length && before.confidence.missing.length);
    const {runSimpleFinMaintenance,simpleFinFeedStatus}=await import('../src/lib/simplefin-bank-feed.js');
    const report=await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,maxRequestsPerItem:1});
    t.diagnostic(`upgrade first maintenance: ran=${report.ran}, provider calls=${calls.length}, initial confidence=${before.confidence.percent}`);
    assert.ok(f.seen.sql.some(sql=>sql.includes('SELECT c.*,i.access_ciphertext')),'real due selector reached');
    assert.equal(report.ran,1);
    assert.equal(calls.length,1,'first periodic maintenance reaches the injected provider');
    assert.equal(report.items[0].ok,true);
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,START);
    const status=await simpleFinFeedStatus(f.env,{now:START});
    assert.equal(status.connections[0].health.state,'healthy');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
    const after=await money();
    assert.equal(after.rows[0].total,1000,'verified pull preserves the supported figure');
    // Literal SQL proves the recorded selection, never undeclared accounts, so
    // 0.4.28 party certificates retain the figure below High for an unresolved payee.
    assert.equal(after.confidence.percent,89,'a verified pull restores coverage but does not prove the party');
    assert.match(after.confidence_text,/Confidence: Medium \(89%\)/);
    assert.doesNotMatch(after.confidence.reasons.join(' '),/No complete bank sync recorded/);
    assert.equal(after.confidence.reasons.length,2);
    assert.equal(after.confidence.reasons[0],'The complete expected-account inventory is not independently verified.');
    assert.match(after.confidence.reasons[1],/USD \$10\.00 for an unresolved party.*no complete party type certificate/);
    assert.equal(after.confidence.missing.length,2);
    assert.equal(after.confidence.missing[0],'Owner-confirmed expected accounts and verified statement coverage for the requested dates.');
    assert.match(after.confidence.missing[1],/^Resolve every contributing payer\/vendor to one group/);
    t.diagnostic(`verified upgrade confidence: ${after.confidence.percent}`);
  } finally {f.close();}
});

test('an unseeded SimpleFIN partial pull keeps the figure answerable without claiming verified health',async()=>{
  const {f,fetchImpl,calls,money}=await simpleFinHealthUpgrade();
  try {
    const {runSimpleFinMaintenance}=await import('../src/lib/simplefin-bank-feed.js');
    const partial=await runSimpleFinMaintenance(f.env,{now:START,maxRequestsPerItem:1,fetchImpl:async request=>{
      const body=await (await fetchImpl(request)).json();body.errlist=['Synthetic incomplete activity'];return json(body);
    }});
    assert.equal(partial.ran,1);assert.equal(calls.length,1,'partial provider response decision reached');
    assert.equal(partial.items[0].partial,true);
    assert.equal(f.first('SELECT last_successful_sync_at FROM bank_feed_health').last_successful_sync_at,null);
    const answer=await money();assert.equal(answer.rows[0].total,1000);
    assert.equal(answer.confidence.percent,69);assert.ok(answer.confidence.reasons.length && answer.confidence.missing.length);
  } finally {f.close();}
});

test('daily SimpleFIN selector includes NULL attempts but respects recent attempts and failure backoff',async()=>{
  const {f,calls,fetchImpl}=await simpleFinHealthUpgrade();
  try {
    const {runSimpleFinMaintenance}=await import('../src/lib/simplefin-bank-feed.js');
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
    f.raw('INSERT INTO bank_feed_health(tenant_id,item_ref) VALUES (?,?)','primary','synthetic-upgrade');
    const options={fetchImpl,now:START,daily:true,maxRequestsPerItem:1};
    const first=await runSimpleFinMaintenance(f.env,options);
    assert.ok(f.seen.sql.some(sql=>sql.includes('SELECT c.*,i.access_ciphertext')),'daily selector evaluated the future-scheduled connection');
    assert.equal(first.ran,1,'NULL attempt must not wait for tomorrow');
    assert.equal(calls.length,1,'green control reaches real provider path');
    const recent=await runSimpleFinMaintenance(f.env,options);
    assert.equal(recent.ran,0);
    assert.equal(calls.length,1,'recent daily attempt is not repeated');
    f.raw("UPDATE bank_feed_health SET last_attempt_at='2026-10-27T12:00:00.000Z',last_error_code='BANK_SYNC_FAILED'");
    const failed=await runSimpleFinMaintenance(f.env,options);
    assert.equal(failed.ran,0);
    assert.equal(calls.length,1,'NULL-attempt fix must not bypass known failure backoff');
  } finally {f.close();}
});

test('a genuinely stale SimpleFIN sync remains overdue and Low while a successful current sync is healthy',async()=>{
  const {f,fetchImpl,calls,money}=await simpleFinHealthUpgrade();
  try {
    const {runSimpleFinMaintenance,simpleFinFeedStatus}=await import('../src/lib/simplefin-bank-feed.js');
    const stale='2026-10-26T11:00:00.000Z';
    f.raw(`INSERT INTO bank_feed_health(tenant_id,item_ref,last_attempt_at,last_successful_sync_at,data_through,last_error_code)
      VALUES ('primary','synthetic-upgrade',?,?,'2026-10-26','BANK_SYNC_FAILED')`,stale,stale);
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
    const held=await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,daily:true,maxRequestsPerItem:1});
    assert.ok(f.seen.sql.some(sql=>sql.includes('SELECT c.*,i.access_ciphertext')),'stale backoff selector reached');
    assert.equal(held.ran,0);assert.equal(calls.length,0,'known backoff prevents a provider retry');
    const status=await simpleFinFeedStatus(f.env,{now:START});
    assert.equal(status.connections[0].health.state,'overdue');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1);
    const answer=await money();assert.equal(answer.rows[0].total,1000);
    assert.equal(answer.confidence.percent,69);assert.ok(answer.confidence.missing.length);
    f.raw('UPDATE simplefin_connections SET next_pull_at=?',START);
    const recovered=await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,maxRequestsPerItem:1});
    assert.equal(recovered.ran,1);assert.equal(calls.length,1,'green recovery control reaches the provider');
    assert.equal((await simpleFinFeedStatus(f.env,{now:START})).connections[0].health.state,'healthy');
    assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0);
  } finally {f.close();}
});


// R1: failures must surface while yesterday's successful data is still recent.
test('R1 provider errors and partial reads open one exception until verified recovery',async()=>{
  for (const kind of ['failure','partial']) {
    const {f,fetchImpl}=await connected();
    let attempts=0;
    try {
      const broken=async(url,init)=>{
        attempts++;
        if(kind==='failure') return json({error_code:'INSTITUTION_DOWN'},500);
        const response=await fetchImpl(url,init);
        if(new URL(url).pathname!=='/transactions/sync') return response;
        const body=await response.json();body.transactions_update_status='INITIAL_UPDATE_COMPLETE';return json(body);
      };
      const result=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:broken,now:DAY});
      assert.ok(attempts>0,'provider failure decision reached');
      assert.equal(result.ok,false);
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1,kind);
      const first=f.first('SELECT first_seen FROM fin_exceptions').first_seen;
      const {reconcileBankFeedHealth}=await import('../src/lib/bank-feed-health.js');
      await reconcileBankFeedHealth(f.env,OVERDUE);
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions').n,1);
      assert.equal(f.first('SELECT first_seen FROM fin_exceptions').first_seen,first);
      assert.match(f.first("SELECT stale_reason FROM sources WHERE name='bank_activity'").stale_reason,/could not be read|incomplete|48 hours/);
      await syncPlaidItem(f.env,'synthetic-item',{fetchImpl,now:OVERDUE});
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0,'complete recovery control');
    } finally {f.close();}
  }
});

test('R2 every owner-recovery code stops subsequent automatic Plaid calls',async()=>{
  for(const code of ['ITEM_LOGIN_REQUIRED','PENDING_EXPIRATION','USER_PERMISSION_REVOKED','ITEM_NOT_FOUND','ACCESS_NOT_GRANTED','INVALID_ACCESS_TOKEN']) {
    const {f,fetchImpl}=await connected(); let failures=0;
    try {
      const result=await syncPlaidItem(f.env,'synthetic-item',{now:DAY,fetchImpl:async()=>{failures++;return json({error_code:code},400);}});
      assert.equal(result.code,code,'provider catch reached');
      assert.equal(failures,1);
      let calls=0;
      const next=await runPlaidFeedSlice(f.env,{now:OVERDUE,fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);}});
      assert.equal(next.ran,0,code);
      assert.equal(calls,0,code);
      f.raw("UPDATE bank_feed_items SET status='connected'");
      const control=await runPlaidFeedSlice(f.env,{now:OVERDUE,fetchImpl});
      assert.equal(control.ran,1,'verified owner recovery admits the existing connection');
    } finally {f.close();}
  }
});

test('R3 money uses the successful observation in the owner calendar and discloses intraday gaps',async()=>{
  const {f,fetchImpl}=await connected();
  const at='2026-10-29T01:00:00.000Z';
  try {
    f.env.BRAIN_TIMEZONE='America/Phoenix';
    assert.equal((await syncPlaidItem(f.env,'synthetic-item',{fetchImpl,now:at})).ok,true);
    assert.equal(f.first('SELECT data_through FROM bank_feed_health').data_through,'2026-10-29','UTC provider-window evidence retained separately');
    for(const [period,now] of [['2026-10-29','2026-10-29T18:00:00.000Z'],['2026-10-28','2026-10-29T02:00:00.000Z']]) {
      const result=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:period},{now:()=>Date.parse(now)});
      assert.equal(result.rows[0].total,1000);
      assert.equal(result.confidence.percent,40,`${period} at ${now}: candidate selection ceiling`);
      assert.match(result.confidence.reasons.join(' '),/2026-10-28.*1234/);
      assert.match(result.confidence.missing.join(' '),/2026-10-29T01:00:00.000Z/);
    }
    const control=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-10-27'},{now:()=>Date.parse(DAY)});
    assert.equal(control.confidence.percent,40,'candidate selection ceiling also governs the earlier-date control');
    assert.doesNotMatch(control.confidence.reasons.join(' '),/No bank data after/,'earlier date removes the freshness gap');
  } finally {f.close();}
});

test('R4 disconnected saved accounts retain their money gap without restarting the feed',async()=>{
  const {f,fetchImpl}=await connected();
  const {disconnectPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
  const ask=()=>queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-11-01'},{now:()=>Date.parse(OVERDUE)});
  try {
    const before=await ask();assert.equal(before.confidence.percent,40,'candidate selection ceiling');
    let removed=0;
    const result=await disconnectPlaidItem(f.env,'synthetic-item',{now:DAY,fetchImpl:async()=>{removed++;return json({});}});
    assert.equal(result.revocation_state,'confirmed');assert.equal(removed,1,'real disconnect reached');
    const after=await ask();assert.equal(after.rows[0].total,1000);
    assert.equal(after.confidence.percent,40,'candidate selection ceiling');
    assert.match(after.confidence.reasons.join(' '),/disconnected.*1234|1234.*disconnected/);
    assert.match(after.confidence.reasons.join(' '),/2026-10-28/);
    let calls=0;
    assert.equal((await runPlaidFeedSlice(f.env,{now:OVERDUE,fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);}})).ran,0);
    assert.equal(calls,0);
    const historical=await queryMoney(f.env,{sql:'SELECT SUM(amount_minor) AS total FROM txn',period_end:'2026-10-27'},{now:()=>Date.parse(OVERDUE)});
    assert.equal(historical.confidence.percent,40,'candidate selection ceiling');
    assert.doesNotMatch(historical.confidence.reasons.join(' '),/No bank data after/);
  } finally {f.close();}
});

test('R5 provider cooldown survives deadline wrapping and repeated throttles escalate',async()=>{
  const {f,fetchImpl}=await connected(); let calls=0;
  const throttle=async()=>{calls++;return new Response(JSON.stringify({error_code:'RATE_LIMIT_EXCEEDED'}),{status:429,headers:{'Retry-After':'600'}});};
  try {
    const failed=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:throttle,now:DAY});
    assert.equal(failed.ok,false);assert.equal(calls,1,'real 429 reached without sleeping inside invocation');
    const due=f.first('SELECT due_at,last_error_code FROM plaid_reconciliation');
    assert.ok(due.due_at>='2026-10-29T12:10:00.000Z',due.due_at);
    assert.equal(due.last_error_code,'RATE_LIMIT_EXCEEDED');
    const skipped=await runPlaidFeedSlice(f.env,{fetchImpl:throttle,now:'2026-10-29T12:05:00.000Z',daily:true});
    assert.equal(skipped.ran,0,'durable cooldown selection reached');assert.equal(calls,1);
    const resumed=await runPlaidFeedSlice(f.env,{fetchImpl,now:due.due_at});
    assert.equal(resumed.ran,1,'healthy control succeeds at expiry');assert.equal(resumed.items[0].ok,true);
    const dues=[],delays=[];let at=due.due_at;
    const before=calls;
    for(let i=0;i<3;i++) {
      await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:throttle,now:at});
      const next=f.first('SELECT due_at FROM plaid_reconciliation').due_at;
      dues.push(next);delays.push(Date.parse(next)-Date.parse(at));at=next;
    }
    assert.equal(calls,before+3,'each repeat reaches the provider after its prior cooldown');
    assert.ok(dues[2]>dues[0],'repeated throttles increase durable backoff');
    assert.ok(delays[2]>delays[0],'backoff durations grow independently of advancing fixture time');
  } finally {f.close();}
});

test('R1 SimpleFIN HTTP failure and incomplete listing alert immediately and recover',async()=>{
  const {runSimpleFinMaintenance,claimSimpleFinAccess,assignSimpleFinAccountEntity}=await import('../src/lib/simplefin-bank-feed.js');
  for(const mode of ['http','partial']) {
    const f=await createProductFixture({env:{BANK_FEED_PROVIDER:'simplefin',BANK_FEED_ENV:'production',
      BANK_FEED_WRAPPING_KEY_V2:['v2.','A'.repeat(43)].join('')}});
    const claimUrl=new URL('https://bridge.invalid/claim');claimUrl.username='fixture';claimUrl.password='fixture-value';
    const accessUrl=new URL('https://bridge.invalid/access');accessUrl.username='fixture';accessUrl.password='fixture-value';
    let broken=false,calls=0;
    const fetchImpl=async(input)=>{
      const request=new Request(input);
      if(request.method==='POST') return new Response(accessUrl.href);
      calls++;
      if(broken && mode==='http') return new Response('',{status:500});
      return json({errors:[],accounts:[{id:'sf-current',name:'Checking 5678',currency:'USD',balance:'100.00',
        'balance-date':Math.floor(Date.parse(DAY)/1000),...(broken ? {} : {transactions:[]})}]});
    };
    try {
      seedOwnedEntity(f,'owner-business','Owner business');
      await claimSimpleFinAccess(f.env,{requestId:`synthetic-sf-${mode}-0001`,setupToken:Buffer.from(claimUrl.href).toString('base64'),fetchImpl,now:START});
      await runSimpleFinMaintenance(f.env,{fetchImpl,now:START,maxRequestsPerItem:1,daily:true});
      await assignSimpleFinAccountEntity(f.env,{request_id:`synthetic-sf-${mode}-assignment`,account_ref:f.first('SELECT account_ref FROM simplefin_account_assignments').account_ref,entity_slug:'owner-business'},{now:START});
      f.raw('UPDATE simplefin_connections SET next_pull_at=?',DAY);
      await runSimpleFinMaintenance(f.env,{fetchImpl,now:DAY,maxRequestsPerItem:1,daily:true});
      const at='2026-10-30T12:00:00.000Z';
      broken=true;const before=calls;
      await runSimpleFinMaintenance(f.env,{fetchImpl,now:at,maxRequestsPerItem:1,daily:true});
      assert.ok(calls>before,'real failed pull reached');
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,1,mode);
      broken=false;
      await runSimpleFinMaintenance(f.env,{fetchImpl,now:'2026-10-31T12:00:00.000Z',maxRequestsPerItem:1,daily:true});
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_exceptions WHERE resolved_at IS NULL').n,0,'verified current recovery');
    } finally {f.close();}
  }
});

for (const arm of ['first-call','first-transaction-page','later-transaction-page']) {
  test(`R3 retry floor starts at the actual ${arm} throttle response`,async t=>{
    const {f,fetchImpl}=await connected();
    let elapsed=0, pages=0;
    const paths=[];
    t.mock.method(Date,'now',()=>Date.parse(DAY)+elapsed);
    const delayed=async(url,init)=>{
      const path=new URL(url).pathname;paths.push(path);
      if(path==='/accounts/get' && arm!=='first-call') {
        elapsed+=8000;return fetchImpl(url,init);
      }
      if(path==='/transactions/sync' && arm==='later-transaction-page' && pages++===0) {
        elapsed+=2000;
        const body=await (await fetchImpl(url,init)).json();
        return json({...body,next_cursor:'synthetic-middle',has_more:true});
      }
      elapsed+=200;
      return new Response(JSON.stringify({error_code:'RATE_LIMIT_EXCEEDED'}),{
        status:429,headers:{'Retry-After':'600'}});
    };
    try {
      const failure=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:delayed,now:DAY});
      assert.equal(failure.ok,false);assert.equal(failure.code,'RATE_LIMIT_EXCEEDED');
      assert.deepEqual(paths,arm==='first-call' ? ['/accounts/get'] : arm==='first-transaction-page'
        ? ['/accounts/get','/transactions/sync'] : ['/accounts/get','/transactions/sync','/transactions/sync'],
        'real provider sequence reaches the intended throttle');
      const expected=new Date(Date.parse(DAY)+elapsed+600000).toISOString();
      const stored=f.first('SELECT provider_retry_not_before FROM plaid_reconciliation').provider_retry_not_before;
      assert.equal(stored,expected,'full Retry-After begins when the response arrives');
      const early=new Date(Date.parse(expected)-7200).toISOString();
      const count=paths.length;
      const skipped=await runPlaidFeedSlice(f.env,{fetchImpl:delayed,now:early,daily:true});
      assert.ok(f.seen.sql.some(sql=>sql.includes('provider_retry_not_before')),'durable selector reached');
      assert.equal(skipped.ran,0);assert.equal(paths.length,count);
      const manual=await syncPlaidItem(f.env,'synthetic-item',{fetchImpl:delayed,now:early});
      assert.equal(manual.code,'PLAID_SYNC_COOLDOWN');assert.equal(paths.length,count);
      elapsed=Date.parse(expected)-Date.parse(DAY);
      let resumedCalls=0;
      const catchUp=async(...args)=>{resumedCalls++;const response=await fetchImpl(...args);if(new URL(args[0]).pathname!=='/transactions/sync')return response;return json({...await response.json(),next_cursor:'synthetic-catch-up'});};
      let resumed=await runPlaidFeedSlice(f.env,{now:expected,fetchImpl:catchUp});
      assert.equal(resumed.ran,1);
      if(arm==='later-transaction-page') {
        assert.equal(resumed.items[0].refresh_pending,true,'resumed prefix retains newer queue debt');
        resumed=await runPlaidFeedSlice(f.env,{now:expected,fetchImpl:catchUp});
        assert.equal(resumed.ran,1,'retained debt is drained at expiry');
      }
      assert.equal(resumed.items[0].ok,true,JSON.stringify(resumed.items[0]));
      assert.ok(resumedCalls>=2,'green expiry control reaches account and transaction reads');
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,1,'catch-up cannot duplicate money');
    } finally {f.close();}
  });
}

test('R3 three stale bank logins show distinct next steps in CLI status and Banks',async()=>{
  const {runBankStatusCommand}=await import('../../operations/bank-feed-status.mjs');
  const first=await connected();const {f}=first;
  try {
    await connected({fixture:f,itemRef:'synthetic-choice',accountId:'synthetic-choice-account',mask:'2222'});
    await connected({fixture:f,itemRef:'synthetic-overdue',accountId:'synthetic-overdue-account',mask:'3333'});
    for(const [ref,label] of [['synthetic-item','Bank 1111'],['synthetic-choice','Bank 2222'],['synthetic-overdue','Bank 3333']])
      f.raw('UPDATE bank_feed_items SET institution_label=? WHERE item_ref=?',label,ref);
    first.setLogin();
    const signIn=await syncPlaidItem(f.env,'synthetic-item',{now:DAY,fetchImpl:first.fetchImpl});
    assert.equal(signIn.code,'ITEM_LOGIN_REQUIRED','real sign-in failure reached');
    f.raw("UPDATE plaid_account_entity_assignments SET entity_slug=NULL,assigned_at=NULL WHERE item_ref='synthetic-choice'");
    const choose=await syncPlaidItem(f.env,'synthetic-choice',{now:DAY,fetchImpl:async url=>{
      if(new URL(url).pathname==='/accounts/get')return json({accounts:[{account_id:'synthetic-choice-account',name:'Checking',mask:'2222',type:'depository',subtype:'checking',balances:{current:'100.00',iso_currency_code:'USD'}}]});
      return json({added:[],modified:[],removed:[],next_cursor:'synthetic-choice-cursor',has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE'});
    }});
    assert.equal(choose.assignment_required,true,'real owner-choice promotion guard reached');
    const statusUrl=new URL('https://brain.invalid/api/bank-feed/status');
    const response=await handleBankFeed(f.env,new Request(statusUrl,{headers:await f.ownerHeaders()}),statusUrl,statusUrl.pathname,{bankFeedNow:OVERDUE});
    assert.equal(response.status,200);const banks=await response.json();
    assert.equal(banks.connections.length,3,'all three stored logins reached real status');
    for(const bank of banks.connections)assert.equal(bank.health.last_successful_sync_at,START,'no data since fixed date');
    let output='';const paths=[];
    const result=await runBankStatusCommand({manifestPath:'synthetic-manifest'}, {
      loadManifest:()=>({m:{brain:{domain:'brain.invalid'}}}),resolveAdminKey:()=>f.env.ADMIN_KEY,
      now:()=>Date.parse(OVERDUE),write:text=>{output=text;},request:async(url,init)=>{
        paths.push([new URL(url).pathname,init.method]);return new URL(url).pathname==='/health' ? json({status:'ok'}) : json(banks);
      }});
    assert.deepEqual(paths,[['/health','GET'],['/api/bank-feed/status','GET']]);
    const byBank=new Map(result.connections.map(bank=>[bank.bank,bank]));
    assert.match(byBank.get('Bank 1111').health_line,/sign in again.*Repair connection/i);
    assert.match(byBank.get('Bank 2222').health_line,/choose.*owner.*on the Connect a bank page/i);
    assert.match(byBank.get('Bank 3333').health_line,/48 hours.*Wait for the next sync/i);
    assert.doesNotMatch(output,/contact support|disconnect/i);
    const {transformSync}=await import('esbuild');const {runInNewContext}=await import('node:vm');
    const source=readFileSync(new URL('../../frontend/src/components/Settings.tsx',import.meta.url),'utf8');
    const start=source.indexOf('export function BankConnectionsSection('),end=source.indexOf('\nexport function ',start+1);
    const compiled=transformSync(source.slice(start,end),{loader:'tsx',format:'cjs',jsx:'transform'}).code;
    const module={exports:{}};
    runInNewContext(compiled,{module,exports:module.exports,
      ...bankRowHarness({Date:class extends Date {static now(){return Date.parse(OVERDUE);}}}),
      bankRowOutcome:await bankOutcomeHarness(),Date:class extends Date {static now(){return Date.parse(OVERDUE);}},
      Section:'section',Note:'note',Attention:'attention',Empty:'empty',Row:'row',Chip:'chip',Confirm:'confirm',agoISO:value=>value,DISCONNECT_BANK_QUESTION:'Disconnect this bank?'});
    const tree=module.exports.BankConnectionsSection({readState:'ready',banks,busy:false,onDisconnect:()=>assert.fail('repair must never disconnect')});
    const rendered=JSON.stringify(tree);
    for(const label of byBank.keys())assert.ok(rendered.includes(label),'each bank is visible');
    assert.match(rendered,/sign in again.*Repair connection/i);
    assert.match(rendered,/choose.*owner/i);
    assert.match(rendered,/48 hours/);
    assert.doesNotMatch(rendered,/contact support|Disconnect/,'fixable states show recovery, never disconnect');
  } finally {f.close();}
});

test('R3 ordinary status includes per-bank next steps only for an enabled feed',async()=>{
  const {cmdStatus}=await import('../../brain.mjs');
  for(const enabled of [true,false]) {
    const lines=[],warnings=[],requests=[],queries=[];
    await cmdStatus('synthetic-manifest',{
      loadManifest:()=>({m:{brain:{domain:'brain.invalid'},corpora:{bank_feed:{enabled}},infrastructure:{cloudflare:{d1_database_id:'fixture-database'}}}}),
      resolveAccount:async()=>({id:'fixture-account'}),resolveAdminKey:()=>['fixture','key'].join('-'),
      loadMigrations:()=>[{version:1,name:'fixture',checksum:'a'.repeat(16)}],
      d1Query:async(_account,_database,sql)=>{
        queries.push(sql);
        if(sql.includes('FROM install_state'))return {results:[{schema_version:1,client_slug:'synthetic-owner'}]};
        if(sql.includes('FROM schema_migrations'))return {results:[{version:1,name:'fixture',checksum:'a'.repeat(16)}]};
        return {results:[]};
      },
      write:line=>lines.push(line),warn:line=>warnings.push(line),now:()=>Date.parse(OVERDUE),
      request:async(url,init)=>{
        requests.push([new URL(url).pathname,init.method]);
        if(new URL(url).pathname==='/health')return json({status:'ok'});
        return json({configured:true,connections:[
          {institution_label:'Bank 1111',status:'reauth_required',health:{last_successful_sync_at:START,last_error_code:'ITEM_LOGIN_REQUIRED'}},
          {institution_label:'Bank 2222',status:'connected',health:{last_successful_sync_at:START},accounts_needing_owner:1},
          {institution_label:'Bank 3333',status:'connected',health:{last_successful_sync_at:START}},
        ]});
      },
    });
    assert.ok(queries.some(sql=>sql.includes('FROM install_state')),'real ordinary status decision reached');
    assert.equal(warnings.length,0);
    if(enabled) {
      assert.deepEqual(requests,[['/health','GET'],['/api/bank-feed/status','GET']]);
      const text=lines.join('\n');
      assert.match(text,/Bank 1111[\s\S]*sign in again.*Repair connection/i);
      assert.match(text,/Bank 2222[\s\S]*choose.*owner.*on the Connect a bank page/i);
      assert.match(text,/Bank 3333[\s\S]*48 hours.*Wait for the next sync/i);
      assert.doesNotMatch(text,/contact support|disconnect/i);
    } else {
      assert.equal(requests.length,0,'disabled-feed control makes no new request');
      assert.doesNotMatch(lines.join('\n'),/Bank 1111/);
    }
  }
});
