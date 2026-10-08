import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeQbdFrame, qbdPlan, qbdRequests, validateQbdResult,
} from "../operations/quickbooks-desktop-bridge.mjs";

// Packet 07 dependency probes. These deliberately fail until the reviewed
// helper contract supplies the fields required by the connector. Do not replace
// the missing fields with calculated amounts or bypass bridge projection.
const clock = new Date("2026-10-07T12:00:00.000Z");
const account = {
  ListID: "AA-12", TimeCreated: "2020-01-01T00:00:00-07:00",
  TimeModified: "2026-10-07T04:00:00-07:00", Name: "Checking",
  AccountType: "Bank", Balance: "1201.00", TotalBalance: "1201.00",
};

function exchange(operation, supplied = {}) {
  const plan = qbdPlan({ operation, historySince: "2024-10-07T00:00:00Z" }, clock);
  const requests = qbdRequests(operation, plan);
  assert.ok(requests.length > 0, "the real request planner was reached");
  const rows = {
    HostRet: [{ Country: "US", ProductName: "QuickBooks Pro" }],
    CompanyRet: [{ IsSampleCompanyFile: "false" }],
    PreferencesRet: [{
      "CurrentAppAccessRights.IsReadOnly": "true",
      "CurrentAppAccessRights.IsAutomaticLoginAllowed": "false",
      "CurrentAppAccessRights.IsPersonalDataAccessAllowed": "false",
    }],
    AccountRet: [account],
    ...supplied,
  };
  const frames = requests.filter((request) => request.mode !== "postdated").map((request) => ({
    protocol: 1, type: "batch", request: request.id,
    entity: request.ret, rows: rows[request.ret] || [],
  }));
  frames.push({
    protocol: 1, type: "terminal", requests: requests.map((request) => ({
      id: request.id, statusCode: 0, statusSeverity: "Info",
      iteratorRemainingCount: 0, requestCount: 1,
      rowCount: frames.find((frame) => frame.request === request.id)?.rows.length || 0,
      ...(request.mode === "postdated" ? { matchedCount: 0 } : {}),
    })),
  });
  const bytes = Buffer.concat(frames.map((frame) => encodeQbdFrame(frame)));
  const result = validateQbdResult(bytes, operation, plan);
  assert.equal(result.ok, true, "the production validator accepted the complete framed run");
  assert.equal(result.frames.at(-1).type, "terminal");
  return result.frames;
}

const returnedRows = (frames, entity) => frames.filter((frame) => frame.entity === entity)
  .flatMap((frame) => frame.rows);

test("green control: complete snapshots preserve account identity and observed fields", () => {
  assert.deepEqual(returnedRows(exchange("snapshot"), "AccountRet"), [account]);
});

test("attended probe provides the account tuple required before binding creation", () => {
  assert.equal(returnedRows(exchange("snapshot"), "AccountRet").length, 1,
    "the same fixture provides an account through the snapshot control");
  const frames = exchange("probe");
  assert.equal(returnedRows(frames, "HostRet").length, 1);
  assert.equal(returnedRows(frames, "CompanyRet").length, 1);
  assert.ok(returnedRows(frames, "AccountRet").length > 0,
    "connect cannot derive its account-based company fingerprint from the probe");
});

const contracts = [
  ["CustomerRet", { ListID: "BB-13", Balance: "75.00", TotalBalance: "75.00" }, {
    Sublevel: "0",
  }],
  ["InvoiceRet", { TxnID: "CC-14", Subtotal: "75.00", BalanceRemaining: "75.00" }, {
    IsPending: "false", "CustomerRef.FullName": "Customer One", "TermsRef.FullName": "Net 30",
  }],
  ["BillRet", { TxnID: "DD-15", AmountDue: "75.00" }, {
    OpenAmount: "25.00", IsPending: "false", "VendorRef.FullName": "Vendor One",
  }],
  ["CreditMemoRet", { TxnID: "EE-16", Subtotal: "70.00", SalesTaxTotal: "5.00" }, {
    TotalAmount: "75.00", IsPending: "false", "CustomerRef.FullName": "Customer One",
  }],
  ["TransactionRet", { TxnID: "CC-14", Amount: "75.00" }, {
    "CurrencyRef.ListID": "FF-17",
  }],
  ["BillPaymentCheckRet", { TxnID: "AB-18", Amount: "75.00" }, {
    "PayeeEntityRef.FullName": "Vendor One", "BankAccountRef.FullName": "Checking",
    AppliedToTxnRet: [{ TxnID: "DD-15", TxnType: "Bill", Amount: "75.00" }],
  }],
  ["BillPaymentCreditCardRet", { TxnID: "AC-19", Amount: "75.00" }, {
    "PayeeEntityRef.FullName": "Vendor One", "CreditCardAccountRef.FullName": "Company Card",
    AppliedToTxnRet: [{ TxnID: "DD-15", TxnType: "Bill", Amount: "75.00" }],
  }],
];

for (const [entity, control, required] of contracts) {
  test(`${entity} preserves the packet-required slots through the real bridge`, () => {
    const baseline = returnedRows(exchange("snapshot", { [entity]: [control] }), entity);
    assert.deepEqual(baseline, [control], "green control reaches projection with one accounting row");
    const projected = returnedRows(exchange("snapshot", { [entity]: [{ ...control, ...required }] }), entity);
    assert.equal(projected.length, 1, "the target record reached the field projection");
    for (const [field, value] of Object.entries(control)) assert.deepEqual(projected[0][field], value);
    assert.deepEqual(Object.keys(required).filter((field) => !Object.hasOwn(projected[0], field)), [],
      "required accounting slots were discarded before the mapper could inspect them");
    for (const [field, value] of Object.entries(required)) assert.deepEqual(projected[0][field], value);
  });
}
