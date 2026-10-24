# QBO-ATTACH-0420-2

## Contract changes from round 1

This round replaces round 1's whole-message attachment refusal with per-part
exclusions. Readable body and siblings remain in the message family. A bad
immutable attachment no longer blocks history. Body and attachment credentials
are scanned separately before assembly; the whole envelope is scanned again.
Missing provider or message-wide MIME evidence still blocks history. A message
with no readable part after credential exclusion retains the established
whole-family credential-refusal outcome.

M1 is stopped at the explicitly permitted design plus failing-red-test fallback.
The current full-sweep migration is still present and is a blocker, not accepted
large-mailbox behavior. R0 is also unresolved: the reported assertion did not
recur in the isolated Windows harness, and no proven product root cause or
product fix is claimed. The round 1 report is unchanged.

## Work completed and remaining

- B1: fixed per-part reasons, markers and metadata preserve readable content.
  The real runner accepts a bad original with a readable sibling, accepts a
  clean control, then accepts a corrected resend under its new message identity.
- M2: the configured scanner checks the body, subject, each attachment name
  and extracted attachment text before assembly. Excluded names are removed
  from metadata. The existing final scanner still checks title, content and
  nested metadata before splitting or sending. The scanner opt-out is passed
  through from the manifest rather than replaced by a connector default.
- M1: a separate candidate pager/checkpoint and independent cleanup binding
  are specified in `partner-reports/qbo-attach-backfill-design.md`. No production
  backfill implementation or candidate-coverage claim is made.
- R0: diagnostic and fixture isolation improvements are prepared. The original
  regression remains unclosed despite repeated green runs.

The extraction limits are admission limits: the first 10 MIME attachment
positions are eligible, with 5 MiB per admitted part and 15 MiB admitted total.
In-bound duplicates and unsupported parts consume decoded-byte budget.
Rejected oversized parts do not consume the remaining budget. Accepted distinct
attachment text is capped at 1 MiB. Every excluded occurrence retains a fixed
reason. The raw message remains bounded at 25 MiB before MIME parsing. The
existing tolerant parser and extractor memory-isolation limitations remain.

## R0 investigation and limits of the evidence

The first unmodified command failed before the policy behavior ran: this
sandbox could not create the machine-level lifecycle lock directory. The test
now uses its own synthetic lifecycle root and the repository's path-checked
ACL adapters. Synthetic Google records are read without native credential
migration. Actual CLI dispatch, leases, owner files, state-file replacement,
policy, scan, send, removal preview/apply and receipt logic remain active.
Checkpoint writes were not replaced with an in-memory adapter in this suite.

The nonempty-plan assertion formerly reported only that the plan was missing,
although an earlier operational failure also exits 1. It now includes redacted
CLI output with explicit synthetic-value withholding. Its plan assertion was
not relaxed. This prepares a useful failure report if the original problem
recurs; it is not evidence that the failure was fixed.

The `git diff f8a7cd05` trace established two real code changes:

1. `gmailPolicyFingerprint` includes extraction version 2, which causes the
   runner to choose a full sweep. The new revision guard rejects every legacy
   accepted revision, so those messages are fetched, resent and checkpointed.
   This explains M1 and increases work, but does not explain the first
   incremental credential-refusal assertion by itself.
2. The new MIME path and raw validation preserve the synthetic ordinary and
   credential-only message behavior in direct offline probes. The final
   credential scanner still refuses the latter. No deterministic explanation
   for the reported early assertion was established from that path.

Four isolated runs before the part changes passed all 62 Windows checks. A later final-code run
failed at a different, deterministic B1 contract expectation: authenticated D1
absence cleared an old removal marker, but missing raw MIME now correctly held
history. The test had expected history to advance. That assertion now requires
history preservation on repeated missing MIME, followed by passing controls for
a provider retry that supplies the same message's raw bytes and an empty next
history window. This does not close the original R0 report.

Final repeats reproduced Windows `EPERM` during checkpoint replacement. One
failed while accepting a recoverable Worker retry, and another during repeated
reset/scanner migration. `ingest/run.mjs:2135` still uses one `renameSync` and
then `chmodSync`; that code is unchanged from the base. The observed failure
boundary is established, but the original Mac nonempty-plan failure and the
lane's causal role are not. No retry shim or in-memory checkpoint replacement
was introduced to hide these failures. Exact final repeat results follow below.
Native ACL/credential behavior and the original Mac reproduction still require
operator evidence.

