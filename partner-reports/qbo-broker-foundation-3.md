# QBO-BROKER-FOUNDATION-3 report

All three requested items are complete. The final eleven-file command passed
**134 tests, 0 failures, 0 skips, 0 TODOs**. The two graph checks passed **2/2**
and confirmed that all **460** inventoried test files are scheduled, with no
exemptions. All three new named mutants are killed. Production remains closed.

Observed branch: `partner/qbo-broker-foundation-3`. Starting commit: `4a2bb66`.
The prior two foundation reports, read-only external design contract and
repository contributor documentation were consulted before implementation.
Item 1 was fixed and verified before implementation of items 2 and 3.

Every change remains in the working tree for the operator. No Git write,
commit, push, dependency installation, full test chain, release command, real
account, real provider, external DNS or network action ran. Every Node command
loaded the mandatory network guard. Provider transport remains injected into
the in-memory fake. No tree copy or new scratch artifact was created. Existing
test helpers use `%TEMP%` for their synthetic scratch files. Final test runs
finished around 06:53 MST on 2026-10-24, before the 14:00 cutoff.

## Changed files

| File and line | Change |
| --- | --- |
| `scripts/run-test-chain.mjs:7` | Admit only the exact new broker test and protocol testing/probe folders. Line 11 defines the eleven-file command; lines 18 and 313 register it in both command lists. |
| `test/qbo-broker-protocol.test.mjs:12` | Independent eleven-file inventory, exact-once positive coverage, publication exclusion and narrow module-admission controls. Line 52 kills the omitted-command mutant. |
| `broker/quickbooks/src/broker.mjs:148` | Serialize one enrollment delivery, then retry identical bytes at most three times within ten seconds and the challenge deadline. Exact status acknowledgement is required. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:99` | Hash canonical enrollment delivery, retain the exact acknowledgement with the consumed challenge, atomically save and read back both records, and replay without another save. Recheck after asynchronous encryption prevents concurrent duplicate saves. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:33` | Partial expiry index for pending intents. Line 169 implements bounded expiry with key destruction and exact transactional readback; line 422 invokes it from authenticated status; line 438 exposes safe inspection counts. |
| `broker/quickbooks/test/broker-security.test.mjs:19` | Real owner/broker enrollment fixture using injected fake transport. Lines 66, 85, 99 and 109 cover lost acknowledgement, changed delivery, expiry, bounded transport failure, concurrent duplicate delivery and rollback/recovery. Line 120 runs the acknowledgement mutant. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs:517` | Shared stored-key expiry invariant. Line 528 tests unavailable delivery and invalid callback at the deadline; line 560 checks bounded backlog and readback recovery; line 582 runs the key-retention mutant. |
| `broker/quickbooks/README.md:64` | Explain acknowledgement persistence/replay and bounded retries. Line 101 documents graph registration; the following fixture section describes status-triggered expiry and its deployment boundary. |
| `protocol/quickbooks-broker/README.md:24` | Current twelve-test probe scope and positive eleven-file graph registration. |
| `protocol/quickbooks-broker/probes/README.md:21` | Replace explicit-only graph claims, add expiry/recovery/mutant inventory at 46, safe inspection fields at 151, and readback faults at 177. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:167` | Clarify canonical enrollment hash, exact replay and retry bound. Line 323 describes verified bounded expiry; line 491 updates integration evidence. |
| `docs/README-developer.md:2023` | Update the offline integration test count. |
| `partner-reports/qbo-broker-foundation-3.md:1` | This evidence and prepared commit. |

No deployed owner route, product migration, schema catalog, CLI, manifest,
connector availability, package version, publication allowlist or public
changelog changed. The owner runtime remains a test-only SQLite fixture.

## Requested fixes and red-to-green evidence

### 1. Test graph blocker

The first new regression run reported eight orphaned broker test files. The
positive coverage and new-folder admission checks also failed. That group was
72 passed and 4 failed. Replacing the wrapper-only command in both lists with
the exact eleven-file command and narrowly extending module admission produced
76/76 passing tests, including the unchanged completeness check and runner
legacy-order verification. The original 172-command projection remains intact.

