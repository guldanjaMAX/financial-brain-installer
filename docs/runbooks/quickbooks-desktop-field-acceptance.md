# QuickBooks Desktop field acceptance notebook

**NOT READY for complete field acceptance: CurrencyRet.IsUserDefined cannot be
captured through the current helper contract. Signed helper adoption is also pending.**
It records local observations and tests comparisons using invented books. Only
the maintainer or an authorized operator may run it on a dedicated test PC.
Never use an owner's PC, real books, or an existing company file.

The repaired helper contract and packet 07 mapper are present, with one remaining
premise gap: the mapper reads CurrencyRet.IsUserDefined but the contract drops it.
Stop that field-verification item. The owning lane must verify the provider field
and extend the reviewed helper projection, or replace that guard with a verified
currency-binding rule. Do not add it only to a fixture or treat its absence as false. The signed helper
is still unadopted. Production Desktop signs remain empty and file freshness is
unverified. This kit collects decision evidence and creates replayable fixtures;
it does not turn either guard off. Owners who leave Desktop disabled have no
behavior change: the kit has no CLI dispatcher, manifest or scheduler hook.

The capture is read-only. Preparing invented postings is a separate operator
activity. R1 needs its own reviewed, never-shipped write-probe artifact and a
disposable copy. Do not substitute a modified production helper.

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

The date and ID above are examples, not discovered values. Use every account ID
from the A0 identity probe, in the same order, for the snapshot plan. The replay
refuses absent, reordered or different account coverage. Keep storedTxnIds empty
for this fresh invented-file kit; existing-history recovery is not tested here.
The cutoff controls incremental history; the account/open-item tier is a full read.

```powershell
node scripts/qbd-field-acceptance.mjs capture --step T1 --input C:\QbdField\snapshot.json --out C:\QbdField\t1-captured
node scripts/qbd-field-acceptance.mjs observe --step T1 --out C:\QbdField\t1-observed
```

On success a capture folder contains `capture.json`, `frames.json` and
`fixture.json`. B1 instead writes `registry.json`. A refused helper call writes
only `capture.json`, with its support code. Fixture frames are the existing
bridge's allowlisted projection, **not original qbXML or rejected raw frames**.
No partial snapshot is copied as a fixture. The schema-2 fixture records capturedAt, the contract digest and request plan,
and retains the terminal completeness frame for packet 07 regression tests. Keep
one successful A0 probe fixture and one P snapshot fixture for each file. Capture
postings with `--step P`; reserve T1 for the separate large-file timing test.

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
| A0 | Open as QuickBooks Admin; `probe`; pick Yes, whenever this company file is open | Permission, read-only and publisher screens, confirmation count, single-user requirement. Count each consent click once. Record authorization clicks separately from fullConnectClicks. Full connect requires a separately approved local harness with fake source/scheduler dependencies, never a Brain. If unavailable, fullConnectTested=no; do not invent the four-click count. |
| A1 | Immediately run `probe2` in the same open file | Whether another prompt appears |
| A2 | Switch to restricted clerk; `snapshot` | Compare every query's row count with the Admin capture. Record same/fewer/refused/not_tested per query. The present bridge discards failed frames, so missing query evidence remains unproven. |
| A3 | In a copy, grant Yes, always; `probe` | Must refuse broad grant. Record automatic-login fields only if actually observed. The current bridge drops the refused preferences frame, so the code alone is not direct field-value evidence. Narrow the grant afterward. |
| A4 | In a copy, grant Prompt each time; `probe2` | Whether the second session blocks/prompts and returns QB_GRANT_PROMPTS. Restore attended grant. |
| B1 | `registry` | Bridge queries HKLM in both 32/64-bit views and checks the resolved Program Files server's Intuit signature. Its local registry file records architecture, CLSID and path. Do not paste registry output into chat. |
| S1 | Authorize reviewed build A; wait 72 real hours; maintainer provides separately adopted re-signed build B; `probe` | Record initialCertificate and the certificate shown after 72 hours as valid/expired/unknown, distinctAdoptedBuilds, and whether authorization repeats. Retain A and B capture timestamps and pins; wall-clock changes invalidate this arm. Never swap an unpinned EXE. No build B has been supplied by this lane. |
| E1 | On the test PC, set QuickBooks Run as administrator; launch reader without elevation; `probe` | LeastPrivilege failure and detection. Restore the original setting. The separate local connect harness must also reach hasElevation and refuse before consent; record beforeConsent only when that decision is observed. A helper failure alone does not prove it. |
| E2 | Leave a modal dialog open; `probe`; then close dialog and repeat in a new folder | Whether it blocks, elapsed milliseconds and recovery. Keep both captures. |
| E3 | Only if the Admin sign-in-due state is available safely; `probe` | Whether a joined session is affected. Otherwise simulated=no, affected=not_tested. Never change a real account to force it. |
| N1 | Second PC/share hosts the file; another user is active; `snapshot` | Join succeeds, other user remains connected and no file lock. This is multi-user testing, not the deferred different-PC connector. |
| W1 | On clean SAC-enforced Windows 11; `probe` | Enforcement active and helper admitted. A disabled-SAC run cannot pass this step. |
| W2 | Maintainer supplies reviewed windowless launch candidates; `probe` within each | Select conhost_headless/signed_launcher/neither/not_tested for each OS. This notebook does not install tasks or claim a launcher is proven. |
| R1 | **Held: no test-only write-probe build exists here** | Maintainer must supply a separately reviewed, never-shipped probe and disposable copy. Require reached Add decision, refused write, and successful read control. No refusal before dispatch counts as proof of IsReadOnly. |
| T1 | P16 file; `snapshot` | Copy capture elapsedMs into snapshotMs, record three-year coverage and responsiveness. A timeout is evidence, not permission to raise a limit. |
| I1 | Inspect special-account deletion restrictions in a disposable copy | Record each candidate separately. Unknown is not undeletable. This script attempts no deletion; any further destructive experiment needs a separately reviewed protocol. |
| F1 | Follow the open-file discovery protocol below, with `probe` before and after each variant | All controls must pass; a path guessed from Recent Files is not an open-file identity source. |
| X1 | Maintainer blocks **only helper outbound** on the test PC; `snapshot` | Confirm firewall block active and read succeeds. Restore the rule. This tests the helper, not QuickBooks' own licence/sign-in traffic. |

