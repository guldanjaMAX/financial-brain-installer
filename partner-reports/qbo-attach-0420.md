# QBO-ATTACH-0420

## Contract prepared before implementation

This lane extends Gmail's existing message ingest. It does not connect to a
bookkeeping API or import figures into the structured ledger. The message and
its readable reports remain one logical document family, so the existing
credential scan, acceptance, retry and deletion boundaries continue to apply.

- Read named `.xlsx`, `.xls`, `.csv` and text-bearing `.pdf` attachments,
  case-insensitively, from eligible Gmail messages. No sender allowlist or
  provider-specific subject rule. Legacy `.xls` means an OLE workbook.
  Unsupported types, unnamed parts, inline images and nested messages receive
  explicit exclusion metadata and a visible content marker. No archive or
  nested-message recursion, OCR, macro execution or link downloads.
- Hard safety bounds: 10 MIME attachments including excluded parts; 5 MiB
  decoded bytes per attachment; 15 MiB total decoded attachment bytes;
  25 MiB decoded raw message; 1 MiB combined extracted attachment text in UTF-8.
  Bounds are inclusive. Attachment names are limited to 255 characters and may
  not contain control characters. Existing Office archive safety also applies.
- Keep the bare Gmail message ID as the durable family identity. Rerunning the
  same message is idempotent. Each attachment occurrence records its position,
  decoded name, exact-byte SHA-256, byte count, Gmail message ID and receipt
  date. Duplicate bytes of the same type inside one message render once, with
  all occurrences retained. Different bytes with the same filename remain
  distinct. Across weekly deliveries, identical bytes have the same payload
  hash, while each delivery retains its own message family and provenance.
  This contract does not collapse storage or retrieval across messages; doing
  that safely needs shared ownership and deletion semantics beyond this lane.
- The message date remains Gmail's receipt date. A report's `report_as_of` is
  separate and comes only from an explicit `As of` or `Report as of` line in
  extracted attachment text, using an unambiguous ISO or English month date.
  Missing, invalid or conflicting dates stay unknown. Filenames, subjects,
  workbook properties and resend dates never establish report freshness.
  Period-range inference and automatic latest-report selection are out of scope.
- A supported attachment that is encrypted, malformed, empty, truncated,
  unreadable or over a bound refuses the whole replacement message. A readable
  body or sibling cannot hide the failure. Return a fixed reason code, retain
  any accepted prior family, and block the source cursor. No attachment bytes
  are written to disk; diagnostics do not contain names, bytes or parser errors.
  Recovery is a readable export or an explicit source-policy/removal decision,
  followed by a rerun. This is a decoded-file validation contract, not a claim
  that the existing tolerant MIME parser detects every transport corruption.
- Increment the Gmail extraction policy and stamp accepted message revisions.
  Previously accepted body-only revisions must be fetched again during the
  policy sweep. A current stamped revision can resume without a body download.

## Result and boundaries

Implemented for operator review on the existing lane branch. The final focused
run passed all 40 new tests. Three named mutants are killed. No network,
installation, real account, credential ceremony, production write, Git metadata
write, commit or push was performed. Existing installed dependencies were used.
The product version remains 0.4.19; this is proposed 0.4.20 work, not a release.

Cross-message storage dedupe, period-range inference, automatic latest-report
selection, nested-message extraction, OCR and structured ledger ingestion are
deliberately outside this contract. A changed workbook byte stream has a new
hash even if it displays the same figures. A report with only a period range
retains its text but has unknown `report_as_of`.

The raw-message cap applies before MIME parsing, after the existing Google
helper receives its JSON response. The text cap applies after each shared file
extractor returns. This does not add a new process-isolation or memory-bound
guarantee to spreadsheet extraction. Existing ZIP expansion guards still apply.
The MIME parser remains tolerant of framing and transfer-encoding defects.

## Findings and changed files

Gmail already fetched `format=raw` and passed the message to the EML extractor.
`ingest/formats.mjs:603` retained attachment names but discarded their bytes
from the returned text. The registered file readers already supported the four
target formats. The patch reuses those readers instead of adding a provider
API or a second financial parser.

