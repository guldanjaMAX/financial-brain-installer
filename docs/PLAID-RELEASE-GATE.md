# Plaid connection release gate

General invitations to connect banks are held. The reviewed source candidate
is not a completed owner acceptance test. Track the executable regression and
release requirements as UPDATE-017 through UPDATE-022 and UPDATE-025 in
[`update-incidents.json`](update-incidents.json). `npm run audit:updates`
must remain held until reviewed evidence closes them.

"Held" here means the bank invitations are held, not that the tag is. UPDATE-022
is the owner journey against a deployed candidate with real institutions and a
separately approved production pilot, so it may carry a written version-scoped
deferral under [release gate section 11](RELEASE-GATE.md) only while invitations
stay closed, and that deferral's `unproven` text must say so. UPDATE-017 through
UPDATE-021 and UPDATE-025 are code gates on this repository and are deferrable
only when a release changes none of that code. Any release that touches the
Plaid protocol, ledger, custody, connection review or freshness paths is held by
them outright.

## What the product must establish

The seven steps below gate public invitations. Until every step has
version-scoped evidence, ordinary onboarding must
leave `corpora.bank_feed.enabled` false and must not run `brain connect bank` for a
customer. The one exception is the Brain owner connecting their own accounts
while present: they may set `enabled` to `true` with `provider: "plaid"` and
`environment` of `sandbox` or `production`, deploy, and run
`brain connect bank` themselves. That owner-present pilot is evidence toward
these steps, not permission to invite anyone else.

Application credentials are entered by the owner through `brain connect bank`.
Before it opens the browser, the command lists the Worker's secret names
read-only. If `BANK_FEED_CLIENT_ID`, `BANK_FEED_SECRET`, or
`BANK_FEED_WRAPPING_KEY_V2` is missing, it asks the owner for the Plaid client
ID and secret at a hidden prompt, generates a missing wrapping key locally,
writes the missing values to the Worker as secrets, lists the names again to
verify them, and prints names only. An existing wrapping key is never replaced,
because retained encrypted connection references depend on it. No command
accepts these values from environment variables, arguments, or chat. Generic
`brain setup`, `brain secrets`, and technician workflows still do not accept or
write them. Routine setup preserves a complete existing set, and all three
names must be present before a routine core-key rotation can begin. If any is
missing, it stops without changing a local or Worker secret and points the
owner to `brain connect bank`.
Recording the return URI in a manifest is non-secret evidence that it is
already on the matching Plaid dashboard's Allowed redirect URIs list. It does
not perform that registration or justify automatically renewing a Plaid
deferral for a new release. The webhook URI needs no dashboard registration,
because the Brain sends it in every new Link token request, so recording it is
optional.

## The owner-present journey, in order

These are the steps an approved owner-present pilot actually goes through.
Each one was missed or misread in a sandbox rehearsal.

1. **Keys before setup.** When `corpora.bank_feed.enabled` is `true`, run
   `brain connect bank <manifest>` BEFORE `brain setup` or `brain secrets`.
   Those commands stop while any of the three bank secret names is missing
   from the Worker, and only `brain connect bank` can write them.
2. **Keys are checked before they are saved.** The hidden prompt asks for the
   Plaid client ID and secret for the manifest's environment. Before anything
   is written, the command makes one harmless authenticated Plaid read
   (`/institutions/get`, count 1) in that environment. A refused pair is
   stopped at the prompt with the likely cause, a secret from a different Plaid
   environment, and nothing is written. Plaid uses one client ID in every
   environment, but each environment has its own secret.
3. **A wrong key is corrected with `--replace-keys`.** Run
   `brain connect bank <manifest> --replace-keys`. It asks for both keys again
   at the same hidden prompt, checks them the same way, and never touches
   `BANK_FEED_WRAPPING_KEY_V2`. `brain secrets` still refuses bank keys.
4. **The redirect URI must be allowed.** `https://<brain.domain>/app/connect/bank`
   MUST be on the Plaid dashboard's Allowed redirect URIs list for the same
   environment, because every Link request sends it. Plaid refuses to open Link
   otherwise, and the connect page now names that exact address.
5. **Phone verification.** Plaid Link shows a phone-verification pane. In
   sandbox the code is `123456`, and no text message arrives. In production,
   Plaid sends a real code to the owner's phone, and only the owner enters it.
6. **Pick the bank, not a saved connection.** Plaid's returning-user flow is
   keyed to the phone number entered in Link. It can re-share a connection that
   phone number made earlier instead of the institution the owner selected, and
   the Brain labels the Item with what Plaid returned. In one sandbox rehearsal
   the owner selected First Platypus Bank and the connection came back as Bank
   of America. Choose "Add new account" or the specific bank rather than a saved
   entry, and check that the connection's institution label matches before
   assigning accounts. If it does not match, disconnect it in the Brain app
   (Access, then Banks) and connect again. For sandbox testing, use a fresh
   test phone number, 415-555-0011 or one of 415-555-0131 through
   415-555-0138, with the code `123456`.
7. **Add an owner first.** A new Brain has no person, household, or business
   yet. The connect page opens "Add a person, household, or business" by
   itself when none exists. Every account needs an owner choice before its
   transactions enter the ledger, and `/api/bank-feed/status` lists a
   connection waiting on those choices under `needs_attention` with the count.
8. **Disconnect lives in the owner app.** It is not on the connect page. In the
   Brain app, open Access (the settings page), find Banks, and choose
   Disconnect. Saved history stays.

**Turning the feed off deletes the Plaid keys.** Setting
`corpora.bank_feed.enabled` to `false` and then running `brain secrets` or
`brain setup` DELETES `BANK_FEED_CLIENT_ID` and `BANK_FEED_SECRET` from the
Worker. `BANK_FEED_WRAPPING_KEY_V2` is kept so retained connections stay
recoverable. Turning the feed back on means the owner runs
`brain connect bank <manifest>` again and re-enters both keys.

A bank can report more decimal places than its currency has, such as a
retirement balance of 23631.9805 USD. The Brain keeps the exact decimal, stores
the figure rounded half-even to the currency's minor unit, and flags it. A
total that includes a rounded figure says so wherever the owner reads it, and
`/api/bank-feed/status` lists each connection's rounded balances under
`rounded_balances`, first as `staged` and then as `in_ledger`.

1. Deploy the exact packaged version and named Plaid environment to an approved
   disposable Brain. Read back its version, schema, required secret names and
   configuration without exposing secret values. Verify the registered redirect
   destination and that each Link token request carries the Brain's webhook. A
   Plaid developer account alone is not setup proof.
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
