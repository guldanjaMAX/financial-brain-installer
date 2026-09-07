# ADR 004: The incident release gate is scoped to the version being cut

- Status: Accepted
- Date: 2026-09-06
- Owners: Product and engineering
- Confidence: High on the mechanism, medium on the undeferrable set
- Supersedes: None

## Problem

`scripts/audit-updates.mjs --release` held every release until every incident in
`docs/update-incidents.json` reached `verified`. The registry holds 26
incidents, none verified, and their acceptance texts correctly demand real field
evidence: a physical Windows ARM64 host, live bank institutions, an approved
production pilot, a disposable restore rehearsal. No release can satisfy all of
that, so the gate could never go green for any version.

An unsatisfiable gate is not a strict gate. It is one people learn to bypass.
v0.3.6 was published 69 seconds before its own CI reported failure, and a
partner audit then found 22 defects. The gate did not stop the release; it
taught somebody that gates are the sort of thing you get past.

The ownership boundary at stake: who may decide that a release ships without
field proof of a given capability, and what that decision has to look like.

## Options considered

1. **Leave it unsatisfiable.** Keeps the strictest wording. Rejected: it is the
   status quo that produced the v0.3.6 bypass, and a rule nobody can obey is
   enforced by nothing.
2. **A separate reviewed declaration file**, mirroring
   `privacy/credential-dispositions.json` and `evaluateStrictRelease`. Honest
   idiom, and it carries a version, an author and a date naturally. Rejected as
   the base because the excuse then lives several hundred lines away from the
   acceptance text it excuses, it reintroduces the "names an id that does not
   exist" failure class that must then be checked for, and it needs its own
   entries in `package.json` files and the package privacy allowlist, each a
   place to forget.
3. **A `deferral` object on the incident row** (chosen). The excuse sits in the
   same JSON object as the acceptance text it argues against, in the same diff
   hunk. The stale-id class is structurally impossible. One file stays honest,
   and it is already reviewed, validated, packaged and privacy-scanned.
4. **A `deferrable: false` flag per incident.** Rejected: the same person could
   flip it in the same pull request that adds the deferral, so it enforces
   nothing on its own.
5. **A cap on the number of deferrals.** Rejected: arbitrary numbers get bumped,
   and the bump looks exactly like the deferral.

## Decision

An incident blocks a release unless it is `verified` or carries a current, well
formed, permitted `deferral` naming the exact `package.json` version. The
deferral requires a closed-enum `blocked_on` describing why the evidence cannot
yet exist, plus required `reason` and `unproven` prose. It never changes a
status and never means verified. Deferred incidents print in full, and again in
the "This release does NOT cover" block that goes into the release note.

UPDATE-010, UPDATE-014 and UPDATE-026 cannot be deferred at any version. Their
acceptance is a property of the release mechanism rather than of a feature:
what gets published, whether the published bytes are the tested bytes, and
whether a brain reports its own versions honestly. Deferring one of those does
not defer evidence about the product, it defers the ability to trust any other
deferral and any receipt.

## Consequences

- Easier: a release can now ship with a named, published, expiring gap instead
  of being blocked forever by evidence that cannot be collected this quarter.
- Harder: bumping the version invalidates every deferral at once, so each is
  re-declared in a diff at the moment the new version is cut. That friction is
  the mechanism.
- Newly required: the release note carries the audit's "does NOT cover" block.
- Explicitly unsupported: deferring for time, risk appetite, CI flakiness or a
  scheduled-but-unrun rehearsal. There is no enum value for any of them, and
  adding one is a reviewed code and test change.
- Required alongside: `verified` had to be tightened in the same change. It was
  the cheaper and quieter route past the same gate (one word plus any existing
  path, including a local test or the registry itself, and it printed nothing),
  so scoping deferral alone would have moved traffic onto it. Evidence is now a
  document under `docs/` that is not part of the rulebook, names its incident
  and carries a tested package digest, and every closure prints in the receipt.
- Newly required: an incident whose acceptance is about the release mechanism
  must be added to `UNDEFERRABLE_INCIDENTS` when it is opened. The set is a
  manual list and does not grow by itself.
- Not defended against: a maintainer with commit rights writing a plausible but
  false reason, or a fabricated evidence document that satisfies every
  mechanical rule. The change converts a silent, unattributed, permanent filter
  edit into a written, version-scoped, published claim that expires. It does not
  claim more.
- Attribution stays in git. A human name in the file would fail the package
  privacy gate, which UPDATE-026 says must not be waived.

## Verification

`test/update-audit.test.mjs` pins all six properties and the negative cases: a
stale deferral fails, a missing reason fails, a version mismatch fails, an
undeferrable id carrying a deferral fails, an unknown key inside the object
fails, and a new incident blocks by default. `UNDEFERRABLE_INCIDENTS` is
asserted byte-exact with its reason in the assertion message, and the audit
fails if the constant names an incident absent from the registry. The declared
0.4.0 scope is checked against the live registry in the same file. Rollback is
deleting every `deferral` object, which returns the previous behaviour exactly,
because `releaseBlockers(cases)` with one argument is unchanged.

## Revisit when

- A deferral is renewed across three consecutive versions with the same
  `blocked_on`. That is no longer a scoped gap, it is an unsupported platform or
  capability, and it should be said in the product surface rather than tracked
  as a pending incident.
- Any deferral is found to have been written for a reason that was not true. The
  mechanism assumes good faith in the prose and has no defence if that fails.
- The undeferrable set needs a fourth member, or UPDATE-014 is argued out of it.
  UPDATE-014 is the arguable one: it is about the product telling the owner the
  truth rather than about the publication pipeline. It is included because
  release gate sections 3, 7 and 10 all read a version from a running brain and
  believe it.
