# WIN-OWNER-PC-2

Working branch: `partner/win-owner-pc-2`. Starting commit: `5618681`.

The smallest product fix is ready for operator review. The native long-path
regression was red before the fix and green afterward. Removing the prefix
kills that regression again. The guide-level tests remain visibly blocked by
the sandbox's profile-root realpath restriction; unrestricted verification is
still required. All changes remain in the working tree. No commit or push was
attempted, as required by this run's read-only Git boundary.

## Changes

| File:line | Change |
| --- | --- |
| `operations/claude-workspace.mjs:320` | Inside `WINDOWS_ATTRIBUTES_SCRIPT`, derive an extended-length attribute path. Drive paths use `\\?\`, UNC paths use `\\?\UNC\` after removing the original two leading backslashes, and existing `\\?\` paths stay unchanged. Only `GetAttributes` receives this derived spelling. |
| `test/claude-workspace-windows-long-path.test.mjs:37` | Real short-path attribute control under `%TEMP%`. |
| `test/claude-workspace-windows-long-path.test.mjs:44` | Real file longer than 260 characters, created through Node, checked together with its parent folders. This does not walk the profile ancestors. |
| `test/claude-workspace-windows-long-path.test.mjs:54` | Already-prefixed long-path control. |
| `test/claude-workspace-windows-long-path.test.mjs:60` | Mandatory directory-junction refusal with a passing ordinary-target control. |
| `test/claude-workspace-windows-long-path.test.mjs:70` | Short and long managed `CLAUDE.md` refreshes with `existingOnly: true`. The long workspace exceeds 118 characters; their deepest retained-file paths straddle 260 characters. Both require `written`, installed guide content, and exact preserved original bytes. Native ancestry checks remain active. |
| `scripts/run-test-chain.mjs:296` and `scripts/run-test-chain.mjs:455` | Register the new focused test in both explicit command lists so future CI cannot omit it. The chain itself was not run. |
| `partner-reports/win-owner-pc-2.md:1` | Round 2 evidence and prepared commit. The round 1 report is unchanged. |

The checked path list, reparse-point refusal, timeout, stdin JSON escaping,
allowlisted child environment, and exact readback contract are unchanged.
The product change is confined to `operations/claude-workspace.mjs`.
All six new tests explicitly skip off win32. UNC conversion was reviewed in
source; no network share was accessed under this lane's network prohibition.

## Red, green, and mutant evidence

Before editing the product, the four native attribute tests returned 3 pass,
1 fail, exit 1. The long real path failed at line 51 with `false !== true`.
The short path, already-prefixed path, and junction refusal passed. The
junction test also proved that the same regular target without the junction
was accepted. This isolates the bug without relying on the profile root.

After the script change, all four native attribute tests passed. The full new
file returned 4 pass and 2 fail solely at the guide tests' `written` assertion:
both returned `preserved_unsafe_existing_file` before reaching the attribute
boundary. The same two guide assertions failed before the product edit.

**MUTANT_ATTRIBUTE_PREFIX_REMOVED**: temporarily remove the added normalization
block and pass the original `$path` to `GetAttributes`. Run the same four-test
attribute selection. Result: exit 1, 3 pass, 1 fail. Only the unprefixed long
real path fails with `false !== true` at line 51; all controls still pass.
Restore the exact original product bytes in `finally` and verify byte equality.
Rerunning that selection then returns exit 0, 4 pass, 0 fail. The mutant is
killed by the requested core regression, not by a sandbox restriction.

The new test also exposed its missing explicit registration before that was
edited: `test-chain-complete` failed with one orphaned candidate test. Adding
both list entries made the completeness test green; the runner contract also
passed without changing the original command order.

## Test ledger

Every row is one invocation. Counts are pass/fail/skip. Commands in this table
use `node --test --test-reporter=tap`; the additional arguments and file follow.

| Additional arguments and focused file | Stage | Counts | Exit |
| --- | --- | --- | ---: |
| `--test-name-pattern='Windows workspace attributes' test/claude-workspace-windows-long-path.test.mjs` | Before product fix | 3/1/0 | 1 |
| `--test-name-pattern='Windows managed Claude guide' test/claude-workspace-windows-long-path.test.mjs` | Before product fix; sandbox ancestry refusal in both arms | 0/2/0 | 1 |
| `test/claude-workspace-windows-long-path.test.mjs` | After product fix; native core green, guide arms sandbox-blocked | 4/2/0 | 1 |
| `--test-name-pattern='Windows workspace attributes' test/claude-workspace-windows-long-path.test.mjs` | Prefix-removal mutant | 3/1/0 | 1 |
| `--test-name-pattern='Windows workspace attributes' test/claude-workspace-windows-long-path.test.mjs` | Exact product bytes restored | 4/0/0 | 0 |
| `test/technician-setup.test.mjs` | Requested once-only rerun | 33/3/0 | 1 |
| `test/owner-contract-workspace.test.mjs` | Requested once-only rerun | 55/122/28 | 1 |
| `test/test-chain-complete.test.mjs` | Before registering new test | 0/1/0 | 1 |
| `test/test-chain-complete.test.mjs` | After registration; all five internal checks pass | 1/0/0 | 0 |
| `test/test-chain-runner.test.mjs` | Command-list and bounded fixture-runner verification only | 1/0/0 | 0 |

The technician file's three failures are guide creation, unrelated-guide
preservation, and managed refresh. The owner-workspace file shows native
ancestry refusals and downstream missing-guide or unreached race-hook
assertions. Its native regular-folder/junction smoke test and injected probe
protocol tests pass. Both requested suite counts match the round 1 restricted
sandbox run. These are not unrestricted-host green claims.

The two complete-file logs are local only:

- `%TEMP%\win-owner-pc-2-technician-setup.log`
- `%TEMP%\win-owner-pc-2-owner-contract-workspace.log`

A single ad-hoc Node realpath probe loaded
`--import file:///C:/offload/lanes-1023/no-network.mjs` and printed
`LANE_NETWORK_GUARD_ACTIVE`. It returned exit 0 with temporary-root realpath
passing and profile-root realpath returning `EPERM`. It printed no actual
profile path and removed its own temporary fixture. No ownership check was
bypassed to turn a guide test green.

