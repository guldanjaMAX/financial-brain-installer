/** Owner-authenticated page. Only operation ids and the short-lived Link token
 * live in session storage; financial review rows are rendered as text nodes. */
export function replacementPage() {
  const nonce=crypto.randomUUID();
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recover a bank connection</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#242c29;font:17px/1.6 system-ui,sans-serif}main{max-width:850px;margin:3rem auto;padding:0 1.2rem 4rem}h1{font-size:2rem;line-height:1.2}section{background:white;border:1px solid #ddd;border-radius:12px;padding:1.2rem;margin:1rem 0}button,select,input{font:inherit;max-width:100%;padding:.6rem;margin:.4rem .4rem .4rem 0}button{background:#244f43;color:white;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}:focus-visible{outline:3px solid #a04e12;outline-offset:3px}label{display:block}p{overflow-wrap:anywhere}.row{border-top:1px solid #ddd;padding:.8rem 0}.note{color:#505b55}#message{padding:.6rem;background:#fff0d5}a{color:#244f43}@media(max-width:540px){main{margin:1.5rem auto}h1{font-size:1.6rem}button,select{width:100%}}
</style></head><body><main><a href="/app">Back to your Brain</a><h1>Recover a bank connection</h1>
<p>Your saved accounts, transactions and older months stay available throughout recovery. Nothing is deleted.</p>
<p class="note">The old bank permission is not revoked. Missing activity can affect recent answers; its dollar impact is unknown until reviewed.</p>
<p id="message" role="status" aria-live="polite">Checking this saved connection.</p><section id="content"></section>
<button id="resume">Continue this recovery</button><button id="cancel">Cancel before bank sign-in</button>
<script nonce="${nonce}">
const $=id=>document.getElementById(id), query=new URLSearchParams(location.search), item=query.get('item_ref');
const storageKey='bank-replacement:'+item;let op=query.get('operation_ref') || sessionStorage.getItem(storageKey),plan=null,mappings=[],choices=[],intervals=[],linkHandler=null;
const say=text=>$('message').textContent=text;
function text(tag,value,parent=$('content')){const e=document.createElement(tag);e.textContent=value;parent.append(e);return e;}
function button(label,fn,parent=$('content')){const e=text('button',label,parent);e.type='button';e.onclick=()=>run(fn);return e;}
async function run(fn){for(const b of document.querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{for(const b of document.querySelectorAll('button'))b.disabled=false;}}
async function post(action,body={}){const r=await fetch('/api/bank-feed/replacement/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Brain-App':'1'},body:JSON.stringify({operation_ref:op,...body})});const data=await r.json();if(!r.ok)throw Error(data.detail);return data;}
async function load(){
 $('content').replaceChildren();
 if(!op){plan=await post('preview',{item_ref:item});say(plan.diagnostic.detail);text('p',plan.detail);
  for(const a of plan.accounts)text('p',a.name+' ending '+a.last4+' · '+a.type+' · '+a.currency);
  if(plan.existing_operation){op=plan.existing_operation;sessionStorage.setItem(storageKey,op);return load();}
  if(!plan.eligible){text('p','This connection needs a different recovery check before replacement. Ask the installer to review its custody report.');return;}
  const label=text('label',''),check=document.createElement('input');check.type='checkbox';label.append(check,document.createTextNode('The original protected access has been checked and cannot be recovered. Keep this history and prepare a new bank sign-in.'));
  button('Confirm and prepare sign-in',async()=>{if(!check.checked)throw Error('Confirm the custody review before continuing.');const result=await post('approve',{item_ref:item,approve:plan.plan_hash,expires_at:plan.expires_at,confirm_unrecoverable:true});op=result.operation_ref;sessionStorage.setItem(storageKey,op);await load();});return;
 }
 const r=await fetch('/api/bank-feed/replacement/status?operation_ref='+encodeURIComponent(op),{credentials:'same-origin',headers:{'X-Brain-App':'1'}});
 if(!r.ok)throw Error('Recovery status could not be read. Keep this recovery and try again.');
 const state=await r.json();say(state.detail);text('p',state.state==='history_review' ? 'Review the same accounts and statement occurrences below.' : state.state==='active' ? 'The reviewed handover is saved.' : 'Continue this saved recovery.');
 $('cancel').hidden=!['owner_approved','link_pending'].includes(state.state);
 if(['owner_approved','link_pending'].includes(state.state))button('Sign in to the bank',openLink);
 if(['candidate_staged','active'].includes(state.state))button('Fetch the next history page',async()=>{await post('stage');await load();});
 if(state.state==='history_review' || state.can_resume_review || state.open_review_count>0)await review(state.state==='rolled_back');
 if(state.published_revision>0 && state.state!=='rolled_back')button('Review rollback to the old connection',async()=>{const p=await post('rollback');text('p',p.detail);button('Confirm rollback and keep all saved activity',async()=>{await post('rollback',{approve:p.plan_hash});await load();});});
 if(['exchange_claimed','outcome_unknown'].includes(state.state))text('p','Keep this recovery reference. The installer must recover the same saved result; starting a new sign-in can create an untracked bank permission.');
}
async function sdk(){if(window.Plaid)return window.Plaid;await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';script.onload=resolve;script.onerror=()=>reject(Error('The bank sign-in screen could not load. Saved history is kept.'));document.head.append(script);});return window.Plaid;}
async function openLink(){
 const link=await post('link');sessionStorage.setItem('bank-replacement-current',JSON.stringify({item,op,link}));
 const plaid=await sdk();linkHandler=plaid.create({token:link.link_token,onSuccess:token=>run(async()=>{await post('complete',{public_token:token});sessionStorage.removeItem('bank-replacement-current');await load();}),onExit:()=>say('Bank sign-in closed. Your history is kept. Continue this same recovery when ready.')});linkHandler.open();
}
async function review(rolledBack=false){
 const p=await post('review',{mappings,choices,intervals});plan=p;
 text('h2','Match the same accounts');text('p','Confirm the account name, last four, type, currency and owner. Similar last four digits alone do not prove a match.');
 for(const a of p.accounts){const box=text('div','');box.className='row';text('p',a.name+' ending '+a.last4+' · '+a.type+' · '+a.currency,box);
  const label=text('label','New bank account',box),select=document.createElement('select');label.append(select);
  const options=[{provider_id:'',name:'Choose an account'},...p.incoming_accounts];
  for(const n of options){const o=document.createElement('option');o.value=n.provider_id;o.textContent=n.name+(n.last4?' ending '+n.last4:'');select.append(o);}select.value=a.provider_id || '';
  const confirmLabel=text('label','',box),check=document.createElement('input');check.type='checkbox';check.checked=a.confirmed;confirmLabel.append(check,document.createTextNode('This is the same account and owner.'));
  const update=()=>{mappings=mappings.filter(m=>m.account_slug!==a.account_slug);if(select.value)mappings.push({account_slug:a.account_slug,provider_id:select.value,confirm:check.checked});};select.onchange=update;check.onchange=update;update();
 }
 text('h2','Confirm statement coverage, when available');
 text('p','Optional: enter a complete statement interval for each account after comparing every occurrence. Leave this blank when dates or missing dollars are uncertain. A gap between intervals stays a gap.');
 for(const a of p.accounts){const box=text('div','');box.className='row';text('p',a.name+' ending '+a.last4,box);
  const old=intervals.find(i=>i.account_slug===a.account_slug);
  const fromLabel=text('label','Complete from',box),from=document.createElement('input');from.type='date';from.value=old?.from || '';fromLabel.append(from);
  const toLabel=text('label','Complete through',box),to=document.createElement('input');to.type='date';to.value=old?.to || '';toLabel.append(to);
  const proofLabel=text('label','Statement or reconciliation used',box),proof=document.createElement('input');proof.maxLength=500;proof.value=old?.evidence || '';proofLabel.append(proof);
  const update=()=>{intervals=intervals.filter(i=>i.account_slug!==a.account_slug);if(from.value || to.value || proof.value)intervals.push({account_slug:a.account_slug,from:from.value,to:to.value,evidence:proof.value});};from.onchange=update;to.onchange=update;proof.oninput=update;
 }
 text('h2','Review overlapping activity');text('p','Sync continues while these items stay open. Their affected dollars keep answers provisional. Keep distinct purchases even when their date and amount match. A duplicate or pending-to-posted change needs the exact statement occurrence.');
 for(const d of p.decisions){const box=text('div','');box.className='row';text('p',(d.date || 'Date not supplied')+' · '+d.amount_text+' · '+d.action,box);
  text('p',d.evidence,box);
  if(d.action==='review'){
    const label=text('label','Decision',box),select=document.createElement('select');label.append(select);
    for(const [v,t] of [['','Keep for review'],['admit','New, distinct statement occurrence'],['duplicate','Same saved posted occurrence'],['replace','Correction or pending became posted'],['remove','Withdrawn, including a redelivery that stays withdrawn']]){const o=document.createElement('option');o.value=v;o.textContent=t;select.append(o);}
    const priorLabel=text('label','Saved occurrence for duplicate or correction',box),prior=document.createElement('select');priorLabel.append(prior);const empty=document.createElement('option');empty.value='';empty.textContent='Choose the saved occurrence';prior.append(empty);
    for(const t of d.saved_occurrences){const o=document.createElement('option');o.value=t.id;o.textContent=t.date+' · '+t.amount_text+(t.pending?' · pending':'')+(t.withdrawn?' · withdrawn':'');prior.append(o);}
    const evidenceLabel=text('label','How did you verify this occurrence?',box),evidence=document.createElement('input');evidence.maxLength=500;evidenceLabel.append(evidence);
    const update=()=>{choices=choices.filter(c=>c.event_index!==d.event_index || c.event_revision!==d.event_revision);if(select.value)choices.push({event_revision:d.event_revision,event_index:d.event_index,action:select.value,...(prior.value?{old_row_id:Number(prior.value)}:{}),evidence:evidence.value});};select.onchange=update;prior.onchange=update;evidence.oninput=update;
  }
 }
 button('Check these choices',load);
 if(rolledBack)button('Review resuming this recovery',async()=>{const r=await post('resume');text('p',r.detail);button('Confirm resume for review, keep old connection selected',async()=>{await post('resume',{approve:r.plan_hash});await load();});});
 else if(p.can_complete || p.ready)button(p.unresolved ? 'Save reviewed activity and keep '+p.unresolved+' items open' : 'Confirm handover and keep history',async()=>{await post('activate',{approve:p.plan_hash,expires_at:p.expires_at,mappings,choices,intervals});await load();});
}
$('resume').onclick=()=>run(load);$('cancel').onclick=()=>run(async()=>{await post('cancel');sessionStorage.removeItem(storageKey);op=null;say('Preparation cancelled. Saved history is kept.');$('content').replaceChildren();});
run(async()=>{await load();if(query.has('oauth_state_id')){const saved=JSON.parse(sessionStorage.getItem('bank-replacement-current') || 'null');if(saved && saved.op===op){const plaid=await sdk();linkHandler=plaid.create({token:saved.link.link_token,receivedRedirectUri:location.href,onSuccess:token=>run(async()=>{await post('complete',{public_token:token});sessionStorage.removeItem('bank-replacement-current');await load();}),onExit:()=>say('Sign-in closed. Continue this same recovery.')});linkHandler.open();}}});
</script></main></body></html>`;
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store',
    'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}' https://cdn.plaid.com; style-src 'nonce-${nonce}'; connect-src 'self' https://*.plaid.com; frame-src https://*.plaid.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'}});
}