The protocol wrapper now asserts positive coverage for all eleven files,
including privacy and E2E files outside the completeness discovery pattern.
Every file must be scheduled exactly once. The eight broker files remain in
the normal completeness inventory; no exemption was added. Valid module
admission precedes rejection of runtime, sibling and traversal paths.

### 2. Enrollment acknowledgement replay

The lost-acknowledgement regression first returned 503 instead of 202; the
bounded-delivery test saw only one attempt instead of three. An initial
concurrency assertion lacked a save observation, so that first failure alone
was not treated as proof of duplicate saves. After adding an observation at
the existing write without changing behavior, the test measured two actual
saves instead of one. Both security runs were 6 passed and 3 failed.

The owner now stores the canonical delivery hash and exact status-only
acknowledgement with the consumed challenge, in the same transaction as the
encrypted installation record. Both records require exact readback before
consumption and acknowledgement. An identical delivery replays the saved
acknowledgement, including after challenge expiry; changed bytes refuse.
Asynchronous encryption is followed by another consumption check before the
synchronous transaction, preventing concurrent identical saves.

The broker mints and fences one voucher, serializes once and permits at most
three identical delivery attempts in the same invocation, within ten seconds
and the challenge deadline. It never repeats provider exchange or issues a
second voucher to recover an acknowledgement. The first implementation run
passed 9/9 security tests. Added readback and mutant checks passed in the
23/23 combined security/E2E run and the final aggregate.

The lost-acknowledgement control proves two byte-identical deliveries, one
voucher issuance, one committed owner save and one replayed acknowledgement.
Both acknowledgements have identical bytes and only protocol, outcome and
install fingerprint. Persistent unavailability or three lost replies return
failure after three attempts. Failed readback rolls back consumption and
installation; a later identical delivery can recover without a consumed key.

This fixture proves replay during the requested same-invocation retry. It does
not prove replay across an owner restart or a later enrollment ceremony; the
fixture still has one in-memory pending challenge and one stored receipt.

### 3. Pending-intent expiry and key destruction

The first two expiry probes failed because the safe key/count observations did
not yet exist. After adding only those observations, both still failed on the
actual behavior: overdue intents did not expire, and a readback fault could not
refuse status. The focused run was 0 passed and 2 failed at each stage.

Authenticated status now selects at most 32 overdue pending intents through
an expiry index. Each is marked expired with both temporary keys set to null,
and the exact stored record is read back inside the same transaction. Failed
readback rolls back the batch and refuses status. Older pending rows remain
eligible for later polls. This is status-triggered fixture cleanup, not a
background scheduler or deployed owner integration.

Unavailable delivery reaches one fake exchange and one in-memory revoke;
invalid callback reaches callback validation with zero exchange. Both leave a
pending owner intent. Status at 599999 ms preserves both keys and pending
state. At exactly 600000 ms it reports expired and proves both stored keys are
gone, with no outbound transport. A 33-intent backlog proves rollback on
readback failure, then batches of 32 and 1, followed by an idempotent terminal
poll. The two probes passed 2/2 after implementation, and the complete E2E file
passed 12/12 after the source mutant was added.

## Complete focused test inventory

These are report abbreviations, not shell aliases. Every invocation is listed
in execution order within its command row. All runs had zero skips and TODOs.

| Symbol | Exact expansion |
| --- | --- |
| `N` | `node --import file:///C:/offload/lanes-1023/no-network.mjs` |
| `Q` | `test/qbo-broker-protocol.test.mjs` |
| `G` | `test/test-chain-complete.test.mjs` |
| `R` | `test/test-chain-runner.test.mjs` |
| `B` | `broker/quickbooks/test/broker-security.test.mjs` |
| `E` | `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` |

