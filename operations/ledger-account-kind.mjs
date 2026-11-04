import { requestMaintenance } from './ledger-rekey.mjs';
import { renderCliCommands } from './cli-guidance.mjs';
import { reviewedAccountRole, validAccountKindSelector } from '../worker/src/lib/fin-account-kinds.js';

const USAGE = 'brain ledger account-kind <manifest> --account <mask|slug|id:number> --kind <kind> [--role asset|liability] | --revoke, with --preview | --apply --approve <hash>';
export function parseLedgerAccountKindArgs(argv) {
  const [action,manifestPath,...rest] = argv, flags = {};
  if (action !== 'account-kind' || !manifestPath || manifestPath.startsWith('-')) throw Error(USAGE);
  for (let i=0; i<rest.length; i++) {
    const flag = rest[i];
    if (!['--account','--kind','--role','--revoke','--preview','--apply','--approve'].includes(flag) || flag in flags) throw Error(USAGE);
    flags[flag] = ['--account','--kind','--role','--approve'].includes(flag) ? rest[++i] : true;
  }
  const revoke = !!flags['--revoke'];
  if (!validAccountKindSelector(flags['--account']) ||
      (flags['--preview'] === true) === (flags['--apply'] === true) ||
      (flags['--apply'] ? !/^[a-f0-9]{64}$/.test(flags['--approve'] || '') : flags['--approve'] !== undefined) ||
      (revoke && (flags['--kind'] !== undefined || flags['--role'] !== undefined))) throw Error(USAGE);
  const role = revoke ? undefined : reviewedAccountRole(flags['--kind'],flags['--role']);
  return { manifestPath, selector: flags['--account'], kind: flags['--kind'], role, revoke,
    dryRun: !!flags['--preview'], approve: flags['--approve'] };
}
export async function runLedgerAccountKind(args, deps) {
  const receipt = await requestMaintenance({ action: 'account-kind', account: args.selector, kind: args.kind,
    role: args.role, revoke: args.revoke, dry_run: args.dryRun, approve: args.approve }, deps);
  if (receipt?.selector !== args.selector || receipt.action !== (args.revoke ? 'revoke' : 'review') ||
      receipt.kind !== (args.revoke ? null : args.kind) || receipt.role !== (args.revoke ? null : args.role) ||
      receipt.dry_run !== args.dryRun || typeof receipt.blocked !== 'boolean' || typeof receipt.complete !== 'boolean' ||
      !Array.isArray(receipt.accounts) || receipt.accounts.length > 3 ||
      (!receipt.blocked && receipt.accounts.length !== 1) || receipt.accounts.some(a =>
        !Number.isSafeInteger(a?.account_id) || a.account_id < 1 || typeof a.account_slug !== 'string' ||
        !(a.mask === null || typeof a.mask === 'string') || typeof a.provider_kind !== 'string' ||
        !['asset','liability','neither'].includes(a.provider_role)) ||
      ![0,1].includes(receipt.mutation_count) || (args.dryRun && receipt.mutation_count !== 0) ||
      (!args.dryRun && (!receipt.complete || receipt.blocked)) || !/^[a-f0-9]{64}$/.test(receipt.plan_hash || '')) {
    throw Error('Invalid account review receipt. No completion is claimed.');
  }
  if (!args.dryRun && !args.revoke && (receipt.review?.state !== 'current' || receipt.review.kind !== args.kind ||
    receipt.review.role !== args.role || receipt.review.reviewer !== 'owner' || receipt.review.source !== 'owner_account_kind' ||
    receipt.review.revoked_at !== null || !Number.isFinite(Date.parse(receipt.review.reviewed_at)))) {
    throw Error('Invalid account review provenance. No completion is claimed.');
  }
  if (!args.dryRun && args.revoke && receipt.review !== null && (receipt.review?.state !== 'revoked' ||
    !Number.isFinite(Date.parse(receipt.review?.revoked_at)))) throw Error('Invalid account revocation provenance. No completion is claimed.');
  const write = deps.write ?? console.log;
  write(JSON.stringify(receipt));
  if (receipt.blocked) write('Account identity needs review. Select an exact account ID if masks repeat; revoke a stale review first.');
  else if (args.dryRun) write(renderCliCommands(`Review the masked account, provider values and proposed fact. Run brain ledger account-kind <manifest> --account ${args.selector}${args.revoke ? ' --revoke' : ` --kind ${args.kind} --role ${args.role}`} --apply --approve ${receipt.plan_hash}`));
  else write(args.revoke ? 'Account review revoked; history retained.' : 'Owner account classification verified.');
  return receipt;
}
