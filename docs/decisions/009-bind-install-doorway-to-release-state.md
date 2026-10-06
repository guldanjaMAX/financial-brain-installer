# ADR 009: Bind the public install doorway to the release state

- Status: Accepted
- Date: 2026-10-01
- Owners: Product and engineering
- Confidence: High
- Supersedes: None

## Problem

The public install routes have two legitimate states. While a release is held,
both platform routes return one exact 232-byte closed-door document and expose
no artifact. In candidate or stable state, they expose the version-2 supervised
install contract and its immutable artifact receipt.

The release checks always sent either response to the supervised-contract
parser. That parser correctly rejected the held document because it has no
`AGENT_INSTALL_CONTRACT_VERSION` field. Since the release workflow requires the
public install matrix before it publishes, requiring an already-open stable
door at that point made the release path circular.

## Decision

The public release manifest is read and validated before the install runner may
select an artifact. A `held` manifest accepts only the exact closed-door
document. That result exits successfully before creating a work
directory, downloading an artifact, extracting a kit, or executing a command.

A `candidate` or `stable` manifest still requires the complete version-2
supervised contract. The existing platform, status, owner-presence, setup-page, immutable URL, byte
count, digest, version, and commit checks remain unchanged. A missing held
document, an unexpected held byte, a missing stable contract, or an undeclared
contract version fails closed.

The release-health checker binds the same manifest state, update guide, and
install document. A green held check proves only that the public door is closed
consistently. It is not artifact proof or promotion permission.

## Consequences

- A release tag can complete its repository and held-door checks before the
  stable public door is opened.
- The scheduled install matrix performs no package install while the public
  state is held.
- After the public state becomes candidate or stable, the matrix resumes the
  existing download, receipt, extraction, install, version, and doctor checks.
- Copy changes to the held document require a coordinated contract update.
- ADR 006's exact version-2 pin remains in force for the stable doorway.

## Verification

`test/install-page-version.test.mjs` covers held, stable, missing, and malformed
version states through the production parser. Its runner fixture proves the
held decision point is reached and no work directory or command appears, while
the stable control reaches the synthetic execution boundary. A source mutant
restores the old unconditional supervised parser and is required to reject the
held fixture.

## Revisit when

- The public site replaces the exact closed-door document with a structured
  held contract.
- The stable install route no longer publishes the version-2 supervised field
  kit contract.