## Changed files

| File:line | Change |
| --- | --- |
| `connectors/gmail-attachments.mjs:89` | Parsed arguments include configured scanner policy. |
| `connectors/gmail-attachments.mjs:106` | Shared sanitizer/scanner checks each part independently. |
| `connectors/gmail-attachments.mjs:116` | Fixed per-attachment exclusion markers, without raw diagnostics. |
| `connectors/gmail-attachments.mjs:133` | Credential filenames are withheld from metadata before any duplicate or type decision. |
| `connectors/gmail-attachments.mjs:138` | Count, name and decoded-byte admission limits exclude only the affected part. |
| `connectors/gmail-attachments.mjs:170` | Incomplete, text-budget and quality failures preserve readable siblings. |
| `connectors/gmail-attachments.mjs:173` | Credential-bearing extracted attachment text is omitted before assembly. |
| `connectors/gmail-attachments.mjs:189` | No-readable-part credential refusal and safe title for an excluded body. |
| `connectors/gmail.mjs:401`, `connectors/gmail.mjs:439` | Pass scanner policy, classify credential-only refusal, and block missing message MIME. Aggregate quality no longer rejects readable sibling reports. |
| `connectors/gmail.mjs:487` | Explicit body outcome beside attachment outcomes. |
| `brain.mjs:18602`, `brain.mjs:18642` | Pass configured scanner state and account for typed whole-family credential refusals in existing cleanup/cursor logic. |
| `ingest/formats.mjs:607` | Gmail body rendering excludes generated attachment-name headers; local EML/MBOX defaults stay unchanged. |
| `test/gmail-attachments.test.mjs:100` | Exclusion controls, malformed/encrypted/incomplete/bounded parts and body quality cases. |
| `test/gmail-encrypted-pdf.test.mjs:99` | Encrypted PDF is excluded while the body remains. |
| `test/gmail-attachment-resume.test.mjs:121` | Existing blocking stub is explicitly a message MIME gap. |
| `test/gmail-attachment-parts.test.mjs:15` | Real-runner bad original, readable sibling, corrected resend, plus clean and missing-MIME controls. |
| `test/fixtures/gmail-attachment-parts.mjs:28` | Shared real-runner fixture with closed offline routes and snapshot state. |
| `test/gmail-attachment-credentials.test.mjs:19` | Attachment/body/name credential isolation, final scan, body-only refusal and scanner opt-out controls. |
| `test/gmail-incremental-policy.test.mjs:207`, `test/gmail-incremental-policy.test.mjs:248` | Scratch lifecycle root and redacted nonempty-plan diagnostic. |
| `test/gmail-incremental-policy.test.mjs:717` | Missing-MIME history preservation and subsequent provider-recovery controls. |
| `test/fixtures/gmail-incremental-policy-fetch.mjs:2`, `test/fixtures/gmail-incremental-policy-fetch.mjs:64` | Existing ACL doubles and no-migration synthetic credential storage; recovered-MIME fixture mode. |
| `test/google-drive.test.mjs:919` | Existing Gmail assertion now requires missing raw MIME to block history. |
| `test/gmail-attachment-backfill.test.mjs:205` | Three intentionally red M1 requirements and three independent passing controls. |
| `test/fixtures/gmail-attachment-incomplete-mutant.mjs:4`, `test/fixtures/gmail-attachment-credential-mutant.mjs:5` | Updated omission mutant and new per-part credential mutant. |
| `scripts/run-test-chain.mjs:37`, `scripts/run-test-chain.mjs:654` | Register only the two completed green suites; the M1 red suite is deliberately separate. |
| `README.md:908`, `docs/README-developer.md:902`, `docs/ARCHITECTURE.md:420` | Revised part contract and explicit unresolved migration boundary. |
| `manifest.schema.json:233`, `templates/brain.manifest.json:106`, `onboarding/07-ingest-source-matrix.md:122` | Matching Gmail capability descriptions without new instance configuration. |
| `partner-reports/qbo-attach-backfill-design.md:1` | Independent pager/checkpoint design and removal-review risks. |

## Red then green

