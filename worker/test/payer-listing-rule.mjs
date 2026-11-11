import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
const source = readFileSync(url, 'utf8');
const needle = 'activity.filter(row => row.direction === intent.direction)';
assert.equal(source.split(needle).length, 2);
// Match the money-in outside_inflow_minor predicate exactly, including its
// account-kind and reciprocal-evidence guards. Keep unproved credits visible.
const changed = source.replace(needle, `activity.filter(row => row.direction === intent.direction &&
  !(intent.direction === "inflow" && pairs.some(pair => pair.in.id === row.id &&
    selected.has(pair.in.effective_account_slug) && inWindow(pair.in) &&
    [pair.out, pair.in].every(leg => bySlug.get(leg.effective_account_slug).account_kind !== "other") &&
    isDirectedOwnedTransfer(pair, bySlug))))`);
const absolute = changed.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_, q, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
export const trial = (await import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`)).withLedgerAnswer;