## Adopt the signed helper before any capture

The maintainer, in a separate reviewed change, places the adopted executable at
`operations/quickbooks-desktop-helper.exe` and its lowercase 64-hex SHA-256 in
`operations/quickbooks-desktop-signed.mjs`, **`QBD_HELPERS.x86.sha256`**. The pin
is over the final signed bytes, not the unsigned build. Retain the signing receipt,
source commit, artifact digest, Authenticode subject and timestamp validation.
`QBD_HELPERS.x64` is currently null. If B1 finds only a 64-bit processor, the
maintainer must separately build/sign/adopt an x64 artifact with its own path and
sha256 entry there. An x64 Windows host does not imply an x64 COM processor.

The operator never edits these constants. There is no helper path, checksum,
compile, download or skip-signature option in the kit. The bridge checks the pin
before registry/signature/native launch and refuses `QB_HELPER_UNAVAILABLE` if
unadopted or mismatched. Authenticode must be Valid with the expected organization;
the resolved HKLM processor must be Intuit-signed under Program Files. A hash
alone does not replace those checks. Build B in S1 requires its own adoption
receipt and reviewed checkout; swapping bytes under build A's pin must refuse.

## Field capture coverage, from the real mapper

Run the following to save the closed field/step inventory and pass bars:

```powershell
node scripts/qbd-field-acceptance.mjs plan --out C:\QbdField\field-plan
```

The inventory comes from `connectors/quickbooks-desktop-map.mjs`. Transport coverage
is checked against `operations/quickbooks-desktop-requests.json`; uncapturable
fields produce HELPER_FIELD_UNCAPTURABLE in replay and receipt. Presence means
observed, not proven. `fieldCoverage` reports observed row counts and missing
fields. For each field below, retain a populated provider control and the listed
mutation or absence. Every negative must reach a mapped record or connector
call and have a corresponding green control in the follow-up connector tests.

The common mapper reads are `ListID` or `TxnID`, `RefNumber`, `TxnDate`, `DueDate`,
`TimeModified`, and `IsPending`. List rows normally lack transaction dates/numbers;
The helper also omits RefNumber on both BillPayment forms and ReceivePayment;
the common mapper attempts that optional read but these renderers do not require
a payment DocNumber. Historical rows lack DueDate/IsPending. Those expected absences stay visible.
Do not add fields to a captured frame to claim the provider returned them.

