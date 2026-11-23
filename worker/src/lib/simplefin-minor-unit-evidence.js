import { FINANCIAL_CURRENCY_EXPONENTS as CURRENCY_EXPONENTS } from './financial-money.js';

export const SIMPLEFIN_EXACT_MINOR_MARK = '~simplefin-exact-minor-v1';
const threeDecimals = Object.keys(CURRENCY_EXPONENTS)
  .filter(currency => CURRENCY_EXPONENTS[currency] === 3).map(currency => "'" + currency + "'").join(',');

const feed = "t.provenance='feed' AND t.account_slug GLOB 'simplefin-*' AND t.source_feed GLOB 'bank-feed:*'";
const transactionFeed = `t.source_provider='simplefin' OR (${feed})`;

// No timestamp proves which decoder ran. Only the same write that read the
// provider decimal can vouch for the stored minor units.
function selectUnconfirmed(table, kind, day, provider) {
  return `SELECT '${kind}' AS kind, t.currency AS currency,
      COALESCE(NULLIF(a.mask,''),'last four unknown') AS account, MIN(t.${day}) AS first_day,
      MAX(t.${day}) AS last_day, COUNT(*) AS row_count
    FROM ${table} t LEFT JOIN main.fin_accounts a ON a.tenant_id=t.tenant_id
      AND a.account_slug=t.account_slug AND a.superseded_by_id IS NULL
    WHERE t.currency IN (${threeDecimals}) AND (${provider}) AND
      COALESCE(substr(t.source_locator,instr(t.source_locator,'#')-${SIMPLEFIN_EXACT_MINOR_MARK.length},${SIMPLEFIN_EXACT_MINOR_MARK.length + 1}),'') <> '${SIMPLEFIN_EXACT_MINOR_MARK}#'
    GROUP BY t.tenant_id,t.account_slug,t.currency,a.mask`;
}

// Use the same frozen input as the clean amounts. A promotion can briefly
// restore a superseded predecessor before it writes the new decoded amount.
export const SIMPLEFIN_MINOR_UNIT_SNAPSHOT_SQL = `SELECT 'simplefin_minor_units' AS snapshot_kind,
  json_object('kind',kind,'currency',currency,'account',account,'first_day',first_day,'last_day',last_day,'row_count',row_count) AS value,
  NULL AS value2 FROM (${selectUnconfirmed('fin_transactions','transactions','posted_on',transactionFeed)}
  ORDER BY kind,currency,account,first_day)`;

const missing = 'Re-read the affected dates and accounts from SimpleFIN and verify the posted amounts and balances against the provider records.';
export function describeSimpleFinMinorUnitGaps(rows) {
  return [
    ...rows.slice(0,20).map(row => ({
      reason: `SimpleFIN ${row.currency} ${row.kind} for account ending ${row.account} (${row.first_day || 'date unknown'} through ${row.last_day || 'date unknown'}, ${row.row_count} rows) are unconfirmed because the stored amounts lack proof of correct minor-unit conversion. The stored figures are provisional.`,
      missing,
    })),
    ...(rows.length > 20 ? [{reason:'Additional SimpleFIN three-decimal amounts are unconfirmed.',missing}] : []),
  ];
}

export const SIMPLEFIN_MINOR_UNIT_UNAVAILABLE = {
  reason:'The SimpleFIN minor-unit evidence could not be checked.',missing,
};

export function simpleFinMinorUnitEvidenceSql(balances = false) {
  const transactions = selectUnconfirmed('main.fin_transactions','transactions','posted_on',transactionFeed);
  // Balance recomputation can use transactions as well as stored observations.
  // This compound has exactly two arms regardless of the number of accounts.
  const input = balances ? `${transactions} UNION ALL ${selectUnconfirmed('main.fin_balance_snapshots','balance observations','as_of_date',feed)}`
    : transactions;
  return `SELECT json_group_array(json_object('kind',kind,'currency',currency,'account',account,
    'first_day',first_day,'last_day',last_day,'row_count',row_count))
    FROM (SELECT * FROM (${input}) ORDER BY kind,currency,account,first_day LIMIT 21)`;
}
