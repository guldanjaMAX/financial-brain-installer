# QuickBooks Desktop field acceptance notebook

**Status: held. This notebook cannot produce a green Desktop release receipt.**
It records local observations and tests comparisons using invented books. Only
the maintainer or an authorized operator may run it on a dedicated test PC.
Never use an owner's PC, real books, or an existing company file.

The current checkout has no adopted signed helper and no Desktop mapping module
from packet 07. The helper also omits fields needed below. Do not edit helper
pins, compile a replacement, loosen its query allowlist, or substitute Online
mapping to get past these stops. Owners who leave Desktop disabled have no
behavior change: this notebook has no CLI dispatcher, manifest, or scheduler hook.

## Before booking the test

Have the maintainer supply the reviewed checkout, adopted signed helper,
approved licence, and a local folder outside the checkout for receipts. Use:

- An **x64 Windows 11** PC or VM, running x64 Node 22 or newer. Windows on ARM,
  including an emulated x64 Node process, is excluded because COM may differ.
- QuickBooks Desktop **2024 Pro Plus or Enterprise 24**, US edition with an
  active subscription. A developer trial or not-for-resale licence remains an
  open question. Resolve it before the appointment; this script obtains none.
- Smart App Control in its default state. W1 needs a clean installation where
  enforcement is active. Do not disable it to make a test succeed.
- Windows 10 22H2 and Desktop 2023 only if licensed copies are already available.
  Record an unavailable variant as `not_tested`; do not imply it passed.
- A second PC or network share for N1, with another user joined in multi-user
  mode. The reader still runs on the same PC as the open QuickBooks session.
- A restricted clerk user without **Sensitive accounting activities**.

Allow about half a day of hands-on work **after** the invented files are prepared.
Creating three years of postings may take longer. S1 also requires a return
visit after **72 real hours**. Moving the Windows clock does not satisfy S1.

## Create the invented books by hand

Create a fresh company called `Synthetic Store`. Do not choose a sample company;
the helper refuses those. Use `Customer One`, `Vendor One`, and similar role
labels. Leave real addresses, staff names, bank numbers and tax identifiers out.
Save a clean copy before each exceptional scenario. The script never enters or
changes a posting. All preparation below is done by the operator in disposable
books, separate from capture.

Use the exact amounts below. Keep a paper ledger relating P1 through P16 to the
invented account or transaction labels and the capture folder. Export the reports
after each relevant stage, before a later posting changes the same balance.

| ID | Enter in the disposable company | Check against reports |
|---|---|---|
| P1 | Deposit 1,000.00 to Checking | Bank sign |
| P2 | Credit card charge 123.45 | Card Balance sign |
| P3 | Bill 500.00; pay 200.00 by check | AmountDue, OpenAmount, BillPaymentCheck; open 300.00 |
| P4 | Bill 80.00; pay it by credit card | BillPaymentCreditCard |
| P5 | Invoice subtotal 100.00, tax 8.25; receive 50.00 | TransactionRet.Amount 108.25, BalanceRemaining 58.25, AppliedAmount sign |
| P6 | Credit memo 30.00 plus tax 2.48; apply 10.00 | Whether total includes tax; CreditRemaining name and observed value |
| P7 | Loan 5,000.00 to a Long Term Liability account | Liability sign |
| P8 | Vendor One and Customer One each with an open balance | Enter a separate 60.00 bill and 70.00 invoice; vendor/customer signs |
| P9 | Checking with a sub-account; another bank Savings:Checking | Put 25.00 in the sub-account and 40.00 in Savings:Checking; parent totals and colliding leaf names |
| P10 | Check 4,000.00 dated 13 days after the capture date | Postdated inclusion in Balance; export present-date and future-date balance sheets |
| P11 | An invoice 20.00 and bill 30.00 marked pending | IsPending; if the edition offers no pending bill, record that limitation for review |
| P12 | Void a separate invoice 40.00 and bill payment 50.00 | Zero totals; no approved paid statement |
| P13 | Edit a separate invoice on both sides of a DST transition | TimeModified offset and refusal window |
| P14 | Customer One:Job with an invoice 90.00 | Hierarchy rendering and parent/child balance exclusion |
| P15 | In a copy only, enable multicurrency; add EUR customer, vendor and bank | Capture actual currency fields; v1 must withhold money |
| P16 | A second company with three years of invented daily postings | Snapshot time and responsiveness; have this file prepared before the session |

