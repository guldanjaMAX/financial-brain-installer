# Technician runbook

Use this with the owner present for every human ceremony. Start read-only and
complete one stage before opening the next one.

Claude Code is the primary guided surface. Before any provider page, hidden
prompt, or system window, name the provider, explain why the step is needed,
state the minimum permission, and give the owner one next action. When browser
control is available, offer to navigate the official page and fill non-secret
fields after exact approval. Stop before every sign-in, 2FA, credential reveal
or entry, consent, billing, financial-provider handoff, and secure passkey
window. Explain what is happening and why before asking for the owner's click.
If the screen differs
from the explanation, stop and explain before continuing.

## 1. Readiness

1. Confirm the host computer, a current browser, internet access, and a separate
   passkey-capable device if the owner wants one.
2. Use a normal current-user terminal. Do not use `sudo`, root, or Run as
   administrator.
3. Before the first `brain tools` run, explain that it is a local setup action,
   not a read-only check. It installs or updates the reviewed technician skill,
   and may write local bootstrap status and may update the current user's PATH to
   include the Brain CLI folder. Ask the owner to approve those local
   changes, then run it. Before any resource creation, it also verifies Node.js
   22 or newer, at least 2 GiB free on the actual per-user install drive
   (`LOCALAPPDATA` on Windows), Claude Code, Claude sign-in, the installed
   `financial-brain-technician` skill, Anthropic's doctor, and pinned Wrangler 4.
4. Ask whether this is the owner's first Cloudflare account or an account they
   already control. Let the named sign-in verify the exact account first. Before
   provisioning, setup opens that account's Workers & Pages > Plans page and the
   owner confirms it says Paid. The narrow sign-in cannot read billing status.
   Do not infer the plan from product access.
5. In Claude Code, run `/skills` and confirm
   `financial-brain-technician` appears. Then start
   `/financial-brain-technician` with the reviewed packet and manifest paths.

The skill must begin with a read-only plan. Skill presence proves that the
instructions are installed, not that Cloudflare, a provider, or a passkey works.

## 2. Cloudflare account and browser approval

For most owners, choose **Create my first Cloudflare account**. The installer
opens Cloudflare's official sign-up page so the owner can create the account,
verify the email address, and complete Cloudflare's own sign-in protection. If
the owner already has Cloudflare, choose **Use a Cloudflare account I already
have** and sign in normally. When a login can reach more than one account, pause
while the owner confirms the exact account by both name and ID.

After Cloudflare verifies the selected account, setup opens Workers & Pages >
Plans for that exact account. The owner confirms it says Paid before any
resource is created. Browser control may navigate there after approval, but the
owner handles sign-in, 2FA, any plan change, payment, billing approval, and
Cloudflare consent. The installer's narrow named session cannot read billing
status and must not claim the plan is verified from successful Workers or
Vectorize access.

One Cloudflare account may hold several Brains. Each one still receives a
separate Worker, D1 database, Vectorize index, secrets, hostname, and saved
resource IDs. Recommend another Cloudflare account only when separate billing
or administrators would help.

Wrangler opens Cloudflare in the owner's browser and keeps this Brain's named
profile in the Mac or Windows OS keyring. The installer uses the short-lived
access value only in memory and clears it after the exact-account action. The
owner does not need to copy any Cloudflare token into chat, Claude, Codex, or a
command.

An expiring account-scoped API token remains available for a reviewed legacy,
automation, or recovery path. If that exact plan calls for one, use only its
required permissions: Workers Scripts Edit, D1 Edit, Vectorize Edit, and Workers
AI Read, plus R2 Storage Edit only when this manifest uses R2. Set a short
expiry, normally two days. Let the owner enter the value only through the Brain
CLI's hidden prompt, or let reviewed automation use an approved no-history
launcher. It stays out of the command line, chat, environment files,
screenshots, and support notes.

Prepared-manifest, recovery-token, and approved automation setup paths must pass
the same machine checks and the same exact-account Workers Paid prerequisite.
Unattended setup needs the released CLI's non-secret account-bound confirmation
for the manifest account. A generic yes or a different account ID stops before
provisioning.

The named-profile and keyring contract passes deterministic local tests. A real
browser callback on the final Mac and Windows machines, plus live Vectorize
access under the exact Wrangler approval, remain field gates. Record those
results before describing the path as production-proven.

## 3. Install and app acceptance

Follow `https://financialbrain.ai/install`. Use only the pinned commands on the
page. Before setup, state which Cloudflare resources will be created and wait
for the owner's approval.

The install stage is complete only when all of these are recorded:

- exact installer version and package digest;
- Cloudflare account identifier and final owner-approved hostname, without a
  secret or raw credential;
- D1, Worker, Vectorize, and optional R2 checks;
- `brain doctor <manifest>` result;
- owner passkey enrollment on the final hostname;
- sign-out and sign-in with the physical passkey;
- app load on desktop and mobile width with keyboard-accessible controls;
- unknown or unavailable states presented plainly, without false empty states;
- no outstanding vector backlog before semantic-search acceptance.

