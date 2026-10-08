import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

test("shared row guard is pure and withholds exactly present void fields", async () => {
  const { guardQuickBooksRecord } = await import("../connectors/quickbooks-guard.mjs");
  for (const entity of ["Invoice", "Bill", "CreditMemo", "BillPayment"]) {
    for (const edition of ["online", "desktop"]) {
      for (const TotalAmt of [0, -0, "0", "0.000000", "-0.00"]) {
        const row = Object.freeze({ TotalAmt, Balance: 0, RemainingCredit: 0, Line: Object.freeze([]) });
        const result = guardQuickBooksRecord(entity, row, { edition });
        const fields = entity === "BillPayment" ? ["TotalAmt"] : ["TotalAmt", "Balance", "RemainingCredit"];
        assert.notEqual(result.row, row, "the caller never receives its own row for mutation");
        assert.deepEqual(result.withheld, fields);
        for (const field of fields) assert.equal(Object.hasOwn(result.row, field), false);
        assert.equal(row.TotalAmt, TotalAmt, "frozen caller still owns every original slot");
        const valid = { ...row, TotalAmt: 75 };
        assert.deepEqual(guardQuickBooksRecord(entity, valid, { edition }), { row: valid, withheld: [] });
      }
    }
  }
  for (const TotalAmt of [null, undefined, "", false, "1e-999", "0.000001"]) {
    const row = { TotalAmt, Balance: 75 };
    assert.deepEqual(guardQuickBooksRecord("Invoice", row, { edition: "online" }), { row, withheld: [] }, "missing, invalid and nonzero values are not exact zero");
  }
  assert.deepEqual(guardQuickBooksRecord("Invoice", { TotalAmt: 0 }, { edition: "online" }).withheld, ["TotalAmt"]);
});

test("account signs are edition-bound and permanently excluded types fail module initialization", async () => {
  const { guardQuickBooksRecord, PROVEN_SIGN_TYPES } = await import("../connectors/quickbooks-guard.mjs");
  const proven = ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset", "Credit Card"];
  assert.deepEqual(PROVEN_SIGN_TYPES.online, proven);
  assert.deepEqual(PROVEN_SIGN_TYPES.desktop, []);
  const forbidden = ["Non-Posting", "Income", "Other Income", "Expense", "Other Expense", "Cost of Goods Sold"];
  for (const edition of ["online", "desktop"]) {
    for (const AccountType of [...proven, ...forbidden, "Accounts Payable", "Other Current Liability", "Long Term Liability", "Equity", "Unknown"]) {
      const row = Object.freeze({ AccountType, CurrentBalance: -75 });
      const result = guardQuickBooksRecord("Account", row, { edition });
      const allowed = edition === "online" && proven.includes(AccountType);
      assert.equal(Object.hasOwn(result.row, "CurrentBalance"), allowed);
      assert.deepEqual(result.withheld, allowed ? [] : ["CurrentBalance"]);
      assert.equal(row.CurrentBalance, -75);
    }
    assert.throws(() => PROVEN_SIGN_TYPES[edition].push("Income"), TypeError);
  }
  const source = await readFile(new URL("../connectors/quickbooks-guard.mjs", import.meta.url), "utf8");
  for (const excluded of forbidden) {
    for (const edition of ["online", "desktop"]) {
      const modified = edition === "online"
        ? source.replace('"Bank",', `${JSON.stringify(excluded)}, "Bank",`)
        : source.replace("desktop: Object.freeze([])", `desktop: Object.freeze([${JSON.stringify(excluded)}])`);
      assert.notEqual(modified, source, "the prospective sign-list edit actually reached module initialization");
      await assert.rejects(import(`data:text/javascript;base64,${Buffer.from(modified).toString("base64")}`), /permanently excluded/);
    }
  }
  assert.throws(() => guardQuickBooksRecord("Account", { CurrentBalance: 1 }, { edition: "unknown" }), /edition/);
  assert.throws(() => guardQuickBooksRecord("Account", { CurrentBalance: 1 }), /edition/);
});

test("edition admission reads injected inventory and requires other QuickBooks families to be gone", async () => {
  const { assertSingleQuickBooksSource } = await import("../connectors/quickbooks-edition-guard.mjs");
  const targetSource = "quickbooks_desktop";
  let calls = 0;
  const attempt = (sources) => assertSingleQuickBooksSource({ targetSource, listQuickBooksSources: async () => { calls++; return sources; } });
  await assert.rejects(attempt([{ name: "quickbooks", kind: "quickbooks", family_count: 1 }]), (error) => {
    assert.equal(error.code, "quickbooks_other_edition_present");
    assert.ok(error.message.includes(renderCliCommands("brain forget <manifest> --source <old-source>")));
    assert.doesNotMatch(error.message, /--yes/, "guidance begins with a reviewed preview");
    return true;
  });
  assert.equal(calls, 1, "refusal reached the injected stored-family inventory");
  await attempt([{ name: "quickbooks", kind: "quickbooks", family_count: 0 }]);
  await attempt([{ name: targetSource, kind: "quickbooks", family_count: 3 }]);
  await attempt([{ name: "files", kind: "upload", family_count: 10 }]);
  await attempt([]);
  assert.equal(calls, 5, "empty, reconnecting and non-QuickBooks controls all reached the same decision");
  for (const family_count of [undefined, null, -1, 0.5, "0", NaN]) {
    await assert.rejects(attempt([{ name: "quickbooks", kind: "quickbooks", family_count }]), /inventory/);
  }
  await assert.rejects(attempt(null), /inventory/);
  await assert.rejects(assertSingleQuickBooksSource({ targetSource, listQuickBooksSources: async () => { throw new Error("inventory unavailable"); } }), /inventory unavailable/);
});
