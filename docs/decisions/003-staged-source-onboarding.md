# ADR 003: Make source onboarding useful before historical backfill completes

- Status: Accepted
- Date: 2026-09-06
- Owners: Product and engineering
- Confidence: High in the customer model; medium in throughput until large live Gmail and messaging field runs complete
- Supersedes: None

## Problem

A large mailbox can contain hundreds of thousands of messages. One complete
Gmail sweep currently makes the owner wait hours before the source can report
ready, and an interruption re-reads already accepted mail before it reaches new
work. Message histories and cloud drives have the same shape at different
scales. Waiting for every historical item and every derived vector before the
owner can ask a useful question creates a poor first experience. Calling a
partial corpus complete would be worse because an answer could hide the exact
date range or source that is still absent.

Gmail has no supported bulk API that bypasses per-user request and bandwidth
limits. HTTP batching reduces connection overhead, but every enclosed request
still consumes its normal quota. Cloud source cursors also cover complete
provider windows, so a client-side limit cannot be saved as if the source were
fully synchronized.

## Options considered

1. Keep one foreground full sweep. This keeps one completion boundary but
   makes setup depend on an uninterrupted machine and network session.
2. Treat a recent import as the whole source. This feels fast but makes missing
   history indistinguishable from a complete negative answer.
3. Separate starter context, live updates, historical coverage, and semantic
   projection while preserving one logical source and one final exact boundary.

## Decision

Adopt the third option for every large source. A connector first discovers a
bounded, high-signal slice, then hydrates and stores it through durable work
items. The owner may use that confirmed slice while history continues newest
to oldest. Live changes run in an independent cursor lane so a long backfill
does not make new mail stale. Historical windows, item receipts, retries, and
projection state survive process exit, sleep, reboot, and network loss.

Gmail starts with recent Inbox and Sent mail under the existing bulk-mail
policy. It lists 500 identifiers at a time, persists work before fetching
content, uses quota-paced HTTP batches, reads the structured full-message shape
without downloading attachment bodies during starter context, and retries only
failed parts. A final complete membership walk and history reconciliation are
required before Gmail history is complete or any snapshot absence can authorize
removal. A provider page token may accelerate a restart but is never the only
durable checkpoint.

Zoom transcript delivery and Calendar begin before deep email history because
they protect current client context. Plaid begins alongside starter context
when the owner's first questions require financial activity. iMessage,
WhatsApp, SMS, Google Drive, Box, Dropbox, and later providers use the same
discover, hydrate, store, project, and verify lifecycle with source-specific
cursors and deletion authority.

The shared owner status has four independent dimensions:

- starter context: preparing, ready, or degraded;
- live updates: catching up, current, stale, or unavailable;
- history: not started, running, complete, needs attention, or unknown;
- meaning search: projecting, ready, degraded, or unknown.

Every answer checks the requested source and date range against that coverage.
When coverage is partial, absence language names the confirmed boundary, such
as "Email is confirmed from January 2025 onward. Older email is still loading."
No combined percentage may hide a missing source, a stale live lane, or a
Vectorize backlog.

## Consequences

- The first useful, cited owner question can succeed without waiting for years
  of low-value history.
- Network interruptions repeat at most one bounded work window rather than the
  complete mailbox.
- Current mail, calls, and transactions stay fresh while history backfills.
- One source remains one zoning, provenance, search, and forget boundary even
  though its synchronization has several lanes.
- Partial history never authorizes whole-source deletion or advances the final
  Gmail history marker.
- The product needs a durable source-work ledger, source coverage records,
  priority in the vector outbox, and a cross-platform local runner for OAuth
  credentials that remain on the owner's machine.
- Google Takeout and provider exports remain optional seed accelerators. They
  require provider reconciliation and never become completion proof by
  themselves.

## Verification

- Offline tests for interruption at discovery, hydration, ingest receipt,
  history reconciliation, removal review, and projection confirmation.
- Tests proving live and starter work outrank historical work without starving
  the backfill.
- Tests proving partial windows cannot advance a complete-source cursor or
  authorize snapshot deletion.
- Large synthetic mailbox and message-history runs with injected sleep,
  network loss, rate limits, expired page tokens, process termination, and
  reboot-style restart.
- Real-account field runs for Gmail, Zoom, Plaid, iMessage, WhatsApp, Google
  Drive, Box, and Dropbox. Record time to starter readiness, restart work
  repeated, final coverage, and exact Vectorize parity separately.
- Desktop and mobile owner-workspace checks for each status and provisional
  answer state.

## Revisit when

Revisit if a provider adds a supported bulk export with durable change fencing,
or if owner-approved server-side OAuth custody makes a cloud runner safer and
more reliable than the local credential model.
