# WIN-OWNER-PC

Working branch: `partner/win-owner-pc-1`. Starting commit: `f8a7cd05`.

The fixture portability changes are prepared, but this lane is not ready. The
restricted execution sandbox prevents native profile-path and ACL checks from
completing. The historical technician refresh result of `not_written` remains
unexplained: it did not reproduce in the bounded diagnostics. No product fix is
claimed. All changes remain in the working tree for the operator.

## Seven-file classification

| File | Class | Cause | Change |
| --- | --- | --- | --- |
| `test/quickbooks-desktop-connect.test.mjs` | Privileged test fixture; additional fixture environment assumption | File symlink creation requires privilege. The test also assumed `HOME` exists on Windows. | Keep native ACL/readback coverage; independently exercise a normal-file control, hard link, leaf junction, and parent junction through an injected ACL boundary. Gate only the file-symlink arm. Use test-owned `%TEMP%` roots. |
| `test/older-release-paused-resume.test.mjs` | Privileged test fixture and fixture cleanup defect | Top-level dependency directory symlink fails with `EPERM`, before `after()` can clean copied releases. Lifecycle fixtures also lacked a synthetic machine-lock root. | Use Windows junctions with exact target readback and an executed-branch assertion. Clean every registered release on setup failure, test failure cleanup against a successful control, and inject a scratch lifecycle-lock root. |
| `test/technician-setup.test.mjs` | Profile-dependent fixture; historical refresh cause unresolved | Direct writers assumed `%TEMP%` was inside the profile. Here the layout is correct, but native realpath of the profile root is denied. The previously reported `not_written` was not reproduced. | Inject only the fixture's profile at all five guide writes. Keep native path and attribute checks. No product change. |
| `test/owner-contract-workspace.test.mjs` | Privileged fixtures and dropped fixture ownership options | Symlink creation stopped later arms. Two updater/setup controls dropped the existing ownership injection. | Independent subtests, mandatory hard-link/junction/dangling-junction arms, explicit execution assertions, narrowly gated file symlinks, and restored ownership injection. |
| `test/machine-prep.test.mjs` | Privileged test fixtures | File symlinks at npm leaves need privilege. Additional evidence fixtures could fail before their intended refusal decision. | Preserve symlink arms for elevated CI; add mandatory CLI/shim and evidence junction arms, assert fixture completion, retain controls and assertions, and move scratch roots to `%TEMP%`. |
| `test/health-verify-exit.test.mjs` | Platform-specific assertion bug | Two assertions expect POSIX bare `brain`, while Windows correctly prints `brain.cmd` or the quoted Node command. | Return the scenario manifest path and compare both messages using the product's `renderCliCommands(HEALTH_NEXT_STEP(...))`. Product unchanged. |
| `test/upgrade-bookmark-windows.test.mjs` | Original fence artifact; current native sandbox restriction | Original fence ACLs lacked the permissions of a normal profile. This run again receives native `set-failed` despite profile-shaped TEMP. | No change: an unrestricted normal-profile rerun is required before inferring a product defect. |

File-symlink skips require all three conditions: `process.platform === 'win32'`,
error code `EPERM`, and `process.env.GITHUB_ACTIONS !== 'true'`. Every skip states
why. CI still requires successful symlink creation. Directory dependency links
retain their POSIX arm. Native security checks were not relaxed or skipped.

## Changed locations

- `test/quickbooks-desktop-connect.test.mjs:171`: native ACL/readback control.
- `test/quickbooks-desktop-connect.test.mjs:192`: independent link refusal test,
  passing normal-file control, and mandatory owner-PC arms; execution assertions
  at line 243. The public lock fixture uses its own temporary root at line 291.
- `test/older-release-paused-resume.test.mjs:67`: registered release cleanup;
  setup failure wrapper at line 73; dependency junction/readback at line 99;
  branch proof at line 126; cleanup regression at line 133; synthetic machine
  lock root at line 422.
