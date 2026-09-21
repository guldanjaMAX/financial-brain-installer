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
but each of those five boundary failures names only its compile-time field name.
No untrusted field value enters those five fixed diagnostics. The guide parser's
separate malformed-field and duplicate-field diagnostics may name a
page-controlled field key whose characters are restricted to `[A-Z][A-Z0-9_]*`
but whose length has no independent bound within the 200,000-character guide
limit.
Setup-page URL parsing is caught and translated to the fixed
`invalid supervised setup URL` refusal before URL policy validation.

This decision adds no field requirement, endpoint, fetch, MCP contract, or
cross-link requirement.

## Consequences

- Both published version-2 platform contracts can pass the shared validator.
- Version 1 and every future undeclared version remain rejected.
- Hosted logs identify which of the five formerly joined contract fields failed
  without disclosing its value.
- The Windows guide is rejected as a macOS contract and the macOS guide is
  rejected as a Windows contract with a `TARGET` diagnostic.
- A malformed setup page no longer escapes as a raw URL parser exception.
- Cross-link and update-contract ownership remain unresolved rather than being
  silently decided by a release-unblocking change.

## Verification

`test/install-page-version.test.mjs` proves that version 2 passes while versions
1 and 3 fail with the version field name, both supplied published field sets
pass on their own platform, and both synthetic cross-platform swaps fail with
the exact target-field message. For `AGENT_INSTALL_CONTRACT_VERSION`, `STATUS`,
`OWNER_PRESENT`, and `TARGET`, the forbidden marker is the failing field's own
value. The `SETUP_PAGE` presence fixture necessarily omits `SETUP_PAGE`; its
marker is in another parsed field, so it proves only that the failure does not
dump the parsed field map. The separate malformed-URL fixture proves that a
present malformed setup-page value is not echoed.

The test guard recursively inspects own property names and own data-property
values, plus message, stack, cause, input, code, raw bytes from `ArrayBuffer`
views, and element-wise character-code representations for every numeric and
bigint typed-array constructor exercised by the fixture table, including a
cross-realm `Uint16Array`. It also inspects `util.inspect` output and fails closed
when inspection throws. `DataView` has no element-width sequence and is inspected
only as raw bytes. This does not claim to detect values exposed only through an
inherited `toString` or an otherwise-unselected own accessor. The harness also
recognizes a 5,000-character uppercase-and-underscore marker in both key-bearing
parser diagnostics. Those diagnostics intentionally disclose the page-controlled
field name and remain outside the five value-free field diagnostics; field-name
characters are restricted to `[A-Z][A-Z0-9_]*`, with no independent length bound
inside the guide-size limit.

The Windows and macOS supervised-guide resources have one operational selector:
the module-local platform table. Validation, the bounded contract reader, and
the release-health check's fixed Windows guide fetch all use that table. Tests
exercise both bounded-reader fetch paths, bind the release-health fetch to the
same Windows entry, and tie each returned guide URL to the URL actually passed
to the reader. A separate dependency-free module carries literal expected URLs;
it is an independent oracle, not another resource selector.

The public install runner first asks the bounded reader to download and validate
both the guide and its artifact. It then compares the returned fetched-guide URL
with that independent oracle before creating the work directory, extracting the
archive, installing the package, or executing its CLI. A mismatch therefore
prevents extraction, installation, and execution. The comparison semantics are
tested directly through the oracle module; a narrow source assertion proves the
top-level runner invokes it in that sequence. No decision or proof relies on
whether the module-local platform table is frozen.

Commit `f9e7aaf` introduced `Object.hasOwn` and its regression cases, changing
prototype property names from the misleading `TARGET` failure to the
unsupported-caller-platform diagnostic; commit `148e7a2` did not change that
behavior. `test/package-privacy.test.mjs` continues to review the packaged
validator and decision record and explicitly reviews the shipped independent
oracle module.

## Revisit when

- The owner decides whether each platform contract must carry a required
  cross-link field and defines its exact schema.
- The owner decides whether the `EXISTING_BRAIN_RUNBOOK` location published by
  the install guides or `ENDPOINTS.updateGuide` is the authoritative update
  contract.
- A version beyond 2 is intentionally published; replace the exact pin only in
  the same reviewed change that proves the new contract.
