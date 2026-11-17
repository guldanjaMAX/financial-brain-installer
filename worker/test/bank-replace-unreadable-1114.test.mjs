import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { handleBankFeed, encryptAccessReference, decryptAccessReference } from '../src/lib/bank-feed.js';

const ambientFetch=globalThis.fetch;let forbiddenFetches=0;
test.before(()=>{globalThis.fetch=async()=>{forbiddenFetches++;throw Error('Ambient endpoint contact forbidden.');};});
test.after(()=>{globalThis.fetch=ambientFetch;assert.equal(forbiddenFetches,0);});
const NOW = '2026-11-14T12:00:00.000Z';
const randomKey = () => 'v2.' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
async function fixture() {
  const f = await createProductFixture({env:{BANK_FEED_ENABLED:'true',BANK_FEED_PROVIDER:'plaid',BANK_FEED_ENV:'sandbox',BANK_FEED_TENANT:'primary',INGEST_VERSION:'fixture-build',BANK_FEED_CLIENT_ID:crypto.randomUUID(),BANK_FEED_SECRET:crypto.randomUUID(),BANK_FEED_WRAPPING_KEY_V2:randomKey()}});
  const sealed = await encryptAccessReference(f.env, crypto.randomUUID());
  const healthy = await encryptAccessReference(f.env, crypto.randomUUID());
  f.env.BANK_FEED_WRAPPING_KEY_V2 = randomKey();
  const readable = await encryptAccessReference(f.env, crypto.randomUUID());
  for (const [id, value] of [['old', sealed], ['healthy', readable]]) f.raw(`INSERT INTO bank_feed_items
    (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,key_version,environment,status,status_detail,connected_at,last_synced_at,cursor)
    VALUES ('primary',?,'institution-fixture','Fixture bank',?,?,2,'sandbox','error','Needs attention','2026-09-01T00:00:00Z','2026-10-28T00:00:00Z','old-cursor')`,id,value.ciphertext,value.iv);
  f.raw("UPDATE bank_feed_items SET institution_ref='institution-healthy',status='connected',status_detail=NULL WHERE item_ref='healthy'");
  return {...f, sealed, healthy};
}
async function route(f, path, body, {operator=false}={}) {
  const headers = operator ? {'X-Admin-Key':f.env.ADMIN_KEY} : await f.ownerHeaders();
  const request = new Request('https://brain.invalid'+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return handleBankFeed(f.env,request,new URL(request.url),path,{bankFeedNow:NOW,bankFeedFetchImpl:f.fetchImpl});
}
test('read-only custody reaches real opening, separates unreadable and healthy, returns no secret',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(decryptAccessReference(f.env,{ciphertext:f.sealed.ciphertext,iv:f.sealed.iv,keyVersion:2}),{code:'BANK_ACCESS_REFERENCE_UNREADABLE'});
    const start=f.seen.sql.length;
    const response=await route(f,'/api/bank-feed/custody',undefined,{operator:true});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.connections.length,2);
    assert.equal(body.connections.find(r=>r.connection_ref==='old').code,'BANK_ACCESS_REFERENCE_UNREADABLE');
    assert.equal(body.connections.find(r=>r.connection_ref==='healthy').opens,true);
    assert.ok(f.seen.sql.slice(start).some(sql=>sql.includes('bank_feed_items')),'diagnostic selection reached');
    assert.equal(f.seen.sql.slice(start).filter(sql=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)).length,0);
    const projection=JSON.stringify(body);
    for(const hidden of [f.env.BANK_FEED_WRAPPING_KEY_V2,f.env.ADMIN_KEY,f.sealed.ciphertext,f.sealed.iv]) assert.equal(projection.includes(hidden),false);
    assert.match(body.connections[0].key_fingerprint,/^[a-f0-9]{64}$/);
  } finally {f.close();}
});

test('replacement preview reaches unreadable eligibility; healthy control stays ineligible and preview writes nothing',async()=>{
  const f=await fixture();
  try {
    const start=f.seen.sql.length;
    const bad=await route(f,'/api/bank-feed/replacement/preview',{item_ref:'old'});
    assert.equal(bad.status,200);
    const plan=await bad.json();
    assert.equal(plan.eligible,true);
    assert.ok(plan.plan_hash);
    const good=await route(f,'/api/bank-feed/replacement/preview',{item_ref:'healthy'});
    assert.equal(good.status,200);
    assert.equal((await good.json()).eligible,false);
    assert.ok(f.seen.sql.slice(start).filter(sql=>sql.includes('bank_feed_items')).length>=2);
    assert.equal(f.seen.sql.slice(start).filter(sql=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)).length,0);
  } finally {f.close();}
});

async function seeded() {
  const f=await fixture();seedOwnedEntity(f,'owned','Fixture business');
  f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,feed_mode,external_ref,source_feed,provenance,basis_state,recorded_at)
    VALUES ('primary','checking','owned','Fixture bank','Fixture checking','checking','asset','1234','USD','live','old-account','bank-feed:old','feed','confirmed',?)`,NOW);
  const {plaidPublicAccountRef}=await import('../src/lib/plaid-account-entities.js');
  const ref=await plaidPublicAccountRef('primary','old','old-account');
  f.raw(`INSERT INTO plaid_account_entity_assignments (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
    VALUES ('primary','old','old-account',?,'owned',?,?,?,?)`,ref,NOW,NOW,NOW,NOW);
  f.raw(`INSERT INTO fin_account_coverage (tenant_id,account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary','checking','complete','2024-10-01','2026-10-27','Statement compared',?,'feed','bank-feed:old','confirmed',?)`,NOW,NOW);
  for(const [id,date,amount] of [['older','2024-10-01',10000],['prior','2026-09-15',20000],['overlap','2026-10-27',30000]]) f.raw(`INSERT INTO fin_transactions
    (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,pending,external_id,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary',?,'checking',?,?,'outflow','USD','Fixture purchase','Fixture Store',0,?,'feed','bank-feed:old','confirmed',?)`,'plaid:'+id,date,amount,id,NOW);
  f.providerCalls=[];
  f.events=[event('changed-overlap','2026-10-27','300.00'),event('gap','2026-10-28','400.00'),event('november','2026-11-01','500.00')];
  f.inventory=[{account_id:'new-account',name:'Fixture checking',mask:'1234',type:'depository',subtype:'checking',balances:{iso_currency_code:'USD',current:'50.00',available:'45.00'}}];
  f.fetchImpl=async(url,init)=>{
    const path=new URL(url).pathname,body=JSON.parse(init.body);f.providerCalls.push({path,cursor:body.cursor});
    let data;
    if(path==='/link/token/create') data={link_token:crypto.randomUUID(),expiration:'2026-11-14T13:00:00.000Z'};
    if(path==='/item/public_token/exchange') data={item_id:f.currentItem || 'new',access_token:crypto.randomUUID()};
    if(path==='/item/get') data={item:{item_id:f.currentItem || 'new',institution_id:f.wrongInstitution?'wrong-institution':'institution-fixture',error:null}};
    if(path==='/accounts/get') data={accounts:f.inventory};
    if(path==='/transactions/sync') {
      if(f.failFetch) throw Error('fixture interrupted');
      data={added:f.events,modified:f.modified || [],removed:f.removed || [],next_cursor:'new-cursor-'+(f.providerCalls.filter(c=>c.path===path).length),has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE',...f.syncPage};
    }
    assert.ok(data,'injected provider decision reached');
    return Response.json(data);
  };
  return f;
}
// Ordinary sync stores the merchant name as the description. A supplies
// merchant with its provider category is a purchase the 0.4.28 type
// certificate can support independently, so High controls do not depend on
// raw bank text that ordinary sync never stores.
const event=(id,date,amount,extra={})=>({transaction_id:id,account_id:'new-account',amount,iso_currency_code:'USD',date,pending:false,name:'Fixture purchase',merchant_name:'Fixture Supplies',personal_finance_category:{primary:'GENERAL_MERCHANDISE',detailed:'GENERAL_MERCHANDISE_OFFICE_SUPPLIES'},...extra});
const mapping=[{account_slug:'checking',provider_id:'new-account',confirm:true}];
async function jsonRoute(f,action,body) {
  const response=await route(f,'/api/bank-feed/replacement/'+action,body);
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
}
async function start(f,itemRef='old') {
  const preview=await jsonRoute(f,'preview',{item_ref:itemRef});
  const approved=await jsonRoute(f,'approve',{item_ref:itemRef,approve:preview.plan_hash,expires_at:preview.expires_at,confirm_unrecoverable:true});
  const op=approved.operation_ref;
  await jsonRoute(f,'link',{operation_ref:op});
  await jsonRoute(f,'complete',{operation_ref:op,public_token:crypto.randomUUID()});
  return op;
}
const sum=f=>f.first(`SELECT SUM(amount_minor) AS n FROM fin_transactions WHERE pending=0 AND removed_at IS NULL AND superseded_by_id IS NULL`).n;
async function reviewed(f,op,choices=[]) {
  return jsonRoute(f,'review',{operation_ref:op,mappings:mapping,choices});
}
async function activate(f,op,choices=[]) {
  const plan=await reviewed(f,op,choices);assert.equal(plan.ready,true,JSON.stringify(plan));
  return jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,choices,approve:plan.plan_hash,expires_at:plan.expires_at});
}
test('exact account match keeps every old row, admits the gap once, persists alias and rollback restores pointer',async()=>{
  const f=await seeded();try {
    const original=f.rows('SELECT id,amount_minor FROM fin_transactions ORDER BY id');
    const op=await start(f);assert.equal(sum(f),60000);
    await jsonRoute(f,'stage',{operation_ref:op});
    assert.equal(f.providerCalls.find(c=>c.path==='/transactions/sync').cursor,undefined,'old cursor never copied');
    const plan=await reviewed(f,op);assert.equal(plan.ready,false);assert.equal(plan.unresolved,1);
    const oldId=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:oldId,evidence:'Statement occurrence compared by owner.'}];
    const approved=await activate(f,op,choices);assert.equal(approved.state,'active');
    assert.equal(sum(f),150000);
    assert.deepEqual(f.rows('SELECT id,amount_minor FROM fin_transactions ORDER BY id').slice(0,3),original);
    assert.equal(f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND removed_at IS NULL AND pending=0").n,70000);
    assert.equal(f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE posted_on<'2026-10-01' AND removed_at IS NULL AND pending=0").n,30000);
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:new');
    assert.equal(f.first("SELECT status FROM bank_feed_items WHERE item_ref='old'").status,'removed');
    assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='old'").cursor,'old-cursor');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_revocation_outbox').n,0);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_aliases').n,3);
    const {activateReplacement,rollbackReplacement}=await import('../src/lib/plaid-item-replacement.js');
    const hash=f.first('SELECT review_hash FROM plaid_item_replacements').review_hash;
    assert.equal((await activateReplacement(f.env,{operationRef:op,approve:hash,now:NOW})).state,'active');
    assert.equal(sum(f),150000);
    const rollback=await rollbackReplacement(f.env,{operationRef:op,now:NOW});
    await rollbackReplacement(f.env,{operationRef:op,approve:rollback.plan_hash,now:NOW});
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:old');
    assert.equal(sum(f),150000,'rollback preserves newly proved facts');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_audit').n>=5,true);
    assert.throws(()=>f.raw('DELETE FROM plaid_replacement_audit'),/append only/);
    assert.equal(f.first("SELECT status FROM bank_feed_items WHERE item_ref='healthy'").status,'connected');
  } finally {f.close();}
});
test('ambiguous account evidence requires an owner choice; wrong institution stays quarantined',async()=>{
  const f=await seeded();try {
    const op=await start(f);f.wrongInstitution=true;
    const denied=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op});
    assert.equal(denied.status,409);assert.ok(f.providerCalls.some(c=>c.path==='/item/get'));
    assert.equal(sum(f),60000);f.wrongInstitution=false;
    f.inventory[0].name='Different account name';
    await jsonRoute(f,'stage',{operation_ref:op});
    const plan=await jsonRoute(f,'review',{operation_ref:op});
    assert.equal(plan.ready,false);assert.equal(plan.accounts[0].provider_id,null);
    assert.ok(plan.accounts.length>0,'nonempty account decision reached');
    assert.equal(f.first("SELECT status FROM bank_feed_items WHERE item_ref='old'").status,'error');
    const chosen=await reviewed(f,op);assert.equal(chosen.accounts[0].confirmed,true,'explicit owner choice is the green control');
  } finally {f.close();}
});
test('interrupted staging and activation resume atomically; pending-to-posted correction keeps evidence',async()=>{
  const f=await seeded();try {
    f.raw(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,pending,external_id,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:pending-old','checking','2026-10-27',1500,'outflow','USD',1,'pending-old','feed','bank-feed:old','confirmed',?)`,NOW);
    f.events.push(event('posted-new','2026-10-29','15.00',{pending_transaction_id:'pending-old'}));
    const op=await start(f);f.failFetch=true;
    assert.equal((await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op})).status,409);
    assert.ok(f.providerCalls.some(c=>c.path==='/transactions/sync'));assert.equal(sum(f),60000);
    f.failFetch=false;await jsonRoute(f,'stage',{operation_ref:op});
    const overlap=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const pending=f.first("SELECT id FROM fin_transactions WHERE external_id='pending-old'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:overlap,evidence:'Statement occurrence compared.'},
      {event_index:3,action:'replace',old_row_id:pending,evidence:'Pending occurrence became this posted occurrence.'}];
    const plan=await reviewed(f,op,choices);assert.equal(plan.ready,true);
    f.control.failOn=/INSERT INTO fin_transactions/;
    const response=await route(f,'/api/bank-feed/replacement/activate',{operation_ref:op,mappings:mapping,choices,approve:plan.plan_hash,expires_at:plan.expires_at});
    assert.equal(response.status,409);assert.equal(sum(f),60000);
    assert.ok(f.seen.sql.some(sql=>sql.includes('INSERT INTO fin_transactions')));
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:old');
    f.control.failOn=null;await activate(f,op,choices);assert.equal(sum(f),151500);
    assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',pending).removed_at);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE pending=1').n,1,'pending evidence retained');
  } finally {f.close();}
});