- `test/technician-setup.test.mjs:44`: fixture ownership profile; writer injection
  at lines 399, 478, 494, 512, and 530.
- `test/owner-contract-workspace.test.mjs:272`: independent refusal arms and
  setup control; updater injection at line 837; independent sibling arms at
  line 1007; setup writer injection at line 1490.
- `test/machine-prep.test.mjs:70`: temporary-root allocation, repeated at the
  other scratch allocation sites; symlink gate at line 95; npm junction cases
  at line 1902; evidence junction cases at line 2621; fixture completion proof
  at line 2673.
- `test/health-verify-exit.test.mjs:445`: return the bound manifest path;
  platform-rendered assertions at lines 622 and 641.
- `partner-reports/win-owner-pc.md:1`: this report.

## Native restrictions and technician investigation

A guarded probe confirmed that `%TEMP%` is inside `%USERPROFILE%`. Nevertheless,
`realpathSync.native(os.homedir())` returns `EPERM` in this sandbox. A newly
created temporary root resolves normally. The guide ownership walk therefore
refuses at the profile ancestor before reaching its native attribute probe.
Several native ACL tests also lose access to their own synthetic files after
protection, preventing readback or recursive cleanup. These are visible test
failures, not evidence that a normal unrestricted owner has the same defect.

The technician investigation used a temporary diagnostic substitution only for
that denied profile-root realpath. It retained real filesystem writes and native
Windows attribute checks. The selected three tests passed; the complete file
passed 36/36 with 29 diagnostic substitutions. The managed refresh returned
`written` after about 6.6 seconds. A separate direct refresh completed all 15
native attribute checks and all renames. A synthetic POSIX-ownership probe also
returned `written`. None of these diagnostic substitutions is in the patch,
and none establishes unrestricted native-host proof.

The historical `not_written` cause is still unresolved. The operator needs an
unrestricted rerun and failure-stage tracing if it recurs. Do not describe it as
fixed by profile injection. The Windows wrapper at `brain.mjs:29705` deliberately
preserves existing guides for owner setup/tools/update calls, so the direct
existing-guide refresh case is bypassed by those Windows owner paths. No owner
command defect was established in this lane.

The outside-profile reason for the messages at `brain.mjs:22583` and
`brain.mjs:22608` cannot apply to the ordinary `%USERPROFILE%\Financial Brain`
layout. Those messages were left unchanged. The sandbox's denied ancestor read
is a separate reason for refusal and does not establish an ordinary-layout
owner defect.

## Red-then-green evidence

| Fix | Red evidence before the fix | Passing evidence and remaining limit |
| --- | --- | --- |
| Binding link fixture | Supplied classification records file-symlink `EPERM`; this lane first found unset `HOME`, then native cleanup `EPERM`. | Independent link test passes its normal-file control, hard-link refusal, leaf-junction refusal, and parent-junction refusal. All three owner-PC branches are asserted. File symlink skips with a reason. Native ACL test remains present and red in this sandbox. |
| Release junction and cleanup | Baseline module-load `EPERM`, 0 pass/1 fail. A guarded probe found and removed the newly leaked release copy. | Selected junction and cleanup tests pass 2/2. Dependency target is read back exactly. Failed setup removes both an earlier successful allocation and a partial allocation; successful setup retains its fixture. Cleanup mutant is killed. |
| Workspace link fixture | Supplied classification records all three symlink failures; this sandbox additionally rejects profile ancestry before the controls. | All six mandatory e/f/h link/junction/dangling-junction arms pass; four file-symlink arms explicitly skip. Missing/setup and unrelated controls remain present but fail at the sandbox ancestry gate, so full green proof is incomplete. |
| Fixture ownership injection | Baseline selected technician cases fail 0/3, and raw updater/setup controls also encounter unsafe-path refusal. | Diagnostic technician run passes 36/36. Ordinary native run still fails three guide tests. No native green claim. |
| Machine-prep link fixtures | Baseline npm refusal selection: 5 pass, 2 symlink failures. | Both new npm junction creation assertions execute; refusal decisions and regular controls run. Seven selected cases then fail when native logging does not produce a readable `prep.log`; two file-symlink cases skip. Full green proof is incomplete. |
| Health rendering | Guarded in-process `cmdHealth` probe shows both old POSIX assertions reject the actual Windows output. | The same real command output passes the new rendered, manifest-bound comparison, missing-key warning control, and query-ready control. Full file stops earlier at synthetic cleanup `EPERM`. |

