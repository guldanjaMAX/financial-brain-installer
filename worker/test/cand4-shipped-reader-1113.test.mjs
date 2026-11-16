import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdAsk } from '../../brain.mjs';
import worker from '../src/index.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { mintSessionCookie } from '../src/lib/sessions.js';
import { storePasskey, sessionGeneration } from '../src/lib/auth-store.js';
import { fixture as moneyFixture } from './helpers/clean-money-fixture.mjs';

function setup(t) {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.put = (id, cents, { date = '2026-10-05', direction = 'outflow', payee = 'Service Unit',
    description = 'Service charge', category = 'GENERAL_SERVICES' } = {}) => {
    f.add(id, description, payee, { date, direction, cents });
    f.raw('UPDATE fin_transactions SET category=?,category_basis_state=? WHERE txn_uid=?', category, 'confirmed', id);
  };
  f.account = (slug, kind, mask, amount = null) => {
    f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,'manual','owner_stated','confirmed',?)`, slug, kind, 'liability', mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    if (amount !== null) f.raw(`INSERT INTO fin_balance_snapshots(account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, slug, amount, NOW);
  };
  return f;
}

async function humanHeaders(f, surface) {
  if (surface === 'admin') return { 'X-Admin-Key': f.env.ADMIN_KEY };
  const credentialId = randomBytes(24).toString('hex');
  await storePasskey(f.env, { credentialId, jwk: {}, alg: -7, signCount: 0, nickname: 'Fixture device' });
  const cookie = (await mintSessionCookie(f.env, await sessionGeneration(f.env), { credentialId })).split(';')[0];
  return { Cookie: cookie, 'X-Brain-App': '1' };
}

