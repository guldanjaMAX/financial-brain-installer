# Update and recovery audit

From a maintainer source checkout, the release gate is `npm run audit:updates`.
Regression fixtures require the maintainer source checkout; the installed package is not the audit execution environment.
A green unit suite does not clear
this gate. `docs/update-incidents.json` retains the original F1-F16 and N1-N6
findings and subsequent field incident classes. Each has an explicit fresh,
upgrade or recovery scope, reproduction/acceptance requirement and disposition.
No customer identities, messages, account IDs, credentials or private logs belong
in this repository. Keep the source-message crosswalk in the private work folder.

Bank connections are a core release boundary. Follow [Plaid release gate](PLAID-RELEASE-GATE.md)
and retain UPDATE-017 through UPDATE-022 in the same mechanical release gate.
An installer upgrade must preserve bank credentials, account ownership,
transaction history and interrupted sync state. General bank invitations require
the deployed owner journey and a separately approved production pilot.

## Required sequence for every candidate

1. Review newly authorized support evidence, email reports and technician
   messages before changing an incident's status. Record the search date,
   coverage and inaccessible sources privately. A promise of a fix is not a
   recovery receipt. Never contact the client automatically.
2. Reconcile the package digest, actual executable and prefix, manifest version,
   deployed Worker version and D1 product/schema version independently. Preserve
   discrepancies until explained. Match account IDs, not similar display names.
3. Reproduce the incident with synthetic data and actual product entrypoints.
   First demonstrate the failure against the affected code. Do not bypass the
   CLI wrapper. Start from both clean OS-native configuration and migrated
   configuration, without the maintainer's cached credentials or environment.
   Exercise acceptance probes through the actual Worker request handler. A
   copied response object can keep an obsolete error contract green after the
   deployed Worker changes. Prove the exact refusal, provider label, absence
   of echoed secrets, and that the rejected request reaches no storage write.
4. Run `npm test` and `npm run audit:regressions`. The second command runs each
   incident suite independently and retains every exit status, even after an
   earlier failure. CI runs this step even if the main suite fails. A missing,
   timed-out or signalled process is a failure; skipped hardware checks remain
   unproven. Never pipe the command being verified into an output filter.
   Install locked frontend dependencies and the reviewed Playwright Chromium
   first. Owner browser regressions execute the actual components, with only
   synthetic loopback APIs, and are part of the independent incident runner.
   Change entity, recipient and selection while requests are pending; final
   success alone cannot establish that drafts and private links stayed scoped.
5. Prove the full lifecycle: bootstrap to actual confirmed batch history, add
   overwrite and delete documents, upgrade, delay provider visibility, interrupt, restart,
   contend for the lease, attempt connector writes during pause, then verify
   ingestion and cited retrieval. Cover queued-only and submitted outbox rows,
   exact-generation replacements and delete absence. Small fixtures prove state
   transitions; they do not prove million-row recovery duration.
   Feed every intermediate Worker receipt through the actual CLI receipt and
   progress validators. Include mixed add/overwrite/delete work, deletion alone,
   and deletion of the final document after confirmed bootstrap history. A
   removed vector is pending work even though its chunk is absent from the
   current corpus count. Immediate provider visibility and an eventual final
   assertion can hide a receipt that would stop the installed updater.
6. Test the same packaged bytes on Mac and Windows, Node 22 and 24. Record OS
   and architecture separately. Windows x64 CI is not Windows ARM64 proof.
   The Windows ARM64 Node 24 case needs a real packaged launch, DPAPI roundtrip,
   browser login, interruption/resume and clean process exit. Native macOS
   sign-in must work without setting XDG_CONFIG_HOME as a workaround.
7. Complete an authorized disposable recovery rehearsal before a customer
   recovery. D1 holds the documents; Vectorize is derived. A D1 bookmark alone
   is not a tested rollback of both. Never begin with a bookmark restore,
   export a live Brain, clear drain mode manually, or edit applied migrations.
8. Attach a reviewed, sanitized evidence file under `docs/` before changing an
   incident to `verified`. Include tested commit, package SHA-256, platform,
   architecture, source/target versions, fixture shape, actual commands and exit
   codes, interruption point, before/after counts and retrieval result. Reopen
   affected incidents when code or dependencies change. The validator now checks
   four mechanical properties of that file and no more: it lives under `docs/`,
   it is not one of the documents that define the gate (RELEASE-GATE.md,
   UPDATE-AUDIT.md, PLAID-RELEASE-GATE.md, MAINTAINER.md, update-incidents.json,
   docs/decisions/), it names the incident it closes, and it carries a tested
   package SHA-256. A test path is never evidence. The reviewer must still
   verify the evidence itself; passing those four checks proves nothing.
   Every `verified` row is printed by the audit with the document it rests on,
   so a closure is as visible in the receipt as a deferral.
9. Run `npm run audit:updates`. Release publication runs this again on the
   exact tagged checkout, before any release write. Every incident must be
   verified or carry a current written deferral for the exact version in
   `package.json`; see [release gate section 11](RELEASE-GATE.md). Full CI,
   immutable artifacts and owner field gates still apply.
   Verify publication controls before publishing, then verify the immutable
   published tag and asset bytes before URL promotion. A completed publication
   cannot be a prerequisite for the gate that authorizes that publication.

## Dispositions

- `open`: a defect, unresolved report or missing recovery/hardware proof.
- `local-only`: candidate code has regression coverage; field acceptance is
  incomplete. This blocks public release unless the row carries a current
  deferral for the version being cut.
- `verified`: reviewed evidence meets the incident's acceptance criteria, in a
  sanitized document under `docs/` that names the incident and records the
  tested package digest. It is the other route past the gate and it is printed
  in the receipt exactly like a deferral, under "CLOSED on reviewed evidence".