No product fix was made without a failing product regression test. The changed
scope is test fixtures and assertions only.

## Named mutants

1. **MUTANT_BINDING_ACCEPTS_HARD_LINK**: temporarily remove only
   `st.nlink !== 1` from the binding leaf guard. Run
   `node --test --test-name-pattern='binding rejects links' test/quickbooks-desktop-connect.test.mjs`.
   The green control had 4 pass/0 fail/1 skip. The mutant returns exit 1,
   2 pass/2 fail/1 skip, with `Missing expected rejection` at the hard-link
   rejection assertion, and the parent execution assertion also fails. Exact
   product bytes were restored in `finally`; the restored selection passes
   4/0/1. The product diff is empty.
2. **SCRATCH-CLEANUP-REMOVED**: temporarily remove only catch-path cleanup from
   `withScratchCleanup`. Run
   `node --no-warnings --test --test-name-pattern='scratch setup failure' test/older-release-paused-resume.test.mjs`.
   The mutant returns exit 1, 0 pass/1 fail, with `true !== false` at the retained
   directory assertion. The test's own `finally` cleans the mutant fixtures.
   Exact source was restored; the junction plus cleanup selection passes 2/2.

## Test ledger before the final run

Counts below are pass/fail/skip. Each full-file invocation is still one focused
file, never the test chain.

| Command or selection | Runs and result |
| --- | --- |
| `node --test --test-name-pattern='binding is owner-only' test/quickbooks-desktop-connect.test.mjs` | Before edits: 0/1/0, unset `HOME`. Repeated with `HOME=%TEMP%`: red, native cleanup `EPERM`. |
| `node --test --test-name-pattern='e/f/h\|Codex update requires' test/owner-contract-workspace.test.mjs` | Before edits: 0/3/0, profile ancestry refusals. |
| `node --test test/quickbooks-desktop-connect.test.mjs` | After initial edits: 23/1/0, native cleanup `EPERM`. |
| `node --test test/owner-contract-workspace.test.mjs` | After initial edits: exit 1; count summary was not retained. No green claim. |
| `node --test --test-name-pattern='binding rejects links' test/quickbooks-desktop-connect.test.mjs` | Three unmutated runs: each 4/0/1. One mutant run: 2/2/1. |
| `node --test --test-name-pattern='e/f/h' test/owner-contract-workspace.test.mjs` | After split: 6/6/4; mandatory refusal arms pass; controls and parent results fail. |
| `node --no-warnings --test test/older-release-paused-resume.test.mjs` | Baseline: 0/1/0. After junction/cleanup: 8/24/0, unfenced machine-lock root. After scratch lock-root injection: 8/24/0, native ACL/access and cleanup failures. |
| `node --test --test-name-pattern='Windows standard npm layout refuses unsupported files' test/machine-prep.test.mjs` | Baseline: 5/2/0. After edits: 0/7/2, missing native diagnostic log after decision assertions. |
| `node --no-warnings --test --test-name-pattern='scratch setup failure' test/older-release-paused-resume.test.mjs` | Cleanup mutant: 0/1/0. |
| `node --no-warnings --test --test-name-pattern='scratch releases use\|scratch setup failure' test/older-release-paused-resume.test.mjs` | Restored source: 2/0/0; prints `scratch_dependency_link_type=junction`. |
| `node --test --test-name-pattern='update refreshes only an existing installer-managed Claude workspace guide\|setup can create an owner-only Claude workspace guide\|an unrelated Claude workspace guide' test/technician-setup.test.mjs` | Baseline: 0/3/0. Guarded diagnostic equivalent: 3/0/0. |
| `node --test test/technician-setup.test.mjs` | After edits, ordinary execution: 33/3/0. Guarded full-file diagnostic equivalent: 36/0/0. An earlier diagnostic run had no retained completion result; no result is claimed for that run. |
| `node --test test/health-verify-exit.test.mjs` | Baseline attempt: outer file 0/1/0; cleanup `EPERM` prevents reaching the two assertions. |
| `node --test test/upgrade-bookmark-windows.test.mjs` | Baseline: 9/7/1; all seven failures report native ACL `set-failed`. |

