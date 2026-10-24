# REVIEW-0419-FINAL-PARTNER: independent review of the final 0.4.19 release

Scope: `git diff f8a7cd05..5d8f804d` on `claude/0419-release`, f8a7cd05a1e641d29d5b3af77fc91901a5281639 to 5d8f804d517ca8ef4bc8eb1c0b347c7172a47041. That is one commit, "Release fixes: lifecycle lock rule, busy messages, safe half-run guidance", changing 16 files (+1,604, -124). The new automatic recovery after an interrupted Claude-key setup is out of this version, so its absence is expected and is not reported.

Method: Claude Code multi-agent review. One finder each for the lifecycle lock rule, the busy messages, the answer-setup journal and half-run guard and its message, the Windows health test, and the rest of the diff. Two checkers marked each of C1's 20 findings as fixed, partly fixed, open or not applicable in the final head. One adversarial verifier per finding tried to refute it and re-rated severity, and a completeness critic followed. 35 agents, all offline: no network, no real Brain, no Cloudflare, no keys. Focused tests and small probes only, from a read-only worktree; probes stayed outside the repository.

Result: 25 confirmed findings (7 P2, 18 P3), 2 refuted, no P0 or P1. The completeness critic found nothing beyond the five areas. Severity below is the verifier's rating. P0 = owner data loss or corruption, key or secret exposure, or an update that can leave the Brain broken; P1 = a fail-safe that does not fail safe, a guard that can be bypassed, or a wrong result shown as right; P2 = real but bounded; P3 = minor.

