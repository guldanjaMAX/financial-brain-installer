# QBO-BROKER-FOUNDATION-2 report

All six requested items are complete. The final round 1 eleven-file command
passes **124 tests, 0 failures, 0 skips, 0 TODOs**, including all nine E2E probes
against actual broker handlers, the injected fake provider and SQLite stores.
The protocol wrapper contributes 72 tests; the foundation and E2E files
contribute 52. Production remains closed.

Observed branch: `partner/qbo-broker-foundation-2`. Starting commit: `b71c4ba`.
Both prior lane reports, the external design contract and repository contributor
documentation were read. Implementation proceeded through a to f, followed by
review corrections to the privacy and committed-receipt checks.

All changes remain in the working tree for the operator. No Git write command,
commit, push, dependency installation, full test chain, release test, live
account, real provider, DNS lookup or network action ran. Every Node invocation,
including authoring scripts and syntax checks, used the mandatory network guard.
The focused tests printed `LANE_NETWORK_GUARD_ACTIVE`. Provider transport remains
injected, and canaries are generated at runtime. Database-image scratch uses
the existing `%TEMP%` helper. Verification finished around 06:41 MST on
2026-10-24, well before the 14:00 test cutoff.

## Changed files

| File and line | Change |
| --- | --- |
| `broker/quickbooks/src/broker.mjs:211` | Attribute launch audit events to the launch route. At 279, observe the cookie authentication boundary after cookie parsing. |
| `broker/quickbooks/src/protocol-schema.mjs:1470` | Matching local catalog: active and terminal intents, committed receipt requirements, connection and status read constraints. Exact equality with the source catalog passes. |
| `protocol/quickbooks-broker/implementation-adapter.mjs:109` | Expose the fixture's direct-read entry point through the adapter. |
| `protocol/quickbooks-broker/probes/harness.mjs:59` | Require replay refusal and unchanged full provider/owner state; at 70, exercise both disabled read paths. At 198, collect operation-specific audit witnesses; at 217, collect actual callback-private input; at 307, require distinct witnesses in both sinks and scan all captured response headers/bodies. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:134` | Empty/stale/concurrent audit-sink mutant and controls. At 164, clean-Location callback leak mutant covers code, state, company, headers, bodies and altered callback input. At 191, health/absent-route controls avoid inventing audit requirements. |
| `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs:65` | Well-formed wrong-cookie attack and reached binding check. At 148, refresh refusal/state/read invariants. At 211, revoke refusal, in-flight disabled reads and fresh-request consumed-proof replay. |
| `protocol/quickbooks-broker/probes/README.md:53` | Document nonempty audit evidence, exact response exception, replay invariants, direct-read adapter method, safe fence observation and cookie guard. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:8` | False-success replay mutant; at 26, launch-state retention before consent; at 39, concurrent launch response controls. |
| `protocol/quickbooks-broker/testing/owner-runtime.mjs:317` | Persist `disconnecting` during provider contact, then the terminal result. At 389, expose safe read status and fence fingerprint; at 398, split scheduled/direct entry points around the same credential/status/fence guard. |
| `protocol/quickbooks-broker/testing/protocol.test.mjs:59` | Non-BMP key/value UTF-8 round trips and lone-surrogate refusals for both fixture and broker canonical encoders. |
| `protocol/quickbooks-broker/testing/schema.test.mjs:188` | Active-key controls, post-destruction fixtures and terminal-key refusals; at 235, mandatory committed replay receipt; at 249 and 263, status/read controls. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:293` | Terminal key destruction and receipt retention; at 351, disabled-read requirements; at 469, stored `committed` versus model `complete` terminology. |
| `protocol/quickbooks-broker/v1/schemas/protocol.schema.json:1469` | State-discriminated owner intents. At 1675 and 1993, state-discriminated connection/status read constraints. |
| `partner-reports/qbo-broker-foundation-2.md:1` | Round 2 evidence and prepared commit. |

No owner migration, deployed owner route, CLI, manifest, connector availability,
package version, publication allowlist or public changelog changed. The owner
runtime remains an isolated integration fixture with its own internal storage
shape; the catalog changes do not install a production owner schema.

## Requested items and red-to-green evidence

### a. Privacy evidence

An audit expectation now comes from the requested operation. It needs fresh,
distinct event witnesses with the expected route/phase/outcome in durable rows
and identical captured logs. Empty sinks, stale events, a missing operation and
concurrent operations sharing one event are rejected. Health and absent routes
have no invented audit expectation, while a privacy check still needs an
audited operation. An unavailable audit sink cannot establish a privacy pass.

The stronger check exposed a real route-label defect: successful launch audit
events used the start route. The connect probe failed at the required launch
witness until the handler recorded the launch route.

Every captured broker/owner response body and header is scanned for credentials
and callback code, state and company values. Callback admission records every
nonempty supplied value, including changed/duplicate values. Launch state is
also scanned in retained evidence before consent. Only its exact parameter in
the validated provider launch Location is exempt, bound to that specific
Response object. No body or other header is exempt.

Initial harness regressions: 8 pass/3 fail, then passing after implementation.
The stricter integrated audit run exposed the launch label: 15 pass/8 fail;
the isolated connect probe was 0 pass/1 fail, then the combined group passed
23/23. Review regressions for shared concurrent evidence and pre-consent state
were 13 pass/2 fail, then 24/24 in the integrated group. The health-route
expectation regression was 16 pass/1 fail, then 26/26 integrated. The altered
callback leak regression was 11 pass/1 fail, then 12/12 in the harness.

### b. Intent destruction

Pending and saved intents require both ciphertext keys. Committed, canceled,
failed and expired intents reject either key, including null placeholders,
and retain only protocol, intent, status and receipt replay fields. Committed
intents require non-null delivery ID, envelope hash and token-delivery receipt;
a completion receipt cannot substitute for it. Other terminal states allow
null receipt material when no delivery was accepted. Post-destruction fixtures
cover every terminal state, with valid controls before missing/reintroduced-key
and missing/null-receipt refusals.

Initial schema run: 16 pass/2 fail. An unavailable Python authoring command left
the schema unchanged, so the first schema-plus-crypto run remained 25 pass/2
fail. A guarded Node authoring script applied the source/catalog-copy change,
then 27/27 passed. Final review added the committed-receipt regression: 29
pass/1 fail before correction, then 30/30 passed. Schema-copy equality stayed
part of every combined green run.

### c. Replay decisions

The second refresh and unproven second disconnect must return refusal and
preserve the entire inspected owner state and provider snapshot. This includes
generation, fence-content fingerprint, status, schedule/direct-read state and
remote revocation outcome. Failed refresh readback also gets the second-request
check. The former count-only oracle was extracted unchanged first; a handler
mutant returning 204 without new provider contact survived it. The regression
was 14 pass/1 fail. Requiring refusal and unchanged state killed it: 15/15 pass.

The no-contact proof control permits one fenced retry. A replay uses another
fresh signed request ID so it reaches proof consumption, receives 409/replayed,
and leaves the original row exactly unchanged in `proof_consumed` with zero
original provider attempts. `proof_consumed` is the retained ledger phase;
the existing public refusal code remains `replayed`.

### d. Disabled reads

Both catalog surfaces permit enabled reads only in connected/delayed states;
the other states require false. Valid connected reads and disabled-state
controls precede every schema refusal. The schema-plus-crypto regression was
27 pass/2 fail, then 29/29 passed.

The fixture exposes scheduled and direct read entry points sharing the same
status/fence guard. After each uncertain refresh, including failed readback,
both refuse with unchanged owner state and no outbound/provider counter change.
The disconnect test holds the real injected revoke transport in flight and
checks the stored status, fence and both read paths before releasing it.
The first run was 8 pass/1 fail because the fixture prematurely reported
disconnected. Persisting disconnecting until the result made the E2E/privacy
group 15/15. Confirmed, rejected, uncertain and proven-no-contact disconnect
states all remain read-disabled.

### e. Canonical Unicode

The reported surrogate-pair rejection was not reproduced: the existing regex
already has the Unicode flag, so a valid pair is one non-BMP code point outside
the surrogate range. No encoder behavior change or fabricated behavioral red
is claimed. Explicit non-BMP values and keys round-trip through UTF-8 and keep
identical canonical bytes in both encoders. Lone high/low surrogates, reversed
pairs, repeated halves and lone-surrogate keys refuse. The focused suite passed
6/6 on the existing implementation.

### f. Wrong cookie

The new attack-shape assertion failed first: 0 pass/1 fail, after the successful
connect control. The attack now keeps the actual cookie name and four-part
sealed-cookie syntax, changes a tag byte and reaches the observation immediately
before authenticated cookie opening. The missing-cookie arm remains separate.
The complete E2E file then passed 9/9 with no exchange for the wrong cookie.

## Complete focused test inventory

The following abbreviations expand to exact command text and file arguments.
They are report notation, not shell aliases. Results list every invocation of
each command in execution order within that row; parallel schema work is
grouped by command. Every result had zero skipped tests and zero TODOs.

| Symbol | Exact expansion |
| --- | --- |
| `N` | `node --import file:///C:/offload/lanes-1023/no-network.mjs` |
| `H` | `protocol/quickbooks-broker/probes/harness.unit.mjs` |
| `E` | `protocol/quickbooks-broker/probes/broker.e2e.probe.mjs` |
| `P` | `protocol/quickbooks-broker/testing/broker-privacy.test.mjs` |
| `S` | `protocol/quickbooks-broker/testing/schema.test.mjs` |
| `C` | `broker/quickbooks/test/crypto.test.mjs` |
| `U` | `protocol/quickbooks-broker/testing/protocol.test.mjs` |