async function read(f, question, headers) {
  const before = f.calls.length;
  const response = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ q: question }),
  }), f.env, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(f.calls.slice(before).some(sql => /fin_accounts/.test(sql)), 'real account decision reached');
  assert.ok(body.ledger, 'populated ledger reached the human response');
  assert.equal(body.money_handoff, undefined);
  assert.ok(body.answer.trim());
  assert.doesNotMatch(body.answer, /\bI (?:cannot|can't|am unable)|\bwithheld\b/i);
  assert.equal(body.confidence.percent, 0, 'unassessed compatibility reader never claims High');
  assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.equal(body.answer_contract.kind, 'ledger');
  assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  return body;
}

for (const surface of ['admin', 'session']) {
  test(`${surface}: shipped spending excludes bank-coded card and owned-loan payments`, async t => {
    const f = setup(t), headers = await humanHeaders(f, surface);
    f.put('service', 164331);
    assert.equal((await read(f, 'How much did I spend in October 2026?', headers)).ledger.total_minor, 164331, 'ordinary green control');
    f.account('loan', 'loan', '2222');
    f.put('card-payment', 2500, { payee: 'Card Unit', description: 'Card payment', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
    f.put('loan-payment', 70318, { payee: null, description: 'TRANSFER TO LOAN ACCOUNT 2222', category: 'LOAN_PAYMENTS' });
    const body = await read(f, 'How much did I spend in October 2026?', headers);
    assert.equal(body.ledger.total_minor, 164331);
    assert.equal(body.ledger.payment_exclusions.total_minor, 72818);
    assert.equal(body.ledger.payment_exclusions.count, 2);
    assert.match(body.answer, /1,643\.31/);
  });

  for (const c of [
    { q: 'rent', control: 'Show spending on rent this month', category: 'rent', kind: 'category', total: 125000 },
    { q: 'Landlord LLC this year', control: 'How much did I pay to Landlord LLC in October 2026?', payee: 'Landlord LLC', kind: 'merchant', total: 125000 },
    { q: 'payroll in Q3', control: 'Show spending on payroll in Q3', category: 'payroll', date: '2026-08-05', kind: 'category', total: 125000 },
    { q: 'card owed', control: 'What are my card balances?', balance: true, kind: 'balance', total: 32109 },
    { q: 'deposits this week', control: 'Show deposits this week', direction: 'inflow', date: '2026-10-12', kind: 'deposits', total: 125000 },
  ]) test(`${surface}: shorthand ${c.q} reaches matching ledger rows`, async t => {
    const f = setup(t), headers = await humanHeaders(f, surface);
    f.put('matching', c.total, c);
    if (c.balance) f.account('card', 'card', '3333', c.total);
    const amount = body => c.balance ? body.ledger.accounts.find(a => a.account_mask === '3333')?.current_minor
      : c.kind === 'deposits' ? body.ledger.rows.reduce((sum, row) => sum + row.amount_minor, 0) : body.ledger.total_minor;
    const green = await read(f, c.control, headers);
    assert.equal(amount(green), c.total, 'fully worded green control reaches the same figure');
    const body = await read(f, c.q, headers);
    assert.equal(body.ledger.kind, c.kind);
    assert.equal(amount(body), c.total);
    if (!c.balance) assert.ok(body.citations.some(ref => ref.amount_minor === c.total), 'matching amount has real posting evidence');
    if (c.q === 'payroll in Q3') assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-07-01', '2026-09-30']);
    if (c.q === 'Landlord LLC this year') assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-01-01', '2026-10-12']);
    if (c.q === 'deposits this week') assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-10-12', '2026-10-12']);
  });
}

test('assistant clean-money counting retains candidate treatment of unproved bank-coded debits', async t => {
  const f = moneyFixture(t); f.account('bank');
  f.row('service', 'bank', 164331, { direction: 'outflow', category: 'GENERAL_SERVICES' });
  assert.equal((await f.query('SELECT SUM(expense_minor) n FROM txn'))[0].n, 164331, 'ordinary green control');
  f.row('card-payment', 'bank', 2500, { direction: 'outflow', memo: 'Card payment', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Card Unit' });
  const rows = await f.query('SELECT * FROM txn ORDER BY id');
  assert.equal(rows.length, 2, 'both postings reached clean classification');
  assert.equal(rows.reduce((sum, row) => sum + row.expense_minor, 0), 166831);
  assert.equal(rows[1].estimated, 1);
  assert.equal(rows[1].uncertain_kind, 'card_payment');
});

test('document tasks with money nouns retain document retrieval beside a matching-ledger control', async t => {
  const f = setup(t); f.put('rent', 125000, { category: 'rent' });
  const options = { env: f.env, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner' };
  const green = await withLedgerAnswer({ ...options, question: 'Show spending on rent this month' }, () => assert.fail('green document fallback'));
  assert.equal((await green.json()).ledger.total_minor, 125000);
  for (const question of ['Find the rent clause in the lease', 'Explain the payroll policy in Q3', 'Find the Landlord LLC agreement this year', 'Define card owed', 'Explain deposits this week in the handbook']) {
    let fallbacks = 0;
    const response = await withLedgerAnswer({ ...options, question }, () => { fallbacks++; return Response.json({ documentTask: true }); });
    assert.equal(fallbacks, 1, 'document routing decision reached with a populated ledger');
    assert.equal((await response.json()).documentTask, true);
  }
});

test('known balances survive a different selected account without an observation', async t => {
  const f = setup(t); f.put('ordinary', 100);
  f.raw("UPDATE fin_balance_snapshots SET current_minor=54321 WHERE account_slug='fixture-account'");
  f.account('loan', 'loan', '2222');
  const body = await read(f, 'What are my account balances?', await humanHeaders(f, 'admin'));
  assert.equal(body.ledger.accounts.find(a => a.account_mask === '1234')?.current_minor, 54321);
  assert.ok(body.confidence.missing.some(reason => /2222.*no recorded balance/.test(reason)));
});

test('brain ask renders the shipped figure from the real Worker with fixture-only authority', async t => {
  assert.equal(process.env.BRAIN_NO_WRANGLER_LOGIN, '1', 'CLI test requires credential isolation');
  const f = setup(t); f.put('service', 164331);
  const root = mkdtempSync(join(process.env.HOME, 'shipped-reader-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyPath = join(root, '.brain-admin-key'), manifest = join(root, 'brain.manifest.json');
  writeFileSync(keyPath, f.env.ADMIN_KEY, { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' } }));
  let requests = 0;
  const invoke = async () => {
    const lines = [], original = console.log;
    try {
      console.log = (...parts) => lines.push(parts.join(' '));
      await cmdAsk(manifest, {
        ask: async () => 'How much did I spend in October 2026?',
        adminKey: readFileSync(keyPath, 'utf8'),
        launchctl: () => assert.fail('scheduler forbidden'),
        http: async (url, options) => {
          requests++;
          assert.equal(new URL(url).hostname, 'fixture.invalid');
          return worker.fetch(new Request(url, options), f.env, { waitUntil() {} });
        },
      });
    } finally { console.log = original; }
    return lines.join('\n');
  };
  assert.match(await invoke(), /1,643\.31/, 'ordinary CLI green control');
  f.put('card-payment', 2500, { description: 'Card payment', category: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', payee: 'Card Unit' });
  const text = await invoke();
  assert.equal(requests, 2, 'both CLI requests reached the actual authenticated Worker');
  assert.match(text, /1,643\.31/);
  assert.doesNotMatch(text, /1,668\.31/);
  assert.match(text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.match(text, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
});

test('shorthand admission retains owner, filter and entity boundaries with matching rows', async t => {
  const f = setup(t); f.put('rent', 125000, { category: 'rent' });
  const options = { env: f.env, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner', question: 'rent' };
  const green = await withLedgerAnswer(options, () => assert.fail('green document fallback'));
  assert.equal((await green.json()).ledger.total_minor, 125000);
  for (const restriction of [{ access: { id: 'limited' } }, { grantScope: { all: false } },
    { scopePrincipalKind: 'agent' }, { filters: { source: 'records' } }, { entityScope: { applied: true } }]) {
    let fallbacks = 0;
    const response = await withLedgerAnswer({ ...options, ...restriction }, () => { fallbacks++; return Response.json({ restricted: true }); });
    assert.equal(fallbacks, 1, 'restriction decision reached beside a populated owner green control');
    assert.equal((await response.json()).restricted, true);
  }
});

test('SR-01: invoice lists retain the real document callback beside annual payee controls', async t => {
  const f = setup(t);
  f.put('rent', 125000, { payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
  const options = { env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner' };
  for (const question of ['Vendor LLC this year', 'How much did I pay to Vendor LLC so far this year?']) {
    const body = await (await withLedgerAnswer({ ...options, question }, () => assert.fail('money control fell back'))).json();
    assert.equal(body.ledger.total_minor, 125000);
    assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-01-01', '2026-10-12']);
  }
  for (const question of ['List invoices from Vendor LLC this year', 'Please list invoices from Vendor LLC this year',
    'Show Vendor LLC invoices this year', 'Summarize Vendor LLC this year', 'List Vendor LLC this year']) {
    let calls = 0;
    const response = await withLedgerAnswer({ ...options, question }, () => {
      calls++;
      return Response.json({ answer: 'One matching invoice: $1,250.00.', documentTask: true });
    });
    assert.equal(calls, 1, 'populated routing boundary invoked document callback exactly once');
    assert.equal((await response.json()).documentTask, true);
  }
});

test('SR-01: an already structured annual money question retains its payee and measure', async t => {
  const f = setup(t), headers = await humanHeaders(f, 'admin');
  f.put('rent', 125000, { payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
  const control = await read(f, 'How much did I pay to Vendor LLC so far this year?', headers);
  assert.equal(control.ledger.total_minor, 125000);
  const body = await read(f, 'How much did I pay to Vendor LLC this year?', headers);
  assert.equal(body.ledger.total_minor, 125000);
  assert.deepEqual([body.ledger.from, body.ledger.to], [control.ledger.from, control.ledger.to]);
});

for (const surface of ['admin', 'session']) {
  test(`SR-01 ${surface}: authenticated invoice list retains the document answer contract`, async t => {
    const f = setup(t), headers = await humanHeaders(f, surface);
    f.put('rent', 125000, { payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
    for (const q of ['Vendor LLC this year', 'How much did I pay to Vendor LLC so far this year?']) {
      assert.equal((await read(f, q, headers)).ledger.total_minor, 125000, 'same-period money control');
    }
    const before = f.calls.length;
    const response = await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ q: 'List invoices from Vendor LLC this year' }),
    }), f.env, { waitUntil() {} });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.answer_contract, 'authenticated owner answer boundary reached');
    assert.equal(body.answer_contract.kind, 'document');
    assert.equal(body.ledger, undefined);
    assert.ok(f.calls.slice(before).some(sql => /chunks/.test(sql)), 'document retrieval decision reached');
  });

  for (const question of ['rent', 'Show spending on rent this month']) {
    test(`SR-02 ${surface}: ${question} retains an incomplete observed subtotal`, async t => {
      const f = setup(t), headers = await humanHeaders(f, surface);
      f.put('rent', 125000, { category: 'rent', date: '2026-10-10' });
      const full = await read(f, question, headers);
      assert.equal(full.ledger.total_minor, 125000, 'complete-coverage green control');
      f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-06',covered_to='2026-10-12'");
      const body = await read(f, question, headers);
      assert.equal(body.ledger.observed_subtotal_minor, 125000);
      assert.equal(body.ledger.total_minor, null, 'observations cannot certify a full-period total');
      assert.equal(body.ledger.complete, false);
      assert.equal(body.ledger.coverage.complete, false);
      assert.equal(body.evidence_gate.complete, false);
      assert.equal(body.evidence_gate.partial, true);
      assert.deepEqual(body.ledger.coverage.missing_periods, [{ account_mask: '1234', from: '2026-10-01', to: '2026-10-05' }]);
      assert.match(body.answer.split('\n')[0], /1,250\.00.*(?:incomplete|lower bound).*October/i);
      assert.match(body.answer, /1234.*October 6.*October 12/s);
      assert.match(body.answer, /(?:missing|uncovered).*1234.*October 1.*October 5/is);
      assert.match(body.answer, /statements.*1234.*October 1.*October 5/is);
      assert.ok(body.confidence.percent < 90);
      assert.ok(body.confidence.basis.some(reason => /October 1.*October 5/s.test(reason)));
      assert.ok(body.confidence.missing.some(reason => /1234.*October 1.*October 5/s.test(reason)));
      assert.ok(body.citations.some(ref => ref.amount_minor === 125000));
    });
  }

  test(`SR-02 ${surface}: incomplete zero outflows cannot certify a period zero`, async t => {
    const f = setup(t), headers = await humanHeaders(f, surface);
    f.put('rent', 125000, { category: 'rent', date: '2026-10-10' });
    assert.equal((await read(f, 'rent', headers)).ledger.total_minor, 125000, 'populated full-coverage control');
    // Keep the exact category known, with no matching outflows. An unknown
    // category is a different decision and must never certify category zero.
    f.put('rent-credit', 500, { category: 'rent', direction: 'inflow', date: '2026-10-10' });
    f.raw("DELETE FROM fin_transactions WHERE txn_uid='rent'");
    f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-06',covered_to='2026-10-12'");
    const body = await read(f, 'rent', headers);
    assert.equal(body.ledger.observed_subtotal_minor, 0);
    assert.equal(body.ledger.total_minor, null);
    assert.equal(body.ledger.complete, false);
    assert.equal(body.evidence_gate.complete, false);
    assert.match(body.answer, /full-period total or zero is not established/);
    assert.ok(body.confidence.percent < 90);
  });
}

test('SR-02: unreadable coverage dates do not erase a readable category posting', async t => {
  const f = setup(t), headers = await humanHeaders(f, 'admin');
  f.put('rent', 125000, { category: 'rent', date: '2026-10-10' });
  assert.equal((await read(f, 'rent', headers)).ledger.total_minor, 125000, 'populated covered control');
  f.raw("UPDATE fin_account_coverage SET covered_from=NULL,covered_to='2026-99-99'");
  const body = await read(f, 'rent', headers);
  assert.equal(body.ledger.observed_subtotal_minor, 125000);
  assert.deepEqual(body.ledger.coverage.missing_periods, [{ account_mask: '1234', from: '2026-10-01', to: '2026-10-12' }]);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false);
});

// Keep the reviewed requests verbatim. The readable document and the money
// controls prove that a fallback did not pass because either source was empty.
async function seedReadableDocument(f) {
  f.env.AI = { async run(model, input) {
    if (String(model).includes('bge-')) return { data: [[0.1, 0.2]] };
    if (JSON.stringify(input).includes('verify a proposed answer')) return {
      response: { supported: true, complete: true, evidence: [1], reason: 'record support' },
    };
    return { response: 'Vendor LLC record: the notice period is 45 days [1].' };
  } };
  f.raw("INSERT INTO sources(name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds) VALUES ('records','upload','ready',?,?,?,86400)", NOW, NOW, NOW);
  const response = await worker.fetch(new Request('https://fixture.invalid/api/admin/brain/ingest/batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
    body: JSON.stringify({ docs: [{ source_type: 'records', source_id: 'vendor-record', title: 'Vendor LLC record',
      content: 'Vendor LLC record: the notice period is 45 days.', occurred_at: '2026-10-10',
      date_source: 'fixture:recorded_at', date_reliable: true, text_source: 'native', text_reliable: true,
      metadata: { evidence_lineage: { version: 1, kind: 'source_record' } } }] }),
  }), f.env, { waitUntil() {} });
  assert.equal(response.status, 200, 'synthetic readable record stored');
}

async function tracedRead(f, surface, question, headers) {
  const before = f.calls.length;
  let callbacks = 0;
  const response = surface === 'routing' ? await withLedgerAnswer({ env: f.env, question,
    now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => {
      callbacks++;
      return Response.json({ answer: 'Vendor LLC record: the notice period is 45 days.', documentTask: true });
    }) : await worker.fetch(new Request('https://fixture.invalid/api/rag/think', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ q: question }),
    }), f.env, { waitUntil() {} });
  const body = await response.json(), calls = f.calls.slice(before);
  assert.equal(response.status, 200);
  assert.ok(body.answer?.trim(), 'answer boundary reached');
  return { body, callbacks, accounts: calls.filter(sql => /FROM fin_accounts a/.test(sql)).length,
    documents: calls.filter(sql => /chunks/.test(sql)).length };
}

for (const surface of ['routing', 'admin', 'session']) {
  test(`R3-01 ${surface}: prior-year payee shorthand retains the scoped absence observation`, async t => {
    const f = setup(t), headers = surface === 'routing' ? {} : await humanHeaders(f, surface);
    f.put('expense', 125000, { description: 'Monthly rent', payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
    const populated = await tracedRead(f, surface, 'Vendor LLC this year', headers);
    assert.ok(populated.accounts > 0, 'populated money decision reached');
    assert.equal(populated.body.ledger?.total_minor, 125000);
    assert.equal(populated.callbacks, 0);
    assert.equal(populated.documents, 0);

    // Change only the posting date. The authorized payee remains recorded and
    // January 1 through the anchored owner day is still completely covered.
    f.raw("UPDATE fin_transactions SET posted_on='2025-09-10'");
    const explicit = await tracedRead(f, surface, 'How much did I pay to Vendor LLC this year?', headers);
    assert.ok(explicit.accounts > 0, 'explicit same-period absence reader reached');
    assert.equal(explicit.body.ledger?.kind, 'merchant');
    assert.equal(explicit.body.ledger.coverage.complete, true);
    assert.equal(explicit.body.ledger.found, false);
    assert.equal(explicit.body.answer.split('\n')[0], 'No charges found for Vendor LLC from 2026-01-01 to 2026-10-12 on your account ending 1234.');

    const actual = await tracedRead(f, surface, 'Vendor LLC this year', headers);
    assert.ok(actual.accounts > 0 || actual.callbacks > 0 || actual.documents > 0, 'actual routing decision reached');
    if (surface !== 'routing') assert.ok(actual.body.answer_contract, 'authenticated owner finalization reached');
    assert.equal(actual.body.ledger?.kind, 'merchant', 'known payee absence remains a money reading');
    assert.ok(actual.accounts > 0, 'ordinary account reader reached');
    assert.equal(actual.callbacks, 0, 'no document callback for a recorded payee');
    assert.equal(actual.documents, 0, 'no document retrieval for a recorded payee');
    assert.deepEqual([actual.body.ledger.from, actual.body.ledger.to], ['2026-01-01', '2026-10-12']);
    assert.equal(actual.body.ledger.coverage.complete, true);
    assert.equal(actual.body.ledger.found, false);
    assert.equal(actual.body.ledger.total_minor, null, 'bounded absence is not numeric zero');
    assert.equal(actual.body.answer.split('\n')[0], 'No charges found for vendor llc from 2026-01-01 to 2026-10-12 on your account ending 1234.');
    if (surface !== 'routing') {
      assert.equal(actual.body.answer_contract.kind, 'ledger');
      assert.equal(actual.body.confidence.percent, 0, 'historical identity cannot raise money confidence');
      assert.match(actual.body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
      assert.match(actual.body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    }

    if (surface !== 'routing') await seedReadableDocument(f);
    for (const question of ['List invoices from Vendor LLC this year', 'Correspondence with Vendor LLC this year',
      'Messages from Vendor LLC this year', 'Purchase orders from Vendor LLC this year', 'E-mails from Vendor LLC this year']) {
      const document = await tracedRead(f, surface, question, headers);
      assert.ok(document.callbacks > 0 || document.documents > 0, 'document decision reached beside historical payee identity');
      assert.equal(document.body.ledger, undefined);
      assert.match(document.body.answer, /45 days/);
      if (surface === 'routing') assert.equal(document.callbacks, 1);
      else assert.equal(document.body.answer_contract.kind, 'document');
    }
  });
}

test('R3-01: historical identity uses the owner-day window independently of the asked month', async t => {
  const f = setup(t);
  f.put('expense', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const populated = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(populated.accounts > 0);
  assert.equal(populated.body.ledger.total_minor, 125000, 'in-period populated control');
  // A current-month label can identify last month's payee; its amount must
  // never enter last month's observation or certify a numeric zero.
  const actual = await tracedRead(f, 'routing', 'Vendor LLC last month', {});
  assert.ok(actual.accounts > 0, 'historical label and ordinary period readers reached');
  assert.equal(actual.callbacks, 0);
  assert.equal(actual.body.ledger.kind, 'merchant');
  assert.deepEqual([actual.body.ledger.from, actual.body.ledger.to], ['2026-09-01', '2026-09-30']);
  assert.equal(actual.body.ledger.coverage.complete, true);
  assert.equal(actual.body.ledger.found, false);
  assert.equal(actual.body.ledger.total_minor, null);
  assert.match(actual.body.answer.split('\n')[0], /^No charges found for vendor llc from 2026-09-01 to 2026-09-30/);
});

for (const [label, change] of [
  ['outside the historical bound', "UPDATE fin_transactions SET posted_on='2015-09-10'"],
  ['after the owner day', "UPDATE fin_transactions SET posted_on='2026-10-13'"],
  ['incoming rather than a payee outflow', "UPDATE fin_transactions SET direction='inflow'"],
  ['unconfirmed posting', "UPDATE fin_transactions SET basis_state='unparsed',unparsed_reason='fixture',amount_minor=NULL,direction=NULL"],
  ['pending posting', 'UPDATE fin_transactions SET pending=1'],
  ['removed posting', "UPDATE fin_transactions SET removed_at='2026-10-11T12:00:00.000Z',removal_reason='fixture'"],
  ['unowned entity', "UPDATE fin_entities SET relationship='counterparty'"],
  ['different tenant', "UPDATE fin_transactions SET tenant_id='other-tenant'"],
  ['different whole label', "UPDATE fin_transactions SET payee='Other Vendor LLC'"],
]) test(`R3-01: historical nomination excludes ${label}`, async t => {
  const f = setup(t);
  f.put('expense', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const populated = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(populated.accounts > 0);
  assert.equal(populated.body.ledger.total_minor, 125000, 'populated exact-payee control');
  f.raw("UPDATE fin_transactions SET posted_on='2025-09-10'");
  const historical = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(historical.accounts > 0, 'historical identity decision reached');
  assert.equal(historical.body.ledger?.kind, 'merchant', 'historical identity green control');
  f.raw(change);
  const actual = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(actual.accounts > 0, 'authorized account lookup reached before excluding the label');
  assert.equal(actual.callbacks, 1, 'document decision reached after label exclusion');
  assert.equal(actual.body.ledger, undefined);
});

test('R3-01: dense older history does not consume the successful in-period nomination budget', async t => {
  const f = setup(t);
  f.put('expense', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const populated = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(populated.accounts > 0);
  assert.equal(populated.body.ledger.total_minor, 125000, 'populated control before historical overflow');
  f.raw(`WITH RECURSIVE older(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM older WHERE n<5001)
    INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,payee,provenance,source_feed,basis_state,recorded_at)
    SELECT 'older-'||n,'fixture-account','2025-09-10',100,'outflow','Other Unit','feed','bank-feed:fixture-feed','confirmed',? FROM older`, NOW);
  assert.equal(f.first('SELECT count(*) n FROM fin_transactions').n, 5002, 'history exceeds the transaction read limit');
  const actual = await tracedRead(f, 'routing', 'Vendor LLC this year', {});
  assert.ok(actual.accounts > 0, 'ordinary populated reader reached with dense history');
  assert.equal(actual.callbacks, 0);
  assert.equal(actual.body.ledger.total_minor, 125000);
});

test('R3-01: failed historical lookup keeps documents with a visible gap', async t => {
  const f = setup(t);
  f.put('expense', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const options = { env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner', question: 'Vendor LLC this year' };
  assert.equal((await (await withLedgerAnswer(options, () => assert.fail('populated control fell back'))).json()).ledger.total_minor, 125000);
  f.raw("UPDATE fin_transactions SET posted_on='2025-09-10'");
  assert.equal((await (await withLedgerAnswer(options, () => assert.fail('historical control fell back'))).json()).ledger.found, false);
  const prepare = f.env.DB.prepare;
  let lookups = 0, documents = 0;
  t.mock.method(f.env.DB, 'prepare', sql => {
    if (/FROM json_each\(\?1\) m CROSS JOIN fin_transactions/.test(sql) && ++lookups === 2) throw new Error('fixture history read failure');
    return prepare(sql);
  });
  const response = await withLedgerAnswer(options, gap => {
    documents++;
    return Response.json({ answer: 'The readable record states a 45-day notice period.', gaps: gap ? [gap] : [] });
  });
  const body = await response.json();
  assert.equal(lookups, 2, 'in-period lookup reached followed by the failing historical lookup');
  assert.equal(documents, 1, 'document decision still reached');
  assert.match(body.answer, /45-day/);
  assert.equal(body.gaps[0]?.reason, 'ledger_unavailable');
});

for (const surface of ['routing', 'admin', 'session']) {
  for (const question of ['Correspondence with Vendor LLC this year', 'Messages from Vendor LLC this year',
    'Purchase orders from Vendor LLC this year', 'E-mails from Vendor LLC this year',
    'List invoices from Vendor LLC this year']) {
    test(`R2-01 ${surface}: ${question} reads the document`, async t => {
      const f = setup(t), headers = surface === 'routing' ? {} : await humanHeaders(f, surface);
      f.put('rent', 125000, { payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
      if (surface !== 'routing') await seedReadableDocument(f);
      for (const q of ['Vendor LLC this year', 'How much did I pay to Vendor LLC so far this year?']) {
        const green = await tracedRead(f, surface, q, headers);
        assert.ok(green.accounts > 0, 'populated money decision reached');
        assert.equal(green.body.ledger?.total_minor, 125000);
      }
      const verifyDocument = actual => {
        assert.ok(actual.callbacks > 0 || actual.documents > 0 || actual.accounts > 0, 'actual routing decision reached');
        if (surface === 'routing') assert.equal(actual.callbacks, 1, 'document callback invoked exactly once');
        else {
          assert.ok(actual.documents > 0, 'readable document retrieval decision reached');
          assert.equal(actual.body.answer_contract.kind, 'document');
          assert.match(actual.body.confidence_text, /Confidence: (?:High|Medium|Low) \(\d+%\)/);
        }
        assert.equal(actual.body.ledger, undefined);
        assert.match(actual.body.answer, /45 days/);
      };
      verifyDocument(await tracedRead(f, surface, 'Find the Vendor LLC record this year', headers));
      verifyDocument(await tracedRead(f, surface, question, headers));
    });
  }

  for (const partial of [false, true]) {
    test(`R2-02 ${surface}: structured spending retains ${partial ? 'incomplete observations' : 'the full figure'}`, async t => {
      const f = setup(t), headers = surface === 'routing' ? {} : await humanHeaders(f, surface);
      f.put('rent', 125000, { payee: 'Vendor LLC', category: 'rent', date: '2026-10-10' });
      const green = await tracedRead(f, surface, 'How much did I pay to Vendor LLC in October 2026?', headers);
      assert.ok(green.accounts > 0, 'fully covered populated control reaches account decision');
      assert.equal(green.body.ledger?.total_minor, 125000);
      if (partial) f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-06',covered_to='2026-10-12'");
      const actual = await tracedRead(f, surface, 'What did I spend at Vendor LLC this year?', headers);
      assert.ok(actual.accounts > 0 || actual.callbacks > 0 || actual.documents > 0, 'actual routing decision reached');
      const body = actual.body;
      assert.equal(body.ledger?.[partial ? 'observed_subtotal_minor' : 'total_minor'], 125000, 'supported spending survives');
      assert.ok(actual.accounts > 0, 'merchant reader decision reached');
      assert.equal(body.ledger.kind, 'merchant');
      assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-01-01', '2026-10-12']);
      assert.ok(body.citations.some(ref => ref.amount_minor === 125000), 'posting citation retained');
      assert.match(body.answer.split('\n')[0], /1,250\.00/);
      assert.doesNotMatch(body.answer, /\b(?:withheld|I cannot|I can't|No ledger figure is shown)\b/i);
      if (partial) {
        assert.equal(body.ledger.total_minor, null);
        assert.equal(body.ledger.complete, false);
        assert.deepEqual(body.ledger.coverage.missing_periods, [{ account_mask: '1234', from: '2026-01-01', to: '2026-10-05' }]);
        assert.match(body.answer.split('\n')[0], /observed subtotal \(incomplete lower bound\)/);
        assert.match(body.answer, /1234.*October 6.*October 12/s);
        assert.match(body.answer, /Missing dates:.*1234.*January 1.*October 5/s);
        assert.match(body.answer, /Original statements.*1234.*January 1.*October 5/s);
        assert.match(body.answer, /1 contributing, 0 fully covered, 1 account with missing dates/);
      }
      if (surface !== 'routing') {
        assert.equal(body.answer_contract.kind, 'ledger');
        assert.equal(body.confidence.percent, 0, 'compatibility confidence ceiling unchanged');
        assert.match(body.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
        assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
        if (partial) {
          assert.ok(body.confidence.basis.some(reason => /January 1.*October 5/s.test(reason)));
          assert.ok(body.confidence.missing.some(reason => /1234.*January 1.*October 5/s.test(reason)));
        }
      }
    });
  }
}

test('R2-01: company grammar requires the entire recorded label, never a suffix or substring', () => {
  const context = { now: Date.parse(NOW), timeZone: 'UTC', payeeLabels: ['Vendor LLC'] };
  assert.equal(classifyLedgerQuestion('Vendor LLC this year', context).kind, 'merchant');
  assert.equal(classifyLedgerQuestion('Vendor LLC this year', { ...context, payeeLabels: [] }).kind, null);
  for (const question of ['Correspondence with Vendor LLC this year', 'Messages from Vendor LLC this year',
    'Purchase orders from Vendor LLC this year', 'E-mails from Vendor LLC this year',
    'List invoices from Vendor LLC this year', 'Vendor LLC this year excluding rent']) {
    assert.equal(classifyLedgerQuestion(question, context).kind, null, question);
  }
});

for (const surface of ['routing', 'admin', 'session']) {
  test(`R2-01 ${surface}: whole recorded company labels support bare and calendar variants`, async t => {
    const f = setup(t), headers = surface === 'routing' ? {} : await humanHeaders(f, surface);
    // A multiword label proves that admission is not a word-count heuristic.
    f.put('vendor', 125000, { payee: 'Vendor Services Group LLC', date: '2026-10-10' });
    const green = await tracedRead(f, surface, 'How much did I pay to Vendor Services Group LLC this month?', headers);
    assert.ok(green.accounts > 0);
    assert.equal(green.body.ledger.total_minor, 125000);
    for (const q of ['Vendor Services Group LLC', 'vendor services group llc this month', 'VENDOR SERVICES GROUP LLC this year?']) {
      const actual = await tracedRead(f, surface, q, headers);
      assert.ok(actual.accounts > 0, 'exact payee allowlist and monetary decision reached');
      assert.equal(actual.callbacks, 0);
      assert.equal(actual.body.ledger.total_minor, 125000);
      assert.match(actual.body.answer, /Read as recorded spending for that exact payee/);
    }
    // A readable payee with request-like words is still a literal when all
    // of those words belong to its recorded label, with no extra framing.
    f.put('label', 75000, { payee: 'Messages from Unit LLC', date: '2026-10-10' });
    const literal = await tracedRead(f, surface, 'Messages from Unit LLC this year', headers);
    assert.ok(literal.accounts > 0);
    assert.equal(literal.body.ledger.total_minor, 75000);
  });
}

test('R2-01: failed company-label lookup preserves documents with a visible read gap', async t => {
  const f = setup(t);
  f.put('vendor', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const options = { env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner', question: 'Vendor LLC this year' };
  const green = await withLedgerAnswer(options, () => assert.fail('populated company control fell back'));
  assert.equal((await green.json()).ledger.total_minor, 125000);
  const prepare = f.env.DB.prepare;
  let lookups = 0, documents = 0;
  t.mock.method(f.env.DB, 'prepare', sql => {
    if (/FROM json_each\(\?1\) m CROSS JOIN fin_transactions/.test(sql)) {
      lookups++;
      throw new Error('fixture label read failure');
    }
    return prepare(sql);
  });
  const response = await withLedgerAnswer(options, gap => {
    documents++;
    return Response.json({ answer: 'The readable record states a 45-day notice period.', gaps: gap ? [gap] : [] });
  });
  const body = await response.json();
  assert.equal(lookups, 1, 'failing nomination decision reached');
  assert.equal(documents, 1, 'ordinary document decision still reached');
  assert.match(body.answer, /45-day/);
  assert.equal(body.gaps[0]?.reason, 'ledger_unavailable', 'lookup failure is recoverable, not silently discarded');
});

test('R2-01: company allowlist lookup retains owner, scope, filter and calendar guards', async t => {
  const f = setup(t);
  f.put('vendor', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  const options = { env: f.env, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner', question: 'Vendor LLC this year' };
  assert.equal((await (await withLedgerAnswer(options, () => assert.fail('populated control fell back'))).json()).ledger.total_minor, 125000);
  for (const restriction of [{ access: { id: 'limited' } }, { grantScope: { all: false } },
    { scopePrincipalKind: 'agent' }, { filters: { source: 'records' } }, { entityScope: { applied: true } },
    { ledgerEligible: false }, { env: { ...f.env, BRAIN_TIMEZONE: 'Invalid/Zone' } }]) {
    const before = f.calls.length;
    let documents = 0;
    const response = await withLedgerAnswer({ ...options, ...restriction }, () => {
      documents++;
      return Response.json({ answer: 'The readable record remains available.' });
    });
    assert.equal(documents, 1, 'restricted routing decision reached');
    assert.equal((await response.json()).ledger, undefined);
    assert.equal(f.calls.slice(before).filter(sql => /FROM fin_accounts a/.test(sql)).length, 0, 'no company lookup before authority and calendar admission');
  }
});

test('R2-02: structured spending includes readable rows from both complete and partial accounts', async t => {
  const f = setup(t), headers = await humanHeaders(f, 'admin');
  f.put('vendor', 125000, { payee: 'Vendor LLC', date: '2026-10-10' });
  f.account('peer', 'checking', '5678');
  f.raw("UPDATE fin_accounts SET balance_role='asset' WHERE account_slug='peer'");
  f.put('peer-charge', 75000, { payee: 'Vendor LLC', date: '2026-10-02' });
  f.raw("UPDATE fin_transactions SET account_slug='peer',provenance='owner_stated',source_feed=NULL WHERE txn_uid='peer-charge'");
  const question = 'What did I spend at Vendor LLC this year?';
  assert.equal((await read(f, question, headers)).ledger.total_minor, 200000, 'populated two-account full-coverage control');
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-06',covered_to='2026-10-12' WHERE account_slug='fixture-account'");
  const body = await read(f, question, headers);
  assert.equal(body.ledger.observed_subtotal_minor, 200000);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false);
  assert.deepEqual(body.ledger.coverage.missing_periods, [{ account_mask: '1234', from: '2026-01-01', to: '2026-10-05' }]);
  for (const amount of [125000, 75000]) assert.ok(body.citations.some(ref => ref.amount_minor === amount));
  assert.match(body.answer, /2 contributing, 1 fully covered, 1 account with missing dates/);
});
