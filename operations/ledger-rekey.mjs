import { fetchBrainWithAdminKey } from '../components/brain-http.mjs';
import { renderCliCommands } from './cli-guidance.mjs';

const USAGE = 'brain ledger rekey <manifest> --account <account> --preview | --apply --approve <hash>';

/** Parsed arguments and injected IO keep maintenance outside control-plane login. */
export function parseLedgerRekeyArgs(argv) {
  const [action, manifestPath, ...rest] = argv;
  const flags = {};
  if (action !== 'rekey' || !manifestPath || manifestPath.startsWith('-')) throw new Error(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!['--account', '--preview', '--apply', '--approve'].includes(flag) || flag in flags) throw new Error(USAGE);
    flags[flag] = ['--account', '--approve'].includes(flag) ? rest[++i] : true;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(flags['--account'] || '') ||
      (flags['--preview'] === true) === (flags['--apply'] === true) ||
      (flags['--apply'] ? !/^[a-f0-9]{64}$/.test(flags['--approve'] || '') : flags['--approve'] !== undefined)) throw new Error(USAGE);
  return { manifestPath, accountSlug: flags['--account'], dryRun: !!flags['--preview'], approve: flags['--approve'] };
}

export async function runLedgerRekey(args, { manifest, credential, fetchImpl = fetch, write = console.log }) {
  const saved = manifest?.brain?.domain;
  if (typeof saved !== 'string' || !saved) throw new Error('A saved HTTPS Brain address is required for ledger recovery.');
  const base = new URL(saved.includes('://') ? saved : `https://${saved}`);
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('A saved HTTPS Brain address is required for ledger recovery.');
  }
  const response = await fetchBrainWithAdminKey(fetchImpl, new URL('/api/admin/fin/import-bank-export', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rekey', account_slug: args.accountSlug, dry_run: args.dryRun, approve: args.approve }),
  }, credential);
  const receipt = await response.json();
  if (!response.ok) throw new Error(receipt?.reason || 'Ledger recovery could not be verified. Preview again before applying.');
  if (typeof receipt?.complete !== 'boolean' || typeof receipt.blocked !== 'boolean' ||
      !Number.isSafeInteger(receipt.candidate_count) || receipt.candidate_count < 0 || receipt.candidate_count > 2000 ||
      !Number.isSafeInteger(receipt.mutation_count) || receipt.mutation_count < 0 ||
      receipt.mutation_count > receipt.candidate_count || receipt.dry_run !== args.dryRun ||
      !/^[a-f0-9]{64}$/.test(receipt.plan_hash || '')) throw new Error('Invalid ledger recovery receipt. No completion is claimed.');
  write(JSON.stringify(receipt));
  if (receipt.blocked) write('Ambiguous identities require a separately reviewed owner plan. Imports remain blocked; no rows changed.');
  else if (args.dryRun && receipt.candidate_count) write(renderCliCommands(`Review this page, then run brain ledger rekey <manifest> --account <account> --apply --approve ${receipt.plan_hash}`));
  else if (!receipt.complete) write(renderCliCommands('This page was verified. Imports remain blocked. Run brain ledger rekey <manifest> --account <account> --preview for the next page.'));
  else write('Identity recovery is complete. The bank export can be retried.');
  return receipt;
}
