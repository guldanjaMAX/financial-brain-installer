# QuickBooks broker protocol and probes

Step 1 defines the offline review contract. Step 2 adds the separate
[broker foundation](../../broker/quickbooks/README.md), its own security
migration, and an adapter binding real broker handlers to a test-only SQLite
owner implementation. There are no provider credentials or feature enablement.
Production remains closed.

Protocol **`qbo-broker/1`** uses the `/v1/quickbooks/` namespace. Read the
[protocol](v1/PROTOCOL.md), [wire constants](v1/wire-contract.json),
[state machine](v1/state-machine.json), [JSON schemas](v1/schemas/protocol.schema.json),
and [probe adapter contract](probes/README.md) together. The external
`QBO-DESIGN.md` is the governing architecture; implementation choices filled in
here require security review before deployment.

Run these focused commands with the approved offline network guard loaded:

```text
node --import <offline-network-guard-url> --test test/qbo-broker-protocol.test.mjs
node --import <offline-network-guard-url> --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
```

The first is green and includes protocol, schema, state, fake provider, and
probe-harness units. The second now passes all nine scenarios with the
foundation handler, injected fake provider and real SQLite stores. There are
zero skipped tests and zero TODOs. This is offline implementation evidence,
not deployed owner integration or provider acceptance.

The normal ordered chain registers only the green wrapper. The `.probe.mjs`
file is outside discovery roots, is not imported by that wrapper, and is not
listed in `scripts/run-test-chain.mjs`. Do not add a stub adapter that returns
expected observations just to make the probes green. The future adapter must
bind real reviewed handlers to injected transports and stores. It must never
use network fallback.

`testing/` contains executable specification oracles, synthetic fakes, privacy
tests and the isolated owner handler used by the adapter.
Cryptographic fixture tests exercise standard Node primitives; they are not a
production cryptography module. The schema helper supports the catalog's
explicit subset and rejects unknown keywords. A deployment needs a reviewed
complete validator plus all semantic guards described in the protocol.

The package publication allowlist does not include `protocol/`,
`partner-reports/`, or the test wrapper. No product version or connector
availability claim changes in this lane.