A fourth thing exists and is not a status. A `deferral` object on an incident
row scopes that incident out of ONE named release, and only when the acceptance
cannot yet be satisfied at all: `blocked_on` is a closed enum covering physical
hardware that does not exist and live third-party accounts that cannot be
created. It never rewrites a status, never means verified, expires the moment
`package.json` moves, and is printed in full by the audit and in the release
note's "This release does NOT cover" block. UPDATE-010, UPDATE-014 and
UPDATE-026 cannot be deferred at all: their acceptance is a property of the
release mechanism, so waiving one waives the meaning of every other verdict.
Their acceptance text is digest-pinned in `test/update-audit.test.mjs`, because
the protection binds to an ID and an ID whose text has been hollowed out
protects nothing. Opening an incident whose acceptance is about the release
mechanism rather than about a feature? Add its ID to `UNDEFERRABLE_INCIDENTS`
in the same change; the set does not grow by itself.

Deleting a row, broadening an exception, increasing a timeout, or pointing to
unrelated passing CI is not closure. Keep an old report's conclusion separate
from what the present candidate actually proves.

## Frozen-watermark regression and candidate recovery

`node --no-warnings scripts/reproduce-frozen-vector-fence.mjs` now requires both
submitted and queued-only shapes to empty with exact vector coverage. Before
the candidate fix it exited 1: an accepted mutation was overtaken, the provider's
last processed time was only 123.6 seconds later, and twenty cron invocations
could not satisfy the five-minute skew margin. The provider time is the time of
its last mutation, not a clock that advances merely because the client waits.
The old regression advanced it with an external mutation, concealing the stall.

The candidate uses the existing exclusive writer lease. After ten minutes with
an unresolved, overtaken fence and a usable provider timestamp, it checks a
random probe ID is absent and submits its deletion. It persists the new receipt
only if both the old fence and the unexpired lease still match. Acceptance does
not acknowledge any row. A later invocation must observe provider processing,
then independently confirm every exact generation or delete absence. A crash
before persistence retains the old fence; a crash after it retains the new one.
An accepted probe resets the ten-minute cooldown across invocations. A failed
probe exits the invocation with the pending work intact. Probe SQL stays inside
the existing smallest-batch query reservation.

`test/vector-fence-probe.test.mjs` covers both queue shapes, cooldown/repeated
overtaking, delayed or missing visibility, normal pending work, paused/busy
writers, ambiguous absence, provider errors, invalid receipts, lease loss before
and after acceptance, persistence failure and resumed recovery. It runs in both
`npm test` and the independent incident audit. Completed bootstrap-history
coverage lives in `test/vector-delete-outbox.test.mjs`; the incident registry
must retain that suite rather than relying on a fixture with an empty ledger.

UPDATE-002 remains `local-only` until its full field acceptance is reviewed.
Disposable provider checks and accelerated-clock rehearsals must state their
limits explicitly: they do not prove a deployed Worker/D1 recovery, physical
Windows ARM64 behavior, large-corpus duration, or a customer's current state.
Never treat a timeout or vector count alone as confirmation, restore a bookmark
first, or clear the drain mode manually.

## Recovery handoff acceptance

Report separately: writes active; source refresh working; queued/submitted/
confirmed/failed counts and their trend; reconciled vector coverage; actual
cited retrieval; versions and account agreement; and remaining warnings.
Do not label an HTTP 200, upload count, package installation or successful
login as a completed update. Never promise a duration without a measurement.

## Current candidate lineage

The unreleased 0.4.8/schema45 field candidate carries 39 stable incident rows.
The earlier held 0.4.7 candidate was never tagged, published, or offered as a
customer update. Its identity and planning record remain historical and are not
reused as proof for the changed 0.4.8 bytes. The
[current 0.4.8 evidence plan](release-evidence/v0.4.8-candidate-release-evidence-plan.md)
remains unbound to a final SHA and records no field execution.
Four are `verified` on reviewed evidence: UPDATE-010, UPDATE-014, UPDATE-026,
and UPDATE-032. Their evidence documents remain attached to the exact rows in
`update-incidents.json`. The other 35 block release writes. No 0.4.6 deferral
was renewed for this candidate. UPDATE-012 still needs a reviewed Windows ARM64
support decision or its required physical proof. UPDATE-017 through UPDATE-022
and UPDATE-025 still need their required real-provider evidence while bank
credential setup and general invitations remain held. Schema 43 can bind
eligible single-record local file ingests to their exact raw originals. Schema
45 can admit a narrowly bounded accepted-resolution proof for one exact
original after its unresolved observation, raw binding, complete result family,
zero outbox, Vectorize parity, deterministic owner retrieval, and matching
citation pass together. Other ingest producers and ambiguous multi-record
exports remain unbound, and the legacy whole-source provenance repair remains
unaccepted. Every narrow receipt states `whole_source_complete: false` and does
not authorize OCR, reingest, deletion, deployment, or customer execution.
Nothing in this candidate
weakens the gate: no acceptance criterion was rewritten, and the release
workflow still refuses to publish while any incident blocks. Earlier candidate
rehearsals do not automatically clear changed code. Current named-profile OAuth
uses its reviewed encrypted backend; the explicit legacy TOML helper keeps its
separate compatible pin. Preflight detects environment and executable traps but
does not read credentials, authorize an account, or prove a current named-profile
login.

Source and package Windows DPAPI gates, frontend bundle parity, and zero-findings public-history scanning remain mandatory alongside the shared-package matrix. Windows hosted CI does not prove the physical Windows ARM64 owner journey.