| Item | Red evidence | Green/control evidence |
| --- | --- | --- |
| R0 | Original host assertion not reproduced. First local attempt failed at sandbox lifecycle-directory access; final repeats reproduced checkpoint `EPERM`. | Four isolated runs before part changes passed 62 checks each. This is insufficient to claim a product fix. |
| B1 | Revised attachment, PDF and runner suites: 18 passed, 22 failed. | Same three suites: 40/40. Clean messages and each format/boundary control pass; bad original and corrected resend both advance history. |
| B1 missing message MIME | Existing compatibility assertion and later policy assertion expected a nonblocking missing raw read. | Updated assertions require the blocking contract, with clean/recovered provider evidence as passing controls. |
| M2 | Credential suite: 3/6. Attachment, body and filename cases discarded the readable family. | 6/6 after implementation, then 7/7 with explicit scanner opt-out control. Final envelope scan and body-only refusal controls remain active. |
| M1 | 3/6 intentionally red: legacy membership hash changes, full-walk scale budget exceeded, saved candidates never resume. | Three controls pass: completed-checkpoint empty history, ordinary new-mail read/send/preview, and dry-run no writes. No M1 green claim. |

The M1 scale checkpoint contains exactly 140,000 synthetic legacy message
entries and three report candidates. Its budget tripwire stops a wrong full
walk after 104 raw reads. Observed counts were fetch=104, send=50, preview=0;
the walk failed before final preview. The ordinary-mail control proves that
the preview counter reaches one. The intended assertion requires exactly the
three candidate reads, sends and previews and no full inventory or ordinary-mail
walk. This is a bounded red probe, not a live scale benchmark.

## Every focused test invocation

Windows, Node v24.18.0. Older assertion scripts appear as one Node test while
printing their internal check counts. No full test chain, install, audit or pack
command was run. The following abbreviations name exact file sets:

- B1 set: `test/gmail-attachments.test.mjs test/gmail-encrypted-pdf.test.mjs test/gmail-attachment-parts.test.mjs`
- Compatibility set: `test/gmail-attachments.test.mjs test/gmail-encrypted-pdf.test.mjs test/gmail-attachment-parts.test.mjs test/gmail-attachment-resume.test.mjs test/gmail-attachment-credentials.test.mjs test/google-drive.test.mjs test/formats-extra.test.mjs test/test-chain-runner.test.mjs`

| Command | Every result in execution order |
| --- | --- |
| `node --test test/gmail-incremental-policy.test.mjs` | Initial attempt: exit 1 before policy cases, sandbox lifecycle-directory permission failure. Isolated runs before part changes 1-4: exit 0, 62/62 each, respectively 50.687 s, 49.128 s, 48.070 s, 47.239 s. First final-code attempt: exit 1 at old pending-absent-unreadable expectation, 17.618 s; original nonempty-plan case passed. Final unchanged-source run 1: exit 1, checkpoint `EPERM` during recoverable Worker retry, 3.875 s. Run 2: exit 1, checkpoint `EPERM` during repeated reset/scanner migration, 42.396 s; new MIME recovery controls passed. Run 3: exit 0, 64/64, 48.028 s. Run 4: exit 0, 64/64, 46.477 s. Final unchanged-source result: 2 failed, 2 passed; no R0 fix claimed. |
| `node --test <B1 set>` | Red: 18/40, exit 1. Green: 40/40, exit 0. |
| `node --test test/gmail-attachment-resume.test.mjs` | 4/4, exit 0. |
| `node --test test/gmail-attachment-credentials.test.mjs` | Red: 3/6, exit 1. Green: 6/6, exit 0. Expanded 7/7 also passed in compatibility set. |
| `node --test test/gmail-attachment-backfill.test.mjs` | 3/6, exit 1 as intentionally retained red evidence. |
| `node --test <Compatibility set>` | 53/54, exit 1 solely at the old no-content Gmail assertion. Completed attachment suites all pass (51 cases); formats-extra 64 internal checks and test-chain-runner also pass. |
| `node --test test/google-drive.test.mjs` | After contract assertion update: exit 0, all 172 internal checks. |
| `node --import ./test/fixtures/gmail-attachment-incomplete-mutant.mjs --test test/gmail-attachments.test.mjs` | Two runs, before and after M2: both 30 passed/3 failed, exit 1. |
| `node --import ./test/fixtures/gmail-attachment-credential-mutant.mjs --test test/gmail-attachment-credentials.test.mjs` | First 5 passed/1 failed with six cases; final 6 passed/1 failed after adding scanner opt-out. Both exit 1. |
| `node --import ./test/fixtures/gmail-attachment-encryption-mutant.mjs --test test/gmail-encrypted-pdf.test.mjs` | 3 passed/1 failed, exit 1. |

