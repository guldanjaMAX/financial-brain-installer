import { fetchBrainWithAdminKey } from '../components/brain-http.mjs';
import { renderCliCommands } from './cli-guidance.mjs';

const ERRORS = {
  content_dates_d1_required: 'Content-date repair requires the D1 document store. Ask your installer to review storage before continuing.',
  content_dates_approval_required: 'Preview the page, then apply with its exact approval hash.',
  content_dates_stale: 'This content-date approval is stale. Preview the same cursor again before applying.',
  content_dates_blocked: 'This page contains a document over 500 chunks. Ask your installer to review it. No page changes were made.',
  content_dates_queue_budget: 'The vector queue exceeds the queue budget, or this page would exceed it. Wait for indexing to finish, then preview again. Use a smaller page if needed.',
  content_dates_unavailable: 'Content-date repair could not be verified. Ask your installer to check the database upgrade, then preview again.',
};
const USAGE = 'brain content refresh-dates <manifest> --preview [--limit N] [--cursor C] | --apply --approve <hash> [--cursor C] [--queue-budget N]';
export function parseContentRefreshDatesArgs(argv) {
  const [action, manifestPath, ...rest] = argv, flags = {};
  if (action !== 'refresh-dates' || !manifestPath || manifestPath.startsWith('-')) throw new Error(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!['--preview', '--apply', '--approve', '--limit', '--cursor', '--queue-budget'].includes(flag) || flag in flags) throw new Error(USAGE);
    flags[flag] = ['--preview', '--apply'].includes(flag) ? true : rest[++i];
    if (flags[flag] === undefined) throw new Error(USAGE);
  }
  const integer = (value, min, max) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  if ((flags['--preview'] === true) === (flags['--apply'] === true) ||
      (flags['--apply'] ? !/^[a-f0-9]{64}$/.test(flags['--approve'] || '') : flags['--approve'] !== undefined) ||
      (flags['--limit'] !== undefined && (!flags['--preview'] || !integer(flags['--limit'], 1, 10))) ||
      (flags['--cursor'] !== undefined && !integer(flags['--cursor'], 0, Number.MAX_SAFE_INTEGER)) ||
      (flags['--queue-budget'] !== undefined && !integer(flags['--queue-budget'], 0, 10000))) throw new Error(USAGE);
  return { manifestPath, dryRun: !!flags['--preview'], approve: flags['--approve'],
    limit: flags['--limit'] === undefined ? undefined : Number(flags['--limit']), cursor: flags['--cursor'] ?? '0',
    queueBudget: Number(flags['--queue-budget'] ?? 500) };
}

export async function runContentRefreshDates(args, { manifest, credential, fetchImpl = fetch, write = console.log }) {
  const saved = manifest?.brain?.domain;
  if (typeof saved !== 'string' || !saved) throw new Error('A saved HTTPS Brain address is required for content-date repair.');
  const base = new URL(saved.includes('://') ? saved : `https://${saved}`);
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('A saved HTTPS Brain address is required for content-date repair.');
  }
  let response, receipt;
  try {
    response = await fetchBrainWithAdminKey(fetchImpl, new URL('/api/admin/brain/content/refresh-dates', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: args.dryRun,
        approve: args.approve, cursor: args.cursor, limit: args.limit, queue_budget: args.queueBudget }),
    }, credential);
    receipt = await response.json();
  } catch {
    // JSON parser and transport errors can quote private reply bytes or URLs.
    // A lost response also cannot establish whether the transaction committed.
    throw new Error('Content-date repair could not be verified. Check access, then retry the same request or preview again.');
  }
  if (!response.ok) throw new Error(Object.hasOwn(ERRORS, receipt?.code) ? ERRORS[receipt.code] :
    'Content-date repair could not be verified. Preview again before applying.');
  const count = (key, max) => Number.isSafeInteger(receipt?.[key]) && receipt[key] >= 0 && receipt[key] <= max;
  if (receipt?.dry_run !== args.dryRun || typeof receipt.complete !== 'boolean' || typeof receipt.replayed !== 'boolean' ||
      !count('documents', 10) || !count('planned', receipt.documents) || !count('updated', receipt.planned) ||
      !count('chunks', receipt.planned * 500) || !count('chunks_requeued', receipt.chunks) ||
      !count('blocked_documents', receipt.documents) || !count('queue_depth', Number.MAX_SAFE_INTEGER) ||
      !count('limit', 10) || receipt.limit < 1 || receipt.documents > receipt.limit ||
      !count('cursor', Number.MAX_SAFE_INTEGER) || receipt.cursor < Number(args.cursor) || receipt.next_cursor !== String(receipt.cursor) ||
      !/^[a-f0-9]{64}$/.test(receipt.plan_hash || '') ||
      (args.dryRun && (receipt.updated !== 0 || receipt.chunks_requeued !== 0 || receipt.replayed || receipt.limit !== (args.limit ?? 10))) ||
      (!args.dryRun && (receipt.plan_hash !== args.approve || receipt.blocked_documents !== 0 ||
        receipt.updated !== (receipt.replayed ? 0 : receipt.planned) || receipt.chunks_requeued !== (receipt.replayed ? 0 : receipt.chunks))) ||
      (receipt.blocked_documents > 0 && (receipt.complete || receipt.cursor !== Number(args.cursor)))) {
    throw new Error('Invalid content-date repair receipt. No completion is claimed.');
  }
  // Project the closed count receipt; an unexpected server field cannot print
  // a document title, text, identifier or raw diagnostic into operator output.
  const safe = Object.fromEntries(['dry_run', 'documents', 'planned', 'chunks', 'blocked_documents', 'queue_depth',
    'plan_hash', 'limit', 'cursor', 'next_cursor', 'complete', 'updated', 'chunks_requeued', 'replayed'].map(k => [k, receipt[k]]));
  write(JSON.stringify(safe));
  if (receipt.blocked_documents) write('This page has a document over 500 chunks. Ask your installer to review it. The cursor has not advanced.');
  else if (args.dryRun) write(renderCliCommands(`Review the counts, then run brain content refresh-dates <manifest> --apply --approve ${receipt.plan_hash} --cursor ${args.cursor} --queue-budget ${args.queueBudget}`));
  else {
    write(receipt.replayed ? 'This page was already applied. No additional changes were made.' : 'This page was repaired and its search updates were queued.');
    if (receipt.complete) write('The approved walk reached its end. Wait for the vector queue to empty before checking meaning search.');
    else write(renderCliCommands(`Preview the next page with brain content refresh-dates <manifest> --preview --limit ${receipt.limit} --cursor ${receipt.next_cursor}`));
  }
  return safe;
}
