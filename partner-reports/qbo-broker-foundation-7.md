# QBO-BROKER-FOUNDATION-7 report

Unified exchange capture is complete. The final required eleven-file command
passed **239 tests, 0 failures, 0 skips, 0 TODOs**. Both graph checks passed and
confirmed all **460** inventoried test files are scheduled. The three named
mutants below are killed. Schema copy equality and all **24** private annotation
sites remain green.

Observed branch: `partner/qbo-broker-foundation-7`. Starting commit: `54976e6`.
The round 6 report was read first, followed by the read-only design contract,
README, developer README and architecture documentation. Independent review
checked schema classification, all transport boundaries, retained grants,
concurrent calls, receipt mutations and the independence of echo assertions.

All changes remain in the working tree for the operator. No Git metadata write,
commit, push, network operation, dependency installation, full test chain or
live account operation ran. Every Node invocation loaded the mandatory network
guard. Provider calls stayed behind injected transport and used only fake Intuit.
No scratch tree was created. Existing synthetic SQLite image checks use `%TEMP%`.
Final tests finished at approximately **11:35 MST on 2026-10-24**, before the
13:30 hard stop. Production remains closed.

## Changed files

| File and line | Change |
| --- | --- |
| `protocol/quickbooks-broker/probes/harness.mjs:60` | One channel walker, with independent recording before traversal. |
| `protocol/quickbooks-broker/probes/harness.mjs:218` | Common request/response capture, schema-based registration, full authentication values and payloads, repeated cookie headers and cookie aliases. |
| `protocol/quickbooks-broker/probes/harness.mjs:250` | Refuse uninspectable schema-selected owner request bodies before handler entry. |
| `protocol/quickbooks-broker/probes/harness.mjs:330` | Capture injected provider requests and replies, authenticated challenge traffic, delivery failures and owner receipt observations. |
| `protocol/quickbooks-broker/probes/harness.mjs:395` | Preserve every response observation before validation, with exact launch cookie and state grants. |
| `protocol/quickbooks-broker/probes/harness.mjs:455` | Capture and validate broker ingress, including direct adapter calls. Invocation-scoped single-use delegation prevents concurrent Request reuse from bypassing observation. |
| `protocol/quickbooks-broker/probes/harness.mjs:514` | Capture direct owner entry before the handler and its response on receipt. |
| `protocol/quickbooks-broker/probes/harness.mjs:585` | Require complete channel traversal before privacy verification; bind cookie aliases to one exact physical response header. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:17` | Whole-channel and individual-entry omission mutants for headers and cookies, each following a successful full connection control. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:41` | Owner callback/voucher duplicate-JSON regressions with valid and inspectable-invalid controls. |
| `protocol/quickbooks-broker/probes/harness.unit.mjs:76` | Sequential and concurrent reuse of the same Request must each preserve both captures. |
| `protocol/quickbooks-broker/testing/broker-privacy.test.mjs:151` | Twenty-seven real-handler header/cookie echo cases with unchanged controls and reachability counters. Header echo sinks use the reviewed public CSP field to prove prior source registration. |
| `protocol/quickbooks-broker/v1/schemas/protocol.schema.json:7` | Closed header/cookie models. Only eleven reviewed metadata header names are public; unknown headers are private. The exact payload-free transaction-cookie deletion header is public. |
| `broker/quickbooks/src/protocol-schema.mjs:8` | Identical broker-local catalog copy. |
| `protocol/quickbooks-broker/testing/schema.test.mjs:28` | Expand the reviewed annotation inventory to 24 sites, including header and cookie values. |
| `protocol/quickbooks-broker/testing/schema.test.mjs:116` | Header/cookie classification, public-name inventory, unknown-header defaults and exact clearing-header controls. |
| `protocol/quickbooks-broker/testing/schema.test.mjs:193` | Existing removal check now independently removes every one of the 24 markers. |
| `protocol/quickbooks-broker/probes/README.md:59` | Document every channel, registration timing, completeness evidence and response grants. |
| `protocol/quickbooks-broker/v1/PROTOCOL.md:42` | Document header/cookie privacy models and the shared capture contract. |
| `partner-reports/qbo-broker-foundation-7.md:1` | Evidence, operator handoff and prepared commit. |

