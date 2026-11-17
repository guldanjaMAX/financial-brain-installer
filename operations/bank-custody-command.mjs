/** Parsed arguments and injected durable credential/read transport only. */
export async function runBankCustodyCommand({manifestPath,json=false},{loadManifest,resolveAdminKey,request,write}) {
  const {m}=loadManifest(manifestPath);
  const domain=m?.brain?.domain;
  let address;
  try { address=new URL(domain?.includes('://') ? domain : `https://${domain || ''}`); } catch { throw Error('A saved Brain HTTPS hostname is required.'); }
  if(address.protocol!=='https:' || address.username || address.password || address.port || address.pathname!=='/' || address.search || address.hash)
    throw Error('A saved Brain HTTPS hostname is required.');
  const adminKey=resolveAdminKey(manifestPath,{ignoreEnvironment:true});
  if(!adminKey) throw Error('No durable data-plane key is available for this manifest.');
  const response=await request(address.origin+'/api/bank-feed/custody',{
    method:'GET',redirect:'error',headers:{'X-Admin-Key':adminKey}}, {timeoutMs:30000,what:'read-only bank custody check'});
  if(!response?.ok) throw Error('Bank custody could not be checked. No repair was attempted.');
  const body=await response.json();
  if(body?.read_only!==true || !Array.isArray(body.connections) || ![0,2,3].includes(body.exit_code)) throw Error('Bank custody report could not be verified.');
  // Projection prevents an accidental future route change from printing custody bytes.
  const connections=body.connections.map((r,i)=>({connection:i+1,key_version:r.key_version,
    key_identity:String(r.key_identity || ''),key_fingerprint:/^[a-f0-9]{64}$/.test(r.key_fingerprint || '') ? r.key_fingerprint : null,
    opens:r.opens===true,last_good_sync:r.last_good_sync || null,cursor_saved:r.cursor_saved===true,
    cursor_fingerprint:/^[a-f0-9]{64}$/.test(r.cursor_fingerprint || '') ? r.cursor_fingerprint : null,
    code:r.code,detail:r.detail}));
  const result={read_only:true,connections,exit_code:body.exit_code};
  write(json ? JSON.stringify(result,null,2) : connections.map(r=>`Connection ${r.connection}: ${r.opens?'access opens':'needs attention'}; key version ${r.key_version}; ${r.key_identity}; fingerprint ${r.key_fingerprint || 'unavailable'}; last good sync ${r.last_good_sync || 'never'}; cursor ${r.cursor_saved?'saved':'absent'}${r.cursor_fingerprint ? ' ('+r.cursor_fingerprint+')':''}.\n${r.detail}`).join('\n') || 'No active bank connections.');
  return result;
}
