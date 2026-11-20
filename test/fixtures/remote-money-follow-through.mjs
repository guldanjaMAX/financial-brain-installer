import { assertOwnerEvidence } from '../helpers/owner-evidence-contract.mjs';
import assert from 'node:assert/strict';
import { handleMcp } from '../../worker/src/lib/mcp-endpoint.js';
import { moneyQuestionHandoff } from '../../worker/src/lib/money-handoff.js';
import { fixtureMoneyMeasures } from './money-measure-oracle.mjs';
import { queryMoney } from '../../worker/src/lib/money-query.js';

// Compare the requested clean measure with independent fixture membership.
// Raw transport parity remains a separate, additional control.
export async function sameLedgerFigure(f, request = {}) {
  const measures = request.measures || fixtureMoneyMeasures(f, request);
  assert.ok(measures.length, 'a nonempty question-specific measure plan exists');
  for (const measure of measures) {
    const before = f.calls.length;
    const clean = await queryMoney(f.env, { sql: measure.sql }, { now: () => Date.parse('2026-10-12T12:00:00.000Z') });
    assert.ok(f.calls.length > before, 'clean measure reached real SQLite');
    assert.ok(Array.isArray(clean.rows), 'clean tool returned rows, not an unavailable reading');
    assert.deepEqual(clean.rows.map(row => ({ ...row })), measure.expected, 'clean tool figure matches the independent spending/ranking/refund oracle');
    if (measure.cardRuleDifference) {
      assert.ok(Number.isSafeInteger(measure.cardRuleDifference.humanMinor));
      assert.notDeepEqual(measure.expected, [{ gross_minor: measure.cardRuleDifference.humanMinor }], 'the card-rule difference is populated');
      assert.match(JSON.stringify(clean), /may be a card payment/);
      assert.ok(clean.confidence.percent <= measure.cardRuleDifference.cap, 'unproved payment respects its computed confidence cap');
    }
  }
  const sql = "SELECT substr(posted_on,1,7) AS month, direction, SUM(amount_minor) AS total FROM fin_transactions WHERE pending=0 AND removed_at IS NULL AND superseded_by_id IS NULL GROUP BY substr(posted_on,1,7), direction ORDER BY month, direction";
  const expected = f.rows(sql).map(row => ({ ...row }));
  const result = await queryMoney(f.env, { sql }, { now: () => Date.parse('2026-10-12T12:00:00.000Z') });
  assert.deepEqual(result.rows.map(row => ({ ...row })), expected, 'money query preserves independent period/direction figures on the same fixture');
  assert.ok(result.confidence && Number.isFinite(result.confidence.percent));
  return result;
}

export async function remoteMoneyFollowThrough(question, reader) {
  const url = new URL('https://brain.invalid/mcp');
  const call = async q => {
    const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: q } },
    }) }), url, { grant: { profile: 'read-only' }, think: args => {
      assert.equal(args.q, q, 'the document control retains its exact request');
      return reader(args);
    } });
    assert.equal(response.status, 200);
    const rpc = await response.json();
    assert.equal(rpc.id, 1);
    assert.equal(rpc.result.isError, undefined);
    return rpc;
  };
  if (!moneyQuestionHandoff(question)) return call(question);
  let calls = 0;
  const handoff = await remoteMoneyFollowThroughCall(question, () => { calls++; assert.fail('money handoff cannot read documents or bank rows'); });
  assert.equal(calls, 0, 'money routing decision reached before the injected reader');
  const text = handoff.result.content.map(item => item.text).join('\n');
  for (const name of ['brain_money_overview', 'brain_money_guide', 'brain_money_query']) assert.ok(text.includes(name));
  const routed = moneyQuestionHandoff(question);
  assert.equal(routed.confidence.percent, 0, 'routing cannot invent bank evidence');
  assertOwnerEvidence(text, routed.confidence);
  const limited = moneyQuestionHandoff(question, { moneyToolsAvailable: false, requiredAgentProfile: 'technician' });
  assert.equal(limited.money_tools_available, false);
  assert.equal(limited.required_agent_profile, 'technician');
  assert.deepEqual(limited.results, []);
  assert.deepEqual(limited.citations, []);
  assert.doesNotMatch(limited.answer, /\$\d|owner-assistant/);
  // Presentation assertions keep the original reader facts through this
  // document control. The money reply above contains routing guidance only.
  return call('What do the policy documents say?');
}

async function remoteMoneyFollowThroughCall(question, reader) {
  const url = new URL('https://brain.invalid/mcp');
  const response = await handleMcp({}, new Request(url, { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question } },
  }) }), url, { grant: { profile: 'read-only' }, think: reader });
  assert.equal(response.status, 200);
  return response.json();
}
