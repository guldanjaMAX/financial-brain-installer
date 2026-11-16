import { readBankStatus } from './bank-feed-status.mjs';

/** Read with the laptop clock before waking the bounded Worker path. A missing
 * cron cannot suppress the warning; a zero-work receipt cannot prove recovery. */
export async function refreshDailyBankFeed({base,adminKey,request,maxSlices=32,now=Date.now}) {
  let ran=0;
  let complete=true;
  let wakeFailed=false;
  let initial;
  try {initial=await readBankStatus({base,adminKey,request,now});}
  catch {complete=false;}
  const overdue_detected=initial?.connections.filter(bank=>bank.overdue).length || 0;
  const finish=(status,finished)=>({ran,complete:complete && finished && status?.configured===true && status?.worker_status==='ok' &&
    !status.connections.some(bank=>bank.needs_attention),overdue_detected,
    message:[overdue_detected ? `${overdue_detected} overdue bank connection(s) detected by daily refresh.` : '',
      status?.worker_status==='paused-for-upgrade' ? 'Worker /health is paused-for-upgrade; bank sync is paused until the upgrade finishes.' : '',
      status && !['ok','paused-for-upgrade'].includes(status.worker_status) ? 'Worker /health could not confirm a healthy Worker. Review the upgrade and connection status.' : '',
      status?.configured===false ? 'The enabled bank feed is not configured in the Worker. Review Access > Banks.' : '',
      wakeFailed ? 'The scheduled bank sync could not complete. Review Access > Banks; the overdue warning remains open.' : '',
      !status ? 'Bank connection health could not be verified. Review Access > Banks.' : '',
      ...(status?.connections.filter(bank=>bank.needs_attention).map(bank=>bank.health_line) || [])].filter(Boolean).join(' ') || 'Bank connections checked.',
    bank_status:status || null});
  if(initial?.worker_status==='paused-for-upgrade') return finish(initial,false);
  for(let slice=0;slice<maxSlices;slice++) {
    let result;
    try {
      const response=await request(`${base}/api/bank-feed/sync`,{
        method:'POST',redirect:'error',headers:{'X-Admin-Key':adminKey,'Content-Type':'application/json'},
        body:JSON.stringify({daily:true,max_items:10}),
      },{timeoutMs:120000,what:'the scheduled bank sync'});
      if(!response.ok) throw new Error('bank_sync_unavailable');
      result=await response.json();
      if(!Number.isSafeInteger(result?.ran) || result.ran<0 || !Array.isArray(result.items) || result.items.length!==result.ran)
        throw new Error('bank_sync_receipt_incomplete');
    } catch {
      // Keep the independent observation when a missing secret, upgrade pause
      // or transport outage also prevents the wake. Never turn it into success.
      complete=false;wakeFailed=true;
      return finish(initial,false);
    }
    ran+=result.ran;
    if(result.paused) complete=false;
    if(result.health_attention>0 || result.items.some(item=>item.ok===false || item.partial)) complete=false;
    if(result.ran===0 || result.paused) {
      let after;
      try {after=await readBankStatus({base,adminKey,request,now});} catch {complete=false;}
      return finish(after,true);
    }
  }
  return finish(initial,false);
}