Shared root causes (the operator's grouping, from file:line and the fixes):
- #2, #3, #7 and #21: the new partner test file fails 9 of 20 tests on a Windows host.
- #10, #13, #18, #19 and #23: the half-run check in `brain connect anthropic` runs before the lock.
- #9 and #11: a killed lock holder blocks without wait guidance.
- #12 and #25: pre-start update refusals are filed as UPGRADE_FAILED.

So the 25 confirmed findings come down to about 16 distinct fixes, 5 of them P2.

## What matters for the seal

Two Windows test-gate blockers. These are test defects, not product behavior, but both turn the Windows test chain red on any Windows host, including an elevated CI runner:
- #5 `test/health-verify-exit.test.mjs`: the new side-effect tripwire also blocks `icacls.exe` when a support event is recorded. Every failing-health scenario then exits 86 instead of 1, and 38 of 67 checks fail on a healthy machine. Because the child dies before printing, the fail-closed health checks that update relies on are not actually exercised on Windows. Fix: load the existing support-journal ACL preload after the tripwire, and make the failure checks reject exit 86.
- #2, #3, #7, #21 `test/fix-0419-partner-r1.test.mjs` (in both chain lists): 7 tests loop simulated darwin and linux platforms over the real filesystem, and on Windows `assertPrivateDirectory` cannot clear mode bits. 2 mutant tests match `\n` anchors against a CRLF checkout. Fix: skip simulated rows that cannot run on the host (or stub the private-directory check), and normalize CRLF before matching mutant anchors.

The Windows test legs on 5d8f804d are running on an owner-like PC now and will confirm both directly. Results follow separately.

Three product P2s:
- #1 lock: a stale holder whose PID now belongs to an unrelated live process is never reclaimed. The daily run defers with a generic reason, and `brain update` waits 120 s, then stops with UPDATE_BRAIN_BUSY. 0.4.18 behaves the same way; the C1 snapshot did not.
- #4 answer setup: an interrupted answer setup leaves no command-line way out. `update` and `connect` refuse with HALF_RUN, and `disconnect` refuses with UPDATE_FIRST when the versions differ. Only owners who connected Claude answers are affected.
- #6: the new update journal guard is skipped by `brain upgrade`, which runs the same migrate, deploy and acceptance engine.

## The four focus areas, in short

- Lock rule: the final rule restores 0.4.18 behavior: a live holder is busy, and a dead or same-PID holder is reclaimed only when stale. It adds a random per-process instance and a retryable "being acquired" state. C1's P1 is fixed: a live holder can no longer lose the lock to new code, as a real-process probe on this Windows host showed. The remaining gap is #1, plus #8 (a release mid-check can crash a waiting contender).
- Busy messages: busy errors no longer surface as a dropped internet connection (C1-8 fixed), and the nonexistent commands are gone (C1-19 fixed). Remaining: P3 wording, receipt and changelog issues (#9, #11, #12, #14 to #17, #25).
- Half-run guard and its message: `brain update` refuses an interrupted answer setup. But the check in `connect` runs before the lock, so a setup still running in another window is called "interrupted", `--json` output breaks, and the clipboard is no longer cleared on that path (#10, #13, #18, #19, #23). There is no way out from the command line (#4), and `brain upgrade` bypasses the guard (#6).
- Windows health test: the product's Windows health fix is in, but the new test cannot pass on Windows (#5). Separately, the health "Next:" reconnect line prints the manifest path unquoted, and the new test asserts that unquoted form (#22).

C1 follow-up: 3 fixed (C1-1, C1-8, C1-19), 1 partly fixed (C1-3), and 16 still open. Most open items are in the optional Claude-answer setup, which this trimmed release does not change. The full table is below.

## Confirmed findings

### 1. [P2] A dead holder whose PID now belongs to an unrelated live process is never reclaimed; the daily path defers silently with no restart guidance

- Area: lock-rule. Finder severity P2, verifier severity P2.
- Location: `operations/brain-lifecycle-lock.mjs:93`; verifier: operations/brain-lifecycle-lock.mjs:93 (lifecycleOwnerIsDead; reclaim gate at 418-432; guidance at 442-444); operations/daily-refresh-run.mjs:196-208 (deferred receipt drops error.message); operations/daily-refresh-observation.mjs:244 (status text)
- Inputs: A daily refresh ends abnormally, so its owner record stays behind. Two common causes: Task Scheduler hard-terminates it at the PT45M ExecutionTimeLimit (AllowHardTerminate=true, and the runner checks its own 45-minute budget only before each source), or the PC shuts down mid-run. Windows then gives that PID to an unrelated long-lived process (a browser, a service, Explorer). A store PC is often left on for weeks.
- Wrong outcome: The rule is `lifecycleOwnerIsDead = live !== true || same-PID-as-contender`. Because the reused PID passes process.kill(pid,0), the owner is never treated as dead, however stale it is. Every daily run returns status 'deferred' with the generic reason 'another Brain lifecycle operation owns the manifest lock'. That reason drops the busy error's restart advice. `brain daily status` shows only 'Daily refresh was deferred by another operation or recovery.' Sources go stale until the unrelated process exits or the PC reboots. `brain update` waits 120 s and then dies with UPDATE_BRAIN_BUSY, saying 'restart the computer'. No message names the lock directory under %ProgramData%\FinancialBrain\locks, and a reboot clears the lock only if no process takes that PID after boot.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus1-lock\pid-reuse-probe.mjs used a real lock with a 2-hour-old owner record whose PID was rewritten to a live process. The update attempt returned brain_lifecycle_busy with 'Another Brain task has held the lock for 120 minutes. If no Brain command is running, restart the computer'. runDailyRefresh returned 'deferred brain_lifecycle_busy | another Brain lifecycle operation owns the manifest lock'. The removed test 'a stale owner whose pid was reused cannot block the Brain forever' (test/brain-lifecycle-lock.test.mjs) covered exactly this case. 0.4.18 behaved the same way; the C1 snapshot did not.
- Fix: Reclaim a stale, live-PID owner only on one-sided proof that the PID was reused. Read the OS creation time of the live PID with the existing processStartIdentity. Treat the owner as dead only when that process was created strictly after owner.created_at plus a margin of 60 s or more, and keep the existing stale and second-read checks. A real holder always exists before it writes its record, so slow-start skew (the C1 bug) cannot cause a false takeover. An unknown (null) identity stays busy. Also carry the busy error's guidance into the daily deferred receipt and `brain daily status`, and name the exact lock directory in the restart guidance.
- Verifier's fix note:

Treat a live-PID owner as dead only on one-sided proof that it is a different process. Keep the existing stale gate and the second read.

(a) Boot check, needs no spawn. bootMs = Date.now() - os.uptime()*1000. If Date.parse(owner.created_at) < bootMs - 5 min, the holder cannot be alive, so reclaim. This makes the "restart the computer" guidance true. A forward clock jump cannot cause a false takeover, because a live holder's heartbeat keeps its mtime fresh.

(b) Reuse without a reboot. Read the live PID's creation time and reclaim only when it is strictly later than owner.created_at + 60 s. A real holder always exists before it writes its record, so the C1 slow-start skew cannot cause a false takeover. Use CIM Win32_Process CreationDate, or keep processStartIdentity. Get-Process may return null for service processes the owner's account cannot open, and any null or unknown result must stay busy.

(c) Carry error.message, or at least the restart guidance, into the daily deferred receipt reason and the `brain daily status` "Last daily error" line. Name the lock directory (%ProgramData%\FinancialBrain\locks\brain-lifecycle-<id>.lock) in the long-held guidance.

(d) Restore a test equivalent to the deleted "a stale owner whose pid was reused cannot block the Brain forever" case. Base it on the boot-time proof and the later-creation-time proof, plus a control showing that an unknown identity stays busy.

- Verifier's reasoning:

I could not refute it. I traced the code and reproduced it on this Windows PC.

1. In the final head, operations/brain-lifecycle-lock.mjs:93-95 treats an owner as dead only when `live !== true`, or when its PID equals the contender's own PID with a different process_instance. The reclaim at lines 418-432 needs both stale and dead. A record whose PID now belongs to any other live process therefore never takes that branch, however old the record is. Lines 442-444 then throw brain_lifecycle_busy with "restart the computer" guidance.

2. The OS treats a reused PID as live. ownerAlive (line 311) uses process.kill(pid, 0) and returns true for every error except ESRCH. On Windows, libuv's OpenProcess returns ESRCH only for a PID that does not exist. A live process the owner's account cannot open (EPERM) also counts as live.

3. The holder record can be left behind. The daily task is registered with ExecutionTimeLimit PT${max_runtime_minutes}M (default 45), AllowHardTerminate=true, and node.exe is the direct action (operations/daily-refresh-scheduler.mjs:251). The runner checks its budget only before each source starts (operations/daily-refresh-run.mjs:282). A hard terminate skips the process 'exit' release handler, and the lock lives under %ProgramData%\FinancialBrain\locks, so a reboot does not clear it.

4. Daily path. operations/daily-refresh-run.mjs:196-208 turns busy into status 'deferred' with the generic reason "another Brain lifecycle operation owns the manifest lock" and drops error.message. The run exits 0 (only 'failed' sets exitCode, line 612). observeDailyRun records "Daily refresh was deferred by another operation or recovery." (operations/daily-refresh-observation.mjs:244), and `brain daily status` shows only that. Update path: brain.mjs:31551-31570 waits 120 s and then dies with UPDATE_BRAIN_BUSY.

5. This is a regression inside the review scope. At f8a7cd05, a live PID with a mismatched start identity was reclaimed. The test "a stale owner whose pid was reused cannot block the Brain forever" was deleted in 5d8f804d. test/fix-0419-partner-r1.test.mjs:166 now asserts that a long-held live owner stays busy. The head's own docs/release-evidence/v0.4.19-candidate-release-evidence-plan.md item 8 still says "Reaping requires confirmed dead or reused process identity", which the code no longer does except for the contender's own PID.

6. The restart guidance is not reliable. Nothing checks boot time, so after a restart the record still blocks if any new process gets that PID.

Severity: P2, real but bounded. The lock fails closed: no false takeover and no data corruption. The cost is that daily freshness stalls and the update is refused until the unrelated process exits or a reboot happens to free the PID. It needs a rare double event: an abnormal end, then reuse by a long-lived process. On an unattended store PC, though, it can last for weeks, and the daily surface gives no actionable guidance.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\verify-pidreuse-stuck\probe.mjs (holder: holder.mjs in the same folder). It sets BRAIN_LIFECYCLE_LOCK_ROOT to a scratch folder and imports the final-head modules read-only.

Run: node C:\offload\review-0419-final-scratch\verify-pidreuse-stuck\probe.mjs

Output observed:
- A: a real child process acquired the lock as daily-refresh and was killed with TerminateProcess (child.kill SIGKILL). Its owner file owner-61408-<token>.json stayed in the lock directory.
- B: the record was re-keyed to the PID of a live, unrelated node process, with created_at and mtime set 2 hours back.
- C: acquireBrainLifecycleLock (operation update, real isOwnerAlive) returned brain_lifecycle_busy: "...held by daily-refresh since ... Another Brain task has held the lock for 120 minutes. If no Brain command is running, restart the computer and run the command again." With the clock moved +30 days it was still busy: "held the lock for 43320 minutes".
- D: runDailyRefresh, using its real default acquireLock, returned "deferred brain_lifecycle_busy | another Brain lifecycle operation owns the manifest lock". The restart guidance was dropped.
- E: after the unrelated process was killed, the next acquire reclaimed the lock at once and released it cleanly. Process liveness of the reused PID is the only blocker.


### 2. [P2] The new partner lock tests cannot pass on a Windows host, so the Windows npm test leg and this PC's Windows chain go red

- Area: lock-rule. Finder severity P2, verifier severity P2.
- Location: `test/fix-0419-partner-r1.test.mjs:90`; verifier: test/fix-0419-partner-r1.test.mjs:91 (also the platform loops at 133, 167, 207, 250, 309, 411; importMutant source read at 666-668); root cause in operations/brain-lifecycle-lock.mjs:110-118 (POSIX mode check against a real Windows filesystem)
- Same root cause as: #3, #21, #7 (the new partner test file test/fix-0419-partner-r1.test.mjs fails 9 of 20 tests on a Windows host).
- Inputs: `node --test test/fix-0419-partner-r1.test.mjs` on Windows. It was added to TEST_COMMANDS and POST_LAUNCHER_TEST_COMMANDS in scripts/run-test-chain.mjs, and ci.yml runs `npm test` on windows-latest.
- Wrong outcome: 9 of 20 tests fail on this Windows host. 7 tests (lines 90, 132, 166, 206, 249, 303, 410) loop through simulated 'darwin'/'linux' platforms against the real filesystem. On Windows, assertPrivateDirectory cannot clear mode bits, so each throws brain_lifecycle_unsafe 'the local Brain lifecycle lock is not private' (operations/brain-lifecycle-lock.mjs:117) before any lock decision. 2 mutant tests (806, 879) fail with 'mutant anchor exists' because importMutant (line 668) matches anchors containing a bare \n against a CRLF checkout (core.autocrlf=true in this checkout). The release's own target-OS gate is therefore red by construction, which can hide a real Windows lock regression among the expected failures.
- Finder's evidence: I ran `node --test test/fix-0419-partner-r1.test.mjs` in C:\offload\review-0419-final: 11 passed, 9 failed. The stack for 'a dead holder stays busy...' ends at assertPrivateDirectory (brain-lifecycle-lock.mjs:117) from acquireBrainLifecycleLock (365). `file operations/brain-lifecycle-lock.mjs` reports CRLF line terminators. test/brain-lifecycle-lock.test.mjs passes 11/11 on the same host because it never simulates POSIX with real filesystem calls.
- Fix: In each platform loop, skip rows that cannot run on the host: `if ((process.platform === 'win32') !== (platform === 'win32')) continue;`. Alternatively, inject a private-directory stub for simulated POSIX rows the way restrictWindowsDirectory is stubbed. In importMutant, normalize the source before matching (`source = source.replace(/\r\n/g, '\n')`), or add `* text eol=lf` for .mjs files to .gitattributes.
- Verifier's fix note:

Fix 1, platform loops: in each of the 7 platform loops in test/fix-0419-partner-r1.test.mjs (lines 91, 133, 167, 207, 250, 309, 411), add `if ((process.platform === "win32") !== (platform === "win32")) continue;` as the first statement. A simulated POSIX row against the real filesystem then runs only on a POSIX host, and a simulated win32 row only where the matching rules apply. The win32 rows keep running on Windows, and the darwin/linux rows keep running on the macOS and Ubuntu CI legs.

Fix 2, mutant anchors: in importMutant, change line 666 to `let source = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");` so the anchors match on autocrlf checkouts. Optionally, also pin `operations/*.mjs text eol=lf` in .gitattributes, matching the existing brain.mjs pin.

Fix 1 is the simplest. An alternative is to give acquireBrainLifecycleLock an injectable private-directory assertion that is used only by tests, like restrictWindowsDirectory. I checked the combined fix in a scratch copy: 20 of 20 pass on Windows.

- Verifier's reasoning:

I reproduced the claim on this Windows host (Node 24.18.0, the checkout has core.autocrlf=true). `node --test test/fix-0419-partner-r1.test.mjs` gives 11 passed and 9 failed.

The first group is 7 tests: #1-#6 and #8, with loops at lines 91, 133, 167, 207, 250, 309 and 411. Each loops over simulated 'darwin'/'linux' rows against the real filesystem. In acquireBrainLifecycleLock (operations/brain-lifecycle-lock.mjs:365), assertPrivateDirectory(path, ..., platform) sees platform !== 'win32' and checks the POSIX mode bits. A Windows directory always reports group and other bits. chmodSync(path, 0o700) cannot clear them on Windows, so line 117 throws brain_lifecycle_unsafe 'the local Brain lifecycle lock is not private'. The lock function has no hook to inject this check. restrictWindowsDirectory only covers the win32 branch, so these rows cannot pass on any Windows host, whatever the line endings.

The second group is 2 mutant tests, #15 (line 806) and #17 (line 879). importMutant (lines 666-668) reads the source as utf8 and asserts that source.includes(before) for anchors containing a bare "\n". `git ls-files --eol` shows operations/brain-lifecycle-lock.mjs as i/lf w/crlf with no attribute, and .gitattributes pins brain.mjs and others but not operations/*.mjs. So on an autocrlf checkout the assertion 'mutant anchor exists' fails. GitHub's Windows runners default to autocrlf, and the repo's own .gitattributes comment already names that hazard.

Wiring: the diff adds the file to both TEST_COMMANDS (run-test-chain.mjs:768) and POST_LAUNCHER_TEST_COMMANDS (:304). The chain has no known-failure allowlist, and it sets a non-zero exitCode on any failure, even with --continue-on-failure. ci.yml:615 runs `npm test -- --continue-on-failure` on windows-latest. So both the Windows CI leg and the local Windows chain go red.

Refutation attempts that failed:
- No platform skip exists in the test or the runner.
- No injection exists for the POSIX privacy check.
- The older test/brain-lifecycle-lock.test.mjs only simulates POSIX for processStartIdentity with a stubbed run, never against the real filesystem.

I also ran a scratch copy with the proposed fix applied (skip rows whose platform does not match the host, and normalize CRLF in importMutant). It passed 20 of 20 on Windows. So the real win32 lock rows and the win32 mutant kills are fine, and the defect is test-only. Owner data and the update path are not affected.

Severity stays P2. The release's target-OS test gate is red by construction, and a reviewer used to these 9 expected failures could miss a real win32 lock regression, because a failing win32 row produces the same 'not ok' line. It is bounded because no shipped code is wrong.

- Reproduction:

In C:\offload\review-0419-final, run `node --test --test-reporter=tap test/fix-0419-partner-r1.test.mjs`. Result: # tests 20, # pass 11, # fail 9.
- Tests 1-6 and 8 fail with code 'brain_lifecycle_unsafe', error 'the local Brain lifecycle lock is not private'. The stack is assertPrivateDirectory (brain-lifecycle-lock.mjs:117:15) called from acquireBrainLifecycleLock (brain-lifecycle-lock.mjs:365:7).
- Tests 15 and 17 fail with ERR_ASSERTION 'mutant anchor exists in operations/brain-lifecycle-lock.mjs' and '... operations/answer-setup.mjs'.

`git ls-files --eol operations/brain-lifecycle-lock.mjs` shows `i/lf w/crlf attr/`, and `git config core.autocrlf` is true.

Control: C:\offload\review-0419-final-scratch\lock-rule-verifier\make-probe.cjs writes probe-fixed.test.mjs, a copy with imports pointed at the checkout. The copy adds `if ((process.platform === "win32") !== (platform === "win32")) continue;` inside each of the 7 platform loops and `.replace(/\r\n/g, "\n")` on the importMutant source read. It passed 20 of 20 and exited 0. TAP output is in run1.tap (original) and run-fixed.tap (fixed) in the same scratch folder.

The chain wiring is scripts/run-test-chain.mjs:304 and :768. Any failed command sets process.exitCode non-zero, including under --continue-on-failure. ci.yml:615 runs npm test on windows-latest.


### 3. [P2] The new partner test file is in the Windows test chain but fails 9 of 20 tests on a Windows host

- Area: busy-messages. Finder severity P2, verifier severity P2.
- Location: `test/fix-0419-partner-r1.test.mjs:91`; verifier: test/fix-0419-partner-r1.test.mjs:91 (the same simulated-platform loops are at :133, :167, :207, :250, :309 and :411), and test/fix-0419-partner-r1.test.mjs:666 (importMutant reads the CRLF worktree source and asserts at :668). The thrower is operations/brain-lifecycle-lock.mjs:117, reached through :365.
- Same root cause as: #2, #21, #7 (the new partner test file test/fix-0419-partner-r1.test.mjs fails 9 of 20 tests on a Windows host).
- Inputs: `node --test test/fix-0419-partner-r1.test.mjs` on Windows 11. The run-test-chain.mjs diff adds this command to both POST_LAUNCHER_TEST_COMMANDS (line 304) and TEST_COMMANDS (line 768). The checkout used core.autocrlf=true.
- Wrong outcome: Tests 1-6 and 8 fail with brain_lifecycle_unsafe "the local Brain lifecycle lock is not private". They loop over simulated "darwin" and "linux" platforms, and on a Windows host assertPrivateDirectory cannot make the mode private through chmod. Tests 15 and 17 fail with "mutant anchor exists": their anchors contain "\n", and operations/brain-lifecycle-lock.mjs and operations/answer-setup.mjs are not pinned to LF in .gitattributes, unlike brain.mjs. Result: the Windows host gate is red, and none of the busy-message and journal-guard coverage runs on the target platform.
- Finder's evidence: TAP run here: tests 20, pass 11, fail 9. probe-platform.mjs: win32 acquires, while darwin and linux both throw brain_lifecycle_unsafe on this host. The existing test/brain-lifecycle-lock.test.mjs passes 11/11 here because it acquires only with the host platform. `git ls-files --eol` shows i/lf w/crlf for both operations files.
- Fix: Run the simulated darwin/linux iterations only when process.platform !== 'win32', or inject a no-op privacy check for simulated POSIX platforms. Normalize CRLF in importMutant before anchoring, or add `operations/brain-lifecycle-lock.mjs text eol=lf` and `operations/answer-setup.mjs text eol=lf` to .gitattributes.
- Verifier's fix note:

1. Simulated platforms: in the seven loops, build the platform list from the host. For example, define `const SIMULATED_PLATFORMS = process.platform === "win32" ? ["win32"] : ["win32", "darwin", "linux"];` and use it in place of the literal arrays (for the test-8 loop, filter `["win32", "darwin"]` the same way). POSIX permission semantics cannot be exercised on a Windows host. The darwin and linux rows still run on the macOS and Ubuntu CI lanes.

2. Mutant anchors: in importMutant, normalize the source before anchoring: `let source = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");`. Writing the mutant with LF endings is harmless for import. As an alternative or in addition, add `operations/brain-lifecycle-lock.mjs text eol=lf` and `operations/answer-setup.mjs text eol=lf` to .gitattributes, as was done for brain.mjs. Existing Windows worktrees need a re-checkout before that takes effect, so the in-test normalization is the more robust fix.

3. Re-run `node --test test/fix-0419-partner-r1.test.mjs` on a Windows host with core.autocrlf=true and confirm 20/20 before sealing.

- Verifier's reasoning:

I reproduced the failure on this Windows 11 host. Running `node --test test/fix-0419-partner-r1.test.mjs` against the final head, with an isolated home, TEMP and lock root, gives tests 20, pass 11, fail 9. The failing tests are the same nine the claim lists.

Why it reaches the Windows gate:
- The diff adds this command to both POST_LAUNCHER_TEST_COMMANDS (scripts/run-test-chain.mjs:304) and TEST_COMMANDS (:768).
- runTestCommands runs every command on every host, with no platform filter.
- .github/workflows/ci.yml runs `npm test -- --continue-on-failure` in a test matrix that includes windows-latest. The workflow's own comment says Windows is the platform "we are actually here to learn from".

Root cause 1: the simulated POSIX platforms (tests 1-6 and 8).
- Each of these tests loops `for (const platform of ["win32", "darwin", "linux"])` (or `["win32", "darwin"]` in test 8) and calls acquireBrainLifecycleLock with a simulated platform.
- For any platform other than win32, operations/brain-lifecycle-lock.mjs:365 calls assertPrivateDirectory (lines 105-121). That function checks `(state.mode & 0o077) !== 0`, then tries `chmodSync(path, 0o700)`.
- On a Windows host, Node reports directory modes with the group and other bits set, and chmod only toggles the read-only flag. So the second lstat still shows group and other bits, and line 117 throws brain_lifecycle_unsafe "the local Brain lifecycle lock is not private".
- The stack traces confirm this: brain-lifecycle-lock.mjs:117, reached through :365. The test lines are 95, 413 and the other loop sites.
- This happens on any Windows host, whatever the git settings.

Root cause 2: the mutant anchors (tests 15 and 17).
- importMutant (line 666) reads the worktree source and asserts that an anchor containing "\n" exists.
- .gitattributes pins brain.mjs to LF but not operations/brain-lifecycle-lock.mjs or operations/answer-setup.mjs. `git ls-files --eol` shows i/lf w/crlf for both under core.autocrlf=true, which is the Git for Windows default and is what windows-latest runners use.
- My probe (anchor-probe.mjs) shows both anchors are present in the LF blob (`git show HEAD:<path>`) and missing from the CRLF worktree file.

One part of the claim is overstated. The claim says "none of the busy-message and journal-guard coverage runs on the target platform". In fact win32 is first in every loop, so its iteration finishes and passes before the darwin iteration throws. Tests 7 and 9-14 also pass on Windows, including the update busy-message test and the update journal-refusal test. What Windows loses is a red Windows test lane in CI (both Node versions) and on local Windows chain runs, plus the two mutant-kill checks for the fresh-empty classification and the update journal guard.

Severity: this is test-only. No product code path changes, and nothing touches the owner's Brain, data or keys. But a permanently red Windows gate on the release platform can hide a real Windows regression behind an expected failure. That is real but bounded, so P2.

- Reproduction:

I ran this from C:\offload\review-0419-final, with USERPROFILE, HOME, TEMP, TMP, APPDATA, LOCALAPPDATA and BRAIN_LIFECYCLE_LOCK_ROOT all pointed at C:\offload\review-0419-final-scratch\verify-partner-test\...:
`node --test test/fix-0419-partner-r1.test.mjs` (Node v24.18.0, Windows 11).

Result: tests 20, pass 11, fail 9. Full output is in C:\offload\review-0419-final-scratch\verify-partner-test\tap.txt.
- Failing: tests 1-6 and 8, each with "BrainLifecycleLockError: the local Brain lifecycle lock is not private" at operations/brain-lifecycle-lock.mjs:117 (assertPrivateDirectory), called from :365.
- Also failing: tests 15 and 17, each with "AssertionError: mutant anchor exists in operations/brain-lifecycle-lock.mjs" (or "in operations/answer-setup.mjs") at test/fix-0419-partner-r1.test.mjs:668.

Probe: C:\offload\review-0419-final-scratch\verify-partner-test\anchor-probe.mjs printed, for both operations files, "worktree has CRLF: true, anchor in worktree: false, anchor in LF blob: true".

`git ls-files --eol` shows i/lf w/crlf attr/(none) for operations/brain-lifecycle-lock.mjs and operations/answer-setup.mjs, compared with attr/text eol=lf for brain.mjs.

`git config core.autocrlf` in the checkout returns true.


### 4. [P2] An interrupted answer setup leaves no command-line way out, and a version gap turns it into a loop that blocks the update

- Area: answer-setup-journal. Finder severity P2, verifier severity P2.
- Location: `brain.mjs:30958`; verifier: brain.mjs:30958 (update journal guard). Also brain.mjs:20728-20738 (disconnect turns the version mismatch into UPDATE_FIRST even when the journal blocks update), and the single-argument HALF_RUN calls at brain.mjs:4297, brain.mjs:19620, brain.mjs:30959, doctor.mjs:893 and operations/answer-setup.mjs:373.
- Inputs: A half-run journal exists from any interrupted connect, reconnect or cap change. Example: a working Claude setup runs `--keep-key --daily-cap 10`, and the window closes during deploy. The installer is 0.4.19 and the live Worker is still 0.4.18. This is the supervised-update situation.
- Wrong outcome: `brain update` refuses with HALF_RUN ("ask the person who set up your Brain for help"). `brain connect anthropic` refuses with HALF_RUN. `brain disconnect anthropic` is the only command that removes the journal, and it refuses with UPDATE_FIRST ("Update it first with: brain update") because assertLiveAnswerSetupWorker requires the live version to equal PRODUCT_VERSION. The guidance goes in a circle. With matching versions, the only way out is disconnect, which deletes the stored key, which is exactly what the new copy says not to do. Nothing reads the journal on disk. All five HALF_RUN call sites pass one argument (brain.mjs:4297, 19620, 30959; doctor.mjs:893; answer-setup.mjs:373), so even a journal that proves secret_name_existed=false never gets the safe recovery wording. restoreManifestFromAnswerSetupJournal is used only during the same run. No runbook or `support --explain` entry tells the setup person what to do. The only remaining fix is deleting a hidden file by hand, without being told what state to check first.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus3\probe-deadlock.mjs uses a journal with secret_name_existed=false and a Worker /health reporting 0.4.18. Results: update gives the HALF_RUN text, connect gives the HALF_RUN text, and disconnect gives "Your Brain is on an older version than this installer. Update it first with: brain update ...". Disconnect's only side effect was the /health read, and the journal is still present. Before this diff, HALF_RUN advised disconnect and update was not blocked.
- Fix: Add a journal-driven recovery path that runs under the lifecycle lock, for example `brain connect anthropic <manifest> --recover`, or a step inside `brain update`. It would: parse schema_version 1; restore the `previous` fields with restoreManifestFromAnswerSetupJournal; delete ANTHROPIC_API_KEY only when secret_name_existed===false and rerank is not on; redeploy, or leave the deploy to the update when the Worker is behind; then remove the journal. At the HALF_RUN call sites, read the journal and pass journal.secret_name_existed, falling back to the conservative copy if the journal is unreadable. Document the setup-person steps in the runbook. Operational, before the supervised session: check the owner's Brain folder for .answer-setup-journal.json.
- Verifier's fix note:

Add a local, journal-driven recovery step for the setup person, run under the lifecycle lock with no live-version requirement. Example: `brain connect anthropic <manifest> --recover`. It would:
- parse the journal, refusing if schema_version !== 1 or `previous` is malformed;
- restore the manifest with restoreManifestFromAnswerSetupJournal(current, journal) and saveAnswerManifestAtomically;
- remove the journal;
- leave the Cloudflare secret unchanged, and leave the redeploy to the following `brain update`, which deploys the restored manifest.

In cmdDisconnectAnthropic, when the version check fails and the journal exists, print the HALF_RUN escalation instead of UPDATE_FIRST, so the messages stop pointing at each other.

At the HALF_RUN call sites, read the journal and pass journal.secret_name_existed. Fall back to the conservative copy when the journal is unreadable.

Add the recovery step to onboarding/06-runbook-top-ten-failures.md and the ANTHROPIC_ROLLBACK_INCOMPLETE support entry.

Separately, either add the same journal guard to cmdUpgrade or document why `brain upgrade` may bypass it.

Before the supervised session, check the owner's Brain folder (next to brain.manifest.json) for .answer-setup-journal.json.

- Verifier's reasoning:

I traced the claim in the final head and it holds, with one overstatement.

1. Update is newly blocked. In cmdUpdateWithPrompts (brain.mjs:30958-30959), `answerSetupNeedsRecovery(installed.path)` returns true whenever the journal path exists (operations/answer-setup.mjs:225-232, an lstat presence check). Update then dies with HALF_RUN before any remote work. This guard is new in this diff. At f8a7cd05, update had no journal check.

2. Connect is blocked. cmdConnect (brain.mjs:19618-19620) dies with HALF_RUN before manifest control. runAnthropicAnswerSetup (answer-setup.mjs:372-375) also throws HALF_RUN when the journal exists.

3. Disconnect is the only command that removes the journal (brain.mjs:20779-20782). Before that, it runs assertLiveAnswerSetupWorker (brain.mjs:19713-19716), which requires `/health` version === PRODUCT_VERSION. Otherwise it throws UPDATE_FIRST: "Update it first with: brain update". The two messages point at each other.

4. The version-gap state is reachable, but only when the journal comes from an older installer. A 0.4.19 connect checks the version before it writes the journal (answer-setup.mjs:381-387 runs before listSecretNames and writeJournal). So 0.4.19 cannot create a journal while the Worker is behind. A journal left by an interrupted connect on the owner's current version, followed by the 0.4.19 update, hits exactly this state. That is the supervised-update scenario.

5. I re-ran the reviewer's probe (C:\offload\review-0419-final-scratch\focus3\probe-deadlock.mjs) and got the same results:
   - update and connect print the "interrupted part way ... ask the person who set up your Brain" text;
   - disconnect prints "Your Brain is on an older version than this installer. Update it first with: brain update ...";
   - disconnect's only side effect is the /health read, and the journal stays.

6. All five HALF_RUN call sites pass one argument: brain.mjs:4297, 19620, 30959; doctor.mjs:893; answer-setup.mjs:373. The `secretNameExisted === false` branch of HALF_RUN is never reached in production, so it only exists for tests (answer-setup-copy.test.mjs, fix-0419-partner-r1.test.mjs).

7. No setup-person procedure exists. The runbook (onboarding/06-runbook-top-ten-failures.md:768) and the support catalog (support-recovery.mjs:62) both say to leave the journal unchanged and ask the setup person.

Correction: "no command-line way out" is overstated. `brain upgrade <manifest>` is listed under "Technician only" (brain.mjs:33560, dispatch at 33301 to 28664-28665). It calls cmdUpgrade with no journal check, since answerSetupNeedsRecovery is used only in cmdConnect and cmdUpdateWithPrompts. A technician could upgrade, then disconnect. That route is undocumented for this case. It skips the update wrapper's lifecycle lock, daily pause and Windows bridge guard, and it deploys the half-run manifest the new guard is meant to stop. The disconnect that follows also deletes the stored key, which the new copy says not to do. The only non-destructive exit is still deleting the hidden journal by hand, then rerunning connect --keep-key.

Severity: P2 is right. The stop fails closed: nothing is written, and the Brain stays working on the old version, so this is not P0 or P1. It can still stall the owner's supervised 0.4.19 update with circular guidance and no documented recovery for the setup person. It depends on a journal from an earlier interrupted setup, which can be checked before the session.

- Reproduction:

Run `node C:\offload\review-0419-final-scratch\focus3\probe-deadlock.mjs` from C:\offload\review-0419-final. The probe writes a schema-1 journal with secret_name_existed=false next to a temp manifest and stubs the Worker /health to report version 0.4.18. Observed:
- cmdUpdate: "The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help."
- cmdConnect anthropic --keep-key: same text.
- cmdDisconnectAnthropic: "Your Brain is on an older version than this installer. Update it first with: brain update <manifest>. Nothing was changed."
- Disconnect side effects: only the /health GET. The journal still exists.
Static check: answerSetupNeedsRecovery is referenced only at brain.mjs:19618 and 30958. cmdUpgrade (brain.mjs:6819 on) has no journal check, so `brain upgrade` is the only undocumented technician bypass.


### 5. [P2] Windows release gate blocker: the new tripwire makes 38 of 67 health/verify checks fail on every Windows machine, because icacls.exe is blocked when a support event is recorded

- Area: windows-health-test. Finder severity P2, verifier severity P2.
- Location: `test/health-verify-exit.test.mjs:543`; verifier: test/health-verify-exit.test.mjs:543 (spawn args in runScenario; the tripwire was added at lines 506 and 543-545)
- Inputs: Run `node test/health-verify-exit.test.mjs` from the final head on any Windows host. I ran it on this PC (Node v24.18.0). This command is entry 216 of the 449 in TEST_COMMANDS in scripts/run-test-chain.mjs.
- Wrong outcome: Every child scenario that should exit 1 exits 86 instead, so the file reports 38 failures and exits 1 on a healthy machine. The Windows test chain stops on its first failure unless --continue-on-failure is set, so the 233 commands after this one never run on Windows. The child dies before it prints any failure text, so the negative checks ("never prints green", "never downgraded to a warning") pass without testing anything. None of the fail-closed health exits that update relies on is verified on Windows.
- Finder's evidence: This diff adds `--import SIDE_EFFECT_TRIPWIRE` to the child (lines 543-545). On win32, every failing CLI path goes through recordSupportFailure (brain.mjs:707) -> recordSupportEvent -> prepareSupportDirectory -> secureDirectory (support-journal.mjs:383) -> restrictWindowsFileToCurrentUser (operations/current-user-file.mjs:46). That calls spawnSync(C:\Windows\System32\icacls.exe ...), and the tripwire turns the call into `TEST_SIDE_EFFECT_BLOCKED:child_process.spawnSync` with exit 86. I captured that stack in a probe. On POSIX the journal uses fchmod, so the test passes on macOS and fails only on Windows. The baseline f8a7cd05 had no tripwire, so icacls ran. I copied the test to %TEMP%-free scratch with absolute imports and added only the repo's existing test/fixtures/support-journal-acl-preload.mjs after the tripwire: all 67 checks passed on Windows with the tripwire still active. errors.test.mjs already pairs the tripwire with this fixture (line 91).
- Fix: In runScenario, load the existing ACL fixture after the tripwire: `const SUPPORT_ACL = new URL("./fixtures/support-journal-acl-preload.mjs", import.meta.url).href;` and spawn `["--import", SIDE_EFFECT_TRIPWIRE, "--import", SUPPORT_ACL, "--import", THIS_FILE, CLI, command, manifestPath]`. Also make every failure-scenario check reject `code === 86` and `TEST_SIDE_EFFECT_BLOCKED` explicitly, so a blocked boundary can never satisfy a negative assertion. Then rerun this file on Windows before sealing.
- Verifier's fix note:

1. In runScenario, load the existing ACL fixture after the tripwire. errors.test.mjs already does this.
   - Add `const SUPPORT_ACL = new URL("./fixtures/support-journal-acl-preload.mjs", import.meta.url).href;`
   - Spawn `["--import", SIDE_EFFECT_TRIPWIRE, "--import", SUPPORT_ACL, "--import", THIS_FILE, CLI, command, manifestPath]`.
2. In every non-isolation scenario check, require `code !== 86` and `!output.includes("TEST_SIDE_EFFECT_BLOCKED")`. For example, assert this once inside runScenario for scenarios that do not start with "isolation-". That way a blocked boundary can never satisfy a negative ("never prints green") assertion again.
3. Rerun this file on Windows before sealing. The scratch copy with step 1 alone gives 67/67 on Windows.

- Verifier's reasoning:

I reproduced this on this Windows PC (Node v24.18.0) from the read-only final head, and I traced the full code path.

1. The diff adds `--import SIDE_EFFECT_TRIPWIRE` to runScenario's child at test/health-verify-exit.test.mjs:543-545. The baseline f8a7cd05:438 spawned with `--import THIS_FILE` only.
2. test/fixtures/cli-side-effect-tripwire.mjs replaces child_process.spawnSync, then calls syncBuiltinESMExports. On a hit, `blocked()` calls process.exit(86) directly. The try/catch in brain.mjs:690 recordSupportFailure therefore cannot swallow it.
3. A failing health command calls recordSupportFailure. That calls recordSupportEvent (support-journal.mjs:728), then prepareSupportDirectory (:435), then secureDirectory on supportRoot with windowsPrivate=true (:381-383). The next calls are restrictWindowsSupportPath (:227) and restrictWindowsFileToCurrentUser (operations/current-user-file.mjs). The last one calls spawnSync on System32\icacls.exe, which hits the tripwire.
4. cliTestEnvironment drops USERNAME. libuv still adds USERNAME back into the child on Windows, so the username guard does not throw first. My probe confirms that spawnSync is reached.
5. The child's SCENARIO branch hooks only admin-key-file and admin-key-persistence. It does not hook the support journal ACL. Only errors.test.mjs and a few other tests load test/fixtures/support-journal-acl-preload.mjs.

What I ran:
- `node test/health-verify-exit.test.mjs` gave 29 PASS, 38 FAIL, exit 1. The 38 failures are exactly the "exits nonzero" and "rejects" checks.
- A scratch probe of health-ok, health-documents-unreachable and health-backend-mismatch: each child exits 86 with `TEST_SIDE_EFFECT_BLOCKED:child_process.spawnSync`. Its last product line is "binding it to authenticated inventory", so no failure text is printed. That makes the paired negative checks (for example "never claims the documents endpoint passed" and "never prints green") pass without testing anything.
- The same probe with the ACL preload added after the tripwire: each child exits 1 with the correct failure text and support code, and the ACL fixture is reached.
- A scratch copy of the full test with only that preload added: 67/67 PASS, exit 0, with the tripwire still active.
- TEST_COMMANDS has this file at entry 216 of 449. runTestCommands breaks on the first failure unless --continue-on-failure is passed. So on Windows, 233 later commands do not run.

Product behaviour is not affected: real owner runs do not load the tripwire. This is a test-harness defect that fails the Windows release gate and hides real coverage of the fail-closed health and verify exits. It is loud, not a false green, so P1 does not fit. P2 is right.

- Reproduction:

From C:\offload\review-0419-final on Windows: `node test/health-verify-exit.test.mjs` gives "38 FAILURES", exit 1.

Scratch probe C:\offload\review-0419-final-scratch\verify-health-tripwire\probe.mjs spawns `node --import cli-side-effect-tripwire.mjs --import health-verify-exit.test.mjs brain.mjs health <manifest>` with the cliTestEnvironment env and BRAIN_HEALTH_VERIFY_SCENARIO=health-ok:
- Result: status 86, stderr ends `TEST_SIDE_EFFECT_BLOCKED:child_process.spawnSync`, and no "no admin key" text is printed.
- Run with the `acl` argument (adds `--import test/fixtures/support-journal-acl-preload.mjs` after the tripwire): status 1, with the expected AUTH_REQUIRED / HEALTH_CHECK_FAILED text.

C:\offload\review-0419-final-scratch\verify-health-tripwire\fixed-copy.mjs is the test with absolute imports and that one preload added. It gives 67 PASS, 0 FAIL, exit 0.

Logs: C:\offload\review-0419-final-scratch\verify-health-tripwire\run1.txt and run-fixed.txt.


### 6. [P2] The new update journal guard is skipped by `brain upgrade`, which runs the same migrate, deploy and acceptance engine

- Area: rest-of-diff. Finder severity P2, verifier severity P2.
- Location: `brain.mjs:28664`; verifier: brain.mjs:28664-28665 (cmdUpgradeInteractive calls cmdUpgrade with no journal check); also brain.mjs:6819 (cmdUpgrade preflight has none); the guard exists only at brain.mjs:30958 and 19618
- Inputs: A half-run journal exists, so the local manifest names claude-opus-5-5 and claude-sonnet-5-5 but the Worker key is missing or rejected. A technician runs `brain upgrade <manifest>`. That command is still in the CLI help (brain.mjs:33560), and README-developer.md says it 'uses the same engine and cannot bypass those gates'.
- Wrong outcome: cmdUpgradeInteractive calls cmdUpgrade directly (brain.mjs:28664-28665). cmdUpgrade (6819-7357) has no answerSetupNeedsRecovery check, so the guard added at 30958 only covers `brain update`. The upgrade pauses, applies migrations and deploys active mode with the half-run models. The answer-aware acceptance from 52a36e11 then fails ('configured answer model returned an answer' is FAIL with no key). The owner is left with 'The update is incomplete ... run brain update once more', and `brain update` now refuses with HALF_RUN.
- Finder's evidence: `grep -c 'journal|HALF_RUN|NeedsRecovery'` over cmdUpgrade lines 6819-7357 returns 0. answerSetupNeedsRecovery is called only at brain.mjs:19618 and 30958.
- Fix: Move the presence check into cmdUpgrade's preflight, before the pause and before `beforeRemoteMutation`, so both entry points refuse. Alternatively, add the same `answerSetupNeedsRecovery(manifestPath)` refusal to cmdUpgradeInteractive.
- Verifier's fix note:

1. In `cmdUpgradeInteractive` (brain.mjs:28664), refuse before `withManifestCloudflareControl`, so it stops before credential control, the same order `cmdConnect` uses at 19618:
   `if (answerSetupNeedsRecovery(manifestPath)) die(HALF_RUN(manifestPath));`
2. Also add the same check at the top of `cmdUpgrade`, before `pinUpdateManifest` and `resolveUpgradeAccount`. Inject it as `options.answerSetupNeedsRecovery ?? answerSetupNeedsRecovery`, as the update path does. Then any direct caller refuses before the bookmark, `beforeRemoteMutation`, or the paused deploy.
   - The only other direct caller is `cmdDoctorRepair`, which resumes an already-paused Brain. Refusing there leaves the Brain paused, so keep its refusal message pointing to the setup person.
3. Add a focused test next to test/fix-0419-partner-r1.test.mjs:605. Plant each journal shape (valid, zero-byte, malformed, directory), call `cmdUpgrade` and the upgrade CLI route with remote stubs that record calls, and assert HALF_RUN with zero remote events. Add a no-journal control that reaches the bookmark capture.
4. Correct docs/README-developer.md:219 if any update-only pre-gates stay deliberately outside `brain upgrade`.

- Verifier's reasoning:

I traced the code in the final head and could not refute the claim.

1. The new journal guard runs only on two paths. `answerSetupNeedsRecovery` is called at brain.mjs:19618, in `cmdConnect` for anthropic, and at brain.mjs:30958, in `cmdUpdateWithPrompts`. No other caller exists.
2. `brain upgrade` is still a live command. The command table at brain.mjs:33301 maps `upgrade` to `cmdUpgradeInteractive`. At brain.mjs:28664-28665 that function goes straight to `withManifestCloudflareControl(..., () => cmdUpgrade(manifestPath))`. Neither the credential wrapper nor `cmdUpgrade` (brain.mjs:6819 onward) checks the journal.
   - The only other journal touch is brain.mjs:4297 in `cmdHealth`, which only prints a warning.
   - `cmdDoctorRepair` (brain.mjs:21182) also calls `cmdUpgrade` directly, but only for a Brain that is already paused.
3. The in-repo test at test/fix-0419-partner-r1.test.mjs:605 only covers `brain update`.
4. The bad end state matches the claim. In `runAnthropicAnswerSetup` (operations/answer-setup.mjs) the journal is written, then the Opus/Sonnet manifest, then the key (`putSecret`), then the deploy. A crash between those steps, or a rollback that only half finishes, leaves the journal behind. If no key existed before, the manifest now names the Claude models while the Worker has no key.
   - In that state, `cmdUpgrade` would deploy active mode with those models.
   - The acceptance check at acceptance.mjs:1121 ('configured answer model returned an answer') records FAIL whenever no answer text comes back.
   - `cmdUpgrade` then prints 'The update is incomplete ... run brain update once more' (from brain.mjs:7312). But `brain update` now refuses with HALF_RUN.

Probe: C:\offload\review-0419-final-scratch\verify-upgrade-journal\probe.mjs. It builds a fixture manifest naming the Claude models, at schema 48, with a half-run journal beside it. `answerSetupNeedsRecovery` returns true for it. I then called the real exported `cmdUpgrade` with injected Cloudflare stubs. It ran the full preflight: the migration plan ('pending: 0049-0056 (8)'), bookmark capture, saving the bookmark, then `beforeRemoteMutation`, then 'DEPLOY paused=true'. So the journal never stopped it before the first remote change.

Why P2 and not P1 or P0:
- `brain upgrade` is listed under 'Technician only' (help text near brain.mjs:33560). The owner's supervised update uses `brain update`, which is guarded.
- It needs an earlier interrupted `brain connect anthropic` to have left a journal behind.
- No data is lost. D1 version state is not committed when acceptance fails.
- The harm: answers can go from built-in to failing, and the owner is left at an 'incomplete update' that `brain update` then refuses.
- It is still a real gap in the new fix. The developer README (docs/README-developer.md:219) says `brain upgrade` 'uses the same engine and cannot bypass those gates', so a technician has reason to reach for it.

- Reproduction:

I ran `node C:\offload\review-0419-final-scratch\verify-upgrade-journal\probe.mjs`, which imports from C:\offload\review-0419-final.

Fixture, in a folder under %TEMP%:
- brain.manifest.json naming `retrieval.answer_model` claude-opus-5-5 and `gate_model` claude-sonnet-5-5.
- `.answer-setup-journal.json` beside it, built by `answerSetupJournal` from the previous built-in manifest with secretExisted=false.
- The install_state row says schema 48, product version 0.4.18.
- The ledger has 0001 through 0048 applied.

Call: `cmdUpgrade(manifestPath, { ... })` with injected stubs for `resolveAccount`, `d1Query`, `cf` (returns a bookmark), `saveUpgradeBookmark`, and `readUpdateBacklog` (returns `{pending:0}`). The `cmdDeploy` stub records the call and then throws.

Observed:
- `answerSetupNeedsRecovery`=true.
- Events recorded: ["plan:pending: 0049-0056 (8)", "cf:.../time_travel/bookmark", "bookmark-saved", "beforeRemoteMutation", "DEPLOY paused=true", "d1:INSERT INTO upgrade_runs ..."].
- So the paused deploy was reached with the journal present.

Comparison: for the same journal, `cmdUpdate` refuses with HALF_RUN before any remote work (test/fix-0419-partner-r1.test.mjs:605). The real CLI route is `brain upgrade <manifest>` → brain.mjs:33301 → `cmdUpgradeInteractive` (brain.mjs:28664) → `cmdUpgrade`, with no journal check anywhere on that path.


### 7. [P2] New Windows test-chain entry fails on any Windows host: 9 of 20 tests

- Area: rest-of-diff. Finder severity P2, verifier severity P2.
- Location: `scripts/run-test-chain.mjs:768`; verifier: test/fix-0419-partner-r1.test.mjs:91 (the same platform loop at lines 133, 167, 207, 250, 309, 411) and test/fix-0419-partner-r1.test.mjs:666-668 (importMutant). The file enters the chain at scripts/run-test-chain.mjs:304 and :768.
- Same root cause as: #2, #3, #21 (the new partner test file test/fix-0419-partner-r1.test.mjs fails 9 of 20 tests on a Windows host).
- Inputs: Run `node --test test/fix-0419-partner-r1.test.mjs` on Windows. This file was added to TEST_COMMANDS and POST_LAUNCHER_TEST_COMMANDS at lines 304 and 768. The checkout used Git for Windows with the default core.autocrlf=true.
- Wrong outcome: Seven lock tests fail with 'the local Brain lifecycle lock is not private'. Each loops over `["win32", "darwin", "linux"]` (test lines 91, 133, 167, 207, 250, 309, and the empty-directory test at 410) and acquires real locks on disk with a simulated POSIX platform. On a Windows host chmod cannot clear the group and other mode bits, so assertPrivateDirectory refuses. Two mutant tests (lines 806 and 879) fail with 'mutant anchor exists in ...', because importMutant (lines 661-668) matches anchors that contain `\n` against CRLF working-tree files. The Windows gate for this Windows release therefore cannot pass, or its lock-test failures get waived as noise, and real regressions in the same file would be hidden. The existing test/brain-lifecycle-lock.test.mjs passes 11 of 11 on the same host because it uses the host platform.
- Finder's evidence: Local run from C:\offload\review-0419-final: 9 failed (the 7 lock tests above plus 'the fresh-empty-as-damaged mutant' and 'the drop-update-journal-guard mutant'). Probe C:\offload\review-0419-final-scratch\focus5\lock-probe.mjs: win32 acquired; darwin and linux FAILED brain_lifecycle_unsafe 'not private'. `file operations/answer-setup.mjs` reports CRLF line terminators.
- Fix: Make the real-filesystem iterations use only the host platform, for example `process.platform === "win32" ? ["win32"] : ["darwin", "linux", "win32"]`, or inject a no-op privacy check for the simulated platforms. In importMutant, normalize with `source = source.replace(/\r\n/g, "\n")` before matching anchors, or use single-line anchors.
- Verifier's fix note: (a) In the seven real-filesystem lock tests, replace the literal platform list with a host-aware one, e.g. `const LOCK_PLATFORMS = process.platform === "win32" ? ["win32"] : ["win32", "darwin", "linux"];` and loop over LOCK_PLATFORMS. (The empty-directory test at 411 uses `["win32","darwin"]`; give it the same filter.) A simulated POSIX platform cannot pass assertPrivateDirectory's chmod/mode check on an NTFS host, and the darwin and linux iterations still run on the macOS and Linux CI lanes. (b) In importMutant, normalize line endings right after reading the file: `let source = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");`. This keeps the multi-line anchors at lines 808 and 881 valid on a CRLF checkout. Alternatively, add `operations/*.mjs text eol=lf` (or at least operations/brain-lifecycle-lock.mjs and operations/answer-setup.mjs) to .gitattributes, the way brain.mjs is pinned. Then re-run `node --test test/fix-0419-partner-r1.test.mjs` on a Windows autocrlf checkout and confirm 20/20.
- Verifier's reasoning:

I traced and reproduced the claim. It holds as stated. It is a test-harness defect only. No product code is wrong, but the new chain entry cannot pass on any Windows host.

1. Lock tests (7 failures, happen even on an LF checkout). Seven tests loop over ["win32","darwin","linux"]: test/fix-0419-partner-r1.test.mjs:91, 133, 167, 207, 250, 309, and the empty-directory test at 411. Each acquires a real lock under %TEMP% with the platform faked. For darwin and linux, acquireBrainLifecycleLock (operations/brain-lifecycle-lock.mjs:354-365) skips the win32 ACL branch and calls assertPrivateDirectory (lines 105-121). On a Windows host process.getuid is undefined, and lstat reports group and other mode bits on directories. chmodSync(path, 0o700) at line 115 can only toggle the read-only attribute, so (mode & 0o077) stays non-zero. Line 117 then throws brain_lifecycle_unsafe "the local Brain lifecycle lock is not private". No option skips this check: restrictWindowsDirectory only covers the win32 branch. My probe C:\offload\review-0419-final-scratch\verify-crlf-lock\probe.mjs printed: win32 acquired; darwin FAILED brain_lifecycle_unsafe not private; linux FAILED the same way.

2. Mutant tests (2 failures, CRLF checkouts only). importMutant (test lines 661-670) reads the working-tree source as raw text and asserts source.includes(before). Two anchors contain "\n": line 808 targets operations/brain-lifecycle-lock.mjs and line 881 targets operations/answer-setup.mjs. .gitattributes pins brain.mjs and several fixtures to LF, but not these operations files or the test. `git ls-files --eol` shows i/lf w/crlf for both, and core.autocrlf=true. The .gitattributes comment itself says Windows runners use autocrlf. The probe showed both anchors missing in the raw text and present once the text is normalized to LF.

3. Full reproduction. `node --test test/fix-0419-partner-r1.test.mjs` from C:\offload\review-0419-final on Node 24.18.0: 20 tests, 11 passed, 9 failed. The failures are exactly the 7 lock tests ("the local Brain lifecycle lock is not private") and the 2 mutants ("mutant anchor exists in operations/brain-lifecycle-lock.mjs" and "... operations/answer-setup.mjs").

4. Nothing in the chain absorbs this. The file is listed in both POST_LAUNCHER_TEST_COMMANDS (line 304) and TEST_COMMANDS (line 768). runTestCommands (run-test-chain.mjs:857-899) has no per-platform skip or known-failure list, so any non-zero exit fails the chain. The CI Windows lane (ci.yml:373-379, windows-latest, actions/checkout) and the local Windows gate both run `npm test`, so both turn red.

Why P2 and not higher: the win32 iteration of each lock loop runs and passes before the simulated-platform iteration throws, and the two mutants run on the macOS and Linux lanes. Owner data and the update path are untouched. What is at risk is the Windows gate for a Windows-owner release: it cannot go green, and waiving these 9 failures as known noise would hide a real regression in the same file.

- Reproduction: From C:\offload\review-0419-final (Git for Windows, core.autocrlf=true, Node 24.18.0): `node --test --test-reporter=spec test/fix-0419-partner-r1.test.mjs` gives tests 20, pass 11, fail 9. Seven fail with BrainLifecycleLockError brain_lifecycle_unsafe "the local Brain lifecycle lock is not private". "the fresh-empty-as-damaged mutant" fails with "mutant anchor exists in operations/brain-lifecycle-lock.mjs". "the drop-update-journal-guard mutant" fails with "mutant anchor exists in operations/answer-setup.mjs". The full log is at C:\offload\review-0419-final-scratch\verify-crlf-lock\run1.txt. Probe: `node C:\offload\review-0419-final-scratch\verify-crlf-lock\probe.mjs` prints "win32 acquired", "darwin FAILED brain_lifecycle_unsafe ... not private", "linux FAILED ...", then for both operations files "raw has CRLF: true anchor raw: false anchor normalized: true". The checkout stayed clean (git status empty).

### 8. [P3] A holder releasing mid-check makes a waiting contender crash with a TypeError or a non-retryable 'unsafe' error instead of retrying

- Area: lock-rule. Finder severity P3, verifier severity P3.
- Location: `operations/brain-lifecycle-lock.mjs:408`; verifier: operations/brain-lifecycle-lock.mjs:376-432 (EEXIST branch: 378, 389-391, 408-409, 419-420, 429-430). Related: 354/377 (mkdir EPERM on Windows delete-pending) and 289-291 (readOwner treats a just-created, still-empty owner file as malformed). Pre-existing at f8a7cd05; the diff narrowed it but did not close it.
- Inputs: `brain update` is in its 120 s wait loop polling every 500 ms because the daily refresh holds the lock. The daily refresh releases (unlink, then rmdir) between the contender's readdirSync at line 391 and its readOwner at line 408. A variant: a third process has just re-created the directory but not yet written its owner file.
- Wrong outcome: readOwner returns null, and `isOwnerAlive(owner.pid)` throws `TypeError: Cannot read properties of null (reading 'pid')`. In the variant, readOwner sees zero entries and throws brain_lifecycle_unsafe 'the Brain lifecycle lock contains unexpected files' (retryable=false). withBrainLifecycleLockWait retries only brain_lifecycle_busy. The update therefore ends in the generic crash handler, or in UPGRADE_FAILED with a damage-sounding message, at the exact moment the lock became free. The daily run records 'failed' instead of acquiring or deferring. The same unguarded ENOENT exists at lines 378, 390-391, 419 (the second readOwner returns null when a rival reclaimer wins) and the takeover unlinkSync at 429.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus1-lock\race-probe.mjs releases the holder inside the contender's first readdirSync, patching node:fs with syncBuiltinESMExports. It printed 'case1 TypeError | Cannot read properties of null (reading 'pid')' and 'case2 BrainLifecycleLockError brain_lifecycle_unsafe retryable=false | the Brain lifecycle lock contains unexpected files'.
- Fix: In the EEXIST branch, treat a vanished or emptied directory as contention, not damage. Wrap lstatSync/readdirSync and `continue` on ENOENT. If readOwner returns null (first or second read), `continue`. If the directory has become empty, throw the retryable 'being acquired' busy error rather than letting readOwner throw unsafe. In the takeover branch, `continue` on ENOENT from unlinkSync or rmdirSync.
- Verifier's fix note:

In the EEXIST branch, treat any sign that the lock was released or is mid-acquire as contention, not damage.

1. Wrap 378-391 so that ENOENT from lstatSync, assertPrivateDirectory or readdirSync does `continue` and retries mkdir immediately, because the lock may now be free.
2. Give readOwner a way to say "transient": return null on ENOENT and a distinct `{empty:true}` when entries.length === 0, rather than throwing unsafe. At 408 and 419: on null, `continue`. On empty, throw the existing retryable "being acquired" brain_lifecycle_busy.
3. For a malformed or zero-length owner file whose mtime is within a few seconds of now, throw the "being acquired" busy error, not unsafe. A cleaner option is to stop the window ever existing: write the owner JSON to a temp file in the lock root, then renameSync it into the lock directory, so a reader never sees a partial owner file.
4. At 429-430, catch ENOENT from unlinkSync or rmdirSync and `continue`, since a rival reclaimer won.
5. On win32, when mkdirSync at 354 or readdirSync raises EPERM, re-lstat the path. If it is missing or delete-pending, throw retryable brain_lifecycle_busy instead of rethrowing the raw error.

Add a regression test that releases the holder between the contender's first and second directory reads, and another that leaves the directory empty. Both should end in busy (retryable) or a successful acquire, never TypeError or unsafe.

- Verifier's reasoning:

I tried to refute this and could not. The code path is as described, and I reproduced it with real processes and no fs patching.

The EEXIST branch of acquireBrainLifecycleLock (operations/brain-lifecycle-lock.mjs:376-454) reads the lock directory several times, one syscall after another: lstatSync at 378, assertPrivateDirectory's lstat at 389, lstatSync at 390, readdirSync at 391, readOwner at 408 (which runs readdirSync again at 271, then lstat and readFileSync), and the second readOwner at 419. Nothing stops a holder in another process from running releaseOwner (unlinkSync at 320, then rmdirSync at 321) in between. A rival acquirer can also run mkdirSync followed by writeFileSync with flag wx. Only the empty-directory case at 391 is turned into a retryable busy error. Every other observation that shows the lock was freed or is half-built gets reported as damage or crashes:
- The directory is gone. lstatSync or readdirSync throws a raw ENOENT, or readOwner returns null and `owner.pid` at 409 (or `current.pid` at 420) throws a TypeError.
- The directory is empty after the owner file was unlinked but before rmdir. readOwner throws brain_lifecycle_unsafe "unexpected files" (277).
- A rival's owner file was created by wx but not yet written. JSON.parse fails, giving brain_lifecycle_unsafe "owner is malformed" (290-291).
- On Windows the directory is delete-pending. mkdirSync at 354 fails with EPERM, which 377 rethrows, or readdirSync fails with EPERM.

withBrainLifecycleLockWait (511) retries only brain_lifecycle_busy. In cmdUpdate (brain.mjs:31565-31572), unsafe errors become UPGRADE_FAILED with a damage-sounding message, and raw or TypeError errors go to the generic crash handler. runDailyRefresh (daily-refresh-run.mjs:193-194) rethrows anything that is not busy or recovery_required, so the scheduled run fails instead of recording "deferred".

Real-process reproduction: three node processes contended on one scratch lock root for 20 s, each looping acquire and release through the real module, with only restrictWindowsDirectory injected as a no-op. Each process saw 30k+ busy results and, as well, non-retryable failures:
- ENOENT on lstat (398, 486 and 509 per process)
- ENOENT on scandir (55-71)
- TypeError "Cannot read properties of null (reading 'pid')" (14-22)
- brain_lifecycle_unsafe "unexpected files" (40-50)
- brain_lifecycle_unsafe "owner is malformed" (24-48)
- EPERM on scandir or mkdir (1-6)

So the interleaving can really happen on Windows. It is not just an artifact of the claimant's patched-fs probe.

Why this is only P3:
1. Every failure happens before the update task runs. There is no journal, fence or remote write, so nothing on the Brain changes and a rerun succeeds.
2. In the supervised update the window is tiny. The vulnerable span is about a millisecond against a 500 ms poll, and it only exists while the daily refresh is actually holding the lock. My estimate is at most about 0.2% per contention episode.
3. This is not new. The TypeError and "unexpected files" path at readOwner was already in f8a7cd05. The diff narrowed it by making the empty-directory-at-391 case busy and retryable, but left the rest of the time-of-check/time-of-use gap.

Severity: confusing, non-retryable failure text, and a daily run marked failed instead of deferred, at the moment the lock frees. No owner data or Brain state is affected, so P3 is right.

- Reproduction:

Probe files: C:\offload\review-0419-final-scratch\verify-lock-midcheck-race\worker.mjs and run.mjs. They import file:///C:/offload/review-0419-final/operations/brain-lifecycle-lock.mjs read-only, with machineLockRoot set to a fresh mkdtemp under that scratch folder and restrictWindowsDirectory set to () => true. There is no fs monkey-patching.

Command: node C:\offload\review-0419-final-scratch\verify-lock-midcheck-race\run.mjs 20 3

The script starts three real processes. Each one loops acquireBrainLifecycleLock({operation:"update"}) then release() for 20 s and counts the error classes it sees.

Output for one process: acquired 4146, busy 6152, "ENOENT lstat" 486, "ENOENT scandir" 60, "TypeError Cannot read properties of null (reading 'pid')" 22, "brain_lifecycle_unsafe ... contains unexpected files" 50, "brain_lifecycle_unsafe ... owner is malformed" 26, "EPERM scandir" 6. The other two processes show the same classes.

Every failure other than busy is the kind withBrainLifecycleLockWait does not retry. The same TypeError and unsafe outcome came from the claimant's deterministic probe, C:\offload\review-0419-final-scratch\focus1-lock\race-probe.mjs.


### 9. [P3] Busy messages for a dead-but-fresh owner give no wait time, and the self-PID case tells the user to wait for a process that is the contender itself

- Area: lock-rule. Finder severity P3, verifier severity P3.
- Location: `operations/brain-lifecycle-lock.mjs:434`; verifier: operations/brain-lifecycle-lock.mjs:434-447 (holderStatus/guidance); brain.mjs:31556 (retryCommand literal); support-recovery.mjs:95 (UPDATE_BRAIN_BUSY card)
- Same root cause as: #11 (a killed lock holder blocks for about 30 minutes without wait guidance).
- Inputs: During the supervised update, `brain update` is interrupted (Ctrl+C or the window is closed). Neither path emits 'exit', so the owner record stays. The update is re-run within 30 minutes.
- Wrong outcome: The re-run waits 120 s, then dies with UPDATE_BRAIN_BUSY: 'The recorded process is no longer running, but the lock is still inside its recovery window. Wait for the recovery window to end, then run brain update <manifest> again.' The window is 30 minutes from the last heartbeat, but the message gives no length. The operator retries blindly, losing 2 minutes per try, and the literal '<manifest>' is printed instead of the path. If the contender happens to have the dead owner's PID, holderStatus says 'A process with that ID is running... Wait for it to finish'. That process is the contender itself, and the recorded owner is provably dead.
- Finder's evidence: A real-process probe on this Windows host (C:\offload\review-0419-final-scratch\focus1-lock\probe.mjs) killed the holding child. The dead-fresh attempt printed the message above, and the same lock was acquired only with a clock 31 minutes later. The update passes retryCommand 'brain update <manifest>' (brain.mjs:31556), and renderCliCommands leaves '<manifest>' unchanged.
- Fix: Compute `remainingMs = staleAfter - (observedAt - owner.mtimeMs)` and say 'try again in about N minutes'. When owner.pid === process.pid and the instance differs, say the recorded process has stopped (and give the same remaining time). In cmdUpdate, pass retryCommand built with the real manifest path (commandPath(displayPath(lockManifestPath))), as the other update messages already do.
- Verifier's fix note:

In acquireBrainLifecycleLock, after line 418, compute:
  const remainingMinutes = Math.max(1, Math.ceil((staleAfter - (observedAt.getTime() - owner.mtimeMs)) / 60_000));
  const priorSamePid = ownerIsPriorProcessWithContenderPid(owner, contenderInstance);

Treat (!live || priorSamePid) as the 'stopped' case. holderStatus becomes "The process that held the lock has stopped. The lock stays reserved for about ${remainingMinutes} more minute(s) in case it was still finishing." The guidance for that case when not stale becomes "${holderStatus} Wait about ${remainingMinutes} minute(s), ${busyRetryInstruction(retryCommand)}". Keep the live-and-same-instance and live-unknown wording only for a genuinely live, different holder, so the same-PID case can no longer reach "Wait for it to finish". Optionally, have withBrainLifecycleLockWait stop early when the error says the holder has stopped, so the operator does not spend 120 s first.

In cmdUpdate (brain.mjs:31556), use the real path, as line 31415 already does:
  retryCommand: `brain update ${commandPath(displayPath(lockManifestPath))}`

Split or extend the UPDATE_BRAIN_BUSY card (support-recovery.mjs:95) so it covers lifecycle-lock contention and says to wait up to 30 minutes after an interrupted update, instead of only "a few minutes" for a readiness check.

Add a test in test/brain-lifecycle-lock.test.mjs. With isOwnerAlive returning false and a fresh mtime, the message should contain the remaining minutes and no '<manifest>'. With an owner record that has pid === process.pid and a foreign process_instance, the message should say the holder stopped and not say "Wait for it to finish".

- Verifier's reasoning:

I traced the claim through the final head and reproduced it. Nothing elsewhere guards it, and it only affects wording, so P3 is the right rating.

1. No 'exit' on interrupt. brain.mjs installs no SIGINT, SIGHUP or SIGBREAK handler. The only Ctrl+C handling is the raw-mode prompt reader at brain.mjs:978, which runs only while a prompt is open. operations/windows-task-contract.mjs:309 adds signal handlers only for the duration of its own task. So a Ctrl+C or window close during the rest of the update kills Node without 'exit', and the release at brain-lifecycle-lock.mjs:487 never runs. The owner record stays, and its mtime freezes at the last heartbeat (written every 10 s at line 477).

2. Dead-but-fresh path. At lines 409-418, live=false gives ownerDead=true, but stale=false, so the lock is not reclaimed. Lines 434-447 then pick holderStatus "The recorded process is no longer running, but the lock is still inside its recovery window." and guidance "Wait for the recovery window to end, then run <retry> again." No duration is computed, though staleAfter and owner.mtimeMs are both available right there.

3. Waiting and output. cmdUpdate (brain.mjs:31551-31558) calls withBrainLifecycleLockWait with waitMs 120000 and retryCommand "brain update <manifest>". At 31566-31570 it re-throws the error as a Fatal with code UPDATE_BRAIN_BUSY. The top-level catch (brain.mjs:~33657-33673) prints it through renderCliCommands. That function (operations/cli-guidance.mjs:108-118) only rewrites the 'brain' prefix, so '<manifest>' prints literally. That includes the bare `brain update` case, where the manifest was found automatically. The receipt line then points to `brain support --explain UPDATE_BRAIN_BUSY`. That card (support-recovery.mjs:95) describes a readiness-check problem and says "Wait a few minutes". That makes it worse: the real wait is up to 30 minutes from the last heartbeat.

4. Same-PID case. Suppose the owner record carries the contender's own PID with a different process_instance (the dead update's PID was reused by the new run). isOwnerAlive returns true because the contender itself is running. If the lock is fresh, line 438 prints "A process with that ID is running, but this computer could not confirm it is the same one." and line 446 adds "Wait for it to finish". But ownerIsPriorProcessWithContenderPid has already proven the owner is a different, finished process, and the running process is the contender.

Reproduced with a probe that only reads the head: C:\offload\review-0419-final-scratch\verify-lock-msg\probe.mjs and child.mjs. A real child process took the lock and was killed with SIGKILL (no 'exit').
- Immediate retry: brain_lifecycle_busy with the exact "recovery window ... then run brain update <manifest> again." text.
- Clock at +29 min: the same message.
- Clock at +31 min: acquired.
- Same-PID owner record: "A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish, then run brain update <manifest> again." With waitMs it waited the full period and still failed.
- Same-PID at +31 min: acquired.

Why P3 and not higher. The 30-minute hold is a deliberate fail-safe and still fails safe. No data is lost, nothing is corrupted and no guard is bypassed. The update stays blocked and then recovers on its own. The literal '<manifest>' placeholder is used 28 times in brain.mjs, so on its own it is a consistency problem. The real harm is operational: a supervised operator retries blindly, each attempt costs 120 s, and the support card points to the wrong cause and too short a wait.

- Reproduction:

Run `node C:\offload\review-0419-final-scratch\verify-lock-msg\probe.mjs`. It imports C:\offload\review-0419-final\operations\brain-lifecycle-lock.mjs and uses a private machineLockRoot under the scratch folder.

Case 1: child.mjs takes the 'update' lock and kills itself with SIGKILL (no 'exit' event). The parent then calls acquireBrainLifecycleLock with retryCommand 'brain update <manifest>'.
- At now: brain_lifecycle_busy, "...The recorded process is no longer running, but the lock is still inside its recovery window. Wait for the recovery window to end, then run brain update <manifest> again."
- At now+29 min: the same message.
- At now+31 min: acquired.

Case 2: the probe writes an owner record with pid = the probe's own PID and a different process_instance.
- At now: "A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish, then run brain update <manifest> again."
- withBrainLifecycleLockWait (waitMs 1500) waits the full 1.5 s and still fails busy.
- At now+31 min: acquired.

In the real CLI, cmdUpdate's 120 s wait (brain.mjs:31557) runs before this text is printed with code UPDATE_BRAIN_BUSY. The receipt then points to the support card at support-recovery.mjs:95, which says "Wait a few minutes".


### 10. [P3] The new half-run check before the lock reports 'setup was interrupted' while another answer setup is still running

- Area: lock-rule. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19619`; verifier: brain.mjs:19619
- Same root cause as: #13, #19, #23, #18 (the half-run check in brain connect anthropic runs before the lock).
- Inputs: `brain connect anthropic <manifest>` is running and holds the lifecycle lock. It writes the half-run journal before the manifest edit (operations/answer-setup.mjs:452) and keeps it through secret put, deploy and checks. A second `brain connect anthropic <manifest>` starts in another terminal.
- Wrong outcome: The second command reads the journal outside the lock and dies with HALF_RUN(manifestPath). Because secretNameExisted is undefined, that becomes 'The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help.' The live setup then finishes normally, so the owner was given a false alarm instead of the lock's busy message. The update's equivalent check (brain.mjs:30958) runs inside the lock and does not have this problem.
- Finder's evidence: The journal check at brain.mjs:19617-19621 runs before runManifestControl and before runAnthropicAnswerSetup takes the lifecycle lock (answer-setup.mjs:370). answerSetupNeedsRecovery is a bare lstat with no ownership check.
- Fix: When the journal is present, first attempt a non-blocking acquireBrainLifecycleLock({ manifestPath, operation: 'answer-setup' }). If it throws brain_lifecycle_busy, die with that busy message. Otherwise release it and die with HALF_RUN. This keeps the check ahead of Cloudflare control.
- Verifier's fix note:

In cmdConnect's anthropic branch, when setupNeedsRecovery(manifestPath) is true, check the lock before dying with HALF_RUN. Use a short non-blocking probe:

try { await withBrainLifecycleLock({ manifestPath, operation: 'answer-setup', retryCommand: 'brain connect anthropic <manifest>' }, async () => {}); } catch (error) { if (error?.code === 'brain_lifecycle_busy') die(error.message); if (error?.code === 'brain_lifecycle_recovery_required') die(UPDATE_FIRST(manifestPath)); throw error; }

Only then call die(HALF_RUN(manifestPath)).

Run the probe only when the journal is present, so an absent journal behaves as before. The check still runs before Cloudflare control. The in-lock journalExists check at operations/answer-setup.mjs:372 still covers the window between this probe's release and the real acquisition.

Also add a test: hold the lock with operation 'answer-setup' and a journal present, then expect the busy message, not HALF_RUN. Keep the existing journal-present/no-lock test expecting HALF_RUN.

- Verifier's reasoning:

I traced the path in the final head and reproduced it.

1. cmdConnect('anthropic') at brain.mjs:19617-19621 is new in this diff. It calls answerSetupNeedsRecovery(manifestPath) before runManifestControl and before cmdConnectAnthropic. The lifecycle lock is taken only later, in runAnthropicAnswerSetup at operations/answer-setup.mjs:370, through withBrainLifecycleLock (non-blocking).
2. answerSetupNeedsRecovery (operations/answer-setup.mjs:225-233) is a bare lstat of `<manifest dir>/.answer-setup-journal.json`. It does not check who wrote the journal or whether the lock is held.
3. A live setup writes the journal at operations/answer-setup.mjs:452, inside the lock. It keeps it through reconcileDaily, putSecret, verifyDeploy, deploy (cmdDeploy) and the worker-check loop, which can run up to 60s. It removes the journal only at 497/524 on success or 566 after rollback. That is a window of a minute or more.
4. A second `brain connect anthropic <manifest>` in that window gets true from step 2. It dies with HALF_RUN(manifestPath). No secretNameExisted is passed, so HALF_RUN returns INTERRUPTED_WITH_STORED_KEY (operations/answer-setup-copy.mjs:23, 31-33).
5. Before this diff, the same second command would have reached the lock and died with the brain_lifecycle_busy message. The update path's check (brain.mjs:30958) runs inside cmdUpdate's withBrainLifecycleLockWait when a lock manifest path exists, so it does not have this problem in that case.

Probe: in a child process I held the real lifecycle lock (operation answer-setup, lock root redirected to scratch) and wrote the journal. In the parent I called the real cmdConnect('anthropic', ...) with a pass-through withManifestControl stub.
- Journal present: the second command printed the "interrupted part way... Ask the person who set up your Brain for help" message. controlCalls was 0.
- Journal removed, same live holder: the second command got the lock's busy message ("the Brain lifecycle lock is held by answer-setup since ... Wait for it to finish, then run the same command again.").

So the wrong message depends only on which phase the live setup is in.

Why P3: nothing is written, no secret is touched, and the advice is on the safe side (do not remove the connection, ask for help). The live setup finishes normally. The harm is a false alarm that can send the owner or supporter into a needless recovery conversation. It needs two concurrent connect runs on the same Brain, which is rare in a supervised session.

- Reproduction:

Scratch probe: C:\offload\review-0419-final-scratch\lock-rule-verify\probe.mjs and holder.mjs, with BRAIN_LIFECYCLE_LOCK_ROOT pointing at the scratch locks folder.
1. holder.mjs runs acquireBrainLifecycleLock({manifestPath, operation:'answer-setup'}) in a child process. It writes .answer-setup-journal.json next to the manifest, as the live setup does at operations/answer-setup.mjs:452, and holds the lock for 30s.
2. The parent imports cmdConnect from brain.mjs and calls cmdConnect('anthropic', {argv:[node,'brain.mjs','connect','anthropic',manifestPath,'--keep-key'], withManifestControl:(p,a)=>a(), anthropicOptions:{loadManifest stub, listSecretNames throws, verifyVersion noop}}).
   Output A (journal present, lock held): "The Claude setup was interrupted part way. Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help." controlCalls=0.
3. The parent deletes the journal and calls again with the same live holder.
   Output B: "the Brain lifecycle lock is held by answer-setup since <time>. ... Wait for it to finish, then run the same command again."
The message the owner sees depends only on which phase the concurrent live setup is in.


### 11. [P3] A killed lock holder blocks brain update for about 30 minutes, and neither the message nor the UPDATE_BRAIN_BUSY explanation says so

- Area: busy-messages. Finder severity P2, verifier severity P3.
- Location: `operations/brain-lifecycle-lock.mjs:434`; verifier: operations/brain-lifecycle-lock.mjs:434-447 (also 402-406). brain.mjs:31566-31570 maps lifecycle busy to UPDATE_BRAIN_BUSY. support-recovery.mjs:95 holds the stale readiness-check catalog text.
- Same root cause as: #9 (a killed lock holder blocks for about 30 minutes without wait guidance).
- Inputs: Any Brain command that holds the lifecycle lock is killed instead of exiting normally. Examples: Ctrl+C, closing the console window, an agent tool timeout, or a Task Scheduler time limit on the daily task. brain.mjs has no SIGINT handler, so the owner file stays behind. The operator then reruns `brain update` within 30 minutes.
- Wrong outcome: The update waits 120 s with no output and then fails. It prints: "the Brain lifecycle lock is held by update since <UTC>. The recorded process is no longer running, but the lock is still inside its recovery window. Wait for the recovery window to end, then run brain.cmd update <manifest> again." The message never says how long the window is. The receipt then sends the owner to `brain support --explain UPDATE_BRAIN_BUSY`, which is wrong for this case: it says "The readiness check could not get a complete answer", "Wait a few minutes, then run brain update again", "If the same check is still busy, run brain health once and keep its output for support", and calls a technician after one retry. Following it, the operator escalates to support or retries every few minutes, paying 2 more minutes each time. The real fix is to wait about 30 minutes from the holder's last heartbeat. At the C1 snapshot the same dead holder was taken over immediately, so this is a new failure mode for the supervised update.
- Finder's evidence: I probed this on this Windows host with a real second process holding the lock (scratch probe.mjs). Killed holder: busy immediately, busy at +29 min, acquired at +31 min. The same probe against the f8a7cd05 lock module acquired immediately. cmdUpdate maps the busy error to UPDATE_BRAIN_BUSY (brain.mjs:31566-31570). The catalog entry in support-recovery.mjs:95 still describes the backlog readiness check. A probe-update.mjs run printed both the screen line and the explain text quoted above.
- Fix: In the !live branch (lines 434-447), compute remaining = staleAfter - (observedAt - owner.mtimeMs) and say e.g. "Wait about N minutes (until HH:MM), then run ...". Do the same for the fresh-empty-directory branch at 402-406. Give lifecycle contention its own catalogued support code, or rewrite the UPDATE_BRAIN_BUSY entry to cover lock contention with the real wait. Optionally print one "waiting for <operation> to finish" line when withBrainLifecycleLockWait starts waiting in cmdUpdate.
- Verifier's fix note:

1) In the `!live` branch of acquireBrainLifecycleLock, compute `remainingMs = Math.max(0, owner.mtimeMs + staleAfter - observedAt.getTime())` and `minutes = Math.max(1, Math.ceil(remainingMs / 60_000))`. Say: "The recorded process is no longer running. The lock clears itself in about ${minutes} minutes (at ${new Date(owner.mtimeMs + staleAfter).toISOString()}). Wait until then, " + busyRetryInstruction(retryCommand). Apply the same computation, from directoryState.mtimeMs, to the empty-directory branch at lines 402-406.

2) Stop routing lifecycle contention to the readiness-check entry. Either:
- add a separate code (for example UPDATE_LIFECYCLE_BUSY) to support-journal.mjs's code list and to the support-recovery.mjs CATALOG, saying another Brain task holds the lock, or the last one was interrupted and the lock clears itself up to 30 minutes after its last heartbeat, and use it at brain.mjs:31569; or
- rewrite the UPDATE_BRAIN_BUSY entry at support-recovery.mjs:95 so it covers both causes and says to follow the wait time printed above, not "a few minutes".

3) Optional: when withBrainLifecycleLockWait starts waiting in cmdUpdate, print one line such as "Waiting up to 2 minutes for <operation> to release the Brain lock". Then the 120 s wait is not silent.

Add a lock test that asserts the `!live`, not-stale message contains a minute count. Add a support-recovery test that asserts the lifecycle-busy code's guide does not mention the readiness check.

- Verifier's reasoning:

I traced the full path in the final head, and a probe on this Windows host reproduced it.

1) What changed. The only commit in scope is 5d8f804d. It changed operations/brain-lifecycle-lock.mjs:418 so a holder is taken over only when it is `stale && ownerDead`. `stale` means owner.mtimeMs is older than staleAfter, and DEFAULT_STALE_MS is 30 min (line 29). At f8a7cd05, a dead PID (`!live`) made `sameProcess` false, so the lock was taken over at once. The commit message says this was deliberate: "a dead PID is reaped only after the stale age". So the 30-minute block itself is by design and is not a defect. The defect is the guidance around it.

2) The killed holder leaves its owner file behind. Release is wired only through process.once("exit") at line 487. No SIGINT, SIGTERM, SIGHUP or SIGBREAK handler covers the lifecycle lock in brain.mjs. The only signal handlers are in operations/windows-task-contract.mjs:309, for a different lock, and they are removed in a synchronous finally. A hard kill or Ctrl+C therefore skips 'exit', and the heartbeat at line 476 kept mtime current until the kill.

3) The message. For `!live`, lines 434-447 give: "The recorded process is no longer running, but the lock is still inside its recovery window. Wait for the recovery window to end, then run brain update <manifest> again." No duration or end time is shown anywhere. heldMinutes is used only in the live&&stale branch, and no doc mentions a 30-minute window (git grep found none).

4) The wrong recovery guide. cmdUpdate (brain.mjs:31551-31570) uses waitMs 120_000 and then maps brain_lifecycle_busy to UPDATE_BRAIN_BUSY through dieWithSupportCode. The main Fatal handler (brain.mjs:33666-33671) prints the fail line plus "Need help with this? Run: brain support --explain UPDATE_BRAIN_BUSY". That catalog entry (support-recovery.mjs:95, unchanged by this diff) describes a different cause, the backlog readiness check. It says "Wait a few minutes, then run brain update again", then "run brain health", and it escalates to a technician after one retry. Following it cannot clear the lock and costs 2 minutes per retry. The busy-to-UPDATE_BRAIN_BUSY mapping is new in this diff, and test fix-0419-partner-r1.test.mjs:580-603 asserts it.

Severity re-rated from P2 to P3. There is no data, secret or safety impact: the lock fails closed and recovers by itself after the window. The on-screen text is accurate, just incomplete. The cost is up to about 30 minutes of unexplained stall in the supervised session, plus wrong escalation advice. It needs a prior hard kill of a lock holder (ingest, load, daily-schedule, connect or disconnect anthropic, quickbooks-desktop, or update) in the last 30 minutes.

A side observation outside this claim: ownerAlive is process.kill(pid,0). If Windows reuses the dead PID for an unrelated long-lived process, `live` stays true and ownerDead stays false. The lock is then never taken over, and after 30 min the message switches to "restart the computer". That deserves its own review item.

- Reproduction:

I used scratch files in C:\offload\review-0419-final-scratch\verify-busy-window\ (holder.mjs, probe.mjs, explain.mjs), imported from the read-only head.

holder.mjs runs acquireBrainLifecycleLock({manifestPath, machineLockRoot, operation:"update"}) in a real child node process. probe.mjs kills that child with child.kill(), which is TerminateProcess on Windows. Results:
- The owner file owner-<pid>-<token>.json survived the kill.
- In the parent, acquireBrainLifecycleLock({operation:"update", retryCommand:"brain update <manifest>", now: mtime+1s}) threw brain_lifecycle_busy: "...held by update since <UTC>. The recorded process is no longer running, but the lock is still inside its recovery window. Wait for the recovery window to end, then run brain update <manifest> again."
- At mtime+29 min it gave the same busy error. At mtime+31 min it ACQUIRED.

explain.mjs renders supportRecovery("UPDATE_BRAIN_BUSY"). It printed: "What happened: The readiness check could not get a complete answer before the update began", "1. Wait a few minutes, then run brain update again. 2. If the same check is still busy, run brain health once...", and "A technician can help when: The readiness check stays busy after one retry."

By code reading: cmdUpdate waits 120 s (brain.mjs:31557), then calls dieWithSupportCode(msg, "UPDATE_BRAIN_BUSY") (brain.mjs:31567-31570). The main handler prints the receipt pointing to `brain support --explain UPDATE_BRAIN_BUSY` (brain.mjs:33668-33670).


### 12. [P3] brain update refuses an interrupted answer-setup journal, but the refusal is filed as UPGRADE_FAILED, which says to rerun brain update, and no surface gives the setup person a recovery step

- Area: busy-messages. Finder severity P2, verifier severity P3.
- Location: `brain.mjs:30959`; verifier: brain.mjs:30959
- Same root cause as: #25 (pre-start update refusals are filed as UPGRADE_FAILED).
- Inputs: `.answer-setup-journal.json` exists next to the manifest, for example after a `brain connect anthropic` run was killed after answer-setup.mjs:452 wrote it. The owner or operator runs `brain update`.
- Wrong outcome: The update dies with HALF_RUN: "The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help." This die has no support code, so supportErrorCode classifies it as UPGRADE_FAILED. The receipt points to `brain support --explain UPGRADE_FAILED`, which says "Run brain update once more; it picks up where it stopped". That loops on the same refusal. The setup person gets no procedure either: the runbook (onboarding/06-runbook-top-ten-failures.md:768) and the ANTHROPIC_ROLLBACK_INCOMPLETE catalog entry (support-recovery.mjs:62) both say "Leave the saved connection and half-run journal unchanged. Ask the person who set up your Brain for help." That is circular. When the journal records no prior key, the screen line from ROLLBACK_INCOMPLETE(manifest, false) says to run `brain disconnect anthropic <manifest>`, while the explain printed right under it says to leave everything unchanged. Every later surface calls HALF_RUN without the journal flag, so it forbids that same disconnect. The net effect: all future updates of that Brain stay refused, with no documented exit. This store owner's update is not affected, because answer setup is new in 0.4.19.
- Finder's evidence: probe-halfrun.mjs: supportErrorCode(new Error(HALF_RUN(path)), {command:'update'}) returns UPGRADE_FAILED, and its rendered explain says to rerun brain update. Rendering ANTHROPIC_ROLLBACK_INCOMPLETE gives the leave-unchanged text. ROLLBACK_INCOMPLETE('<manifest>', false) gives the disconnect line. All three HALF_RUN call sites (brain.mjs:19620, brain.mjs:30959, answer-setup.mjs:373) pass one argument.
- Fix: Use dieWithSupportCode(HALF_RUN(installed.path), "ANTHROPIC_ROLLBACK_INCOMPLETE"), or a dedicated ANSWER_SETUP_HALF_RUN code. Add a technician procedure to the runbook and catalog that resolves the journal by its recorded secret_name_existed: restore the manifest fields from the journal and keep the key when it existed; run disconnect when it did not. Make the screen line and the explain text for the same code agree.
- Verifier's fix note:

1. In cmdUpdateWithPrompts (brain.mjs:30959), replace `die(HALF_RUN(installed.path))` with `dieWithSupportCode(HALF_RUN(installed.path), "ANTHROPIC_ROLLBACK_INCOMPLETE")`. That code is already in SUPPORT_ERROR_CODES and its card is review_first with no "rerun brain update" advice. Do the same at the connect guard (brain.mjs:19620), so the support note names the real cause.

2. Make the screen line and the card agree:
   - Either pass the journal's recorded secret_name_existed to HALF_RUN on every surface, reading it best-effort and leaving it undefined when the journal is unreadable, so the no-prior-key case always shows the disconnect line;
   - or change the ANTHROPIC_ROLLBACK_INCOMPLETE card's first step to "Follow the instruction printed above this code", so it does not contradict ROLLBACK_INCOMPLETE(m, false).

3. Add a technician-only procedure to skills/financial-brain-technician/SKILL.md, not the owner runbook, for resolving .answer-setup-journal.json:
   - When secret_name_existed is false, run `brain disconnect anthropic <manifest>`.
   - When it is true, either restore retrieval.answer_model, retrieval.gate_model and the daily cap from the journal's `previous` block, remove the journal, then run `brain connect anthropic <manifest> --keep-key`; or, with the owner's approval, disconnect and reconnect with a newly created key.

4. Add a test that cmdUpdate with a journal present throws with supportCode ANTHROPIC_ROLLBACK_INCOMPLETE (not UPGRADE_FAILED).

- Verifier's reasoning:

I traced the claim through the final head and reproduced the core of it in-process.

1. The guard is new in this diff. brain.mjs:30958-30960 in cmdUpdateWithPrompts reads `if (answerSetupNeedsRecovery(installed.path)) die(HALF_RUN(installed.path));`. It runs before anything else in the update, and plain `die` throws a Fatal with no supportCode.

2. HALF_RUN is called with one argument here, at the connect guard (brain.mjs:19620), in health (brain.mjs:4297), in doctor (doctor.mjs:893) and in answer-setup.mjs:373. With one argument, `secretNameExisted === false` is false, so every later surface prints INTERRUPTED_WITH_STORED_KEY: "...Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help."

3. supportErrorCode (brain.mjs:593-626) finds no typed code, and none of its message regexes match that text. It falls through to `command === "update"` → UPGRADE_FAILED. classifyCliCredentialBoundary("update", ...) returns "update", which is the value currentSupportCommand gets. The main catch (brain.mjs ~33667) records UPGRADE_FAILED in the support journal and prints "Need help with this? Run: brain support --explain UPGRADE_FAILED".

4. The UPGRADE_FAILED card (support-recovery.mjs:94) says "Safe to retry: Yes. The same command is designed to resume safely" and "Run brain update once more; it picks up where it stopped". It also says one update stage "did not reach its verified completion point", but no stage started. A rerun hits the identical refusal. The support note keeps only the code, never the message, so the technician who receives `brain support --preview` sees a mid-update failure instead of an interrupted answer setup.

5. The ANTHROPIC_ROLLBACK_INCOMPLETE contradiction is real. ROLLBACK_INCOMPLETE(m, false) tells the user to run `brain disconnect anthropic`, while that code's catalog card (support-recovery.mjs:62) and the runbook (onboarding/06-runbook-top-ten-failures.md:768) say to leave everything unchanged. One correction to the claim: the card is not printed under the screen line; only the "brain support --explain" pointer is.

6. No technician procedure exists. The runbook, the catalog and skills/financial-brain-technician/SKILL.md contain nothing on resolving the answer-setup journal beyond "ask the person who set up your Brain".

Probe output: Fatal, supportCode undefined, message = INTERRUPTED_WITH_STORED_KEY, boundary "update", supportErrorCode = UPGRADE_FAILED, and the rendered card shows "Run brain update once more; it picks up where it stopped."

What I could not refute: the misclassification and the contradictory guidance are real.

Why I rate it P3, not P2:
- The refusal itself is correct and fails safe, before any mutation.
- The UPGRADE_FAILED card escalates after one retry (step 2: "If it stops again at the same step, run brain support --preview and send us that note"), so this is one wasted rerun, not an endless loop.
- The code has a working exit. cmdDisconnectAnthropic (brain.mjs:20716-20797) has no journal guard and removes the journal at 20779-20782. The cost is the stored key, which the owner can recreate in the Claude Console, so no data is lost.
- The store owner's update cannot reach this path. Answer setup is new in 0.4.19 (added in 72e47136), and connect requires the updated Worker first (UPDATE_FIRST), so no journal can exist at schema 48 / 0.4.18.

The impact is wrong recovery text and a support-triage code that points the wrong way, on a rare path: after a killed setup or a failed rollback.

- Reproduction:

Probe at C:\offload\review-0419-final-scratch\busy-messages-verify-halfrun\probe.mjs, run with `node` from C:\offload\review-0419-final. Steps:
1. It creates a temp brain.manifest.json in a scratch fixture folder.
2. Next to it, it writes .answer-setup-journal.json (answerSetupJournal(..., {mode:'clipboard', secretExisted:false})).
3. It calls cmdUpdate(manifest, {lifecycleLockHeld:true, preDiscoveredInstalled:{path:manifest}}) and catches the error.

Output: Fatal, supportCode undefined, message "The Claude setup was interrupted part way. Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help." classifyCliCredentialBoundary('update') = 'update'. supportErrorCode(err,{command:'update'}) = UPGRADE_FAILED. renderSupportRecovery(supportRecovery('UPGRADE_FAILED','win32')) prints "Safe to retry: Yes. The same command is designed to resume safely" and "1. Run brain update once more; it picks up where it stopped."

The probe also shows the conflict: ROLLBACK_INCOMPLETE('<manifest>', false) gives the disconnect line, while the ANTHROPIC_ROLLBACK_INCOMPLETE card says "Leave the saved connection and half-run journal unchanged. Ask the person who set up your Brain for help." The fixture was removed afterwards.


### 13. [P3] A second `brain connect anthropic` while the first is still running is told the setup was "interrupted", not that it is busy

- Area: busy-messages. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19619`; verifier: brain.mjs:19619-19621 (cmdConnect, anthropic branch: pre-lock answerSetupNeedsRecovery -> die(HALF_RUN(manifestPath)))
- Same root cause as: #10, #19, #23, #18 (the half-run check in brain connect anthropic runs before the lock).
- Inputs: `brain connect anthropic <manifest> --from-clipboard` is in progress: it holds the answer-setup lock and has written its journal at answer-setup.mjs:452 (the worker check loop alone can take 60 s). The owner runs the same command again in another window.
- Wrong outcome: The new check before the lock sees the in-flight run's live journal and dies with "The Claude setup was interrupted part way. Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help." Nothing was interrupted. The true answer is the lock-busy "wait for it to finish" message, which is what the C1 code gave, because its only journal check sat inside the lock.
- Finder's evidence: probe-connect.mjs: a child process holds the lock with operation answer-setup, the journal is present, and cmdConnect('anthropic', ...) rejects with the HALF_RUN text before reaching manifest control.
- Fix: When answerSetupNeedsRecovery returns true in cmdConnect, try acquireBrainLifecycleLock({manifestPath, operation: 'answer-setup'}) before reporting HALF_RUN. If that throws brain_lifecycle_busy, die with its message. Otherwise release the lock and die HALF_RUN. The custody stop still comes before any Cloudflare control.
- Verifier's fix note:

In cmdConnect's anthropic branch, when setupNeedsRecovery(manifestPath) is true, check whether a live run holds the lock before reporting HALF_RUN. Steps:
1. Import acquireBrainLifecycleLock (injectable as options.acquireLifecycleLock).
2. try { const lock = acquire({ manifestPath, operation: 'answer-setup', retryCommand: 'brain connect anthropic <manifest>' }); lock.release(); } catch (error) { ... }
3. In the catch:
   - error.code === 'brain_lifecycle_busy': die(error.message). This is the C1 "wait for it to finish" answer.
   - error.code === 'brain_lifecycle_recovery_required': die(UPDATE_FIRST(manifestPath)). This matches cmdConnectAnthropic's mapping.
   - Any other BrainLifecycleLockError or brain_lifecycle_* code: die(error.message).
4. After the lock was taken and released without error, die(HALF_RUN(manifestPath)).

This keeps the custody stop ahead of withManifestCloudflareControl, and the lock itself touches only local files. Add a test to test/anthropic-connect.test.mjs: a child process holds the lock with operation 'answer-setup' and the journal is present. Assert that cmdConnect('anthropic', ...) rejects with the busy text and never reaches manifest control. As the control case, the same journal with no lock holder still rejects with HALF_RUN.

- Verifier's reasoning:

I traced the path in the final head and reproduced it.

1. First run, `brain connect anthropic <manifest> --from-clipboard`. cmdConnect runs withManifestCloudflareControl, then cmdConnectAnthropic, then runAnthropicAnswerSetup. That function takes the lifecycle lock with operation "answer-setup" (operations/answer-setup.mjs:365). Inside the lock it checks journalExists, finds none, and goes on. It writes the journal at answer-setup.mjs:451-452, before writeManifest. The journal stays on disk through reconcileDaily, putSecret, verifyDeploy/deploy (cmdDeploy) and the worker-check loop (up to 60 s, each check with a 75 s timeout). It is removed only on success or transient completion (about lines 502/510) or after a rollback finishes (about line 567). That leaves a window of minutes where a live run has a journal on disk.

2. A second run, started in another window during that window, enters cmdConnect. The new pre-lock check at brain.mjs:19618-19621 calls answerSetupNeedsRecovery(manifestPath). It only lstat's the journal path, sees the file, and calls `die(HALF_RUN(manifestPath))`. No secretNameExisted argument is passed, so answer-setup-copy.mjs returns INTERRUPTED_WITH_STORED_KEY: "The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help." Nothing checks the lifecycle lock first. In the C1 snapshot the only journal check was inside the lock, so this second run hit brain_lifecycle_busy and cmdConnectAnthropic's catch printed the busy message via die(error.message).

3. Nothing else guards this. The CLI map sends `connect` straight to cmdConnect (brain.mjs:33282) with no outer lock. The new test, "the installed Anthropic connect route refuses every journal state before credential control", only covers a journal with no lock holder.

Reproduction: one child process holds acquireBrainLifecycleLock with operation "answer-setup" and the journal is present. cmdConnect('anthropic', ...) then rejects with the INTERRUPTED_WITH_STORED_KEY text, and manifest control is never reached. On the same state, the C1-order core path (cmdConnectAnthropic) gives "the Brain lifecycle lock is held by answer-setup since ... Wait for it to finish, then run the same command again." The journal is still present afterwards.

Severity: the claim's P3 stands. The wrong message is on the safe side. It stops before any Cloudflare control, does not tell the owner to disconnect, and says to ask for help. Nothing is lost or corrupted, and once the first run finishes and removes its journal, the same command works again. The cost is a false "interrupted" alarm during a supervised session and a needless call for help. It needs two windows open at once, so the trigger is unlikely.

Note: I had first written my probe in C:\offload\review-0419-final-scratch\busy-verify\. Another process later overwrote probe.mjs there with an unrelated update/disconnect probe. I did not revert it. My reproduction lives separately in the halfrun-refute folder.

- Reproduction:

C:\offload\review-0419-final-scratch\halfrun-refute\holder.mjs takes acquireBrainLifecycleLock({manifestPath, operation:'answer-setup'}) in a child process and holds it for 20 s. C:\offload\review-0419-final-scratch\halfrun-refute\probe.mjs does the rest:
- sets BRAIN_LIFECYCLE_LOCK_ROOT to a scratch folder
- writes a fixture manifest
- spawns the holder and waits for HELD
- writes answerSetupJournalPath(manifestPath) to stand in for the in-flight run's journal from answer-setup.mjs:452
- calls cmdConnect('anthropic', {argv:[node,'brain.mjs','connect','anthropic',manifestPath,'--from-clipboard'], withManifestControl: stub})

Run with: node C:\offload\review-0419-final-scratch\halfrun-refute\probe.mjs

Output:
HEAD cmdConnect message: "The Claude setup was interrupted part way. Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help." | manifest control reached: false

C1-order core path on the same state (cmdConnectAnthropic, which takes the lock first):
"the Brain lifecycle lock is held by answer-setup since <ts>. A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish, then run the same command again."

journal still present: true


### 14. [P3] The normal busy message points to "a process with that ID" but prints no ID, and hedges on every healthy cross-process holder

- Area: busy-messages. Finder severity P3, verifier severity P3.
- Location: `operations/brain-lifecycle-lock.mjs:436`; verifier: operations/brain-lifecycle-lock.mjs:434-447
- Inputs: Any real contention between two processes. Example: the daily refresh task is running and the operator runs `brain update`, `brain load` or `brain connect anthropic`.
- Wrong outcome: The message reads: "the Brain lifecycle lock is held by daily-refresh since <UTC>. A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish...". The PID is never printed, so the operator cannot look it up in Task Manager. The "could not confirm" hedge appears for every normal holder in another process, because "That process is still running." applies only when the holder is the same process (a nested acquisition). When the recorded PID is the contender's own PID from a prior process, which is provably dead, the message still says "Wait for it to finish", but that holder never finishes; it clears only after the stale window.
- Finder's evidence: probe.mjs case 1, a live separate holder process on this host, printed the hedged text with no PID. The holderStatus branch at lines 434-438 shows "That process is still running" only when owner.pid === process.pid and the instance matches.
- Fix: Include owner.pid and owner.operation in plain words, e.g. "Another Brain task (daily-refresh, process 1234) is using your Brain". Use the recovery-window wording when ownerIsPriorProcessWithContenderPid is true.
- Verifier's fix note:

At lines 434-447, build holderStatus and guidance in this order:
1. If `!live`: keep the current "no longer running ... recovery window" text.
2. Else if `ownerIsPriorProcessWithContenderPid(owner, contenderInstance)`: say "The Brain task that took the lock has ended, but the lock is still inside its recovery window." and use the "Wait for the recovery window to end, ..." guidance instead of "Wait for it to finish".
3. Else if it is the same process instance: keep "That process is still running."
4. Otherwise: name the PID, e.g. `Process ${owner.pid} is running, but this computer could not confirm it is the same one.`

The live && stale branch should not take precedence over case 2, because a prior-self holder that has gone stale is reaped before this point.

The tests at test/fix-0419-partner-r1.test.mjs:568 and :838 will keep passing if the substring "could not confirm it is the same one" stays. Add an assertion that the message contains the holder's PID, and add a test for the prior-process-same-PID case that checks for "recovery window" and that "Wait for it to finish" is absent.

- Verifier's reasoning:

I traced the code and reproduced it in the final head. The defect is real but bounded: the copy is wrong, while the lock itself still fails closed.

How the message is built (operations/brain-lifecycle-lock.mjs:434-453):
- holderStatus says "That process is still running." only when owner.pid === process.pid and owner.process_instance === CURRENT_PROCESS_INSTANCE. That only happens when the same process takes the lock twice (nested).
- Every live holder in another process gets the text "A process with that ID is running, but this computer could not confirm it is the same one."
- The final string interpolates only owner.operation and owner.created_at. owner.pid is never printed, so "that ID" refers to nothing the reader can see.

The text reaches the operator unchanged:
- `brain update` (brain.mjs:31566-31570) passes error.message to dieWithSupportCode, which wraps it in Fatal with no rewriting.
- `brain disconnect anthropic` (brain.mjs:20791) calls die(error.message).
- crash() (brain.mjs:24614) writes msg directly.

Hedging on every cross-process holder follows from 0.4.19 removing the start-time identity check. processStartIdentity is still exported but never called during lock acquisition. So the hedge is honest, but without the PID it cannot be acted on.

The tests do not catch this. test/fix-0419-partner-r1.test.mjs:568 and :838 only match /could not confirm it is the same one/. The "verified holder" test still passes a processInstance option, which the final code ignores, and it never checks for "That process is still running".

The prior-process case is also confirmed. A dead earlier holder can have the same PID as the contender: owner.pid === process.pid with a different process_instance. Then isOwnerAlive returns true, because the contender is checking itself. ownerDead is true, but the lock is not stale yet, so it is not reaped. The guidance branch only looks at `live`, so it prints "Wait for it to finish". That holder will never finish. The lock clears only once the 30-minute stale window passes since the last heartbeat, and a retry inside that window fails the same way.

Why only P3: there is no data loss, no lock bypass, and no wrong custody decision. Contention still fails closed with brain_lifecycle_busy and the right retry command. The impact is an operator message that names an ID it does not show, plus wrong wording in a rare PID-reuse case.

- Reproduction:

Scratch probes are in C:\offload\review-0419-final-scratch\busy-msg-verify\. Each run uses a temporary manifest and its own machineLockRoot, imports C:\offload\review-0419-final\operations\brain-lifecycle-lock.mjs, and needs no network.

1. run.mjs starts holder.mjs as a separate node process. It acquires operation "daily-refresh" and holds the lock for 8 seconds. While it holds, contender.mjs calls acquireBrainLifecycleLock with operation "update" and retryCommand "brain update <manifest>". Output:
"CODE brain_lifecycle_busy / MSG the Brain lifecycle lock is held by daily-refresh since 2026-10-24T16:45:29.926Z. A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish, then run brain update <manifest> again."
No PID appears anywhere in the message.

2. selfpid.mjs acquires "daily-refresh" in-process. It then rewrites the owner receipt's process_instance to a different value, which simulates an earlier process that had this PID. It then tries "update" from the same process. Output is the same hedged text plus "Wait for it to finish", even though that recorded holder is provably gone and will never release.


### 15. [P3] Lock-busy errors that reach crash() are recorded as INTERNAL_ERROR, INGEST_FAILED or SCHEDULE_RUN_FAILED, and the receipt points to that wrong explanation

- Area: busy-messages. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:24614`; verifier: brain.mjs:24611 and brain.mjs:24614-24617 (crash records and prints the receipt), with the classification fallback at brain.mjs:617-625 in supportErrorCode
- Inputs: `brain load`, `brain ingest`, `brain sources`, `brain folder`, `brain disconnect` or `brain schedule` run while another Brain task holds the lifecycle lock.
- Wrong outcome: The new crash() branch prints the busy text correctly, but recordSupportFailure(err, {unexpected: true}) classifies the error by command. brain_lifecycle_busy is not a support code. load, sources, folder and connect get INTERNAL_ERROR ("The installer hit an unexpected problem"); ingest gets INGEST_FAILED ("At least one item in the source could not finish ingestion"); schedule gets SCHEDULE_RUN_FAILED. The "Need help with this?" line sends the owner to that wrong explanation, and the support journal logs ordinary contention as a bug or an ingest failure.
- Finder's evidence: probe-classify.mjs: supportErrorCode(BrainLifecycleLockError('brain_lifecycle_busy', ...)) gives load INTERNAL_ERROR, ingest INGEST_FAILED, connect INTERNAL_ERROR, disconnect INTERNAL_ERROR, folder INTERNAL_ERROR, sources INTERNAL_ERROR, schedule SCHEDULE_RUN_FAILED, daily INTERNAL_ERROR.
- Fix: Add a catalogued busy code (e.g. BRAIN_LIFECYCLE_BUSY, explaining waits for a live holder and for the recovery window) to SUPPORT_ERROR_CODES and the support-recovery CATALOG. In the crash() lifecycle branch, set err.supportCode before recordSupportFailure, or map brain_lifecycle_busy in supportErrorCode.
- Verifier's fix note:

**Fix:** give lock contention its own catalogued support code.

1. Add "BRAIN_LIFECYCLE_BUSY" to SUPPORT_ERROR_CODES in support-journal.mjs:109.
2. Add a matching CATALOG entry in support-recovery.mjs:
   - Title: "Another Brain task is running".
   - What happened: "This computer's Brain lifecycle lock was held by another task."
   - Data safety: "Nothing was changed."
   - Class: safe_now.
   - Next steps: "Wait for the other Brain task to finish (or for the recovery window to end), then run the same command again." and "If the message says the lock has been held for many minutes and no Brain command is running, restart the computer and run it again."
   - Don't reuse UPDATE_BRAIN_BUSY: its catalog text only fits the update readiness check.
3. In supportErrorCode (brain.mjs:593), before the command-based fallbacks at 617-625, add:
   `if (error?.code === "brain_lifecycle_busy") return "BRAIN_LIFECYCLE_BUSY";`
   With that in place, `crash()` at 24611 records and prints the right code without further changes.
4. If the code is not added, the minimal alternative is to stop printing the receipt in the 24614 branch for brain_lifecycle_busy.
5. Add a test that runs `crash()` (or `supportErrorCode(err, {command:'load'|'ingest'|'schedule', unexpected:true})`) with a busy BrainLifecycleLockError and asserts BRAIN_LIFECYCLE_BUSY.

- Verifier's reasoning:

I traced the path in the final head and reproduced it with the real CLI.

1. `cmdLoad` (brain.mjs:16798-16805), `cmdIngest` (12942-12949) and `cmdScheduleAllConfigured` (27549-27556) take the lock through `withBrainLifecycleLock` and don't catch the error. That function covers `brain schedule --all-configured --install/--remove` and `brain daily on/off`, which reach it through `cmdDaily` at 27742. When the lock is held, `acquireBrainLifecycleLock` throws `BrainLifecycleLockError('brain_lifecycle_busy')`. This is a plain Error, not a Fatal.
2. Because it isn't a Fatal, the main catch at 33651-33673 sends it to `crash()`. `crash()` calls `recordSupportFailure(err, {unexpected:true})` at 24611 before the new lifecycle branch at 24614.
3. `supportErrorCode` (593-626) upper-cases the code to BRAIN_LIFECYCLE_BUSY. That code isn't in SUPPORT_ERROR_CODES (support-journal.mjs:109), and no message regex matches the busy text. So the code falls back by command: ingest gives INGEST_FAILED, schedule gives SCHEDULE_INSTALL_FAILED or SCHEDULE_RUN_FAILED (chosen by argv), and load and daily give INTERNAL_ERROR.
4. The new branch then calls `printSupportReceipt`. That function only hides COMMAND_FAILED and CONFIG_INVALID, so it prints "Need help with this? Run: brain support --explain <wrong code>".

The catalog entries those codes point to are wrong for lock contention:
- INTERNAL_ERROR says "The installer hit an unexpected problem".
- INGEST_FAILED says "At least one item in the source could not finish ingestion".
- SCHEDULE_INSTALL_FAILED says to "Resolve the named operating-system permission or path issue".
- The journal also records ordinary contention as INGEST_FAILED or a scheduler failure.

**Corrections to the claim's scope:**
- `brain disconnect anthropic` does not reach `crash()`. The diff added a catch at 20791 that calls `die()`, so it becomes a Fatal with COMMAND_FAILED and no receipt line.
- `brain connect anthropic` also turns the error into a Fatal (19855-19857).
- I found no lifecycle-lock use in `cmdSources` or `cmdFolder`.
- `brain schedule --install` gets SCHEDULE_INSTALL_FAILED, not SCHEDULE_RUN_FAILED. Only `--remove` gets SCHEDULE_RUN_FAILED.
- `brain update` is not affected: the diff maps its busy error to UPDATE_BRAIN_BUSY at 31565-31570.
- At f8a7cd05 the same receipt code was already printed. That older version showed it under the wrong "internet connection dropped" text. The diff fixed the main text and kept the wrong receipt.

**Severity:** P3, as claimed. The main busy sentence is correct, and the update path the owner will run is not affected. The wrong part is the secondary receipt line and the support-journal classification.

**Side observation, outside this claim:** in the normal case, where a different live process holds the lock, the message says "A process with that ID is running, but this computer could not confirm it is the same one". After this diff, the "That process is still running" wording only appears when the holder is the same process.

- Reproduction:

Scratch probe in C:\offload\review-0419-final-scratch\busy-receipt-verify\ (drive.mjs, holder.mjs, netblock.mjs, manifest.json):
- holder.mjs holds `withBrainLifecycleLock({operation:'ingest'})` for 60 seconds in a separate node process.
- drive.mjs runs `node --import netblock.mjs C:\offload\review-0419-final\brain.mjs <cmd>` with BRAIN_LIFECYCLE_LOCK_ROOT, USERPROFILE and HOME pointed at scratch and BRAIN_NO_WRANGLER_LOGIN=1. Network is blocked.

Every command below exits 1 and prints the correct busy line, "fail  the Brain lifecycle lock is held by ingest since ... Wait for it to finish, then run the same command again.", followed by a receipt with the wrong code:
- `brain load <manifest>`: "Need help with this? Run: ... support --explain INTERNAL_ERROR"
- `brain ingest <manifest>`: "... --explain INGEST_FAILED"
- `brain daily on <manifest>`: "... --explain INTERNAL_ERROR"
- `brain schedule <manifest> --all-configured --install`: "... --explain SCHEDULE_INSTALL_FAILED"
- `brain schedule <manifest> --all-configured --remove`: "... --explain SCHEDULE_RUN_FAILED"

The support journal under the scratch home's .brain\support\events recorded error_code INGEST_FAILED, SCHEDULE_INSTALL_FAILED and SCHEDULE_RUN_FAILED for these runs.

`brain disconnect anthropic` never reaches the lock: it stops earlier on Cloudflare access. Code reading shows its busy error is turned into a Fatal anyway.


### 16. [P3] The busy retry commands use a literal <manifest> even when the real path is known or the owner ran plain `brain update`

- Area: busy-messages. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:31556`; verifier: brain.mjs:31556 (update) and brain.mjs:20726 (disconnect anthropic); message built at operations/brain-lifecycle-lock.mjs:97-103, 404, 446-447
- Inputs: The owner runs `brain update` with no argument (the supported discovery path) and meets a busy lock. Or `brain disconnect anthropic <path>` meets a busy lock (retryCommand at brain.mjs:20726).
- Wrong outcome: The guidance reads "then run brain.cmd update <manifest> again", or with no shim on PATH, "& 'C:\Program Files\nodejs\node.exe' '...\brain.mjs' update <manifest>". That tells the owner to add an argument they never used. Typed literally in PowerShell, `<` is a parse error ("The '<' operator is reserved for future use"). For disconnect, the manifest path is in hand but is not used.
- Finder's evidence: probe-update.mjs SCREEN line, rendered with renderCliCommands for win32, ends in "update <manifest> again."
- Fix: Build retryCommand from the actual invocation: manifestPath ? `brain update ${commandPath(manifestPath)}` : "brain update". For disconnect use `brain disconnect anthropic ${commandPath(manifestPath)}`.
- Verifier's fix note:

Build each retry command from the actual invocation, using the existing `commandPath` and `displayPath` helpers (brain.mjs:1816, used the same way at 8545).

At brain.mjs:31556:
`retryCommand: manifestPath ? \`brain update ${commandPath(displayPath(manifestPath))}\` : "brain update",`
This uses the caller's original `manifestPath`, not `lockManifestPath`. An owner who used discovery is then told to run plain `brain update` again.

At brain.mjs:20726:
`retryCommand: \`brain disconnect anthropic ${commandPath(displayPath(manifestPath))}\`,`

`renderCliCommands` at the top level already swaps in the right Windows prefix (brain.cmd or the quoted node invocation). That leaves a command the owner can paste and run.

Add a focused test: under a held lock, call `cmdUpdate(undefined, ...)` with discovery and assert the message matches /then run brain update again/ and does not match /<manifest>/. Also assert that the disconnect busy message contains the real manifest path.

- Verifier's reasoning:

I could not refute this. I traced the path and reproduced it.

1) What changed: at the C1 snapshot f8a7cd05 the busy message was a fixed string: "Wait for it to finish, then run brain ${operation} again." That reads "then run brain update again", which is exactly right after a plain `brain update`. This diff added the `retryCommand` parameter and `busyRetryInstruction()` (operations/brain-lifecycle-lock.mjs:97-103). Both callers now pass a hard-coded placeholder: brain.mjs:31556 passes `retryCommand: "brain update <manifest>"`, and brain.mjs:20726 passes `retryCommand: "brain disconnect anthropic <manifest>"`.

2) Can the path be reached? Yes:
- `cmdUpdate(undefined)` takes the discovery branch (brain.mjs:31539-31549), finds the manifest path, and calls `withBrainLifecycleLockWait` with the placeholder string.
- After the 120 s wait, `acquireBrainLifecycleLock` throws `brain_lifecycle_busy` with the guidance from lines 446/447 or 404.
- `cmdUpdate` rethrows it as a Fatal with code UPDATE_BRAIN_BUSY (31566-31570).
- The top-level handler prints `renderCliCommands(e.message)` (brain.mjs:33669).
- `cmdDisconnectAnthropic` uses the lock with no wait at all (20719-20727), and its `manifestPath` is required and already known (20717).

