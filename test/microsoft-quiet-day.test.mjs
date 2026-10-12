import assert from "node:assert/strict";
import test from "node:test";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { runProviderConnector } from "../connectors/provider-runtime.mjs";

const NOW = "2026-10-10T12:00:00.000Z";
const DELTA = "https://graph.microsoft.com/v1.0/fixture-delta";
const NEXT = "https://graph.microsoft.com/v1.0/fixture-next";
const terminal = { value: [], "@odata.deltaLink": DELTA };
const cursor = { mail: { inbox: `${DELTA}-prior` }, drives: {}, calendar: {
  delta_link: `${DELTA}-prior`, window_start: "2026-09-10T00:00:00.000Z", window_end: "2027-01-08T00:00:00.000Z",
  id_type: "immutable", event_ids: [],
} };

async function runCase({ pages = [terminal], workload = "mail", saveFailure = false, mutate = x => x } = {}) {
  const calls = { provider: 0, saves: 0, sync: 0 };
  const receipts = [];
  const events = [];
  let saved = null;
  let error = null;
  let result = null;
  try {
    result = await runProviderConnector({
      provider: "microsoft", source: "mailbox", now: () => new Date(NOW),
      resolveAccess: async () => ({ accessToken: "synthetic-provider-proof" }),
      loadState: () => ({ cursor }),
      saveState: state => {
        calls.saves++;
        events.push("save");
        if (saveFailure) throw new Error("synthetic cursor save failure");
        saved = structuredClone(state);
      },
      listStoredFamilies: async () => new Set(),
      sendBatch: async () => assert.fail("quiet delta fixtures never deliver documents"),
      postReceipt: async (_base, _key, receipt) => { receipts.push(receipt); events.push(receipt.status); },
      sync: async options => {
        calls.sync++;
        return mutate(await syncMicrosoftGraph({ ...options,
          mailFolderIds: workload === "calendar" ? [] : ["inbox"],
          includeCalendar: workload !== "mail", includePersonalDrive: false, now: () => Date.parse(NOW),
          fetchImpl: async () => {
            calls.provider++;
            assert.ok(pages.length > 0, "every provider decision consumes a distinct response");
            const { status = 200, ...body } = pages.shift();
            return Response.json(body, { status });
          },
        }));
      },
    });
  } catch (caught) { error = caught; }
  assert.equal(calls.sync, 1, "the real connector was reached");
  assert.ok(calls.provider > 0, "the real delta page decision was reached");
  assert.equal(receipts.length, 2, "both source receipt decisions were reached");
  return { calls, receipts, events, saved, error, result };
}

for (const workload of ["mail", "calendar", "both"]) {
  test(`Microsoft ${workload} quiet boundary survives paging and cursor persistence`, async () => {
    const pages = [{ value: [], "@odata.nextLink": NEXT }, terminal];
    if (workload === "both") pages.push(terminal);
    const f = await runCase({ workload, pages });
    assert.equal(f.error, null);
    assert.equal(f.calls.provider, workload === "both" ? 3 : 2);
    assert.equal(f.calls.saves, 1);
    assert.equal(f.result.provider_check_complete, true);
    assert.equal(f.receipts.at(-1).provider_check_complete, true);
    assert.deepEqual(f.events, ["indexing", "save", "ready"]);
    assert.equal(f.saved.cursor[workload === "calendar" ? "calendar" : "mail"][workload === "calendar" ? "delta_link" : "inbox"], DELTA);
  });
}

for (const [name, options, calls, code] of [
  ["missing boundary", { pages: [{ value: [] }] }, 1, "missing_delta_link"],
  ["incomplete second page", { pages: [{ value: [], "@odata.nextLink": NEXT }, { value: [] }] }, 2, "missing_delta_link"],
  ["expired cursor", { pages: [{ status: 410 }] }, 1, "cursor_expired"],
  ["provider error", { pages: [{ status: 403 }] }, 1, null],
  ["missing items", { pages: [{ "@odata.deltaLink": DELTA }] }, 1, null],
  ["malformed boundary", { pages: [{ value: [], "@odata.deltaLink": {} }] }, 1, null],
  ["conflicting boundary", { pages: [{ value: [], "@odata.nextLink": NEXT, "@odata.deltaLink": DELTA }, { value: [] }] }, 1, null],
  ["cursor save error", { saveFailure: true }, 1, null],
]) {
  test(`Microsoft ${name} never certifies a quiet check`, async () => {
    const f = await runCase(options);
    assert.equal(f.calls.provider, calls);
    assert.ok(f.error, "a failed boundary remains a failed execution");
    if (code) assert.equal(f.error.code, code);
    assert.equal(f.saved, null);
    assert.equal(f.receipts.at(-1).status, "error");
    assert.notEqual(f.receipts.at(-1).provider_check_complete, true);
  });
}

test("Outlook 410 recovery retains its cursor recovery but cannot certify the failed invocation", async () => {
  const f = await runCase({ workload: "calendar", pages: [{ status: 410 }, terminal] });
  assert.equal(f.calls.provider, 2, "expiry and baseline recovery were both reached");
  assert.equal(f.error, null, "existing recovery remains available");
  assert.equal(f.calls.saves, 1);
  assert.equal(f.result.cursor_advanced, true);
  assert.equal(f.result.provider_check_complete, false);
  assert.equal(f.receipts.at(-1).provider_check_complete, false);
});

for (const [name, mutate] of [
  ["unfinished walk", result => ({ ...result, walk_complete: false })],
  ["partial result", result => ({ ...result, outcome: { kind: "partial" } })],
  ["withheld cursor", result => ({ ...result, cursor_can_advance: false })],
]) {
  test(`Microsoft ${name} cannot borrow the adapter boundary proof`, async () => {
    const f = await runCase({ mutate });
    assert.equal(f.calls.provider, 1);
    assert.equal(f.error, null);
    assert.notEqual(f.receipts.at(-1).provider_check_complete, true);
  });
}
