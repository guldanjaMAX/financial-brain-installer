# UPDATE-010 evidence: exact package publication only after every gate

**Incident:** UPDATE-010. **Tested package:** `brain-installer-0.4.0.tgz`,
sha256 `bd6e02082aece9ae642dbe216da0b96ef68b399876a7707567f6d36b0c0cb3df`,
5,499,693 bytes, built by CI from tagged commit
`3fdf98e6c32a5459330e020a0c9ade75d6a078fe` in run `34123656784`.
**Evidence date:** 2026-09-07.

The acceptance text, clause by clause, against what was observed.

## Before publication

**One tested package.** Every OS lane in run `34123656784` downloaded the
single artifact the `build one exact package` job produced (artifact id
`10019217280`) and verified it by digest before any step touched the bytes.
The Windows Node 22 lane log reads
`verified brain-installer-0.4.0.tgz at sha256:bd6e0208…` ahead of extraction.
The package sealed into the supervised field kit is byte-identical to that
artifact; the kit receipt records the same digest and byte count.

**Six completed OS/Node jobs.** Windows, macOS and Ubuntu on Node 22 and 24,
all green on the tagged commit. Stated plainly: `windows-latest / node 22`
failed on its first attempt on a Playwright `locator.waitFor` timeout in
`frontend/test/browser/document-access.browser.mjs`, while `windows-latest /
node 24` passed the identical test in the same run and the preceding browser
suite passed 15 of 15 on the failing lane. A re-run of only that job passed.
That is a flaky browser test, not a package defect, and it is recorded rather
than smoothed over.

**Planted traps.** The `preflight-traps` job is green on the tagged commit.

**Reviewed field evidence.** One real installation (run A in
`v0.4.0-field-findings-2026-09-07.md`) completed the full update on this exact
package: migrations 0023 through 0035 applied and each confirmed individually,
schema 22 to 35, the stranded projection fence cleared, acceptance suite 26 of
26, new-shell `health` and `doctor` both exit 0, a supported question answered
with a citation and a gaps array, an unsupported question declined with a null
answer and an empty citation list. Pause wall time 46 m 29 s measured from
outside. That run was performed by the operator on a physical Windows x64
machine and reported in writing with counts, not adjectives.

**Immutable releases enabled.** Enabled in the repository settings on
2026-09-07. The `release.yml` workflow additionally verifies the immutable
flag before it will publish.

**A verified enforcing workflow.** `release.yml` looks a release up by listing
and matching, not by tag (the by-tag endpoint cannot see drafts), requires
exactly one match, and refuses to publish while the incident audit fails.
`scripts/test-release-workflow-contract.mjs` pins those properties and passes.
The workflow demonstrated enforcement on this very release: on the tagged
commit it refused to publish 0.4.0, before any release write, so no draft or
partial release exists.

**No release before CI finishes.** The `publish` job depends on CI completing.
This is the specific failure v0.3.6 had, where publication preceded CI by
about a minute and the six-job gate was never consulted; the dependency now
makes that sequence impossible.

## After publication

**Verify immutable tag and asset bytes before URL promotion.** Not yet
exercised, because no publication has occurred. The site's `verify-release`
gate (`financialbrain-site/scripts/verify-release.mjs` and its tests) refuses
to promote a release URL unless the GitHub release is immutable and the
downloaded asset's bytes and digest match the recorded values. That check runs
at promotion time and is the closing half of this incident.

## What this does not prove

Windows ARM64 (UPDATE-012, deferred) and live bank acceptance (UPDATE-022,
deferred) are not covered by this package or this run. The after-publication
clause is enforced by tooling but has not yet been executed against a real
release.