P13 needs a **Windows clock change**, on the isolated test machine only. Choose
a time zone with DST and have the maintainer supply the two actual transition
instants, including offsets. Restore clock synchronization immediately afterward.
Retain captures before and after; do not guess UTC from a missing offset.
Do not combine P13 clock changes with the S1 certificate waiting period.

## Local commands and files

Use ordinary PowerShell in the reviewed checkout, outside an embedded agent
terminal, without Run as administrator. The operator opens QuickBooks first.
The helper joins the open file; it never opens a file by path or starts QuickBooks.
There is no manifest argument and no Brain connection.

The examples use an existing, access-restricted parent folder `C:\QbdField`.
Choose a **new child folder for every command**. A previous folder is never
overwritten. Windows inherits the parent folder's ACL; numeric POSIX modes alone
do not establish an owner-only Windows ACL. Keep receipts out of cloud sync.

```powershell
node scripts/qbd-field-acceptance.mjs help
node scripts/qbd-field-acceptance.mjs observe --step A0 --out C:\QbdField\a0-observed
```

Answer only `yes`, `no`, a whole number, or a numbered menu choice. The notebook
does not accept notes. A bad answer ends the command without saving an observation.
For `tested`, answer `no` if the step did not run; use zero for unobserved counts
and `not_tested` when offered. A complete form means only that its fields exist.
It never means the behavior passed.

`capture` takes a local JSON file prepared by the maintainer. For A0, `probe.json`:

```json
{ "inventedOnly": true, "request": { "operation": "probe" } }
```

```powershell
node scripts/qbd-field-acceptance.mjs capture --step A0 --input C:\QbdField\probe.json --out C:\QbdField\a0-captured
```

For A1/A4 use `{"inventedOnly":true,"request":{"operation":"probe2"}}`.
For B1 use `{"inventedOnly":true,"request":{"operation":"registry"}}`.
For snapshot steps the maintainer prepares this shape with a real test cutoff
and **all account ListIDs from the invented file**:

```json
{
  "inventedOnly": true,
  "request": {
    "operation": "snapshot",
    "historySince": "2024-10-07T00:00:00Z",
    "accountListIds": ["AA-12"],
    "storedTxnIds": []
  }
}
```

The date and ID above are examples, not discovered values. Snapshot data includes
the account IDs needed to prepare a later complete postdated check. A first
snapshot with no IDs cannot establish postdated coverage; retain it as discovery
only and rerun with the complete ID set. This notebook does not certify coverage.
The cutoff controls incremental history; the account/open-item tier is a full read.

```powershell
node scripts/qbd-field-acceptance.mjs capture --step T1 --input C:\QbdField\snapshot.json --out C:\QbdField\t1-captured
node scripts/qbd-field-acceptance.mjs observe --step T1 --out C:\QbdField\t1-observed
```

On success a capture folder contains `capture.json`, `frames.json` and
`fixture.json`. B1 instead writes `registry.json`. A refused helper call writes
only `capture.json`, with its support code. Fixture frames are the existing
bridge's allowlisted projection, **not original qbXML or rejected raw frames**.
No partial snapshot is copied as a fixture. The fixture records the request plan
and retains the terminal completeness frame for later packet 07 regression tests.

Before creating any output directory, the script scans all output for the real
Windows user name and machine name from `USERNAME` and `COMPUTERNAME`. Matching
is literal, case-insensitive and includes decoded JSON escapes. Missing identity
values also refuse. Never replace those variables to bypass a refusal. The check
is deliberately conservative; the operator must still ensure all data is invented.
Stdout contains counts and codes only, never frames, record labels or raw errors.

Exit 0 means local recording or comparison succeeded. Exit 1 means invalid input,
privacy refusal or local failure. Exit 2 means a capture refused, a comparison
failed, or a held receipt was written. **No exit code approves a release.**

## Run each step

