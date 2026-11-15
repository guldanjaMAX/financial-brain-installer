import { bankConnectionHealth, bankSyncError } from '../worker/src/lib/bank-feed-health.js';

const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,120) : 'A bank';

/** Explicit projection: connection ids, raw errors and credentials never leave it. */
export function projectBankStatus(body, now) {
  if (typeof body?.configured !== 'boolean' || !Array.isArray(body?.connections))
    throw new Error('Bank connection status could not be verified.');
  return body.connections.map(bank=>{
    const receipt=bank.health || {};
    const health=bankConnectionHealth({status:bank.status,connected_at:instant(bank.connected_at),
      last_attempt_at:instant(receipt.last_attempt_at),last_successful_sync_at:instant(receipt.last_successful_sync_at),data_through:receipt.data_through,
      next_due_at:instant(receipt.next_due_at || bank.next_pull_at || bank.reconciliation?.due_at),
      pending_state:receipt.pending_state || (bank.next_pull_at ? 'pending' : bank.reconciliation?.state),
      last_error_code:receipt.last_error_code,
      last_error_meaning:receipt.last_error_code ? bankSyncError(receipt.last_error_code).meaning : null},now);
    const waiting=Number.isSafeInteger(bank.accounts_needing_owner) && bank.accounts_needing_owner>=0 ? bank.accounts_needing_owner : 0;
    const status=['connected','error','reauth_required','permission_revoked','removed'].includes(bank.status) ? bank.status : 'unknown';
    return {bank:label(bank.institution_label) || 'A bank',status,
      last_successful_sync:health.last_successful_sync_at,next_due:health.next_due_at,
      overdue:health.overdue,needs_sign_in:health.needs_sign_in,accounts_waiting_for_owner:waiting,
      needs_attention:health.state!=='healthy' || waiting>0 || status==='unknown',
      health_line:[health.status_line,waiting>0 ? `Choose an owner for each account in Access > Banks to continue. Accounts waiting for your choice: ${waiting}.` : ''].filter(Boolean).join(' ')};
  });
}

export async function readBankStatus({base,adminKey,request,now=Date.now}) {
  const get=async path=>{
    const response=await request(`${base}${path}`,{method:'GET',redirect:'error',headers:{'X-Admin-Key':adminKey}},
      {timeoutMs:30000,what:'bank connection status'});
    if(!response?.ok) throw new Error('Bank connection status could not be read.');
    return response.json();
  };
  let worker_status='unavailable';
  try {
    const health=await get('/health');
    worker_status=['ok','paused-for-upgrade','storage-unavailable'].includes(health?.status) ? health.status : 'unknown';
  } catch { /* The connection read still provides useful dated evidence. */ }
  const body=await get('/api/bank-feed/status');
  return {worker_status,configured:body.configured,connections:projectBankStatus(body,now())};
}

export function renderBankStatus(status) {
  const lines=[`Worker /health: ${status.worker_status}${status.worker_status==='paused-for-upgrade' ? '. Bank sync is paused until the upgrade finishes.' : ''}`];
  if(!status.configured) lines.push('Bank syncing is not configured. Saved connection status follows; ask the installer to restore the bank feed settings.');
  for(const bank of status.connections) lines.push(`${bank.bank} | ${bank.status} | last successful sync: ${bank.last_successful_sync || 'never'} | next due: ${bank.next_due || 'unknown'} | overdue: ${bank.overdue?'yes':'no'} | needs sign-in: ${bank.needs_sign_in?'yes':'no'} | accounts waiting for owner: ${bank.accounts_waiting_for_owner}\n${bank.health_line}`);
  if(!status.connections.length) lines.push(status.configured ? 'No bank connections recorded.' : 'Bank connections are not configured.');
  return lines.join('\n');
}

export async function runBankStatusCommand({manifestPath,json=false},{loadManifest,resolveAdminKey,request,write,now}) {
  const {m}=loadManifest(manifestPath);
  const domain=m?.brain?.domain;
  let address;
  try {address=new URL(domain?.includes('://') ? domain : `https://${domain || ''}`);} catch {throw new Error('A saved Brain HTTPS address is required.');}
  if(address.protocol!=='https:' || address.username || address.password || address.port || address.pathname!=='/' || address.search || address.hash)
    throw new Error('A saved Brain HTTPS hostname is required.');
  const adminKey=resolveAdminKey(manifestPath,{ignoreEnvironment:true});
  if(!adminKey) throw new Error('No durable data-plane key is available for this manifest.');
  const status=await readBankStatus({base:address.origin,adminKey,request,now});
  write(json ? JSON.stringify(status,null,2) : renderBankStatus(status));
  return status;
}