| Provider record | Every entity-specific field read (plus applicable common fields) | Capture/control |
|---|---|---|
| HostRet | Country | US control; non-US only if licensed variant exists. Missing country refuses context. |
| PreferencesRet | MultiCurrencyPreferences.IsMultiCurrencyOn, MultiCurrencyPreferences.HomeCurrencyRef.ListID | Single-currency control; P15 on copy; missing home ID. |
| CurrencyRet | ListID, CurrencyCode, IsUserDefined | Exact home-ID join, real ISO code, non-user-defined control; unknown/duplicate ID and user-defined currency refuse. IsUserDefined is currently UNCAPTURABLE (helper allowlist omission); stop this item. Missing is not false. |
| AccountRet | ListID, TimeModified, Name, AccountType, Balance, TotalBalance | P1/P2/P7/P9/P10; all 16 type values considered; only individually proved balance types may be proposed. |
| CustomerRet | ListID, TimeModified, Name, Balance, TotalBalance, Sublevel | P8 top-level control; P14 child and parent rollup withholds. |
| VendorRet | ListID, TimeModified, Name, Balance | P8 owed and credit-balance cases; preserve sign. |
| InvoiceRet | TxnID, TimeModified, RefNumber, TxnDate, DueDate, CustomerRef.FullName, TermsRef.FullName, Subtotal, SalesTaxTotal, BalanceRemaining, AppliedAmount, IsPaid, CurrencyRef.ListID, IsPending | P5 full/partial/paid states, P11 pending, P12 void, P13 offsets, P14 hierarchy. Missing terms is optional; slash or empty hierarchy segment refuses. |
| TransactionRet | TxnID, Amount, CurrencyRef.ListID | Exact P5 invoice join, one row per TxnID; missing/duplicate ID and different currency are negative replay controls. |
| BillRet | TxnID, TimeModified, RefNumber, TxnDate, DueDate, VendorRef.FullName, AmountDue, OpenAmount, IsPending | P3 open 300.00; paid control P4; missing OpenAmount refuses; P11 pending capability must be observed, never fabricated. |
| CreditMemoRet | TxnID, TimeModified, RefNumber, TxnDate, CustomerRef.FullName, TotalAmount, CreditRemaining, Subtotal, SalesTaxTotal, IsPending | P6 32.48 total and 22.48 remaining; verify tax inclusion; add pending/zero-total controls if the UI supports them. |
| BillPaymentCheckRet | TxnID, TimeModified, TxnDate, PayeeEntityRef.FullName, Amount, BankAccountRef.FullName, AppliedToTxnRet[].TxnID, AppliedToTxnRet[].TxnType | P3 200.00 payment; P12 void; full account name maps to leaf; multiple bill links with exact IDs. |
| BillPaymentCreditCardRet | TxnID, TimeModified, TxnDate, PayeeEntityRef.FullName, Amount, CreditCardAccountRef.FullName, AppliedToTxnRet[].TxnID, AppliedToTxnRet[].TxnType | P4 80.00 payment; a second disposable case paying multiple bills; Bill links retained and non-Bill links excluded. |
| ReceivePaymentRet | TxnID, TimeModified, TxnDate, TotalAmount; adapter reads CustomerRef.ListID | P5 50.00; exact customer-ID join supplies context.customerName; missing join remains descriptive only, never a money-policy statement. |

The context reads are `host`, `preferences`, `currencies`,
`usSingleCurrencyBinding`, `accounts`, `transaction`, `postdatedCount`, and
`customerName`. The US fallback constant remains **false**; neither fixtures nor
CLI options can enable it. A missing home-currency binding means money refuses.
P15's multicurrency copy must also refuse, even if it contains readable amounts.

Additional connector/helper evidence: AccountRet.TimeCreated (bounded probe
identity), CompanyRet.IsSampleCompanyFile, HostRet.SupportedQBXMLVersion, all three
CurrentAppAccessRights flags, terminal request counts/status/remaining counts,
per-account Postdated matchedCount, TxnDeletedRet.TxnDelType/TxnID and
ListDeletedRet.ListDelType/ListID. Capture a prepared before/after disposable
removal case with manual setup outside the read-only capture. AppliedToTxnRet.Amount
is validated and retained by the helper although the mapper reads only type/ID;
verify every link's amount and the contract's bounded list limit in follow-up tests.
`CompanyName`, `FullName` on Account/Customer, and Customer.CompanyName are not
mapper inputs. Never substitute those for a leaf or ID.