Run `observe --step ID` after every step. `capture --step ID` is available only
where an operation is listed below. Restore the ordinary attended grant between
exceptional scenarios. Never run R1 against the main invented file.

| Step | Operator action and capture operation | Record and stop condition |
|---|---|---|
| A0 | Open as QuickBooks Admin; `probe`; pick Yes, whenever this company file is open | Permission, read-only and publisher screens, confirmation count, single-user requirement. Count each consent click once. This is authorization-only; full connect clicks await packet 07. |
| A1 | Immediately run `probe2` in the same open file | Whether another prompt appears |
| A2 | Switch to restricted clerk; `snapshot` | Compare every query's row count with the Admin capture. Record same/fewer/refused/not_tested per query. The present bridge discards failed frames, so missing query evidence remains unproven. |
| A3 | In a copy, grant Yes, always; `probe` | Must refuse broad grant. Record automatic-login fields only if actually observed. The current bridge drops the refused preferences frame, so the code alone is not direct field-value evidence. Narrow the grant afterward. |
| A4 | In a copy, grant Prompt each time; `probe2` | Whether the second session blocks/prompts and returns QB_GRANT_PROMPTS. Restore attended grant. |
| B1 | `registry` | Bridge queries HKLM in both 32/64-bit views and checks the resolved Program Files server's Intuit signature. Its local registry file records architecture, CLSID and path. Do not paste registry output into chat. |
| S1 | Authorize reviewed build A; wait 72 real hours; maintainer provides separately adopted re-signed build B; `probe` | Certificate valid/expired/unknown and whether authorization repeats. Never swap an unpinned EXE. No build B has been supplied by this lane. |
| E1 | On the test PC, set QuickBooks Run as administrator; launch reader without elevation; `probe` | LeastPrivilege failure and detection. Restore the original setting. Connector pre-consent detection is unavailable until packet 07. |
| E2 | Leave a modal dialog open; `probe`; then close dialog and repeat in a new folder | Whether it blocks, elapsed milliseconds and recovery. Keep both captures. |
| E3 | Only if the Admin sign-in-due state is available safely; `probe` | Whether a joined session is affected. Otherwise simulated=no, affected=not_tested. Never change a real account to force it. |
| N1 | Second PC/share hosts the file; another user is active; `snapshot` | Join succeeds, other user remains connected and no file lock. This is multi-user testing, not the deferred different-PC connector. |
| W1 | On clean SAC-enforced Windows 11; `probe` | Enforcement active and helper admitted. A disabled-SAC run cannot pass this step. |
| W2 | Maintainer supplies reviewed windowless launch candidates; `probe` within each | Select conhost_headless/signed_launcher/neither/not_tested for each OS. This notebook does not install tasks or claim a launcher is proven. |
| R1 | **Held: no test-only write-probe build exists here** | Maintainer must supply a separately reviewed, never-shipped probe and disposable copy. Require reached Add decision, refused write, and successful read control. No refusal before dispatch counts as proof of IsReadOnly. |
| T1 | P16 file; `snapshot` | Copy capture elapsedMs into snapshotMs, record three-year coverage and responsiveness. A timeout is evidence, not permission to raise a limit. |
| I1 | Inspect special-account deletion restrictions in a disposable copy | Record each candidate separately. Unknown is not undeletable. This script attempts no deletion; any further destructive experiment needs a separately reviewed protocol. |
| X1 | Maintainer blocks **only helper outbound** on the test PC; `snapshot` | Confirm firewall block active and read succeeds. Restore the rule. This tests the helper, not QuickBooks' own licence/sign-in traffic. |

## Report comparison and receipt

Export these reports by hand, on the same invented file and observation date,
with the same basis and filters: **Balance Sheet Standard, A/R Aging Detail,
A/P Aging Detail, Customer Balance Summary, Vendor Balance Summary**.
Keep each original CSV unchanged. The maintainer can prepare a separate table-only
copy and specify exact key, currency and amount columns. Keep hierarchy in keys;
duplicate labels must be disambiguated from the original report, never merged.
Do not assume an unlabeled currency is USD. Record the report's currency settings
before adding an explicit currency column to a reviewed comparison copy.