Automated app tests do not replace the final-hostname passkey ceremony.

Immediately before the first enrollment, tell the owner that choosing **Create
my owner passkey** opens the device's secure passkey window and confirms owner
access to the private area. Tell them to follow the device window with Face ID,
fingerprint, device PIN, or screen lock, and to choose Cancel if the hostname or
prompt looks unexpected. Financial Brain and the Claude Code guide cannot see
or store the passkey, Face ID, fingerprint, or device PIN. The passkey step
connects no files, messages, accounts, or other device data.

Keep Optimize separate from this explicit access ceremony. Optimize may detect
a missing or outdated Brain CLI, technician skill, or MCP registration and
report it without changing anything. After the report, one clearly previewed
and approved bundle may repair the owner-selected technician skill, Claude MCP,
and Codex MCP items only when the exact target release advertises those repair
scopes. Do not invent a command, and keep CLI replacement separate. Optimize
uses the non-writing machine-continuity audit, MCP discovery, and configuration
inspection. Optimize never runs `brain tools`, `brain invite`, `brain devices`,
passkey enrollment, or device review.

## 4. Owner Financial Map

Establish the completeness denominator with the owner before calling the
financial picture complete. Begin with `brain_financial_map` in read mode. It
may show structured entities and accounts from earlier records, but each is a
possible mention until the owner confirms it.

Immediately before that read, say: "I'm about to read your current Financial
Map. This sends no Financial Map snapshot and changes nothing. Your assistant
may still show an approval prompt because it is authorizing a private read from
your Brain." A normal host approval prompt must not arrive without this
explanation.

Offer a guided interview and ask one short question at a time. Confirm:

- the finite tax-year horizon;
- whether the owner believes the full entity and account population is present,
  knows it is partial, or does not yet know;
- each current entity exactly once as included, excluded, or unavailable;
- each current account exactly once as included, excluded, or unavailable;
- any entity or account the owner expects but the current records do not show;
- each entity-year pair in the horizon;
- entity kind, status, what it holds, ownership, tax class, relationship, and
  parent, plus account assignment, kind, balance role, currency, and status,
  with an independent confirmed, unknown, unavailable, or not-applicable answer; and
- for each entity-year, filing units, required returns and forms, K-1 roles,
  books and any bookkeeping company, payroll applicability, and expected
  sources, each with its own confirmed, unknown, unavailable, or not-applicable
  answer.

Do not infer one answer from another or convert a document mention into owner
truth. Give owner-declared missing rows opaque local map IDs and keep their
missing ledger evidence visible. When the interview is complete, explain that
creating a full version 1 preview writes one expiring, non-authoritative review
copy to the owner's Brain. It changes no ledger, source, tax, books, payroll, or
account record. Ask for separate explicit approval before preview mode. The MCP response is deliberately compact: report its state, counts, unresolved count,
and expiration, but do not echo the submitted private map or place any selector
in chat. Ask the owner to open **Financial Map** inside their signed-in Brain to
see the complete exact map, its changes from the last confirmed map, and every unresolved item.

Activation is a separate owner choice. The signed-in Financial Map screen
explains that a fresh passkey confirms the exact preview, its full denominator,
and the current map head. It provides one explicit confirmation button and
independently verifies the activation receipt before showing success. The MCP,
Optimize, and installer admin key cannot activate it. Never copy an internal
review value into a URL or chat, and never open a raw API ceremony.

If browser control is available, offer to open the owner app, choose **Financial
Map**, and scroll through the entire current review draft. Stop before the confirmation
button. The owner alone decides whether to choose it and completes or cancels
the device passkey window. If the installed release does not advertise this
screen, stop and update through the supported release process instead of
inventing a workaround.

During later Optimize reviews, first ask one goal question, then give the
no-snapshot explanation immediately before the read and report the map status
and unresolved gaps. If the map is missing, stale, incomplete, or unresolved,
before making any financial completeness conclusion, offer the guided read-only interview. Never start it automatically. The interview creates only a
conversational working draft. End Optimize before preview mode, obtain separate
approval for the expiring preview, and keep activation behind another owner
decision and the fresh passkey ceremony. Keep all passkey and device checks out
of Optimize.

## 5. Source onboarding

Connect one source at a time. For every source:

1. Name the account, mailbox, folder, drive, export, or human custodian in
   ordinary language. Do not place credentials in the record.
2. Confirm who owns it, what is approved, what is excluded, and whether another
   person or organization controls access.
3. Run the source's dry run or preview. A preview is read-only and sends no
   private content.
4. Show the owner the proposed scope, exclusions, estimated size, and whether
   the path is native, export-based, watched, scheduled, or manual.
5. Ask for exact approval to connect or ingest that source.
6. Load it. If interrupted, rerun the same supported command so the source can
   resume from its own state.
7. Record created, updated, unchanged, refused, partial, unavailable, and failed
   outcomes separately.
8. Prove the same approved low-sensitivity item through the four-stage chain
   below.
9. Run the applicable exclusion or leak tripwires from the pre-interview.
10. Record the proof level and the next missing live acceptance step.

