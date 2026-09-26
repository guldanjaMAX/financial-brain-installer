# ADR 008: Re-home UPDATE-025's account breadth into UPDATE-044 and pre-register its 0.4.9 exception

- Status: Accepted
- Date: 2026-09-26
- Owners: Product and engineering
- Confidence: High that the re-homing removes no requirement; the 0.4.9
  exception is a deliberate narrowing of what 0.4.9 proves, not a claim of proof
- Supersedes: None

## Problem

UPDATE-025 ("Bank freshness never reports a failed or unfetched refresh as
current") required two different things in one row. The first is the
freshness proof with a real Item: refresh debt shown in both owner views, the
ready window, the interrupted prefix, the ordinary poll, the debt clearing, a
verified signed webhook, and a deliberately missed notification recovered on
schedule. The second is account breadth: the proof repeated across two
institutions and at least four accounts spanning a person and two owned
businesses, including a real business banking login.

The Plaid release gate makes UPDATE-025 undeferrable whenever a release
touches the Plaid freshness code, and 0.4.9 does. The owner's own production
bank connection is one institution reached through a personal login, and the
owner holds no business banking login. Any wider set of accounts belongs to
other account holders. Whether the Windows tester's own-Brain production pilot
under UPDATE-022 will supply any of that breadth on the sealed package is not
known before it runs. As written, UPDATE-025 could neither close nor be
deferred for 0.4.9, and the tag would wait on accounts the release does not
hold.

The ownership boundary at stake: who may let 0.4.9 ship without
multi-institution, multi-business bank freshness proof, and how that decision
is recorded so that it cannot be mistaken for proof.

## Options considered

1. **Leave UPDATE-025 as written.** The tag waits until a business banking
   login, a second institution and a second owned business are connected on
   the sealed package. Rejected by the owner for 0.4.9: the tag would slip day
   for day with no assured path to those accounts.
2. **Defer UPDATE-025 whole for 0.4.9.** Rejected: the Plaid release gate
   forbids it because 0.4.9 changes the freshness code, and the real-Item proof
   of that code can still be collected.
3. **Delete or reword the breadth clause.** Rejected: a weakening, with no row
   left to require the breadth.
4. **Re-home the breadth clause verbatim into a new row, UPDATE-044, and
   pre-register a 0.4.9-only deferral of that row before the seal** (chosen).

## Decision

The decision has two parts, and they are deliberately separable.

**The re-homing is not a weakening.** UPDATE-025 keeps every real-Item
freshness assertion, the verified signed webhook and the deliberately missed
notification recovered on schedule. Only the breadth sentence leaves, and the
row now names UPDATE-044 as its owner. UPDATE-044 ("Bank freshness across two
institutions, two owned businesses and a business banking login") repeats
UPDATE-025's real-Item proof across two institutions and at least four accounts
spanning personal and two businesses, including a real business banking login,
with a verified signed webhook and a deliberately missed notification
recovered on schedule, in the words UPDATE-025 used. It is `open`, with
UPDATE-025's tests and findings. The union of the two acceptance texts demands
exactly what UPDATE-025 demanded before.

**The pre-registered exception is a narrowing, for 0.4.9 only.** On
2026-09-26, before the 0.4.9 seal, the owner approved that 0.4.9 may ship
without UPDATE-044's evidence if that evidence does not exist by the
2026-09-29 18:00 (UTC-7) hard stop. It is written now rather than at the hard
stop because the registry and the Plaid release gate ship in the package: a
deferral added after the seal would change the sealed bytes and void every
receipt taken from them. So:

- UPDATE-044 carries an exact-version 0.4.9 deferral with `blocked_on:
  live_third_party_account_required`. Its `reason` and `unproven` say what is
  missing, that the owner pre-registered it, and that it holds only while
  general bank invitations stay closed.
- The Plaid release gate classifies UPDATE-044 like UPDATE-022: deferrable
  only while invitations stay closed, and for 0.4.9 only under this record.
  UPDATE-025 stays a code gate and is not deferred.
- If reviewed evidence for UPDATE-044 from the sealed 0.4.9 package exists
  before the release write, the change that closes it sets `status` to
  `verified`, names the evidence, and deletes UPDATE-044's `deferral` object,
  because the validator refuses a verified row that still carries one. The
  0.4.9 evidence plan permits exactly that one deferral edit after the seal. It
  only narrows what ships unproven and changes no acceptance text, test, code
  or other row.
- Otherwise the deferral prints in full in the audit and in the release note's
  "This release does NOT cover" block.

## Consequences

- Easier: the 0.4.9 tag no longer waits on accounts the release does not hold,
  and UPDATE-025 can close on real-Item evidence from one institution.
- Harder: UPDATE-044 must be closed or taken to a fresh owner decision at the
  next version, because the version bump expires its deferral. Any receipt
  protocol that pinned UPDATE-025's acceptance text must be re-pinned to the
  new text, and UPDATE-044 needs a receipt protocol of its own.
- Unchanged: UPDATE-022 stays `open` and carries no deferral. Its production
  pilot approval is recorded in the 0.4.9 evidence plan, is not a gate change,
  and does not close the row. General bank invitations stay closed.
- Not defended against: a release that opens bank invitations while the
  UPDATE-044 deferral stands. The gate prose forbids it, but no validator reads
  the invitation state, exactly as with the earlier UPDATE-022 deferrals.

## Verification

`node test/update-audit.test.mjs` validates the registry shape, the 0.4.9
deferrals, and that UPDATE-044 stays registered. `node
scripts/audit-updates.mjs --check` prints UPDATE-044 under "DEFERRED for 0.4.9"
and again under "This release does NOT cover". The diff to
`docs/update-incidents.json` for this record touches only UPDATE-025's
`acceptance` string and adds the UPDATE-044 row. The same change adds UPDATE-012's
0.4.9 deferral under the condition ADR 007 set, not under this record.
Rollback is restoring UPDATE-025's string and deleting UPDATE-044, which
returns the previous requirement set exactly and holds 0.4.9 on UPDATE-025
again.

## Revisit when

- 0.4.10 is cut: the deferral expires, and UPDATE-044 either closes on
  evidence or needs a new, separately reviewed owner decision.
- General bank invitations are proposed: UPDATE-044 must be verified first.