| Command | Every observed result, passed/failed |
| --- | --- |
| `N --test H` | 8/3 initial privacy red; 11/1 altered-callback red; 12/0 green. |
| `N --test H E P` | 15/8 launch-audit mismatch; 23/0 after correction. |
| `N --test --test-name-pattern="E2E connect" E` | 0/1 missing launch-route witness. |
| `N --test H P` | 13/2 concurrent evidence and launch-state regressions; 16/1 health expectation regression. |
| `N --test H P E` | 24/0 after first review fixes; 26/0 after health/response-binding correction. |
| `N --test S` | 16/2 active/terminal intent regressions. |
| `N --test S C` | 25/2 unchanged schema after unavailable authoring tool; 27/0 intent fix; 27/2 read-state regressions; 29/0 read-state fix; 29/1 committed-receipt regression; 30/0 receipt fix. |
| `N --test P E` | 14/1 count-only replay oracle; 15/0 strict replay refusal. |
| `N --test E` | 8/1 in-flight disconnect status; 9/0 final cookie correction. |
| `N --test E P` | 15/0 after disconnect status correction. |
| `N --test U` | 6/0 non-BMP and lone-surrogate controls. |
| `N --test --test-name-pattern="E2E callback" E` | 0/1 malformed wrong-cookie attack shape. |
| Final eleven-file command below | 124/0, no skips or TODOs. |

