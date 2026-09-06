# Plaid connection release gate

General invitations to connect banks are held. The reviewed source candidate
is not a completed owner acceptance test. Track the executable regression and
release requirements as UPDATE-017 through UPDATE-022 in
[`update-incidents.json`](update-incidents.json). `npm run audit:updates`
must remain held until reviewed evidence closes them.

## What the product must establish

1. Deploy the exact packaged version and named Plaid environment to an approved
   disposable Brain. Read back its version, schema, required secret names and
   configuration without exposing secret values. Verify the registered redirect
   and webhook destinations. A Plaid developer account alone is not setup proof.
2. Through the owner page, connect two institutions with at least four accounts.
   Create any missing owner entities in the same journey. Assign accounts to a
   person and two different owned businesses. Every unassigned account remains
   staged. No transaction or balance may appear under an inferred business.
3. Compare accepted account counts, money amounts, currencies, transaction
   changes, balance snapshots and history boundaries against the controlled
   source. Keep missing values and delayed provider history visibly incomplete.
4. Interrupt pagination, delivery, promotion, update and sign-in. Resume without
   duplicate rows, skipped changes or altered history. Exercise concurrent cron
   and manual syncs, and prove a fourth Item progresses while others wait.
5. Verify real signed webhook delivery into the deployed Worker and scheduled
   fallback after missed delivery. A simulated request or API-only Sandbox
   runner does not establish either boundary.
6. Repair an existing connection through Link update mode. Review repeated new
   connections and changed account identities before any historical continuity
   decision. Verify provider-confirmed disconnect retains accepted history.
7. Run the owner journey on Mac and Windows and record the actual browser and
   architecture. Complete a separately approved production pilot before broad
   invitations. Do not ask owners to share passwords, tokens or bank statements
   in support messages.

## Account and business boundaries

One bank login can return several accounts, and each account can belong to a
different active owned entity. The financial entity model includes people,
households, businesses, trusts, properties and investments, with optional parent
and ownership metadata. These are owner-confirmed facts, not legal ownership
verified by Plaid.

Each account currently has one entity assignment. A single mixed-use account
does not automatically split its personal and business transactions. Historical
reassignment requires review. Transactions access does not establish investment
holdings, tax correctness or complete net worth coverage.

Names and masked digits can indicate an accidental repeated connection, but
cannot establish account identity. Ambiguous matches must pause for review and
must never merge or delete history. The pre-exchange check is intentionally
conservative; changed masks, provider account churn and replacement Items still
need explicit continuity acceptance. See [Plaid's duplicate Item guidance](https://plaid.com/docs/link/duplicate-items/).

## Evidence

Keep detailed receipts private. A reviewed shareable receipt must identify the
commit, package SHA-256, deployment version, schema, environment, scenario,
actual entrypoint, result, and unresolved gaps. Include only synthetic or
sanitized aggregate counts. Reopen affected gates when the tested code changes.

Configured, local fixtures passed, provider API passed, deployed owner journey
passed, and production pilot passed are separate evidence levels. None implies
the next. Never label the invitation ready from a green unit suite alone.