For P9, compare the full account list with NFKC/case-fold collisions and differing
Balance/TotalBalance. For P10, retain a clean P1 control then present/future report
exports: any positive matchedCount withholds the account, even if Balance matches.
For P13, use independent trusted observation times in the later connector tests,
verify actual offset-to-UTC conversion on both sides of the transition, and test
missing offset refusal. The kit PC's capture timestamp is **not** production
Worker-clock proof. If provider offsets are wrong, stop for the specified two-hour
refusal-window implementation; never repair the raw timestamps in the fixture.

## F1: discover a safe open-file identity and stat source (P08)

The accounting fingerprint cannot distinguish a live file from a byte copy or
restored backup containing the same earliest account. A typed filename, Recent
Files, a directory scan, window-title guessing, or hashing the account tuple again
cannot close P08. No safe open-file source is currently implemented.

1. The maintainer investigates a documented session-bound API on the installed
   request processor first. Verify the API exists on that build; do not assume
   an API name or add a request to the shipped helper. If none is available,
   investigate an OS handle tied to the exact running QuickBooks process and
   joined session. Record source=session_api, os_handle or none. Any diagnostic
   code needs separate review and its digest retained locally before use.
2. The candidate must obtain the **currently joined file**, hold a stable file
   identity while reading its stat, and bind that observation to the accounting
   fingerprint. Read identity and last-write before and after the accounting
   snapshot. Reject ambiguity, a switch mid-read, inaccessible stat, symlink or
   reparse ambiguity, a guessed path, or identity changing during the read.
3. On the clean invented file: record stable repeated reads; rename/move while
   closed and reopen; then make a posting and verify last-write advances. Require
   ordinary user privileges and no network calls by the diagnostic itself.
4. Open a different company; then open a copied file with the **same accounting
   fingerprint**; restore an older copy; close QuickBooks; switch files during a
   read. Each must reach discovery and refuse or distinguish the file correctly.
   Retain the original passing read alongside every negative.
5. Repeat on the N1 network share while another user is connected. Establish what
   the server file identity and write-time semantics mean; caching, leases,
   permission failures and disconnected shares must refuse. A local-only result
   cannot clear the network-file bar.
6. Keep actual paths/user/machine identifiers transient. Persist only typed
   outcomes, non-reversible diagnostic identity digests and UTC times in a
   separate private evidence bundle after privacy review. Never put raw paths
   into fixture JSON or Git. The kit's F1 observation records no path or ID.
7. Run `observe --step F1`. Every boolean must be observed true and source must
   be session_api or os_handle for discovery to pass. `productionFreshness`
   still reads `unverified`: MAIN must review and implement the candidate in
   the connector, then prove 14-day dormancy, restored-copy rollback, missing
   stat and wrong identity refusals with changed-file green controls.

If no candidate passes, choose none, preserve failures and leave Desktop money
held. Do not replace the freshness guard with a manual attestation. Lost binding
with stored families still refuses `QB_BINDING_RECOVERY_REQUIRED`; this protocol
never authorizes automatic adoption. Recovery remains reviewed source removal
followed by fresh connect.

## Replay the capture and compare every rendered amount

Export Balance Sheet Standard, A/R Aging Detail, A/P Aging Detail, Customer
Balance Summary and Vendor Balance Summary by hand at each posting stage, using
the same file, observation date, basis and filters. **Also export transaction
detail for subtotal, tax, original total, credit applied and payment links.** The
five summary/aging reports alone do not contain all of these. Do not invent a
missing report cell from the helper amount or infer it by subtraction.

Keep original CSVs unchanged. Hash originals and reviewed table-only copies in
the private evidence inventory. The operator verifies report settings and a
maintainer records exact key/currency/amount columns. Explicit currency may be
added only to a separate copy after verifying the report setting; never assume
USD. Retain hierarchy in keys; duplicate identities refuse. Parentheses mean a
negative amount. No rounding, absolute-value conversion or sign flipping occurs.

