/** Non-secret unattended destination contract. Never resolves a credential or account. */
export function quickBooksScheduleBinding(m, platform) {
  // Match resolveBaseUrl's domain-first branch, including its exact base URL.
  // The workers.dev fallback needs a control-plane lookup. An unattended task
  // cannot establish that origin, so it requires an explicit domain to run.
  const base = m?.brain?.domain ? `https://${m.brain.domain}` : null;
  let origin = null;
  if (base) {
    try {
      const url = new URL(base);
      if (url.protocol === 'https:' && !url.username && !url.password) origin = url.origin;
    } catch { /* invalid destinations leave the plan unready */ }
  }
  const reference = m?.operations?.admin_key_secret;
  return Object.freeze({
    version: 1,
    data_plane: { base_url: base, origin },
    // D1 identity alone does not bind where the CLI's fallback would send data.
    worker_fallback: { account_id: m?.infrastructure?.cloudflare?.account_id || null,
      worker_name: m?.brain?.worker_name || `${m?.client?.slug || 'client'}-brain` },
    credential: reference ? { backend: 'keychain', locator: reference }
      : { backend: platform === 'win32' ? 'dpapi-current-user' : 'file',
        // Both native contracts also hash the absolute manifest path, so this
        // locator binds its adjacent key without depending on a host path parser.
        locator: { relative_to: 'manifest_directory', name: '.brain-admin-key' } },
  });
}

export function quickBooksScheduleRegistrationRequired() {
  return Object.assign(new Error('QuickBooks schedule changed after registration. Re-register the schedule before it may read credentials or run sources.'), {
    code: 'SCHEDULE_RUN_FAILED', reason: 'QB_SCHEDULE_REREGISTER_REQUIRED',
  });
}
