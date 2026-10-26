# Part B route-readiness contract

- Status: Proposed, with two named implementation gaps
- Date: 2026-10-24
- Owners: Product and engineering
- Confidence: High for sealed code paths, medium for physical Windows behavior
- Supersedes: None

## Problem

Part B changes the answer and verifier models, but model setup alone does not
prove which route an operator's Claude Code session used. The installed Windows
client uses the local stdio `brain_think` tool. Its local timing route is
`mcp.brain_think`, and its backend timing route is `think`. The direct remote
`mcp.ask` route is a different transport and cannot prove the Windows path.

The sealed implementation can prove the deployment-time model pair. It does
not safely refresh an existing Windows `CLAUDE.md`, force an already open local
MCP process to reread the changed manifest, or expose both actual model roles
in operator-visible tool content. It also has no production collector for the
visible receipt and no production decision that owns the full ordered proof.
A plausible cited answer is therefore not route proof.

## Decision

Part B is route-ready only when one production-owned operation establishes all
four facts in this order:

1. The exact post-setup manifest selects `claude-opus-5-5` for answers and
   `claude-sonnet-5-5` for checks.
2. The real Windows workspace writer accepts and reads back an ask-first refresh
   of the existing installer-managed `CLAUDE.md`.
3. The prior local MCP process is fully stopped, then a new process is created
   from the production MCP registration descriptor and initialized after the
   accepted guide generation.
4. The actual `freshTool.result.content` from that new process contains one
   authorized, content-free receipt proving the local route, backend route,
   both model roles, and zero fallback search calls.

No test-local parser, local route predicate, callback that replaces ownership,
or hand-built receipt can satisfy any of those facts. Setup success may report
that the model pair is configured, but it must not print `PART B PASS` until
the one production decision accepts the ordered proof.

The pass predicate is fail closed. Missing, malformed, duplicated, stale,
conflicting, unauthorized, or unrecognized evidence is a refusal, not partial
success.

## Production ownership and new interfaces

Implementation must add the focused module
`operations/partb-route-readiness.mjs`. It owns two new exports:

- `validatePartBRouteReceiptContent(content, { diagnosticsAuthorized })`
  inspects the actual MCP tool content. It collects every `route_receipt`
  occurrence across all content items. It accepts exactly one recognized
  occurrence only when authorization is true and every field passes the closed
  schema below. Receipt-bearing malformed JSON is conflicting evidence. One
  valid receipt plus any duplicate, stale, malformed, nested, or unrecognized
  route evidence is refused. The return is content-free and identifies only
  accepted or refused plus a closed reason.
- `provePartBRouteReadiness({ manifestPath, guideRefresh, control }, {
  stopMcpProcess, openMcpTransport })` is the only Part B pass decision. It
  rereads the exact post-setup manifest, consumes the real guide refresh from
  its installed caller, invokes `stopMcpProcess`, then calls exactly
  `openMcpTransport(mcpRegistrationDescriptor(...))`. The production decision
  owns that descriptor and supplies it as the transport boundary's sole
  argument. The boundary must not construct or substitute the launch
  descriptor. The returned transport exposes only `request(method, params)`
  and `close()`. The decision initializes it, calls the supplied `brain_think`
  control, closes it, and passes that exact tool content to
  `validatePartBRouteReceiptContent`. It owns the guide and process generation
  ordering. Its tests may inject only filesystem behavior, process stop, and
  MCP transport boundaries.

`cmdConnectAnthropic` must call the real `writeClaudeWorkspaceGuide` dependency
after the accepted model-pair readback. The dependency remains injectable for
tests, but the decision stays in `operations/claude-workspace.mjs`. The command
returns a content-free `guide_refresh` with schema version, operation, accepted
outcome, managed status, ask-first route, and a positive guide generation. It
must not copy the writer's path or workspace into operator-visible JSON.

The installed `brain connect anthropic` path ends fail closed after accepted
model setup and guide refresh. Its result says route not ready, identifies a
full Claude Code exit and relaunch as still required, and names
`brain mcp-config <manifest> --apply` as the continuation. It never calls the
route-ready authority from the process that changed the guide and never prints
`PART B PASS`.

