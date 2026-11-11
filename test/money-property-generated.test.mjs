// Synthetic finder: no provider, router, credential, or product writes.
// Run: node --test test/money-property-generated.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { total, formatMinor, displayFigures } from '../eval/fast-loop/money-oracle.mjs';

let productAnswer = withLedgerAnswer;
const COUNT = 2000;
const clone = value => structuredClone(value);
const day = date => date.toISOString().slice(0, 10);
const ownerDay = (now,zone) => new Intl.DateTimeFormat('en-CA',{
  timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
}).format(new Date(now));
const addDays = (date, n) => day(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000));
// Generated days are <=28, except dedicated end-of-month boundary rows.
const month = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`), dom = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dom,last)); return day(d);
};
const rng = seed => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const oracleSum = rows => total(rows.map(r => r.cents));
function generate(index, seedBase = 0x4d4f4e45) {
  const seed = (seedBase + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  const random = rng(seed), int = n => Math.floor(random()*n);
  const n = 1+int(6), months = 1+int(14), size = index % 401;
  const target = ['2026-09-01','2026-02-01','2026-03-01','2026-10-01'][index%4];
  const end = addDays(month(target,1),-1);
  const today = index%3===0?addDays(month(target,2),-1):month(target,1);
  const start = month(target,1-months);
  const accounts = Array.from({length:n},(_,i)=>({slug:`account-${i}`,mask:String(6100+i),
    kind:['checking','savings','card','loan'][(index+i)%4],label:`Synthetic account ${i}`,
    balance:String([-101,-99,-1,0,1,49,50,99,101,99999999][int(10)]),observed:today,
    coverage:index%5===0 && i===n-1?'partial':'complete',from:start,to:addDays(today,20)}));
  for(const a of accounts) a.role=['card','loan'].includes(a.kind)?'liability':'asset';
  const rows=[];
  const put = (account,date,cents,direction,description='Synthetic purchase',extra={}) => {
    const id=rows.length+1;
    rows.push({id,uid:`synthetic-${id}`,account,date,cents:String(cents),direction,
      description,payee:description==='Synthetic refund'?'Synthetic store':description,pending:0,...extra});
    return rows.at(-1);
  };
  for(let i=0;i<(n>1 && size>=4 ? size-3 : size);i++) {
    const a=accounts[int(n)], m=int(months), date=month(target,-m).slice(0,8)+String(1+int(28)).padStart(2,'0');
    put(a.slug,date,[0,1,2,49,50,99,100,101,99999999,int(1000000)][int(10)],
      int(2)?'inflow':'outflow',i%13===0?'Synthetic refund':'Synthetic store', {pending:i%17===0?1:0});
  }
  // Disjoint high amounts prevent accidental equal-amount competition. The
  // oracle records the constructed economic event, never calls a classifier.
  if(n>1 && size>=4) {
    const source=accounts.find(a=>['checking','savings'].includes(a.kind)) || accounts[0];
    const dest=accounts.find(a=>a!==source) ;
    const payment=['card','loan'].includes(dest.kind) && ['checking','savings'].includes(source.kind);
    for(let j=0;j<2;j++) {
      if(rows.length>=size) break;
      const date=addDays(target,j?14:0), cents=200000001+j;
      const out=put(source.slug,date,cents,'outflow',`${payment?'payment':'transfer'} to account ${dest.mask}`,
        {payee:'',event:payment?'payment': 'transfer',destination:dest.slug});
      if(j===0 && rows.length<size) {
        const incoming=put(dest.slug,date,cents,'inflow',`transfer from account ${source.mask}`, {payee:'',event:'counterpart',peer:out.id,destination:source.slug});
        out.peer=incoming.id;
      }
    }
  }
  // Preserve the requested 0..400 row bound after dedicated movement probes.
  rows.splice(size);
  if(rows.length>=6) {
    rows[0].date=target; rows[1].date=end; rows[2].date=addDays(target,-1);
    rows[3].date=addDays(end,1); rows[4].date=addDays(target,7); rows[5].date=addDays(target,21);
  }
  const zone=index%2?'America/New_York':'America/Phoenix';
  // UTC month boundary is still the previous owner day; local noon cases
  // alternate with these to exercise both calendar interpretations.
  const now=index%3===0?`${addDays(today,1)}T00:30:00Z`:`${today}T19:00:00Z`;
  const positive=rows.find(r=>r.direction==='inflow'&&BigInt(r.cents)>0n&&!r.pending&&r.date>=target&&r.date<=end);
  return {seed,index,months,target,end,today,now,zone,accounts,rows,
    amount:positive?.cents || '12347',anchor:positive?.date || addDays(target,14)};
}
function database() {
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/d1/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(`../migrations/d1/${f}`,import.meta.url),'utf8'));
  return db;
}
function seed(db,s) {
  db.prepare("INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at) VALUES ('owner','Synthetic owner','Synthetic owner','business','active','owned','owner_stated','confirmed',?)").run(s.now);
  for(const a of s.accounts) {
    db.prepare("INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at) VALUES (?,'owner',?,?,?,?,'manual','owner_stated','confirmed',?)").run(a.slug,a.kind,a.role,a.mask,a.label,s.now);
    db.prepare("INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,'owner_stated','confirmed',?)").run(a.slug,a.coverage,a.from,a.to,s.now,s.now);
    db.prepare("INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at) VALUES (?,?,?,'owner_stated','confirmed',?)").run(a.slug,a.observed,Number(a.balance),s.now);
  }
  for(const r of s.rows) db.prepare("INSERT INTO fin_transactions (id,txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,basis_state,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)").run(r.id,r.uid,r.account,r.date,Number(r.cents),r.direction,r.description,r.payee,r.pending,s.now);
}
const questions = s => ['What are my account balances?','Show my last ten transactions.',
  'How much money came in last month?','How much money went out last month?',
  'What were my five biggest expenses last month?',
  `Did a payment of ${formatMinor(s.amount).replaceAll(',','')} arrive around ${s.anchor}?`];
async function answers(db,s) {
  db.exec('SAVEPOINT generated');
  try {
    seed(db,s); db.exec('PRAGMA query_only=ON');
    const prepare=(sql,binds=[])=>({sql,binds,bind:(...b)=>prepare(sql,b),all:async()=>({results:db.prepare(sql).all(...binds)})});
    const env={STORAGE:'d1',BRAIN_TIMEZONE:s.zone,DB:{prepare,batch:async statements=>statements.map(st=>({results:db.prepare(st.sql).all(...st.binds)}))},
      AI:{run(){throw Error('MODEL_FORBIDDEN');}}};
    const out=[];
    for(const question of questions(s)) out.push(await (await productAnswer({env,question,now:s.now,
      scopePrincipalKind:'owner',grantScope:{all:true}},async gap=>Response.json({gap}))).json());
    return out;
  } finally {db.exec('PRAGMA query_only=OFF');db.exec('ROLLBACK TO generated');db.exec('RELEASE generated');}
}
const covered = (a,from,to) => a.coverage==='complete' && a.from<=from && a.to>=to;
const complete = b => Boolean(b.ledger && b.evidence_gate?.complete && b.ledger.complete!==false && b.ledger.coverage?.complete!==false);
// Constructed event metadata supplies the independent owned-account truth.
// Spending excludes an authored own candidate; flow totals require the reciprocal proof below.
function ordinaryRows(s, rows) {
  return rows.filter(r => !(BigInt(r.cents)>0n && ['transfer','payment','counterpart'].includes(r.event) &&
    r.destination !== r.account && s.accounts.some(a => a.slug === r.destination)));
}
// Authored reciprocal peer links, equal amounts and the three-day window are
// independent proof. A destination label alone remains a possible movement.
function provenPeer(s, rows, row) {
  const out = row.direction==='outflow' ? s.accounts.find(a=>a.slug===row.account) : s.accounts.find(a=>a.slug===row.destination);
  const incoming = row.direction==='inflow' ? s.accounts.find(a=>a.slug===row.account) : s.accounts.find(a=>a.slug===row.destination);
  const supported = Boolean(out && incoming && out.slug !== incoming.slug);
  return supported && BigInt(row.cents)>0n && rows.some(peer=>peer.id===row.peer && peer.peer===row.id &&
    !peer.pending && peer.direction!==row.direction && peer.account===row.destination &&
    peer.destination===row.account && peer.cents===row.cents &&
    Math.abs(Date.parse(peer.date)-Date.parse(row.date))<=3*86400000);
}
function moneyOutRows(s,rows) {
  const bySlug=new Map(s.accounts.map(a=>[a.slug,a]));
  return rows.filter(r=>r.direction==='outflow' && bySlug.get(r.account)?.kind!=='loan' && !provenPeer(s,rows,r));
}
function eligibleExpenses(s,rows) {
  const bySlug=new Map(s.accounts.map(a=>[a.slug,a]));
  return ordinaryRows(s,rows).filter(r=>r.direction==='outflow' && bySlug.get(r.account)?.kind!=='loan' &&
    !(r.event==='payment' && BigInt(r.cents)>0n));
}
function inspect(s,bodies) {
  const failures=[];
  const fail=(q,property,actual,expected,refusal=false)=>failures.push({q,property,actual,expected,refusal});
  const equal=(q,p,a,e)=>{if(JSON.stringify(a)!==JSON.stringify(e))fail(q,p,a,e);};
  const posted=s.rows.filter(r=>!r.pending);
  const period=posted.filter(r=>r.date>=s.target&&r.date<=s.end);
  const allCovered=s.accounts.every(a=>covered(a,s.target,s.end));
  const unprovedCounterpart=moneyOutRows(s,period).some(row=>BigInt(row.cents)>0n&&row.destination&&
    period.some(peer=>peer.account===row.destination&&peer.direction==='inflow'&&peer.cents===row.cents&&
      Math.abs(Date.parse(peer.date)-Date.parse(row.date))<=3*86400000));
  bodies.forEach((b,q)=>{
    const l=b.ledger;
    const from=q===5?addDays(s.anchor,-7):q===1?s.accounts.map(a=>a.from).sort().at(-1):s.target;
    const requestedTo=q===5?addDays(s.anchor,7):q===1?s.today:s.end;
    // Future tolerance days have no observed activity. The independent oracle
    // keeps the requested bound and checks only the slice through the owner day.
    const to=q===5 && requestedTo>s.today?s.today:requestedTo;
    const scopeCovered=s.accounts.every(a=>covered(a,from,to));
    if(q!==0&&!scopeCovered&&(b.evidence_gate?.complete===true||l?.complete===true||l?.coverage?.complete===true))
      fail(q,'partial-complete',true,false);
    // Balances are observed facts independent of transaction-history coverage.
    if(!l) {if(q===0||scopeCovered)fail(q,'over-refusal',b.gap||b.gaps,'ledger',true);return;}
    if(q>=2&&q<=4)equal(q,'requested-period',[l.from,l.to],[s.target,s.end]);
    if(q===5) {
      equal(q,'lookup-period',[l.from,l.to],[from,to]);
      if(requestedTo>s.today) {
        equal(q,'lookup-requested-end',l.requested_to,requestedTo);
        equal(q,'lookup-future-complete',complete(b),false);
        equal(q,'lookup-future-coverage',l.coverage?.complete,false);
      }
    }
    if(q===0) {
      equal(q,'balances',l.accounts.map(a=>[a.account_mask,String(a.current_minor)]).sort(),s.accounts.map(a=>[a.mask,a.balance]).sort());
      equal(q,'balance-dates',l.accounts.map(a=>a.as_of),l.accounts.map(a=>s.accounts.find(x=>x.mask===a.account_mask).observed));
      const shown=displayFigures(b.answer).map(f=>f.cents);
      equal(q,'balance-display',shown,l.accounts.slice(0,shown.length).map(a=>s.accounts.find(x=>x.mask===a.account_mask)?.balance));
      if(shown.length<s.accounts.length)fail(q,'balance-display-omitted',shown.length,s.accounts.length,true);
    }
    if(q===1) {
      const expected=posted.filter(r=>r.date>=from&&r.date<=to).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id).slice(0,10);
      equal(q,'last-ten',l.rows.map(r=>[r.posted_on,String(r.amount_minor),r.direction,r.account_mask]),expected.map(r=>[r.date,r.cents,r.direction,s.accounts.find(a=>a.slug===r.account).mask]));
      equal(q,'transactions-display',displayFigures(b.answer).map(f=>f.cents),expected.map(r=>r.direction==='outflow'&&r.cents!=='0'?`-${r.cents}`:r.cents));
    }
    if(q===2 && complete(b)) {
      equal(q,'inflow',String(l.combined_inflow_minor),oracleSum(period.filter(r=>r.direction==='inflow')));
      for(const a of l.lead_accounts) {
        const rs=period.filter(r=>!provenPeer(s,period,r) &&
          !(BigInt(r.cents)>0n && ['transfer','payment','counterpart'].includes(r.event) &&
            ['card','loan'].includes(s.accounts.find(a=>a.slug===(r.direction==='outflow'?r.destination:r.account))?.kind)) &&
          s.accounts.find(x=>x.slug===r.account).mask===a.account_mask);
        equal(q,'ordinary-account-credits',String(a.credits_minor),oracleSum(rs.filter(r=>r.direction==='inflow')));
        equal(q,'ordinary-account-debits',String(a.debits_minor),oracleSum(rs.filter(r=>r.direction==='outflow')));
      }
      for(const a of l.accounts) {
        const rs=period.filter(r=>s.accounts.find(x=>x.slug===r.account).mask===a.account_mask);
        equal(q,'account-credits',String(a.credits_minor),oracleSum(rs.filter(r=>r.direction==='inflow')));
        equal(q,'account-debits',String(a.debits_minor),oracleSum(rs.filter(r=>r.direction==='outflow')));
      }
    }
    if(q===3 && complete(b)) {
      equal(q,'money-out-measure',l.outflow_measure,'money_out');
      equal(q,'expenses',String(l.expense_total_minor),oracleSum(moneyOutRows(s,period)));
      for(const row of moneyOutRows(s,period).filter(r=>BigInt(r.cents)>0n&&['transfer','payment','counterpart'].includes(r.event))) {
        const ref=b.citations.find(c=>c.ref===`ledger:transaction:${row.id}`);
        const entry=[...(l.possible_payments||[]),...(l.possible_transfers||[])].find(r=>r.n===ref?.n);
        equal(q,'possible-outflow-included',Boolean(entry&&entry.included_in_total&&String(entry.amount_minor)===row.cents),true);
        equal(q,'possible-outflow-disclosed',Boolean(ref&&b.answer.split('\n').some(line=>line.startsWith('included above, possibly')&&line.includes(`[${ref.n}]`))),true);
      }
    }
    if(q===4 && complete(b)) {
      const expected=eligibleExpenses(s,period).sort((a,b)=>Number(BigInt(b.cents)-BigInt(a.cents))||a.id-b.id).slice(0,5);
      equal(q,'ranking',(l.lead_rows||l.rows).map(r=>Number(r.ref.split(':').at(-1))),expected.map(r=>r.id));
    }
    if(q===5 && scopeCovered) {
      const hits=posted.filter(r=>r.direction==='inflow'&&r.cents===s.amount&&r.date>=from&&r.date<=to);
      equal(q,'payment-count',l.match_count,hits.length);
      // This amount-only question asks whether any arrival exists, not which
      // unique payment it was. Multiple exact deposits prove existence too.
      if(hits.length>1&&l.found===null&&!complete(b))
        fail(q,'payment-existence-over-refusal',l.found,{exists:true,matches:hits.length},true);
      else equal(q,'payment-found',l.found,hits.length>0);
      // Requested amounts and nearby receipts are context, never exact matches.
      const nearby=posted.filter(r=>r.direction==='inflow' && r.cents!==s.amount && r.date>=from && r.date<=to &&
        BigInt(r.cents)-BigInt(s.amount)<=100n && BigInt(s.amount)-BigInt(r.cents)<=100n &&
        Math.abs(Date.parse(r.date)-Date.parse(s.anchor))<=3*86400000);
      const figures=prefix=>b.answer.split('\n').filter(line=>line.startsWith(prefix)).flatMap(line=>displayFigures(line).map(f=>f.cents)).sort();
      equal(q,'payment-matched-display',figures('Found a deposit'),hits.map(r=>r.cents).sort());
      equal(q,'payment-possible-display',figures('Possible nearby deposit'),nearby.map(r=>r.cents).sort());
      equal(q,'payment-display',displayFigures(b.answer).map(f=>f.cents).sort(),
        [...hits.map(r=>r.cents),...nearby.map(r=>r.cents),...(!hits.length?[s.amount]:[])].sort());
    }
    if(q===3&&allCovered&&unprovedCounterpart) {
      equal(q,'unproved-counterpart-withheld',complete(b),false);
      equal(q,'unproved-counterpart-no-figure',l.expense_total_minor,null);
      equal(q,'unproved-counterpart-disclosure',/money out is withheld/i.test(b.answer),true);
    }
    if(q>=2&&q<=4&&allCovered&&!complete(b)&&!(q===3&&unprovedCounterpart)) fail(q,'over-refusal',b.evidence_gate,'complete',true);
    if(complete(b)&&[2,3,4].includes(q)) {
      const expenses=q===3?moneyOutRows(s,period):eligibleExpenses(s,period);
      const sum=oracleSum(period.filter(r=>r.direction==='inflow'));
      const matched=period.filter(r=>r.event==='counterpart'&&BigInt(r.cents)>0n).filter(r=>{
        const peer=s.rows.find(p=>p.id===r.peer);
        return peer&&!peer.pending&&peer.cents===r.cents&&Math.abs(Date.parse(peer.date)-Date.parse(r.date))<=3*86400000&&
          s.accounts.every(a=>a.slug!==peer.account||covered(a,peer.date,peer.date));
      });
      for(const line of b.answer.split('\n')) {
        const figures=displayFigures(line).map(f=>f.cents);
        if(!figures.length)continue;
        let expected;
        // Repayment disclosure also includes the receiving liability leg and
        // card-funded payments. The generator's event tag describes its older
        // checking-funded probe; input account roles supply this wider truth.
        const paymentRows=period.filter(r=>(q!==3||provenPeer(s,period,r)) && BigInt(r.cents)>0n &&
          ['transfer','payment','counterpart'].includes(r.event) && r.destination!==r.account &&
          ['card','loan'].includes(s.accounts.find(a=>a.slug===(r.direction==='outflow'?r.destination:r.account))?.kind) &&
          (q!==3||r.direction==='outflow'));
        // Peer links are authored by the generator. Opposite postings of one
        // owned payment are one economic event; unpaired legs remain separate.
        const economicPayments=paymentRows.filter(row=>row.direction!=='inflow'||!paymentRows.some(peer=>
          peer.direction==='outflow' && row.peer===peer.id && peer.peer===row.id &&
          peer.account===row.destination && peer.destination===row.account &&
          peer.cents===row.cents && Math.abs(Date.parse(peer.date)-Date.parse(row.date))<=3*86400000));
        if(line.startsWith('Payments to loans and cards (excluded from spending and income):')) {
          expected=[oracleSum(economicPayments)];
          equal(q,'payment-disclosure-total',String(l.payment_exclusions?.total_minor),oracleSum(economicPayments));
          equal(q,'payment-disclosure-count',l.payment_exclusions?.count,economicPayments.length);
        } else if(/^(?:payment to (?:a card|a loan|your own loan)|and \d+ more:)/i.test(line)) {
          const cited=[...line.matchAll(/\[(\d+)\]/g)].map(m=>b.citations.find(c=>c.n===Number(m[1])));
          const members=cited.map(c=>paymentRows.find(r=>`ledger:transaction:${r.id}`===c?.ref));
          equal(q,'payment-disclosure-members',members.every(Boolean),true);
          expected=[oracleSum(members.filter(Boolean))];
        } else if(line.startsWith('Pending activity:')) {
          const pending=s.rows.filter(r=>r.pending&&r.date>=s.target&&r.date<=s.end);
          expected=[oracleSum(pending)];
          equal(q,'pending-disclosure-count',l.pending_excluded?.count,pending.length);
          equal(q,'pending-disclosure-total',String(l.pending_excluded?.total_minor),oracleSum(pending));
        } else if(/^(?:included (?:above|in money out above), possibly|possible .*not counted)/.test(line)) {
          const refs=[...line.matchAll(/\[(\d+)\]/g)].map(m=>b.citations.find(c=>c.n===Number(m[1])));
          const members=refs.map(c=>period.find(r=>`ledger:transaction:${r.id}`===c?.ref));
          equal(q,'possible-movement-membership',members.length>0&&members.every(r=>r&&['transfer','payment','counterpart'].includes(r.event)&&!provenPeer(s,period,r)),true);
          expected=members.filter(Boolean).map(r=>r.cents);
        } else if(q===2) {
          if(line.startsWith('Combined recorded inflow:'))expected=[sum];
          else if(line.startsWith('Matched transfers between your own accounts:'))expected=[oracleSum(matched)];
          else if(line.startsWith('Inflow from outside your covered accounts:'))expected=[(BigInt(sum)-BigInt(oracleSum(matched))).toString()];
          else {
            const mask=/account ending (\d+)/.exec(line)?.[1];
            const a=s.accounts.find(a=>a.mask===mask),rs=period.filter(r=>r.account===a?.slug);
            if(a)expected=[oracleSum(rs.filter(r=>r.direction==='inflow')),oracleSum(rs.filter(r=>r.direction==='outflow'))];
          }
        } else if(line.startsWith('Payments to your own loan/card accounts:')) expected=[oracleSum(economicPayments.filter(row=>provenPeer(s,period,row)))];
        else if(line.startsWith('Unconfirmed categories:')) {
          // This synthetic population has no category labels. Count and sum
          // the independent expense membership before admitting its disclosure.
          expected=[oracleSum(expenses)];
          equal(q,'unconfirmed-category-count',l.unconfirmed_category_count,expenses.length);
          equal(q,'unconfirmed-category-amount',String(l.unsorted_minor),oracleSum(expenses));
          equal(q,'unconfirmed-category-copy',line,`Unconfirmed categories: ${expenses.length} rows totaling ${formatMinor(oracleSum(expenses))}; left out of confirmed category totals.`);
        } else if(q===3) {
          // The went-out lead and its merchant lines read the money-out membership.
          const outgoing=moneyOutRows(s,period);
          if(/^(?:Money out(?: I could check)?: |You spent |Unsorted:)/.test(line))expected=[oracleSum(outgoing)];
          else {
            const merchant=line.split(':')[0];
            expected=[oracleSum(outgoing.filter(r=>(r.payee||r.description).toLowerCase()===merchant))];
          }
        } else {
          const gross=period.filter(r=>r.direction==='outflow').sort((a,b)=>Number(BigInt(b.cents)-BigInt(a.cents))||a.id-b.id).slice(0,5);
          if(line.startsWith('If these are transfers')) {
            expected=[oracleSum(gross.filter(r=>{
              const peer=s.rows.find(p=>p.id===r.peer);
              return !peer||peer.pending||BigInt(r.cents)===0n||Math.abs(Date.parse(peer.date)-Date.parse(r.date))>3*86400000;
            }))];
          } else if(line.startsWith('Note:')) {
            expected=[oracleSum(gross.filter(r=>r.event==='transfer'&&provenPeer(s,period,r)&&!expenses.some(e=>e.id===r.id)))];
          } else expected=[...line.matchAll(/\[(\d+)\]/g)].map(m=>{
            const cite=b.citations.find(c=>c.n===Number(m[1]));
            return s.rows.find(r=>`ledger:transaction:${r.id}`===cite?.ref)?.cents;
          });
        }
        equal(q,'complete-display',figures,expected);
      }
    }
    // Every displayed citation-backed transaction figure must match its source.
    for(const c of b.citations||[]) {
      if(!c.ref?.startsWith('ledger:transaction:'))continue;
      const r=s.rows.find(r=>r.id===Number(c.ref.split(':').at(-1)));
      if(!r||String(c.amount_minor)!==r.cents||c.posted_on!==r.date) fail(q,'citation',c,r);
    }
  });
  return failures;
}
function transform(s,kind) {
  const t=clone(s);
  if(kind==='scale') {
    t.amount=(BigInt(t.amount)*2n).toString();
    t.accounts.forEach(a=>a.balance=(BigInt(a.balance)*2n).toString());
    t.rows.forEach(r=>r.cents=(BigInt(r.cents)*2n).toString());
  } else if(kind==='outside') {
    // Older than all stored history and >6 days from every relevant window.
    const date=month(t.accounts.map(a=>a.from).sort()[0],-2);
    t.rows.push({id:10001,uid:'synthetic-outside',account:t.accounts[0].slug,date,cents:'171',direction:'outflow',description:'Unrelated synthetic store',payee:'Unrelated synthetic store',pending:0});
  } else {
    for(const key of ['target','end','today','anchor'])t[key]=month(t[key],1);
    t.end=addDays(month(t.target,1),-1);
    t.now=month(t.now.slice(0,10),1)+t.now.slice(10);
    t.today=ownerDay(t.now,t.zone);
    for(const a of t.accounts)for(const key of ['from','to','observed'])a[key]=month(a[key],1);
    // Preserve end-of-period membership when month lengths differ.
    for(const r of t.rows)r.date=r.date===s.end?t.end:month(r.date,1);
  }
  return t;
}
function projection(b) {
  const l=b.ledger;
  if(!l)return {complete:false};
  const money={};
  const walk=(v,path='')=>{for(const [k,x] of Object.entries(v)) {
    if(k==='if_own_transfers'||k==='default_exclusions')continue;
    if(k.endsWith('_minor')&&typeof x==='number') money[`${path}${k}`]=String(x);
    else if(x&&typeof x==='object')walk(x,`${path}${k}.`);
  }};walk(l);
  return {kind:l.kind,complete:complete(b),money,ids:(l.lead_rows||l.rows||[]).map(r=>r.ref||[r.account_mask,r.direction]),found:l.found,match_count:l.match_count};
}
async function evaluate(db,s,metamorphic=true) {
  const bodies=await answers(db,s), failures=inspect(s,bodies);
  if(metamorphic)for(const kind of ['outside','scale','month']) {
    const transformed=transform(s,kind),changed=await answers(db,transformed);
    failures.push(...inspect(transformed,changed).filter(f=>!f.refusal).map(f=>({...f,property:`${kind}-${f.property}`})));
    for(let q=0;q<6;q++) {
      const expected=projection(bodies[q]),actual=projection(changed[q]);
      // Calendar months need not preserve a payment tolerance window's relation
      // to today. Inspect checks each window independently; compare money here.
      if(kind==='month' && q===5 && (addDays(s.anchor,7)>s.today)!==(addDays(transformed.anchor,7)>transformed.today)) {
        delete expected.complete; delete actual.complete;
      }
      if(kind==='scale')for(const k of Object.keys(expected.money||{}))expected.money[k]=(BigInt(expected.money[k])*2n).toString();
      // Month clamping can merge days and change last-ten tie ordering; compare
      // cent totals/ranking only when all source days survive without merging.
      if(kind==='month' && [1,4,5].includes(q) && s.rows.some(r=>Number(r.date.slice(-2))>28))continue;
      if(JSON.stringify(expected)!==JSON.stringify(actual)) failures.push({q,property:`metamorphic-${kind}`,actual,expected,refusal:false});
    }
  }
  return failures;
}
// Delta-debug to deletion minimality, then remove unused accounts. A final
// single-row pass proves no remaining row can be deleted for the same failure.
async function shrink(db,s,wanted) {
  let current=clone(s);
  const reproduces=async candidate=>(await evaluate(db,candidate,wanted.property.startsWith('metamorphic'))).some(f=>f.q===wanted.q&&f.property===wanted.property&&f.refusal===wanted.refusal);
  if(wanted.property==='payment-existence-over-refusal') {
    const candidate=clone(current);
    candidate.rows=candidate.rows.filter(r=>!r.pending&&r.direction==='inflow'&&r.cents===candidate.amount&&
      r.date>=addDays(candidate.anchor,-7)&&r.date<=addDays(candidate.anchor,7)).slice(0,2);
    if(await reproduces(candidate))current=candidate;
  }
  const empty=clone(current); empty.rows=[];
  if(await reproduces(empty))current=empty;
  for(let width=Math.max(1,Math.floor(current.rows.length/2));width>=1;width=Math.floor(width/2)) {
    for(let i=0;i<current.rows.length;) {
      const candidate=clone(current);candidate.rows.splice(i,width);
      if(await reproduces(candidate))current=candidate;else i+=width;
    }
  }
  for(let i=0;i<current.accounts.length&&current.accounts.length>1;) {
    if(current.rows.some(r=>r.account===current.accounts[i].slug)){i++;continue;}
    const candidate=clone(current);candidate.accounts.splice(i,1);
    if(await reproduces(candidate))current=candidate;else i++;
  }
  return current;
}

test('2,000 seeded ledgers: six measures, independent cents, coverage and metamorphic checks',async()=>{
  const start=performance.now(),db=database(),groups=new Map();
  let wrong=0,refusals=0,checks=0;
  try {
    for(let i=0;i<COUNT;i++) {
      const s=generate(i),failures=await evaluate(db,s);
      checks+=24;
      for(const failure of failures) {
        if(failure.refusal)refusals++;else wrong++;
        const key=`${failure.q}:${failure.property}`;
        // Shrink each failing ledger/property, retaining the smallest witness
        // per group in stdout. Nothing writes generated ledgers to disk.
        const minimal=await shrink(db,s,failure);
        const group=groups.get(key)||{key,count:0,refusal:failure.refusal,example:failure,witness:minimal};
        group.count++;
        if(minimal.rows.length+minimal.accounts.length<group.witness.rows.length+group.witness.accounts.length)group.witness=minimal;
        groups.set(key,group);
      }
      if((i+1)%250===0)console.log(`progress ledgers=${i+1} wrong_figures=${wrong} over_refusals=${refusals}`);
    }
  } finally {db.close();}
  console.log('MONEY_PROPERTY_RESULT '+JSON.stringify({ledgers:COUNT,wrong_figures:wrong,groups:groups.size,over_refusals:refusals,checks,runtime_s:Math.round((performance.now()-start)/1000),failures:[...groups.values()]}));
  assert.equal(wrong,0,'Wrong complete figures or metamorphic violations; grouped witnesses above');
  assert.equal(refusals,0,'Day-one answers must not hide balances or refuse deposit existence');
});





test('four in-memory product mutants turn cents and coverage properties red',async()=>{
  const db=database(),s=generate(31);
  const url=new URL('../worker/src/lib/ledger-answer.js',import.meta.url);
  const original=readFileSync(url,'utf8');
  const mutants=[
    ['balance','current_minor: row.current_minor,','current_minor: row.current_minor + 1,','balances'],
    ['inflow','combined_inflow_minor: combined,','combined_inflow_minor: combined + 1,','inflow'],
    ['expense','expense_total_minor: totalMinor,','expense_total_minor: totalMinor + 1,','expenses'],
    ['coverage','if (scope) labelPartialPeriodAnswer(result, scope, intent);','if (scope) { labelPartialPeriodAnswer(result, scope, intent); result.ledger.complete = true; }','partial-complete'],
  ];
  try {
    assert.equal((await evaluate(db,s,false)).filter(f=>!f.refusal).length,0,'unmutated control green');
    for(const [name,before,after,property] of mutants) {
      assert.ok(original.includes(before),`mutant anchor ${name}`);
      const source=original.replace(before,after).replace(/(['"])(\.\/[^'"]+)\1/g,(_,quote,path)=>quote+new URL(path,url).href+quote);
      productAnswer=(await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).withLedgerAnswer;
      const input=name==='coverage'?clone(s):s;
      if(name==='coverage') {
        if(input.accounts.length===1)input.accounts.push({...input.accounts[0],slug:'extra',mask:'6199',label:'Synthetic extra account'});
        input.accounts.at(-1).coverage='partial';
      }
      const failures=await evaluate(db,input,false);
      assert.ok(failures.some(f=>f.property===property&&!f.refusal),`${name} must turn the cents property red`);
      console.log(`mutant killed: ${name}`);
      productAnswer=withLedgerAnswer;
    }
    assert.equal((await evaluate(db,s,false)).filter(f=>!f.refusal).length,0,'restored control green');
  } finally {productAnswer=withLedgerAnswer;db.close();}
});

for (const [index, expectedSeed] of [[14,2458873884],[64,2036676158]]) {
  test('day-one regression seed '+expectedSeed,async()=>{
    const db=database(),s=generate(index);
    assert.equal(s.seed,expectedSeed);
    try {assert.deepEqual(await evaluate(db,s,false),[]);} finally {db.close();}
  });
}

async function dayOneCheck(db,s) {
  const bodies=await answers(db,s);
  const payment=bodies[5];
  if(s.accounts.some(a=>!covered(a,addDays(s.anchor,-7),addDays(s.anchor,7)))) {
    assert.notEqual(payment.ledger?.found,false,'missing coverage cannot prove absence');
    assert.equal(complete(payment),false,'missing coverage stays partial');
  }
  assert.deepEqual(inspect(s,bodies),[]);
}
test('day-one mutants: balance display capped at five; multiple exact deposits return found=null; missing coverage answered no',async()=>{
  const db=database(),url=new URL('../worker/src/lib/ledger-answer.js',import.meta.url);
  const original=readFileSync(url,'utf8');
  const missing=generate(64);missing.accounts[0].coverage='partial';missing.rows=[];
  const mutants=[
    ['balance display capped at five','const cited = ordered;','const cited = ordered.slice(0, 5);',generate(14)],
    ['multiple exact deposits return found=null','found: ambiguous && !existenceLookup ? null : matched.length > 0,','found: ambiguous ? null : matched.length > 0,',generate(64)],
    ['missing coverage answered no','else if (!periodCovered) return { reason: "period_outside_coverage" };','else if (!periodCovered) return { answer: "No matching deposit.", citations: [], ledger: { kind: "payment", found: false, complete: true } };',missing],
  ];
  try {
    for(const [name,before,after,input] of mutants) {
      await dayOneCheck(db,input);
      assert.ok(original.includes(before),'mutant anchor '+name);
      const source=original.replace(before,after).replace(/(['"])(\.\/[^'"]+)\1/g,(_,quote,path)=>quote+new URL(path,url).href+quote);
      productAnswer=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).withLedgerAnswer;
      await assert.rejects(()=>dayOneCheck(db,input),{code:'ERR_ASSERTION'},name);
      console.log('mutant killed: '+name);
      productAnswer=withLedgerAnswer;
      await dayOneCheck(db,input);
    }
  } finally {productAnswer=withLedgerAnswer;db.close();}
});

test('month shift crossing payment future bound preserves monetary oracle', async () => {
  const db = database();
  try {
    const input = generate(1606,0x6a7b8c90), shifted = transform(input,'month');
    assert.equal(input.seed,2562237663);
    assert.ok(addDays(input.anchor,7)<=input.today,'original window has ended');
    assert.ok(addDays(shifted.anchor,7)>shifted.today,'shifted window is still partial');
    assert.deepEqual(await evaluate(db,input),[]);
  } finally { db.close(); }
});

test('payment amount context regression seed 1',async()=>{
  const db=database();
  try { assert.deepEqual(await evaluate(db,generate(1),false),[]); } finally { db.close(); }
});

test('reciprocal card-to-loan event proof is independent of the payment subtype', () => {
  const s=generate(46),out=s.rows.find(row=>row.event==='transfer'&&row.peer);
  assert.equal(s.seed,1501472572);
  assert.ok(out, 'authored reciprocal event exists');
  assert.equal(s.accounts.find(account=>account.slug===out.account).kind,'card');
  assert.equal(s.accounts.find(account=>account.slug===out.destination).kind,'loan');
  assert.equal(provenPeer(s,s.rows,out),true,'owned identity proof is independent of repayment subtype');
  const unary=s.rows.find(row=>row.event==='transfer'&&!row.peer);
  assert.ok(unary,'same ledger has a separate one-sided control');
  assert.equal(provenPeer(s,s.rows,unary),false);
});