The final command exactly matches the round 1 report:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
```

`N --check <file>` passed for all ten changed JavaScript modules: broker,
local schema copy, adapter, E2E probes, harness, harness units, privacy tests,
owner runtime, protocol tests and schema tests. Scoped and final
`git diff --check` passed. Added-line language/path checks passed. No new
instance artifact, credential, generated dependency or unrelated file appears
in the changed-file list.

## Named mutants

These three round 2 mutants execute in the final command. Each has a passing
control and is killed by the same oracle used for the corresponding probes.
Inherited round 1 mutants also remain green.

| Mutant | Injection and observed kill |
| --- | --- |
| `EMPTY_AUDIT_SINKS` | Clear either or both captured sinks, suppress a later same-route operation, or let concurrent operations share one event. The valid audited operation passes; each mutation causes assertPrivate to throw. Initial empty-sink and later concurrent-evidence red tests proved the previous oracle missed these cases. |
| `CALLBACK_RESPONSE_LEAK` | Keep an approved clean 303 Location while leaking generated code, state or company values in the body or another header. Also change the incoming callback value before echoing it. The clean control passes and every leaking response makes assertPrivate throw. Initial and altered-input red runs proved the old scans missed these leaks. |
| `REPLAY_FALSE_SUCCESS` | Let the actual owner handler refuse a repeated refresh/disconnect, then replace only its response with 204. Provider counters stay unchanged. The genuine refusal passes; the mutated result makes refusedUnchanged throw. The count-only oracle demonstrably missed this before correction. |

## Prepared commit

Subject: `Close QuickBooks broker privacy and replay probe gaps`

Body:

```text
Require fresh audit witnesses and complete callback-private response scans.
Make intent key destruction, receipt replay and disabled-read states explicit
in both matching protocol catalogs.

Strengthen refresh, revoke, consumed-proof and cookie probes against actual
offline handlers. Record 124 focused passing tests and three killed mutants
while keeping production deployment and owner integration closed.
```

The operator can rerun the final command and commit these working-tree changes
on `partner/qbo-broker-foundation-2`. No commit or push was attempted under the
read-only Git instruction. No requested item remains unfinished. The external
design's deployment, provider approval and real-account gates remain separate.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran the final eleven-file command with the network guard on the unchanged working tree: 124 passed, 0 failed, 0 skipped, 0 todo. The guard was active and blocked nothing. The three round 2 mutant tests run inside that command and pass, so each mutant was killed. Names, banned-word, email, user-path and key scan of every added line and new file: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator.

LANE QBO-BROKER-FOUNDATION-2: READY