test('same ids and changed ids dedupe once; identical purchases remain two; money readers preserve pre-gap figures',async()=>{
  const f=await seeded();try {
    const {queryMoney}=await import('../src/lib/money-query.js');
    const query=()=>queryMoney(f.env,{sql:"SELECT SUM(amount_minor) AS total_minor FROM fin_transactions WHERE account_slug='checking' AND posted_on BETWEEN '2024-10-01' AND '2026-09-30' AND removed_at IS NULL AND superseded_by_id IS NULL AND pending=0",period_end:'2026-09-30'},{now:()=>Date.parse(NOW)});
    const before=await query();assert.equal(before.rows[0].total_minor,30000);
    f.events.push(event('prior','2026-09-15','200.00'),event('purchase-a','2026-10-29','25.00'),event('purchase-b','2026-10-29','25.00'),event('income','2026-10-30','-80.00'));
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    await activate(f,op,[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement occurrence confirmed.'}]);
    assert.equal(f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE direction='outflow' AND pending=0 AND removed_at IS NULL").n,155000);
    assert.equal(f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE direction='inflow' AND pending=0 AND removed_at IS NULL").n,8000);
    const after=await query();assert.equal(after.rows[0].total_minor,before.rows[0].total_minor);
    assert.match(after.confidence_text,/Confidence: (High|Medium|Low) \(\d+%\)/);
    if(after.confidence.percent<100){assert.ok(after.confidence.reasons.length);assert.ok(after.confidence.missing.length);}
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE amount_minor=2500 AND pending=0 AND removed_at IS NULL").n,2);
    // A later backdated event remains durable, visible for review, and uncounted.
    f.events=[event('late','2026-10-26','70.00')];
    await jsonRoute(f,'stage',{operation_ref:op});const late=await reviewed(f,op);
    assert.equal(late.unresolved,1);assert.equal(late.decisions[0].amount_minor,7000);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events WHERE revision=2').n,1);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='late'").n,0);
    assert.ok(f.providerCalls.filter(c=>c.path==='/transactions/sync').at(-1).cursor.startsWith('new-cursor-'));
  } finally {f.close();}
});
test('provider and database fences stop old writers; healthy sync lease control still acquires',async()=>{
  const f=await seeded();try {
    const {claimPlaidSyncLease}=await import('../src/lib/plaid-sync-lease.js');
    const held=await claimPlaidSyncLease(f.env,{tenantId:'primary',itemRef:'old'});assert.ok(held);
    const op=await start(f);
    const {runPlaidSyncBatch}=await import('../src/lib/plaid-sync-lease.js');
    await assert.rejects(runPlaidSyncBatch(f.env,held,[f.DB.prepare("UPDATE fin_transactions SET amount_minor=1 WHERE source_feed='bank-feed:old'")]));
    assert.ok(f.seen.sql.some(sql=>sql.includes('plaid_sync_custody_guard')),'stale lease decision reached');
    assert.throws(()=>f.raw("UPDATE fin_transactions SET amount_minor=1 WHERE source_feed='bank-feed:old'"),/replacement ledger fenced/);
    assert.equal(sum(f),60000);
    assert.ok(await claimPlaidSyncLease(f.env,{tenantId:'primary',itemRef:'healthy'}));
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const count=f.providerCalls.length;const result=await syncPlaidItem(f.env,'old',{fetchImpl:f.fetchImpl,now:NOW});
    assert.equal(result.code,'PLAID_REPLACEMENT_HISTORY_RETAINED');assert.equal(f.providerCalls.length,count);
  } finally {f.close();}
});
test('stale owner assignment, operator-only approval and unrelated duplicate history cannot bypass review',async()=>{
  const f=await seeded();try {
    const preview=await jsonRoute(f,'preview',{item_ref:'old'});
    const denied=await route(f,'/api/bank-feed/replacement/approve',{item_ref:'old',approve:preview.plan_hash,expires_at:preview.expires_at,confirm_unrecoverable:true},{operator:true});
    assert.equal(denied.status,401);assert.equal(f.first('SELECT COUNT(*) n FROM plaid_item_replacements').n,0);assert.ok(preview.accounts.length>0);
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement compared.'}];
    const plan=await reviewed(f,op,choices);assert.equal(plan.ready,true);
    f.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='owned'");
    const blocked=await route(f,'/api/bank-feed/replacement/activate',{operation_ref:op,mappings:mapping,choices,approve:plan.plan_hash,expires_at:plan.expires_at});
    assert.equal(blocked.status,409);assert.equal(sum(f),60000);
    assert.ok(f.seen.sql.some(sql=>sql.includes('fin_entities')));
  } finally {f.close();}
});
test('current and changed v1/v2 custody has exact errors and no legacy fingerprint',async()=>{
  const {inspectBankCustody}=await import('../src/lib/bank-custody.js');
  const f=await fixture();try {
    for(const version of [1,2]){
      const material=crypto.randomUUID();
      const env={...f.env,SESSION_SIGNING_KEY:material};
      const sealed=await encryptAccessReference(env,crypto.randomUUID(),{keyVersion:version});
      const row={tenant_id:'primary',item_ref:'fixture',environment:'sandbox',access_ciphertext:sealed.ciphertext,access_iv:sealed.iv,key_version:version};
      assert.equal((await inspectBankCustody(env,row)).opens,true);
      const unused={...env,ADMIN_KEY:crypto.randomUUID()};assert.equal((await inspectBankCustody(unused,row)).opens,true);
      const changed={...env,...(version===1?{SESSION_SIGNING_KEY:crypto.randomUUID()}:{BANK_FEED_WRAPPING_KEY_V2:randomKey()})};
      assert.equal((await inspectBankCustody(changed,row)).code,'BANK_ACCESS_REFERENCE_UNREADABLE');
      if(version===1)assert.equal((await inspectBankCustody(env,row)).key_fingerprint,null);
      const unsupported=await inspectBankCustody(env,{...row,key_version:3});
      assert.equal(unsupported.code,'BANK_ACCESS_WRAPPING_KEY_VERSION_UNSUPPORTED');assert.match(unsupported.key_identity,/unsupported/);
      const missing={...env};if(version===1){delete missing.SESSION_SIGNING_KEY;delete missing.ADMIN_KEY;}else delete missing.BANK_FEED_WRAPPING_KEY_V2;
      assert.notEqual((await inspectBankCustody(missing,row)).code,'BANK_ACCESS_REFERENCE_UNREADABLE');
    }
  } finally {f.close();}
});
test('interval union preserves a hole instead of certifying min-to-max coverage',async()=>{
  const {bankCoverageGaps}=await import('../src/lib/bank-coverage-intervals.js');
  assert.deepEqual(bankCoverageGaps('2026-10-01','2026-10-31',[{from:'2026-10-01',to:'2026-10-27'},{from:'2026-10-29',to:'2026-10-31'}]),[['2026-10-28','2026-10-28']]);
  assert.deepEqual(bankCoverageGaps('2026-10-01','2026-10-31',[{from:'2026-10-01',to:'2026-10-27'},{from:'2026-10-28',to:'2026-10-31'}]),[]);
});
test('restore inventory includes replacement evidence after its ledger; older schema inventories stay unchanged',async()=>{
  const f=await seeded(), target=await createProductFixture();try {
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    await activate(f,op,[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement compared.'}]);
    const {recoveryExportTables}=await import('../../operations/cloudflare-recovery-adapter.mjs');
    const order=recoveryExportTables([{version:66}]);
    const newTables=['plaid_item_replacements','plaid_replacement_bindings','plaid_replacement_events','plaid_replacement_decisions','plaid_replacement_aliases','bank_account_coverage_intervals','plaid_replacement_audit','plaid_replacement_balance_evidence'];
    assert.ok(newTables.every(t=>order.includes(t)));
    assert.ok(newTables.every(t=>!recoveryExportTables([{version:65}]).includes(t)));
    assert.ok(order.indexOf('plaid_item_replacements')>order.indexOf('fin_transactions'));
    const ledgerTables=['fin_entities','fin_accounts','fin_transactions','fin_account_coverage','fin_balance_snapshots','fin_obligations','bank_feed_items','bank_feed_health','plaid_account_entity_assignments','plaid_link_operations'];
    const restored=order.filter(t=>ledgerTables.includes(t) || newTables.includes(t));
    for(const table of restored)for(const row of f.rows('SELECT * FROM '+table)){
      const keys=Object.keys(row);target.raw('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',...keys.map(k=>row[k]));
    }
    for(const table of restored)assert.deepEqual(target.rows('SELECT * FROM '+table),f.rows('SELECT * FROM '+table));
    assert.equal(sum(target),150000);
    assert.throws(()=>target.raw("UPDATE fin_transactions SET amount_minor=1 WHERE source_feed='bank-feed:old'"),/replacement ledger fenced/);
    assert.equal(sum(target),150000);
    assert.ok(f.first('SELECT COUNT(*) n FROM plaid_replacement_audit').n>0);
  } finally {f.close();target.close();}
});

test('read-only CLI command projects custody and returns documented exit codes through injected data-plane transport',async()=>{
  const f=await fixture();try {
    const {cmdBankStatus}=await import('../../brain.mjs');let reads=0,writes=0;
    const result=await cmdBankStatus(['custody','fixture.json','--json'],{
      loadManifest:()=>({m:{brain:{domain:'brain.invalid'}}}),resolveAdminKey:()=>crypto.randomUUID(),
      request:async(url,init)=>{reads++;assert.equal(init.method,'GET');return route(f,new URL(url).pathname,undefined,{operator:true});},
      write:value=>{writes++;const output=JSON.parse(value);assert.equal(output.read_only,true);assert.equal(output.connections.length,2);assert.equal('connection_ref' in output.connections[0],false);}
    });assert.equal(reads,1);assert.equal(writes,1);assert.equal(result.exit_code,2);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_item_replacements').n,0);
  } finally {f.close();}
});
test('new account and history plan cannot bypass another same-bank connection',async()=>{
  const f=await seeded();try {
    const op=await start(f);
    const sealed=await encryptAccessReference(f.env,crypto.randomUUID());
    f.raw(`INSERT INTO bank_feed_items (tenant_id,item_ref,institution_ref,access_ciphertext,access_iv,key_version,environment,status,connected_at)
      VALUES ('primary','unrelated','institution-fixture',?,?,2,'sandbox','connected',?)`,sealed.ciphertext,sealed.iv,NOW);
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,mask,currency,feed_mode,external_ref,source_feed,provenance,basis_state,recorded_at)
      VALUES ('primary','unrelated-checking','owned','Fixture checking','checking','asset','1234','USD','live','unrelated-provider','bank-feed:unrelated','feed','confirmed',?)`,NOW);
    const result=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op});
    assert.equal(result.status,409);assert.ok(f.providerCalls.some(c=>c.path==='/accounts/get'));
    assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,0);
    assert.equal(sum(f),60000);
  } finally {f.close();}
});
test('same-id pending-to-posted correction never counts both observations',async()=>{
  const f=await seeded();try {
    f.raw(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,pending,external_id,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','plaid:pending-same','checking','2026-10-27',1500,'outflow','USD',1,'pending-same','feed','bank-feed:old','confirmed',?)`,NOW);
    f.events.push(event('pending-same','2026-10-29','15.00'));
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const overlap=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const pending=f.first("SELECT id FROM fin_transactions WHERE external_id='pending-same'").id;
    await activate(f,op,[{event_index:0,action:'duplicate',old_row_id:overlap,evidence:'Statement occurrence verified.'},
      {event_index:3,action:'replace',old_row_id:pending,evidence:'Provider occurrence changed from pending to posted.'}]);
    assert.equal(sum(f),151500);assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='pending-same'").n,2);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='pending-same' AND removed_at IS NULL AND pending=0").n,1);
  } finally {f.close();}
});
test('Banks has one reconnect action for unreadable custody and a working repair control for readable consent errors',async()=>{
  const {readFileSync}=await import('node:fs'),{transformSync}=await import('esbuild'),{runInNewContext}=await import('node:vm');
  const source=readFileSync(new URL('../../frontend/src/components/Settings.tsx',import.meta.url),'utf8');
  const a=source.indexOf('export function BankConnectionsSection('),b=source.indexOf('\nexport function ',a+1);
  const compiled=transformSync(source.slice(a,b),{loader:'tsx',format:'cjs',jsx:'transform'}).code;
  const module={exports:{}};runInNewContext(compiled,{module,exports:module.exports,React:{createElement:(tag,props,...children)=>({tag,props,children}),Fragment:'fragment'},Section:'section',Note:'note',Attention:'attention',Empty:'empty',Row:'row',Chip:'chip',Confirm:'confirm',agoISO:x=>x,DISCONNECT_BANK_QUESTION:'Confirm disconnect?'});
  for(const unreadable of [true,false]){
    const rendered=JSON.stringify(module.exports.BankConnectionsSection({readState:'ready',busy:false,onDisconnect:()=>{},banks:{configured:true,connections:[{item_ref:'fixture',institution_label:'Fixture bank',status:'reauth_required',health:{state:unreadable?'needs_reconnect':'login_required',needs_reconnect:unreadable,needs_sign_in:!unreadable}}]}}));
    assert.match(rendered,/Fixture bank/);
    assert.equal(rendered.includes('Replace unreadable connection'),unreadable);
    assert.equal(rendered.includes('"Repair connection"'),!unreadable);
    assert.equal(rendered.includes('"Disconnect"'),false);
  }
});
test('replacement coverage and unresolved cents enter real clean-money confidence without altering historical figures',async()=>{
  const f=await seeded();try {
    f.env.BRAIN_TIMEZONE='UTC';
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const {queryMoney}=await import('../src/lib/money-query.js');
    const result=await queryMoney(f.env,{sql:"SELECT SUM(amount_minor) AS total_minor FROM txn WHERE account_slug='checking' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31'"},{now:()=>Date.parse(NOW)});
    assert.equal(result.rows[0].total_minor,30000);
    assert.ok(result.confidence.percent<=69);
    assert.match(result.confidence.reasons.join(' '),/replacement activity awaiting review/);
    assert.ok(result.confidence.missing.length);
  } finally {f.close();}
});

test('same-day balances retain original evidence and account kind/link approvals survive exact lineage',async()=>{
  const f=await seeded();try {
    f.raw(`INSERT INTO fin_balance_snapshots (tenant_id,account_slug,as_of_date,current_minor,currency,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','checking','2026-11-14',70000,'USD','feed','bank-feed:old','confirmed','2026-11-14T10:00:00.000Z')`);
    const {maintainAccountKind,accountKindIdentity}=await import('../src/lib/fin-account-kinds.js');
    const kind=await maintainAccountKind(f.env,{selector:'checking',kind:'checking',dryRun:true,now:NOW});
    await maintainAccountKind(f.env,{selector:'checking',kind:'checking',dryRun:false,approve:kind.plan_hash,now:NOW});
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('primary','statement','owned','Fixture bank','Fixture checking','checking','asset','1234','USD','manual','owner_stated','confirmed',?)`,NOW);
    const {maintainAccountLink,accountLinkIdentity}=await import('../src/lib/fin-account-links.js');
    const link=await maintainAccountLink(f.env,{manualSlug:'statement',liveSlug:'checking',now:NOW});
    await maintainAccountLink(f.env,{manualSlug:'statement',liveSlug:'checking',dryRun:false,approve:link.plan_hash,now:NOW});
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    await activate(f,op,[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement occurrence compared.'}]);
    const balance=f.first("SELECT * FROM fin_balance_snapshots WHERE account_slug='checking'");assert.equal(balance.current_minor,5000);
    assert.equal(balance.recorded_at,NOW);assert.equal(f.first('SELECT COUNT(*) n FROM fin_balance_snapshots').n,1);
    const original=JSON.parse(f.first('SELECT snapshot_json FROM plaid_replacement_balance_evidence WHERE balance_id>0').snapshot_json);assert.equal(original.current_minor,70000);
    const account=f.first("SELECT * FROM fin_accounts WHERE account_slug='checking'");
    const review=f.first('SELECT * FROM fin_account_kind_reviews WHERE revoked_at IS NULL');assert.equal(review.identity_json,accountKindIdentity(account));
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n,2);
    const manual=f.first("SELECT * FROM fin_accounts WHERE account_slug='statement'");
    assert.equal(f.first('SELECT identity_json FROM fin_account_links WHERE unlinked_at IS NULL').identity_json,JSON.stringify([accountLinkIdentity(manual),accountLinkIdentity(account)]));
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n,2);
  } finally {f.close();}
});

test('lost exchange response never consumes a second handoff or publishes candidate history',async()=>{
  const f=await seeded();try {
    const preview=await jsonRoute(f,'preview',{item_ref:'old'});
    const approved=await jsonRoute(f,'approve',{item_ref:'old',approve:preview.plan_hash,expires_at:preview.expires_at,confirm_unrecoverable:true});
    const op=approved.operation_ref;await jsonRoute(f,'link',{operation_ref:op});
    const fetchImpl=f.fetchImpl;let exchanges=0;
    f.fetchImpl=async(url,init)=>{if(new URL(url).pathname==='/item/public_token/exchange'){exchanges++;throw Error('synthetic response loss');}return fetchImpl(url,init);};
    const handoff=crypto.randomUUID();
    for(let i=0;i<2;i++)assert.equal((await route(f,'/api/bank-feed/replacement/complete',{operation_ref:op,public_token:handoff})).status,409);
    assert.equal(exchanges,1,'one-shot decision reached');assert.equal(sum(f),60000);
    assert.equal(f.first('SELECT state FROM plaid_item_replacements').state,'outcome_unknown');
    assert.equal(f.first("SELECT COUNT(*) n FROM bank_feed_items WHERE item_ref='new'").n,0);
  } finally {f.close();}
});
test('real custody CLI exits 0, 2 or 3 with file-backed fixture credentials and forbidden host helpers',async()=>{
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync}=await import('node:fs');
  const {join,resolve}=await import('node:path'),{pathToFileURL}=await import('node:url');
  const {spawnSync}=await import('node:child_process');
  for(const exitCode of [0,2,3]){
    const root=mkdtempSync(join((process.env.HOME||process.env.USERPROFILE||process.env.TEMP),'custody-cli-'));mkdirSync(join(root,'bin'));
    const key=crypto.randomUUID(),manifest=join(root,'manifest.json'),launchctl=join(root,'bin','launchctl');
    writeFileSync(manifest,JSON.stringify({brain:{domain:'brain.invalid'},operations:{}}));
    writeFileSync(join(root,'.brain-admin-key'),key,{mode:0o600});writeFileSync(launchctl,'#!/bin/sh\nexit 99\n',{mode:0o700});
    const hook=join(root,'offline.mjs');
    writeFileSync(hook,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {readFileSync,appendFileSync} from 'node:fs';
const deny=()=>{throw Error('host helper forbidden');};for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[method]=deny;syncBuiltinESMExports();
const key=readFileSync(new URL('./.brain-admin-key',import.meta.url),'utf8');
globalThis.fetch=async(url,options)=>{if(url!=='https://brain.invalid/api/bank-feed/custody' || options.method!=='GET' || new Headers(options.headers).get('X-Admin-Key')!==key)throw Error('network forbidden');appendFileSync(new URL('./calls.txt',import.meta.url),'read\\n');return Response.json({read_only:true,exit_code:${exitCode},connections:[{connection_ref:'private-fixture-id',key_version:2,opens:${exitCode===0},key_identity:'dedicated bank wrapping key',key_fingerprint:'a'.repeat(64),cursor_saved:true,cursor_fingerprint:'b'.repeat(64),code:'fixture-code',detail:'Saved history is kept.'}]});};`);
    const env={HOME:root,USERPROFILE:root,PATH:join(root,'bin'),TMPDIR:root,TMP:root,TEMP:root,BRAIN_NO_WRANGLER_LOGIN:'1',BRAIN_TEST_LAUNCHCTL:launchctl};
    const child=spawnSync(process.execPath,['--import',pathToFileURL(hook).href,resolve('brain.mjs'),'bank','custody',manifest,'--json'],{encoding:'utf8',timeout:8000,env});
    assert.equal(child.status,exitCode,child.stderr);assert.equal(readFileSync(join(root,'calls.txt'),'utf8'),'read\n');
    assert.equal(child.stdout.includes(key),false);assert.equal(child.stdout.includes('private-fixture-id'),false);
    assert.equal(JSON.parse(child.stdout).connections.length,1);
  }
});

test('candidate page script parses, includes an accessible viewport and does not embed credentials',async()=>{
  const {replacementPage}=await import('../src/lib/bank-replacement-page.js'),{Script}=await import('node:vm');
  const page=replacementPage(),html=await page.text();
  const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(()=>new Script(script));
  assert.match(html,/name="viewport"/);assert.match(html,/aria-live="polite"/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(html.includes('X-Admin-Key'),false);assert.equal(html.includes('minor units'),false);
});

test('owner-proved coverage joins adjacent intervals, retains the old interval and records a dated successful observation',async()=>{
  const f=await seeded();try {
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement occurrence confirmed.'}];
    const intervals=[{account_slug:'checking',from:'2026-10-28',to:'2026-11-13',evidence:'All statement occurrences and empty dates reconciled.'}];
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings:mapping,choices,intervals});assert.equal(plan.ready,true);
    await jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,choices,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
    const coverage=f.first("SELECT covered_from,covered_to,coverage_status FROM fin_account_coverage WHERE account_slug='checking'");
    assert.deepEqual({...coverage},{covered_from:'2024-10-01',covered_to:'2026-11-13',coverage_status:'complete'});
    assert.equal(f.first('SELECT COUNT(*) n FROM bank_account_coverage_intervals').n,2);
    const health=f.first("SELECT last_successful_sync_at,data_through FROM bank_feed_health WHERE item_ref='new'");
    assert.equal(health.last_successful_sync_at,NOW);assert.equal(health.data_through,'2026-11-13');assert.equal(sum(f),150000);
  } finally {f.close();}
});