| File:line | Change |
| --- | --- |
| `connectors/gmail-attachments.mjs:7` | Fixed count, decoded byte, raw-message, text and filename bounds. |
| `connectors/gmail-attachments.mjs:21` | Closed local refusal codes without parser diagnostics or attachment names. |
| `connectors/gmail-attachments.mjs:32` | Conservative explicit report-date extraction; unknown/conflicting dates remain null. |
| `connectors/gmail-attachments.mjs:52` | Binary signatures, UTF decoding, OLE encryption and workbook checks. |
| `connectors/gmail-attachments.mjs:88` | Bounded MIME parse, occurrence provenance, SHA-256 identity and same-message dedupe. |
| `connectors/gmail-attachments.mjs:130` | MIME message/image exclusions take precedence over a misleading report extension. |
| `connectors/gmail-attachments.mjs:149` | Strict encrypted-PDF opt-in, complete extraction requirement and text budget. |
| `connectors/gmail-attachments.mjs:161` | Generated CSV filename headings cannot establish readability. |
| `connectors/gmail.mjs:30` | Extraction policy 2 and versioned accepted revisions. |
| `connectors/gmail.mjs:446` | Attachments join the existing message envelope with separate receipt/report dates. |
| `connectors/gmail.mjs:460` | Combined message quality refusal preserves retry eligibility. |
| `brain.mjs:18442` and `brain.mjs:18567` | Older accepted body-only revisions cannot bypass attachment extraction on a policy sweep. |
| `brain.mjs:19220` | Cursor-gap wording covers policy and extraction evidence. |
| `ingest/formats.mjs:74`, `ingest/formats.mjs:131`, `ingest/formats.mjs:365` | Optional encrypted-PDF refusal propagated through the isolated parser and reread path. Default PDF policy is unchanged. |
| `ingest/formats.mjs:589` | Opt-in attachment access from the existing MIME parser with nesting/header bounds. Local EML and MBOX defaults remain unchanged. |
| `ingest/pdf-child.mjs:64` | Uses parsed encryption metadata before text extraction, including PDFs that open with an empty user password. |
| `test/gmail-attachments.test.mjs:100` | 32 synthetic message/file contract cases, generated in memory. |
| `test/gmail-attachment-resume.test.mjs:94` | Four real-runner tests with injected provider, authority, receipt and snapshot checkpoint dependencies. |
| `test/gmail-encrypted-pdf.test.mjs:31` | Generated encrypted PDF with real parser controls and Gmail integration. |
| `test/gmail-incremental-policy.test.mjs:18`, `test/gmail-incremental-policy.test.mjs:295` | Existing regression expectations use the new extraction version and changed fingerprint. |
| `test/fixtures/gmail-attachment-resume-mutant.mjs:1` | In-memory legacy resume mutant. |
| `test/fixtures/gmail-attachment-incomplete-mutant.mjs:1` | In-memory omission-guard mutant. |
| `test/fixtures/gmail-attachment-encryption-mutant.mjs:1` | In-memory encryption-forwarding mutant. |
| `scripts/run-test-chain.mjs:35` and `scripts/run-test-chain.mjs:650` | Registers the three new focused suites in both test-graph lists. The full chain was not run. |
| `README.md:908` | Owner explanation of reports, limits, dates and refusals. |
| `docs/README-developer.md:894` | Exact connector contract and remaining field gate. |
| `docs/ARCHITECTURE.md:420` | Message-family ownership, recovery and provenance boundaries. |
| `manifest.schema.json:233`, `templates/brain.manifest.json:106` | Matching Gmail capability descriptions; no new per-install settings. |
| `onboarding/07-ingest-source-matrix.md:45` and `onboarding/07-ingest-source-matrix.md:122` | Matching connector status and attachment behavior; real-mailbox proof remains outstanding. |
| `partner-reports/qbo-attach-0420.md:1` | Contract, evidence and operator handoff. |

## Red then green

| Fix | Red evidence | Green evidence and passing control |
| --- | --- | --- |
| Read bounded attachment content with provenance, dedupe and honest dates | Initial attachment suite: 1 passed, 25 failed. Ordinary mail passed while attachments were names only. | 26/26 after implementation; final expanded suite 32/32. Each refusal case includes a readable control; bound tests include valid boundary controls. |
| Backfill accepted body-only mail | Resume suite: 2 passed, 2 failed. Old accepted state skipped the fetch and bypassed a later refusal. | 4/4. Current stamped state still skips download; missing stored family still fetches. |
| Exclude nested messages and images despite report extensions | Selected nested-message test: failed after the valid CSV control passed. | Same selected test passed after MIME type takes precedence. |
| Do not accept blank CSV from a generated filename heading; classify text-budget refusal before quality scanning | Selected four-case group: 2 passed, 2 failed. Blank CSV was accepted; over-budget text returned a quality code. | Same group 4/4. Ordinary CSV and UTF-16 controls pass; row truncation remains refused. |
| Refuse encrypted PDFs that open without a password | Corrected synthetic PDF suite before implementation: 2 passed, 1 failed. Both a plain strict-mode PDF and a genuinely encrypted default-mode PDF were readable. | Direct suite 3/3, then Gmail integration 4/4. Parser metadata, not a raw-byte pattern, proves encryption. |
| Retain retry eligibility after combined-message quality failure | Selected combined-message test: 0/1; each single attachment control loaded, but combined refusal was nonblocking. | Same test 1/1; prior family is retained and cursor/retry protection remains explicit. |