The comparator accepts quoted CSV cells, commas in numbers, and parentheses for
negative amounts. It uses integer cents, never floating point. Unsupported report
headers, missing columns, extra precision and ambiguous duplicate keys refuse.
The parser does not guess the layout of arbitrary QuickBooks CSV exports.

The maintainer prepares `comparison.json` in this shape:

```json
{
  "inventedOnly": true,
  "reports": [{
    "report": "balance_sheet",
    "csv": "Account,Currency,Balance\nChecking,USD,1000.00\n",
    "keyColumn": "Account", "currencyColumn": "Currency", "amountColumn": "Balance"
  }],
  "rendered": [{
    "report": "balance_sheet", "key": "Checking", "currency": "USD",
    "amount": "1000.00", "surface": "opening", "posting": "P1"
  }],
  "withheld": [{ "record": "bill:BB-13", "reason": "OPEN_AMOUNT_ABSENT", "posting": "P3" }]
}
```

Report identifiers are `balance_sheet`, `ar_aging`, `ap_aging`, `customer_balance`
and `vendor_balance`. Surface is `opening` or `answer`. Each withheld record needs
a reason and a posting. An empty comparison cannot pass. Extra report rows may
be unrelated to the selected rendered amounts; matching one cell is not proof
of every posting or every answer.

```powershell
node scripts/qbd-field-acceptance.mjs compare --input C:\QbdField\comparison.json --out C:\QbdField\comparison-01
node scripts/qbd-field-acceptance.mjs receipt --input C:\QbdField\receipt-input.json --out C:\QbdField\receipt-01
```

`receipt-input.json` has `observations` keyed by all 17 step IDs (each value is
the `values` object from that step's observation), `captures` containing the
capture records, and `oracle` containing the comparison result. The maintainer
assembles it locally; the operator need not edit JSON. Keep separate receipts for
each OS/edition/company variant. Unknown and missing observations remain visible.

**Integration stop:** the rendered amounts above are externally supplied test
inputs. This revision neither imports packet 07 nor runs real answer renderers.
Every comparison says `mappingVerified: false`. A green cell comparison cannot
be relabeled as a mapping or field pass. A maintainer must integrate the actual
mapper, record renderer and answer gates, with complete posting coverage, before
this notebook can fulfill the release acceptance role.

The receipt always says NOT_READY. Its proposals are review-only: Desktop sign
types remain empty; field meanings and ID patterns remain unproven; 13.0 is only
the helper's candidate qbXML minimum. Bitness, certificate status, windowless
observations, elapsed snapshot time and authorization clicks are retained for
review. It applies no constants, money-policy settings or time-budget changes.

## Maintainer handoff and unresolved premises

- Adopt signed helper bytes through the signing review. Both local helper pins
  are currently unavailable; never bypass this check for field work.
- Integrate `connectors/quickbooks-desktop-map.mjs` from packet 07 and prove all
  openings and approved answers against the five reports. The file is absent
  from this kit's pinned base.
- Extend the helper in its owning lane, with tests and review: its current
  projection lacks BillRet.OpenAmount, CreditMemoRet.TotalAmount, IsPending,
  CustomerRet.Sublevel and AppliedToTxnRet. The bridge also strips unknown fields;
  editing only a fixture cannot prove them. Grant refusals discard diagnostic
  values. Decide how to collect those field facts without weakening owner guards.
- Supply separate protocols/artifacts for R1, S1 build B and W2 launch candidates.
  This notebook cannot invent their safety evidence.
- Keep Desktop sign findings separate from the already answered Online sign
  gate. No Online behavior or currency policy is changed here.
- Packet 07 connect/disconnect must use `reregisterAfterManifestChange` with exact
  readback. Its scheduler uses the earliest annual cutoff plus the actual-date
  gate, not seasonal re-registration. P13 verifies record offsets, not scheduler
  correctness. This notebook registers no daily tasks.
- Review invented fixture data manually before any follow-up commit. Receipts,
  raw report exports, machine registry observations and generated capture folders
  stay outside the package and repository. Retain interrupted folders as evidence;
  use a fresh directory when repeating a command.

Only MAIN's host gate, CI, independent review, real Windows field receipt and
the owner's publication decision can supply release sign-off.