No broker runtime handler, provider implementation, owner runtime, deployed
route, storage migration, manifest, package version or publication allowlist
changed. The broker-local schema gains only the reviewed channel definitions.

## Every captured channel

The same capture path visits these four channels for every recorded request
and response, including empty channels:

1. **Body:** original finite fixture text and strictly decoded JSON or decoded
   form fields. Form transaction JSON is inspected through its schema. Invalid
   but inspectable requests still register their private leaves.
2. **Headers:** every normalized header name/value, including Authorization,
   proxy authorization, Access headers and unknown future header names. Repeated
   Set-Cookie values retain separate physical entries through `getSetCookie()`.
3. **Cookies:** every Cookie pair and every Set-Cookie entry, linked to its
   original physical header. The registry keeps the full credential header,
   transmitted `name=value` pair and nonempty cookie payload.
4. **Query:** every decoded request query pair, including duplicate names.
   Callback state, code and company values inherit their private schema markers.
   Response Location remains included in the header channel.

Boundaries include enrollment, rig and direct broker calls, owner control
transport, rig and direct owner calls, private enrollment challenges, voucher
delivery, callback delivery and receipts, synthetic delivery faults, provider
exchange/refresh/revoke, and direct owner accounting transport. Requests are
captured before handlers or injected delivery failures. Responses are captured
on receipt, including after mutable fixture wrappers.

The registry retains full authentication credentials and their Bearer payloads;
Basic payloads are retained too. Requests never create response grants. Existing
grants survive legitimate request round trips. Each grant names one response
identity and one field. Cookie aliases share one physical Set-Cookie field and
its exact original bytes. Only the validated launch response can issue that
cookie grant. Its state grant names only the exact provider Location state
parameter. Other headers, cookies and body fields stay visible to the scan.

The authenticated internal challenge reply has one schema-checked local body
allowance for its challenge, without giving that request credential an outward
grant. Its headers are scanned. Direct owner callers cannot borrow the local
allowance. Provider replies are private transport inputs; capture registers
their private values before returning them to the broker or owner. They do not
become outward response exceptions.

The recorder builds expected channel bytes independently before invoking the
walker. Privacy verification compares every channel and its complete contents
with traversal evidence. Omitting an empty channel or one header/cookie entry
cannot shrink that denominator. Failed response observations remain sticky even
if a caller catches the assertion or repairs a mutable Response later.

## Red-to-green evidence

- Authentication and cookie echoes initially produced **0/11**, then **0/15**
  and **0/18** as coverage expanded. Every unchanged real-handler control passed;
  failures were missing expected privacy rejections. They now fail the privacy
  scan as intended, including full credentials, bearer payloads, full launch
  Set-Cookie, transmitted Cookie pairs and bare cookie values.
- Header and cookie channel omissions initially produced **0/2**. Both mutants
  now fail the independent coverage check after successful fake-provider
  connections. Individual-entry omissions are covered too: **6/0** including
  parent tests.
- Channel schema tests first failed **0/1** without the models, then the full
  schema file passed **25/0**. Exact clearing-header classification first failed
  **0/1**, then selected schema checks passed **6/0**. Unknown-header classification
  first failed **0/1**, then selected checks passed **7/0**. Copy equality passed
  after each schema change.
- Direct adapter broker entry bypassed request capture: the expanded echo run
  gave **18/2**, then **21/2** after adding owner response controls. Capturing
  direct entry made the same group pass **23/0**.
- Owner callback/voucher uninspectable bodies initially reached the accepting
  fixture. The first callback duplicate fixture accidentally added an unknown
  field, because that envelope has no top-level protocol field. It was corrected
  to contain an actual duplicate. With the new guard temporarily removed, both
  corrected cases again failed **0/3** after their valid controls. The guard was
  restored; both pass in the final foundation run.
- Concurrent use of the same Request exposed the temporary shared WeakSet
  implementation: **0/1**, with two successful handlers but one captured request.
  Single-use delegation scoped to each asynchronous invocation gives two captures
  and passes the sequential control and concurrent regression.