| Command | Every observed result, passed/failed |
| --- | --- |
| `N --test Q G R` | 72/4 graph red; 76/0 after registration and allowlist fix. |
| `N --test B` | 6/3 initial enrollment regressions; 6/3 after observation-only instrumentation confirmed duplicate saves; 9/0 after implementation. |
| `N --test --test-name-pattern="E2E pending" E` | 0/2 missing observations; 0/2 behavioral red with observations; 2/0 after cleanup. |
| `N --test --test-name-pattern="E2E pending\|OVERDUE_INTENT_KEEPS_KEYS" E` | 3/0 after mutant; 3/0 after explicit callback/exchange/revoke witness assertions. The backslash in this table only escapes the Markdown separator; the shell pattern is `E2E pending` or `OVERDUE_INTENT_KEEPS_KEYS` joined by a literal pipe. |
| `N --test E` | 12/0 after expiry and mutant implementation. |
| `N --test B E` | 23/0 after enrollment readback and mutant checks. |
| Final eleven-file command below | 134/0, including 74 protocol-wrapper tests and 60 broker/privacy/E2E tests. |
| `N --test G R` | Final 2/0; completeness confirms all 460 inventoried files, zero exemptions. |

The final eleven-file command was:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
```

It was followed by:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs
```

Guarded `N --check <file>` passed once for each of the six changed JavaScript
files: runner, protocol wrapper, broker handler, broker security tests, owner
runtime and E2E probes. `git diff --check` passed. Added-line language/path and
private-material checks passed. No generated or unrelated artifact appears in
the changed-file list.

## New named mutants

All three execute in the final eleven-file command. Each first passes the same
invariant against the unmodified implementation or graph.

| Mutant | Alteration and observed kill |
| --- | --- |
| `BROKER_GRAPH_OMITTED` | Replace the eleven-file graph entry with the former wrapper-only command, separately in either graph list. The same positive coverage oracle rejects both mutated graphs. This cannot be satisfied by exempting the eight broker files. |
| `ENROLLMENT_ACK_NOT_REPLAYED` | Load actual owner source with both consumed-delivery replay branches changed to refusal. The real lost-acknowledgement control passes; the mutant fails that same assertion after one save and three delivery attempts. |
| `OVERDUE_INTENT_KEEPS_KEYS` | Load the actual owner source and adapter after removing only the expiry assignments that null both keys. The real runtime passes; the mutant fails the same stored-key expiry invariant after the passing pre-deadline control. |

## Mapping the round 1 references

| Supplied round 1 anchor | Current mapping |
| --- | --- |
| `broker/quickbooks/src/broker.mjs:141-156` | Issuance still begins at 124; voucher mint/fence precedes the new identical-delivery loop at 148. Delivery verification ends before the delivered audit at 169. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:95-114` | `receiveVoucher` begins at 99; canonical hash/replay, atomic consumed receipt and readback now occupy this expanded function before `newIntent` at 147. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:351-360` | Owner dispatch begins at 410, challenge handling at 414, voucher dispatch at 419, and authenticated status cleanup at 422. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:117-137` | `newIntent` begins at 147 and retains the ten-minute deadline; bounded cleanup follows at 169. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:376-389` | `inspect` begins at 438 and now includes stored temporary-key, pending and expiry-readback counts. |

## Prepared commit

Subject: `Register broker tests and repair enrollment replay and intent expiry`

Body:

```text
Register the complete offline broker foundation in both test command lists.
Replay exact enrollment acknowledgements with bounded identical delivery
retries and atomic owner readback. Expire pending owner intents in verified
batches and destroy both temporary keys.

Record 134 focused tests plus two graph checks, 460 scheduled inventory files,
and three killed mutants. Keep production and real-account gates closed.
```

The operator can rerun the focused commands and commit these working-tree
changes on `partner/qbo-broker-foundation-3`. No commit or push was attempted
under the read-only Git instruction. No requested item remains unfinished.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree: the eleven-file command with the network guard gave 134 passed, 0 failed, with the guard active and nothing blocked. `node --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs` gave 2 passed, 0 failed. The new mutant tests run inside those commands and pass, so each was killed. Names, banned-word, email, user-path and key scan of every added line and new file: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION-3: READY
