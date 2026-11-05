import './fixtures/net-refund/guards.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execute } from './fixtures/net-refund/execute.mjs';
import { blocked } from './fixtures/net-refund/guards.mjs';
import { cases, recount } from './fixtures/net-refund/cases.mjs';
import { extended } from './fixtures/net-refund/extended-cases.mjs';

const parts = body => body.ledger?.parts || (body.ledger ? [body.ledger] : []);
const grossPeer = c => ({ ...c, id: c.id + '_gross_peer', grossRequest: true,
  question: c.question.replace(/net of refunds|after refunds|once refunds are netted out/gi, 'before refunds (gross)') });

// The requested-field oracle recounts fixture membership with BigInt cents.
// Product gross amounts stay valid only when their refund limitation is clear.
function inspect(c, body) {
  const count = recount(c), ledger = parts(body), answer = body.answer || '';
  const qualifier = /Refunds have not been subtracted because|before subtracting refunds/i.test(answer);
  const leads = [...answer.matchAll(/(?:You (?:spent|received)|Income from that payer is at least) \$([\d,]+\.\d{2})/g)]
    .map(m => Math.round(Number(m[1].replaceAll(',', '')) * 100));
  const wrong = [];
  const amounts = c.twoPeriods ? [count.gross, count.priorGross] : [c.inflow ? 2000 : count.gross];
  const net = c.twoPeriods ? [count.net, count.priorNet] : [count.net];
  for (let i = 0; i < ledger.length; i++) {
    if (Number.isSafeInteger(ledger[i].total_minor) && ledger[i].total_minor !== amounts[i]) wrong.push(`structured_${i}`);
    if (leads[i] !== undefined && leads[i] !== amounts[i]) wrong.push(`prose_${i}`);
  }
  if (c.inflow && ledger[0]?.attributed_subtotal_minor !== 2000) wrong.push('inflow_subtotal');
  const requestedNet = !c.grossRequest && !c.terminal;
  const unqualifiedGrossClaims = requestedNet && !qualifier ? leads.filter((n, i) => n === amounts[i]).length : 0;
  if (requestedNet && !c.inflow && !qualifier) {
    for (let i = 0; i < leads.length; i++) if (leads[i] === amounts[i] && leads[i] !== net[i]) wrong.push(`net_${i}`);
  }
  if (requestedNet && body.ledger?.comparison) {
    const comparison = body.ledger.comparison;
    comparison.figures_minor.forEach((n, i) => { if (n !== net[i]) wrong.push(`comparison_${i}`); });
    if (comparison.difference_minor !== net[0] - net[1]) wrong.push('comparison_difference');
  }
  return { reached: ledger.length > 0 && leads.length > 0, unqualifiedGrossClaims, wrong };
}

function witness(c, o) {
  assert.equal(o.trace.model, 1, 'recorded model decision reached');
  assert.equal(o.trace.validation, 1);
  if (c.terminal === 'router') {
    assert.equal(o.plan.outcome, 'fallback');
    assert.equal(o.trace.document, 1);
    assert.equal(o.trace.inventory, 0);
  } else {
    assert.ok(o.plan.intents.length > 0, 'nonempty validated plan');
    assert.ok(o.trace.inventory > 0, 'account decision reached');
    if (c.terminal === 'currency') {
      assert.equal(o.body.ledger, null);
      assert.equal(o.body.code, c.mixedCurrency ? 'unsupported_currency' : 'unreadable_transactions');
      assert.equal(o.trace.transactions, c.mixedCurrency ? 0 : 1);
    } else {
      assert.ok(o.trace.transactions > 0, 'transaction read reached');
      assert.ok(o.body.citations.length > 0, 'recorded facts carry citations');
      assert.equal(o.trace.document, 0);
      assert.equal(o.trace.render, 1);
    }
    const offers = o.body.answer.match(/Want[^?\n]*\?/g) || [];
    assert.equal(offers.length, 1, 'one offer follows the facts');
    assert.ok(o.body.answer.endsWith(offers[0]));
  }
  assert.deepEqual(blocked, [], 'no external or credential path reached');
}