The maintainer prepares a local JSON with `inventedOnly: true`, `probe` containing
the whole A0 `fixture.json`, and `snapshot` containing the whole P `fixture.json`.
Do not use `capture.json` in those slots. Captures must share the complete account
identity set and contract digest. Use a fresh probe if preparation added accounts.
The kit reconstructs a replay-only binding from the probe and captured history
cutoff, with an empty stored-family set. It writes no owner binding and proves
neither recovery nor historical deletion custody.

```powershell
node scripts/qbd-field-acceptance.mjs capture --step P --input C:\QbdField\snapshot.json --out C:\QbdField\p1-captured
node scripts/qbd-field-acceptance.mjs replay --input C:\QbdField\replay-input.json --out C:\QbdField\p1-replay
```

`replay.json` contains real mapper rows and field provenance, record openings,
money-policy statements, account and open-item renderings, every extracted money
cell, observed/missing field counts, and the actual connector result. These are
**pre-freshness previews**, not approved owner answers. The normal connector
result retains `QB_FRESHNESS_UNVERIFIED` and no monetary documents. The shared
guard also withholds Account amounts. Raw provider money cells use surface=field,
so withheld sign evidence can still be compared without changing the guard.

`connector-fixture.json` is ready for an offline follow-up test: import
`replayFixtures` from this script and pass the JSON object. It invokes the real
`syncQuickBooksDesktop`, validates frames and exact request coverage, and requires
non-empty emitted documents. For positive goldens **in tests only**, supply the
existing `createQuickBooksGuardForTest({ desktopSignTypes: [...],
desktopFreshnessVerified: true })` as the injected guardRecord dependency. There
is no JSON, CLI, environment or manifest option to select that seam. Test all
openings/answers and their refusal variants before promoting a sign type. Raw
frames remain unedited; mutations are isolated copies made by tests.

For comparison, add `reports` and `selections` to the same replay input:

```json
{
  "reports": [{
    "report": "ar_aging",
    "csv": "Record,Currency,Amount\nInvoice-open,USD,58.25\n",
    "keyColumn": "Record", "currencyColumn": "Currency", "amountColumn": "Amount"
  }],
  "selections": [{
    "cell": "invoice:CC-14/opening/1",
    "report": "ar_aging", "key": "Invoice-open", "posting": "P5"
  }]
}
```

This fragment is illustrative, **not a complete comparison**. Use actual invented
IDs from replay, and select **every** entry in replay.cells, including repetitions
across allowed money statements, open-item answers and raw field cells. A selection
supplies no amount: the program extracts it from actual rendered output or the
captured field. Several cells may use the same report row. A credit-card "owes"
cell uses the report's liability magnitude only if the report explicitly supplies
it; retain the signed-balance comparison as a separate cell. A raw AppliedAmount
sign differing from the report stays a mismatch requiring review, not a conversion.

Report identifiers: balance_sheet, ar_aging, ap_aging, customer_balance,
vendor_balance and transaction_detail. Missing, duplicate or extra cell selectors,
missing report amounts, currency drift, invalid precision and any 0.01 discrepancy
fail. Zero comparisons fail. Withheld records and reasons remain in the oracle.
Field presence and complete selections do not prove every P1-P16 branch; the
reviewer must check the scenario ledger and before/after controls as well.

```powershell
node scripts/qbd-field-acceptance.mjs mapped-compare --input C:\QbdField\comparison.json --out C:\QbdField\comparison-01
node scripts/qbd-field-acceptance.mjs receipt --input C:\QbdField\receipt-input.json --out C:\QbdField\receipt-01
```

The legacy `compare` command accepts manually supplied values solely as a CSV
primitive and always records mappingVerified=false. Use mapped-compare for field
work. Each mapped comparison rebuilds the replay from frames; it never trusts a
hand-edited replay or rendered amount. Run separate comparisons for each posting
stage and OS/edition variant; retain all their digests in the review inventory.