`cmdMcpConfig --apply` is the one installed caller of
`provePartBRouteReadiness`. After its real apply branch successfully wires
Claude Code, it calls the real workspace writer to obtain a fresh `written` or
`verified` ask-first guide receipt, then passes that receipt to the authority.
The authority obtains its command, arguments, and registration environment
from `mcpRegistrationDescriptor`; it does not hand-build them. Its injected
transport receives that production descriptor as its one argument and launches
only from that received value. A test may compute an expected descriptor for
comparison, but it may not supply the launch descriptor. The Windows PowerShell
renderer remains part of the saved-registration path. A failed or skipped
Claude Code apply, unsafe guide result, absent full-exit boundary, or refused
route receipt returns route not ready and cannot print `PART B PASS`.

The route change must not alter any established export in a separately merged
retry helper. In particular, an existing `renameWithRetry` interface remains
unchanged. If safe guide refresh needs the partner's proof-aware policy, it
first calls `captureStagedProofWithRetry` after the staging descriptor is closed,
then supplies that proof and the intended bytes through the existing `staged`
option of `renameWithRetrySync`. Async callers use the same staged proof with
the existing `renameWithRetry`. Both rename exports keep their established
signatures and return and error behavior. The current pinned route branch does
not contain `operations/rename-retry.mjs`, so that integration is a premise to
verify after the partner change is merged, not an interface this contract test
may fabricate.

The workspace writer's `revalidate` checks its lock, parent, staging identity,
and destination state, but it must not make a separate content read that can
turn a transient Windows sharing refusal into a terminal `not_written` result
before the staged-proof retry runs. `captureStagedProofWithRetry` and the staged
proof check inside `renameWithRetrySync` own transient staging-read retries. A
definite byte mismatch is different: it refuses without publishing, leaves the
managed guide byte-identical, and cannot be converted into a retry success.

## Route receipt

A successful `brain_think` tool response contains one top-level JSON member
named `route_receipt` in operator-visible tool content. Its value has exactly
these fields and no others:

```json
{
  "schema_version": 1,
  "route": "mcp.brain_think",
  "backend_route": "think",
  "outcome": "ok",
  "answer_provider": "anthropic",
  "answer_model": "claude-opus-5-5",
  "answer_calls": 1,
  "answer_errors": 0,
  "check_provider": "anthropic",
  "check_model": "claude-sonnet-5-5",
  "check_calls": 1,
  "check_errors": 0,
  "fallback_search_calls": 0
}
```

`answer_calls` and `check_calls` may be greater than one. All call and error
counts are nonnegative integers. The two role call counts must each be at least
one, and both role error counts and `fallback_search_calls` must be zero.

The real MCP runtime constructs this receipt from its real local timing and
backend timing only. A test fixture may assert the expected value, but it may
not supply that value to a product decision. The receipt is visible only when
the active profile has `diagnostics:read`. The same real stdio tool call under
a profile without that capability must contain no route receipt.

The receipt omits question text, answer text, citations, record data, request
identifiers, durations, hosts, file paths, and resource names. Out-of-band
timing may remain available for diagnostics, but it does not substitute for
the visible receipt.

A deterministic answer, refusal, missing verifier, wrong model, built-in
route, search-first route, fallback search, nonzero role error, or unrecognized
receipt cannot satisfy this predicate.

## Guide and process ordering

A guide refresh is acceptable only when the real writer saw an existing
installer-managed regular file, reached the Windows ownership and native
attribute decision, installed the ask-first managed section, and returned
`written` or `verified` after exact readback. Controlled safe and refused tests
inject only the native filesystem boundary. They do not replace the ownership
decision.

The Windows staging boundary has two distinct outcomes. A one-shot `EACCES`,
`EPERM`, or `EBUSY` while reading the same staged inode is retried within the
shared helper's fixed budget and can complete only after exact bytes are proved.
A real same-inode byte change is a terminal preservation refusal. The focused
test injects only those filesystem events and asserts that both arms reach the
real workspace writer's staging decision.

Unrelated, damaged, linked, foreign, and concurrently edited guides remain
byte-identical. A preservation refusal is a safe outcome, but it reports route
not ready and cannot produce `PART B PASS`.

The relaunch boundary follows the accepted guide generation. Reinitializing
the old stdio process, opening another window backed by the same process, or
merely confirming that the manifest changed is insufficient. The production
readiness operation must stop the old process through its injected boundary,
create a fresh transport with
`openMcpTransport(mcpRegistrationDescriptor(...))`, initialize that transport,
and use that transport's actual `brain_think` result. A test cannot replace
those events with booleans, a hand-built session receipt, or a test-owned
launch descriptor.