- Owner callback receipt wrappers could append a fresh private response header
  after the inner observation. The corrected red run gave **22/4**, with three
  missing privacy rejections plus the parent. Capturing the transport receipt
  after the wrapper kills all three. The earlier same-rig reconnect fixture
  also gave **22/4** but failed its reachability counters; separate fresh rigs
  now prove both actual callback successes and one mutation.
- Unknown `x-api-key` and future credential headers first gave **25/3** in the
  echo group. Private-by-default header classification kills both. Review then
  moved all header echo sinks to the reviewed public CSP field, preventing an
  echo from registering itself. The focused harness/privacy run passed **112/0**
  with those independent sinks, followed by the final **239/0** foundation run.

During integration, the combined mutant/control pattern gave **0/29**, **25/4**
and **26/3**. Those runs exposed selecting every header schema branch as private,
classifying a payload-free clearing header as a credential, a synthetic cookie
filler colliding with public JSON field names, and stopping traversal after a
body grant refusal. The corrected code selects matching header branches, models
the exact clearing header, uses opaque cookie fixtures, and completes remaining
channels while retaining the first failure. The combined harness/E2E/privacy
runs then passed **111/0** and, after added boundary cases, **127/0**.

## Complete test inventory

Every command below used `N`. Symbols are report notation, not shell variables.
Counts are passed/failed and include subtests and parents. All completed runs
had zero skips and TODOs. Repeated results are listed in execution order for
that command family; independent review work sometimes ran concurrently.

```text
N = node --import file:///C:/offload/lanes-1023/no-network.mjs
P = protocol/quickbooks-broker/testing/broker-privacy.test.mjs
U = protocol/quickbooks-broker/probes/harness.unit.mjs
E = protocol/quickbooks-broker/probes/broker.e2e.probe.mjs
S = protocol/quickbooks-broker/testing/schema.test.mjs
C = broker/quickbooks/test/crypto.test.mjs
H = HEADER_COOKIE_ECHO
K = CAPTURE_SKIP
O = schema-selected owner requests
R = HEADER_COOKIE_ECHO|CAPTURE_SKIP|clean starts|START_REQUEST_PRIVATE_ECHO|ENROLLMENT_REQUEST_PRIVATE_ECHO
S1 = exchange channel schemas|exchange cookie clearing|private schema|PRIVATE_ANNOTATION_REMOVED|schema catalog is versioned
S2 = exchange channel schemas|exchange unknown headers|exchange cookie clearing|private schema|PRIVATE_ANNOTATION_REMOVED|schema catalog is versioned
```

| Command after symbol expansion | Every result |
| --- | --- |
| `N --test --test-name-pattern="exchange channel schemas" S` | 0/1 red. |
| `N --test S` | 25/0. |
| `N --test --test-name-pattern="vendored closed catalog" C` | 1/0, 1/0, 1/0 after the three catalog changes. |
| `N --test --test-name-pattern=H P` | 0/11; 0/15; 0/18; 18/2; 21/2; 23/0; 22/4 fixture issue; 22/4 corrected receipt red; 25/3 unknown-header red. |
| `N --test --test-name-pattern=K U` | 0/2 red; 6/0 expanded omissions. |
| `N --test --test-name-pattern=R P U` | 0/29; 25/4; 26/3 integration failures described above. |
| `N --test --test-name-pattern="exchange cookie clearing" S` | 0/1 red. |
| `N --test --test-name-pattern=S1 S` | 6/0. |
| `N --test U E P` | 111/0; 127/0. |
| `N --test --test-name-pattern=O U` | 0/3 initial red; 1/2 fixture correction diagnostic; 0/3 corrected regression with the new guard temporarily removed, then restored. |
| `N --test --test-name-pattern="schema-selected owner requests|CAPTURE_SKIP" U` | 7/2 callback fixture issue; 9/0 corrected. |
| `N --test --test-name-pattern="concurrent reuse" U` | 0/1 red. |
| `N --test --test-name-pattern="concurrent reuse|CAPTURE_SKIP|schema-selected owner requests" U` | 10/0. |
| `N --test --test-name-pattern="exchange unknown headers" S` | 0/1 red. |
| `N --test --test-name-pattern=S2 S` | 7/0. |
| `N --test U P` | 112/0 with independent public echo sinks. |
| Eleven-file command below | 239/0 initially; 239/0 after final capture cleanup; 239/0 final rerun after independent echo sinks. |
| Graph command below | 2/0; 2/0 final rerun, both covering 460 files. |