3) Nothing guards it: no caller swaps the placeholder for the real path. The project already has the helper and the habit. Line 8545 builds `commandPath(displayPath(manifestPath))` and puts it in place of `<manifest>`. operations/answer-setup-copy.mjs says "Callers substitute only the manifest locator", and its disconnect and connect remedies use the real manifest path. test/answer-setup-copy.test.mjs:84 asserts that the unused `<manifest>` locator is not shown in answer-setup copy.

4) Impact is limited:
- Nothing is changed and no data is at risk. The update is supervised and run by a technician.
- Many other update messages already use the `<manifest>` placeholder.
- The support receipt for UPDATE_BRAIN_BUSY (support-recovery.mjs:95) still says "run brain update again".

The defect is guidance accuracy: the "runnable" rendered command is not runnable as printed. It tells someone who used the no-argument discovery path to add an argument they may not know. If the shim-less PowerShell form is pasted as printed, it fails to parse at `<`. P3 is the right rating.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\busy-verify\probe.mjs, run with node from C:\offload\review-0419-final. It does the following:
- Holds a real `daily-refresh` lifecycle lock on a temporary manifest under %TEMP%, using an injected machineLockRoot.
- Calls `cmdUpdate(undefined, { discoverInstalledManifest: () => ({ path }), lifecycleLockWaitMs: 0, lifecycleLockOptions: { machineLockRoot } })`.
- Calls `cmdDisconnectAnthropic(path, {}, { acquireLock: (i, a) => withBrainLifecycleLock({ ...i, machineLockRoot }, a) })`.

