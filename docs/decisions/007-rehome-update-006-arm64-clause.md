# ADR 007: Re-home UPDATE-006's Windows ARM64 clause into UPDATE-012

- Status: Accepted
- Date: 2026-09-25
- Owners: Product and engineering
- Confidence: High that no requirement is removed; medium on whether ARM64 CLI
  identity will later need its own row
- Supersedes: None

## Problem

UPDATE-006 ("Windows CLI identity, MSIX paths and PowerShell shims") required
both physical Windows acceptance and Windows ARM64 acceptance before closure.
UPDATE-012 ("Windows ARM64 Node 24 physical runtime") already owns every other
physical ARM64 requirement. The same ARM64 host was therefore demanded by two
rows, and UPDATE-006 could not close on complete physical x64 evidence while
its ARM64 half waited on hardware that UPDATE-012 already tracks.

A row that mixes two platforms hides which evidence is missing. It also makes
the gate harder to read: a reviewer could not tell from UPDATE-006 alone
whether the x64 CLI-identity work was proven.

The ownership boundary at stake: which incident row carries the obligation to
prove, on a physical Windows ARM64 machine, that every printed human command
uses the actual installed executable.

## Options considered

1. **Leave the clause on UPDATE-006.** Rejected: the row then blocks on
   hardware tracked elsewhere, and x64 CLI-identity proof can never close it.
2. **Delete the ARM64 clause from UPDATE-006.** Rejected: that would be a
   weakening. No other row would require ARM64 CLI-identity proof.
3. **Open a new ARM64 CLI-identity row.** Rejected for now: it would repeat the
   hardware dependency UPDATE-012 already names, and a third row for the same
   physical host adds tracking without adding a requirement.
4. **Move the clause verbatim to UPDATE-012** (chosen). UPDATE-006 keeps every
   x64 requirement. UPDATE-012 gains the full CLI-identity requirement, scoped
   to physical Windows ARM64, in the same words UPDATE-006 used.

## Decision

This is a re-homing, not a weakening. The owner decided on 2026-09-25 to move
the ARM64 clause, and this record is the reviewed, explicit text change in
`docs/update-incidents.json`:

- UPDATE-006 still requires resolving the actual executable and version before
  and after installing into one prefix, running pasted commands with
  restrictive PowerShell and redirected APPDATA, verifying that every printed
  human command uses the actual installed executable, and physical Windows x64
  acceptance before closure. Only the ARM64 requirement leaves the row, and the
  row now names UPDATE-012 as its owner.
- UPDATE-012 keeps its packaged CLI, DPAPI, login, update interruption and
  process-exit requirements on Windows ARM64 Node 24, keeps "x64 hosted CI is
  insufficient", and gains the CLI-identity requirement verbatim for physical
  Windows ARM64.

No status, evidence list, test list, finding label, or deferral changes in
either row. UPDATE-006 stays `local-only`; UPDATE-012 stays `open`. The union of
the two acceptance texts demands exactly what it demanded before.

UPDATE-012 is not closed or deferred by this record. On this change it carries
no `deferral` object, so it blocks a 0.4.9 release write under ADR 004 until it
is verified on physical ARM64 hardware or a separately reviewed change adds an
exact-version 0.4.9 deferral with `blocked_on: physical_hardware_unavailable`.
Any such deferral moves nothing back into UPDATE-006: the ARM64 CLI-identity
proof ships unproven exactly as the rest of UPDATE-012 would, and is printed
in the release note's "does NOT cover" block.

## Consequences

- Easier: UPDATE-006 can close on reviewed physical Windows x64 evidence alone.
- Harder: UPDATE-012 now needs more evidence from the same ARM64 session,
  including a CLI-identity walk under restrictive PowerShell.
- Unchanged: UPDATE-022 and UPDATE-025 stay open. No other row is closed,
  deferred, or reworded.
- Not defended against: a later change that edits UPDATE-012's acceptance and
  silently drops the re-homed sentence. That edit would be a separate reviewed
  gate change and would need its own record.

## Verification

`node scripts/audit-updates.mjs --regressions` and
`node test/update-audit.test.mjs` validate the registry shape after the edit.
The diff to `docs/update-incidents.json` touches only the two `acceptance`
strings. Rollback is restoring both strings, which returns the previous
requirement set exactly.

## Revisit when

- Physical Windows ARM64 hardware becomes available and UPDATE-012 is
  exercised; if the CLI-identity half and the runtime half fail independently,
  split them into separate rows.
- Windows ARM64 is dropped as a supported platform, which would be a product
  decision recorded in its own ADR rather than a quiet deferral.