Every ad-hoc Node probe used
`--import file:///C:/offload/lanes-1023/no-network.mjs`; stdin probes also used
`--input-type=module -`. Focused test files used their closed fixture routes.
The health probe injected the inspected `request` boundary, `resolveKey`, and
`wait`. Its first version incorrectly matched `/health` without the cache-buster
query and was rejected by the public receipt validator; the corrected version
passed both rendering checks and both controls. A filesystem probe passed
temporary-root realpath and temporary cleanup while reporting profile-root
realpath `EPERM`.

Other probes: corrected guarded environment/ownership probes isolated the
profile denial; a corrected guarded release-cleanup probe removed the newly
leaked baseline copy. Three preliminary inline probe attempts had quoting
syntax errors and did not execute their scripts. One mutation precondition
failed before editing or running the mutant. Two scratch-script commands were
rejected by automatic tool policy before execution; safe stdin alternatives
were used. None is counted as a passing test.

## Final seven-file run

Each command is
`node --test --test-reporter=tap test/<file>.test.mjs`.
Logs are local at `%TEMP%\win-owner-pc-final-<file>.log`; logs are not committed.

| File | Pass | Fail | Skip | Exit | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `quickbooks-desktop-connect` | 27 | 1 | 1 | 1 | Native fixture cleanup `EPERM`; independent owner-PC link arms pass. |
| `older-release-paused-resume` | 8 | 24 | 0 | 1 | Native lifecycle ACL/access and cleanup restrictions. Junction and setup-cleanup regressions pass. |
| `technician-setup` | 33 | 3 | 0 | 1 | Profile-root realpath denial; historical `not_written` not reached. |
| `owner-contract-workspace` | 55 | 122 | 28 | 1 | Native ancestry refusal blocks managed-guide controls; existing platform skips plus five new explicit symlink skips. |
| `machine-prep` | 39 | 17 | 51 | 1 | Missing native diagnostic logs and ACL/evidence readback failures under the sandbox; four explicit file-symlink skips plus existing platform skips. |
| `health-verify-exit` | 0 | 1 | 0 | 1 | Outer file stops at synthetic cleanup `EPERM`. |
| `upgrade-bookmark-windows` | 9 | 7 | 1 | 1 | Native ACL `set-failed`; elevated-owner case skips as expected. |

All test processes finished by 06:55 MST on 2026-10-24, before the 14:00 cutoff.
The machine-prep final run took 68.9 seconds. No test process remains running.

`node --import file:///C:/offload/lanes-1023/no-network.mjs --check` passed for
all six edited test files. `git diff --check` passed, including both agents'
focused diff checks. Chain lists were not changed, so the two chain-list tests
were not run. No package install, full suite, live account, provider request,
credential operation, Git mutation, commit, or push was performed.

Some synthetic `%TEMP%` fixture directories remain after native ACL cleanup
denials. The release-copy module-load leak was independently fixed and tested;
these later native-fixture cleanup failures remain visible. The operator should
use the exact lane logs to identify its scratch directories for cleanup outside
this sandbox, without deleting unrelated temporary folders. No scratch tree was
created in the working copy by the changed fixtures.

## Prepared commit

Subject: `test: support Windows owner-PC fixture execution`

Body:

```text
Keep privileged symlink coverage in CI and add mandatory junction and hard-link controls.
Clean failed release fixtures, isolate scratch state, and render health guidance by platform.
Record native sandbox blockers and the unresolved guide-refresh investigation.
```

The operator must rerun the seven focused files outside this restricted sandbox
and resolve any remaining native failure before treating the lane as ready.
The missing commit and push are expected and do not determine this verdict.

## Operator note

The Codex sandbox is more restricted than a normal account: profile-root realpath and native ACL calls are denied there. So the operator (Claude Code) re-ran the seven files outside the sandbox, from this working tree, as a normal non-elevated user (Developer Mode off, so symlinks give EPERM). The run used a profile-shaped fence: AppData and Temp under a fenced home with a profile-like ACL, the real global npm folder off PATH, and BRAIN_TEST_CHAIN=1, BRAIN_NO_WRANGLER_LOGIN=1 and CI=true set.

| File | Result |
| --- | --- |
| `test/quickbooks-desktop-connect.test.mjs` | 28 pass, 1 skipped (file-symlink arm), 0 fail |
| `test/older-release-paused-resume.test.mjs` | 32/32 pass |
| `test/technician-setup.test.mjs` | 35 pass, 1 fail in a fence with a long root path; 36/36 in a fence with a shorter root path (6 of 6 runs) |
| `test/owner-contract-workspace.test.mjs` | 177 pass, 28 skipped, 0 fail |
| `test/machine-prep.test.mjs` | 56 pass, 51 skipped (platform and file-symlink arms), 0 fail |
| `test/health-verify-exit.test.mjs` | exit 0 |
| `test/upgrade-bookmark-windows.test.mjs` | 16 pass, 1 skipped (elevated-only case), 0 fail |

So the sandbox blocker is resolved for six files. The seventh is a real product problem, and the operator found its cause.

**Cause of the guide-refresh `not_written` (product defect).** Instrumenting `operations/claude-workspace.mjs` showed that every check passes except the final readback at the line that verifies the retained attempt after the lock directory is renamed (`if (!sameIdentity(lstatSync(retained), lockStat) || !exact()) return notWritten();`). There, `workspaceFileOwnedByUser` returns false for the pending file only. That file is the deepest path the writer ever checks: `<workspace>\CLAUDE.md.financial-brain-retained-<uuid>\CLAUDE.md.financial-brain-pending-<uuid>`, which is the workspace path plus 142 characters. `windowsWorkspaceAttributesSafe` reads attributes with Windows PowerShell 5.1 `[IO.File]::GetAttributes`, which throws for paths over 260 characters when long paths are not enabled (the Windows default; this PC reports LongPathsEnabled=0). The script maps the exception to "unsafe". A direct probe on this PC: 257 characters works, 277 characters fails (MethodInvocationException), and the same 277-character path with the `\\?\` prefix works.

- Owner impact: on Windows, `brain setup` and `brain update` report the Claude workspace guide (and, by the same code, the Codex AGENTS.md guide) as `not_written` whenever the Brain folder path is longer than about 118 characters, even though the new guide was installed by then. The attempt is left as a `...financial-brain-retained-<uuid>` folder. The documented default (`%USERPROFILE%\Financial Brain`, about 35 characters) is far below the threshold. A Brain folder deep under OneDrive or Documents can reach it. CI's short runner temp path keeps the test green there.
- Smallest fix: in the PowerShell attribute script, read each path through the `\\?\` (or `\\?\UNC\`) prefix, with a red test whose workspace path exceeds the threshold on win32 and a short-path control. This is being done in round 2 on `partner/win-owner-pc-2`.

Names, banned-word, email, user-path and key scan of every added line and new file: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator. The last line below was updated by the operator: the sandbox reason no longer applies, and the guide-refresh cause is now known, with its fix pending in round 2.

LANE WIN-OWNER-PC: NOT READY guide-refresh long-path product fix pending (cause found by operator; fix in round 2)
