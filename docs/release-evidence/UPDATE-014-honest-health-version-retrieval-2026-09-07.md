# UPDATE-014 evidence: honest health, version and retrieval handoff

**Incident:** UPDATE-014. **Tested package:** `brain-installer-0.4.0.tgz`,
sha256 `bd6e02082aece9ae642dbe216da0b96ef68b399876a7707567f6d36b0c0cb3df`,
built by CI from tagged commit `3fdf98e6c32a5459330e020a0c9ade75d6a078fe`.
**Evidence date:** 2026-09-07. **Source:** run A in
`v0.4.0-field-findings-2026-09-07.md`, a real installation on a physical
Windows x64 machine, reported by its operator with counts.

The acceptance text, clause by clause.

**Record executable, package, manifest, worker and D1 versions separately.**
Run A recorded them as distinct facts, not one number: brain 0.3.4 to 0.4.0,
CLI 0.3.5 to 0.4.0 (the previously installed shim was a different version
from the brain it served), schema 22 to 35. `doctor` separately verified that
every applied migration matches its file. The acceptance suite's own version
check compared install-state to live and reported the difference at the
instant it ran (see the gap below).

**Verify ingestion.** `accepting_documents` was observed true before the
update, false throughout the pause, and true after, read from the health
surface at each stage rather than assumed from the update's exit.

**Verify paused state.** Health flipped to `paused-for-upgrade` at the safety
pause and back to active after the final deploy, measured externally at
15:32:46Z and 16:19:15Z for a pause of 46 m 29 s. The operator did not rely on
the console for this; the external endpoint was polled independently.

**Verify backlog trend.** Measured from the read-only readiness endpoint
during the update, not from the console counter: pending 3,968 to 168 to 68 to
0; vectors 10,001 to 13,801 to 13,869 of 13,869 expected; archive chunks
embedded 8,900 to 12,800. This is the clause that mattered, because the
console progress line showed `1001/13869` unchanged for the entire 46 minutes
(defect D4 in the findings document). The trend was only visible because the
verification read the numbers rather than the screen.

**Verify cited retrieval.** A supported question returned the exact monthly
figure with a citation to the source document and a gaps array. An
unsupported question, about a lease that does not exist, returned a null
answer and an empty citation list, surfaced nearest-neighbour documents, and
refused to synthesize from them. That refusal is the behaviour that matters
most and it held.

**Never infer recovery from HTTP 200.** Demonstrated in the negative on two
other installations the same day. Run B's `/health` returned `ok: true`,
`accepting_documents: true`, `vector_drain_mode: active`, HTTP 200, while
199,062 chunks had been stuck for two days with zero attempts; the only signal
was the readiness numbers. Run C's earlier `/health` had returned `ok` while
its corpus was paused, and on 2026-09-07 the same endpoint correctly reported
`paused-for-upgrade`, which is the health-honesty fix in this package doing
its job. The rule this incident encodes is therefore proven necessary, not
merely asserted.

## Gaps, stated

- **Run A saw `query-ready (0 confirmed)`** between the second deploy and the
  final probe. The readiness assertion accepted an empty queue as ready
  without checking the vector count. Recorded as defect D5 and fixed in the
  0.4.1 branch with a regression test that fails on 0.4.0.
- **The acceptance suite warned `install state 0.3.4, live 0.4.0`** because
  it runs before the D1 version commit, so that warning fires on every
  successful update. Recorded as D9. The commit and its readback both
  succeeded on run A; the warning was accurate at the instant it ran and
  misleading as a summary.
- **The console progress line is not an honest handoff surface** (D4). The
  external readiness numbers are. Until D4 ships, operators are instructed to
  read the endpoint, not the counter.

## What this does not prove

Run A's corpus was 13,869 chunks. The same handoff on a corpus two orders of
magnitude larger (run C, 696,701 chunks) has not been observed.
