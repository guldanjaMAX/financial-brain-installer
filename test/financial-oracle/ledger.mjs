// Test-only independent double-entry oracle. No product monetary/parser imports.
export function requireThat(ok, code) { if (!ok) throw new Error(`ORACLE_${code}`); }
export function day(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'DATE');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === value, 'DATE');
  return stamp / 86400000;
}
export function decimalMinor(value, exponent = 2) {
  requireThat(Number.isInteger(exponent) && exponent >= 0 && exponent <= 6, 'EXPONENT');
  requireThat(typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value), 'DECIMAL');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  requireThat(fraction.length <= exponent, 'PRECISION');
  return (BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0')) * (value.startsWith('-') ? -1n : 1n);
}
export function minorDecimal(value, exponent = 2) {
  const n=BigInt(value); const digits=(n<0n?-n:n).toString().padStart(exponent+1,'0');
  return `${n<0n?'-':''}${exponent?`${digits.slice(0,-exponent)}.${digits.slice(-exponent)}`:digits}`;
}
const sum = values => values.reduce((s,v)=>s+v,0n);
export function calculate(fixture, period = fixture.period) {
  requireThat(fixture.synthetic_only === true && fixture.currency === 'USD' && fixture.exponent === 2, 'FIXTURE');
  day(period.start); day(period.end); requireThat(period.start <= period.end, 'PERIOD');
  const balances = Object.fromEntries(Object.keys(fixture.accounts).map(a=>[a,0n]));
  const opening = {...balances}; const activity={...balances}; const ids=new Set();
  const byId=new Map(fixture.events.map(e=>[e.id,e]));
  for (const e of fixture.events) {
    requireThat(!ids.has(e.id),'DUPLICATE'); ids.add(e.id); day(e.date);
    requireThat(e.postings.length>=2,'POSTINGS');
    let debit=0n,credit=0n;
    for (const p of e.postings) {
      requireThat(Object.hasOwn(balances,p.account) && ['debit','credit'].includes(p.side) && /^\d+$/.test(p.minor),'POSTING');
      const n=BigInt(p.minor); if(p.side==='debit') debit+=n; else credit+=n;
      const signed=p.side==='debit'?n:-n;
      if(e.date<=period.end) balances[p.account]+=signed;
      if(e.date<period.start) opening[p.account]+=signed;
      if(e.date>=period.start && e.date<=period.end) activity[p.account]+=signed;
    }
    requireThat(debit===credit,'UNBALANCED');
    if(e.linked || e.apply_to) {
      const target=byId.get(e.linked||e.apply_to);
      requireThat(target && target.party===e.party && ['Invoice','Bill'].includes(target.api_entity) && target.date<=e.date,'ALLOCATION');
    }
  }
  const role=(which, map=balances)=>sum(Object.keys(map).filter(a=>fixture.accounts[a].role===which).map(a=>map[a]));
  const income=-role('income',activity),expenses=role('expense',activity),profit=income-expenses;
  const accumulated=-role('income')-role('expense');
  const bank=['checking','savings'];
  const lines=fixture.events.filter(e=>e.date>=period.start && e.date<=period.end).flatMap(e=>e.postings).filter(p=>bank.includes(p.account));
  const values={};
  for (const a of ['checking','savings','ar','undeposited','equipment']) values[a]=balances[a];
  for (const a of ['ap','card','sales_tax','payroll','loan']) values[a]=-balances[a];
  values.revenue=-activity.revenue; values.interest=-activity.interest;
  Object.assign(values,{expenses,profit,assets:role('asset'),liabilities:-role('liability'),equity:-role('equity')-role('contra_equity')+accumulated,
    bank_cash:sum(bank.map(a=>balances[a])),cash_change:sum(bank.map(a=>balances[a]-opening[a])),
    trial_balance_debits:sum(Object.values(balances).filter(n=>n>0n)),trial_balance_credits:-sum(Object.values(balances).filter(n=>n<0n)),
    bank_inflows:sum(lines.filter(p=>p.side==='debit').map(p=>BigInt(p.minor))),bank_outflows:sum(lines.filter(p=>p.side==='credit').map(p=>BigInt(p.minor)))});
  const open_items=[];
  for (const e of fixture.events.filter(e=>['Invoice','Bill'].includes(e.api_entity) && e.date<=period.end).sort((a,b)=>a.id.localeCompare(b.id))) {
    const control=e.api_entity==='Invoice'?'ar':'ap';
    let amount=sum(e.postings.filter(p=>p.account===control).map(p=>BigInt(p.minor)));
    for (const payment of fixture.events.filter(p=>(p.linked===e.id || p.apply_to===e.id) && p.date<=period.end)) {
      const allocations=payment.postings.filter(p=>p.account===control);
      requireThat(allocations.length===1 && allocations[0].side===(control==='ar'?'credit':'debit'),'ALLOCATION');
      amount-=BigInt(allocations[0].minor);
    }
    requireThat(amount>=0n,'OVERALLOCATION');
    const age=day(period.end)-day(e.due);
    if(amount) open_items.push({id:e.id,party:e.party,kind:control,minor:String(amount),due:e.due,aging_bucket:age<=0?'current':age<=30?'1-30':age<=60?'31-60':age<=90?'61-90':'91+'});
  }
  // A future fixture with control-account journals must supply a new bridge;
  // never silently equate invoice totals with net AR outside this clean ledger.
  for(const control of ['ar','ap']) requireThat(sum(open_items.filter(i=>i.kind===control).map(i=>BigInt(i.minor)))===values[control],'OPEN_ITEM_BRIDGE');
  const transferEvents=fixture.events.filter(e=>e.api_entity==='Transfer'&&e.date>=period.start&&e.date<=period.end);
  const transfer=sum(transferEvents.flatMap(e=>e.postings).filter(p=>bank.includes(p.account)&&p.side==='debit').map(p=>BigInt(p.minor)));
  const transferNet=sum(transferEvents.flatMap(e=>e.postings).filter(p=>bank.includes(p.account)).map(p=>BigInt(p.minor)*(p.side==='debit'?1n:-1n)));
  return {values:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,String(v)])),open_items,total_income:String(income),transfer:String(transfer),transfer_net:String(transferNet),events_checked:ids.size};
}
export function perturbExpense(fixture,delta) {
  const f=structuredClone(fixture); const expense=f.events.find(e=>e.id==='S12');
  requireThat(expense?.postings.length===2 && BigInt(delta)>0n,'PERTURBATION');
  for(const p of expense.postings) p.minor=String(BigInt(p.minor)+BigInt(delta));
  return f;
}