Output:
- `UPDATE ctor: Fatal support: UPDATE_BRAIN_BUSY`
- `UPDATE RAW: ...That process is still running. Wait for it to finish, then run brain update <manifest> again.`
- Rendered for win32 with no shim on PATH: `...then run & 'C:\Program Files\nodejs\node.exe' 'C:\offload\review-0419-final\brain.mjs' update <manifest> again.`
- `DISCONNECT RAW: ...then run brain disconnect anthropic <manifest> again.` This happens even though the real manifest path was passed in.

For comparison, the C1 snapshot (`git show f8a7cd05:operations/brain-lifecycle-lock.mjs`) printed "then run brain ${operation} again", which reads "brain update" with no placeholder.


### 17. [P3] The 0.4.19 CHANGELOG, shown by `brain whatsnew`, still claims process-start identity and recovery of reused-process locks, which this diff removed

- Area: busy-messages. Finder severity P3, verifier severity P3.
- Location: `CHANGELOG.md:36`; verifier: CHANGELOG.md:35-36 and CHANGELOG.md:54-55 (0.4.19 section, both printed by `brain whatsnew`); behavior source operations/brain-lifecycle-lock.mjs:25, 93-95, 372, 418-433, 442-447
- Inputs: The owner or operator runs `brain whatsnew` after the update.
- Wrong outcome: The entry says "confirmed dead or reused-process locks can recover safely" (line 36) and "Lifecycle locks include process-start identity" (line 54). After this diff, processStartIdentity is no longer called anywhere (it is dead code), and owners record a random per-process token. A live reused PID now keeps the lock busy until that unrelated process exits; the guidance is to restart. A dead holder is held for the full 30-minute stale age. Owner-facing release notes describe behavior that is no longer shipped.
- Finder's evidence: A grep for processStartIdentity/processInstance outside tests finds only the export at brain-lifecycle-lock.mjs:52. CURRENT_PROCESS_INSTANCE (line 25) is randomBytes. lifecycleOwnerIsDead (lines 93-95) treats any live PID other than the contender's own as alive.
- Fix: Rewrite the two CHANGELOG lines. A live process ID always keeps the lock. A stopped holder is released after about 30 minutes. A holder that stays busy for a long time gets restart guidance.
- Verifier's fix note:

