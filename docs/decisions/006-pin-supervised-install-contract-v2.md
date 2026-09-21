# ADR 006: Pin supervised install validation to contract version 2

- Status: Accepted
- Date: 2026-09-21
- Owners: Product and engineering
- Confidence: High on the exact-version fail-closed gate and bounded diagnostics; medium on the unresolved public-contract ownership questions
- Supersedes: None

## Problem

The published Windows and macOS supervised-install guides declare contract
version 2, while the shared validator accepts only version 1. The release job
requires the public install matrix, and that matrix follows these published
contracts, so an obsolete validator pin makes the release gate unsatisfiable.
ADR 004 records why such a gate is unsafe: a rule that cannot pass is a rule
people learn to bypass.

The validator also joins five independent contract checks behind one error and
parses `SETUP_PAGE` without translating a malformed URL into a bounded refusal.
Hosted logs therefore cannot distinguish a version mismatch from status, owner,
target, or setup-page drift, while a malformed untrusted value can produce a raw
runtime error.

## Options considered

1. Keep the version-1 pin. Rejected because it refuses both published version-2
   contracts and leaves the release path unsatisfiable.
2. Accept versions 1 and 2. Rejected because this would hide the next contract
   bump instead of requiring an explicit reviewed change.
3. Pin exactly version 2 and split existing checks into bounded field-name
   diagnostics. Chosen because it restores a satisfiable fail-closed gate without
   weakening or expanding the accepted contract.
4. Add cross-link, MCP, or update-contract requirements in the same change.
   Rejected because those ownership decisions remain open, and making an
   undecided field mandatory would create another unsatisfiable gate.

## Decision

The shared supervised-install validator accepts exactly
`AGENT_INSTALL_CONTRACT_VERSION: 2`. It retains the existing version, status,
owner-presence, platform-target, and setup-page checks in their existing order,
but each failure names only its compile-time field name. No untrusted field value
enters an error message. Setup-page URL parsing is caught and translated to the
fixed `invalid supervised setup URL` refusal before URL policy validation.

This decision adds no field requirement, endpoint, fetch, MCP contract, or
cross-link requirement.

## Consequences

- Both published version-2 platform contracts can pass the shared validator.
- Version 1 and every future undeclared version remain rejected.
- Hosted logs identify which bounded contract field failed without disclosing
  its value.
- The Windows guide is rejected as a macOS contract and the macOS guide is
  rejected as a Windows contract with a `TARGET` diagnostic.
- A malformed setup page no longer escapes as a raw URL parser exception.
- Cross-link and update-contract ownership remain unresolved rather than being
  silently decided by a release-unblocking change.

## Verification

`test/install-page-version.test.mjs` proves that version 2 passes, version 3
fails with the version field name, both cross-platform swaps fail with the
target field name, every existing boundary has its own value-free message, and
a malformed setup page receives a fixed refusal. `test/package-privacy.test.mjs`
continues to review the packaged validator and this decision record.

## Revisit when

- The owner decides whether each platform contract must carry a required
  cross-link field and defines its exact schema.
- The owner decides whether the `EXISTING_BRAIN_RUNBOOK` location published by
  the install guides or `ENDPOINTS.updateGuide` is the authoritative update
  contract.
- A version beyond 2 is intentionally published; replace the exact pin only in
  the same reviewed change that proves the new contract.
