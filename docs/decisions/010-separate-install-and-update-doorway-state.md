# ADR 010: Separate install doorway state from update availability

- Status: Accepted
- Date: 2026-11-04
- Owners: Product and engineering
- Confidence: High for the offline contract; live verification remains separate
- Supersedes: ADR 009

## Problem

Existing owners can receive stable updates while new installs remain closed.
ADR 009 coupled those states, so the exact held install document blocked both
release health and the public install matrix whenever updates were stable.

## Decision

Validate the manifest before interpreting any install document. The manifest
and matching update guide govern updates. One shared install parser accepts:

| Update manifest and guide | Install document | Install result |
|---|---|---|
| Held | Exact reviewed held document | Held |
| Stable | Exact reviewed held document | Held |
| Candidate or stable | Valid supervised version-2 contract | Supervised |

Candidate updates with held installs remain refused. Held updates with an open
install contract remain refused. Altered held text must pass every supervised
contract check or fail closed. The status, owner-presence, platform target,
immutable URL, byte count, digest, version and full-commit checks remain intact.

Report update `state` separately from `install`, whose values are `held` and
`supervised`. Stable release health always verifies immutable release metadata,
archive bytes and the canonical runtime identity receipt, even when installs
are held. A held install result exits the matrix successfully before selecting
an install artifact, creating an install directory or executing a command.

## Alternatives and consequences

Keeping ADR 009 blocks updates whenever new installs are closed. Accepting any
stable install text would hide public contract drift. The exact held literal
allows the intended combination without accepting either failure mode.
A healthy stable update feed does not open installs or prove owner acceptance.
Changing the held literal or opening installs still requires coordinated review.

## Verification and revisit

The focused doorway tests exercise all accepted and refused combinations,
actual runner decisions with synthetic public responses, stable artifact and
runtime binding failures, and mutations that remove these boundaries. Live
public verification, host package gates and cross-platform CI remain separate.
Revisit when the public site replaces the held literal or supervised contract.