Syntax checks each passed with exit 0 using
`node --import file:///C:/offload/lanes-1023/no-network.mjs --check` for:

- `operations/claude-workspace.mjs`
- `test/claude-workspace-windows-long-path.test.mjs`
- `scripts/run-test-chain.mjs`

`git diff --check` passed. Final added-line scans found zero matches for the
private names under review, profile paths, email addresses, key literals,
prohibited wording, or em dashes. No package install, full suite, release chain, real Brain,
Cloudflare call, credential operation, network access, Git mutation, or push
was performed. All test processes finished before 07:15 MST on 2026-10-24,
well before the 14:00 cutoff.

## Owner commands and exact result

The shared writer serves `brain setup` and `brain update` for the Claude
`CLAUDE.md` and Codex `AGENTS.md` workspace guides. For an affected write in a
long workspace, the old native attribute check could fail after installing the
new guide, returning `status: "not_written", changed: false` at the final
retained-file readback. The corrected check can complete that exact readback
and return `status: "written", changed: true`.

The before warning at `brain.mjs:29661` is exactly:

```text
The <filename> guide was not written because a local write failed, its folder or file changed, or another refresh holds its lock. The staged guide is retained at <pendingPath>. The earlier file is retained for recovery at <recoveryPath>. Review the local guide before retrying its refresh.
```

The staged and earlier-file sentences appear only when their respective paths
are returned. `<filename>` is `CLAUDE.md` or `AGENTS.md`. Update appends:
`The Brain software update remains verified.`

After a successful affected setup write, the existing success copy at
`brain.mjs:22576` or `brain.mjs:22601` is:

```text
Claude Code owner workspace ready at <path>
Codex owner workspace ready at <path>
```

The existing successful update-writer branch at `brain.mjs:29741` prints:

```text
existing Financial Brain <filename> refreshed with the answer rules in <folder>; open <assistant> in that folder for Brain conversations
```

This patch changes no owner-facing strings. Two boundaries prevent overstating
that before/after behavior:

- The Windows wrapper at `brain.mjs:29705` preserves guides already present
  before entering the writer. Its result remains `kept_existing_windows_guide`,
  with the existing notice: `On Windows, this <action> leaves your assistant's workspace guide as it is. Refreshed answer rules arrive in the next version.`
  The fix benefits setup creating missing guides and update paths that enter
  the writer, including verified missing Codex-guide creation beside a safely
  managed Claude guide. Direct managed refresh is covered by the new guide
  tests, but ordinary Windows refresh of existing guides is still deferred.
- Successful writes deliberately keep the retained staging and original inode
  for recovery (`operations/claude-workspace.mjs:463` and
  `docs/README-developer.md:2192`). This fix corrects verification and reporting;
  it does not delete retained directories.

## Operator verification

Run `node --test test/claude-workspace-windows-long-path.test.mjs` outside the
restricted sandbox as a normal Windows user with a short `%TEMP%` root. Both
managed refresh arms must return `written`; neither is skipped or weakened
here. The test explicitly rejects a too-long short-control fixture. Rerun the
two requested existing suites there as well. This lane's readiness is for the
bounded product patch and its recorded core proof, not live deployment or
unrestricted guide-write certification.

## Prepared commit

Subject: `fix: support long Windows workspace guide paths`

Body:

```text
Prefix native attribute reads for drive and UNC paths while retaining reparse refusal.
Add Windows long-path controls and managed-guide refresh coverage to the test graph.
Record the killed prefix-removal mutant and sandbox-limited focused results.
```

## Operator note

The Codex sandbox blocked the guide-level tests (EPERM on native profile and ACL calls). So the operator (Claude Code) verified outside it, as a normal non-elevated user, in the same profile-shaped fence whose longer root path reproduced the original failure every time:

- `node --test test/claude-workspace-windows-long-path.test.mjs`: 6/6, including the guide refresh in a long workspace.
- `node test/technician-setup.test.mjs`: 36/36. In this fence the unfixed tree failed exactly 1 case ("update refreshes only an existing installer-managed Claude workspace guide").
- `node --test test/owner-contract-workspace.test.mjs`: 177 pass, 28 skipped, 0 fail.
- An independent in-memory mutant that removes only the drive-path prefix line: the new test drops to 4 pass / 2 fail (the long-path attribute test and the long-workspace guide refresh), and technician-setup fails its original case again. Killed.
- `node --test test/test-chain-runner.test.mjs test/test-chain-complete.test.mjs`: 2/2.
- Names, banned-word, email, user-path and key scan of every added line and new file: none.

The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE WIN-OWNER-PC-2: READY
