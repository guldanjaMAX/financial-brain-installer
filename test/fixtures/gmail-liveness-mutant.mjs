import { registerHooks } from 'node:module';

const mutations = {
  window_hold: ['if (!progressChecked) gmailMoreHistory = true;', 'if (!progressChecked) { gmailMoreHistory = true; gmailWindowPaused = true; }'],
  false_ready: ['if (!progressChecked) gmailMoreHistory = true;', 'void progressChecked;'],
  audit_first: null,
};
const name = process.env.BRAIN_GMAIL_LIVENESS_MUTANT;
if (!Object.hasOwn(mutations, name)) throw new Error('Unknown liveness mutation');
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/brain.mjs')) return result;
  const source = String(result.source);
  if (name === 'audit_first') {
    const start = source.indexOf('    // New mail gets the daily budget first.');
    const end = source.indexOf('    const currentGmailRemovalUids = new Set([', start);
    const insertion = source.indexOf('    if (window) {', source.indexOf('    let progressChecked = dry;'));
    if (insertion < 0 || start <= insertion || end <= start) throw new Error('Audit order mutation target missing');
    process.stderr.write(`MUTATION_APPLIED ${name}\n`);
    return { ...result, source: source.slice(0, insertion) + source.slice(start, end) +
      source.slice(insertion, start) + source.slice(end) };
  }
  const [target, replacement] = mutations[name];
  if (source.split(target).length !== 2) throw new Error('Liveness mutation target missing or ambiguous');
  process.stderr.write(`MUTATION_APPLIED ${name}\n`);
  return { ...result, source: source.replace(target, replacement) };
} });
