import { bankAccessWrappingKeyProof, decryptAccessReference } from './bank-feed.js';

export const custodyDigest = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(n=>n.toString(16).padStart(2,'0')).join('');
const CODES = new Set(['BANK_ACCESS_REFERENCE_UNREADABLE','BANK_ACCESS_LEGACY_KEY_UNAVAILABLE',
  'BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE','BANK_ACCESS_WRAPPING_KEY_INVALID','BANK_ACCESS_WRAPPING_KEY_VERSION_UNSUPPORTED']);

/** Never return plaintext, a key-derived legacy fingerprint, ciphertext or IV. */
export async function inspectBankCustody(env, item) {
  let code='BANK_ACCESS_READABLE', opens=false;
  try {
    await decryptAccessReference(env,{ciphertext:item.access_ciphertext,iv:item.access_iv,keyVersion:item.key_version});
    opens=true;
  } catch (error) { code=CODES.has(error?.code) ? error.code : 'BANK_ACCESS_CHECK_UNAVAILABLE'; }
  const proof=Number(item.key_version)===2 ? await bankAccessWrappingKeyProof(env) : null;
  return {connection_ref:item.item_ref,key_version:item.key_version,opens,code,
    key_identity:Number(item.key_version)===2 ? 'current dedicated bank wrapping key' : Number(item.key_version)===1 ?
      (env.SESSION_SIGNING_KEY ? 'current legacy signing-key selection; stored-key identity unavailable' : 'current legacy admin fallback; stored-key identity unavailable') :
      'unsupported wrapping-key version; identity unavailable',
    key_fingerprint:proof?.key_fingerprint || null,
    last_good_sync:item.last_synced_at || null,
    cursor_saved:Boolean(item.cursor),cursor_fingerprint:item.cursor ? await custodyDigest(item.cursor) : null,
    reference_fingerprint:await custodyDigest([item.tenant_id,item.item_ref,item.environment,item.access_ciphertext,item.access_iv,item.key_version]),
    detail:opens ? 'Saved access opens. A successful fetch is still needed to verify current activity.' :
      code==='BANK_ACCESS_REFERENCE_UNREADABLE' ? 'Needs reconnect. Saved access cannot be opened. History is kept; review replacement before signing in.' :
      'The key configuration or diagnostic needs review before replacement. Saved history remains available.'};
}

export async function bankCustodyReport(env) {
  const tenant=String(env.BANK_FEED_TENANT || 'primary');
  const rows=(await env.DB.prepare(`SELECT tenant_id,item_ref,environment,key_version,access_ciphertext,access_iv,
    last_synced_at,cursor FROM bank_feed_items WHERE tenant_id=? AND removed_at IS NULL ORDER BY id`).bind(tenant).all()).results;
  const connections=[];
  for(const row of rows) connections.push(await inspectBankCustody(env,row));
  return {read_only:true,connections,exit_code:connections.some(r=>!r.opens && r.code!=='BANK_ACCESS_REFERENCE_UNREADABLE') ? 3 :
    connections.some(r=>!r.opens) ? 2 : 0,
    detail:'Last good sync is an observation, not proof of complete history. No keys, connection state or financial records were changed.'};
}
