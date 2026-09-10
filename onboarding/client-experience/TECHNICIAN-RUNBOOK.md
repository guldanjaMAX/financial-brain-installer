# Technician runbook

Use this with the owner present for every human ceremony. Start read-only and
complete one stage before opening the next one.

Claude Code is the primary guided surface. Before any provider page, hidden
prompt, or system window, name the provider, explain why the step is needed,
state the minimum permission, and give the owner one next action. When browser
control is available, offer to navigate the official page and fill non-secret
fields after exact approval. Stop before sign-in, 2FA, credential reveal or
entry, consent, billing, and every secure passkey window. If the screen differs
from the explanation, stop and explain before continuing.

## 1. Readiness

1. Confirm the host computer, a current browser, internet access, and a separate
   passkey-capable device if the owner wants one.
2. Use a normal current-user terminal. Do not use `sudo`, root, or Run as
   administrator.
3. Run `brain tools`. Before any resource creation, it verifies Node.js 22 or
   newer, at least 2 GiB free on the actual per-user install drive
   (`LOCALAPPDATA` on Windows), Claude Code, Claude sign-in, the installed
   `financial-brain-technician` skill, Anthropic's doctor, and pinned Wrangler 4.
4. Ask whether this is the owner's first Cloudflare account or an account they
   already control. Before provisioning, navigate to Workers & Pages > Plans
   and have the owner confirm the exact account says Paid. The narrow sign-in
   cannot read billing status. Do not infer the plan from product access.
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

Before any resource is created, open Workers & Pages > Plans for that exact
account and have the owner confirm it says Paid. Browser control may navigate
there after approval, but the owner handles sign-in, 2FA, any plan change,
payment, billing approval, and Cloudflare consent. The installer's narrow named
session cannot read billing status and must not claim the plan is verified from
successful Workers or Vectorize access.

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
does not run `brain invite`, `brain devices`, passkey enrollment, or device
review.

## 4. Source onboarding

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
8. Verify freshness, provenance, and one known item from the real source.
9. Run the applicable exclusion or leak tripwires from the pre-interview.
10. Record the proof level and the next missing live acceptance step.

Use one scorecard row for every authorized source. Keep these four readiness
dimensions independent: **starter context**, **live updates**, **history**, and
**meaning search**. A recent useful result can make starter context ready while
older history is still loading. A complete D1 load can still have partial
meaning search while Vectorize catches up. A changing source without a proven
refresh schedule cannot be marked live-ready.

Each row also records the access zone, provenance label, items seen, retries,
elapsed time, owner minutes, technician minutes, and the next gap. Compare the
source receipt with the owner-visible `/optimize` display before accepting it.
If a source appears in documents but has no registered source kind or access
zone, record it as **unregistered** and stop scoped-sharing acceptance until it
is assigned and tested.

### Value-first source sequence

1. **Zoom client calls:** connect the webhook, reconcile the recent bounded
   window, and open one real transcript with the owner. Treat the initial
   30-day reconciliation and ongoing webhook delivery as separate proof. Import
   older recordings only after this current-call path is accepted.
2. **Email:** begin with recent, high-value mail and the authorized folders most
   likely to answer the owner's acceptance questions. Backfill a large mailbox
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
5. **Plaid or another financial source:** let the owner complete Link and choose
   the accounts. Accept the source only after current data and its available
   history have separate live receipts. Keep account-to-entity assignment and
   disconnect verification in the private owner record.

The [client onboarding scorecard](../10-client-onboarding-scorecard.md) is the
shared install record. It uses aggregate counts and receipt IDs, never message
text, transcript text, filenames, addresses, credentials, or financial values.

An API is not required. A named human custodian, portal download, or periodic
export is a valid source when its owner, cadence, provenance, and gap state are
explicit.

### Source onboarding prompt

```text
Read onboarding/07-ingest-source-matrix.md and the current manifest. Begin read-only. Show me the sources that are configured, released but not connected, partial, unavailable, or export-only. Recommend one valuable low-risk source to preview first. Do not log in, connect, ingest, delete, schedule, or change a provider until I approve that exact action. Keep credentials and private source content out of this conversation. After each approved source, report its counts, freshness, provenance, proof level, and remaining live acceptance test.
```

## 5. Before Golden 20

Do not start the Golden 20 while a required source is unavailable, the initial
vector backlog is nonzero, a known exclusion leaks, or the owner has not written
the twenty questions from memory. Fix or explicitly accept each gap first.