test('scheduled successor sync admits distinct later activity under retained owner authority but holds a backdated difference',async()=>{
  const f=await seeded();try {
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:old,evidence:'Statement occurrence confirmed.'}];
    const intervals=[{account_slug:'checking',from:'2026-10-28',to:'2026-11-13',evidence:'All statement occurrences and empty dates compared.'}];
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings:mapping,choices,intervals});
    await jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,choices,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
    f.events=[event('later','2026-11-14','60.00')];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const receipt=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    assert.equal(receipt.ok,true);assert.equal(sum(f),156000);
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements').published_revision,2);
    f.events=[event('backdated','2026-10-26','70.00')];
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    assert.equal(held.partial,false);assert.equal(held.ok,true);assert.equal(sum(f),156000);
    assert.equal(held.replacement.state,'active');assert.equal(held.ok,true);assert.equal(held.replacement.published_revision,held.replacement.revision);assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements').published_revision,3);
    const {rollbackReplacement}=await import('../src/lib/plaid-item-replacement.js');
    const rollback=await rollbackReplacement(f.env,{operationRef:op,now:NOW});
    await rollbackReplacement(f.env,{operationRef:op,approve:rollback.plan_hash,now:NOW});
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:old');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events WHERE revision=3').n,1);
    assert.equal(sum(f),156000);
  } finally {f.close();}
});

test('loan replacement keeps one obligation and updates only a provider-owned observation',async()=>{
  for(const ownerMaintained of [false,true]){
    const f=await seeded();try {
      f.raw("UPDATE fin_accounts SET account_kind='loan',balance_role='liability' WHERE account_slug='checking'");
      f.inventory[0].type='loan';f.inventory[0].subtype='business';
      const uid=ownerMaintained?'owner-loan':'plaid-obligation:checking';
      f.raw(`INSERT INTO fin_obligations (tenant_id,obligation_uid,entity_slug,kind,account_slug,balance_minor,balance_as_of,currency,provenance,source_feed,basis_state,recorded_at)
        VALUES ('primary',?,'owned','loan','checking',100000,'2026-10-27','USD',?,?,'confirmed','2026-10-27T12:00:00.000Z')`,uid,ownerMaintained?'owner_stated':'feed',ownerMaintained?null:'bank-feed:old');
      const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
      const id=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
      await activate(f,op,[{event_index:0,action:'duplicate',old_row_id:id,evidence:'Statement occurrence checked.'}]);
      assert.equal(f.first('SELECT COUNT(*) n FROM fin_obligations').n,1);
      const obligation=f.first('SELECT obligation_uid,balance_minor FROM fin_obligations');
      assert.equal(obligation.obligation_uid,uid);assert.equal(obligation.balance_minor,ownerMaintained?100000:5000);
      assert.equal(f.first("SELECT balance_role FROM fin_accounts WHERE account_slug='checking'").balance_role,'liability');
    } finally {f.close();}
  }
});
test('schema 66 is independently restart-safe on a populated migrated database',async()=>{
  const f=await seeded();try {
    const {readFileSync}=await import('node:fs');const sql=readFileSync(new URL('../../migrations/d1/0066_plaid_item_replacement.sql',import.meta.url),'utf8');
    f.sqlite.exec(sql);f.sqlite.exec(sql);assert.equal(sum(f),60000);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_item_replacements').n,0);
    assert.ok(f.first("SELECT COUNT(*) n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'replacement_fence_%'").n>=30);
  } finally {f.close();}
});


