# Shared install-entry fixtures

These 14 fixtures were supplied by the paired site lane. They contain synthetic
approval hashes, receipt identities, dates, source commits and artifact claims.
They are test inputs only. They are not release evidence or installable artifacts.

The current packaged reader accepts the exact held literal and explicit legacy
version-2 guides. It intentionally rejects the proposed version-3 HTML. The
`proposed-v3` rows in `expected-cases.json` remain requirements, not current
product behavior. Update manifests use schema 2; runtime receipts use schema 1.

Keep raw bytes unchanged. The manifest approval hash excludes only top-level
`approval`, recursively sorts object keys, and has no trailing LF. The runtime
receipt instead preserves the real writer's insertion order and pretty JSON
with one LF. The `.gitattributes` rule preserves LF on Windows checkouts.

`test/install-entry-fixtures.test.mjs` imports the real package validators and
is included by `test/install-page-version.test.mjs` in the existing test chain.