## Decision table

| Evidence | Required result | Any other result |
|---|---|---|
| Post-setup manifest | Exact answer and check pair reread by production | Route not ready |
| Managed guide refresh | Real safe writer returns accepted ask-first readback | Route not ready |
| Client lifecycle | Real stop boundary, then descriptor-based initialization | Route not ready |
| Visible control receipt | Strict collector accepts exactly one actual fresh-tool receipt | Route not ready |

## Executable contract and named gaps

`test/partb-route-contract.test.mjs` contains no local receipt validator and no
local Part B pass predicate. It exercises these sealed decisions directly:

- `mcpRegistrationDescriptor`, the Windows `cmdMcpConfig` renderer, and
  `cmdMcpConfig --apply` through its installed route-authority call, with only
  external agent wiring, filesystem behavior, process stop, and MCP transport
  injected;
- `writeClaudeWorkspaceGuide` with controlled safe and refused native Windows
  attribute results, a transient staging read lock, and a real same-inode
  staging mismatch, including byte preservation on refusal;
- `cmdConnectAnthropic` and `runAnthropicAnswerSetup` through the real manifest
  write and accepted model-pair path;
- an old real `components/brain-mcp.mjs` process plus a fresh real process
  launched only from the descriptor received at the production transport
  boundary; and
- authorized and unauthorized real `brain_think` calls with nonzero initialize
  and tool counters.

Three real-path assertions are intentionally red on sealed bytes: the authorized
MCP response lacks the visible receipt, successful connect never reaches the
managed guide writer, and a transient staging read lock ends the real workspace
refresh before its rename retry can run. Four explicit controls pass on sealed
bytes for the registration, guide ownership, staging-content refusal, and
unauthorized-profile decisions.

Two gaps remain named rather than faked:

1. `operations/partb-route-readiness.mjs` and its strict receipt collector do
   not exist, so the duplicate, stale, and malformed evidence test fails at
   runtime after a real MCP call. Once implemented, that test derives every
   conflicting arm from the real tool content rather than a hand-built receipt.
2. The one production operation that binds guide generation, process stop,
   fresh initialization, and actual tool content does not exist, and
   `cmdMcpConfig --apply` does not call it. Its accepted and duplicate named-gap
   arms first drive the installed `cmdConnect` Anthropic route, require its
   fail-closed full-exit continuation, then drive the same real
   `cmdMcpConfig --apply` operation. Both arms require the transport boundary to
   receive exactly one production-owned descriptor equal to the expected
   `mcpRegistrationDescriptor`, and the callback launches the child only from
   that received value. Both require the exact `stop`, `open`, `initialize`,
   `brain_think`, `close` order with nonzero guide and apply decisions. The
   accepted arm requires readiness from the exact actual fresh tool content.
   The second arm duplicates that actual content before returning it through
   the transport and requires route not ready, binding the installed caller to
   `validatePartBRouteReceiptContent`. Both fail on sealed bytes because the
   installed caller never reaches the injected stop and transport boundaries.
   No direct import can satisfy the owner-path assertions, and no green
   route-ready control is claimed until the installed caller and production
   decision exist.

These are product implementation gaps. Closing them is outside this
contract-only lane.

## Windows proof boundary

The focused suite verifies the production descriptor, apply branch, PowerShell
rendering shape, and simulated Windows ownership decision. It does not prove
physical PowerShell 5.1 execution, a non-elevated Windows profile, full Claude
Code exit, or a client-launched fresh MCP process. Those remain required host
gates after implementation. A local macOS process cannot replace them.

## Consequences

- Deployment-time model checks remain necessary but are not route proof.
- A fresh process alone is insufficient while the managed guide still says
  search first.
- A safe preservation refusal leaves protected guide bytes unchanged and keeps
  Part B incomplete.
- Receipt authorization is enforced at the real MCP profile decision.
- Conflicting receipt evidence is refused even when one occurrence is valid.
- Product implementation remains deferred. This record changes no runtime
  behavior and supplies no release evidence.

## Revisit when

Replace this proposed contract only after a reviewed implementation, focused
green tests, the full host gate, all required CI jobs including Windows, and a
physical Windows operator proof establish an equal or stronger content-free
route guarantee.
