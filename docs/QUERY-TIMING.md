# Query timing diagnostics

The query routes return an additive `timing` object for an authenticated admin
key. Read-only proxy keys, document grants and owner sessions receive their
existing responses. Remote MCP `ask` and `search` expose the same diagnostic in
`result._meta.timing` only to profiles with `diagnostics:read`. A librarian or
structured contributor receives no timing. Local MCP query tools expose timing
in the same metadata location for diagnostic profiles, including the local
owner assistant. Timing never enters the rendered answer or tool content.

Timing does not change retrieval, model selection, evidence admission or
refusal wording. It is request-local and does not write a new log or database
record. The existing spend ledger and ordinary connector activity records still
apply. No production logging option is enabled by this change.

`version: 1` has an opaque, server-generated UUID `request_id`, a fixed route
identifier, an `ok`, `refused` or `error` outcome, and durations in milliseconds:

- `total_ms` covers Worker entry through reading the response JSON, before
  adding timing and final serialization. It excludes network transit and the
  outer assistant's scheduling and reasoning.
- Each fixed `stages` entry has `calls`, `errors` and inclusive `ms`. A stage
  with zero calls did not execute. Zero milliseconds with nonzero calls can
  reflect the runtime clock's resolution, including Workers' coarse CPU timing.
- `covered_ms` is the union of measured intervals. `overlap_ms` is summed stage
  time minus that union, including nesting and concurrent fan-out.
  `unattributed_ms` is the rest of the request. Within rounding and saturation,
  stage sum minus overlap equals covered, and covered plus unattributed equals
  total. Stage times must not be added together as if they were sequential.
- `models` counts actual embedding/answer/verifier/rerank provider attempts,
  including failed attempts, and measures provider time separately from helper
  overhead such as spend accounting. Model identifiers come from a closed
  reviewed list; other configured identifiers are `unrecognized`. A provider's
  response cannot supply an arbitrary telemetry label.

`retrieval` includes embedding, keyword/vector fan-out, readiness and fusion.
`vector` includes hydration; `vector_query` measures actual binding attempts,
including a filtered-query fallback. `embedding` includes retry backoff while
its model entries count actual attempts. `authority_lineage` includes provenance
assessment, fusion, claim authority and public lineage projection.
`answer_llm` and `verifier_llm` cover the complete helper calls;
`evidence_gate` includes verifier time and deterministic admission.
`premise_temporal` covers the existing tax-scope, owner/context, governing-source,
current/operative and temporal checks. It does **not** imply a general premise
checker exists. `coverage` covers source and tax inventory reads; `gaps` covers
result-specific gap computation. `legacy_hybrid` is one opaque legacy RPC, whose
internal keyword/vector durations cannot be separated on the Worker.

Remote `mcp_wrapping` excludes internal think/search execution. Local MCP has
its own clock and request ID: its `mcp_backend` stage covers backend round trips,
`mcp_retry_wait` covers the existing search retry delay, and `mcp_wrapping` covers
local processing. Up to two projected Worker receipts are nested in `backend`,
retaining each Worker request ID. Never subtract timestamps from these clocks
or treat tool timing as end-to-end conversational latency.

The schema has fixed stage/route labels, at most 16 model entries, bounded
counts (65,535) and durations (24 hours per field). Local MCP carries at most
two backend receipts. No question, answer, source identifier, title, path,
credential, arbitrary request ID, provider error or document text is added to
timing. The new probe reprojects the receipt through the same closed schema.

Tests inject the monotonic clock through the optional fourth argument to
`worker.fetch`, or directly into the collector. Production uses
`performance.now()`. This injection is an in-process seam, never a JSON field,
HTTP header or environment variable. Wall time continues to govern existing
date-sensitive evidence rules.

## Operator probe

After the normal integration and deployment gates, an authorized operator can
run the repository script with the exact Brain origin and an existing private
admin-key file locator:

```sh
node scripts/query-spans-probe.mjs --url https://brain.example.invalid --admin-key-file /private/path/admin-key
```

The script performs six serial JSON POSTs: think and unified for each of three
fixed invented questions. It never accepts question text or a key value on the
command line. It accepts HTTPS origins only, refuses redirects, caps response
reads at 1 MiB, and stops on the first request failure, non-200 response or
missing/invalid timing. It does not retry or switch endpoints. Output contains
case labels, HTTP status, response byte count, client elapsed time and projected
timing only. Response content and the target/key locator are not printed.

The probe does not change corpus state, but the normal query routes can incur
model usage and write aggregate spend records. It is never run by tests without
injected file/network dependencies. These invented queries measure mechanics;
they are not a correctness evaluation or a latency percentile sample.

## Deadline handoff

The Workers AI branch of `callLLM` still awaits `env.AI.run` without using
`timeoutMs`. The Anthropic branch attaches `AbortSignal.timeout`. An offline
provider returning after 8,000 injected milliseconds is accepted with a 1,000 ms
timeout, while a 500 ms success control is also accepted. Both reach the actual
helper and call the provider once. Timing instrumentation leaves that defect
unchanged. QUERY-DEADLINE must address typed deadlines, late-result accounting,
verifier refusal and binding cancellation limits together. This lane does not
claim the latency targets are achieved or authorize a live probe or deployment.
