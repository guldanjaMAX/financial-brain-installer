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
| First evidence-derived question or action | Recorded by sanitized receipt ID |
| Excluded sources and zones | Recorded in the private client manifest |

## Owner Financial Map

Do not copy entity names, account labels, tax identifiers, balances, or other
private values into this scorecard. Use only the sealed snapshot reference and
aggregate gap counts from the owner's private Brain.

| Field | Result |
|---|---|
| Map status | not established / stale / current |
| Population state | owner asserted complete / known partial / unknown |
| Finite tax-year horizon | |
| Entity count | |
| Account count | |
| Entity-year count | |
| Owner-declared rows with no current ledger evidence | |
| Filing-unit count | |
| Return and form obligations reviewed | yes / not yet |
| K-1 roles reviewed | yes / not yet |
| Books and bookkeeping companies reviewed | yes / not yet |
| Payroll applicability reviewed | yes / not yet |
| Expected sources reviewed | yes / not yet |
| Unresolved item count | |
| Complete preview reviewed by owner | date / not yet |
| Separately activated by owner | sealed snapshot reference / not activated |

Every structured row remains a possible mention until the owner confirms it.
Expected-but-not-loaded entities and accounts belong in the map with no ledger
link. Ask one short question at a time. Show the complete plain-language
preview, yearly obligations, evidence mismatches, and all unresolved items
before offering the separate owner activation ceremony.
Immediately after the owner's opening goal, Optimize reads this state and
explains that the private read sends no Financial Map snapshot and changes
nothing. Before any financial-completeness conclusion, offer the optional
session-only interview. Do not start it automatically. The interview submits
nothing and changes nothing. End Optimize before offering a separately
explained and approved preview. Optimize does not run the passkey ceremony.

## Source order

Choose the order from the owner's goals, approved source scope, and the actual
evidence most likely to create early value. Do not require a prepared question
list. The usual starting order is:

1. Current client calls and Zoom transcripts.
2. Recent email and the mailbox folders most likely to support the owner's
   current goals.
3. Messages and shared files.
4. The client's main drive, then Dropbox, Box, or another file system they use.
5. Plaid or another financial source when the approved financial picture needs it.
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
| One material evidence-derived question or action completed usefully | | Private acceptance receipt ID |
| Exact source citation opened | | Receipt ID |
| Provenance showed the correct source kind | | Receipt ID |
| Result respected the expected access zone | | Receipt ID |
| Known missing claim stayed provisional | | Receipt ID |
| Client described the answer as useful | | Date and yes/no |

## Install review

Complete this before owner handoff.

- [ ] The source map comes from the owner's approved goals, sources, and exclusions.
- [ ] Exclusions and access zones are written before ingestion.
- [ ] Current Zoom client-call transcripts were attempted first when authorized.
- [ ] Recent, high-value material was proven before older history.
- [ ] Every source row separates starter context, live updates, history, and
      meaning search.
- [ ] Accepted, stored in D1, projected to Vectorize, and query-visible were
      proved separately for one approved low-sensitivity test item.
- [ ] The exact test item has the expected logical family, chunks, source and
      extraction provenance, confirmed vector generation, cleared matching
      outbox work, and a cited distinctive-phrase retrieval.
- [ ] Two health readings show pending projection declining or zero with no
      competing drain lease; a green health response was not used as a
      substitute for exact readback.
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
| Owner Financial Map status | | | | |
| Owner Financial Map unresolved items | | | | |
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