Rewrite the two 0.4.19 CHANGELOG bullets to match the shipped rule.

Lines 34-36 (owner-facing), replace "Lock messages identify the operation holding the lock, while confirmed dead or reused-process locks can recover safely." with:
"Lock messages name the task holding the lock, when it started, and what to run next. A lock left by a stopped task is released about 30 minutes after that task last ran. While the recorded process ID is still running, the lock stays busy. After a long hold, the message says to restart the computer if no Brain command is running."

Lines 54-55 (Technical changes), replace "Lifecycle locks include process-start identity and report the holding operation, start time and safe retry action." with:
"Lifecycle lock receipts record a random per-process instance token and report the holding operation, start time and retry action. A live PID always holds the lock, except a prior owner with the contender's own PID. A dead holder is reaped only after the 30-minute stale age and a second dead check. PID reuse by an unrelated live process is not detected; it gets restart guidance."

Optional, not owner-facing: align docs/release-evidence/v0.4.19-candidate-release-evidence-plan.md:136-137 ("confirmed dead or reused process identity"). Also remove the now-unused processStartIdentity export, or note that it is test-only.

- Verifier's reasoning:

The claim holds. I traced it in the final head and reproduced it with a probe.

1. CHANGELOG.md is not in the f8a7cd05..5d8f804d diff, so the 0.4.19 entry still says what it said at C1. The only commit, 5d8f804d, says it changed the rule: "a live PID is always busy; a dead PID is reaped only after the stale age". It did not update the entry.

2. `brain whatsnew` prints those lines. cmdWhatsnew (brain.mjs ~24967-24984) slices from `## 0.4.19` to the next "\n## ". "\n### Technical changes" does not match that pattern, so the Technical changes bullets are printed too. PRODUCT_VERSION is 0.4.19 (package.json). My probe called cmdWhatsnew with no manifest, so there was no network call. Both strings were in the output: "reused-process locks can recover safely" (CHANGELOG.md:36) and "Lifecycle locks include process-start identity" (CHANGELOG.md:54).

3. The lock code no longer behaves the way those lines say:
- operations/brain-lifecycle-lock.mjs:25: CURRENT_PROCESS_INSTANCE is `process-lifetime:<random>`. Line 372 writes it into every owner receipt. The probe confirmed the receipt holds `process-lifetime:<32hex>`, not a start time.
- processStartIdentity (line 52) is now called only from test/brain-lifecycle-lock.test.mjs. The `processInstance` option was removed from acquireBrainLifecycleLock, and no production code passes it.
- lifecycleOwnerIsDead (lines 93-95) counts any live PID as alive. The one exception is a prior owner with the contender's own PID.
- Reaping needs `stale && ownerDead` (line 418). No production caller passes staleMs, so DEFAULT_STALE_MS of 30 minutes applies (line 29).
- The diff deleted the test "a stale owner whose pid was reused cannot block the Brain forever". test/fix-0419-partner-r1.test.mjs:166 now asserts that a stale live holder stays busy and gets restart guidance.

Probe results, using a temporary manifest and lock root in %TEMP% and simulated win32:
- Owner PID reused by a live unrelated process, owner file 2 hours old: brain_lifecycle_busy with "restart the computer and run the command again". It was not recovered.
- Dead holder, fresh owner file: brain_lifecycle_busy, "still inside its recovery window".
- Dead holder, 31 minutes stale: acquired.

Why only P3: line 36 is partly still true. Dead locks do recover, after the stale window. A lock left by a prior process that had the contender's own PID also recovers, so a strict reading of "confirmed ... reused-process" can be defended. Line 54's "process-start identity" is plainly out of date: no start time is recorded and reuse of another process's PID is no longer detected. The live busy message itself gives correct guidance, so nothing unsafe follows. The defect is that owner-visible release notes in the sealed package claim a recovery mechanism that is not shipped. That is bounded documentation drift, so P3.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\verify-changelog-lock\probe.mjs, run with `node probe.mjs`. It imports C:\offload\review-0419-final\brain.mjs and operations\brain-lifecycle-lock.mjs read-only.

(a) It calls cmdWhatsnew(undefined, { discoverManifest: () => { throw } }), captures console.log, and checks for both strings. Both are present.

(b) It acquires a lifecycle lock on a temporary manifest in %TEMP% (platform win32, ACL step stubbed). The recorded process_instance is `process-lifetime:<32hex>`.

(c) It rewrites the owner receipt to PID process.pid+100000 with an mtime 2 hours old, then runs acquire with isOwnerAlive=>true. Result: brain_lifecycle_busy, "...If no Brain command is running, restart the computer and run the command again." The lock is not recovered, which contradicts "reused-process locks can recover safely".

(d) With isOwnerAlive=>false and a fresh mtime: busy, "recovery window". With a 31-minute-old mtime: acquired.

Grep: `processStartIdentity` appears only at operations/brain-lifecycle-lock.mjs:52 (the export) and in test/brain-lifecycle-lock.test.mjs.


### 18. [P3] The new half-run check in brain connect no longer clears the Anthropic key from the clipboard

- Area: answer-setup-journal. Finder severity P2, verifier severity P3.
- Location: `brain.mjs:19619`; verifier: brain.mjs:19620 (die(HALF_RUN(manifestPath)) inside the `which === "anthropic"` branch of cmdConnect, brain.mjs:19615-19621)
- Same root cause as: #10, #13, #19, #23 (the half-run check in brain connect anthropic runs before the lock).
- Inputs: A .answer-setup-journal.json file sits beside the manifest, left by any interrupted connect (for example, the terminal was closed during deploy). Following the Console flow, the owner clicks Copy on a key and reruns `brain connect anthropic <manifest> --from-clipboard`. On Windows the same happens with no mode flag, because clipboard is the default there.
- Wrong outcome: cmdConnect refuses with HALF_RUN before cmdConnectAnthropic or runAnthropicAnswerSetup runs, so the `finally` that calls clearClipboardNow never runs. The live Anthropic key stays on the clipboard. The refusal text says only "ask the person who set up your Brain for help" and never says to clear the clipboard. At f8a7cd05 this same refusal happened inside runAnthropicAnswerSetup and cleared the clipboard. The old test asserted `halfCalls == ["clear"]`; this diff deleted that assertion and rewrote the case to use --key-set-in-dashboard.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus3\probe-halfrun-clipboard.mjs runs the installed route `cmdConnect("anthropic", argv ... --from-clipboard)` with a journal present and an injected anthropicOptions.clearClipboard. It throws Fatal HALF_RUN with calls=[]: no clear and no read. As a control, runAnthropicAnswerSetup called directly with the same journal records calls=["clear"].
- Fix: When cmdConnect refuses on HALF_RUN, first work out the key-entry mode the same way chooseMode does: --from-clipboard, or no flag on a non-darwin platform. In clipboard mode, make a best-effort call to clearCustomApiClipboard({ platform }) and log CLIPBOARD_CLEAR_WARNING if it fails, then die. Add an installed-route regression test that asserts the clear happens.
- Verifier's fix note: Before die(HALF_RUN(manifestPath)) in cmdConnect, resolve the key-entry mode the same way chooseMode does. Use parseAnthropicConnectFlags(flags).modeFlag: "from-clipboard" means clipboard; "key-set-in-dashboard" or "keep-key" means no clear; no flag means clipboard unless platform === "darwin" and stdin is a TTY. Take platform from options.anthropicOptions?.platform ?? process.platform. In clipboard mode, call (options.anthropicOptions?.clearClipboard ?? (() => clearCustomApiClipboard({ platform })))() inside try/catch. If it throws, add a refusal-specific line such as "This command could not clear the clipboard. Clear it now; a clipboard history app may still keep a copy." to the die message. Do not reuse CLIPBOARD_CLEAR_WARNING, which says "Claude answers are connected". Then die with HALF_RUN. In the existing installed-route test in test/anthropic-connect.test.mjs, add a --from-clipboard case and a no-flag win32 case that assert the injected clear ran exactly once and that withManifestControl and connectAnthropic were never reached. Restore the clipboard-mode assertion in the core HALF_RUN test.
- Verifier's reasoning:

I traced the path and reproduced it. The claim is correct, but the severity is overstated.

Final head, brain.mjs:19617-19621: the `which === "anthropic"` branch of cmdConnect calls answerSetupNeedsRecovery(manifestPath). That check returns true when any journal is present (lstat, operations/answer-setup.mjs:225). The branch then calls die(HALF_RUN(manifestPath)) before withManifestCloudflareControl, cmdConnectAnthropic or runAnthropicAnswerSetup runs. The only clipboard cleanup is clearClipboardNow, which runs in the try/finally inside runAnthropicAnswerSetup (operations/answer-setup.mjs:349-360 and 583-585). That code is never reached, so nothing clears the clipboard.

At f8a7cd05 the anthropic branch went straight to runManifestControl, then cmdConnectAnthropic, then runAnthropicAnswerSetup. That function threw HALF_RUN inside its try, and its finally cleared the clipboard in clipboard mode. chooseMode returns "clipboard" for --from-clipboard, and also for no flag unless the platform is darwin with a TTY, so this was the Windows default. The old test pinned the behaviour with `halfCalls == ["clear"]`. This diff removed that assertion and switched the case to --key-set-in-dashboard.

My probe is at C:\offload\review-0419-final-scratch\verify-halfrun-clipboard\probe.mjs. It runs the installed route cmdConnect("anthropic") with a journal present and platform win32. With --from-clipboard and with no flag, it gets Fatal plus the stored-key HALF_RUN text, with calls=[]: no clear and no read. Control: the same route with the journal decision moved into the core (journal absent on disk, journalExists injected true) gives calls=["control","clear"].

The refusal copy is: "The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help." It says nothing about the clipboard.

Why I rate it P3, not P2:
(1) The command never reads the clipboard on this path. The key stays on the owner's own clipboard, where the owner put it. Nothing is sent anywhere.
(2) Clear-on-refusal was never a complete invariant. Before and after this diff, other refusals that happen before the read also leave the clipboard alone: manifest load failure, Cloudflare custody failure, lifecycle lock busy, and recovery-fence brain_lifecycle_recovery_required thrown by lock acquisition outside the try/finally.
(3) In the claimed "terminal closed during deploy" scenario, the first run was killed before its finally ran, so the key was already left on the clipboard. Also, at f8a7cd05 a rerun within the 30-minute stale window would have hit the leftover lifecycle lock (brain_lifecycle_busy) before the journal check, again with no clear. So the old code cleared only on a rerun after the lock had gone stale.
(4) The refusal stops all work, and the update is a supervised session.

It is still a real, reproducible regression of a cleanup the old version tested. The product copy promises the command "clears your clipboard", and the refusal gives no clipboard guidance. So it is a minor custody-hygiene defect, not a non-issue.

Correction to the proposed fix: do not log CLIPBOARD_CLEAR_WARNING. Its text begins "Claude answers are connected", which would be false on a HALF_RUN refusal.

- Reproduction: node C:\offload\review-0419-final-scratch\verify-halfrun-clipboard\probe.mjs, which imports cmdConnect from C:\offload\review-0419-final\brain.mjs. Setup: a temp manifest in %TEMP% with .answer-setup-journal.json beside it; argv [node, brain.mjs, connect, anthropic, <manifest>, --from-clipboard], then the same with no flag; anthropicOptions { platform: "win32", clearClipboard, readClipboard, acquireLock } injected. Output: both runs give Fatal "The Claude setup was interrupted part way..." with calls=[] (clearClipboard never called). Control: the same route with the journal file removed and anthropicOptions.journalExists: () => true, so the HALF_RUN decision happens inside runAnthropicAnswerSetup as it did at f8a7cd05. That gives the same Fatal text with calls=["control","clear"].

### 19. [P3] The half-run check runs before the lock, so --json output breaks and a live setup in another window is reported as interrupted

