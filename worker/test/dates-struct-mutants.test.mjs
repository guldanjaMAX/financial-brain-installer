import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('restored refusal paths and scope loss each turn a real SQLite test red', t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dates-struct-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['worker/src', 'migrations/d1']) cpSync(join(root, path), join(dir, path), { recursive: true });
  cpSync(join(root, 'worker/test'), join(dir, 'worker/test'), { recursive: true });
  copyFileSync(join(root, 'package.json'), join(dir, 'package.json'));
  const env = Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'HOME', 'TMPDIR', 'BRAIN_NO_WRANGLER_LOGIN', 'BRAIN_LAUNCHCTL', 'NODE_OPTIONS'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, 'worker/test/dates-struct.test.mjs')],
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1000000 });
  const control = run();
  assert.equal(control.status, 0, `isolated control: ${control.stdout} ${control.stderr}`);
  for (const [name, file, from, to] of [
    ['R1 deposit payer loss', 'ledger-activity-reading.js', 'const payer = intent.descriptionKeyword || intent.counterpartyText;', 'const payer = null;'],
    ['R1 payment payer loss', 'ledger-activity-reading.js', 'const payer = intent.descriptionKeyword || intent.counterpartyText;', 'const payer = intent.descriptionKeyword;'],
    ['R2 pending direction loss', 'ledger-activity-reading.js', "if (pending && intent.direction && intent.direction !== 'both')", 'if (false)'],
    ['R3 future open horizon loss', 'ledger-intent.js', 'const future = start > today;', 'const future = false;'],
    ['open-range refusal', 'ledger-intent.js', "if (open && !new RegExp", "if (open) return { invalid: true };\n  if (open && !new RegExp"],
    ['future refusal', 'ledger-intent.js', 'const next = text.match(', 'if (/\\bnext month\\b/.test(text)) return { invalid: true };\n  const next = text.match('],
    ['projection payment membership', 'ledger-activity-reading.js', ' && !loanCardPaymentKind(r, bySlug)', ''],
    ['projection vendor loss', 'ledger-activity-reading.js', 'if (intent.match) rows =', 'if (false) rows ='],
    ['projection direction loss', 'ledger-activity-reading.js', "intent.direction === 'both' || r.direction === intent.direction", 'r.direction === intent.direction'],
    ['checking verb', 'ledger-intent.js', "const accountType = /", "if (/checking something/i.test(scopeClause)) return fallbackDecision('capability');\n    const accountType = /"],
    ['personal-only loss', 'ledger-intent.js', "const bothRoles = misspelledRoleComparison || /\\bpersonal\\b/i.test(scopeText) && /\\bbusiness\\b/i.test(scopeText);", 'const bothRoles = false;'],
    ['single model role loss', 'ledger-intent.js', 'if (raw.intents.length === 1 && (misspelledRoleComparison || /\\b(?:personal (?:vs|versus|and) business|business (?:vs|versus|and) personal)\\b/i.test(clause)) &&', 'if (false &&'],
    ['vendor refusal', 'ledger-intent.js', "if (vendorRanking) kind = 'expense_summary';", "if (vendorRanking) return fallbackDecision('capability');"],
    ['pending refusal', 'ledger-intent.js', "if (kind === 'transactions' && /\\bpending\\b/i.test(clause)) intent.pendingActivity = true;", "if (kind === 'transactions' && /\\bpending\\b/i.test(clause)) return fallbackDecision('capability');"],
    ['loan refusal', 'ledger-answer.js', 'return Response.json(await activityReading(env, intent, accounts, inventory, ownerTime.day));', "if (intent.loanPaymentSubject) return Response.json({answer:'Please clarify'});\n          return Response.json(await activityReading(env, intent, accounts, inventory, ownerTime.day));"],
  ]) {
    const path = join(dir, 'worker/src/lib', file), original = readFileSync(path, 'utf8');
    assert.ok(original.includes(from), `${name} applied`);
    try {
      writeFileSync(path, original.replace(from, to));
      const result = run();
      assert.equal(result.status, 1, `${name}: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, /ERR_ASSERTION|AssertionError|TypeError/);
      assert.doesNotMatch(result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      t.diagnostic(`${name}: killed`);
    } finally { writeFileSync(path, original); }
  }
});
