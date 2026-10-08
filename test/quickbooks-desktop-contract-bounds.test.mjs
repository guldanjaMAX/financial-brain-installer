import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QBD_CONTRACT, encodeQbdFrame, qbdPlan, qbdRequests, validateQbdResult,
} from '../operations/quickbooks-desktop-bridge.mjs';
import { fakeQbdFrames } from './fixtures/qbd-fake-helper.mjs';
import { checkQbdContract } from '../scripts/qbd-helper-il-check.mjs';

const clock = new Date('2026-10-07T12:00:00Z');
const tuple = { ListID: 'AA-12', TimeCreated: '2020-01-01T00:00:00-07:00' };
const link = { TxnID: 'DD-15', TxnType: 'Bill', Amount: '75.00' };
function exchange(operation, entity, rows) {
  const plan = qbdPlan({ operation, historySince: '2024-10-07T00:00:00Z' }, clock);
  const requests = qbdRequests(operation, plan);
  assert.ok(requests.length > 0);
  const frames = fakeQbdFrames(operation, plan);
  const target = frames.find((frame) => frame.entity === entity);
  assert.ok(target, 'the real planner selected the target request');
  frames.splice(frames.indexOf(target), 1, ...Array.from({ length: Math.max(1, Math.ceil(rows.length / 500)) }, (_, i) => (
    { ...target, rows: rows.slice(i * 500, (i + 1) * 500) }
  )));
  frames.at(-1).requests.find((receipt) => receipt.id === target.request).rowCount = rows.length;
  return validateQbdResult(Buffer.concat(frames.map((frame) => encodeQbdFrame(frame))), operation, plan);
}
function outputRows(result, entity) {
  assert.equal(result.ok, true);
  assert.equal(result.frames.at(-1).type, 'terminal');
  return result.frames.filter((frame) => frame.entity === entity).flatMap((frame) => frame.rows);
}

test('probe identity is a complete bounded account stream containing only the immutable tuple', () => {
  const result = exchange('probe', 'AccountRet', [{ ...tuple, Name: 'SENTINEL_LABEL', Balance: '12.34', CompanyFileName: 'SENTINEL_PATH' }]);
  assert.deepEqual(outputRows(result, 'AccountRet'), [tuple]);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
  const ids = Array.from({ length: 10000 }, (_, i) => ({ ...tuple, ListID: `AA-${i}` }));
  assert.equal(outputRows(exchange('probe', 'AccountRet', ids), 'AccountRet').length, 10000);
  const over = exchange('probe', 'AccountRet', [...ids, { ...tuple, ListID: 'AA-10000' }]);
  assert.equal(over.code, 'QB_PARTIAL_VIEW');
  assert.deepEqual(over.frames, []);
});

test('probe identity refuses empty, duplicate or incomplete tuples after selecting the account read', () => {
  assert.deepEqual(outputRows(exchange('probe', 'AccountRet', [tuple]), 'AccountRet'), [tuple]);
  for (const rows of [[], [tuple, tuple], [{ ListID: 'AA-12' }], [{ ...tuple, ListID: 'aa-12' }], [{ ...tuple, TimeCreated: '' }]]) {
    const result = exchange('probe', 'AccountRet', rows);
    assert.equal(result.code, 'QB_PARTIAL_VIEW');
    assert.deepEqual(result.frames, []);
  }
});