## Three named mutants

Each load hook asserts one exact replacement target and prints
`MUTATION_APPLIED`; no product file is changed by a mutant run.

1. `ignore_incomplete_attachment`: removes the incomplete/unreliable-text
   exclusion. Malformed CSV, thin PDF and row truncation kill it. Thirty cases,
   including readable format controls, still pass.
2. `omit_attachment_credential_gate`: removes only the extracted attachment
   scan, leaving the final envelope scanner active. The final scanner then
   discards the entire family, so the credential-attachment/clean-sibling test
   kills it. Six final controls pass, including body-only refusal and the final
   metadata scan.
3. `reject_encrypted_not_forwarded`: removes Gmail's strict PDF option.
   The Gmail per-part encryption case kills it. All three direct parser and
   readable/default-encryption controls pass.

## Static checks, safety and handoff

`git diff --check` passed, with only Git line-ending notices. `node --check`
passed for all 17 changed/new JavaScript modules, tests and fixtures in this
round, with the two policy files checked again after their recovery-control
update. Both edited JSON files parsed. The new-text wording scan passed. Its
first helper could not locate Git with a minimal child environment; the native
shell read-only scan then succeeded. The test-chain-runner test validates the
registered graph without executing the product chain.

Only synthetic fixtures were used; no real account or credential was read.
No Git metadata write, commit or push was attempted. No base-copy write or
base-copy test was performed. Changes are intentionally left in the working
tree for the operator. No release or field acceptance is claimed.

Network-isolation incident: one exploratory envelope probe incorrectly named
its fetch injection `fetch` instead of `fetchImpl`, allowing the transport path
to start with an invented token. It was interrupted before returning a result.
No real credential or source data was supplied, but absence of network activity
cannot be claimed for that probe. All subsequent probes and test routes use
the correct injected boundary and reject unexpected routes locally.

The operator should retain R0 as a blocker until the original host failure has
an identified cause and demonstrated fix. M1 requires the separate capped
candidate implementation and its retained red tests to turn green, including
independent removal review that does not hold normal history. The missing
commit is expected under this sandbox and is not a readiness blocker.

## Prepared commit

Subject: Isolate Gmail attachment exclusions and retain migration blockers

Body: Keep readable message parts when a report is malformed or carries a
credential. Preserve final envelope scanning and add runner, recovery and
mutation controls. Improve policy diagnostics; leave the unclosed regression
and capped-backfill design with explicit failing acceptance probes.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree:

- `node --test test/gmail-attachments.test.mjs test/gmail-encrypted-pdf.test.mjs test/gmail-attachment-parts.test.mjs`: 40 passed, 0 failed.
- `node --test test/gmail-attachment-resume.test.mjs`: 4/4. `node --test test/gmail-attachment-credentials.test.mjs`: 7/7.
- The compatibility set above (eight files, including google-drive, formats-extra and test-chain-runner): 54/54.
- `node --test test/gmail-attachment-backfill.test.mjs`: 3 passed, 3 failed, the three intentionally red M1 tests, as the lane says.
- Mutants: `gmail-attachment-incomplete-mutant` 30 pass / 3 fail, `gmail-attachment-credential-mutant` 6/1, `gmail-attachment-encryption-mutant` 3/1. All three are killed.
- `node --test test/gmail-incremental-policy.test.mjs`: 10 runs, 8 passed and 2 failed. One failure was at "repeating --reset cannot discard Gmail's reviewed denominator or bypass exact approval"; the other's detail was not captured. This is the same suite and Windows checkpoint behavior the lane reports; the original Mac failure is not reproduced here.

Network incident, checked from the lane log: the probe called `toEnvelope` with `fetch:` instead of `fetchImpl:`. The Google API helper therefore used the real global fetch for one GET to `https://gmail.googleapis.com/gmail/v1/users/me/messages/credential-refused?format=raw` with the header `authorization: Bearer fixture`. The fake credential string was only in the mocked response the probe meant to inject, not in the request. The probe exited 1 after 12.8 s with no output, so whether the request left the machine is unknown. No real token, account or owner data was involved. Later lane runs must load a local fetch guard for every ad-hoc probe.

Names and banned-word scan of every added line and new file: none. Fixture addresses use `example.invalid`. The operator made the prepared commit unchanged. No code was edited by the operator.

LANE QBO-ATTACH-0420-2: NOT READY R0 root cause unproven; M1 remains design plus failing red tests only
