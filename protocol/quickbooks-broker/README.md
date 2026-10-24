# QuickBooks broker protocol and probes

This is step 1: an offline review contract and test doubles. It contains no
broker Worker, owner route implementation, deployment configuration, migration,
provider credential, or feature enablement. Production remains closed.

Protocol **`qbo-broker/1`** uses the `/v1/quickbooks/` namespace. Read the
[protocol](v1/PROTOCOL.md), [wire constants](v1/wire-contract.json),
[state machine](v1/state-machine.json), [JSON schemas](v1/schemas/protocol.schema.json),
and [probe adapter contract](probes/README.md) together. The external
`QBO-DESIGN.md` is the governing architecture; implementation choices filled in
here require security review before deployment.

Run only these focused commands for this lane:

```text
node --test test/qbo-broker-protocol.test.mjs
node --test protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
```

The first is green and includes protocol, schema, state, fake provider, and
probe-harness units. The second must currently exit 1 with nine
`BROKER_IMPLEMENTATION_MISSING` failures, zero skipped tests, and zero TODOs.
Each probe contains passing-control requirements and behavioral attacks for the
future implementation. Their control flows have not run against a broker yet.

The normal ordered chain registers only the green wrapper. The `.probe.mjs`
file is outside discovery roots, is not imported by that wrapper, and is not
listed in `scripts/run-test-chain.mjs`. Do not add a stub adapter that returns
expected observations just to make the probes green. The future adapter must
bind real reviewed handlers to injected transports and stores. It must never
use network fallback.

`testing/` contains only executable specification oracles and synthetic fakes.
Cryptographic fixture tests exercise standard Node primitives; they are not a
production cryptography module. The schema helper supports the catalog's
explicit subset and rejects unknown keywords. A deployment needs a reviewed
complete validator plus all semantic guards described in the protocol.

The package publication allowlist does not include `protocol/`,
`partner-reports/`, or the test wrapper. No product version or connector
availability claim changes in this lane.