For that one item, record these states separately and stop at the first state
that is not proved:

1. **Received:** the source receipt reached a terminal state and names exact
   accepted, refused, unreadable, failed, and retryable counts. A connector
   counter is not a storage receipt.
2. **Saved:** the exact same item exists as the expected
   logical family in D1, has chunks, and carries the correct source and
   extraction provenance.
3. **Search ready:** that exact generation has a confirmed Vectorize receipt and
   no matching outbox work remains. Read health twice and require pending work
   to decline or stay at zero with no competing drain lease.
4. **Answer checked:** a distinctive phrase from that exact same item
   is returned by the supported search path with the expected source citation
   and provenance.

Do not substitute a green health response, an aggregate connector count, or a
different document at a later stage. Received is not Saved, Saved is not Search
ready, and Search ready is not Answer checked.

Use one scorecard row for every authorized source. Keep these four readiness
dimensions independent: **starter context**, **live updates**, **history**, and
**meaning search**. A recent useful result can make starter context ready while
older history is still loading. A complete D1 load can still have partial
meaning search while Vectorize catches up. A changing source without a proven
refresh schedule cannot be marked live-ready.

Each row also records the access zone, provenance label, items seen, retries,
elapsed time, owner minutes, technician minutes, and the next gap. Open
`https://financialbrain.ai/optimize` and give its request to the connected
assistant. Compare only supported returned findings with the source receipt;
the public page is assistant-launch guidance, not a signed-in source display.
If a source appears in documents but has no registered source kind or access
zone, record it as **unregistered** and stop scoped-sharing acceptance until it
is assigned and tested.

### Value-first source sequence

1. **Zoom client calls:** connect the webhook, reconcile the recent bounded
   window, and open one real transcript with the owner. Treat the initial
   30-day reconciliation and ongoing webhook delivery as separate proof. Import
   older recordings only after this current-call path is accepted.
2. **Email:** begin with recent, high-value mail and the authorized folders most
   likely to support the owner's goal and evidence-derived acceptance checks. Backfill a large mailbox
   in bounded resumable windows. Record fetched items, accepted items, retries,
   elapsed time, and active human time separately. Do not call live updates
   ready until a later change arrives through a proven refresh path.
3. **Messages:** use the released path the client actually has, such as live
   iMessage capture on Mac, an iPhone backup snapshot, or an approved WhatsApp
   export. State the proven history boundary and whether new messages can arrive
   automatically.
4. **Files:** prove one valuable folder first, then widen the approved scope.
   Use Google Drive, Dropbox, a locally synced Box folder, or another reviewed
   export according to what the client uses. Keep connector readiness separate
   from the completeness of the authorized file history.
5. **Bank feeds remain outside ordinary onboarding:** do not open Plaid Link or
   ask for a bank password, verification code, or setup key. Preserve a complete
   existing bank setup only for an already approved pilot. If any required piece
   is missing, stop and use a separately reviewed, version-scoped field plan.
   A future approved pilot must keep current-data proof, history proof,
   account-to-entity assignment, and disconnect verification separate.

The [client onboarding scorecard](../10-client-onboarding-scorecard.md) is the
shared install record. It uses aggregate counts and receipt IDs, never message
text, transcript text, filenames, addresses, credentials, or financial values.

An API is not required. A named human custodian, portal download, or periodic
export is a valid source when its owner, cadence, provenance, and gap state are
explicit.

### Source onboarding prompt

```text
Read onboarding/07-ingest-source-matrix.md and the current manifest. Begin read-only. Show me the sources that are configured, released but not connected, partial, unavailable, or export-only. Recommend one valuable low-risk source to preview first. Do not log in, connect, ingest, delete, schedule, or change a provider until I approve that exact action. Keep credentials and private source content out of this conversation. After an approved load, use the same approved low-sensitivity item for every checkpoint and stop at the first unproven state: Received means a terminal source receipt with exact accepted, refused, unreadable, failed, and retryable counts; Saved means that exact same item is the expected logical family in D1 with chunks and correct source and extraction provenance; Search ready means that exact generation has a confirmed Vectorize receipt, no matching outbox work, and two health readings show pending work declining or zero with no competing drain lease; Answer checked means a distinctive phrase from that exact same item returns through the supported search path with the expected source citation and provenance. Never substitute a different item, a connector counter, or a green health response. Report freshness, proof level, and the next unproven checkpoint.
```

## 6. Adaptive assisted acceptance

Start from the actual receipts and evidence, not owner homework. Claude Code
offers one evidence-derived check at a time and explains why it matters. The
owner may use it, reword it, replace it with a real question, or skip it. Zero owner-authored questions are required for install, acceptance, Optimize, or
handoff. Stop a check when its source is unavailable, its same-item chain is
unproven, the vector backlog is not ready, or an exclusion leaks. Record that
honest gap and the next safe action instead of inventing an answer.

Claude Code handles the safe technical details; the owner does not need to
know or type exact commands.

Golden 20 is an optional private regression exercise only when the owner wants
one. It is not the acceptance gate and may remain unfinished without blocking
handoff.
