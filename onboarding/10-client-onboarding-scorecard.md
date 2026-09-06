# Client onboarding scorecard

Copy this file for each client. Use an opaque client ID and aggregate counts.
Do not record message text, transcript text, filenames, email addresses,
credentials, consent codes, or other customer content here.

This scorecard follows one install from intake through the first three client
check-ins. Its purpose is to show where customers spend time, where ingestion
waits or repeats work, and which change would make the next install easier.

## Engagement

| Field | Result |
|---|---|
| Client ID | |
| Platform and version | |
| Install start | |
| Owner handoff | |
| Technician | |
| First high-value source | |
| First high-value question | Recorded in the private client acceptance set |
| Excluded sources and zones | Recorded in the private client manifest |

## Source order

Choose the order from the client's questions, not from connector availability.
The usual starting order is:

1. Current client calls and Zoom transcripts.
2. Recent email and the mailbox folders most likely to answer the acceptance
   questions.
3. Messages and shared files.
4. The client's main drive, then Dropbox, Box, or another file system they use.
5. Plaid or another financial source when the acceptance questions need it.
6. Older history after the first useful result is proven.

Record why any client needs a different order:

> 

## Source scorecard

Use one row per authorized source. `Configured`, fixture-tested, and live-tested
are different proof levels. Never mark a source ready from connector setup
alone.

| Source | Method | Proof level | Start | First accepted item | Starter context | Live updates | History | Meaning search | Access zone | Provenance label | Items seen | Retries | Owner minutes | Technician minutes | Gap or next action |
|---|---|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|
| Zoom transcripts | | | | | | | | | | | | | | | |
| Email | | | | | | | | | | | | | | | |
| Messages | | | | | | | | | | | | | | | |
| Files | | | | | | | | | | | | | | | |
| Financial activity | | | | | | | | | | | | | | | |
| Other | | | | | | | | | | | | | | | |

Allowed readiness values for the four coverage columns:

- `ready`: the exact dimension has current live proof.
- `loading`: accepted work remains and progress is visible.
- `partial`: some authorized material is unavailable or unprocessed.
- `not configured`: the client has not authorized or set up this capability.
- `unknown`: the system cannot currently prove the state.

An unscheduled changing source is not live-ready. An incomplete or unavailable
meaning-search projection cannot support a categorical absence answer. Any
source found in documents but missing from the source registry is a blocking
`unregistered source` gap until its kind, authorization, and zone are reviewed.

## Customer experience timing

Measure elapsed time and active human time separately. Waiting for a provider,
background work, or account owner should not look like technician effort.

| Metric | Target | Actual | Evidence |
|---|---:|---:|---|
| Intake to approved source map | | | |
| Install start to first useful cited answer | | | |
| Install start to first Zoom transcript | | | |
| Install start to recent email starter context | | | |
| Install start to live freshness | | | |
| Install start to complete authorized history | | | |
| Install start to meaning-search parity | | | |
| Owner active minutes | | | |
| Technician active minutes | | | |
| Account consent wait | | | |
| Commands or screens the owner completed | | | |
| Interrupted runs | 0 | | |
| Repeated items after resume | 0 | | |
| Support recoveries | 0 | | |

## First value proof

Record results without copying private questions or answers into this file.

| Check | Result | Evidence |
|---|---|---|
| First acceptance question answered usefully | | Private acceptance receipt ID |
| Exact source citation opened | | Receipt ID |
| Provenance showed the correct source kind | | Receipt ID |
| Result respected the expected access zone | | Receipt ID |
| Known missing question stayed provisional | | Receipt ID |
| Client described the answer as useful | | Date and yes/no |

## Install review

Complete this before owner handoff.

- [ ] The source map comes from the client's acceptance questions.
- [ ] Exclusions and access zones are written before ingestion.
- [ ] Current Zoom client-call transcripts were attempted first when authorized.
- [ ] Recent, high-value material was proven before older history.
- [ ] Every source row separates starter context, live updates, history, and
      meaning search.
- [ ] Every cited result exposes an exact provenance label and access zone.
- [ ] No combined completion percentage hides an incomplete dimension.
- [ ] Restart behavior was tested without duplicate accepted items.
- [ ] The owner can name what is ready, loading, partial, and not configured.
- [ ] Every live connector has its named sanitized acceptance receipt.

## `/optimize` review

Open `/optimize` with the owner after handoff. Compare what the page shows with
the source scorecard above.

| Review | Day 1 | Day 15 | Day 22 | Day 29 |
|---|---|---|---|---|
| Starter-context gaps | | | | |
| Live-update gaps | | | | |
| History gaps | | | | |
| Meaning-search gaps | | | | |
| Provenance mismatches | | | | |
| Zone mismatches or unregistered sources | | | | |
| Real questions that failed | | | | |
| One improvement chosen | | | | |

For each check-in, choose one change that reduces time, owner effort, retries,
or an answer gap. Record the result at the next check-in before choosing
another change.

## Closeout

| Question | Result |
|---|---|
| What created the first useful moment? | |
| Where did the owner wait or get confused? | |
| Which step required technician judgment? | |
| Which source repeated the most work? | |
| Which instruction, default, or product change should be tested next? | |
| Did that change improve the next install? | Pending next comparable install |

Proof links or sanitized receipt IDs:

- 

## Improvement experiment

After three comparable installs, use their median as the baseline for each
timing metric. Compare like platform and source combinations. Change one
instruction, default, or product step at a time, then keep it only when the
next comparable installs improve without weakening a proof gate.

| Date | Friction observed | Change tested | Baseline | Result | Keep, revise, or revert |
|---|---|---|---:|---:|---|
| | | | | | |