test('netted-refunds wording cannot assert gross as net, with a reached gross control', async () => {
  const c = cases.find(c => c.id === 'refunds_netted');
  const gross = await execute(grossPeer(c));
  witness(grossPeer(c), gross);
  assert.equal(gross.body.ledger.total_minor, 12000);
  assert.equal(gross.body.ledger.complete, true);
  assert.equal(inspect(grossPeer(c), gross.body).wrong.length, 0);
  assert.equal(gross.body.ledger.net_refunds_unavailable, undefined);
  const net = await execute(c);
  witness(c, net);
  const judgment = inspect(c, net.body);
  assert.equal(judgment.reached, true);
  assert.equal(recount(c).net, 10000);
  assert.equal(judgment.unqualifiedGrossClaims, 0, 'gross must not be asserted as net');
  assert.equal(net.body.ledger.net_refunds_unavailable, true);
  assert.equal(net.body.ledger.amount_basis, 'gross_before_refunds');
  assert.equal(net.body.evidence_gate.complete, false);
  assert.equal(net.body.evidence_gate.partial, true);
  assert.equal(net.body.evidence_gate.reason,
    'question needs clarification; net of refunds unavailable; gross recorded amounts only');
});

test('28-case matrix has zero wrong monetary claims and keeps all 22 gross peers', async t => {
  const results = [], peers = [];
  let withheld = 0;
  for (const c of cases) {
    const o = await execute(c);
    witness(c, o);
    const score = inspect(c, o.body);
    results.push({ id: c.id, wrong: score.wrong });
    if (c.expectedGross !== undefined) {
      assert.equal(recount(c).gross, c.expectedGross);
      assert.equal(recount(c).net, c.expectedNet);
      assert.equal(o.body.ledger.total_minor, c.expectedGross);
    }
    if (c.terminal) continue;
    assert.equal(score.reached, true, c.id + ': monetary decision inspected');
    const peerCase = grossPeer(c), gross = await execute(peerCase);
    witness(peerCase, gross);
    assert.equal(inspect(peerCase, gross.body).wrong.length, 0, c.id + ': gross peer amounts');
    assert.ok(parts(gross.body).every(p => !p.net_refunds_unavailable));
    peers.push(gross.body);
    if (c.ownTransfer) {
      assert.equal(o.body.ledger.excluded_own_movement_minor, 3000);
      assert.equal(o.body.ledger.default_exclusions.own_transfer_pairs, 1);
    }
    if (!c.grossRequest && !c.inflow && parts(o.body).every(p => p.net_expense_minor === undefined)) withheld++;
  }
  const wrong = results.reduce((sum, r) => sum + r.wrong.length, 0);
  t.diagnostic(JSON.stringify({ cases: results.length, wrong, grossPeers: peers.length, withheld,
    grossDigest: createHash('sha256').update(JSON.stringify(peers)).digest('hex'),
    wrongSlots: results.filter(r => r.wrong.length) }));
  assert.equal(cases.length, 28);
  assert.equal(peers.length, 22);
  assert.equal(withheld, 19, 'unproven refund linkage stays unavailable');
  assert.equal(wrong, 0, 'zero wrong monetary claims');
});

test('unavailable net figures cannot certify a two-period difference', async () => {
  const c = cases.find(c => c.twoPeriods);
  const gross = await execute(grossPeer(c));
  witness(grossPeer(c), gross);
  assert.deepEqual(gross.body.ledger.comparison, { figures_minor: [12000, 9000], difference_minor: 3000 });
  const net = await execute(c);
  witness(c, net);
  assert.equal(net.trace.transactions, 2);
  assert.deepEqual(parts(net.body).map(p => p.total_minor), [12000, 9000]);
  assert.equal(net.body.ledger.comparison, undefined, 'unavailable net totals cannot be compared');
  assert.ok(parts(net.body).every(p => p.net_refunds_unavailable && p.amount_basis === 'gross_before_refunds'));
  assert.ok(parts(net.body).every(p => p.complete), 'gross row coverage remains complete');
  assert.equal(net.body.evidence_gate.complete, false);
});