## Every focused test invocation

All commands below were offline on Windows with Node v24.18.0. Counts from
older assertion scripts are their own internal checks; Node wraps each script
as one test. Repeated invocations are listed in execution order within each row.

| Command | Results |
| --- | --- |
| `node --test test/gmail-attachments.test.mjs` | Initial red: 1/26 passed. Next attempt: import error from a mistyped quality-helper export, exit 1. Corrected: 26/26 passed. Later expanded run after the PDF opt-in: 31/31 passed. Final 32 cases also passed in the combined command below. |
| `node --test --test-name-pattern='nested messages and images' test/gmail-attachments.test.mjs` | Two invocations: 0/1 red, then 1/1 green. |
| `node --test --test-name-pattern='blank CSV\|row truncation\|expanded report\|UTF-8 CSV' test/gmail-attachments.test.mjs` | Two invocations: 2/4 red, then 4/4 green. The shell argument uses ordinary regex alternation pipes, without Markdown escaping. |
| `node --test --test-name-pattern='combined message quality' test/gmail-attachments.test.mjs` | Two invocations: 0/1 red, then 1/1 green. |
| `node --test test/gmail-attachment-resume.test.mjs` | Three invocations: baseline 2/4; first implementation attempt 0/4 due the same helper import error; corrected 4/4. |
| `node --test test/gmail-encrypted-pdf.test.mjs` | Five invocations: initial fixture cleanup mistake 1/3; corrected harness red 2/3; implementation 3/3; added Gmail integration 4/4; final normal rerun 4/4. |
| `node --test test/gmail-attachments.test.mjs test/gmail-attachment-resume.test.mjs test/gmail-encrypted-pdf.test.mjs` | First: 39/40, one Windows `EPERM` during synthetic checkpoint rename. Second: 40/40 after the runner test used injected snapshot checkpoint storage. Atomic filesystem behavior remains covered by the existing ingest suite. |
| `node --test test/google-drive.test.mjs` | Exit 0; 172 internal checks passed, including existing Gmail policy, body, date and transport behavior. |
| `node --test test/quality.test.mjs` | Exit 0; 34 internal checks passed. |
| `node --test test/gmail-finalization.test.mjs` | First: 23/24, one incidental Windows `EPERM` during synthetic checkpoint rename. Unchanged-source rerun: 24/24 passed. |
| `node --test test/formats-extra.test.mjs` | Exit 0; 64 internal checks passed, including shared EML/MBOX behavior. |
| `node --test test/provenance-source-assessment.test.mjs` | Exit 0; all internal checks passed. |
| `node --test test/ingest-run.test.mjs` | Exit 0; 97 internal checks passed, one existing symlink-privilege case skipped. Includes isolated PDF parser, failure, output-bound, timeout and atomic state tests. |
| `node --test test/test-chain-runner.test.mjs` | Exit 0; exact graph/order and runner controls passed. This test does not run the product chain. |
| `node --test test/gmail-incremental-policy.test.mjs` | Four attempts, none complete. First stopped at the old pinned fingerprint after three preliminary checks; the expected version change was corrected. Second stopped after seven preliminary checks on a lifecycle lock directory outside the writable sandbox. Third used a temporary test-only lock root and stopped after seven checks on a synthetic lock-owner file ACL. Fourth set `TEMP` and `TMP` to the workspace test directory and hit the same ACL failure. The temporary test-source lock-root changes were reverted. Full regression behavior requires the operator's host rerun. |

The fourth policy attempt used this wrapper before the same focused command:

```powershell
$testRoot = Join-Path (Get-Location).Path '.test-tmp-qbo-policy'
New-Item -ItemType Directory -Path $testRoot -Force
$env:TEMP = $testRoot
$env:TMP = $testRoot
node --test test/gmail-incremental-policy.test.mjs
```

## Three mutants and proof

Each fixture uses a Node module-load hook, asserts its replacement target is
unique, and prints `MUTATION_APPLIED`. No reviewed source file is edited while
running a mutant. A failing mutant run is the expected success of this check.

