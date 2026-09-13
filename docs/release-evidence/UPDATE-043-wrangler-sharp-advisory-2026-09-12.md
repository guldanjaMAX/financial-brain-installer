# UPDATE-043 Wrangler and Sharp advisory evidence

- Observed: 2026-09-12
- Candidate checked: `aa1937a52c47e299ae649b9acaa4794816ef7946`
- Incident status: open
- Pilot decision: bounded non-applicability requires explicit release-owner
  acceptance; broader beta and public release remain blocked on a requalified
  patched runtime

## Current evidence

Live `npm audit --json` reported three high-severity nodes in the development
and field-tooling dependency chain:

`wrangler 4.127.1 -> miniflare 5.20260828.0-alpha -> sharp 0.35.2`

The advisory is `GHSA-rgj7-g3m4-5g8c`. Sharp versions below 0.35.4 are affected.
Wrangler 4.131.1 resolves Miniflare to a patched Sharp 0.35.4. The Node floor
remains version 22.

The earlier `npm audit --offline` result of zero findings came from a stale
local advisory cache and is not current vulnerability evidence.

## Product and pilot boundary

- `npm audit --omit=dev --json` reported zero vulnerabilities.
- The 553-file package preview contains no Wrangler, Miniflare, or Sharp
  package.
- Wrangler is still fetched dynamically by owner setup and is included in the
  private locked field-runtime closure, so this is not dismissed as test-only.
- Miniflare dynamically imports Sharp only for its local Images binding and
  `cf.image` handlers.
- The frozen pilot uses remote Worker, D1, and Vectorize operations on macOS and
  Windows. It does not use Linux, `wrangler dev`, Miniflare Images, `cf.image`,
  or untrusted HEIF/AVIF input.
- A separate legacy compatibility path still pins `wrangler@4.73.0`, which is
  also in the affected range. The pilot cannot use that path under this
  exception.

These facts make the affected decoder unreachable in the exact frozen pilot.
They do not make the dependency generally acceptable.

## Bounded pilot exception

The incident is not applicable to the Monday pilot only when all of these stay
true:

1. no Linux host;
2. no `wrangler dev`;
3. no local Miniflare Images binding or `cf.image`;
4. no untrusted HEIF or AVIF processing;
5. no legacy `wrangler@4.73.0` route; and
6. the release owner accepts this exact exception before the first field rung.

Any violation stops the pilot. This exception is not general release evidence.

## Closure requirement

Before broader beta or public release, update every product-invoked Wrangler
pin to a patched reviewed contract. Then rerun the exact lock/runtime inventory,
named and legacy OAuth/config parsers, packed setup, full test chain, package and
privacy gates, six-job CI matrix, and field-runtime evidence. Historical
runtime hashes and receipts do not carry forward.

Official references:

- https://github.com/advisories/GHSA-rgj7-g3m4-5g8c
- https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.131.1