- Area: answer-setup-journal. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19620`; verifier: brain.mjs:19620
- Same root cause as: #10, #13, #23, #18 (the half-run check in brain connect anthropic runs before the lock).
- Inputs: (a) `brain connect anthropic <manifest> --json` with a journal present. (b) A first connect holds the lifecycle lock and has written its journal (deploy and Worker-check phase, up to 8 minutes) when a second `brain connect anthropic` starts.
- Wrong outcome: (a) The command now throws a plain-text Fatal instead of the JsonFatal receipt {operation: answer_setup.connect, error_code: "half_run", rolled_back: false}, which breaks the advertised --json contract. (b) The second run says "The Claude setup was interrupted part way... Ask the person who set up your Brain for help" while the first run is healthy. Before the diff, the lock check came first and the second run got the accurate busy message.
- Finder's evidence: In the probe, `--from-clipboard --json` produced errorClass Fatal and isJsonEnvelope=false. cmdConnectAnthropic (19833-19842) still builds the JSON envelope for every other refusal, but this pre-check refuses before reaching it.
- Fix: When flags.json is set, refuse with the same JsonFatal envelope (error_code "half_run"). Before showing HALF_RUN, check whether the lifecycle lock has a live holder and show the busy message instead. Alternatively, take the lifecycle lock in cmdConnect before Cloudflare control and run the presence check under it.
- Verifier's fix note:

At brain.mjs:19619-19621, when the journal is present:

1. If flags.json === true, throw new JsonFatal({schema_version:1, operation:"answer_setup.connect", status:"error", error_code:"half_run", rolled_back:false, rollback_target:null}) instead of die(...).

2. Before showing HALF_RUN, try a non-waiting lifecycle lock: withBrainLifecycleLock({manifestPath, operation:"answer-setup-precheck", retryCommand:"brain connect anthropic <manifest>"}, () => answerSetupNeedsRecovery(manifestPath)).
   - If it throws brain_lifecycle_busy and the holder is live, refuse with the busy message (or a JsonFatal with error_code "brain_lifecycle_busy" under --json).
   - Only if the lock is acquired and the journal is still present, refuse with HALF_RUN.
   - Keep the refusal ahead of withManifestCloudflareControl so a half-run journal still blocks credential control.
   - Note that a dead holder inside its 30-minute recovery window also gives busy. That is acceptable, or you can treat a dead holder as HALF_RUN.

Add a route test that holds the lifecycle lock with a journal present and asserts the busy message. Add a --json route test that asserts the JsonFatal half_run receipt.

- Verifier's reasoning:

I traced the code and reproduced both halves. I could not refute either one.

The new pre-check sits at brain.mjs:19618-19621. When the journal is present it calls die(HALF_RUN(manifestPath)), which throws a plain Fatal. This happens before withManifestCloudflareControl and before cmdConnectAnthropic. It does not look at flags.json and it does not take the lifecycle lock.

(a) Before the diff, a journal was caught only inside runAnthropicAnswerSetup (operations/answer-setup.mjs:372-375, error.code = "HALF_RUN"). The catch in cmdConnectAnthropic (brain.mjs:19832-19842) turned that into a JsonFatal with error_code "half_run", rolled_back false and rollback_target null. Now a plain Fatal reaches the CLI handler (brain.mjs ~33656). That handler prints "fail  <text>" plus a support receipt instead of the JSON receipt. Limits on impact: the --json contract on this route was already incomplete, because manifestCloudflareControlBinding (brain.mjs:27929) and Cloudflare credential failures also refuse in plain text before the envelope. In this repo nothing parses error_code half_run: the technician step builds `connect anthropic` without --json, and a grep for half_run finds no consumer. The exit code is still 1.

(b) runAnthropicAnswerSetup writes the journal after prepareDaily (answer-setup.mjs:451-452). The journal stays through the secret write, verifyDeploy, deploy and a worker-check loop of up to 60 seconds, all under the lifecycle lock and an eight-minute bound. A second `brain connect anthropic` started in that window passes the lock-free presence check and gets HALF_RUN. That call omits secretNameExisted, so it renders INTERRUPTED_WITH_STORED_KEY: "The Claude setup was interrupted part way... Ask the person who set up your Brain for help." Meanwhile the first run is healthy and will remove the journal. Before the diff the lock came before the journal check, so the second run got the accurate brain_lifecycle_busy message.

Why only P3: the wrong message is still safe. It tells the owner not to disconnect and to ask for help, and the second run changes nothing. The first run completes normally. Reaching this needs two connects at once, or a --json caller outside this repo. doctor.mjs:893 already reported a present journal as half-run without the lock, so treating presence as interrupted was not new. No data, key or Brain state is at risk.

- Reproduction:

Probe at C:\offload\review-0419-final-scratch\halfrun-lock-verify\probe.mjs. It sets BRAIN_LIFECYCLE_LOCK_ROOT to the scratch folder, uses a fixture manifest, stubs withManifestControl, and makes no network calls.

(a) Journal file present, no lock holder. cmdConnect("anthropic", argv [..., manifest, "--from-clipboard", "--json"]) gave cls Fatal, isJsonEnvelope false, message INTERRUPTED_WITH_STORED_KEY. Cloudflare control was never reached.

(b) Inside withBrainLifecycleLock({operation:"answer-setup"}) with the journal written:
- Second cmdConnect("anthropic", ..."--from-clipboard"): Fatal, "The Claude setup was interrupted part way. Do not remove the Claude connection... Ask the person who set up your Brain for help."
- Same state through cmdConnectAnthropic directly (the old lock-first order): Fatal, "the Brain lifecycle lock is held by answer-setup since <ts>. That process is still running. Wait for it to finish, then run the same command again."
- The same old-order call with --json: JsonFatal with error_code "brain_lifecycle_busy".


### 20. [P3] A reconnect rollback says the Brain was put back exactly as it was, but the Worker now holds the new key

- Area: answer-setup-journal. Finder severity P3, verifier severity P3.
- Location: `operations/answer-setup.mjs:570`; verifier: operations/answer-setup.mjs:570 (decision at 542-552; copy at operations/answer-setup-copy.mjs:22)
- Inputs: A working Claude setup with key K1. The owner reconnects with `--from-clipboard` and key K2, which passes preflight. putSecret (line 469) overwrites K1. Then the Worker check returns a non-transient status such as "error", or reconcile or deploy fails.
- Wrong outcome: keepPrevious is true, so the manifest is restored and K2 stays stored. K1 cannot be put back because Worker secrets are write-only. The owner sees ROLLED_BACK_PREVIOUS ("your Brain was put back exactly as it was") followed by CHECK_FAILED ("Nothing was changed"). If the failure was specific to K2, answers now fail while the owner is told the earlier working setup is intact.
- Finder's evidence: Lines 542-547 and 551-552: no delete when secret_name_existed is true and the Worker did not reject the key. The test "a preflight-proven replacement can restore the prior Claude pair when an old secret existed" confirms that the secret stays as the replacement.
- Fix: For clipboard and prompt modes where secret_name_existed is true, use copy that says the settings were restored but the Brain keeps the key just copied, and the earlier key cannot be put back. Better: stage the new key under a temporary secret name, run the Worker check against it, and promote it only on success.
- Verifier's fix note: In the catch block, compute `const keyReplaced = keyWritten && journal.secret_name_existed && !shouldDelete;`. When rollbackTarget === "previous" and keyReplaced is true, log a new constant instead of ROLLED_BACK_PREVIOUS. Suggested text: "The change could not be finished. Your Brain's answer settings were put back, but it now uses the key you just copied. The earlier key cannot be put back. Fix the item below, then rerun the same command." In the same branch, either drop "Nothing was changed." from the failure line that follows, or pass a flag to failureLine so it leaves that sentence out. Also set error.keyReplaced = true so the --json receipt and the support tooling can tell this case apart. Add a test assertion that puts a distinct K1 and K2 into the harness and checks that the log does not say "exactly as it was" when the stored value changed. A fuller fix is to stage the new key under a temporary secret name, check the Worker against it, and promote it only on success. That needs Worker changes, so it is optional for this release.
- Verifier's reasoning:

I traced the path in the final head and reproduced it with a probe. It is reachable and nothing guards against it.

1. The starting state is a working Claude pair (opus-sonnet) with ANTHROPIC_API_KEY = K1 stored. The owner runs `brain connect anthropic <manifest> --from-clipboard` with K2. K2 passes preflight, so keyPreflightOk is true. At line 413, secretExisted is true. Line 451 writes the journal with secret_name_existed: true. Line 469 calls putSecret, which overwrites K1 with K2, and keyWritten becomes true.
2. Anything that throws after that goes to the catch block. That includes a failed readback at line 478, verifyDeploy or deploy at 481-482, or a non-transient Worker result with matching echoes such as "error", "billing" or "model_unavailable". A transient result is not one of these: lines 521-527 complete it without a rollback.
3. In the catch, writtenKeyRejected is true only when the Worker's class is key_rejected. In every other case keepPrevious is true (line 542-543) and rollbackTarget is "previous" (line 547). shouldDelete is false (lines 551-552), so K2 stays stored. Worker secrets are write-only, so the code has no way to put K1 back.
4. Line 570 logs ROLLED_BACK_PREVIOUS: "your Brain was put back exactly as it was". Line 571 then logs failureLine(...). Each of CHECK_FAILED, BILLING and MODEL_UNAVAILABLE ends with "Nothing was changed."

Probe: C:\offload\review-0419-final-scratch\verify-rollback-copy\probe.mjs. It imports the real runAnthropicAnswerSetup and stubs the deps so that putSecret stores the actual value. The Worker statuses error, billing and model_unavailable, and a first-deploy failure, all gave the same result: rolledBack true, target "previous", manifest back on opus/sonnet, stored key K2 (new), and the log lines "...put back exactly as it was..." followed by "...Nothing was changed." The existing test at test/anthropic-connect.test.mjs:589 also asserts that the secret survives with no delete. It only checks that the secret is present, so the value change is never caught.

What I could not refute: the reviewer reads the code correctly, and no other guard rewrites the message. What limits severity: the kept K2 passed preflight against both reviewed models a few minutes earlier. In most failures, such as a deploy failure or a Worker-side "error", the Brain still answers with a working key. The real harm needs one of two things. Either the failure is specific to K2 after preflight passed (for example, a Worker "billing" result because K2's account ran out of credit while K1's account still had credit), or the owner acts on the false statement (for example, revokes K2 or relies on K1 because they were told nothing changed). That is a wrong statement shown as true, but it is bounded and unlikely, so it stays P3.

Scope note: lines 542-552 and 570, ROLLED_BACK_PREVIOUS, and the cited test are all unchanged since f8a7cd05. This is a pre-existing defect, not one this diff introduced. The diff did change the neighbouring ROLLBACK_INCOMPLETE and HALF_RUN copy to account for a stored key, but it left this message as it was.

- Reproduction: C:\offload\review-0419-final-scratch\verify-rollback-copy\probe.mjs (run with `node` from C:\offload\review-0419-final). The starting manifest has retrieval = {answer_model: claude-opus-5-5, gate_model: claude-sonnet-5-5} and stored secret = K1. readClipboard returns K2, preflight returns ok, and putSecret records the value. checkWorker returns matching models with status "error" (also tested with "billing", "model_unavailable", and status ok plus a first-deploy failure). Output in every case: rolledBack=true, rollbackTarget=previous, final manifest opus/sonnet, stored key is K2 (new). The logs include "The change could not be finished, so your Brain was put back exactly as it was..." followed by "...Nothing was changed." (CHECK_FAILED, BILLING or MODEL_UNAVAILABLE).

### 21. [P3] The release's new partner test fails on a Windows host, including the journal-guard mutant

- Area: answer-setup-journal. Finder severity P3, verifier severity P3.
- Location: `test/fix-0419-partner-r1.test.mjs:668`; verifier: test/fix-0419-partner-r1.test.mjs:668 (anchor assert in importMutant, line 667 reads source); POSIX-simulation loops at test/fix-0419-partner-r1.test.mjs:91,133,167,207,250,309,411 reaching operations/brain-lifecycle-lock.mjs:117
- Same root cause as: #2, #3, #7 (the new partner test file test/fix-0419-partner-r1.test.mjs fails 9 of 20 tests on a Windows host).
- Inputs: Run `node --test test/fix-0419-partner-r1.test.mjs` on Windows. The chain adds it at scripts/run-test-chain.mjs:304 and :768. The checkout uses Git for Windows' default autocrlf=true, and operations/*.mjs have no eol=lf attribute.
- Wrong outcome: 9 of 20 tests fail. Seven lock tests loop over "darwin" and "linux" and hit assertPrivateDirectory's real POSIX mode check ("the local Brain lifecycle lock is not private"). The "drop-update-journal-guard" and "fresh-empty-as-damaged" mutants fail at "mutant anchor exists" because their anchors contain "\n" and the working-tree source is CRLF. As a result, the journal-guard mutant is never checked on Windows, and the Windows gate cannot pass.
- Finder's evidence: A focused run from scratch reported tests 20, pass 11, fail 9. `git ls-files --eol` shows i/lf w/crlf for operations/answer-setup.mjs and operations/brain-lifecycle-lock.mjs.
- Fix: In importMutant, normalize the source with `source.replace(/\r\n/g, "\n")` before matching anchors. Either skip the simulated-POSIX iterations when process.platform is win32, or inject a mode-check seam. Alternatively, pin `*.mjs text eol=lf` in .gitattributes.
- Verifier's fix note:

(a) In importMutant, normalize the source before matching anchors: `let source = readFileSync(sourcePath, "utf8").replace(/\r\n/gu, "\n");`. Writing the mutant with LF is fine. Also add `operations/*.mjs text eol=lf` and `test/fix-0419-partner-r1.test.mjs text eol=lf` to .gitattributes so every checkout has the same bytes.

(b) The darwin/linux loops cannot pass on a Windows host because the private-directory check is a real filesystem check. Replace them with something like `const SIMULATED = process.platform === "win32" ? ["win32"] : ["win32", "darwin", "linux"];`, with a matching `["win32"]` / `["win32","darwin"]` subset for the test at line 411. Alternatively, add an injectable private-directory check to acquireBrainLifecycleLock, the way `restrictWindowsDirectory` is already injectable, and pass a stub in the simulated-POSIX iterations.

Then confirm the journal-guard mutant at line 879 is killed on a windows-latest CI lane.

- Verifier's reasoning:

I reproduced the claim in the final head. Commit 5d8f804d added test/fix-0419-partner-r1.test.mjs; it did not exist at f8a7cd05. scripts/run-test-chain.mjs lists it at :304 (POST_LAUNCHER_TEST_COMMANDS) and :768 (TEST_COMMANDS). That chain runs unchanged on Windows: package.json "test" calls it, and the windows-latest lanes in .github/workflows/ci.yml:615 and windows-rehearsal.yml:489 run it with `npm test`.

There are two separate causes.

(1) Seven tests at lines 90, 132, 166, 206, 249, 303 and 410 loop over "darwin"/"linux". Each passes `platform` into acquireBrainLifecycleLock, which reaches the real assertPrivateDirectory at operations/brain-lifecycle-lock.mjs:106-121. On a Windows host, lstat of a directory reports mode 0o40666. chmodSync(0o700) cannot clear the group/other bits, so it throws brain_lifecycle_unsafe "the local Brain lifecycle lock is not private" (line 117). This depends on the host OS, not on line endings. The older test/brain-lifecycle-lock.test.mjs only simulates POSIX through processStartIdentity with an injected `run`, so it never hit this.

(2) importMutant (line 664-668) reads the working-tree source as-is and asserts `source.includes(before)`. The "fresh-empty-as-damaged" anchor (line 808, `"brain_lifecycle_busy",\n          ...`) and the "drop-update-journal-guard" anchor (line 881, `inspect(answerSetupJournalPath(manifestPath));\n    return true;`) contain a bare "\n". .gitattributes pins brain.mjs and others to LF, but not operations/*.mjs. Git for Windows' system config here (and on GitHub windows runners) has core.autocrlf=true, and `git ls-files --eol` shows i/lf w/crlf for operations/answer-setup.mjs and operations/brain-lifecycle-lock.mjs. So both anchors fail before the mutant is imported. The other mutants pass because their "before" anchors are single-line.

Effect: the Windows test lane is red, and the journal-guard and fresh-empty mutation checks are never exercised on Windows. Product code and owner data are not affected. The POSIX lanes still run these checks, and the failure is a false red, not a false green. P3 fits.

- Reproduction:

I created a scratch folder at C:\offload\review-0419-final-scratch\verify-partner-r1-windows and pointed TEMP/TMP at it. With cwd C:\offload\review-0419-final, Node v24.18.0 on Windows 11, I ran `node --test test/fix-0419-partner-r1.test.mjs`. Exit code was 1, with "tests 20, pass 11, fail 9".

- Seven failures (tests at lines 90, 132, 166, 206, 249, 303, 410) throw BrainLifecycleLockError code brain_lifecycle_unsafe, "the local Brain lifecycle lock is not private", at operations/brain-lifecycle-lock.mjs:117 via assertPrivateDirectory, called from acquireBrainLifecycleLock:365.
- Two failures, "the fresh-empty-as-damaged mutant is killed" (line 806) and "the drop-update-journal-guard mutant is killed" (line 879), fail with AssertionError "mutant anchor exists in operations/brain-lifecycle-lock.mjs" and "... operations/answer-setup.mjs" at test/fix-0419-partner-r1.test.mjs:668.

`git config --system --get core.autocrlf` returns true. `git ls-files --eol` shows i/lf w/crlf attr/(none) for both operations files. The checkout was still clean after the run (`git status --porcelain` empty).


### 22. [P3] Health's 'Next:' reconnect command prints the manifest path unquoted, and the new win32 test asserts that broken form using a folder name with a space

- Area: windows-health-test. Finder severity P2, verifier severity P3.
- Location: `test/health-verify-exit.test.mjs:800`; verifier: brain.mjs:4300 (also brain.mjs:3695); operations/answer-setup-copy.mjs:45; test/health-verify-exit.test.mjs:800
- Inputs: A Windows owner on the standard layout %USERPROFILE%\Financial Brain\brain.manifest.json (installed-manifest.mjs:391), with Claude answers configured and the Worker reporting anthropic_key_missing: true. Health runs from `brain health` or inside `brain update` (the warning prints before the reachOnly return at brain.mjs:4302).
- Wrong outcome: Health prints `Next: brain.cmd connect anthropic %USERPROFILE%\Financial Brain\brain.manifest.json --from-clipboard` (or the `& 'node.exe' 'brain.mjs'` form). Pasted into PowerShell, this splits the path. I verified the argv: ["connect","anthropic","%USERPROFILE%\...\Financial","Brain\brain.manifest.json","--from-clipboard"]. The CLI then treats `...\Financial` as the manifest and fails. Its half-run journal check (cmdConnect) also looks in the wrong folder. The recovery step health shows for every standard Windows install cannot run as printed. The new 'health win32 seam' check builds its manifest under 'Owner Folder', which has a space, and expects `renderCliCommands(HEALTH_NEXT_STEP(path))` with the path unquoted. So the check passes while the command is broken, and it would fail once the product is fixed.
- Finder's evidence: brain.mjs:4300 `info(HEALTH_NEXT_STEP(manifestPath))` (the same at 3695). operations/answer-setup-copy.mjs:45 inserts `${manifest}` raw. renderCliCommands only rewrites the leading `brain`. Elsewhere the product quotes paths in copyable commands with commandPath() (brain.mjs:1816, used at 12601, 15755, 22160 and others), but not here. Test lines 659-664 add the space on purpose. Lines 800-810 compare against the unquoted raw step, and the rendererControl check only proves the prefix was rewritten. The product line is older than this diff, but this diff's test is the one that claims Windows coverage of a path with a space.
- Fix: In brain.mjs:4300 and 3695, print `HEALTH_NEXT_STEP(commandPath(manifestPath))` (the same applies to the other answer-setup copy that embeds `${manifest}`: HALF_RUN, ROLLBACK_INCOMPLETE, CHECK_PENDING, KEEP_KEY_MISSING). In the win32 seam, expect `renderCliCommands(HEALTH_NEXT_STEP(quotePowerShellArgument(seam.manifestPath)), { platform })`. Also assert that the manifest token appears single-quoted, for example that the logged line contains `'...\Owner Folder\fixture.manifest.json'`, so an unquoted path with a space fails the test.
- Verifier's fix note:

1) brain.mjs:4300 and 3695: print `info(HEALTH_NEXT_STEP(commandPath(displayPath(shownManifest))))`, matching how setup, forget and eval already quote paths. Apply the same commandPath wrap wherever answer-setup copy that embeds ${manifest} is printed: HALF_RUN/ROLLBACK_INCOMPLETE when secretNameExisted === false, CHECK_PENDING, KEEP_KEY_MISSING, LIMIT_ALREADY_REACHED, UPDATE_FIRST, DAILY_RECONCILE_FAILED, ENV_IGNORED, MODEL_NOT_REVIEWED and RECOVERY_KEY_LINE.

2) Give cmdHealth an option such as `displayManifestPath` and use it for owner-facing copy. In cmdUpgrade's three verifyHealth(executionPin.target, ...) calls (brain.mjs:7118, 7216, 7243), pass `displayManifestPath: originalPin.target`. Then the Next: step names the real brain.manifest.json, not the temporary .brain-update-*.tmp pin. Keep using executionPin.target for loading and for the journal check.

3) Test at test/health-verify-exit.test.mjs:800: expect `renderCliCommands(HEALTH_NEXT_STEP(commandPath(seam.manifestPath, { platform })), { platform })`. On win32, also assert that the logged line contains `'` + seam.manifestPath + `'` (single-quoted, with the 'Owner Folder' space inside), so an unquoted path fails the check. Optionally add an update-seam check that the printed path does not contain `.brain-update-`.

- Verifier's reasoning:

I traced the path and it holds. In the final head, brain.mjs:4296-4301 runs `if (inventory.anthropic_key_missing === true) { warn(HEALTH_KEY_MISSING); info(HEALTH_NEXT_STEP(manifestPath)); }` before the reachOnly return at 4302. brain.mjs:3695 does the same in `brain secrets`. HEALTH_NEXT_STEP (operations/answer-setup-copy.mjs:45) puts `${manifest}` in raw. info() (brain.mjs:482) only calls renderCliCommands, and renderCliCommands (operations/cli-guidance.mjs:108-119) only swaps the leading `brain` for the brain.cmd shim or the `& 'node.exe' 'brain.mjs'` form. Nothing quotes the path. The product already has commandPath() (brain.mjs:1816) for exactly this and uses it in about 20 other copyable commands, but not here.

The standard Windows layout is %USERPROFILE%\Financial Brain\brain.manifest.json (installed-manifest.mjs:391), which has a space. `brain health` passes the raw argv path, so a full path the owner typed in quotes comes back unquoted.

Inside `brain update` it is worse than the claim says. Update calls verifyHealth(executionPin.target, ...) at brain.mjs:7118, 7216 and 7243. That target is the temporary pinned copy `.brain.manifest.json.brain-update-<pid>-<hex>.tmp` (writePinnedExecutionManifest, brain.mjs:5881-5910), which sits in the same spaced folder and is deleted after the update. So the printed Next: step names a file that will no longer exist, and it is unquoted. The proposed commandPath() fix alone does not fix the update case.

The test claim also holds. test/health-verify-exit.test.mjs:659-664 builds the win32 manifest under 'Owner Folder'. Lines 800-810 then expect `renderCliCommands(HEALTH_NEXT_STEP(seam.manifestPath), { platform })`, which is the unquoted form. rendererControl (802-804) only proves the prefix was rewritten. So the check passes on the broken command and would fail once the product quotes the path.

Why I rate it lower than P2: it fails safe. With the split argv, cmdConnect (brain.mjs:19603-19621) takes argv[4] = '...\Financial' as the manifest. The half-run journal check looks in the wrong folder, but the manifest load then fails before any Cloudflare or key action. Nothing is changed or lost and no key is exposed. It is only reachable when Claude answers are configured and the Worker reports the key missing, and the product line predates this diff (only the test is new). It is still a real defect: the only recovery step shown for paused answers cannot run as printed on the standard Windows layout.

- Reproduction: Probe: C:\offload\review-0419-final-scratch\verify-health-quote\probe.mjs. It imports cmdHealth from the read-only head, writes a manifest at %TEMP%\probe-health-space-XXXX\Financial Brain\brain.manifest.json with retrieval set to Opus/Sonnet, and injects request/resolveKey/wait. The fake /health returns ok and the documents receipt sets anthropic_key_missing: true. Running `node probe.mjs` on win32 gave failure=null and logged: `Next: & 'C:\Program Files\nodejs\node.exe' 'C:\offload\review-0419-final\brain.mjs' connect anthropic %TEMP%\probe-health-space-...\Financial Brain\brain.manifest.json --from-clipboard`. I parsed that line with the PowerShell 5.1 AST parser ([System.Management.Automation.Language.Parser]::ParseInput). The command elements are: 'node.exe', 'brain.mjs', connect, anthropic, %USERPROFILE%\AppData\Local\Temp\probe-health-space-...\Financial, Brain\brain.manifest.json, --from-clipboard. The path splits into two arguments, and cmdConnect reads argv[4] ('...\Financial') as the manifest. Separately, by code reading: update passes executionPin.target (a deleted-after-use .tmp copy in the same folder) to cmdHealth, so the Next: line printed during update names that temp file.

### 23. [P3] The early half-run check in `brain connect anthropic` skips the --json receipt and misreports a concurrent run as interrupted

- Area: rest-of-diff. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19619`; verifier: brain.mjs:19619-19621 (cmdConnect, `which === "anthropic"` branch: `if (manifestPath && ... && setupNeedsRecovery(manifestPath)) die(HALF_RUN(manifestPath));`)
- Same root cause as: #10, #13, #19, #18 (the half-run check in brain connect anthropic runs before the lock).
- Inputs: Case (a): run `brain connect anthropic <manifest> --keep-key --json` while a journal exists. Case (b): a first connect run is mid-deploy or in its Worker-check loop, so it holds the lifecycle lock and has legitimately written the journal, and a second `brain connect anthropic` starts in another window.
- Wrong outcome: Case (a): the new check calls die() outside cmdConnectAnthropic, so the caller gets a plain-text Fatal ('fail  The Claude setup was interrupted part way...'). It does not get the documented `answer_setup.connect` JSON receipt with error_code and rolled_back fields that every other failure returns (the test 'JSON failures always carry explicit rollback fields'). Case (b): the check runs before the lifecycle lock, so the second run tells the owner the setup 'was interrupted part way ... Ask the person who set up your Brain for help'. Before this diff, the check ran inside the lock and the second run got a busy message.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus5\json-probe.mjs prints `Fatal no JSON payload :: The Claude setup was interrupted part way.`
- Fix: Move the presence check into cmdConnectAnthropic's try block, before runManifestControl's credential work, so the flags.json branch turns it into a JsonFatal with error_code 'half_run'. For a plain run, probe the lifecycle lock without blocking first, and report busy when the lock is held.
- Verifier's fix note:

Keep the presence check in cmdConnect, before runManifestControl, so that the "refuses every journal state before credential control" test still holds. Change two things at brain.mjs:19619-19621.

(1) Run the presence decision under a non-blocking lifecycle lock attempt, which is local filesystem only. Use withBrainLifecycleLock({ manifestPath, operation: "answer-setup-check", retryCommand: "brain connect anthropic <manifest>" }, () => setupNeedsRecovery(manifestPath)).
- If the attempt throws BrainLifecycleLockError with code brain_lifecycle_busy, report the busy message and do not report a half-run.
- If it throws brain_lifecycle_recovery_required, map it to UPDATE_FIRST(manifestPath), the same way cmdConnectAnthropic does.
- The in-lock journalExists check inside runAnthropicAnswerSetup still covers a journal created after this snapshot.

(2) When flags.json === true, throw a JsonFatal instead of calling die(). For a half-run, use { schema_version: 1, operation: "answer_setup.connect", status: "error", error_code: "half_run", rolled_back: false, rollback_target: null }. For a busy lock, use the same shape with error_code "brain_lifecycle_busy". For a journal that cannot be inspected, use error_code "half_run_undecidable".

Add two tests to test/anthropic-connect.test.mjs: one where --json plus a journal yields a JsonFatal with error_code half_run, and one where a held lifecycle lock plus a journal yields the busy message rather than HALF_RUN.

- Verifier's reasoning:

Both cases are real, and both are regressions from this diff. The impact is bounded.

How the code runs: the final head adds a journal-presence check to cmdConnect at brain.mjs:19618-19621. It runs before withManifestCloudflareControl and before cmdConnectAnthropic, and it calls die(HALF_RUN(manifestPath)), which throws a plain Fatal. The --json handling sits in cmdConnectAnthropic's catch block (brain.mjs:19829-19845), so this early path never reaches it. The top-level handler at brain.mjs:33657 prints a plain Fatal as "fail  <text>", not as a JSON receipt. Before the diff, the only journal check was inside runAnthropicAnswerSetup, under the lifecycle lock (operations/answer-setup.mjs:371-375). That check threw code HALF_RUN, and with --json the caller got a JsonFatal with error_code "half_run".

Case (b): the first run writes the journal at answer-setup.mjs:452 and removes it only at 508, 524 or 569. In between it reconciles the daily task, stores the secret, deploys, and runs the Worker-check loop (up to about 60 s, plus a 75 s request timeout), all while holding the lifecycle lock. A second run during that window now passes the lock-free presence check first. It gets INTERRUPTED_WITH_STORED_KEY ("interrupted part way ... Ask the person who set up your Brain for help") instead of the busy message, because HALF_RUN is called with one argument, so secretNameExisted is undefined.

I reproduced both cases with a probe that uses a real lifecycle lock under a scratch lock root. Every Cloudflare dependency was stubbed with a tripwire.

Why P3 and not higher:
- Nothing is written in either case, and the first run finishes normally and removes its journal.
- The wrong message still points toward safety: it says not to disconnect and to ask for help.
- Case (b) needs two concurrent connect runs in separate windows during a supervised session.
- I found no in-repo consumer of `connect anthropic --json`. The technician step builds `connect anthropic <path> --<mode>` without --json (operations/technician-setup.mjs:907-913), and the skill and runbook never pass it. The break is to the documented --json contract only.

The claimant's proposed fix is wrong as written. cmdConnectAnthropic runs inside runManifestControl, so a check placed in its try block cannot also come "before runManifestControl's credential work". Moving it there would also break the deliberate test "the installed Anthropic connect route refuses every journal state before credential control" (test/anthropic-connect.test.mjs:870). The check must stay in cmdConnect. Only its failure shape and its lock awareness need to change.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\verify-halfrun\probe.mjs, run with `node probe.mjs`. It imports brain.mjs, operations/brain-lifecycle-lock.mjs and operations/answer-setup.mjs from C:\offload\review-0419-final. It writes a fixture manifest under the scratch dir and holds withBrainLifecycleLock({operation:"answer-setup", machineLockRoot:<scratch>}) while writing .answer-setup-journal.json, to stand in for a first run mid-deploy. It then calls cmdConnect("anthropic") with withManifestControl passing straight through and tripwires on verifyVersion, listSecretNames, checkWorker and deploy. "Pre-diff order" means the same calls with the early check disabled (answerSetupNeedsRecovery: () => false). Output:

[b final head, plain] Fatal :: "The Claude setup was interrupted part way. Do not remove the Claude connection ... Ask the person who set up your Brain for help."
[b pre-diff order, plain] Fatal :: "the Brain lifecycle lock is held by answer-setup since ... That process is still running. Wait for it to finish, then run the same command again."
[a final head, --json, concurrent] Fatal, no JSON payload :: "The Claude setup was interrupted part way..."
[a pre-diff order, --json, concurrent] JsonFatal error_code=brain_lifecycle_busy, rolled_back:false, rollback_target:null
[a final head, --json, leftover journal] Fatal, no JSON payload :: "The Claude setup was interrupted part way..."
[a pre-diff order, --json, leftover journal] JsonFatal error_code=half_run, rolled_back:false, rollback_target:null

No tripwire fired in any of the six runs.


### 24. [P3] Half-run and rollback guidance contradict each other when no key was stored before

- Area: rest-of-diff. Finder severity P3, verifier severity P3.
- Location: `operations/answer-setup-copy.mjs:31`; verifier: operations/answer-setup-copy.mjs:31 (HALF_RUN), with the one-argument callers at brain.mjs:4297, brain.mjs:19620, brain.mjs:30959, doctor.mjs:893 and operations/answer-setup.mjs:373. The state-blind copy is at support-recovery.mjs:62 and onboarding/06-runbook-top-ten-failures.md:768.
- Inputs: A first-time Claude setup (`secret_name_existed: false`) fails during rollback, so ANTHROPIC_ROLLBACK_INCOMPLETE is raised with the journal kept.
- Wrong outcome: The CLI line from ROLLBACK_INCOMPLETE(manifest, false) tells the owner to run `brain disconnect anthropic <manifest>`. The `brain support` explanation for the same code (support-recovery.mjs:62) and the runbook (06-runbook line 768) say 'Leave the saved connection and half-run journal unchanged'. Every later surface calls HALF_RUN with one argument only: health (brain.mjs:4297), doctor (doctor.mjs:893), connect (19620) and update (30959). So they always show 'Do not remove the Claude connection, because that removes your stored key', even though the journal records that no key existed before. The owner gets opposite instructions for the same state, and a safe disconnect gets escalated to the setup person.
- Finder's evidence: `grep -n 'HALF_RUN('` shows no caller passes the second argument, and HALF_RUN returns INTERRUPTED_WITH_STORED_KEY unless that argument is strictly false. The support catalog entry has no branch on journal state.
- Fix: At the HALF_RUN call sites, read the journal and pass `journal.secret_name_existed`, falling back to the conservative copy when the journal is unreadable. Make the ANTHROPIC_ROLLBACK_INCOMPLETE support and runbook text neutral (for example 'follow the line printed above'), or branch it on the same flag.
- Verifier's fix note:

1. Add a helper in operations/answer-setup.mjs:

```js
export function answerSetupJournalSecretExisted(manifestPath) {
  try {
    const j = JSON.parse(readFileSync(answerSetupJournalPath(manifestPath), "utf8"));
    return j?.schema_version === 1 && typeof j.secret_name_existed === "boolean"
      ? j.secret_name_existed
      : undefined;
  } catch {
    return undefined;
  }
}
```

   It returns `undefined` for a missing, unreadable or malformed journal, which falls back to the conservative stored-key copy.

2. Keep the presence-only guard decisions as they are (answerSetupNeedsRecovery and existsSync). Change only the message at each call site to `HALF_RUN(path, answerSetupJournalSecretExisted(path))`: brain.mjs:4297, 19620, 30959, doctor.mjs:893 and answer-setup.mjs:373.

3. Make the ANTHROPIC_ROLLBACK_INCOMPLETE support step and the runbook line neutral, so they never contradict the state-aware line. For example: "1. Follow the setup line printed just before this code. 2. If that line says not to remove the Claude connection, or you are unsure, leave everything unchanged and ask the person who set up your Brain for help." This still contains no `brain <cmd>` and no "disconnect", so it passes the existing conservative-guidance tests.

4. Add a test: with a `secret_name_existed:false` journal, doctor and health show the disconnect form, and with a malformed journal they show the stored-key form.

A smaller alternative: if the team wants every surface conservative, drop the `false` branch from ROLLBACK_INCOMPLETE so the connect line matches the other surfaces, and update the two copy tests that check the `false` case.

- Verifier's reasoning:

I traced this in the final head and reproduced it. The claim reads the code correctly, but the impact is small.

1. Where the CLI line comes from. operations/answer-setup.mjs:250-260 writes the journal with `secret_name_existed: secretExisted === true`. A first-time setup therefore records `false`. When any rollback step throws (manifest write, secret delete, reconcileDaily, verifyDeploy or deploy), line 575 builds the error from `ROLLBACK_INCOMPLETE(manifestPath, journal.secret_name_existed)` and leaves the journal in place. With `false`, answer-setup-copy.mjs:24-25 prints "To return it to the built-in model, run: brain disconnect anthropic <manifest>". test/anthropic-connect.test.mjs:704-718 pins this for `secretPresent=false`.

2. That advice is correct and it works. cmdDisconnectAnthropic (brain.mjs:20716-20788) does not refuse when a journal exists. It resets the manifest to the built-in model, deletes ANTHROPIC_API_KEY, removes the journal (lines 20779-20782) and deploys.

3. Every other surface gives the opposite advice for the same state:
   - Support explanation (support-recovery.mjs:62) and runbook (06-runbook line 768): "Leave the saved connection and half-run journal unchanged. Ask the person who set up your Brain for help."
   - HALF_RUN is called with one argument everywhere: brain.mjs:4297 (health), 19620 (connect), 30959 (update), doctor.mjs:893 and answer-setup.mjs:373. HALF_RUN (answer-setup-copy.mjs:31-33) returns INTERRUPTED_WITH_STORED_KEY unless the second argument is strictly `false`. So these surfaces always say "Do not remove the Claude connection, because that removes your stored key", even when the journal records that no key existed before.
   - As a result, the `false` branch of HALF_RUN never runs in production.

4. Probe result (scratch dir). I wrote a real first-time journal, then printed each surface:
   - ROLLBACK_INCOMPLETE gives the disconnect command.
   - `renderSupportRecovery` gives "Leave ... unchanged / Ask the person who set up your Brain".
   - doctor.checkAnthropicKey gives a WARN with "Do not remove the Claude connection, because that removes your stored key".

   The state is identical in all three, but the instructions are opposite.

Why the severity is not higher:
- The conservative support and runbook text is deliberate. Tests check it: anthropic-connect.test.mjs:721-752 and the fix-0419-partner-r1 mutant tests.
- Both instructions are safe in this state. Disconnect deletes only the key entered in this run, and asking for help changes nothing.
- No data or key is lost, and no guard is bypassed.
- The supervised update path only refuses with the conservative copy, which is correct.

The real harm is limited:
- A non-technical owner gets contradictory directions.
- A disconnect that would have been safe is escalated unnecessarily.
- The "removes your stored key" warning is inaccurate when no key existed before. Either the key is the one just entered, which rollback itself would have deleted, or there is no key at all.

So it is confirmed, at P3.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\verify-halfrun-copy\probe.mjs (run with `node probe.mjs`).

Steps:
1. Create a temp dir in %TEMP% containing brain.manifest.json.
2. Write the journal from `answerSetupJournal({retrieval:{},safety:{}}, {mode:"clipboard", secretExisted:false})` to `answerSetupJournalPath(manifest)`.
3. Print four surfaces:
   - `ROLLBACK_INCOMPLETE("<manifest>", journal.secret_name_existed)`
   - `renderSupportRecovery(supportRecovery("ANTHROPIC_ROLLBACK_INCOMPLETE"))`
   - `doctor.checkAnthropicKey({}, {manifestPath})`
   - `HALF_RUN("<manifest>")`

Observed output:
- journal.secret_name_existed is `false`.
- The connect CLI line is "Your Brain could not be put back automatically. To return it to the built-in model, run: brain disconnect anthropic <manifest>".
- The support explanation step 1 is "Leave the saved connection and half-run journal unchanged."
- Doctor returns status warn with "The Claude setup was interrupted part way. Do not remove the Claude connection, because that removes your stored key. Ask the person who set up your Brain for help."
- Health, connect and update print the same HALF_RUN text as doctor.

In the real CLI, the trigger is a first-time `brain connect anthropic <manifest> --from-clipboard` whose Worker check fails and whose rollback redeploy also fails (for example a network drop). If the owner then runs `brain health` or `brain doctor`, they are told not to do what the connect command just told them to do.


### 25. [P3] Pre-start lock failures in `brain update` get UPGRADE_FAILED, whose guidance says the update stopped partway

- Area: rest-of-diff. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:31566`; verifier: brain.mjs:31566-31569 (catch in cmdUpdate); pre-existing fallback also at brain.mjs supportErrorCode `if (command === "upgrade" || command === "update") return "UPGRADE_FAILED"`
- Same root cause as: #12 (pre-start update refusals are filed as UPGRADE_FAILED).
- Inputs: Run `brain update C:\wrong\brain.manifest.json`, a mistyped path. The same applies when the manifest has nlink>1 or is invalid JSON, or when the lock directory cannot be made private: any brain_lifecycle_manifest_missing, manifest_unsafe or unsafe error thrown while acquiring the lock.
- Wrong outcome: The new catch maps every non-busy brain_lifecycle_* code to UPGRADE_FAILED. That catalog entry says 'One update stage did not reach its verified completion point ... document loading is paused ... Run brain update once more; it picks up where it stopped'. No update stage started, and rerunning the same command fails the same way.
- Finder's evidence: Probe C:\offload\review-0419-final-scratch\focus5\typo-probe.mjs prints `Fatal UPGRADE_FAILED :: the Brain manifest does not exist`, and renderSupportRecovery('UPGRADE_FAILED') shows the 'stopped before its last check / picks up where it stopped' text.
- Fix: Map the manifest_missing and manifest_unsafe codes to a pre-start code with path guidance, for example reusing the discovery wording from cmdUpdateWithPrompts. Map brain_lifecycle_unsafe to a lock-specific code. Keep UPGRADE_FAILED only for failures after the lock is held.
- Verifier's fix note: In the cmdUpdate catch, choose the code by lock error code. For brain_lifecycle_manifest_missing and brain_lifecycle_manifest_unsafe, call dieWithSupportCode with "CONFIG_INVALID". That code already exists, and printSupportReceipt hides the explain line for it. Add a path hint to the message, for example: `${error.message}. Check the full path to brain.manifest.json, or run brain update with no path on the computer that remembers this Brain.` For brain_lifecycle_unsafe that is thrown before the callback runs, use a lock-specific code, or a CONFIG_INVALID-style message saying the update did not start. Use UPGRADE_FAILED only once the lock is held. To tell the two apart, set a local `lockHeld = true` as the first statement of the callback passed to lockTask, and use it in the catch: UPGRADE_FAILED if the error was thrown after lockHeld became true, the pre-start code if before. Add a cmdUpdate test with a missing manifest path that asserts supportCode is not UPGRADE_FAILED.
- Verifier's reasoning:

The path is reachable and the code does what the claim says, but the claim overstates how new it is and how much harm it does.

How the path runs: dispatchUpdateCli (brain.mjs:30272) passes the typed positional path to cmdUpdate unchanged. When a manifest path is given, cmdUpdate skips discovery and calls withBrainLifecycleLockWait with that path straight away (brain.mjs:31551-31565). Inside the lock, brainLifecycleCoordinates calls canonicalManifest (operations/brain-lifecycle-lock.mjs:124-134). That function throws BrainLifecycleLockError("brain_lifecycle_manifest_missing", "the Brain manifest does not exist") before any lock directory is made. Invalid JSON or nlink>1 gives brain_lifecycle_manifest_unsafe (lines 130-140). An ACL or mkdir problem gives brain_lifecycle_unsafe (lines 105-122, 355-363). The new catch at brain.mjs:31565-31571 sends every code except busy to dieWithSupportCode(..., "UPGRADE_FAILED"). The main handler (brain.mjs:33657-33668) then prints "fail  the Brain manifest does not exist" and "Need help with this? Run: brain support --explain UPGRADE_FAILED". The UPGRADE_FAILED entry (support-recovery.mjs:94) says "One update stage did not reach its verified completion point" and "Run brain update once more; it picks up where it stopped". No update stage started, and a rerun fails the same way.

Where the claim goes too far:
(1) The diff did not create the wrong code. In f8a7cd05 the raw lock error reached crash(). supportErrorCode then fell through to the `command === "update"` fallback, which returns UPGRADE_FAILED even with unexpected:true. My probe shows this for the missing, invalid-JSON and unsafe cases. The diff made the visible output better: it used to say "unexpected error ... This is a bug in the installer" and now prints a plain fail line. The support code is the same as before.
(2) The line the owner sees first is accurate ("the Brain manifest does not exist"). The misleading text only appears if someone runs `brain support --explain UPGRADE_FAILED`. Its second step ("If it stops again at the same step, run brain support --preview and send us that note") ends in a harmless support note. Nothing is lost, corrupted or left in a bad state.

So this is a real but small mismatch between the support code and the guidance, which carried over unchanged through code this diff rewrote. It is P3.

- Reproduction:

Probe: C:\offload\review-0419-final-scratch\verify-typo-lock\probe.mjs. It sets BRAIN_LIFECYCLE_LOCK_ROOT to a scratch folder and imports brain.mjs and the lock module from C:\offload\review-0419-final. It then calls cmdUpdate("C:/offload/review-0419-final-scratch/verify-typo-lock/no-such/brain.manifest.json", {}). Output:
- final head: Fatal UPGRADE_FAILED :: the Brain manifest does not exist
- final head classified: UPGRADE_FAILED
- old path classified (raw BrainLifecycleLockError, supportErrorCode with command "update" and unexpected:true, i.e. the f8a7cd05 crash() route): UPGRADE_FAILED. The manifest_unsafe "not valid JSON" error and the lifecycle_unsafe "not private" error also give UPGRADE_FAILED.
support-recovery.mjs:94 holds the "stopped before its last check / picks up where it stopped" text that this code points to.


## Refuted or uncertain

- [refuted] ROLLBACK_INCOMPLETE gives conflicting advice, and the disconnect it recommends does not restore the journaled daily cap (`operations/answer-setup-copy.mjs:24`; area answer-setup-journal; finder P3, verifier re-rated P3).

The cap claim does not hold for the path the reviewer described.

1. The rollback writes the manifest before it redeploys. In operations/answer-setup.mjs the catch block builds rollbackManifest from the journal (line 540). Its first step, line 549 (`await writeManifest(manifestPath, rollbackManifest)`), runs before the secret delete, the daily reconcile and the rollback redeploy (line 566). restoreManifestFromAnswerSetupJournal always restores safety.daily_llm_spend_cap_usd from journal.previous: it puts the value back if one was recorded, and deletes the field if none was. So when the forward deploy fails and the rollback redeploy also fails, the manifest on disk already has the old cap (absent, so $10) and no models. ROLLBACK_INCOMPLETE is thrown after that write. If the owner then follows the CLI advice and runs `brain disconnect anthropic`, cmdDisconnectAnthropic (brain.mjs:20716 onward) loads a manifest whose cap is absent. The cap stays absent. Nothing is halved.

2. The cap can stay at $5 only if the rollback's own local atomic manifest write (line 549) fails, right after the same write succeeded on the forward path. Even then, disconnect ends with models cleared, the key deleted, the journal removed and the cap at $5. That is exactly the state a normal successful connect followed by a normal disconnect leaves. Connect deliberately lowers an absent or $10 cap to RECOMMENDED_CLAUDE_DAILY_CAP_USD = 5 (capAfterEdit). Disconnect deliberately keeps the cap, and test/anthropic-connect.test.mjs:1004 pins that ("disconnect clears both models, preserves the cap"). So this is the designed outcome of disconnect, not corruption specific to the half-run. The cap is a spend ceiling. No owner data is lost.

3. The "conflicting advice" is intentional and tested. The support catalog (support-recovery.mjs:62) and the runbook have no state to check, so they always give the conservative step: "ask the person who set up your Brain". The CLI knows journal.secret_name_existed. It points to disconnect only when no key was stored before the run, and in that case disconnect removes only the key this run wrote. test/fix-0419-partner-r1.test.mjs (verifyStoredKeyCopy, verifyRollbackSupportGuidance) and test/anthropic-connect.test.mjs ("a stored-key rollback failure leads only to conservative support guidance") check both behaviors: the no-stored-key CLI line keeps the disconnect advice, and the support and runbook text contains no CLI command. Following either piece of advice is safe. This is a difference in wording, not a wrong result or a guard that can be bypassed.

At most this is a P3 copy inconsistency. The cap-corruption claim is refuted.

Reproduction: Probe: C:\offload\review-0419-final-scratch\verify-rollback-cap\probe.mjs. It imports runAnthropicAnswerSetup from the final head and cmdDisconnectAnthropic from brain.mjs, with in-memory deps. Start state: built-in Brain, no stored key, safety = {}. Run: connect --from-clipboard, where every deploy throws.

Case A, the claimed path (forward deploy and rollback redeploy both fail): the error is ANTHROPIC_ROLLBACK_INCOMPLETE with the disconnect line. Disk after connect is {"retrieval":{},"safety":{}}, with the journal kept and the secret already deleted. Disk after `disconnect` is {"retrieval":{},"safety":{}}, so the cap is still absent ($10).

Case B, where the rollback's own manifest write also throws: disk after connect is the cap-5 manifest with Claude models. After disconnect it is {"retrieval":{},"safety":{"daily_llm_spend_cap_usd":5}}. A normal connect followed by disconnect leaves the same state, by design.

Run with: node C:\offload\review-0419-final-scratch\verify-rollback-cap\probe.mjs

- [refuted] A leftover answer-setup journal blocks every future update, and no supported command clears it (`brain.mjs:30958`; area rest-of-diff; finder P2, verifier re-rated P3).

The individual refusals are real. The claimed deadlock is not, because one supported technician command does not check the journal.

What is true in the final head (5d8f804d):
- This diff adds the presence-only journal check (answerSetupNeedsRecovery) in exactly two places: cmdUpdateWithPrompts (brain.mjs:30958-30960) and cmdConnect anthropic (brain.mjs:19618-19620).
- cmdDisconnectAnthropic still requires the live Worker to report version === PRODUCT_VERSION (assertLiveAnswerSetupWorker, brain.mjs:19713-19714), or it throws UPDATE_FIRST. That behaviour predates this diff.
- The new HALF_RUN copy is always called with one argument, so it always says "do not remove the Claude connection".

What breaks the claim:
- `brain upgrade <manifest>` is listed in `brain help` under "Technician only" as "snapshot, migrate, deploy, verify". It dispatches as upgrade: cmdUpgradeInteractive -> withManifestCloudflareControl -> cmdUpgrade (brain.mjs:33301, 28664-28666, 6819).
- Neither wrapper nor cmdUpgrade calls answerSetupNeedsRecovery, and neither reads the journal.
- The only other journal read on that path is cmdHealth, which only warns (brain.mjs:4297).
- docs/README-developer.md:219 calls `brain upgrade` the same engine with the same gates. Runbook line 705 tells technicians to rerun `node brain.mjs upgrade <manifest>` by hand. `brain doctor --repair --yes` resumes the same engine.

So when the CLI is newer than the Worker and the journal is present, the setup person can do this:
1. Run `brain upgrade <manifest>`. The Worker reaches the CLI's PRODUCT_VERSION.
2. Run `brain disconnect anthropic <manifest>`. It now passes assertLiveAnswerSetupWorker and removes the journal (brain.mjs:20779-20781).
3. `brain update` and `brain connect anthropic` work again.

Before the CLI is upgraded, versions match, so `brain disconnect anthropic` works directly. "The Brain can never be updated again without hand-deleting the file" and "no supported command clears it" are both false.

The scenario also needs the CLI to be upgraded while the journal is unresolved. There is no self-update in dispatchUpdateCli (brain.mjs:30247+), so a new CLI only arrives when the technician installs it. The technician controls that ordering, and the owner copy already sends the owner to them.

What is left is P3. The runbook and the support entry for ANTHROPIC_ROLLBACK_INCOMPLETE say to "leave the journal unchanged and ask the setup person", but no text gives the setup person the steps above. The update refusal uses die() with no support code, so `brain support --explain` cannot route it.

Not proven offline: a narrow sub-case where the manifest already names the Claude models but the key was never stored, and the process was killed between the manifest write and putSecret. There, `brain upgrade` might stop at acceptance. Even then, staying on the matching CLI version and running disconnect still works.

Reproduction: Probe: C:\offload\review-0419-final-scratch\verify-journal-deadlock\upgrade-ignores-journal.mjs, run from C:\offload\review-0419-final with node.

Setup: a temp manifest folder under %TEMP% that holds a half-run journal written with answerSetupJournal(). answerSetupNeedsRecovery(manifestPath) returns true.

Step: call brain.cmdUpgrade(manifestPath, { resolveAccount: throws SENTINEL }).

Output:
"journal present before: true needsRecovery: true"
"upgrade: Error code=SENTINEL :: SENTINEL: upgrade reached Cloudflare account resolution"

So the technician-only `brain upgrade` path goes straight past the journal into its first remote step, while `brain update` refuses on the same journal. The other reviewer's probe (focus5\journal-deadlock-probe.mjs) confirms the update, connect and version-mismatched disconnect refusals. It never tried `brain upgrade`.

Static check: grep finds answerSetupNeedsRecovery only at brain.mjs:30958 (update) and brain.mjs:19619 (connect). The journal is read elsewhere only at brain.mjs:4297 (a health warning) and brain.mjs:20779 (disconnect removes it).

## C1 findings: status in the final head

| C1 | Status | Evidence | Remaining |
| --- | --- | --- | --- |
| C1-1 | fixed | operations/brain-lifecycle-lock.mjs:408-433: the lock is now taken over only when `stale && ownerDead` (re-checked at :419-428). lifecycleOwnerIsDead (:91-97) treats an owner as dead only when isOwnerAlive is false, or when the owner has the contender's own PID with a different process_instance. A live owner with another PID can never be reaped, whatever its identity or age. The start-time identity compare (identityEpochMs, sameProcessIdentity and the 2,000 ms tolerance) was removed. process_instance is now one random per-process token (:25, :372). Probe C:\offload\review-0419-final-scratch\c1check\lock\probe.mjs used a real separate holder process ('daily-refresh') and a contender running 'update' with the real liveness check and the real Windows lock root. Fresh mtime gave brain_lifecycle_busy. Owner mtime forced 2 h old with staleMs 60s gave brain_lifecycle_busy (restart guidance). Injected isOwnerAlive=true gave busy. Dead and fresh gave busy (recovery window). The holder still reported assertOwned true at the end. `node --test test/brain-lifecycle-lock.test.mjs` gave 11/11 pass. | Optional hardening not done: the default daily runSource still does not pass assertOwned into cmdLoad (operations/daily-refresh-run.mjs:562-566). Side effect of the new rule: a crashed holder now blocks other commands until its owner file is 30 minutes past its last heartbeat (DEFAULT_STALE_MS, :29). The update waits only 120 s and then refuses with 'Wait for the recovery window to end'. This fails safe and is bounded. Evidence caveat: the new regression file test/fix-0419-partner-r1.test.mjs fails 9 of 20 tests on this Windows host. Its darwin/linux loop iterations hit the POSIX mode-bit check at brain-lifecycle-lock.mjs:114-118 ('not private'). The win32 iterations run first and pass. The file is in TEST_COMMANDS (scripts/run-test-chain.mjs:768) with no platform filter. |
| C1-2 | still_open | acceptance.mjs is unchanged between f8a7cd05 and HEAD (no diff); worker/ is also unchanged. The configured-answer block is still acceptance.mjs:1115-1137: a null answer records FAIL at :1122, and a missing model records FAIL at :1132. Probe C:\offload\review-0419-final-scratch\c1check\acc\probe2.mjs fed contract-valid think responses into the real Acceptance.tierRetrieval. (b) answer_withheld (answer null, evidence_gate unsupported): Claude manifest passed=false with 'configured answer model returned an answer: expected claude-opus-5-5, but no answer text was returned'; built-in manifest passed=true. (c) answer_error dailyLimit: the same FAIL on Claude and PASS on built-in. (a) deterministic exact_contact_fact with no model: FAIL 'received none' (see C1-9). | Everything in the C1 fix is still open. Skip or WARN the model receipt for deterministic answers. Downgrade withheld, dailyLimit and busy null answers to WARN. Add the tests for the four response shapes. |
| C1-3 | partly_fixed | Fixed parts: (1) Update now refuses before any remote work while a journal file exists: brain.mjs:30958-30960 (answerSetupNeedsRecovery, operations/answer-setup.mjs:224-233, blocks on presence alone). (2) Connect refuses before Cloudflare control (brain.mjs:19615-19621). (3) HALF_RUN and ROLLBACK_INCOMPLETE no longer send a stored-key owner to disconnect (operations/answer-setup-copy.mjs:23-33). The runbook (onboarding/06-runbook-top-ten-failures.md:768) and support-recovery.mjs:62 now say to leave the journal alone and ask the setup person. Probes in C:\offload\review-0419-final-scratch\c1check\c3\. With a journal present, cmdConnect anthropic died with 'The Claude setup was interrupted part way. Do not remove the Claude connection...' and never reached manifest control. cmdUpdate died with the same text. Both happened for secret_name_existed true and false. | No command reads the journal or restores from it. There is no resume or --finish path, and restoreManifestFromAnswerSetupJournal is still only used inside a live run (answer-setup.mjs:540-546). cmdDisconnectAnthropic still deletes ANTHROPIC_API_KEY and removes the journal without consulting journal.secret_name_existed (brain.mjs:20757-20782). Probe: with a stored-key journal it returned secret_deleted true, deleted ANTHROPIC_API_KEY, and the journal was gone. Neither the runbook nor skills/financial-brain-technician/SKILL.md gives the setup person a procedure. An owner whose --keep-key run was interrupted is now blocked from connect and update. The only tool that clears the block still destroys the stored key; the other way out is hand-editing the manifest and journal. Every HALF_RUN call passes no journal state (brain.mjs:4297, 19620, 30959; answer-setup.mjs:373; doctor.mjs:893), so the secretNameExisted===false branch of HALF_RUN is never reached. |
| C1-4 | still_open | brain.mjs:30962 still calls assertReviewedAnswerModels in update. The MODEL_NOT_REVIEWED copy at operations/answer-setup-copy.mjs:40-41 still says 'First run brain disconnect anthropic'. cmdDisconnectAnthropic still runs assertLiveAnswerSetupWorker first and throws UPDATE_FIRST (brain.mjs:20729-20739). Probe C:\offload\review-0419-final-scratch\c1check\c4\probe.mjs used a manifest with version 0.4.8 and answer_model claude-sonnet-4-5. cmdUpdate threw Fatal ANSWER_MODEL_NOT_REVIEWED: 'First run brain disconnect anthropic ...'. cmdDisconnectAnthropic, with verifyVersion reporting an older Worker, threw UPDATE_FIRST: 'Update it first with: brain update ...'. The manifest bytes were unchanged. | The dead end remains. Add a manifest-only revert to the built-in model in disconnect when the live Worker is older, or an update-path prompt. Then fix MODEL_NOT_REVIEWED and support-recovery so they name a path that works. |
| C1-5 | still_open | worker/src/lib/mcp-endpoint.js is unchanged (no diff). The built-in ask description still offers 'or a short single-fact lookup' (:72). The initialize arm still says 'ask is for money and short lookups' (:686). The remote empty-search note still allows one search before saying 'I didn't find a matching record in this search' (:364). The Claude-mode fallback search description (:118) has no guard. A grep for 'Broad-question', 'record by record' and 'search again' finds nothing in mcp-endpoint.js. CHANGELOG.md is unchanged, so the unscoped routing claims also remain. | Neither option A (align the hosted connector) nor option B (scope the CHANGELOG and evidence-plan claims to the local MCP) was done. |
| C1-6 | still_open | operations/claude-workspace.mjs:134/136 are unchanged; they are the Claude think-first route with the Opus/Sonnet claim. cmdDisconnectAnthropic (brain.mjs:20716-20796) and cmdConnectAnthropic (brain.mjs:19723 onward) still never call writeAssistantWorkspaceGuide or refreshWorkspaceGuideAfterUpdate. The only guide refresh after setup is in update (brain.mjs:31452, 31468). components/brain-mcp.mjs is unchanged: ANSWER_SETUP, the tool descriptions and the route instructions are still fixed at module load (:97-103, :214, :960). DISCONNECT_LINE (answer-setup-copy.mjs:48) still has no restart instruction. | Re-render the guides after connect, disconnect and rollback. Add a restart line. Have brain_think carry a model receipt or answer_setup field, or re-read the manifest, so a stale process cannot present a built-in answer as Opus. |
| C1-7 | still_open | The early return at acceptance.mjs:968-976 is unchanged and still sits ahead of the only configured-answer checks (:1115-1137). No answer-check call was added. Probe C:\offload\review-0419-final-scratch\c1check\acc\probe2.mjs: a Claude manifest with probe_questions [] gave thinkCalls=0, results ['optional owner-question checks:skip'] and summary passed=true, even though the stubbed think response was a withheld or null answer. | Add a question-independent configured-answer check, for example POST /api/admin/brain/answer-check with model and status assertions, for non-built-in setups. Otherwise correct the CHANGELOG claim. |
| C1-8 | fixed | cmdUpdate now catches lifecycle-lock errors and rethrows them as Fatal UPDATE_BRAIN_BUSY or UPGRADE_FAILED with the lock's own message (brain.mjs:31552-31573). cmdDisconnectAnthropic does the same through die(error.message) (brain.mjs:20791-20793). As a backstop, crash() prints the lock message before the retryable network branch (brain.mjs:24614-24618). The update passes retryCommand (brain.mjs:31556). End-to-end probe C:\offload\review-0419-final-scratch\c1check\cli\run.mjs ran the real CLI `brain.mjs update <manifest>` with an isolated environment against a real separate process holding the lock as daily-refresh. After 120 s it exited 1 with stdout 'fail  the Brain lifecycle lock is held by daily-refresh since <time>. A process with that ID is running, but this computer could not confirm it is the same one. Wait for it to finish, then run ... update <manifest> again.' and the support code UPDATE_BRAIN_BUSY. 'internet connection dropped' did not appear. The focused test 'brain update preserves the lifecycle holder message...' passes. | Minor and not part of the C1 defect. The `support --explain UPDATE_BRAIN_BUSY` entry (support-recovery.mjs:95) still describes a readiness check, not a held lock. The holder text says the computer 'could not confirm it is the same one' for any live holder with another PID. |
| C1-9 | still_open | acceptance.mjs is unchanged. :1124 still records '<model> returned answer text' without checking that a model ran. :1128-1136 still FAILs when `model` is absent. The Worker deterministic paths still emit evidence_gate.method exact_contact_fact or quickbooks_observed_* with no model (worker/src/index.js:1643-1644; worker/ unchanged). Probe C:\offload\review-0419-final-scratch\c1check\acc\probe2.mjs sent an exact_contact_fact response with no model. Claude manifest: passed=false, PASS 'claude-opus-5-5 returned answer text' (a false claim), then FAIL 'configured answer model matches: expected claude-opus-5-5; received none'. Built-in manifest: passed=true. `node --test test/acceptance-answer-model.test.mjs` passes 4/4; none of those tests uses a deterministic response. | Add the deterministic-method skip or SKIP record. Stop naming a model in the PASS detail unless the response's model field names it. Add the regression test. |
| C1-10 | still_open | worker/src/index.js:525-535: checkAnswerModel still calls callLLM with max_tokens: 128 and no anthropic_max_tokens. worker/src/lib/core.js is unchanged; it reads anthropic_max_tokens at :568 and sets output_config.effort from anthropicEffort(model) at :599. The CLI preflight still uses effort 'low' (operations/answer-setup.mjs:142). | Pass anthropic_max_tokens (1024 or more) on the answer-model-check call. Optionally use effort 'low' for that label. Add a request-body test. |
| C1-11 | still_open | cmdHealth still builds the next step from the path it was given: brain.mjs:4300 `info(HEALTH_NEXT_STEP(manifestPath))`. There is no displayManifestPath option. cmdUpgrade still passes the pinned temporary manifest at brain.mjs:7118 (paused), 7216 (active) and 7243 (exact-version) via `verifyHealth(executionPin.target, ...)`. Probe C:\offload\review-0419-final-scratch\c1-11-20\c1-11\probe.mjs ran the final-head cmdHealth on a `.store.manifest.json.brain-update-<pid>-0123456789abcdef.tmp` copy with anthropic_key_missing true. It printed `Next: ... connect anthropic %TEMP%\probe-health-next-...\.store.manifest.json.brain-update-125040-0123456789abcdef.tmp --from-clipboard`. After the simulated update cleanup, `pinned exists after update: false`. One side effect of this release: HALF_RUN at brain.mjs:4297 is now called with one argument, so it prints the path-free 'interrupted part way' text. Also, cmdUpdateWithPrompts now refuses at brain.mjs:30958-30960 when a journal exists. So only the HEALTH_NEXT_STEP line still shows the temp path. | Pass the installed manifest path (originalPin.target) into cmdHealth as a display path at the three verifyHealth calls, and use it for HEALTH_NEXT_STEP at brain.mjs:4300. Alternatively, suppress that owner-facing line when health runs inside update. No test covers health running inside update. |
| C1-12 | still_open | Both default deploys still omit persistDomain:false: connect at brain.mjs:19816 `deploy: options.deploy ?? ((path) => cmdDeploy(path, { nextSteps: false }))` (also used by the rollback deploy at operations/answer-setup.mjs:566), and disconnect at brain.mjs:20755. cmdDeploy still persists the workers.dev domain when `!m.brain?.domain && options.persistDomain !== false` (brain.mjs:3215). The order is still daily reconcile first (answer-setup.mjs:457; rollback :564; disconnect brain.mjs:20751), then deploy (answer-setup.mjs:482/:566; brain.mjs:20755). The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-12\probe.mjs), uses the real runAnthropicAnswerSetup, the real reconcileDailyDefinitionAfterManifestEdit, persistWorkersDevDomain and runDailyRefreshCli. Result: manifest brain.domain = fixture-brain.ownersub.workers.dev, and the daily run threw 'the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it'. In the control run (no domain persist), the run passed the definition guard (REACHED_SOURCE_RUN). | Pass `persistDomain: false` in the deploys at brain.mjs:19816 and 20755, or reconcile the daily definition again after the deploy changes the manifest. Add a domain-less manifest test. |
| C1-13 | still_open | The rollback copy at operations/answer-setup.mjs:570-571 is unchanged: `log(rollbackTarget === "previous" ? ROLLED_BACK_PREVIOUS : ROLLED_BACK_BUILT_IN); log(failureLine(failureClass));`. failureClass 'error' still maps to CHECK_FAILED (:290). A putSecret failure still gets supportCode ANTHROPIC_CHECK_FAILED (:471-473). The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-13\cli-copy-probe.mjs), drives the real cmdConnectAnthropic. For putSecret Cloudflare 500, first-deploy 'could not set the drain cron' and checkWorker throw, stdout still prints 'Your Brain could not answer with Claude using this key...' followed by 'Anthropic refused the test message ... Support code: ANTHROPIC_CHECK_FAILED.' The putSecret case's Fatal carries supportCode ANTHROPIC_CHECK_FAILED. | Use the key-blaming copy only when error.workerCheck or a preflight verdict exists. Add neutral rollback text for Cloudflare or local step failures, and give the secret-write failure its own support code. |
| C1-14 | still_open | operations/answer-setup.mjs:521 is still `if (transient && (!["clipboard", "prompt"].includes(mode) \|\| keyPreflightOk))`, which is always true for dashboard and keep modes, and :525 logs CHECK_PENDING ('Your key works...'). The daily_limit branch at :505-519 still prints DONE_LINES with no proof that the key works. The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-14\probe.mjs), gave these results in dashboard mode. Busy: manifest left on opus-sonnet, journal removed, 'Your key works, but your Brain's own test could not finish yet...'. spend_check_paused: same result. daily_limit over an existing pair: LIMIT_ALREADY_REACHED plus 'Done. Claude Opus now writes your answers...'. No model echo after 31 checks: 'Your key works...'. Controls behave as before. | Compute keyProven = keyPreflightOk \|\| a status of ok or check_problem. Print 'Your key works' or DONE_LINES only when keyProven. Otherwise roll back, or print a 'key not yet tested' line. |
| C1-15 | still_open | operations/answer-setup.mjs:539 still requires this run to have written the key: `const writtenKeyRejected = keyWritten && Boolean(error?.workerCheck) && failureClass === "key_rejected"`. keepPrevious (:542-543) and shouldDelete (:551-552) still depend on it. KEY_REJECTED copy (answer-setup-copy.mjs:13) is unchanged ('click Copy, and rerun the same command ... Nothing was changed'). The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-15\probe.mjs), gave these results. A, dashboard with an earlier Opus/Sonnet pair: setup=opus-sonnet, secret_stored=true, target=previous, ROLLED_BACK_PREVIOUS + KEY_REJECTED. B, dashboard with an earlier built-in setup, run twice: secret_stored=true and the same failure both times, with DASHBOARD_STEPS never shown. D, keep-key with a cap: same as A. C, clipboard control: rolls back to built-in and deletes the secret. | Treat a key_rejected verdict from the Worker on the stored secret as rejected no matter who wrote it: roll back to built-in, and decide whether to delete the dashboard secret. Make the KEY_REJECTED copy and the support-recovery next step depend on the mode (dashboard: edit the secret in Cloudflare; keep: use --from-clipboard with a new key). Add tests for dashboard and keep with key_rejected. |
| C1-16 | still_open | operations/answer-setup-copy.mjs:20 is unchanged: CLIPBOARD_CLEAR_WARNING = 'Claude answers are connected, but this command could not clear the clipboard...'. It is still logged from clearClipboardNow (answer-setup.mjs:359) on success, rollback (:567) and finally (:584). The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-16\probe.mjs), drives the real cmdConnectAnthropic. In the cases for preflight key_rejected, preflight billing, clipboard read failure and wrong key shape, the probe printed the 'Claude answers are connected' warning before the failure Fatal. Only change: the half-run sub-case can no longer be reached from the real CLI, because cmdConnect now dies on a journal before the clipboard is read (brain.mjs:19616-19621). | Make the warning text neutral, or choose it based on `completed`. |
| C1-17 | still_open | brain.mjs:19825 `if (flags.json === true) console.log(JSON.stringify(result));` still drops the collected output lines. resultReceipt (operations/answer-setup.mjs:304-315) still has no clipboard field. The JsonFatal payload (brain.mjs:19835-19842) has no clipboard field either. The C1 probes, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-17\probe.mjs and probe-fail.mjs), gave these results. json=true with the worker ok or busy: stdout is only the receipt (keys preset, answer_model, gate_model, daily_cap_usd, secret_name, key_written, worker_check, rolled_back, rollback_target), stderr is empty and the warning is never shown. json=true with preflight key_rejected: the JsonFatal payload has no clipboard field and no warning is printed. | Add clipboard_cleared to resultReceipt and to the JsonFatal payload, and write CLIPBOARD_CLEAR_WARNING to stderr in JSON mode. |
| C1-18 | still_open | brain.mjs:6984-6990 in cmdUpgrade is unchanged and still states the cause: 'recorded schema N is below ledger maximum M. An older CLI lowered the recorded value. This brain update will repair and verify it; ...'. The doctor-side text at brain.mjs:5683 already says 'may have lowered', but the update text was not changed. The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-18\probe.mjs), runs the real cmdMigrate, interrupts it after 0052, then reruns the real cmdUpgrade. Results: 'ledger max after phase1: 52', 'recorded schema still: 48', and warnings ['recorded schema 48 is below ledger maximum 52. An older CLI lowered the recorded value. ...']. | Reword it to name both possible causes (an interrupted update or an older CLI), or name the cause only when an upgrade_runs 'failed' row proves it. Add a test case in test/fix-update-0419-ledger.test.mjs. |
| C1-19 | fixed | operations/brain-lifecycle-lock.mjs:97-103 adds busyRetryInstruction(retryCommand). It returns 'then run <retryCommand> again.' only when a caller passed one; otherwise it returns 'then run the same command again.'. The internal operation name is no longer put after 'brain'. Callers pass real CLI forms: brain.mjs:20726 'brain disconnect anthropic <manifest>' and brain.mjs:31556 'brain update <manifest>'. holderStatus at brain-lifecycle-lock.mjs:433-437 says 'That process is still running.' only when the holder is this same process instance. A live PID that cannot be confirmed now gets 'A process with that ID is running, but this computer could not confirm it is the same one.'. A dead PID gets recovery-window text, and a stale live holder gets restart guidance (:441-447). crash() at brain.mjs:24614-24618 now prints the lock message instead of the internet-drop text, and cmdUpdate maps busy to UPDATE_BRAIN_BUSY (brain.mjs:31565-31571). Probe C:\offload\review-0419-final-scratch\c1-11-20\c1-19\probe2.mjs against the final head: an answer-setup contender gets '...That process is still running. Wait for it to finish, then run the same command again.'. With retryCommand it names 'brain disconnect anthropic <manifest>' or 'brain update <manifest>'. A live other PID gets '...could not confirm it is the same one...'. Focused test 'busy lock copy uses a caller-supplied retry action and qualifies an unknown holder' passes, and test/brain-lifecycle-lock.test.mjs passes 11/11. | The optional local-time display of created_at was not done: the message still shows an ISO UTC time and the internal holder name ('held by daily-refresh'). The retry text contains a literal '<manifest>' placeholder. These are cosmetic, not part of the defect. |
| C1-20 | still_open | diagnoseChecksumDrift's catch (brain.mjs:21286-21291) still returns {checked:false, reason} for MigrationLedgerValidationError, exactly as it does for a transport failure. buildChecksumDriftCheck still maps every checked:false to D_WARN 'not checked: <reason>' with no fix line (brain.mjs:21476-21477). The C1 probe, repointed at the final head (C:\offload\review-0419-final-scratch\c1-11-20\c1-20\probe.mjs), gave these results. gapAt0049 {checked:false, reason:'the migration ledger has a gap at 0049'}. unknownRow {checked:false, ...0099}. renamed0048 {checked:false, ...}. transport {checked:false, reason:'could not read schema_migrations: fetch failed'}: the same shape. The closing line is 'checkup complete (1 optional item(s) not set up)'. | Return a distinct invalid marker for MigrationLedgerValidationError. Map it to D_FAIL 'brain update will refuse this ledger' with a technician-review fix line, and keep D_WARN only for read failures. Add a doctor test for a ledger with a gap. |

C1 follow-up notes: The final head is one commit, 5d8f804d. It touches brain.mjs, the lifecycle-lock module, the answer-setup files, support-recovery.mjs, the runbook and tests. acceptance.mjs, worker/, operations/claude-workspace.mjs, components/, CHANGELOG.md and docs/ have no diff since f8a7cd05, so C1-2, C1-5, C1-6, C1-7, C1-9 and C1-10 are unchanged. Status: 2 fixed (C1-1, C1-8), 1 partly fixed (C1-3), 7 still open. None regressed or became not applicable.

On the store owner's path (built-in model, schema 48, no answer-setup journal), the open items do not fire. C1-1 and C1-8 are the ones that apply to that update, and both are fixed. C1-5 applies only if the owner uses the hosted app connector.

Read before sealing: test/fix-0419-partner-r1.test.mjs exits 1 on this Windows host, with 9 of 20 tests failing. The cause is environmental: the darwin/linux iterations call the POSIX mode-bit check (operations/brain-lifecycle-lock.mjs:114-118), and that can never pass on NTFS. The file is in the unfiltered TEST_COMMANDS list (scripts/run-test-chain.mjs:304, 768), so a Windows test chain will likely stop there.

Probes run: lock probe with a real separate holder process; real CLI update against a held lock (120 s, isolated environment and lock root); acceptance tierRetrieval with contract-valid think shapes; unreviewed-model update and disconnect; half-run journal connect, update and disconnect. Focused tests run: brain-lifecycle-lock (11/11), answer-setup-copy (5/5), acceptance-answer-model (4/4), fix-0419-partner-r1 (11/20, environmental).

All scratch files are under C:\offload\review-0419-final-scratch\c1check\. `git status --porcelain` in C:\offload\review-0419-final is empty after the run. Nothing touched network, Cloudflare, keys or a real Brain.

C1 follow-up notes: Scope: diff f8a7cd05..5d8f804d, one commit (5d8f804d, 'Release fixes: lifecycle lock rule, busy messages, safe half-run guidance'). Code changed only in brain.mjs, operations/answer-setup.mjs, operations/answer-setup-copy.mjs, operations/brain-lifecycle-lock.mjs, support-recovery.mjs and the runbook. Result: only C1-19 is fixed. C1-11 through C1-18 and C1-20 are still open in the final head, unchanged from C1 except as noted (C1-11's HALF_RUN line and C1-16's half-run sub-case are incidentally affected by the new half-run guards; the main defects remain). Every status was rechecked by running the C1 verifiers' probes, repointed at C:\\offload\\review-0419-final, from copies under C:\\offload\\review-0419-final-scratch\\c1-11-20\\. I also wrote one new lock probe, c1-19\\probe2.mjs. No network, no keys. The checkout stayed clean (git status empty, HEAD 5d8f804d). Not done: the C1-12 probe injects a deploy that calls the real persistWorkersDevDomain. That deploy is not cmdDeploy itself, which needs Cloudflare, so the cmdDeploy persist path (brain.mjs:3215) was checked by reading the code only. Side note for the orchestrator, not a C1 status: running test/fix-0419-partner-r1.test.mjs (newly added to both test chains) in this Windows checkout gave 11 pass and 9 fail. 7 failures are 'the local Brain lifecycle lock is not private' in tests that simulate darwin/linux on a Windows host, where chmod 0700 cannot clear mode bits. 2 failures are mutant-anchor assertions, probably because this checkout uses CRLF line endings (core.autocrlf=true). Both look environmental, but the Windows test chain may hit the same failures.

## Coverage by area

### lock-rule

Checked: the full lock-module diff against f8a7cd05 and against the 0.4.18 release (a85f5649). The final rule is the 0.4.18 semantics (live = busy; dead or self-PID = reaped only when stale), plus a random per-process instance, a retryable 'being acquired' for an empty fresh directory, and new messages.

Mixed versions: a 0.4.18 contender never takes over a live 0.4.19 holder, and 0.4.19 never takes over a live 0.4.18 holder. Only C1-era (f8a7cd05/52a36e11) code would steal a 0.4.19 lock: its two-sided start-identity check reads 'process-lifetime:' as a mismatch. That matters only on a machine whose daily task is registered from a C1-era kit (a rehearsal replica), not an owner on 0.4.18.

Mutual exclusion:
- A live holder cannot lose the lock to new code. Takeover needs a stale record (no heartbeat for 30 min; the heartbeat runs every 10 s) plus a dead owner: ESRCH from process.kill(pid,0), or the contender's own PID with a different instance.
- The largest synchronous child timeout in brain.mjs is 600 s, so a live update cannot look stale.
- Two reclaimers cannot both hold the lock: each unlinks the old owner's specific filename, and rmdir only succeeds on an empty directory.
- A theoretical double owner from two contenders reaping the same stale empty directory exists only in microsecond windows. It is pre-existing, and assertOwned or readOwner would then refuse.
- CURRENT_PROCESS_INSTANCE loads once per process: the daily runner and brain.mjs resolve the same module URL.

Real-process probe on this Windows host (C:\offload\review-0419-final-scratch\focus1-lock\probe.mjs): live fresh = busy; live with a +2h clock = busy with restart text; killed child (dead, fresh) = busy; dead with a +31 min clock = acquired; clean exit = released.

Callers checked: update (120 s wait; errors mapped to UPDATE_BRAIN_BUSY / UPGRADE_FAILED), load, ingest, daily-refresh (busy and recovery_required are deferred), schedule install/remove, answer-setup connect and disconnect, QuickBooks schedule and desktop. Nothing inside cmdUpdateWithPrompts or cmdUpgrade takes the lifecycle lock again, so the wait loop cannot re-run a partly executed update. The crash() lock branch now stops busy errors from being reported as a dropped internet connection.

Pre-existing gaps outside this diff, not reported as findings:
- `brain ingest-file --apply` and provenance target repair take only the source-ingest lease (brain.mjs:11037). They skip the lifecycle lease and the recovery fence, which breaks source-ingest-lock.mjs's own lifecycle-first contract. The Worker's paused-write barrier ('brain corpus writes are paused for a verified upgrade or rollback') covers the migration window.
- `brain upgrade` (cmdUpgradeInteractive) calls cmdUpgrade without the lifecycle lock.

Tests: test/brain-lifecycle-lock.test.mjs passed 11/11 here. test/fix-0419-partner-r1.test.mjs failed 9/20 here (finding 2).

Not checked: Worker code, migrations 0049-0056, the full chain, any real Brain or Cloudflare, and the source-ingest lock's own reclaim rules. The review checkout was left unmodified (git status clean). Probes and scratch files are under C:\offload\review-0419-final-scratch\focus1-lock\.

### busy-messages

What I checked: the full diff f8a7cd05..5d8f804d for brain.mjs, operations/brain-lifecycle-lock.mjs, operations/answer-setup.mjs, operations/answer-setup-copy.mjs, support-recovery.mjs, the runbook line, run-test-chain.mjs and test/fix-0419-partner-r1.test.mjs. I also read the surrounding code the diff relies on:
- every withBrainLifecycleLock/withBrainLifecycleLockWait caller in brain.mjs, plus quickbooks-schedule and daily-refresh-run deferral handling
- crash() and the main Fatal catch
- supportErrorCode, printSupportReceipt, the UPDATE_BRAIN_BUSY/UPGRADE_FAILED/INTERNAL_ERROR catalog entries and renderCliCommands
- cmdConnect, cmdConnectAnthropic and cmdDisconnectAnthropic, plus runAnthropicAnswerSetup's journal and rollback flow
- the HALF_RUN users in doctor.mjs and in the health path (brain.mjs:4297)
- the update daily-transaction and recovery-fence paths, for brain_lifecycle_* errors the new cmdUpdate catch would remap

Probes, all scratch files in C:\offload\review-0419-final-scratch\focus2, run against real processes on this Windows host:
- a live separate holder process, then the same holder killed, checked against both the final and the f8a7cd05 lock modules (the C1 module reclaimed the dead holder at once; the final one held it for 30 minutes)
- cmdUpdate's busy path end to end, including its support code and rendered explanation
- a concurrent cmdConnect anthropic with a live journal
- support classification of lock errors, by command
- simulated platform acquisition on Windows

Focused tests: test/brain-lifecycle-lock.test.mjs passes 11/11. test/fix-0419-partner-r1.test.mjs fails 9/20 here (finding above). The review checkout is unmodified (git status clean).

What looks sound:
- The cmdUpdate and cmdDisconnectAnthropic catches now keep the holder message instead of the network-drop text.
- The crash() lifecycle branch is ordered before the retryable/network branch.
- busyRetryInstruction rejects multi-line or oversized commands.
- The answer-setup lock call falls back to \"run the same command again\" (true).
- The update journal check runs inside the lifecycle lock.

Not checked:
- Whether the 0.4.15-era owner files on the owner's machine parse under schema_version 2.
- Whether rmdir-after-unlink can leave an empty lock directory on Windows. If it can, that directory shows the \"being acquired\" message for up to 30 minutes.
- The wait loop retries the whole update task when a brain_lifecycle_busy is thrown from inside it. I saw no inner caller that throws it.
- The Windows gate in C:\offload\wl, which I did not touch.

### answer-setup-journal

Checked: every hunk in f8a7cd05..5d8f804d, focusing on operations/answer-setup.mjs and answer-setup-copy.mjs, the brain.mjs connect, disconnect, update and crash changes, support-recovery.mjs, and the runbook line. I traced:
- what the journal records and its write and remove points (written before the manifest edit; removed on success, transient or confirmed rollback, or by disconnect);
- every reader: five HALF_RUN sites, presence checked with lstat in connect and update and with existsSync elsewhere, and nothing parses the journal;
- the rollback within a single run for each failure class, with and without a stored key and with rerank;
- crash points: there are no signal handlers, so Ctrl-C or a closed window leaves the journal and the lifecycle lock, and the new lock rule makes the next command wait the 30-minute recovery window;
- key-exposure surfaces: journal contents, error and cause text (cf error text excludes request bodies, and putSecret errors are swallowed), JSON receipts, and the support journal. No key reaches disk or output.

Ran focused tests from scratch: answer-setup-copy and anthropic-connect pass 41/41; fix-0419-partner-r1 passes 11/20 on Windows (finding 6). Probes are in C:\offload\review-0419-final-scratch\focus3: probe-halfrun-clipboard.mjs and probe-deadlock.mjs. The checkout stayed clean (git status empty).

Not reported, lower confidence or outside this focus:
- `brain upgrade`, `brain deploy` and `brain secrets` do not check the journal; only `brain update` does.
- If putSecret fails after Cloudflare actually applied the write, the key is orphaned while the copy says \"Nothing was changed\". It self-heals at the next update, because reconcileWorkerProviderSecrets removes it for a built-in manifest.
- An interrupted disconnect is not journaled: the manifest says built-in while the Worker still answers with Claude until disconnect is rerun.
- Lifecycle lock (another focus): this diff removed the process start-time identity, so on Windows a dead holder whose PID has been reused, including by a protected system process because EPERM counts as alive, is never reaped. The owner gets \"restart the computer\" guidance. This looks deliberate, but it can repeatedly block update after an interrupted connect.

Not verified: real Cloudflare or Worker behavior, Windows clipboard history, or the live update.

### windows-health-test

Scope: the health and Windows parts of f8a7cd05..5d8f804d. That is test/health-verify-exit.test.mjs (+249 lines) and the code it relies on: test/helpers/cli-test-environment.mjs, test/fixtures/cli-side-effect-tripwire.mjs (the new installed symbol), cmdHealth (brain.mjs:3994-4330), resolveAdminKey (24554), recordSupportFailure (690), support-journal.mjs secureDirectory and the Windows ACL path, operations/current-user-file.mjs, operations/cli-guidance.mjs, operations/command-display.mjs, operations/answer-setup-copy.mjs, and the TEST_COMMANDS placement in scripts/run-test-chain.mjs.

What I ran, all on this Windows PC, read-only against C:\offload\review-0419-final (git status is clean afterwards):
- The unmodified test: 29 pass, 38 fail. Every failure is an expected-exit-1 scenario that got exit 86.
- A probe that captured the blocked call's stack: icacls.exe called from the support-journal ACL step.
- A scratch copy that allows only icacls: 67/67 pass.
- A scratch copy that adds only the existing support-journal-acl-preload fixture: 67/67 pass, with the tripwire intact.
- A PowerShell argv probe of the rendered HEALTH_NEXT_STEP for a 'Financial Brain' path: the path splits into two arguments.
Scratch files are in C:\offload\review-0419-final-scratch\focus4-health\.

Checked and found sound:
- The child isolation guard: ADMIN_KEY is unset at spawn and is injected by the preload from the isolated file. The adapter refusal hooks and all four isolation probes pass on Windows.
- realpathSync.native on mkdtemp handles 8.3 and short TEMP paths.
- Number formatting is pinned to en-US, so OS locale cannot break the 84,075 assertions.
- The in-process darwin and win32 platform-override seams restore process.platform.
- The parent and child prefix rendering match when the test runs from a git checkout. Tests do not ship in package.json files, so the brain.cmd shim branch is not reachable from this test.

Not covered by this test, and I did not report it as a defect because the test does not claim it:
- The real Windows admin-key read (DPAPI file via PowerShell) is never exercised. The child always gets ADMIN_KEY from the preload, the same as at the baseline.

Outside FOCUS 4, noted only:
- brain.mjs:4297 still calls HALF_RUN(manifestPath) with one argument. It therefore always shows the stored-key wording, even when the journal recorded secret_name_existed === false. This fails safe, not as data risk.

Not checked:
- Behaviour on macOS hosts.
- Defender or OneDrive timing flakiness. I saw nothing concrete beyond older leftover brain-health-verify-exit-* folders in %TEMP%, dated before this review.

### rest-of-diff

Scope: the single commit 5d8f804d, 16 files. I checked every changed non-test file: brain.mjs (the new imports, the early half-run check in cmdConnect, cmdDisconnectAnthropic's retryCommand and error mapping, the lifecycle branch in crash(), the journal guard in cmdUpdateWithPrompts, and the busy/UPGRADE_FAILED mapping in cmdUpdate), operations/answer-setup.mjs (answerSetupNeedsRecovery and the ROLLBACK_INCOMPLETE argument), operations/answer-setup-copy.mjs, support-recovery.mjs, onboarding/06-runbook-top-ten-failures.md, scripts/run-test-chain.mjs, and operations/brain-lifecycle-lock.mjs (read for data-safety interplay only; its rule design is another reviewer's area).

The diff touches no worker/ code, no migrations (0049-0056 are unchanged), and no manifest writer except through existing answer-setup paths. I followed the surrounding code: the cmdUpgrade staged catch, so lifecycle errors inside staged work become Fatal with recovery text and do not hit the new mapping. I also followed the daily-transaction error path in cmdUpdateWithPrompts, the daily-refresh-run busy/deferred handling (unchanged), reconcileDailyDefinitionAfterManifestEdit (no nested lock), compatibility with 0.4.18 owner files (same schema_version 2 and created_at, so the 0.4.19 contender reads them), and the main Fatal handler.

For this owner's 0.4.18 to 0.4.19 update: answer setup first exists in 0.4.19 (commit 72e47136, after Release 0.4.18 a85f5649), so the new journal guard cannot fire. Its non-ENOENT throw also cannot fire on a normal folder. I found no change in this diff that can change or lose owner data during the update or the daily refresh.

Two observations for the lock reviewer, not filed here. First, a lock left by a Ctrl+C'd or closed-window update (there is no SIGINT or SIGHUP release) now blocks a rerun for up to 30 minutes after the last heartbeat; the C1 code reaped a dead owner immediately. Second, a live PID is never reaped, so PID reuse after a killed daily run keeps daily imports deferred until a reboot.

Tests run (focused only): answer-setup-copy and anthropic-connect pass 41/41; brain-lifecycle-lock passes 11/11; fix-0419-partner-r1 fails 9/20 on this Windows host, as reported. Probes and scratch files are in C:\offload\review-0419-final-scratch\focus5\. The review checkout was not modified.

### completeness critic

I found no new P0 or P1 defects that the five reviewers missed. The range f8a7cd05..5d8f804d is one commit. Its production changes are 63 lines in brain.mjs plus operations/brain-lifecycle-lock.mjs, operations/answer-setup.mjs, operations/answer-setup-copy.mjs, support-recovery.mjs, one runbook line and the test-chain list. The reviewers read every one of those hunks. Below is what I checked in the gaps between their areas, and what I looked at but decided not to file.

What I checked (read-only against C:\offload\review-0419-final; git status is still clean):
- **Users of the lock module outside brain.mjs:** operations/daily-refresh-run.mjs, quickbooks-schedule.mjs and daily-refresh-scheduler.mjs (the recovery fence and update transaction). None of them passes the removed `processInstance` option, and none reads `process_instance`. `processStartIdentity` has no production caller any more, so the change from `epoch:` to `posix:` is dead code with no effect. Both the daily runner and quickbooks-schedule defer only on busy or recovery_required. No other module reads the lock directory (%ProgramData%\FinancialBrain\locks).
- **Nested locking:** I checked again whether anything inside update, connect or disconnect takes the lifecycle lock a second time. If it did, `withBrainLifecycleLockWait` would rerun a partly finished update. Nothing does:
  - `reconcileDailyDefinitionAfterManifestEdit` takes no lock.
  - QuickBooks re-registration from update passes `lifecycleLockHeld: true`.
  - `cmdDeploy` takes no lock.
  - Nothing outside the lock module creates an error with code `brain_lifecycle_busy`.
- **Lock left behind by a refusal:** `die()` throws a `Fatal` and does not exit, and the lock module registers `process.once('exit', release)`. So the new HALF_RUN refusal inside the update lock, and every other refusal inside a lock, releases the lock. Only a signal, a closed window or a kill leaves it behind, which the reviewers already reported.
- **New CLI against the older Worker:** the diff touches no Worker code, migrations or Worker calls. The connect half-run check and the update half-run check are local only. The owner's update from schema 48 runs through the new `retryCommand`, the half-run check and the catch in `cmdUpdate`. Everything after that is unchanged, and the owner cannot have an answer-setup journal on 0.4.18.
- **Docs and skills:** I searched onboarding/, skills/financial-brain-technician/SKILL.md, docs/, the README, AGENTS.md and templates for disconnect, half-run, lock, busy and restart guidance. Nothing outside the reviewed files tells an operator to remove a stored key or delete a lock.
- **Test changes:**
  - The anthropic-connect test now uses dashboard mode, so it no longer checks clipboard clearing; reviewer 3 already reported the clipboard issue.
  - Updated assertions in the tripwire, doctor-cli-isolation, support-recovery and daily-refresh tests.
  - The test-chain invariants: 172 legacy commands plus the post-launcher projection.
- **Partner test on Windows:** I ran test/fix-0419-partner-r1.test.mjs once on this host and got the same 9 of 20 failures. Seven fail because a simulated darwin run on Windows hits the POSIX privacy chmod check (`brain_lifecycle_unsafe`). Two are mutant tests that cannot find their text anchor in the source files. These are test-only causes, and the failure is already reported. Output is in C:\offload\review-0419-final-scratch\completeness\partner-r1.txt.

Not filed (lower impact, outside this diff, or the same root cause as an existing finding):
1. **Another way past the update journal guard:** `brain doctor <manifest> --repair --yes` (brain.mjs:31637-31644, then cmdDoctorRepair:21220) runs cmdUpgrade with no lifecycle lock and no answer-setup journal check. onboarding/06-runbook-top-ten-failures.md (around lines 690-705) tells operators to run it for a paused update. It only runs when D1 shows the Brain paused, so it can only meet a half-run journal after an earlier bypass. That makes it P3, with the same cause as reviewer 5's `brain upgrade` finding. If that finding is fixed by putting the guard only in cmdUpgradeInteractive (28664), this route stays open. The guard belongs inside cmdUpgrade.
2. **Correction to the lock reviewer's mixed-version claim:** the 0.4.18 contender (a85f5649) treats an owner as the same process only if `live && (!stored || !observed || stored === observed)`. The new `process-lifetime:` record never equals the `win32:<ticks>` value that 0.4.18 observes, so a 0.4.18 contender would take over a 0.4.19 holder that is still alive but has gone 30 minutes without a heartbeat. The C1 record (`epoch:`) had the same mismatch, so this diff did not introduce it. It also needs the heartbeat to stall for 30 minutes while a 0.4.18-kit task runs during the update, and the update pauses the daily task. Not filed.
3. **Runbook says the wrong thing about killed commands:** the "interrupted source locks" section (around runbook line 904) says a killed connect or ingest "recovers it immediately" once the process is proven gone. After this diff, the lifecycle lock those commands take first holds a dead owner for up to 30 minutes. This is a P3 wording mismatch that comes with the 30-minute block the reviewers already reported. The runbook still says never to delete a lock, so following it is not unsafe.
4. **Empty lock folder after a failed Windows delete (P3):** if the file delete on release is still pending on Windows (another process has the owner file open), the folder delete can fail. The empty folder then shows "being acquired" for 30 minutes. Before this diff the same situation gave an "unsafe" refusal, so this is not a regression.

Not checked: real Windows sleep or hibernate timer behavior, the actual daily-task command line and kit layout on the owner's machine, the Worker and migrations 0049-0056 (unchanged in this diff), and the full test chain. I did not touch C:\offload\wl.

## Limits

Offline review only. No live Anthropic, Cloudflare or real owner machine behavior was exercised, and no full test chain was run by the reviewers. Focused tests and probes ran on a Windows host from a read-only worktree, which stayed unmodified. Line numbers refer to 5d8f804d.

LANE REVIEW-0419-FINAL-PARTNER: READY (review complete; 25 confirmed: 7 P2, 18 P3; 0 at P0/P1)
