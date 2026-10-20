// Partner review (identifier lens). Made-up data only: every number below is
// synthetic and every address is a fixture placeholder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

const DAY = '2034-10-16';
const NOW = Date.parse('2034-10-20T00:00:00Z');
const FAKE_ACCOUNT = '000123456789';
const FAKE_ROUTING = '021000021';

function ownerMail(body, title = 'Address change') {
  const snippet = `[${title}] From: Record Owner <owner@example.invalid>\nTo: service@example.invalid\n` +
    `Date: ${DAY}\nSubject: ${title}\n\n${body}`;
  const results = [{ title, snippet }];
  const docs = [{ n: 1, ref: 'fixture-mail', source_kind: 'gmail', date_source: 'email_header', date_reliable: true, ts: DAY,
    text_source: 'native', text_reliable: true, lineage: { status: 'known', kind: 'source_record' }, authority: {} }];
  return { results, docs };
}
const ask = (question, body) => entityFactAnswer({ question, owner: 'Record Owner', now: NOW, ...ownerMail(body) });
// More than the last four digits of either made-up identifier.
const leaksIdentifier = text => /0001234|12345678|2100002|1000021/.test(String(text));

test('PR-K1 dated owner address answer echoes a full account and routing number unmasked', () => {
  const value = `12 Synthetic Road, Fixture City, AZ 85001. Account #${FAKE_ACCOUNT}, routing ${FAKE_ROUTING}`;
  const result = ask('What is my mailing address?', `My mailing address is ${value}.`);
  assert.equal(ask('What is my mailing address?', 'My mailing address is 12 Synthetic Road, Fixture City, AZ 85001.')?.method,
    'dated_owner_address', 'the same dated envelope reaches the fact decision');
  assert.equal(result, null, 'identifier-bearing values use the ordinary masked answer path');
});

test('PR-K1 control: plain dated owner address is answered and carries no identifier', () => {
  const result = ask('What is my mailing address?', 'My mailing address is 12 Synthetic Road, Fixture City, AZ 85001.');
  assert.ok(result, 'bounded fact answered');
  assert.equal(result.method, 'dated_owner_address');
  assert.match(result.answer, /12 Synthetic Road, Fixture City, AZ 85001/);
  assert.ok(!leaksIdentifier(result.answer));
});
