/** Non-secret identity contract shared by local setup and protected custody. */
export function ownerAppError(code) {
  const messages = {
    quickbooks_owner_app_required: 'QuickBooks needs an owner-bound private app. Start with the paired local companion; never put keys in chat or the manifest.',
    quickbooks_companion_required: 'The reviewed QuickBooks companion is unavailable. Setup is paused before browser or credential work.',
    quickbooks_transfer_unavailable: 'Secure browser transfer is unavailable. Keep keys out of chat and resume after the reviewed companion is installed.',
    quickbooks_finalization_outcome_unknown: 'The saved connection could not confirm completion. Retry setup to acknowledge it, or choose --reconnect for fresh consent if the prior setup expired.',
    quickbooks_finalization_unverified: 'The local grant was saved, but completion was not confirmed. Resume this setup to retry only its acknowledgement.',
    quickbooks_revocation_uncertain: 'QuickBooks access removal is not confirmed. Reads remain paused; keep the local keys for recovery.',
    quickbooks_disconnect_confirmation_required: 'Preview QuickBooks disconnect with --plan, then approve it with --confirm. Imported records will remain.',
  };
  return Object.assign(new Error(messages[code] || 'QuickBooks owner setup needs attention. No new connection was confirmed.'), { code });
}

export function quickBooksProductionRedirect(origin) {
  let url;
  try { url = new URL(origin); } catch { throw ownerAppError('quickbooks_origin_invalid'); }
  // URL parsers normalize ports, case, escapes and whitespace. Never accept
  // their normalized spelling as proof of the bytes registered at Intuit.
  if (typeof origin !== 'string' || url.protocol !== 'https:' || url.origin !== origin ||
      url.username || url.password || url.port || !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.hostname.endsWith('.') || !url.hostname.includes('.')) {
    throw ownerAppError('quickbooks_origin_invalid');
  }
  return `${origin}/api/oauth/quickbooks/callback`;
}

export function validateQuickBooksOwnerBinding(value) {
  const keys = ['schema_version', 'installation_id', 'app_id', 'brain_origin', 'redirect_uri', 'environment', 'source', 'company_fingerprint'];
  if (!value || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schema_version !== 1 || keys.slice(1).some((key) => typeof value[key] !== 'string') || value.environment !== 'production' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(value.installation_id) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.app_id) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.source) ||
      !/^[a-f0-9]{64}$/.test(value.company_fingerprint)) {
    throw ownerAppError('quickbooks_owner_binding_invalid');
  }
  if (value.redirect_uri !== quickBooksProductionRedirect(value.brain_origin)) {
    throw ownerAppError('quickbooks_redirect_mismatch');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function sameQuickBooksOwnerBinding(left, right) {
  return JSON.stringify(validateQuickBooksOwnerBinding(left)) === JSON.stringify(validateQuickBooksOwnerBinding(right));
}
