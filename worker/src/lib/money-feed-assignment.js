// Both providers use the same ledger feed prefix. SimpleFIN records its
// provider binding in simplefin_connections. Plaid accepts both its ordinary
// raw account ID and the public reference used by replacement.
function simplefinItem(assignment) {
  return `EXISTS(SELECT 1 FROM simplefin_connections sf
    WHERE sf.tenant_id=${assignment}.tenant_id AND sf.item_ref=${assignment}.item_ref)`;
}

function ledgerReference(assignment, simplefin) {
  // Legacy ledger accounts can lack a saved feed. Only the tenant-scoped public
  // reference can identify those accounts. A saved feed always binds the Item.
  return `(${simplefin ? '' : 'NOT '}${simplefinItem(assignment)}
    AND ((a.source_feed='bank-feed:'||${assignment}.item_ref
      AND (${assignment}.account_ref=a.external_ref${simplefin ? '' : ` OR ${assignment}.provider_account_id=a.external_ref`}))
      OR (a.source_feed IS NULL AND ${assignment}.account_ref=a.external_ref)))`;
}

export const PLAID_LEDGER_REFERENCE_SQL = ledgerReference('p', false);
export const SIMPLEFIN_LEDGER_REFERENCE_SQL = ledgerReference('s', true);
export const DISCOVERED_LEDGER_REFERENCE_SQL = `CASE WHEN p.is_plaid=1
  THEN ${PLAID_LEDGER_REFERENCE_SQL} ELSE ${ledgerReference('p', true)} END`;
export const DISCOVERED_PROVIDER_CONFLICT_SQL = `p.is_plaid = ${simplefinItem('p')}`;
export const MONEY_FEED_ASSIGNMENTS_SQL = `SELECT tenant_id,account_ref,item_ref,provider_account_id,1 AS is_plaid
  FROM plaid_account_entity_assignments
  UNION ALL SELECT tenant_id,account_ref,item_ref,NULL,0 FROM simplefin_account_assignments`;

export const ASSIGNED_MONEY_FEED_SQL = `b.tenant_id=a.tenant_id AND b.removed_at IS NULL AND b.environment='production'
  AND b.status='connected' AND a.feed_mode='live' AND a.status='open'
  AND (EXISTS(SELECT 1 FROM plaid_account_entity_assignments p WHERE p.tenant_id=a.tenant_id
    AND p.item_ref=b.item_ref AND p.entity_slug IS NOT NULL AND ${PLAID_LEDGER_REFERENCE_SQL})
  OR EXISTS(SELECT 1 FROM simplefin_account_assignments s WHERE s.tenant_id=a.tenant_id
    AND s.item_ref=b.item_ref AND s.entity_slug IS NOT NULL AND ${SIMPLEFIN_LEDGER_REFERENCE_SQL}))`;

export const ASSIGNED_MONEY_FEED_SYNC_SQL = `(SELECT MAX(b.last_synced_at) FROM bank_feed_items b WHERE ${ASSIGNED_MONEY_FEED_SQL})`;