Final required commands:

```text
node --import file:///C:/offload/lanes-1023/no-network.mjs --test broker/quickbooks/test/provider.test.mjs broker/quickbooks/test/crypto.test.mjs broker/quickbooks/test/store.test.mjs broker/quickbooks/test/boundary.test.mjs broker/quickbooks/test/broker-security.test.mjs broker/quickbooks/test/callback-quota.test.mjs broker/quickbooks/test/revoke-quota.test.mjs broker/quickbooks/test/routes.test.mjs protocol/quickbooks-broker/testing/broker-privacy.test.mjs protocol/quickbooks-broker/probes/broker.e2e.probe.mjs test/qbo-broker-protocol.test.mjs
node --import file:///C:/offload/lanes-1023/no-network.mjs --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs
```

Five guarded syntax commands, each `N --check <file>`, passed for
`broker/quickbooks/src/protocol-schema.mjs`,
`protocol/quickbooks-broker/probes/harness.mjs`,
`protocol/quickbooks-broker/probes/harness.unit.mjs`,
`protocol/quickbooks-broker/testing/broker-privacy.test.mjs` and
`protocol/quickbooks-broker/testing/schema.test.mjs`.
Each printed the active guard marker. No ad-hoc provider or connector probe ran.
`git diff --check` passed throughout review and on the final working tree.

## Named mutants and kill proof

| Mutant | Passing control and kill proof |
| --- | --- |
| `CAPTURE_SKIP_HEADERS` | Full successful fake-provider connection first passes privacy. Skipping the entire header channel or its first actual entry still reaches connection success, then fails independent channel-content coverage. Both omissions are executed and counted. |
| `CAPTURE_SKIP_COOKIES` | Same successful connection control. Skipping the entire cookie channel or one real cookie entry fails the independent denominator, including empty channels. Both omissions are executed and counted. |
| `HEADER_COOKIE_ECHO` | Twenty-seven cases, each with unchanged successful control and real-handler counters. Covers enrollment and owner authentication full/payload, direct broker entry, private challenge headers, launch cookie full/pair/payload through broker and owner, Access and unknown request headers, request-only cookies, and fresh response credentials in health, status and callback receipts. Request-source echoes use a reviewed public header, so only source registration detects them. Fresh private response headers are rejected on receipt. |

All three named mutants run within the final eleven-file command. Controls,
mutations, private values and registry contents stay in memory; assertions never
print their values.

## Prepared commit

Subject: `Capture every broker exchange privacy channel`

Body:

```text
Unify request and response privacy capture across bodies, headers, cookies
and query fields. Keep unknown headers private, preserve exact response
field grants, and verify traversal against an independent channel record.

Cover direct and concurrent entry, owner receipt wrappers, authentication
and cookie echoes. Record 239 focused tests, two graph checks and three
killed mutants with unchanged controls.
```

The operator can rerun the listed commands and commit the working-tree changes
on `partner/qbo-broker-foundation-7`. No commit or push was attempted because
this run explicitly makes Git metadata read-only.

Lane 6 is paused after round 7 pending the founder's 14:00 design review.
Token custody remains a review decision. No further lane work is scheduled here.

## Operator note

The Codex sandbox on this Windows machine makes `.git` read-only, so the lane could not commit. The operator (Claude Code) re-ran on the unchanged working tree: the eleven-file command with the network guard gave 239 passed, 0 failed, with the guard active and nothing blocked. `node --test test/test-chain-complete.test.mjs test/test-chain-runner.test.mjs` gave 2/2. The schema now carries 24 `x-private` annotations, and the round 7 mutant tests (skip-headers, skip-cookies, header and cookie echoes) run inside those commands and pass, so each was killed. `git diff --check` is clean. Names, banned-word, email, user-path and key scan: none. The operator made the prepared commit unchanged and added the Codex co-author trailer. No code was edited by the operator. Lane 6 is now paused until the founder's 14:00 QuickBooks design review.

LANE QBO-BROKER-FOUNDATION-7: READY