for (const c of extended) test('supplemental refund control: ' + c.id, async () => {
  const o = await execute(c);
  witness(c, o);
  const ps = parts(o.body);
  if (c.mixed) {
    assert.equal(ps.length, 2);
    assert.deepEqual(ps.map(p => p.total_minor), [12000, 9000]);
    const grossIndex = c.reverse ? 0 : 1, netIndex = 1 - grossIndex;
    assert.equal(o.plan.intents[grossIndex].refundsNotNetted, undefined, 'explicit gross field stays independently answerable');
    assert.equal(ps[grossIndex].net_refunds_unavailable, undefined);
    assert.equal(ps[grossIndex].complete, true);
    assert.equal(ps[netIndex].net_refunds_unavailable, true);
    assert.equal(o.body.ledger.comparison, undefined);
  } else {
    assert.equal(ps[0].total_minor, recount(c).gross);
    if (c.family) {
      assert.equal(ps[0].match_basis, 'family');
      assert.equal(ps[0].family_match_count, 1);
    }
    assert.equal(ps[0].net_refunds_unavailable, true);
    const gross = await execute(grossPeer(c));
    witness(grossPeer(c), gross);
    assert.equal(gross.body.ledger.total_minor, recount(c).gross);
    assert.equal(gross.body.ledger.net_refunds_unavailable, undefined);
  }
});

test('restoring comparison arithmetic is detected on the real answer path', async () => {
  const url = new URL('../worker/src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const guard = ' && !part.net_refunds_unavailable';
  assert.equal(source.split(guard).length - 1, 1, 'one comparison guard to restore');
  const basisGuard = ': intent.netRefunds || intent.refundsNotNetted ? part.net_expense_minor ?? null';
  assert.equal(source.split(basisGuard).length - 1, 1, 'one requested-basis selector to restore');
  const restored = source.replace(guard, '').replace(basisGuard, '').replace(/from (["'])(\.[^"']+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  assert.notEqual(restored, source);
  const implementation = await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`);
  const c = cases.find(c => c.twoPeriods);
  const green = await execute(c);
  witness(c, green);
  assert.equal(inspect(c, green.body).wrong.length, 0);
  const mutant = await execute(c, implementation);
  witness(c, mutant);
  assert.equal(mutant.trace.transactions, 2, 'mutant reached both real period reads');
  assert.ok(parts(mutant.body).every(p => p.net_refunds_unavailable));
  const judgment = inspect(c, mutant.body);
  assert.equal(judgment.reached, true);
  assert.deepEqual(judgment.wrong, ['comparison_0', 'comparison_1', 'comparison_difference']);
  assert.throws(() => assert.equal(judgment.wrong.length, 0, 'restored wrong comparison must fail'),
    /restored wrong comparison must fail/);
  const gross = await execute(grossPeer(c), implementation);
  witness(grossPeer(c), gross);
  assert.equal(inspect(grossPeer(c), gross.body).wrong.length, 0, 'restored path keeps its green control');
});

test('amount and qualification mutations cannot pass the monetary oracle', async () => {
  const c = cases.find(c => c.id === 'refunds_netted');
  const o = await execute(c);
  witness(c, o);
  assert.equal(inspect(c, o.body).wrong.length, 0);
  const cents = structuredClone(o.body);
  cents.answer = cents.answer.replace('You spent $120.00', 'You spent $121.00');
  assert.notEqual(cents.answer, o.body.answer);
  assert.equal(cents.ledger.kind, o.body.ledger.kind);
  assert.ok(inspect(c, cents).reached);
  assert.deepEqual(inspect(c, cents).wrong, ['prose_0']);
  const qualifier = structuredClone(o.body);
  qualifier.answer = qualifier.answer.split('\n').filter(line =>
    !/before subtracting refunds|refunds have not been subtracted|cannot confirm spending after refunds/.test(line)).join('\n');
  assert.notEqual(qualifier.answer, o.body.answer);
  const judgment = inspect(c, qualifier);
  assert.ok(judgment.reached);
  assert.equal(judgment.unqualifiedGrossClaims, 1);
  assert.deepEqual(judgment.wrong, ['net_0']);
  assert.throws(() => assert.equal(judgment.unqualifiedGrossClaims, 0, 'gross must not be asserted as net'),
    /gross must not be asserted as net/);
});
