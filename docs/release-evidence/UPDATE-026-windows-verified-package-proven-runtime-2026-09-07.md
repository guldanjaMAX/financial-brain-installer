# UPDATE-026 evidence: Windows release evidence from a verified package on a proven runtime

**Incident:** UPDATE-026. **Tested package:** `brain-installer-0.4.0.tgz`,
sha256 `bd6e02082aece9ae642dbe216da0b96ef68b399876a7707567f6d36b0c0cb3df`,
built by CI from tagged commit `3fdf98e6c32a5459330e020a0c9ade75d6a078fe` in
run `34123656784`. **Evidence date:** 2026-09-07. **Sources:** the CI run's
raw lane logs, and run A in `v0.4.0-field-findings-2026-09-07.md`.

The acceptance text, clause by clause.

**Every Windows lane must start the main test chain rather than failing on
command-line length.** Both Windows lanes (`windows-latest / node 22` and
`windows-latest / node 24`) started and ran the full chain in run
`34123656784`. The chain is invoked through `scripts/run-test-chain.mjs`
rather than as one shell line, which is what removed the length failure.

**No step that installs or runs the packaged bytes may execute unless the
exact-package checksum step succeeded.** In each lane the artifact download
step verifies the digest and exports `TARBALL` only on success; the lane log
reads `verified brain-installer-0.4.0.tgz at sha256:bd6e0208…` before the
packaged preflight is extracted, and every later packaged step consumes that
variable. A digest mismatch leaves `TARBALL` unset and the packaged steps
cannot run.

**Continuation after an unrelated source test failure must be preserved.**
The lanes run `npm test -- --continue-on-failure`, and the chain runner
reports each command's own exit status at the end rather than stopping at the
first failure. Demonstrated in the negative on the macOS lanes of an earlier
commit (`8c074f8`), where the architecture assertion failed and the chain
still ran to completion and reported the individual failing commands.

**Assert runner architecture and Node platform, architecture and major before
install.** This is the change in the tagged commit itself. Each lane prints a
`RUNTIME {...}` record and asserts `runner.arch` against a per-OS expectation
(`X64` on Windows and Ubuntu, `ARM64` on macOS) and Node's platform, arch and
major before any install step. The earlier form of that assertion demanded
X64 everywhere and failed both macOS lanes, which is how the per-OS table was
arrived at rather than assumed.

**Feed every lane from one exact artifact.** All six OS/Node lanes downloaded
artifact id `10019217280` from the single `build one exact package` job and
verified the same digest. The field kit sealed for run A carries those exact
bytes, and run A's operator verified both the outer archive and the inner
package by digest before installing.

**Diagnose the Node 22 first-install timeout from the sanitized diagnostics
before changing any timeout; correlation with an npm or Node version is not a
cause.** Two distinct things were observed and are kept apart here.

- The planted first-install timeout trap fired in the Windows Node 22 lane and
  emitted its sanitized `PACKED_NPM` diagnostic as designed: stage
  `initial_install`, `elapsed_ms` 267 against `timeout_ms` 250, `SIGTERM`,
  `ETIMEDOUT`, npm log files reported by byte count and digest only,
  `refused_files: 3`, completed stage timings, and prefix progress counts.
  Nothing in that record identifies the machine or the user. No timeout
  constant was changed in response.
- The lane's one real failure was unrelated to install: a Playwright
  `locator.waitFor` timeout in `document-access.browser.mjs`, on a lane where
  the Node 24 twin passed the identical test and the preceding browser suite
  passed 15 of 15. It was diagnosed from the log as a flaky browser test, a
  single-job re-run passed, and no version was blamed.

**The all-ref history privacy gate remains a separate release blocker and
must not be waived.** The `public git history zero findings` job is green on
the tagged commit and every other job depends on it. It runs with
`--require-clean`, which consults reviewed credential dispositions and still
refuses any privacy finding or unreviewed credential. The gate was not
weakened to reach green; the release workflow separately refused to publish
0.4.0 on incident evidence, which shows the two gates are independent.

## Field confirmation on a physical Windows machine

Run A installed this package on a physical Windows x64 host from the sealed
kit: both digests matched, `brain.cmd --version` printed `0.4.0` and exited 0,
migrations 0023 through 0035 applied, and the update completed. Two runbook
defects surfaced on that host (install prefix not on PATH; browser sign-in
discarded from an unwritable working directory) and are recorded in the
findings document as operator-sheet fixes, not package defects.

## What this does not prove

Windows ARM64 (UPDATE-012) is deferred and unclaimed. The hosted runners are
x64; run A's host was x64. Nothing here speaks to ARM64.