`receipt-input.json` contains `observations` keyed by all **18** step IDs (each
observation's values), `captures` with capture records and `oracle` with the mapped
comparison. It records proposals and unresolved holds, not reviewer approval.
The receipt separately evaluates typed behavior bars (for example SAC must be
enforced, N1 must leave the other user connected and E1 must refuse before
consent). E3 that cannot safely be simulated remains an explicit review hold.
The receipt is always NOT_READY for release; matching amounts cannot prove native
field execution, an adopted helper or an implemented freshness source.

## Exact bars for the Desktop proven set and release review

No type is inferred from Online's already answered G4 or from another Desktop
type. The only initial candidates with postings in this kit are:

| Candidate renderer type | Minimum independent evidence |
|---|---|
| Bank | P1 +1,000.00 before later postings; clean leaf, Balance=TotalBalance; P9/P10 negative controls. |
| Credit Card | P2 charge 123.45 plus P4 card-paid bill 80.00; signed Balance must match report and the existing renderer's owes wording must be correct. Positive owed Balance incompatible with wording means fix/review, not sign flipping. |
| Accounts Payable | P3 500.00 then 200.00 payment; P8 independent vendor amount; exact signed account and liability report. |
| Accounts Receivable | P5 108.25 then 50.00 receipt; P8 independent customer amount; exact signed account/report. |
| Long Term Liability | P7 5,000.00 with its actual signed Balance and the matching liability row. |

Equity, Fixed Asset, Other Asset, Other Current Asset and Other Current Liability
need additional invented postings of their own and exactly the same bars before
inclusion. Non-Posting, Income, Other Income, Expense, Other Expense and Cost of
Goods Sold remain permanently excluded.

For **each** proposed member require all of these:

1. Successful complete terminal frames from the adopted signed helper on x64
   Windows 11 + Desktop 2024, correct attended rights, exact home currency binding,
   no postdated entries, no leaf collision, Balance equals TotalBalance. Record
   before/after posting IDs, captured raw sign and report settings/digests.
2. Zero-cent difference for every selected field, opening and answer cell;
   independent report-derived expected values. Every relevant missing-field,
   rollup, duplicate, pending, void, multicurrency, timestamp and partial-view
   control withholds after a reached decision and has a successful control.
3. Replay retained fixtures through packet 07's test-only guard with **only that
   candidate type** enabled. Account opening, balance answer and owes wording
   match the report; production replay still holds. A raw sign match only proposes
   a candidate and never clears this requirement.
4. P08's verified source is reviewed, implemented and independently tested;
   currency fields, identity anchor, IDs and supported qbXML version are proved.
   No manual observation enables production freshness or the US currency fallback.
5. MAIN accepts the exact evidence, host gate, CI and independent review, then
   makes a separate reviewed edit to `connectors/quickbooks-guard.mjs`,
   `PROVEN_SIGN_TYPES.desktop`. Never modify the set during kit execution.

Field meanings need P3 AmountDue/OpenAmount against original/open bill cells;
P5 TransactionRet.Amount=108.25, remaining=58.25 and observed AppliedAmount with
absolute magnitude 50.00; IsPaid agrees with zero remaining and currency IDs match.
P6 must show TotalAmount=32.48=30.00+2.48 and CreditRemaining=22.48 after applying
10.00. Missing fields, wrong tax inclusion or wrong signs remain unproven. P4 and
both payment kinds need exact links and nonzero totals; P12 must never say paid.

Other proposal bars: both registry views and signer for bitness; every captured
ListID/TxnID conforms to the strict bridge pattern, including repeated links;
13.0 supported and every compiled query succeeds for the qbXML minimum; valid
certificate initially and after 72 real hours on A/B with reprompt outcome for
the certificate decision; SAC actually enforced for W1; invisible window and
successful read/clean close for each W2 OS; at least three complete responsive P16
runs with maximum timing below the current 300,000 ms overall and 30,000 ms request
bounds before proposing a budget. R1 reaches Add and refuses while a read control
succeeds; no production helper can send it. Any missing reviewed artifact holds
that gate. Optional OS/licence variants remain explicitly not_tested.

Count full connect separately from authorization, including opening QuickBooks,
switching to Admin, each confirmation, grant repair and elevation repair.
Record schedule readback only through a separately reviewed local connect harness.
Connect/disconnect uses `reregisterAfterManifestChange`; earliest annual cutoff
plus actual-date gate remains unchanged. P13 is not scheduler proof. The kit
never registers a task or contacts a Brain.

Review raw fixtures manually before any follow-up commit; names/privacy scanning
is necessary but not sufficient to prove invented data. Original CSVs, registry
paths, signed-build receipts, observations and capture folders stay outside Git
and the package. Only reviewed invented regression fixtures may be proposed for
Git. MAIN's host gate, CI, independent review, real field receipt and the owner's
publication decision remain the release authority.
