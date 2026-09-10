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

Until every step below has version-scoped evidence, ordinary onboarding must
leave `corpora.bank_feed.enabled` false and must not run `brain connect bank`.
The native command is an acceptance entrypoint, not permission to invite a
customer. Use it first on the named disposable candidate under the approved
field plan, then on the separately approved production pilot.

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

## Candidate application-secret ceremony

The standard technician workflow now contains a held `plaid` step. This is a
candidate implementation and does not close any live field gate. Before it
accepts a secret, it requires the manifest to select the native Plaid provider,
the exact Sandbox or Production environment, a final Brain hostname, and these
two exact values recorded as saved in the same Plaid environment:

```text
https://<brain.domain>/app/connect/bank
https://<brain.domain>/api/webhooks/plaid
```

The first belongs in `registered_redirect_uris`; the second belongs in
`registered_webhook_uris`. For Production, the owner must also confirm during
that run that Plaid Dashboard shows Production access. This is an explicit
owner-reviewed gate, not an API claim inferred from possession of credentials.

The owner enters the Plaid client ID and environment-specific secret into two
hidden terminal prompts. Neither is accepted through argv, ambient environment,
chat, browser control, a screenshot, or a support note. The installer generates
an independent `BANK_FEED_WRAPPING_KEY_V2`, commits and reads it back through
the existing protected local credential-store machinery, and reuses it on a
retry. macOS uses Keychain, Windows uses a DPAPI CurrentUser encrypted file, and
Linux uses an atomic mode-0600 file.

The plan's exact command must include `--confirm-single-setup-machine`. That
confirmation records that one nominated owner computer is running one
supervised ceremony. A private per-Worker lock prevents overlapping runs on the
same computer during custody checks and update phases. There is no authoritative
remote compare-and-swap for a fresh first setup, so two computers could still
race after both observe an absent binding. This limitation keeps general Plaid
setup held. Never run the ceremony concurrently from another computer or
terminal.

Windows is also held at the secret-entry boundary. The shared terminal reader
has a documented real PowerShell case where input echoed even though raw mode
reported success. The ceremony refuses before Cloudflare control or either
prompt on Windows. Do not bypass that refusal with environment values. A native
masked Windows bridge and physical acceptance evidence remain required.

If the Worker already has `BANK_FEED_WRAPPING_KEY_V2` but this machine has no
matching protected local record, the ceremony stops without generating or
writing anything. Recover the owner's existing key custody first. Replacing it
blindly could make retained encrypted bank access references unreadable.

Before either hidden prompt, the ceremony checks exact Cloudflare binding
metadata and the deployed Worker's wrapping-key fingerprint. The authenticated
proof address is derived from the resolved Cloudflare account, Worker name, and
that account's workers.dev subdomain. It does not trust `brain.domain`, and the
request refuses redirects. The exact Worker's workers.dev route must be enabled
even when the public Brain uses a custom hostname. If it is unavailable, fix
Cloudflare route access and rerun `brain deploy`; the ceremony does not enable a
route while credentials are in scope. If an existing remote key cannot be
proved equal to the protected local key, setup stops before writing.

For an existing key, one matching response is not enough. The fingerprint must
remain equal across the bounded propagation window before the patch, then match
again after the patch. This catches a recent control-plane change while an old
runtime is still serving the prior key. It is not a remote compare-and-swap. If
another session may have just changed the wrapping key, stop and recover or
settle that exact custody instead of relying on the timer.

Cloudflare's script `secrets-bulk` operation applies exactly
`BANK_FEED_CLIENT_ID`, `BANK_FEED_SECRET`, and
`BANK_FEED_WRAPPING_KEY_V2` in one atomic patch. The step then performs an exact
metadata read of each of those three bindings and returns no value. Omitted
Worker secrets remain unchanged. The deployed fingerprint is then polled for a
bounded maximum of one minute. A failed or ambiguous response keeps the
protected wrapping key as desired state and tells the owner to rerun the same
ceremony with the same provider values on the nominated computer. A manifest
change after the patch is reported as potentially committed rather than as a
no-change result.

`brain secrets` does not accept any of these three bank-feed values from the
environment. The custom bank-provider model has no reviewed credential ceremony
and remains held; it must not be routed through this native Plaid step.

If a fresh Worker was deployed from a field-plan manifest that already enables
the bank feed, `brain secrets` first preserves its normal provider cleanup and
installs the durable core admin, read-only proxy, and passkey-session keys. It
then pauses at the missing bank-secret gate and points to the owner-only Plaid
ceremony. No bank-feed value is written on that path. This ordering keeps the
authenticated wrapping-key proof reachable without restoring the retired
environment-variable setup path.

Success proves only protected application-secret setup on that Worker. It does
not open Link, contact a bank, prove a webhook delivery, or open invitations.
The reviewed next order is owner passkey enrollment, then `brain connect bank`
with the account holder present, followed by every disposable-candidate and
production-pilot acceptance event above.

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