for (const entity of ['BillPaymentCheckRet', 'BillPaymentCreditCardRet']) {
  test(`${entity} preserves ordered repeated links while stripping nested private fields`, () => {
    const second = { ...link, TxnID: 'DE-16', Amount: '25.00' };
    const rows = [{ TxnID: 'AB-18', AppliedToTxnRet: [
      { ...link, SSN: 'SENTINEL_SSN', VendorTaxIdent: 'SENTINEL_EIN', BankNumber: 'SENTINEL_BANK',
        AccountNumber: 'SENTINEL_ACCOUNT', CreditCardInfo: { Number: 'SENTINEL_CARD' },
        Notes: 'SENTINEL_NOTES', Desc: 'SENTINEL_DESC', statusMessage: 'SENTINEL_PATH',
        Unknown: { TxnID: 'SENTINEL_NESTED' } }, second,
    ] }];
    const result = exchange('snapshot', entity, rows);
    assert.deepEqual(outputRows(result, entity), [{ TxnID: 'AB-18', AppliedToTxnRet: [link, second] }]);
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
    const full = Array.from({ length: 500 }, (_, i) => ({ ...link, TxnID: `DD-${i}` }));
    assert.equal(outputRows(exchange('snapshot', entity, [{ AppliedToTxnRet: full }]), entity)[0].AppliedToTxnRet.length, 500);
    assert.deepEqual(outputRows(exchange('snapshot', entity, [{ AppliedToTxnRet: [] }]), entity), [{ AppliedToTxnRet: [] }]);
  });

  test(`${entity} refuses malformed or oversized links without returning staged data`, () => {
    assert.deepEqual(outputRows(exchange('snapshot', entity, [{ AppliedToTxnRet: [link] }]), entity), [{ AppliedToTxnRet: [link] }]);
    for (const value of [null, 'SENTINEL_STRING', {}, [null], ['SENTINEL_STRING'], [[]], [{}],
      [{ ...link, Amount: 75 }], [{ ...link, Amount: 'x'.repeat(4097) }],
      [{ ...link, TxnID: 'dd-15' }], [{ ...link, TxnType: { Notes: 'SENTINEL_NESTED' } }],
      Array.from({ length: 501 }, () => link)]) {
      const result = exchange('snapshot', entity, [{ AppliedToTxnRet: value }]);
      assert.equal(result.code, 'QB_PARTIAL_VIEW');
      assert.deepEqual(result.frames, []);
      assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
    }
  });
}

test('contract records every added field as unverified and checks nested privacy and bounds before build', () => {
  assert.equal(checkQbdContract(QBD_CONTRACT).requestSets, 17);
  assert.deepEqual(QBD_CONTRACT.probeIdentity.fields, ['ListID', 'TimeCreated']);
  assert.equal(QBD_CONTRACT.probeIdentity.verification, 'unverified against Intuit');
  for (const [entity, fields] of [
    ['AccountRet', ['ListID', 'TimeCreated']],
    ['CustomerRet', ['Sublevel']],
    ['InvoiceRet', ['IsPending', 'CustomerRef.FullName', 'TermsRef.FullName']],
    ['BillRet', ['OpenAmount', 'IsPending', 'VendorRef.FullName']],
    ['CreditMemoRet', ['TotalAmount', 'IsPending', 'CustomerRef.FullName']],
    ['TransactionRet', ['CurrencyRef.ListID']],
    ['BillPaymentCheckRet', ['PayeeEntityRef.FullName', 'BankAccountRef.FullName', 'AppliedToTxnRet', 'AppliedToTxnRet.TxnID', 'AppliedToTxnRet.TxnType', 'AppliedToTxnRet.Amount']],
    ['BillPaymentCreditCardRet', ['PayeeEntityRef.FullName', 'CreditCardAccountRef.FullName', 'AppliedToTxnRet', 'AppliedToTxnRet.TxnID', 'AppliedToTxnRet.TxnType', 'AppliedToTxnRet.Amount']],
  ]) {
    const ret = QBD_CONTRACT.returns.find((entry) => entry.name === entity);
    for (const field of fields) assert.equal(ret.fieldVerification[field], 'unverified against Intuit');
  }
  for (const change of [
    (c) => { c.returns.find((r) => r.name === 'BillPaymentCheckRet').repeated[0].fields.push('AccountNumber'); },
    (c) => { c.returns.find((r) => r.name === 'BillPaymentCheckRet').repeated[0].maxItems = 501; },
    (c) => { c.returns.find((r) => r.name === 'BillPaymentCheckRet').repeated = []; },
    (c) => { c.probeIdentity.fields.push('Name'); },
    (c) => { c.probeIdentity.maxRows = 10001; },
  ]) {
    const contract = structuredClone(QBD_CONTRACT);
    change(contract);
    assert.throws(() => checkQbdContract(contract), /QB_HELPER_STATIC_REFUSAL/);
  }
});
