// Read receipts are request-local. Inventory, attempted reads and failed reads
// cannot establish coverage; a successful empty read can.

export function moneyCoverage(accounts, rows, { from = null, to = null, missing = [] } = {}) {
  const entries = accounts.map(a => {
    const dates = rows.filter(r => r.effective_account_slug === a.account_slug &&
      (!from || r.posted_on >= from) && (!to || r.posted_on <= to))
      .map(r => r.posted_on).filter(Boolean).sort();
    return { account_mask: a.mask, label: a.label, side: a.entity_kind === 'business' ? 'business' : 'personal',
      kind: a.account_kind, feed: a.source_feed, first_on: dates[0] || null, last_on: dates.at(-1) || null,
      last_sync_at: a.last_synced_at || null, rows: dates.length };
  });
  const lastSync = entries.map(a => a.last_sync_at?.slice(0, 10)).filter(Boolean).sort()[0];
  return { accounts: entries, missing, partial_through: lastSync && to && lastSync < to ? lastSync : null };
}

export function moneyCoverageLine(coverage) {
  const dates = coverage.accounts.map(a => `account ending ${a.account_mask || 'unknown'}: ${a.rows} rows` +
    (a.first_on ? `, ${a.first_on} to ${a.last_on}` : ', no dated rows') +
    (a.last_sync_at ? `, last sync ${a.last_sync_at}` : ', last sync unknown')).join('; ');
  return `Coverage: ${coverage.accounts.length} connected accounts${coverage.partial_through ? `, through ${coverage.partial_through}` : ''}. ` +
    (dates ? dates + '. ' : 'No account reads verified. ') +
    (coverage.missing.length ? 'These figures are partial: ' + coverage.missing.join(' ') : 'Only rows read from these accounts are included.');
}