1. **`body_only_resume`** removes the extraction-version guard.

   ```powershell
   node --import ./test/fixtures/gmail-attachment-resume-mutant.mjs --test test/gmail-attachment-resume.test.mjs
   ```

   Three invocations: first 2 passed/2 failed with one incidental filesystem
   rename error; second 2 passed/2 behavioral failures; final snapshot-storage
   run 2 passed/2 behavioral failures. Legacy backfill and refusal protection
   kill it. Current-version and missing-family controls pass.

2. **`ignore_incomplete_attachment`** removes the known-omission guard.

   ```powershell
   node --import ./test/fixtures/gmail-attachment-incomplete-mutant.mjs --test test/gmail-attachments.test.mjs
   ```

   Two invocations: 28 passed/3 failed with 31 cases, then 29 passed/3 failed
   with the final 32 cases. Malformed CSV, thin PDF and row truncation kill it.
   Normal CSV, XLSX, XLS and PDF controls pass.

3. **`reject_encrypted_not_forwarded`** removes only Gmail's strict PDF option.

   ```powershell
   node --import ./test/fixtures/gmail-attachment-encryption-mutant.mjs --test test/gmail-encrypted-pdf.test.mjs
   ```

   The durable fixture run exits 1: 3 passed/1 failed. Only the Gmail boundary
   test fails; direct strict extraction and both readability controls pass.
   An earlier equivalent `--import data:` loader run also returned 3 passed/1
   failed. The checked-in fixture is the reproducible command for that same
   mutation.

## Static checks and operator follow-up

`git diff --check` passed, including repeated scoped checks while editing.
Both edited JSON documents parsed successfully. `node --check <file>` passed
for every changed JavaScript module and test:

- `brain.mjs`
- `connectors/gmail.mjs`
- `connectors/gmail-attachments.mjs`
- `ingest/formats.mjs`
- `ingest/pdf-child.mjs`
- `scripts/run-test-chain.mjs`
- `test/gmail-attachments.test.mjs`
- `test/gmail-attachment-resume.test.mjs`
- `test/gmail-encrypted-pdf.test.mjs`
- `test/gmail-incremental-policy.test.mjs`
- all three `test/fixtures/gmail-attachment-*-mutant.mjs` files.

The policy test's last attempt left synthetic fixture residue at
`.test-tmp-qbo-policy/brain-test-gmail-mixed-iSUt7O/`. It is not product source
and must not be staged. It contains generated fixture state and protected
synthetic lock/support directories. The package's existing allowlist excludes
this root directory. No package artifact was built in this lane.

Automatic approval review rejected both recursive cleanup attempts with
`rejected: blocked by policy`, without a further reason. Subsequent read-only
inspection confirmed ACL-denied synthetic subdirectories. The operator must
remove that test folder from an authorized host context. No permissions were
changed to bypass the sandbox.

Before committing, the operator should rerun the three new suites and the
existing Gmail incremental-policy suite in its normal host context. Real Gmail
delivery, scheduled-report exports, host matrix coverage and release packaging
remain separate field/release gates. No live-account acceptance is claimed.

## Prepared commit

Subject: Read bounded report attachments during Gmail ingest

Body: Preserve message family identity and attachment provenance. Refuse
incomplete report reads and backfill earlier body-only revisions. Add synthetic
contract tests and mutation evidence.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran the focused suites on the unchanged working tree, while other test-running jobs were active on the same machine:

- `node --test test/gmail-attachments.test.mjs test/gmail-attachment-resume.test.mjs test/gmail-encrypted-pdf.test.mjs`: 40 passed, 0 failed.
- `test/gmail-incremental-policy.test.mjs` (modified by this lane): failed 2 of 4 runs and passed 2 of 4. One failure was `EPERM: operation not permitted, rename '...\.brain-ingest-gmail.json.tmp-...' -> '...\.brain-ingest-gmail.json'` inside "a Gmail refusal plus a recoverable failure stays failed and retryable"; the other was the assertion "a policy or scanner upgrade cannot dilute a stopped Gmail removal baseline". The same suite at the base commit f8a7cd05 passed 2 of 2 runs on the same host. This looks like a Windows rename race under load, but the operator cannot rule out that the lane made it more likely, so the lane is marked NOT READY until the suite is replayed on a quiet host.

The untracked `.test-tmp-qbo-policy/` residue (ACL-protected synthetic fixture state) was left in place and not committed. The names scan found no person names; fixture addresses use the example.invalid domain. The operator made the prepared commit unchanged and edited no code.

LANE QBO-ATTACH-0420: NOT READY gmail-incremental-policy failed 2 of 4 operator reruns on Windows (base passed 2 of 2); replay on a quiet host