// Production-valued metadata is entirely synthetic. The injected provider and
// ambient fetch guard keep the High control independent of any live endpoint.
async function provedReplacement({twoAccounts=false,coverageGap=false,events=null,balances=null}={}) {
  const f=await seeded();if(balances)Object.assign(f.inventory[0].balances,balances);
  f.env.BANK_FEED_ENV='production';f.env.BRAIN_TIMEZONE='UTC';
  f.raw("UPDATE bank_feed_items SET environment='production'");
  f.raw("UPDATE fin_accounts SET opened_on='2024-10-01'");
  const mappings=[...mapping];
  if(twoAccounts) {
    const {plaidPublicAccountRef}=await import('../src/lib/plaid-account-entities.js');
    const ref=await plaidPublicAccountRef('primary','old','old-savings');
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,feed_mode,external_ref,source_feed,provenance,basis_state,opened_on,recorded_at)
      VALUES ('primary','savings','owned','Fixture bank','Fixture savings','savings','asset','5678','USD','live',?,'bank-feed:old','feed','confirmed','2024-10-01',?)`,ref,NOW);
    f.raw(`INSERT INTO plaid_account_entity_assignments (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
      VALUES ('primary','old','old-savings',?,'owned',?,?,?,?)`,ref,NOW,NOW,NOW,NOW);
    f.raw(`INSERT INTO fin_account_coverage (tenant_id,account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','savings','complete','2024-10-01','2026-10-27','Statement compared',?,'feed','bank-feed:old','confirmed',?)`,NOW,NOW);
    f.raw(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,pending,external_id,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary','separate-purchase','savings','2026-10-20',9000,'outflow','USD','Fixture purchase','Fixture Store',0,'separate-purchase','feed','bank-feed:old','confirmed',?)`,NOW);
    f.inventory.push({account_id:'new-savings',name:'Fixture savings',mask:'5678',type:'depository',subtype:'savings',balances:{iso_currency_code:'USD',current:'20.00',available:'20.00'}});
    mappings.push({account_slug:'savings',provider_id:'new-savings',confirm:true});
  }
  f.raw("UPDATE fin_transactions SET category='PURCHASE',category_basis_state='confirmed'");
  f.events=events || [event('overlap','2026-10-27','300.00'),event('gap','2026-10-28','400.00'),event('november','2026-11-01','500.00')];
  const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
  const intervals=mappings.map(m=>({account_slug:m.account_slug,from:coverageGap?'2026-10-29':'2026-10-28',to:'2026-11-13',evidence:'Complete statement interval independently compared.'}));
  const plan=await jsonRoute(f,'review',{operation_ref:op,mappings,intervals});
  assert.equal(plan.ready,true);assert.equal(plan.decisions.length,3);
  await jsonRoute(f,'activate',{operation_ref:op,mappings,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
  return {f,op,mappings};
}
async function monthlyAnswer(f,month,account='checking') {
  const {queryMoney}=await import('../src/lib/money-query.js');
  return queryMoney(f.env,{sql:`SELECT SUM(amount_minor) AS total_minor FROM txn WHERE account_slug='${account}' AND posted_on BETWEEN '2026-${month}-01' AND '2026-${month}-${month==='11'?'13':month==='09'?'30':'31'}'`},{now:()=>Date.parse(NOW)});
}
test('replacement publication keeps the provider merchant and category the ordinary sync stores',async()=>{
  // 0.4.29 integration: the 0.4.28 party certificate and merchant/category
  // questions read payee and category. A handed-over row must carry them.
  const {f}=await provedReplacement({events:[event('overlap','2026-10-27','300.00'),
    event('gap','2026-10-28','400.00',{merchant_name:'Fixture Store',personal_finance_category:{primary:'GENERAL_MERCHANDISE',detailed:'GENERAL_MERCHANDISE_OTHER'}}),
    event('november','2026-11-01','500.00',{merchant_name:undefined,personal_finance_category:undefined})]});try {
    const gap=f.first("SELECT payee,category,category_basis_state FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL");
    assert.deepEqual({...gap},{payee:'Fixture Store',category:'GENERAL_MERCHANDISE_OTHER',category_basis_state:'proposed'});
    const november=f.first("SELECT payee,category FROM fin_transactions WHERE external_id='november' AND removed_at IS NULL");
    assert.equal(november.payee,null,'an absent provider merchant is never invented');assert.equal(november.category,null);
    const {queryMoney}=await import('../src/lib/money-query.js');
    const merchant=await queryMoney(f.env,{sql:"SELECT SUM(amount_minor) AS total_minor FROM txn WHERE payee='Fixture Store' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31'"},{now:()=>Date.parse(NOW)});
    assert.equal(merchant.rows[0].total_minor,70000,'the handed-over gap purchase counts toward its merchant');
  } finally {f.close();}
});
test('R2 clean replacement has a nonempty High October control',async()=>{
  const {f}=await provedReplacement();try {
    const result=await monthlyAnswer(f,'10');
    assert.equal(result.rows[0].total_minor,70000);
    assert.equal(result.confidence.level,'High',JSON.stringify(result.confidence));
    assert.ok(f.seen.sql.some(s=>s.includes("'confidence_accounts'")));
  } finally {f.close();}
});
for(const kind of ['modified','removed'])test(`R2 ${kind} resolves the saved October occurrence before scoring historical confidence`,async()=>{
  const {f,op}=await provedReplacement();try {
    const control=await monthlyAnswer(f,'10');assert.equal(control.rows[0].total_minor,70000);assert.equal(control.confidence.level,'High');
    f.events=[];
    if(kind==='modified')f.modified=[event('gap','2026-11-02','410.00')];
    else f.removed=[{transaction_id:'gap'}];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const staged=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    assert.equal(staged.replacement.state,'active');assert.equal(staged.ok,true);assert.equal(staged.replacement.published_revision,staged.replacement.revision);assert.equal(staged.replacement.staged_events,0);assert.equal(staged.replacement.open_review_count,1);assert.equal(staged.ok,true);
    const plan=await reviewed(f,op);assert.equal(plan.decisions.length,1);assert.equal(plan.decisions[0].action,'review');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events WHERE revision=2').n,1);
    const held=await monthlyAnswer(f,'10');assert.equal(held.rows[0].total_minor,70000);
    assert.ok(held.confidence.percent<=69,JSON.stringify(held.confidence));
    assert.match(held.confidence.reasons.join(' '),/400[.]00.*2026-10-28|2026-10-28.*400[.]00/);
    if(kind==='modified') {
      const november=await monthlyAnswer(f,'11');assert.equal(november.rows[0].total_minor,50000);assert.ok(november.confidence.percent<=69);
      assert.match(november.confidence.reasons.join(' '),/410[.]00.*2026-11-02|2026-11-02.*410[.]00/);
    }
    const unrelated=await monthlyAnswer(f,'09');assert.equal(unrelated.rows[0].total_minor,20000);assert.equal(unrelated.confidence.level,'High');
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    await activate(f,op,[{event_index:0,action:kind==='removed'?'remove':'replace',old_row_id:old,evidence:'Statement confirms this exact corrected occurrence.'}]);
    assert.equal((await monthlyAnswer(f,'10')).rows[0].total_minor,30000);
    assert.equal((await monthlyAnswer(f,'11')).rows[0].total_minor,kind==='removed'?50000:91000);
    assert.equal((await monthlyAnswer(f,'10')).confidence.level,'High');
  } finally {f.close();}
});

function addWithdrawn(f) {
  f.raw(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,pending,external_id,removed_at,removal_reason,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary','plaid:withdrawn','checking','2026-10-26',7500,'outflow','USD',0,'withdrawn-occurrence',?,'Statement withdrawal','feed','bank-feed:old','confirmed',?)`,NOW,NOW);
}
const rowMultiset=f=>f.rows('SELECT id,txn_uid,posted_on,amount_minor,direction,removed_at FROM fin_transactions ORDER BY id').map(r=>({...r}));
for(const phase of ['first handover','automatic sync'])test(`R2 withdrawn occurrence cannot auto-admit on ${phase}; a distinct provider id still admits`,async()=>{
  for(const withdrawn of [false,true]) {
    const f=await seeded();try {
      addWithdrawn(f);assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions WHERE removed_at IS NOT NULL').n,1);
      const op=await start(f);
      if(phase==='automatic sync') {
        f.events=[event('distinct-first','2026-10-28','85.00')];await jsonRoute(f,'stage',{operation_ref:op});
        const intervals=[{account_slug:'checking',from:'2026-10-28',to:'2026-11-13',evidence:'Complete statement interval independently compared.'}];
        const plan=await jsonRoute(f,'review',{operation_ref:op,mappings:mapping,intervals});assert.equal(plan.ready,true);
        await jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
      }
      const before=rowMultiset(f),saved=sum(f),date=phase==='automatic sync'?'2026-11-14':'2026-10-28';
      f.events=[event(withdrawn?'withdrawn-occurrence':'distinct-control',date,'75.00')];
      if(phase==='automatic sync') {
        const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
        const result=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
        assert.equal(result.replacement.state,'active');assert.equal(result.ok,true);assert.equal(result.replacement.open_review_count,withdrawn?1:0);
      } else await jsonRoute(f,'stage',{operation_ref:op});
      assert.ok(f.providerCalls.some(c=>c.path==='/transactions/sync'));
      if(withdrawn) {
        const plan=await reviewed(f,op);assert.equal(plan.decisions.length,1);assert.equal(plan.decisions[0].action,'review');assert.equal(plan.ready,false);
        assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events e WHERE NOT EXISTS(SELECT 1 FROM plaid_replacement_decisions d WHERE d.tenant_id=e.tenant_id AND d.operation_ref=e.operation_ref AND d.revision=e.revision AND d.event_index=e.event_index)').n,1);
        assert.deepEqual(rowMultiset(f),before);assert.equal(sum(f),saved);
      } else {
        if(phase==='first handover') {const plan=await reviewed(f,op);assert.equal(plan.ready,true);assert.equal(plan.decisions[0].action,'admit');await activate(f,op);}
        assert.equal(sum(f),saved+7500);assert.equal(rowMultiset(f).length,before.length+1);
        assert.deepEqual(rowMultiset(f).slice(0,before.length),before);
      }
      const oct=f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND pending=0 AND removed_at IS NULL").n;
      assert.equal(oct,phase==='automatic sync'?38500:withdrawn?30000:37500);
    } finally {f.close();}
  }
});


test('R2 rollback keeps known review dollars and offers an explicit resume without changing the account pointer',async()=>{
  const {f,op}=await provedReplacement();try {
    f.events=[event('backdated','2026-10-26','70.00')];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const rollback=await jsonRoute(f,'rollback',{operation_ref:op});await jsonRoute(f,'rollback',{operation_ref:op,approve:rollback.plan_hash});
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);assert.ok(answer.confidence.percent<=69);
    assert.match(answer.confidence.reasons.join(' '),/70[.]00.*2026-10-26/);
    const plan=await reviewed(f,op);assert.equal(plan.decisions.length,1);assert.equal(plan.unresolved,1);
    const choice=[{event_index:0,action:'admit',evidence:'Independent statement shows a distinct older occurrence.'}];
    const ready=await reviewed(f,op,choice);assert.equal(ready.ready,true);
    assert.equal((await route(f,'/api/bank-feed/replacement/activate',{operation_ref:op,mappings:mapping,choices:choice,approve:ready.plan_hash,expires_at:ready.expires_at})).status,409,'activation requires a separate resume choice');
    const resume=await jsonRoute(f,'resume',{operation_ref:op});assert.ok(resume.plan_hash);
    await jsonRoute(f,'resume',{operation_ref:op,approve:resume.plan_hash});
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:old');
    assert.equal(sum(f),150000,'resume alone publishes no new facts');
    await activate(f,op,choice);assert.equal(sum(f),157000);
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:new');
  } finally {f.close();}
});
test('R2 debt-free rollback has no retained occurrence debt and no resume decision',async()=>{
  const {f,op}=await provedReplacement();try {
    const rollback=await jsonRoute(f,'rollback',{operation_ref:op});await jsonRoute(f,'rollback',{operation_ref:op,approve:rollback.plan_hash});
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events WHERE revision>(SELECT published_revision FROM plaid_item_replacements)').n,0);
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);
    assert.doesNotMatch(answer.confidence.reasons.join(' '),/replacement activity awaiting review/);
    assert.equal((await route(f,'/api/bank-feed/replacement/resume',{operation_ref:op})).status,409);
  } finally {f.close();}
});


async function independentAccount(f) {
  const {plaidPublicAccountRef}=await import('../src/lib/plaid-account-entities.js');
  const ref=await plaidPublicAccountRef('primary','healthy','separate-provider');
  f.raw("UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref='healthy'",NOW);
  f.raw("INSERT INTO bank_feed_health (tenant_id,item_ref,last_successful_sync_at,data_through) VALUES ('primary','healthy',?,'2026-11-13')",NOW);
  f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,label,institution,mask,account_kind,balance_role,currency,feed_mode,external_ref,source_feed,provenance,basis_state,opened_on,recorded_at)
    VALUES ('primary','separate','owned','Independent checking','Independent bank','5678','checking','asset','USD','live',?,'bank-feed:healthy','feed','confirmed','2024-10-01',?)`,ref,NOW);
  f.raw(`INSERT INTO plaid_account_entity_assignments (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,discovered_at,last_seen_at,assigned_at,updated_at)
    VALUES ('primary','healthy','separate-provider',?,'owned',?,?,?,?)`,ref,NOW,NOW,NOW,NOW);
  f.raw(`INSERT INTO fin_account_coverage (tenant_id,account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary','separate','complete','2024-10-01','2026-11-13','Statement compared',?,'feed','bank-feed:healthy','confirmed',?)`,NOW,NOW);
  f.raw(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,payee,category,category_basis_state,pending,provenance,source_feed,basis_state,recorded_at)
    VALUES ('primary','independent-purchase','separate','2026-10-20',9000,'outflow','USD','Fixture Store','PURCHASE','confirmed',0,'feed','bank-feed:healthy','confirmed',?)`,NOW);
}
for(const kind of ['removal','alias'])test(`R2 unknown ${kind} lineage stays conservative while an unrelated supported account stays High`,async()=>{
  const {f,op}=await provedReplacement();try {
    await independentAccount(f);
    const {moneyConfidenceSnapshotSql}=await import('../src/lib/money-confidence.js');
    const direct=f.rows(moneyConfidenceSnapshotSql(true)).filter(r=>r.snapshot_kind==='confidence_accounts').map(r=>JSON.parse(r.value));
    assert.equal(direct.length,2);assert.ok(direct.some(a=>a.account_slug==='separate'));
    const control=await monthlyAnswer(f,'10','separate');assert.equal(control.confidence.level,'High',JSON.stringify(control.confidence));
    if(kind==='removal'){f.events=[];f.removed=[{transaction_id:'unknown-occurrence'}];}
    else {
      f.raw("INSERT INTO plaid_replacement_aliases (tenant_id,operation_ref,provider_id,account_slug,canonical_row_id,created_at) VALUES ('primary',?,'unknown-occurrence','checking',999999,?)",op,NOW);
      f.events=[event('unknown-occurrence','2026-11-14','40.00')];
    }
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const plan=await reviewed(f,op);assert.equal(plan.decisions[0].action,'review');
    for(const month of ['09','10','11']) {
      const answer=await monthlyAnswer(f,month);assert.ok(answer.confidence.percent<=69);
      assert.match(answer.confidence.reasons.join(' '),/unknown affected dates or dollars/);
      assert.match(answer.confidence.missing.join(' '),/original statement/);
    }
    const separate=await monthlyAnswer(f,'10','separate');assert.equal(separate.rows[0].total_minor,9000);assert.equal(separate.confidence.level,'High');
  } finally {f.close();}
});
test('R2 an alias resolves a changed provider ID withdrawal to the exact saved dollars and date',async()=>{
  const f=await seeded();try {
    f.env.BANK_FEED_ENV='production';f.env.BRAIN_TIMEZONE='UTC';f.raw("UPDATE bank_feed_items SET environment='production'");
    f.raw("UPDATE fin_accounts SET opened_on='2024-10-01'");f.raw("UPDATE fin_transactions SET category='PURCHASE',category_basis_state='confirmed'");
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'duplicate',old_row_id:old,evidence:'Exact statement occurrence independently compared.'}];
    const intervals=[{account_slug:'checking',from:'2026-10-28',to:'2026-11-13',evidence:'Complete statement interval independently compared.'}];
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings:mapping,choices,intervals});assert.equal(plan.ready,true);
    await jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,choices,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
    assert.equal((await monthlyAnswer(f,'10')).confidence.level,'High');
    f.events=[];f.removed=[{transaction_id:'changed-overlap'}];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    const review=await reviewed(f,op);assert.equal(review.decisions.length,1);assert.equal(review.decisions[0].action,'review');
    assert.equal(review.decisions[0].saved_occurrences.find(r=>r.id===old).amount_minor,30000);
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);assert.ok(answer.confidence.percent<=69);
    assert.match(answer.confidence.reasons.join(' '),/USD [$]300[.]00 outflow on 2026-10-27/);
    await activate(f,op,[{event_index:0,action:'remove',old_row_id:old,evidence:'Statement confirms this exact provider withdrawal.'}]);
    assert.equal((await monthlyAnswer(f,'10')).rows[0].total_minor,40000);
    assert.equal((await monthlyAnswer(f,'11')).rows[0].total_minor,50000);
    assert.equal((await monthlyAnswer(f,'10')).confidence.level,'High');
    // The same alias now points at a tombstone. Even a later posting date and
    // a later provider page cannot turn it into new money automatically.
    f.removed=[];f.events=[event('changed-overlap','2026-11-14','300.00')];const before=rowMultiset(f);
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.state,'active');assert.equal(held.ok,true);assert.equal(held.replacement.published_revision,held.replacement.revision);
    const again=await reviewed(f,op);assert.equal(again.decisions[0].action,'review');assert.equal(again.decisions[0].saved_occurrences.find(r=>r.id===old).withdrawn,true);
    assert.deepEqual(rowMultiset(f),before);assert.equal(sum(f),120000);
    const reject=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings:mapping,choices:[{event_index:0,action:'admit',evidence:'A later posting date alone is insufficient.'}]});
    assert.equal(reject.status,409);assert.equal((await reject.json()).code,'replacement_admission_conflict');
  } finally {f.close();}
});


test('R2 unresolved changed-ID overlap names the saved period as well as the incoming period',async()=>{
  const {f,op}=await provedReplacement();try {
    assert.equal((await monthlyAnswer(f,'10')).confidence.level,'High');
    f.events=[event('possible-changed-id','2026-11-02','400.00')];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const review=await reviewed(f,op);assert.equal(review.decisions.length,1);assert.equal(review.decisions[0].action,'review');
    assert.ok(review.decisions[0].saved_occurrences.some(r=>r.amount_minor===40000));
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);assert.ok(answer.confidence.percent<=69);
    assert.match(answer.confidence.reasons.join(' '),/400[.]00 outflow on 2026-10-28/);
    const later=await monthlyAnswer(f,'11');assert.equal(later.rows[0].total_minor,50000);assert.ok(later.confidence.percent<=69);
    assert.match(later.confidence.reasons.join(' '),/400[.]00 outflow on 2026-11-02/);
    assert.equal((await monthlyAnswer(f,'09')).confidence.level,'High');
  } finally {f.close();}
});


test('R2 a correction moving accounts and direction lowers both affected account periods only',async()=>{
  const {f,op,mappings}=await provedReplacement({twoAccounts:true});try {
    assert.equal((await monthlyAnswer(f,'10')).confidence.level,'High');
    assert.equal((await monthlyAnswer(f,'10','savings')).confidence.level,'High');
    f.events=[];f.modified=[event('gap','2026-11-02','-410.00',{account_id:'new-savings'})];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(plan.decisions[0].action,'review');
    const previous=await monthlyAnswer(f,'10');assert.equal(previous.rows[0].total_minor,70000);assert.ok(previous.confidence.percent<=69);
    assert.match(previous.confidence.reasons.join(' '),/400[.]00 outflow on 2026-10-28/);
    const incoming=await monthlyAnswer(f,'11','savings');assert.ok(incoming.confidence.percent<=69);
    assert.match(incoming.confidence.reasons.join(' '),/410[.]00 inflow on 2026-11-02/);
    assert.equal((await monthlyAnswer(f,'10','savings')).rows[0].total_minor,9000);
    assert.equal((await monthlyAnswer(f,'10','savings')).confidence.level,'High');
  } finally {f.close();}
});


test('R2 a replacement statement hole keeps the saved figure and caps even the isolated data scorer at 69',async()=>{
  for(const coverageGap of [false,true]) {
    const {f}=await provedReplacement({coverageGap});try {
      const {moneyConfidenceSnapshotSql,scoreMoneyConfidence}=await import('../src/lib/money-confidence.js');
      const accounts=f.rows(moneyConfidenceSnapshotSql(true)).filter(r=>r.snapshot_kind==='confidence_accounts').map(r=>JSON.parse(r.value));
      assert.equal(accounts.length,1);assert.equal(accounts[0].replacement_intervals.length,2);
      const account={tenant_id:'primary',account_slug:'checking'};
      const score=scoreMoneyConfidence({accounts,coverage:[{...account,unreadable_rows:0,possible_duplicate_count:0}],
        amounts:[{...account,currency:'USD',direction:'outflow',kind:'proved',amount_minor:70000}],
        scope:{from:'2026-10-01',to:'2026-10-31',filters:{account_slug:'checking'}},instant:Date.parse(NOW),timeZone:'UTC'});
      assert.equal(f.first("SELECT SUM(amount_minor) n FROM fin_transactions WHERE posted_on BETWEEN '2026-10-01' AND '2026-10-31' AND removed_at IS NULL").n,70000);
      if(coverageGap){assert.ok(score.percent<=69,JSON.stringify(score));assert.match(score.reasons.join(' '),/2026-10-28 through 2026-10-28/);}
      else assert.equal(score.percent,100);
    } finally {f.close();}
  }
});

test('R2 matching money on a different logical account requires correction instead of duplicate approval',async()=>{
  const {f,op,mappings}=await provedReplacement({twoAccounts:true});try {
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    f.events=[];f.modified=[event('gap','2026-10-28','400.00',{account_id:'new-savings'})];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const review=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(review.decisions[0].action,'review');
    const before=rowMultiset(f);
    const refused=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings,choices:[{event_index:0,action:'duplicate',old_row_id:old,evidence:'Equal date and amount alone do not prove this account.'}]});
    assert.equal(refused.status,409);assert.equal((await refused.json()).code,'replacement_duplicate_not_proved');
    assert.deepEqual(rowMultiset(f),before);
    const choices=[{event_index:0,action:'replace',old_row_id:old,evidence:'Exact statement confirms the changed account assignment.'}];
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});assert.equal(plan.ready,true);
    await jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:plan.plan_hash,expires_at:plan.expires_at});
    assert.equal((await monthlyAnswer(f,'10')).rows[0].total_minor,30000);
    assert.equal((await monthlyAnswer(f,'10','savings')).rows[0].total_minor,49000);
  } finally {f.close();}
});

test('R2 rolled-back page exposes retained-debt review and a separate resume confirmation',async()=>{
  const {replacementPage}=await import('../src/lib/bank-replacement-page.js');
  const {runInNewContext}=await import('node:vm');
  for(const debt of [false,true]) {
    const elements=new Map(),calls=[];
    const element=tag=>({tag,children:[],textContent:'',append(...children){this.children.push(...children);},replaceChildren(){this.children=[];}});
    for(const id of ['content','message','resume','cancel'])elements.set(id,element(id));
    let state={state:'rolled_back',staged_events:debt?1:0,published_revision:1,can_resume_review:debt,detail:'Saved facts and retained activity are kept.'};
    const html=await (replacementPage()).text(),script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    const sandbox={URLSearchParams,location:{search:'?operation_ref=fixture-operation'},sessionStorage:{getItem:()=>null,setItem:()=>{}},
      document:{getElementById:id=>elements.get(id),createElement:element,querySelectorAll:()=>[],createTextNode:text=>({textContent:text})},
      fetch:async(url,options)=>{
        assert.ok(url.startsWith('/api/bank-feed/replacement/'),'only the injected local owner route is reached');
        const body=options?.body?JSON.parse(options.body):null;calls.push({url,body});
        if(url.includes('/status?'))return Response.json(state);
        if(url.endsWith('/review'))return Response.json({accounts:[],incoming_accounts:[],decisions:[],ready:false});
        assert.ok(url.endsWith('/resume'));assert.equal(debt,true);
        if(body.approve){assert.equal(body.approve,'fixture-plan');state={...state,state:'history_review',can_resume_review:false};return Response.json(state);}
        return Response.json({plan_hash:'fixture-plan',detail:'Keep the old connection selected until a separate handover.'});
      }};
    await runInNewContext(script,sandbox);
    const buttons=()=>elements.get('content').children.filter(e=>e.tag==='button');
    const preview=buttons().find(e=>e.textContent==='Review resuming this recovery');
    assert.equal(!!preview,debt);assert.ok(calls.some(c=>c.url.includes('/status?')));
    assert.equal(buttons().some(e=>e.textContent==='Confirm handover and keep history'),false);
    if(debt){
      assert.ok(calls.some(c=>c.url.endsWith('/review')));await preview.onclick();
      assert.equal(calls.filter(c=>c.url.endsWith('/resume')).length,1);
      const confirm=buttons().find(e=>e.textContent==='Confirm resume for review, keep old connection selected');assert.ok(confirm);
      await confirm.onclick();assert.equal(calls.filter(c=>c.url.endsWith('/resume')).length,2);
      assert.equal(calls.some(c=>c.url.endsWith('/activate')),false);
    } else assert.equal(calls.some(c=>c.url.endsWith('/review')),false);
  }
});

test('R3 B01 moved occurrence follows its current head on the next ID-only withdrawal',async()=>{
  const {f,op,mappings}=await provedReplacement({twoAccounts:true});try {
    assert.equal((await monthlyAnswer(f,'10','savings')).confidence.level,'High');
    const original=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    f.events=[];f.modified=[event('gap','2026-10-28','400.00',{account_id:'new-savings'})];
    await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    const choices=[{event_index:0,action:'replace',old_row_id:original,evidence:'Statement confirms the move to the savings account.'}];
    let plan=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});assert.equal(plan.ready,true);
    await jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:plan.plan_hash,expires_at:plan.expires_at});
    const head=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    assert.notEqual(head,original);assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',original).removed_at);
    const moved=await monthlyAnswer(f,'10','savings');assert.equal(moved.rows[0].total_minor,49000);assert.equal(moved.confidence.level,'High');
    f.modified=[];f.removed=[{transaction_id:'gap'}];
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    plan=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(plan.decisions[0].action,'review');
    const answer=await monthlyAnswer(f,'10','savings');assert.equal(answer.rows[0].total_minor,49000);
    assert.ok(answer.confidence.percent<=69,JSON.stringify(answer.confidence));
    assert.match(answer.confidence.reasons.join(' '),/400[.]00 outflow on 2026-10-28/);
    assert.equal((await monthlyAnswer(f,'09')).confidence.level,'High','nonempty unrelated period remains supported');
    assert.equal((await monthlyAnswer(f,'10')).rows[0].total_minor,30000);
    assert.ok((await monthlyAnswer(f,'10')).confidence.percent<=69,'the unresolved lineage also retains its former account footprint');
    await independentAccount(f);
    f.raw("UPDATE fin_accounts SET mask='9012' WHERE account_slug='separate'");
    f.raw("UPDATE fin_transactions SET amount_minor=9100 WHERE txn_uid='independent-purchase'");
    assert.equal((await monthlyAnswer(f,'10','separate')).rows[0].total_minor,9100);
    const separate=await monthlyAnswer(f,'10','separate');assert.equal(separate.confidence.level,'High',JSON.stringify(separate.confidence));
    const alias=f.first("SELECT * FROM plaid_replacement_aliases WHERE provider_id='gap'");
    assert.equal(alias.canonical_row_id,head);assert.equal(alias.account_slug,'savings');
    const remove=[{event_index:0,action:'remove',old_row_id:head,evidence:'Statement confirms withdrawal of this moved occurrence.'}];
    plan=await jsonRoute(f,'review',{operation_ref:op,mappings,choices:remove});assert.equal(plan.ready,true);
    await jsonRoute(f,'activate',{operation_ref:op,mappings,choices:remove,approve:plan.plan_hash,expires_at:plan.expires_at});
    assert.equal((await monthlyAnswer(f,'10','savings')).rows[0].total_minor,9000);
    assert.equal((await monthlyAnswer(f,'10','savings')).confidence.level,'High');
    assert.equal(f.first('SELECT head_row_id FROM plaid_occurrence_heads WHERE tenant_id=? AND origin_row_id=?','primary',original).head_row_id,head);
  } finally {f.close();}
});

test('R3 B04 held tombstone redelivery appends withdrawal evidence and permits the next distinct provider page',async()=>{
  const {f,op}=await provedReplacement();try {
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    f.events=[];f.removed=[{transaction_id:'gap'}];await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    await activate(f,op,[{event_index:0,action:'remove',old_row_id:id,evidence:'Exact statement confirms the original withdrawal.'}]);
    const before=rowMultiset(f),total=sum(f);
    f.removed=[];f.events=[event('gap','2026-11-14','400.00')];
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.state,'active');assert.equal(held.ok,true);assert.equal(held.replacement.published_revision,held.replacement.revision);assert.equal(held.replacement.staged_events,0);assert.equal(held.replacement.open_review_count,1);assert.equal(held.ok,true);
    const plan=await reviewed(f,op);assert.equal(plan.decisions[0].action,'review');assert.ok(plan.decisions[0].saved_occurrences.some(t=>t.id===id && t.withdrawn));
    const unrelated=f.first("SELECT id FROM fin_transactions WHERE external_id='november'").id;
    const wrong=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings:mapping,choices:[{event_index:0,action:'remove',old_row_id:unrelated,evidence:'An unrelated occurrence cannot settle this withdrawal.'}]});
    assert.equal(wrong.status,409);assert.equal((await wrong.json()).code,'replacement_correction_not_proved');
    const choices=[{event_index:0,action:'remove',old_row_id:id,evidence:'Statement proves this redelivery remains withdrawn.'}];
    const ready=await reviewed(f,op,choices);assert.equal(ready.ready,true);
    await activate(f,op,choices);assert.deepEqual(rowMultiset(f),before);assert.equal(sum(f),total);
    assert.equal(f.first("SELECT COUNT(*) n FROM plaid_occurrence_events WHERE event_type='withdrawal' AND origin_row_id=?",id).n,2);
    const revision=f.first('SELECT published_revision FROM plaid_item_replacements').published_revision;
    const calls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
    f.events=[event('distinct-next-page','2026-11-14','81.00')];
    const next=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(next.replacement.state,'active');
    assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1);
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements').published_revision,revision+1);
    assert.equal(sum(f),total+8100);assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',id).removed_at);
  } finally {f.close();}
});

test('R3 seeded provider-state property preserves one occurrence through random moves, posting, withdrawals, redelivery and connection replacement',async()=>{
  const actions=['add','move-account','pending->posted','withdraw','redeliver','replace-connection'];
  const counts=Object.fromEntries(actions.map(a=>[a,0])),states=new Set(),reviewCounts={posting:0,paired:0,moved:0,sameId:0,later:0};
  const polls={quiet:0,empty:0,partial:0,retry:0,missing:0,open:0},pollStates=new Set();
  for(const seed of [0x1114,0x2468,0x5317,0x7801]) {
    let random=seed,serial=0,connection=0;
    const pick=values=>{random^=random<<13;random^=random>>>17;random^=random<<5;return values[(random>>>0)%values.length];};
    const {f,op:initial,mappings:initialMappings}=await provedReplacement({twoAccounts:true});
    let op=initial,mappings=initialMappings,item='new';
    // Independent provider truth, never derived from the product's total or
    // lineage decisions. Only generated row IDs are read for owner selection.
    const truth=new Map([
      ['older',{account:'checking',date:'2024-10-01',amount:10000}],
      ['prior',{account:'checking',date:'2026-09-15',amount:20000}],
      ['overlap',{account:'checking',date:'2026-10-27',amount:30000}],
      ['gap',{account:'checking',date:'2026-10-28',amount:40000}],
      ['november',{account:'checking',date:'2026-11-01',amount:50000}],
      ['separate-purchase',{account:'savings',date:'2026-10-20',amount:9000}],
    ].map(([id,t])=>[id,{...t,id,aliases:[id],direction:'outflow',pending:false,removed:false,
      row:f.first('SELECT id FROM fin_transactions WHERE external_id=? AND removed_at IS NULL',id).id}]));
    for(const t of truth.values())t.origin=t.row;
    const providerRow=t=>event(t.id,t.date,(t.direction==='inflow'?'-':'')+(t.amount/100).toFixed(2),{
      account_id:mappings.find(m=>m.account_slug===t.account).provider_id,pending:t.pending});
    let retained=f.first('SELECT COUNT(*) n FROM fin_transactions').n;
    const verify=()=>{
      const expected=[];
      for(const account of ['checking','savings'])for(const direction of ['inflow','outflow']) {
        const n=[...truth.values()].filter(t=>t.account===account && t.direction===direction && !t.pending && !t.removed).reduce((s,t)=>s+t.amount,0);
        expected.push([account,direction,n]);
      }
      for(const [account,direction,n] of expected)assert.equal(f.first(`SELECT COALESCE(SUM(amount_minor),0) n FROM fin_transactions
        WHERE account_slug=? AND direction=? AND pending=0 AND removed_at IS NULL AND superseded_by_id IS NULL`,account,direction).n,n,`seed ${seed}, account ${account}, direction ${direction}`);
      const all=f.first('SELECT COUNT(*) n FROM fin_transactions').n;assert.ok(all>=retained);retained=all;
      for(const t of truth.values()) {
        const heads=f.rows('SELECT head_row_id FROM plaid_occurrence_heads WHERE tenant_id=? AND origin_row_id=?','primary',t.origin);
        assert.deepEqual(heads.map(h=>h.head_row_id),[t.row],`one head for seed ${seed}`);
        const head=f.first('SELECT removed_at,pending,account_slug FROM fin_transactions WHERE id=?',t.row);
        assert.equal(!!head.removed_at,t.removed);assert.equal(!!head.pending,t.pending);assert.equal(head.account_slug,t.account);
      }
      assert.ok(expected.some(r=>r[2]>0),'nonempty green money control');
    };
    const publish=async(rows,choices,modified=[],removed=[])=>{
      f.events=rows;f.modified=modified;f.removed=removed;
      const staged=await jsonRoute(f,'stage',{operation_ref:op});states.add(staged.state);
      assert.equal(staged.staged_events,rows.length+modified.length+removed.length);
      const p=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});assert.equal(p.ready,true);
      const done=await jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:p.plan_hash,expires_at:p.expires_at});states.add(done.state);
      assert.equal(done.published_revision,staged.revision);
    };
    const add=async(pending=false)=>{
      const id=`occurrence-${seed}-${++serial}`,t={id,aliases:[id],account:pick(['checking','savings']),date:'2026-11-14',amount:2500,
        direction:pick(['inflow','outflow']),pending,removed:false};
      await publish([providerRow(t)],[{event_index:0,action:'admit',evidence:'Statement proves a separate new occurrence, even with equal amounts.'}]);
      t.row=f.first('SELECT id FROM fin_transactions WHERE txn_uid=?',`replacement:${op}:${id}:${f.first('SELECT revision FROM plaid_item_replacements WHERE operation_ref=?',op).revision}`).id;
      t.origin=t.row;truth.set(id,t);counts.add++;
    };
    const withdraw=async(t)=>{
      await publish([],[{event_index:0,action:'remove',old_row_id:t.row,evidence:'Statement confirms withdrawal of this exact occurrence.'}],[],[{transaction_id:pick(t.aliases.filter(id=>!(t.retiredPending || []).includes(id)))}]);
      t.removed=true;counts.withdraw++;
    };
    const quiet=async(openAccount=null)=>{
      const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
      const before=rowMultiset(f),revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision;
      const cursor=f.first('SELECT cursor FROM bank_feed_items WHERE item_ref=?',item).cursor;
      f.events=[];f.modified=[];f.removed=[];f.syncPage={next_cursor:cursor,has_more:false};
      const calls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
      const done=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});
      assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1);
      assert.equal(f.providerCalls.at(-1).cursor,cursor);
      assert.equal(done.ok,true);assert.equal(done.cursor_advanced,false);
      assert.equal(done.replacement.published_revision,revision+1);
      assert.equal(done.replacement.sync_completion.state,'complete');pollStates.add(done.replacement.sync_completion.state);
      assert.equal(done.replacement.sync_completion.accounts.length,2);
      assert.ok(done.replacement.sync_completion.accounts.every(a=>a.state!=='unpolled'));
      if(openAccount){assert.equal(done.replacement.sync_completion.accounts.find(a=>a.account_slug===openAccount).state,'open_item');polls.open++;}
      assert.deepEqual(rowMultiset(f),before);f.syncPage={};polls.quiet++;verify();
    };
    try {
      verify();
      // Poll shape is independent of transaction generation. In particular the
      // provider can have nothing to say while both accounts were really read.
      await quiet();
      const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
      f.syncPage={next_cursor:`empty-${seed}`,has_more:false};
      let done=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});
      assert.equal(done.ok,true);assert.equal(done.cursor_advanced,true);polls.empty++;verify();
      const revision=done.replacement.published_revision;
      f.syncPage={next_cursor:`partial-${seed}`,has_more:true};
      const partial=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});
      assert.equal(partial.ok,false);assert.equal(partial.partial,true);
      assert.equal(partial.replacement.published_revision,revision);
      assert.equal(partial.replacement.sync_completion.state,'polling');pollStates.add('polling');polls.partial++;
      assert.ok(partial.replacement.sync_completion.accounts.every(a=>a.state==='unpolled'),'partial pages cannot certify an account');
      f.failFetch=true;let calls=f.providerCalls.length;
      assert.equal((await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW})).ok,false);
      assert.ok(f.providerCalls.length>calls && f.providerCalls.at(-1).path==='/transactions/sync','retry reaches provider');
      assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision);polls.retry++;
      f.failFetch=false;f.syncPage.has_more=false;
      done=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});
      assert.equal(done.ok,true);assert.equal(done.replacement.published_revision,revision+1);verify();
      const missing=f.inventory.pop();calls=f.providerCalls.length;
      assert.equal((await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW})).ok,false);
      assert.ok(f.providerCalls.slice(calls).some(c=>c.path==='/accounts/get'),'unpolled-account refusal is reached');
      assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision+1);
      polls.missing++;f.inventory.push(missing);f.syncPage={};await quiet();
      for(let round=0;round<4;round++) {
        const order=[...actions];for(let i=order.length-1;i>0;i--){const j=pick(Array.from({length:i+1},(_,k)=>k));[order[i],order[j]]=[order[j],order[i]];}
        for(const action of order) {
          if(action==='add')await add(pick([true,false]));
          if(action==='move-account') {
            const t=pick([...truth.values()].filter(t=>!t.removed)),next={...t,account:t.account==='checking'?'savings':'checking'};
            await publish([],[{event_index:0,action:'replace',old_row_id:t.row,evidence:'Statement proves this occurrence moved accounts.'}],[providerRow(next)]);
            t.account=next.account;t.row=f.first('SELECT MAX(id) id FROM fin_transactions').id;counts[action]++;
          }
          if(action==='pending->posted') {
            if(![...truth.values()].some(t=>t.pending && !t.removed))await add(true);
            const t=pick([...truth.values()].filter(t=>t.pending && !t.removed)),id=round===3 ? t.id : `posted-${seed}-${++serial}`;
            const account=round%2 ? (t.account==='checking'?'savings':'checking') : t.account;
            const row=providerRow({...t,id,account,pending:false});row.pending_transaction_id=t.id;
            f.events=[row];f.modified=[];f.removed=round%2 ? [] : [{transaction_id:t.id}];
            const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
            const syncCalls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
            const synced=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});
            assert.equal(synced.ok,true,'every review-needed posting still completes sync');
            assert.equal(synced.replacement.published_revision,synced.replacement.revision);
            assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,syncCalls+1);
            assert.equal(synced.replacement.open_review_count,round%2 ? 1 : 2);
            assert.ok(synced.replacement.open_review_items.every(d=>d.amount_minor===t.amount));
            verify(); // Before statement confirmation, only independently proved money is counted.
            const held=await queryCurrentPeriod(f,t.account,t.date);
            assert.ok(held.confidence.percent<=69);assert.ok(held.confidence.missing.length);
            assert.match(held.confidence.reasons.join(' '),/25[.]00/);
            await quiet(t.account);
            const laterId=`later-${seed}-${++serial}`,later={id:laterId,aliases:[laterId],account:'checking',date:'2026-11-14',amount:8100+serial,
              direction:'outflow',pending:false,removed:false};
            f.events=[providerRow(later)];f.removed=[];
            const continued=await syncPlaidItem(f.env,item,{fetchImpl:f.fetchImpl,now:NOW});assert.equal(continued.ok,true);
            later.row=f.first('SELECT id FROM fin_transactions WHERE external_id=? AND removed_at IS NULL',laterId)?.id;
            assert.ok(later.row,'unrelated later transaction actually lands despite older review items');
            later.origin=later.row;truth.set(laterId,later);
            assert.equal(continued.replacement.open_review_count,round%2 ? 1 : 2);verify();
            const plan=await jsonRoute(f,'review',{operation_ref:op,mappings});
            const choices=plan.decisions.map(d=>({event_revision:d.event_revision,event_index:d.event_index,
              action:d.provider_id===t.id && id!==t.id?'remove':'replace',old_row_id:t.row,evidence:'Provider and statement link the pending occurrence to this posted ID.'}));
            await r4Publish(f,op,mappings,choices);
            t.retiredPending=[...(t.retiredPending || []),...t.aliases.filter(alias=>alias!==id)];if(id===t.id)reviewCounts.sameId++;t.id=id;t.account=account;t.aliases.push(id);t.pending=false;t.row=f.first('SELECT MAX(id) id FROM fin_transactions').id;counts[action]++;
            reviewCounts.posting++;reviewCounts.later++;if(round%2)reviewCounts.moved++;else reviewCounts.paired++;
          }
          if(action==='withdraw')await withdraw(pick([...truth.values()].filter(t=>!t.removed)));
          if(action==='redeliver') {
            if(![...truth.values()].some(t=>t.removed))await withdraw(pick([...truth.values()].filter(t=>!t.removed)));
            const t=pick([...truth.values()].filter(t=>t.removed)),before=rowMultiset(f);
            const row=providerRow({...t,id:pick(t.aliases),date:'2026-11-14'});
            await publish([row],[{event_index:0,action:'remove',old_row_id:t.row,evidence:'Statement confirms the redelivery remains withdrawn.'}]);
            assert.deepEqual(rowMultiset(f),before);counts[action]++;
          }
          if(action==='replace-connection') {
            // Inject a new unreadable-custody fault in the synthetic database.
            // Owner approval, linking, staging and handover use the real routes.
            f.raw('UPDATE plaid_item_replacements SET publishing=1');
            f.raw("UPDATE bank_feed_items SET status='error',status_detail='Fixture unreadable custody' WHERE item_ref=?",item);
            f.raw('UPDATE plaid_item_replacements SET publishing=0');f.env.BANK_FEED_WRAPPING_KEY_V2=randomKey();
            const parent=op;f.currentItem=`successor-${seed}-${++connection}`;
            for(const a of f.inventory)a.account_id=`account-${connection}-${a.subtype}`;
            mappings=f.inventory.map(a=>({account_slug:a.subtype,provider_id:a.account_id,confirm:true}));
            op=await start(f,item);item=f.currentItem;
            const rows=[...truth.values()].map(providerRow),choices=[...truth.values()].map((t,i)=>({event_index:i,action:t.removed?'remove':'duplicate',old_row_id:t.row,evidence:'Statement identifies this same saved occurrence across bank connections.'}));
            await publish(rows,choices);
            const calls=f.providerCalls.length;
            const denied=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:parent});assert.equal(denied.status,409);
            assert.equal((await denied.json()).code,'replacement_successor_owns_connection');assert.equal(f.providerCalls.length,calls);
            counts[action]++;
          }
          verify();
        }
      }
    } finally {f.close();}
  }
  assert.ok(actions.every(a=>counts[a]>=16),JSON.stringify(counts));
  assert.deepEqual([...states].sort(),['active','history_review'],'uniform outcomes would mean the harness missed review or publication');
  assert.deepEqual(reviewCounts,{posting:16,paired:8,moved:8,sameId:4,later:16});
  assert.deepEqual(polls,{quiet:24,empty:4,partial:4,retry:4,missing:4,open:16});
  assert.deepEqual([...pollStates].sort(),['complete','polling'],'uniform completion results would mean the poll harness failed');
  console.log('Provider-state property action counts: '+JSON.stringify({actions:counts,review:reviewCounts,polls}));
});

test('R3 a known withdrawn identity cannot be relabeled as an unrelated equal-money duplicate',async()=>{
  const {f,op}=await provedReplacement();try {
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const id=f.first("SELECT id FROM fin_transactions WHERE external_id='gap'").id;
    f.events=[];f.removed=[{transaction_id:'gap'}];await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    await activate(f,op,[{event_index:0,action:'remove',old_row_id:id,evidence:'Statement confirms this exact withdrawal.'}]);
    f.removed=[];f.events=[event('gap','2026-11-14','500.00')];
    // Use the same economic fields as a distinct live occurrence. Identity,
    // rather than matching money, must decide which lineage can be settled.
    f.events[0].date='2026-11-01';
    await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    const p=await reviewed(f,op);assert.equal(p.unresolved,1);assert.equal(p.decisions[0].action,'review');
    const other=f.first("SELECT id FROM fin_transactions WHERE external_id='november'").id;
    const bad=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings:mapping,choices:[{event_index:0,action:'duplicate',old_row_id:other,evidence:'Equal money alone cannot change known withdrawn identity.'}]});
    assert.equal(bad.status,409);assert.equal((await bad.json()).code,'replacement_duplicate_not_proved');
    await activate(f,op,[{event_index:0,action:'remove',old_row_id:id,evidence:'Statement confirms this redelivery remains withdrawn.'}]);
    assert.equal(sum(f),110000);assert.equal(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',other).removed_at,null);
    // A later modified provider record can be explicitly confirmed as a
    // reinstatement. Automatic admission and added redelivery cannot do it.
    f.events=[];f.modified=[event('gap','2026-11-02','410.00')];
    const held=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(held.replacement.state,'active');assert.equal(held.ok,true);assert.equal(held.replacement.published_revision,held.replacement.revision);
    const before=f.first('SELECT COUNT(*) n FROM fin_transactions').n;
    await activate(f,op,[{event_index:0,action:'replace',old_row_id:id,evidence:'Newer modified provider record and statement prove reinstatement.'}]);
    assert.equal(sum(f),151000);assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n,before+1);
    assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',id).removed_at);
  } finally {f.close();}
});

test('R3 schema 67 reconstructs a populated schema-66 moved lineage without rewriting retained evidence',async()=>{
  const {f,op,mappings}=await provedReplacement({twoAccounts:true}),target=await createProductFixture({migrationThrough:66});
  try {
    const origin=f.first("SELECT id FROM fin_transactions WHERE external_id='gap'").id;
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    f.events=[];f.modified=[event('gap','2026-10-28','400.00',{account_id:'new-savings'})];
    await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    const choices=[{event_index:0,action:'replace',old_row_id:origin,evidence:'Statement confirms the historical account correction.'}];
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});
    await jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:p.plan_hash,expires_at:p.expires_at});
    const head=f.first("SELECT id FROM fin_transactions WHERE external_id='gap' AND removed_at IS NULL").id;
    // Reproduce the old mutable pointer left by schema-66 publication. The
    // migration must derive the successor from the journal rather than repair
    // this pointer or change any source evidence to manufacture a pass.
    f.raw("UPDATE plaid_replacement_aliases SET canonical_row_id=?,account_slug='checking' WHERE provider_id='gap'",origin);
    const {recoveryExportTables}=await import('../../operations/cloudflare-recovery-adapter.mjs');
    const wanted=['fin_entities','fin_accounts','fin_transactions','fin_account_coverage','fin_balance_snapshots','fin_obligations','bank_feed_items','bank_feed_health','plaid_account_entity_assignments','plaid_link_operations'];
    const tables=recoveryExportTables([{version:66}]).filter(t=>wanted.includes(t) || t.startsWith('plaid_replacement_') || t==='plaid_item_replacements' || t==='bank_account_coverage_intervals');
    for(const table of tables)for(const row of f.rows('SELECT * FROM '+table)) {
      if(table==='plaid_replacement_decisions')assert.equal(row.pending_observation_row_id,null,'historical fixture predates observation retirements');
      const fields=Object.keys(row).filter(k=>k!=='pending_observation_row_id');target.raw('INSERT INTO '+table+' ('+fields.join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')',...fields.map(k=>row[k]));
    }
    const before=JSON.stringify(tables.map(t=>target.rows('SELECT * FROM '+t)));
    assert.equal(target.first("SELECT COUNT(*) n FROM sqlite_schema WHERE name='plaid_occurrence_heads'").n,0);
    const {readFileSync}=await import('node:fs');
    const migration=readFileSync(new URL('../../migrations/d1/0067_plaid_occurrence_lineage.sql',import.meta.url),'utf8');
    for(let retry=0;retry<2;retry++)for(const sql of target.splitStatements(migration))target.sqlite.exec(sql);
    assert.equal(JSON.stringify(tables.map(t=>target.rows('SELECT * FROM '+t))),before);
    assert.equal(target.first('SELECT head_row_id FROM plaid_occurrence_heads WHERE tenant_id=? AND origin_row_id=?','primary',origin).head_row_id,head);
    assert.ok(target.first("SELECT COUNT(*) n FROM plaid_occurrence_identities WHERE provider_id='gap'").n>0);
    for(const table of ['plaid_replacement_events','plaid_replacement_decisions']) {
      assert.ok(target.first('SELECT COUNT(*) n FROM '+table).n>0);
      assert.throws(()=>target.raw('DELETE FROM '+table),/append only/);
      assert.throws(()=>target.raw('UPDATE '+table+' SET revision=revision'),/append only/);
    }
    // The real reader must also ignore a stale compatibility alias after the
    // upgrade and expose the moved head's known dollars in a later withdrawal.
    f.modified=[];f.removed=[{transaction_id:'gap'}];await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    const answer=await monthlyAnswer(f,'10','savings');assert.equal(answer.rows[0].total_minor,49000);assert.ok(answer.confidence.percent<=69);
    assert.match(answer.confidence.reasons.join(' '),/400[.]00 outflow on 2026-10-28/);
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.ok(plan.decisions[0].saved_occurrences.some(t=>t.id===head));
  } finally {f.close();target.close();}
});

test('R3 a predecessor fetch cannot publish after a successor claims its connection mid-flight',async()=>{
  const {f,op}=await provedReplacement();try {
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    f.events=[event('ordinary-control','2026-11-14','71.00')];
    const control=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(control.replacement.state,'active');
    const before=f.first('SELECT revision,cursor FROM plaid_item_replacements WHERE operation_ref=?',op);
    const retained=f.first('SELECT COUNT(*) n FROM plaid_replacement_events').n,fetch=f.fetchImpl;
    let child=null;
    f.events=[event('late-parent-page','2026-11-14','72.00')];
    f.fetchImpl=async(url,init)=>{
      const response=await fetch(url,init);
      if(new URL(url).pathname==='/transactions/sync') {
        f.raw('UPDATE plaid_item_replacements SET publishing=1');
        f.raw("UPDATE bank_feed_items SET status='error' WHERE item_ref='new'");f.raw('UPDATE plaid_item_replacements SET publishing=0');
        f.env.BANK_FEED_WRAPPING_KEY_V2=randomKey();
        const p=await jsonRoute(f,'preview',{item_ref:'new'});assert.equal(p.eligible,true);
        child=await jsonRoute(f,'approve',{item_ref:'new',approve:p.plan_hash,expires_at:p.expires_at,confirm_unrecoverable:true});
      }
      return response;
    };
    const stale=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op});
    assert.ok(child?.operation_ref,'the successor claim happened inside the injected in-flight provider call');
    assert.equal(stale.status,409);
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events').n,retained);
    assert.deepEqual(f.first('SELECT revision,cursor FROM plaid_item_replacements WHERE operation_ref=?',op),before);
    assert.equal(f.first('SELECT state FROM plaid_item_replacements WHERE operation_ref=?',child.operation_ref).state,'owner_approved');
    assert.equal(sum(f),157100);
  } finally {f.close();}
});

test('R3 replacement after rollback follows the facts published by the earlier replacement branch',async()=>{
  const {f,op}=await provedReplacement();try {
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const original=f.first("SELECT id FROM fin_transactions WHERE external_id='gap'").id;
    f.events=[];f.modified=[event('branch-head','2026-10-28','410.00')];
    await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    await activate(f,op,[{event_index:0,action:'replace',old_row_id:original,evidence:'Statement links this changed ID to the exact saved occurrence.'}]);
    const head=f.first("SELECT id FROM fin_transactions WHERE external_id='branch-head'").id;
    assert.equal(sum(f),151000);
    const rollback=await jsonRoute(f,'rollback',{operation_ref:op});await jsonRoute(f,'rollback',{operation_ref:op,approve:rollback.plan_hash});
    assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:old');
    f.currentItem='successor-branch';const next=await start(f);
    f.modified=[];f.events=[event('branch-head','2026-11-14','420.00')];
    const stagedResponse=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:next});
    assert.ok(f.providerCalls.some(c=>c.path==='/accounts/get'),'the duplicate connection decision was reached');
    const staged=await stagedResponse.json();assert.equal(stagedResponse.status,200,JSON.stringify(staged));assert.equal(staged.staged_events,1);
    const plan=await reviewed(f,next);assert.equal(plan.decisions.length,1);assert.equal(plan.decisions[0].action,'review');
    assert.equal(plan.ready,false);assert.equal(sum(f),151000);
    assert.ok(plan.decisions[0].saved_occurrences.some(t=>t.id===head));
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,71000);assert.ok(answer.confidence.percent<=69);
    assert.match(answer.confidence.reasons.join(' '),/410[.]00 outflow on 2026-10-28/);
    await activate(f,next,[{event_index:0,action:'replace',old_row_id:head,evidence:'Statement confirms the correction to the retained branch head.'}]);
    assert.equal(sum(f),152000);assert.equal(f.first('SELECT head_row_id FROM plaid_occurrence_heads WHERE tenant_id=? AND origin_row_id=?','primary',original).head_row_id,f.first("SELECT id FROM fin_transactions WHERE external_id='branch-head' AND removed_at IS NULL").id);
  } finally {f.close();}
});

async function r4Pending() {
  const state=await provedReplacement({twoAccounts:true}),{f,op,mappings}=state;
  f.events=[event('pending-review','2026-10-29','25.00',{pending:true})];
  await jsonRoute(f,'stage',{operation_ref:op});
  const choices=[{event_index:0,action:'admit',evidence:'Statement proves a distinct pending observation.'}];
  const p=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});assert.equal(p.ready,true);
  await jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:p.plan_hash,expires_at:p.expires_at});
  return {...state,pending:f.first("SELECT id FROM fin_transactions WHERE external_id='pending-review'").id};
}
async function r4Publish(f,op,mappings,choices) {
  const p=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});
  assert.equal(p.decisions.filter(d=>d.action!=='review').length,choices.length,'nonempty owner decisions reached');
  assert.equal(p.ready,true,JSON.stringify(p.decisions));
  return jsonRoute(f,'activate',{operation_ref:op,mappings,choices,approve:p.plan_hash,expires_at:p.expires_at});
}
for(const split of [false,true])test(`R4 B05 paired pending retirement completes with both observations, split pages=${split}`,async()=>{
  const {f,op,mappings,pending}=await r4Pending();try {
    assert.equal(sum(f),159000,'nonempty unrelated posted-money control');
    const posted=event('posted-review','2026-10-30','25.00',{pending_transaction_id:'pending-review'});
    f.events=[posted];f.removed=split?[]:[{transaction_id:'pending-review'}];
    if(split){
      const injected=f.fetchImpl;let first=true;
      f.fetchImpl=async(url,init)=>{const response=await injected(url,init);if(new URL(url).pathname==='/transactions/sync' && first){first=false;return Response.json({...await response.json(),has_more:true});}return response;};
    }
    await jsonRoute(f,'stage',{operation_ref:op});
    if(split){f.events=[];f.removed=[{transaction_id:'pending-review'}];await jsonRoute(f,'stage',{operation_ref:op});}
    const retained=f.rows('SELECT provider_id,event_index FROM plaid_replacement_events WHERE operation_ref=? AND revision=3 ORDER BY event_index',op);
    assert.deepEqual(retained.map(e=>e.provider_id),['posted-review','pending-review'],'both distinct provider observations retained');
    const choices=retained.map((e,i)=>({event_index:e.event_index,action:i?'remove':'replace',old_row_id:pending,evidence:'Statement confirms the pending observation became this posted occurrence.'}));
    const done=await r4Publish(f,op,mappings,choices);assert.equal(done.state,'active');assert.equal(done.published_revision,3);
    assert.equal(sum(f),161500);assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',pending).removed_at);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='posted-review' AND pending=0 AND removed_at IS NULL").n,1);
    assert.equal(f.first("SELECT COUNT(*) n FROM plaid_occurrence_events WHERE operation_ref=? AND revision=3 AND event_type='pending_retired'",op).n,1);
    const calls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
    f.events=[event('after-posting','2026-11-14','81.00')];f.removed=[];
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const next=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    assert.equal(next.ok,true);assert.equal(next.replacement.published_revision,4);assert.equal(sum(f),169600);
    assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1);
  }finally{f.close();}
});
test('R4 B06 combined posting/account change offers the known pending head and rejects a wrong head',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    f.events=[event('posted-moved','2026-10-30','25.00',{pending_transaction_id:'pending-review',account_id:'new-savings'})];
    await jsonRoute(f,'stage',{operation_ref:op});
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(p.decisions.length,1);
    assert.ok(f.rows("SELECT head_row_id FROM plaid_occurrence_heads WHERE origin_row_id=?",pending).length,'known pending lineage reached');
    assert.ok(p.decisions[0].saved_occurrences.some(t=>t.id===pending),'pending head offered across mapped accounts');
    const wrong=f.first("SELECT id FROM fin_transactions WHERE external_id='separate-purchase'").id;
    const denied=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings,choices:[{event_index:0,action:'replace',old_row_id:wrong,evidence:'Statement evidence supplied for the wrong occurrence.'}]});
    assert.equal(denied.status,409);assert.equal((await denied.json()).code,'replacement_correction_not_proved');
    await r4Publish(f,op,mappings,[{event_index:0,action:'replace',old_row_id:pending,evidence:'Statement proves this checking pending occurrence posted on savings.'}]);
    assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',pending).removed_at);
    assert.equal((await monthlyAnswer(f,'10','checking')).rows[0].total_minor,70000);
    assert.equal((await monthlyAnswer(f,'10','savings')).rows[0].total_minor,11500);
    f.events=[event('after-move-posting','2026-11-14','81.00')];
    const calls=f.providerCalls.length,{syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const next=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(next.ok,true);
    assert.equal(next.replacement.published_revision,4);assert.ok(f.providerCalls.length>calls);assert.equal(sum(f),169600);
  }finally{f.close();}
});
test('R4 unresolved posting is a visible local review item while sync and later money complete',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    const before=await monthlyAnswer(f,'09');assert.equal(before.confidence.level,'High');assert.equal(before.rows[0].total_minor,20000);
    f.events=[event('posted-unreviewed','2026-10-30','25.00',{pending_transaction_id:'pending-review',account_id:'new-savings'})];
    f.removed=[{transaction_id:'pending-review'}];
    const calls=f.providerCalls.length;
    const done=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});
    assert.ok(f.providerCalls.length>calls,'nonempty provider page fetched');
    assert.equal(done.ok,true,'review debt cannot block sync completion');assert.equal(done.replacement.published_revision,3);
    assert.equal(done.replacement.open_review_count,2);assert.equal(done.replacement.open_review_items.length,2);
    assert.ok(done.replacement.open_review_items.every(d=>d.amount_minor===2500),'both observations name the affected dollars');
    assert.equal(sum(f),159000,'unproved posted money stays out of supported total');
    for(const account of ['checking','savings']){
      const held=await monthlyAnswer(f,'10',account);assert.ok(held.confidence.percent<=69);
      assert.match(held.confidence.reasons.join(' '),/25[.]00/);assert.ok(held.confidence.missing.length);
    }
    assert.equal((await monthlyAnswer(f,'09')).confidence.level,'High');
    f.events=[event('later-unrelated','2026-11-14','81.00')];f.removed=[];
    const next=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(next.ok,true);
    assert.equal(next.replacement.published_revision,4);assert.equal(next.replacement.open_review_count,2);assert.equal(sum(f),167100);
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(p.decisions.length,2);
    assert.ok(p.decisions.every(d=>d.event_revision===3),'review survives beyond its sync revision');
    const choices=p.decisions.map(d=>({event_revision:d.event_revision,event_index:d.event_index,action:d.provider_id==='pending-review'?'remove':'replace',old_row_id:pending,evidence:'Statement reconciles both observations as one posted occurrence.'}));
    const settled=await r4Publish(f,op,mappings,choices);assert.equal(settled.open_review_count,0);
    assert.equal(sum(f),169600);assert.equal((await monthlyAnswer(f,'10','savings')).rows[0].total_minor,11500);
    assert.equal((await monthlyAnswer(f,'10','savings')).confidence.level,'High');
  }finally{f.close();}
});
test('R4 single same-account posting control and unrelated double-consumption rejection',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    f.events=[event('posted-control','2026-10-30','25.00',{pending_transaction_id:'pending-review'})];
    await jsonRoute(f,'stage',{operation_ref:op});
    await r4Publish(f,op,mappings,[{event_index:0,action:'replace',old_row_id:pending,evidence:'Statement proves the same-account pending to posted control.'}]);
    assert.equal(sum(f),161500);
    f.events=[event('unrelated-correction-a','2026-10-30','25.00'),event('unrelated-correction-b','2026-10-30','25.00')];
    await jsonRoute(f,'stage',{operation_ref:op});
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='posted-control'").id;
    const choices=[0,1].map(event_index=>({event_index,action:'replace',old_row_id:old,evidence:'Two unrelated observations claim the same saved occurrence.'}));
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings,choices});assert.equal(p.decisions.length,2);
    assert.equal(p.ready,false);assert.ok(p.decisions.every(d=>d.action==='review'),'neither conflicting claim gains authority from event order');
    assert.equal(sum(f),161500);
  }finally{f.close();}
});

async function queryCurrentPeriod(f,account,date) {
  const {queryMoney}=await import('../src/lib/money-query.js');
  return queryMoney(f.env,{sql:`SELECT SUM(amount_minor) AS total_minor FROM txn WHERE account_slug='${account}' AND posted_on='${date}'`},{now:()=>Date.parse(NOW)});
}

test('R4 a delayed pending removal retires only its observation and keeps the posted head',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    f.events=[event('posted-delayed','2026-10-30','25.00',{pending_transaction_id:'pending-review'})];
    await jsonRoute(f,'stage',{operation_ref:op});
    await r4Publish(f,op,mappings,[{event_index:0,action:'replace',old_row_id:pending,evidence:'Statement proves this pending occurrence posted once.'}]);
    const head=f.first("SELECT id FROM fin_transactions WHERE external_id='posted-delayed'").id;
    f.events=[];f.removed=[{transaction_id:'pending-review'}];
    await jsonRoute(f,'stage',{operation_ref:op});
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(p.decisions.length,1);
    assert.ok(p.decisions[0].saved_occurrences.some(t=>t.id===head));
    await r4Publish(f,op,mappings,[{event_index:0,action:'remove',old_row_id:head,evidence:'Statement confirms the bank removed only its old pending observation.'}]);
    assert.equal(sum(f),161500);assert.equal(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',head).removed_at,null);
    assert.equal(f.first('SELECT head_row_id FROM plaid_occurrence_heads WHERE origin_row_id=?',pending).head_row_id,head);
    assert.equal(f.first("SELECT COUNT(*) n FROM plaid_occurrence_events WHERE operation_ref=? AND event_type='pending_retired'",op).n,1);
  }finally{f.close();}
});
test('R4 schema 68 restart preserves populated journal rows and the exclusive economic-head constraint',async()=>{
  const {f,op}=await r4Pending(),target=await createProductFixture({migrationThrough:67});try{
    const source=f.rows('SELECT * FROM plaid_replacement_decisions');assert.ok(source.length>0);
    for(const row of source){const fields=Object.keys(row).filter(k=>k!=='pending_observation_row_id');target.raw('INSERT INTO plaid_replacement_decisions ('+fields.join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')',...fields.map(k=>row[k]));}
    const {readFileSync}=await import('node:fs');
    const statements=target.splitStatements(readFileSync(new URL('../../migrations/d1/0068_plaid_pending_observation_retirement.sql',import.meta.url),'utf8'));
    const applied=[];
    for(let retry=0;retry<2;retry++)await target.runRestartSafeMigrationStatements(statements,async sql=>{
      if(/^(PRAGMA|SELECT)/i.test(sql))return {results:target.rows(sql)};
      target.sqlite.exec(sql);return {results:[]};
    },{afterStatement:event=>applied.push(event)});
    assert.equal(applied.filter(e=>e.skipped).length,1,'retry proves the already-added column');
    assert.deepEqual(target.rows('SELECT * FROM plaid_replacement_decisions'),source);
    const row=source.find(d=>d.old_row_id!==null);assert.ok(row,'nonempty consumed-head control');
    assert.throws(()=>target.raw('INSERT INTO plaid_replacement_decisions (tenant_id,operation_ref,revision,event_index,action,old_row_id,evidence) VALUES (?,?,?,?,?,?,?)',row.tenant_id,op,row.revision,999,'replace',row.old_row_id,'Unrelated correction claims a consumed head.'),/UNIQUE/);
    assert.throws(()=>target.raw("INSERT INTO plaid_replacement_decisions (tenant_id,operation_ref,revision,event_index,action,old_row_id,evidence,pending_observation_row_id) VALUES ('primary',?,99,0,'replace',NULL,'Invalid no-money correction.',?)",op,1),/CHECK/);
    assert.throws(()=>target.raw('UPDATE plaid_replacement_decisions SET evidence=evidence'),/append only/);
  }finally{f.close();target.close();}
});

test('R4 open revisions sharing an event index require scoped choices and settle once',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    f.events=[event('pending-second','2026-10-29','35.00',{pending:true})];
    await jsonRoute(f,'stage',{operation_ref:op});
    await r4Publish(f,op,mappings,[{event_index:0,action:'admit',evidence:'Statement proves the second distinct pending occurrence.'}]);
    const second=f.first("SELECT id FROM fin_transactions WHERE external_id='pending-second'").id;
    const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
    for(const [id,pendingId,amount] of [['posted-first','pending-review','25.00'],['posted-second','pending-second','35.00']]){
      f.events=[event(id,'2026-10-30',amount,{pending_transaction_id:pendingId})];
      const receipt=await syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now:NOW});assert.equal(receipt.ok,true);
    }
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(p.decisions.length,2);
    assert.deepEqual(p.decisions.map(d=>[d.event_revision,d.event_index]),[[4,0],[5,0]]);
    const denied=await route(f,'/api/bank-feed/replacement/review',{operation_ref:op,mappings,choices:[{event_index:0,action:'replace',old_row_id:pending,evidence:'Unscoped choice cannot select between two retained revisions.'}]});
    assert.equal(denied.status,409);assert.equal((await denied.json()).code,'replacement_row_choice_ambiguous');
    const choices=p.decisions.map(d=>({event_revision:d.event_revision,event_index:d.event_index,action:'replace',old_row_id:d.provider_id==='posted-first'?pending:second,evidence:'Statement proves this exact pending-to-posted occurrence.'}));
    const settled=await r4Publish(f,op,mappings,choices);assert.equal(settled.open_review_count,0);assert.equal(sum(f),165000);
    assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id IN ('posted-first','posted-second') AND removed_at IS NULL").n,2);
  }finally{f.close();}
});
test('R4 active owner page keeps two open revision choices distinct',async()=>{
  const {runInNewContext}=await import('node:vm'),{replacementPage}=await import('../src/lib/bank-replacement-page.js');
  const elements=new Map(),created=[],calls=[];
  const element=tag=>{const e={tag,children:[],textContent:'',value:'',append(...c){this.children.push(...c);},replaceChildren(){this.children=[];}};created.push(e);return e;};
  for(const id of ['content','message','resume','cancel'])elements.set(id,element(id));
  const decisions=[4,5].map((event_revision,i)=>({event_revision,event_index:0,provider_id:'posted-'+i,action:'review',date:'2026-10-30',amount_text:'USD 25.00',evidence:'Compare the pending and posted observations.',saved_occurrences:[{id:i+11,date:'2026-10-29',amount_text:'USD 25.00',pending:true}]}));
  const html=await replacementPage().text(),script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  await runInNewContext(script,{URLSearchParams,location:{search:'?operation_ref=fixture-operation'},sessionStorage:{getItem:()=>null,setItem:()=>{}},
    document:{getElementById:id=>elements.get(id),createElement:element,querySelectorAll:()=>[],createTextNode:text=>({textContent:text})},
    fetch:async(url,options)=>{
      assert.ok(url.startsWith('/api/bank-feed/replacement/'));const body=options?.body?JSON.parse(options.body):null;calls.push({url,body});
      if(url.includes('/status?'))return Response.json({state:'active',published_revision:5,open_review_count:2,detail:'Sync continues; two saved activity items need review.'});
      assert.ok(url.endsWith('/review'));return Response.json({accounts:[],incoming_accounts:[],decisions,ready:false,can_complete:true,unresolved:2});
    }});
  assert.ok(calls.some(c=>c.url.endsWith('/review')),'active status reaches retained activity review');
  const selects=created.filter(e=>e.tag==='select'),inputs=created.filter(e=>e.tag==='input');assert.equal(selects.length,4);assert.equal(inputs.length,2);
  for(let i=0;i<2;i++){
    selects[2*i].value='replace';selects[2*i+1].value=String(i+11);inputs[i].value='Statement confirms this exact saved pending occurrence.';inputs[i].oninput();
  }
  await created.find(e=>e.tag==='button' && e.textContent==='Check these choices').onclick();
  const choices=calls.filter(c=>c.url.endsWith('/review')).at(-1).body.choices;
  assert.deepEqual(choices.map(c=>[c.event_revision,c.event_index,c.old_row_id]),[[4,0,11],[5,0,12]]);
  assert.ok(created.some(e=>e.tag==='button' && e.textContent==='Save reviewed activity and keep 2 items open'));
});

test('R4 a true withdrawal of a same-ID posted occurrence is economic removal',async()=>{
  const {f,op,mappings,pending}=await r4Pending();try{
    f.events=[];f.modified=[event('pending-review','2026-10-30','25.00')];
    await jsonRoute(f,'stage',{operation_ref:op});
    await r4Publish(f,op,mappings,[{event_index:0,action:'replace',old_row_id:pending,evidence:'Statement proves this provider ID changed from pending to posted.'}]);
    const posted=f.first("SELECT id FROM fin_transactions WHERE external_id='pending-review' AND pending=0 AND removed_at IS NULL").id;
    assert.equal(sum(f),161500,'same-ID posted-money green control');
    f.modified=[];f.removed=[{transaction_id:'pending-review'}];await jsonRoute(f,'stage',{operation_ref:op});
    const p=await jsonRoute(f,'review',{operation_ref:op,mappings});assert.equal(p.decisions.length,1);
    assert.ok(p.decisions[0].saved_occurrences.some(t=>t.id===posted),'economic posted head reached');
    await r4Publish(f,op,mappings,[{event_index:0,action:'remove',old_row_id:posted,evidence:'Statement confirms withdrawal of the current posted occurrence.'}]);
    assert.equal(sum(f),159000,'same provider ID denotes posted money, not only its old pending observation');
    assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',posted).removed_at);
    assert.equal(f.first("SELECT COUNT(*) n FROM plaid_occurrence_events WHERE operation_ref=? AND event_type='pending_retired'",op).n,0);
    const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);assert.equal(answer.confidence.level,'High');
  }finally{f.close();}
});

// Each control uses the composed sync path and an anchored observation clock.
const R5_NOW='2026-11-14T12:05:00.000Z';
async function r5Sync(f,now=R5_NOW) {
  const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
  return syncPlaidItem(f.env,'new',{fetchImpl:f.fetchImpl,now});
}
function r5Quiet(f,cursor) {
  f.events=[];f.modified=[];f.removed=[];
  f.syncPage={next_cursor:cursor,has_more:false};
}
for(const held of [false,true])test(`R5 B07 terminal unchanged cursor completes with open review=${held}`,async()=>{
  const {f,op}=held?await r4Pending():await provedReplacement({twoAccounts:true});
  try {
    if(held) {
      f.events=[event('posted-review','2026-10-30','25.00',{pending_transaction_id:'pending-review'})];
      const review=await r5Sync(f,NOW);assert.equal(review.ok,true);assert.equal(review.replacement.open_review_count,1);
    }
    const before=rowMultiset(f),total=sum(f),revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision;
    assert.equal(total,159000,'nonempty independent money control');
    const cursor=f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor;
    const coverage=f.rows('SELECT * FROM bank_account_coverage_intervals ORDER BY account_slug,revision,covered_from');
    r5Quiet(f,cursor);
    for(const [i,at] of [R5_NOW,'2026-11-14T12:06:00.000Z'].entries()) {
      f.inventory[0].balances.current=String(51+i);
      const calls=f.providerCalls.length,result=await r5Sync(f,at);
      assert.deepEqual(f.providerCalls.slice(calls).map(c=>c.path),['/item/get','/accounts/get','/transactions/sync']);
      assert.equal(f.providerCalls.at(-1).cursor,cursor,'real cursor decision reached');
      assert.equal(result.ok,true,'valid quiet poll completes');assert.equal(result.cursor_advanced,false);
      assert.equal(result.replacement.sync_completion.state,'complete');
      assert.equal(result.replacement.sync_completion.observed_at,at);
      assert.equal(result.replacement.published_revision,revision+i+1);
      assert.equal(result.replacement.open_review_count,held?1:0);
      assert.ok(result.replacement.sync_completion.accounts.every(a=>['polled','open_item'].includes(a.state)));
      assert.equal(f.first("SELECT last_synced_at FROM bank_feed_items WHERE item_ref='new'").last_synced_at,at);
      const health=f.first("SELECT last_successful_sync_at,data_through,last_error_code FROM bank_feed_health WHERE item_ref='new'");
      assert.equal(health.last_successful_sync_at,at);assert.equal(health.data_through,'2026-11-13');assert.equal(health.last_error_code,null);
      const balance=f.first("SELECT current_minor,recorded_at FROM fin_balance_snapshots WHERE account_slug='checking' AND as_of_date='2026-11-14'");
      assert.equal(balance.current_minor,(51+i)*100);assert.equal(balance.recorded_at,at);
      assert.deepEqual(rowMultiset(f),before);assert.equal(sum(f),total);
      assert.deepEqual(f.rows('SELECT * FROM bank_account_coverage_intervals ORDER BY account_slug,revision,covered_from'),coverage,'quiet polls invent no coverage');
      const {replacementStatus,activateReplacement}=await import('../src/lib/plaid-item-replacement.js');
      const status=await replacementStatus(f.env,{operationRef:op});
      assert.deepEqual(status.sync_completion,result.replacement.sync_completion,'durable completion readback');
      const audit=f.first('SELECT COUNT(*) n FROM plaid_replacement_audit').n;
      const hash=f.first('SELECT review_hash FROM plaid_item_replacements WHERE operation_ref=?',op).review_hash;
      await activateReplacement(f.env,{operationRef:op,approve:hash,now:at});
      assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_audit').n,audit,'completion replay is idempotent');
      if(held){const answer=await monthlyAnswer(f,'10');assert.equal(answer.rows[0].total_minor,70000);assert.ok(answer.confidence.percent<=69);assert.ok(answer.confidence.missing.length);assert.match(answer.confidence.reasons.join(' '),/25[.]00/);}
    }
    f.events=[event('later-quiet','2026-11-14','81.00')];f.syncPage={};
    const changed=await r5Sync(f,'2026-11-14T12:07:00.000Z');assert.equal(changed.ok,true);assert.equal(changed.cursor_advanced,true);
    assert.equal(sum(f),total+8100);assert.equal(f.first("SELECT COUNT(*) n FROM fin_transactions WHERE external_id='later-quiet'").n,1);
    f.syncPage={next_cursor:f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor};f.events=[];
    assert.equal((await r5Sync(f,'2026-11-14T12:08:00.000Z')).ok,true);assert.equal(sum(f),total+8100);
  }finally{f.close();}
});

for(const shape of ['nonadvancing','cycle'])test(`R5 ${shape} reaches validation without completion; terminal control resumes`,async()=>{
    const {f,op}=await provedReplacement({twoAccounts:true});try {
      const cursor=f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor;
      const revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision;
      const total=sum(f);r5Quiet(f,cursor);
      if(shape==='cycle') {
        f.syncPage={has_more:true,next_cursor:'cycle-middle'};
        const partial=await r5Sync(f);assert.equal(partial.ok,false);assert.equal(partial.partial,true);
        f.syncPage={has_more:false,next_cursor:cursor};
      } else f.syncPage.has_more=true;
      const calls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
      const rejected=await r5Sync(f);
      assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1,'invalid page decision reached');
      assert.equal(rejected.ok,false);assert.equal(rejected.cursor_advanced,false);
      assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision);
      assert.equal(f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor,cursor);assert.equal(sum(f),total);
      f.syncPage={next_cursor:'cycle-control',has_more:false};
      const control=await r5Sync(f);assert.equal(control.ok,true);assert.equal(control.replacement.sync_completion.state,'complete');assert.equal(sum(f),total);
    }finally{f.close();}
});

test('R5 advancing terminal cursor is a nonempty green completion control',async()=>{
  const {f}=await provedReplacement({twoAccounts:true});try {
    r5Quiet(f,'advancing-control');const calls=f.providerCalls.length;
    const result=await r5Sync(f);assert.equal(result.ok,true);assert.equal(result.cursor_advanced,true);
    assert.equal(f.providerCalls.length,calls+3);assert.equal(sum(f),159000);
  }finally{f.close();}
});

test('R5 missing account and interrupted provider poll never complete; empty terminal windows do',async()=>{
  const {f,op}=await provedReplacement({twoAccounts:true});try {
    const revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,total=sum(f);
    const account=f.inventory.pop();r5Quiet(f,'missing-account');
    let calls=f.providerCalls.length;assert.equal((await r5Sync(f)).ok,false);
    assert.ok(f.providerCalls.slice(calls).some(c=>c.path==='/accounts/get'),'missing-account decision reached');
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision);
    f.inventory.push(account);f.failFetch=true;calls=f.providerCalls.length;
    assert.equal((await r5Sync(f)).ok,false);assert.equal(f.providerCalls.at(-1).path,'/transactions/sync');assert.ok(f.providerCalls.length>calls);
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision);
    f.failFetch=false;f.syncPage={next_cursor:'empty-terminal',has_more:false};
    const control=await r5Sync(f);assert.equal(control.ok,true);assert.equal(control.replacement.sync_completion.accounts.length,2);
    assert.ok(control.replacement.sync_completion.accounts.every(a=>a.state==='polled'));assert.equal(sum(f),total);
  }finally{f.close();}
});

test('R5 retained terminal page resumes completion after atomic publish failure without another provider poll',async()=>{
  const {f,op}=await provedReplacement({twoAccounts:true});try {
    const total=sum(f),revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision;
    r5Quiet(f,f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor);
    f.control.failOn=/INSERT INTO plaid_replacement_decisions/;
    const calls=f.providerCalls.filter(c=>c.path==='/transactions/sync').length;
    const failed=await r5Sync(f);assert.equal(failed.ok,false);
    assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1);
    assert.ok(f.seen.sql.some(s=>f.control.failOn.test(s)),'publication failure decision reached');
    assert.equal(f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,revision);
    assert.equal(f.first('SELECT state FROM plaid_item_replacements WHERE operation_ref=?',op).state,'history_review');
    f.control.failOn=null;
    const resumed=await r5Sync(f,'2026-11-14T12:10:00.000Z');assert.equal(resumed.ok,true);assert.equal(resumed.cursor_advanced,false);
    assert.equal(f.providerCalls.filter(c=>c.path==='/transactions/sync').length,calls+1,'retained terminal observation is sufficient');
    assert.equal(resumed.replacement.sync_completion.observed_at,R5_NOW,'retry does not manufacture an observation');
    assert.equal(resumed.replacement.published_revision,revision+1);assert.equal(sum(f),total);
  }finally{f.close();}
});

test('R5 rollback during pagination resumes polling and cannot publish an unpolled account',async()=>{
  const {f,op}=await provedReplacement({twoAccounts:true});try {
    const {rollbackReplacement,resumeReplacement}=await import('../src/lib/plaid-item-replacement.js');
    const revision=f.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision,total=sum(f);
    f.events=[];f.modified=[event('gap','2026-10-28','450.00')];f.syncPage={has_more:true,next_cursor:'rollback-partial'};
    const partial=await r5Sync(f);assert.equal(partial.ok,false);assert.equal(partial.replacement.staged_events,1);
    assert.equal(partial.replacement.sync_completion.state,'polling');assert.ok(partial.replacement.sync_completion.accounts.every(a=>a.state==='unpolled'));
    const rollback=await rollbackReplacement(f.env,{operationRef:op,now:R5_NOW});
    const paused=await rollbackReplacement(f.env,{operationRef:op,approve:rollback.plan_hash,now:R5_NOW});assert.equal(paused.sync_completion.state,'paused');
    const resume=await resumeReplacement(f.env,{operationRef:op,now:R5_NOW});
    const resumed=await resumeReplacement(f.env,{operationRef:op,approve:resume.plan_hash,now:R5_NOW});
    assert.equal(resumed.state,'candidate_staged');assert.equal(resumed.sync_completion.state,'polling');
    assert.equal(resumed.published_revision,revision);assert.equal(sum(f),total);
    f.events=[];f.modified=[];f.syncPage.has_more=false;
    const calls=f.providerCalls.length,control=await r5Sync(f);assert.equal(control.ok,true);
    assert.equal(f.providerCalls.length,calls+3);assert.equal(f.providerCalls.at(-1).cursor,'rollback-partial');
    assert.equal(control.replacement.open_review_count,1);assert.equal(control.replacement.sync_completion.state,'complete');
    assert.equal(control.replacement.published_revision,revision+1);assert.equal(sum(f),total);
  }finally{f.close();}
});

for(const partial of [false,true])test(`R5 legacy retained window re-polls without losing open evidence, partial=${partial}`,async()=>{
  const {f,op}=await provedReplacement({twoAccounts:true}),legacy=await createProductFixture();
  try {
    const cursor=f.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor;
    f.events=[];f.modified=[event('gap','2026-10-28','450.00')];f.syncPage={next_cursor:'legacy-retained',has_more:partial};
    await jsonRoute(f,'stage',{operation_ref:op});
    // Construct an older recovery fixture from durable rows, omitting only the
    // receipt format that did not exist then. Never edit the source database.
    const {recoveryExportTables}=await import('../../operations/cloudflare-recovery-adapter.mjs');
    const tables=new Set(['fin_entities','fin_accounts','fin_transactions','fin_account_coverage','fin_balance_snapshots','fin_obligations',
      'bank_feed_items','bank_feed_health','plaid_account_entity_assignments','plaid_link_operations','plaid_item_replacements',
      'plaid_replacement_bindings','plaid_replacement_events','plaid_replacement_decisions','plaid_replacement_aliases',
      'bank_account_coverage_intervals','plaid_replacement_audit','plaid_replacement_balance_evidence']);
    for(const table of recoveryExportTables([{version:68}]).filter(t=>tables.has(t)))for(const row of f.rows('SELECT * FROM '+table)) {
      if(table==='plaid_replacement_audit' && row.event.startsWith('{"type":"replacement_poll_page_v1",'))continue;
      const keys=Object.keys(row);legacy.raw('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',...keys.map(k=>row[k]));
    }
    const db=legacy.env.DB;Object.assign(legacy.env,f.env,{DB:db});legacy.fetchImpl=f.fetchImpl;
    const before=rowMultiset(legacy),revision=legacy.first('SELECT published_revision FROM plaid_item_replacements WHERE operation_ref=?',op).published_revision;
    assert.ok(legacy.first('SELECT COUNT(*) n FROM plaid_replacement_events WHERE operation_ref=? AND revision>?',op,revision).n>0,'nonempty legacy review reached');
    assert.equal(legacy.first("SELECT COUNT(*) n FROM plaid_replacement_audit WHERE event LIKE '{%'").n,0);
    r5Quiet(f,cursor);if(partial)f.syncPage={next_cursor:'legacy-repoll-middle',has_more:true};
    const calls=f.providerCalls.length;
    let done=await r5Sync(legacy);assert.equal(f.providerCalls.at(-1).cursor,cursor,'restart from the successor published cursor, never skip retained work');
    assert.equal(f.providerCalls.length,calls+3);
    if(partial) {
      assert.equal(done.ok,false);assert.equal(done.replacement.sync_completion.state,'polling');
      assert.ok(done.replacement.sync_completion.accounts.every(a=>a.state==='unpolled'));
      assert.equal(done.replacement.published_revision,revision);
      f.syncPage.has_more=false;done=await r5Sync(legacy);
      assert.equal(f.providerCalls.at(-1).cursor,'legacy-repoll-middle','fresh receipt chain resumes after the retained legacy prefix');
    }
    assert.equal(done.ok,true);
    assert.equal(done.replacement.sync_completion.state,'complete');assert.equal(done.replacement.published_revision,revision+1);
    assert.equal(done.replacement.open_review_count,1);assert.equal(done.cursor_advanced,partial);
    assert.deepEqual(rowMultiset(legacy),before);assert.equal(sum(legacy),159000);
    assert.ok((await monthlyAnswer(legacy,'10')).confidence.percent<=69);
    r5Quiet(f,legacy.first("SELECT cursor FROM bank_feed_items WHERE item_ref='new'").cursor);
    const again=await r5Sync(legacy,'2026-11-14T12:06:00.000Z');assert.equal(again.ok,true);assert.equal(again.replacement.open_review_count,1);
  }finally{f.close();legacy.close();}
});

// 0.4.29 bank R1: a handed-over row must store exactly what ordinary Plaid sync
// would store for the same provider payload, and keep an owner-confirmed
// category on a reviewed replacement the way ordinary sync keeps it on update.
async function ordinarySync(payloads,{balances=null}={}) {
  const f=await fixture();seedOwnedEntity(f,'owned','Fixture business');
  const accounts=[{account_id:'parity-account',name:'Parity checking',mask:'4321',type:'depository',subtype:'checking',balances:{iso_currency_code:'USD',current:'50.00',available:'45.00',...balances}}];
  f.ordinaryCalls=[];
  const fetchImpl=async url=>{const path=new URL(url).pathname;f.ordinaryCalls.push(path);
    if(path==='/accounts/get')return Response.json({accounts});
    if(path==='/transactions/sync')return Response.json({added:payloads.map(p=>({...p,account_id:'parity-account'})),modified:[],removed:[],next_cursor:'parity-cursor',has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE'});
    throw Error('unexpected provider path '+path);};
  const {syncPlaidItem}=await import('../src/lib/plaid-bank-feed.js');
  const first=await syncPlaidItem(f.env,'healthy',{fetchImpl,now:NOW});
  if(first.status!=='assignment_required')return {f,result:first};
  const {assignPlaidAccountEntity}=await import('../src/lib/plaid-account-entities.js');
  for(const [i,a] of f.rows("SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='healthy'").entries())
    await assignPlaidAccountEntity(f.env,{request_id:'parity-assignment-'+i,account_ref:a.account_ref,entity_slug:'owned'},{now:NOW});
  return {f,result:await syncPlaidItem(f.env,'healthy',{fetchImpl,now:NOW})};
}
const textFields=(f,id)=>({...f.first('SELECT description,payee,category,category_basis_state FROM fin_transactions WHERE external_id=? AND removed_at IS NULL',id)});
test('R1 replace keeps an owner-confirmed category, so a replaced owner draw stays out of October spending',async()=>{
  const f=await seeded();try {
    f.env.BANK_FEED_ENV='production';f.env.BRAIN_TIMEZONE='UTC';f.raw("UPDATE bank_feed_items SET environment='production'");
    f.raw("UPDATE fin_accounts SET opened_on='2024-10-01'");f.raw("UPDATE fin_transactions SET category='PURCHASE',category_basis_state='confirmed'");
    f.raw("UPDATE fin_transactions SET category='Owner draw' WHERE external_id='overlap'");
    const {queryMoney}=await import('../src/lib/money-query.js');
    const october=()=>queryMoney(f.env,{sql:"SELECT SUM(expense_minor) AS total_minor FROM txn WHERE account_slug='checking' AND posted_on BETWEEN '2026-10-01' AND '2026-10-31'"},{now:()=>Date.parse(NOW)});
    const before=await october();assert.equal(before.rows[0].total_minor ?? 0,0,'control: the confirmed owner draw is not October spending');
    f.events=[event('overlap','2026-10-26','300.00'),event('gap','2026-10-28','400.00'),event('november','2026-11-01','500.00')];
    const op=await start(f);await jsonRoute(f,'stage',{operation_ref:op});
    const old=f.first("SELECT id FROM fin_transactions WHERE external_id='overlap'").id;
    const choices=[{event_index:0,action:'replace',old_row_id:old,evidence:'Statement shows this owner draw posted on 2026-10-26.'}];
    const intervals=[{account_slug:'checking',from:'2026-10-28',to:'2026-11-13',evidence:'Complete statement interval independently compared.'}];
    const plan=await jsonRoute(f,'review',{operation_ref:op,mappings:mapping,choices,intervals});
    assert.equal(plan.ready,true,JSON.stringify(plan.decisions));assert.equal(plan.decisions[0].action,'replace');
    await jsonRoute(f,'activate',{operation_ref:op,mappings:mapping,choices,intervals,approve:plan.plan_hash,expires_at:plan.expires_at});
    const replaced=f.first("SELECT posted_on,category,category_basis_state,source_feed FROM fin_transactions WHERE external_id='overlap' AND removed_at IS NULL");
    assert.deepEqual({...replaced},{posted_on:'2026-10-26',category:'Owner draw',category_basis_state:'confirmed',source_feed:'bank-feed:new'});
    assert.ok(f.first('SELECT removed_at FROM fin_transactions WHERE id=?',old).removed_at,'the old evidence row is kept, withdrawn');
    const gap=textFields(f,'gap');assert.equal(gap.category,'GENERAL_MERCHANDISE_OFFICE_SUPPLIES');assert.equal(gap.category_basis_state,'proposed','an admitted row keeps the provider proposal');
    const after=await october();
    assert.equal(after.rows[0].total_minor,40000,'only the gap purchase is October spending: '+JSON.stringify(after.confidence));
    assert.ok(after.rows[0].total_minor===40000 || after.confidence.level!=='High','a wrong figure never reaches High');
  } finally {f.close();}
});
test('R1 one provider payload stores identical description, payee and category through replacement and ordinary sync',async()=>{
  const payloads=[
    {transaction_id:'parity-merchant',amount:'12.34',iso_currency_code:'USD',date:'2026-10-28',pending:false,
      name:'POS DEBIT 0042 FIXTURE STORE #42  ',merchant_name:'  Fixture Store ',personal_finance_category:{primary:'GENERAL_MERCHANDISE',detailed:' GENERAL_MERCHANDISE_OTHER '}},
    {transaction_id:'parity-raw',amount:'5.00',iso_currency_code:'USD',date:'2026-10-29',pending:false,
      name:'  ACH DEBIT '+'X'.repeat(600)+' ',merchant_name:null,personal_finance_category:null},
  ];
  const ordinary=await ordinarySync(payloads);
  try {
    assert.equal(ordinary.f.first("SELECT COUNT(*) n FROM fin_transactions WHERE source_feed='bank-feed:healthy'").n,2,JSON.stringify(ordinary.result));
    const {f}=await provedReplacement({events:[event('overlap','2026-10-27','300.00'),...payloads.map(p=>({...p,account_id:'new-account'}))]});
    try {
      for(const p of payloads) {
        const expected=textFields(ordinary.f,p.transaction_id),actual=textFields(f,p.transaction_id);
        assert.ok(expected.description,'ordinary sync control row reached');
        assert.deepEqual(actual,expected,p.transaction_id);
      }
      assert.deepEqual(textFields(f,'parity-merchant'),{description:'Fixture Store',payee:'Fixture Store',category:'GENERAL_MERCHANDISE_OTHER',category_basis_state:'proposed'});
      assert.equal(textFields(f,'parity-raw').description.length,'ACH DEBIT '.length+600,'raw text is trimmed, never cut');
    } finally {f.close();}
  } finally {ordinary.f.close();}
});
for(const [label,bad] of [['non-text merchant name',{merchant_name:42}],['half provider category',{personal_finance_category:{primary:'GENERAL_MERCHANDISE'}}],
  ['non-text name',{name:7,merchant_name:null}]])test(`R1 replacement rejects a ${label} exactly where ordinary sync rejects it`,async()=>{
  const payload={transaction_id:'bad-text',amount:'9.00',iso_currency_code:'USD',date:'2026-10-28',pending:false,name:'Fixture purchase',merchant_name:'Fixture Store',...bad};
  const ordinary=await ordinarySync([payload]);
  try {
    assert.equal(ordinary.result.code,'INVALID_SYNC_PAGE',JSON.stringify(ordinary.result));
    assert.ok(ordinary.f.ordinaryCalls.includes('/transactions/sync'),'ordinary provider page reached');
    assert.equal(ordinary.f.first('SELECT COUNT(*) n FROM fin_transactions').n,0);
  } finally {ordinary.f.close();}
  const f=await seeded();try {
    const before=rowMultiset(f);f.events=[{...payload,account_id:'new-account'}];
    const op=await start(f);
    const denied=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op});
    assert.equal(denied.status,409);assert.equal((await denied.json()).code,'replacement_event_invalid');
    assert.ok(f.providerCalls.some(c=>c.path==='/transactions/sync'),'replacement provider page reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events').n,0);assert.deepEqual(rowMultiset(f),before);
    f.events=[event('bad-text','2026-10-28','9.00')];await jsonRoute(f,'stage',{operation_ref:op});
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events').n,1,'control: the same row with valid text stages');
  } finally {f.close();}
});

// 0.4.29 bank R2: a sub-cent amount or balance follows ordinary sync. Refusing
// it stopped the replaced connection with no way out; ordinary sync rounds it
// half-even, keeps the exact decimal and marks the rounded figure.
const SUBCENT={transaction_id:'subcent',amount:12.345,iso_currency_code:'USD',date:'2026-10-28',pending:false,name:'Fixture purchase',
  merchant_name:'Fixture Supplies',personal_finance_category:{primary:'GENERAL_MERCHANDISE',detailed:'GENERAL_MERCHANDISE_OFFICE_SUPPLIES'}};
const SUBCENT_BALANCES={current:1000.005,available:'45.00'};
async function storedMoney(f,externalId) {
  const {minorRoundedFields}=await import('../src/lib/fin-d1.js');
  const {account_slug,source_locator,...transaction}=f.first(`SELECT account_slug,amount_minor,direction,raw_amount_minor,currency,source_amount_decimal,
    source_locator,provenance,basis_state,source_provider FROM fin_transactions WHERE external_id=? AND removed_at IS NULL`,externalId);
  const {source_locator:balanceLocator,...balance}=f.first(`SELECT current_minor,available_minor,currency,source_locator,provenance,basis_state
    FROM fin_balance_snapshots WHERE account_slug=? ORDER BY as_of_date DESC,id DESC LIMIT 1`,account_slug);
  return {transaction:{...transaction,marker:minorRoundedFields(source_locator)},balance:{...balance,marker:minorRoundedFields(balanceLocator)}};
}
test('R2 a sub-cent amount and balance complete the handover and store what ordinary sync stores',async()=>{
  const ordinary=await ordinarySync([SUBCENT],{balances:SUBCENT_BALANCES});
  try {
    assert.equal(ordinary.f.first("SELECT COUNT(*) n FROM fin_transactions WHERE source_feed='bank-feed:healthy'").n,1,JSON.stringify(ordinary.result));
    const expected=await storedMoney(ordinary.f,'subcent');
    assert.deepEqual(expected,{transaction:{amount_minor:1234,direction:'outflow',raw_amount_minor:1234,currency:'USD',source_amount_decimal:'12.345',
      provenance:'feed',basis_state:'confirmed',source_provider:'plaid',marker:['amount']},
      balance:{current_minor:100000,available_minor:4500,currency:'USD',provenance:'feed',basis_state:'confirmed',marker:['current']}},'ordinary sync control: half-even, exact decimal kept, rounded figures marked');
    const {f,op}=await provedReplacement({balances:SUBCENT_BALANCES,events:[event('overlap','2026-10-27','300.00'),{...SUBCENT,account_id:'new-account'},event('november','2026-11-01','500.00')]});
    try {
      assert.equal(f.first('SELECT state FROM plaid_item_replacements WHERE operation_ref=?',op).state,'active');
      assert.equal(f.first("SELECT source_feed FROM fin_accounts WHERE account_slug='checking'").source_feed,'bank-feed:new');
      assert.deepEqual(await storedMoney(f,'subcent'),expected);
    } finally {f.close();}
  } finally {ordinary.f.close();}
});
for(const [label,bad] of [['transaction amount',{amount:'12.3.4'}],['non-numeric transaction amount',{amount:'twelve'}],['balance',{current:'n/a'}]])test(`R2 a malformed ${label} is still refused where ordinary sync refuses it; the same sub-cent payload then stages`,async()=>{
  const balanceCase=label==='balance',payload={...SUBCENT,...(balanceCase?{}:bad)},balances=balanceCase?bad:{};
  const ordinary=await ordinarySync([payload],{balances});
  try {
    assert.equal(ordinary.result.ok,false,JSON.stringify(ordinary.result));
    assert.ok(ordinary.f.ordinaryCalls.includes(balanceCase?'/accounts/get':'/transactions/sync'),'ordinary provider response reached');
    assert.equal(ordinary.f.first('SELECT COUNT(*) n FROM fin_transactions').n,0);
    assert.equal(ordinary.f.first('SELECT COUNT(*) n FROM fin_balance_snapshots').n,0);
  } finally {ordinary.f.close();}
  const f=await seeded();try {
    const before=rowMultiset(f);f.events=[{...payload,account_id:'new-account'}];Object.assign(f.inventory[0].balances,balances);
    const op=await start(f);
    const denied=await route(f,'/api/bank-feed/replacement/stage',{operation_ref:op});
    assert.equal(denied.status,409);assert.equal((await denied.json()).code,'replacement_review_required');
    assert.ok(f.providerCalls.some(c=>c.path===(balanceCase?'/accounts/get':'/transactions/sync')),'replacement provider response reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM plaid_replacement_events').n,0);assert.deepEqual(rowMultiset(f),before);
    assert.equal(f.first('SELECT inventory_json FROM plaid_item_replacements WHERE operation_ref=?',op).inventory_json,null);
    f.events=[{...SUBCENT,account_id:'new-account'}];Object.assign(f.inventory[0].balances,SUBCENT_BALANCES);
    await jsonRoute(f,'stage',{operation_ref:op});
    const staged=f.rows('SELECT payload_json FROM plaid_replacement_events').map(r=>JSON.parse(r.payload_json));
    assert.equal(staged.length,1,'control: the same payload with a sub-cent amount and balance stages');
    assert.deepEqual([staged[0].amount,staged[0].decimal,staged[0].direction],[1234,'12.345','outflow']);
    assert.equal(JSON.parse(f.first('SELECT inventory_json FROM plaid_item_replacements WHERE operation_ref=?',op).inventory_json)[0].balance_current,100000);
  } finally {f.close();}
});

test('confidence snapshot stays fast with a large ledger while a replacement waits for review',async()=>{
  const f=await createProductFixture({});
  try {
    seedOwnedEntity(f,'owned','Biz');
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,feed_mode,external_ref,source_feed,provenance,basis_state,recorded_at)
      VALUES ('primary','a0','owned','Bank','Acct','checking','asset','1234','USD','live','e0','bank-feed:old','feed','confirmed',?)`,NOW);
    f.sqlite.exec('BEGIN');
    const st=f.sqlite.prepare(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,pending,external_id,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary',?,'a0','2025-01-01',?,'outflow','USD','d','p',0,?,'feed','bank-feed:old','confirmed',?)`);
    for(let i=0;i<5000;i++)st.run('plaid:t'+i,100+i,'t'+i,NOW);
    f.sqlite.exec('COMMIT');
    f.raw(`INSERT INTO plaid_item_replacements (tenant_id,operation_ref,old_item_ref,new_item_ref,state,snapshot_json,plan_hash,diagnosis_json,approved_at,expires_at,updated_at)
      VALUES ('primary','op1','old','new','history_review','{}','h','{}',?,?,?)`,NOW,NOW,NOW);
    f.raw(`INSERT INTO plaid_replacement_events (tenant_id,operation_ref,revision,event_index,provider_id,provider_account_id,payload_json,digest)
      VALUES ('primary','op1',1,0,'t5','new-acct',?,'dg')`,JSON.stringify({operation:'added',date:'2026-10-01',amount:105,currency:'USD',direction:'outflow'}));
    f.sqlite.exec('ANALYZE');
    const {moneyConfidenceSnapshotSql}=await import('../src/lib/money-confidence.js');
    const sql=moneyConfidenceSnapshotSql(true,true);
    const started=performance.now();
    const rows=f.rows(sql);
    const ms=performance.now()-started;
    assert.ok(rows.some(r=>r.snapshot_kind==='confidence_accounts'));
    assert.ok(ms<1000,`snapshot took ${Math.round(ms)} ms with 5000 transactions and a pending event`);
  } finally { f.close(); }
});

test('confidence snapshot stays fast with a large ledger, published replace decisions and a revision-2 pending event',async()=>{
  const f=await createProductFixture({});
  try {
    seedOwnedEntity(f,'owned','Biz');
    f.raw(`INSERT INTO fin_accounts (tenant_id,account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,feed_mode,external_ref,source_feed,provenance,basis_state,recorded_at)
      VALUES ('primary','a0','owned','Bank','Acct','checking','asset','1234','USD','live','e0','bank-feed:old','feed','confirmed',?)`,NOW);
    f.sqlite.exec('BEGIN');
    const st=f.sqlite.prepare(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,pending,external_id,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary',?,'a0','2025-01-01',?,'outflow','USD','d','p',0,?,'feed','bank-feed:old','confirmed',?)`);
    for(let i=0;i<5000;i++)st.run('plaid:t'+i,100+i,'t'+i,NOW);
    f.sqlite.exec('COMMIT');
    f.raw(`INSERT INTO plaid_item_replacements (tenant_id,operation_ref,old_item_ref,new_item_ref,state,snapshot_json,plan_hash,diagnosis_json,approved_at,expires_at,updated_at)
      VALUES ('primary','op1','old','new','history_review','{}','h','{}',?,?,?)`,NOW,NOW,NOW);
    f.raw(`INSERT INTO plaid_replacement_events (tenant_id,operation_ref,revision,event_index,provider_id,provider_account_id,payload_json,digest)
      VALUES ('primary','op1',2,0,'t5','new-acct',?,'dg')`,JSON.stringify({operation:'added',date:'2026-10-01',amount:105,currency:'USD',direction:'outflow'}));
    // Published revision 1: 2000 replace decisions with their replacement rows. The
    // fence triggers block these writes while a review is open, so seed past them.
    for(const {name} of f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) f.sqlite.exec('DROP TRIGGER "'+name+'"');
    f.sqlite.exec('BEGIN');
    const ev=f.sqlite.prepare(`INSERT INTO plaid_replacement_events (tenant_id,operation_ref,revision,event_index,provider_id,provider_account_id,payload_json,digest) VALUES ('primary','op1',1,?,?,'new-acct',?,'dg')`);
    const de=f.sqlite.prepare(`INSERT INTO plaid_replacement_decisions (tenant_id,operation_ref,revision,event_index,action,old_row_id,evidence) VALUES ('primary','op1',1,?,'replace',?,'e')`);
    const nt=f.sqlite.prepare(`INSERT INTO fin_transactions (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,pending,external_id,provenance,source_feed,basis_state,recorded_at) VALUES ('primary',?,'a0','2026-01-01',100,'outflow','USD','d','p',0,?,'feed','bank-feed:new','confirmed',?)`);
    for(let i=1;i<=2000;i++){
      ev.run(i,'n'+i,JSON.stringify({operation:'added',date:'2026-01-01',amount:100,currency:'USD',direction:'outflow'}));
      de.run(i,i);nt.run('replacement:op1:n'+i+':1','n'+i,NOW);
    }
    f.sqlite.exec('COMMIT');
    f.sqlite.exec('UPDATE plaid_item_replacements SET published_revision=1');
    f.sqlite.exec('ANALYZE');
    const {moneyConfidenceSnapshotSql}=await import('../src/lib/money-confidence.js');
    const started=performance.now();
    const rows=f.rows(moneyConfidenceSnapshotSql(true,true));
    const ms=performance.now()-started;
    assert.ok(rows.some(r=>r.snapshot_kind==='confidence_accounts'));
    assert.ok(ms<1000,`snapshot took ${Math.round(ms)} ms with 5000 transactions and 2000 published replace decisions`);
  } finally { f.close(); }
});
