# Technician setup and local rehearsal

The owner should not have to understand OAuth, webhook validation, terminal
environment variables, or passkey relying-party rules. The technician workflow
turns those details into eight small ceremonies. It does not hide the parts only
the account owner can do.

Copy and use the [client onboarding scorecard](./10-client-onboarding-scorecard.md)
from intake through the day 29 check-in. It separates customer effort, waiting
time, connector proof, and the four source-readiness dimensions so each install
can improve the next one.

## Try the owner experience with no accounts

From a source checkout on macOS or Linux:

```bash
npm run rehearse:onboarding
```

On Windows, the technician first produces the sealed ZIP and matching
`release.json` described in
[the Windows onboarding rehearsal](./11-windows-onboarding-rehearsal.md). Its
instructions obtain the exact reviewed checkout and use the checked-in
launcher. Do not substitute a repository link, bare SHA, pasted guide, or
emailed script attachment for that sealed pair.

The rehearsal installs only the local UI test dependencies when needed, builds
the real owner-workspace bundle, starts a loopback-only fixture, and opens a
safety page. Every screen says `LOCAL REHEARSAL`, uses invented data, and keeps
the following states one click away:

- populated owner workspace
- first passkey screen
- healthy empty Brain
- partial and unavailable reads
- conflict and lost-response retry
- exact-document guest access
- guest search with the scoped vector gap stated explicitly

The first run may download one additional small set of public frontend packages
and can be quiet for several minutes while it installs and builds. It uses no
account credential. Leave the terminal open until the local address appears.
On Windows, finish by closing the browser tab, returning to the same PowerShell
window, and pressing Control-C once. Nothing is deployed, no manifest or
credential store is read, and no account is contacted.

This proves local layout, navigation, API response handling, access-surface
separation, and empty-versus-unavailable language. It does not prove Cloudflare,
Google consent, a real mailbox, Zoom delivery, or a physical passkey ceremony.
For a physical Windows owner test, use only the sealed, no-account handoff in
[the Windows onboarding rehearsal](./11-windows-onboarding-rehearsal.md).

## Rehearse the customer hiccups

From the same source checkout:

```bash
npm run rehearse:hiccups
```

This offline lab deliberately tries the situations most likely to make an
install day feel difficult: an interrupted setup, a missing watched folder, a
partial connector, a lost save response, a paused migration, a search backlog,
a stale or out-of-scope access request, and a technician step that needs help.
It runs the product's real recovery, cursor, migration, deletion, authorization,
and idempotency tests with synthetic data and a credential-scrubbed environment.

The result names what passed automatically and the exact live field check that
still remains. Use `npm run rehearse:hiccups -- --list` to see the scenarios or
`npm run rehearse:hiccups -- --only folder-safety` to repeat one.

## The one technician command

First ask the owner which situation describes today and keep the matching value
in every setup command:

- `first_brain`: they confirm they have no existing Brain.
- `existing_this_computer`: this Brain already works on this computer.
- `existing_new_computer`: they are reconnecting it on another computer.
- `resume_interrupted`: setup for this exact Brain stopped on this computer.
- `unsure`: they cannot yet tell. This stops read-only and creates nothing.

Never infer `first_brain` because a local file is missing. An existing-Brain
route with no exact manifest pauses for owner-custody recovery instead of
searching Cloudflare by name or starting over.

For the held v0.4.8 pilot, an existing Brain must pass the exact package's
read-only update preview before any update is considered:

```bash
brain update [manifest] --preview --expect-runtime-sha256 <64hex> --json
```

The receipt must name `identity_scheme: brain.runtime-payload.sha256.v1`; use
its `runtime_payload_sha256` as this command's `expected_runtime_sha256`. Do
not substitute the whole package SHA-256. This is a diagnostic only. It does
not update the Brain, approve an update, or carry
approval into a later command. A runtime mismatch, incomplete local manifest,
invalid bare `brain.domain`, or changed local state stops before credential or
network access. After those local gates pass, it ignores ambient `ADMIN_KEY`,
uses the pinned manifest's durable administrator key for exactly one
authenticated HTTP 200 read from `/api/admin/brain/documents`, and makes no
Cloudflare control-plane request. It discards document rows and reports only a
bounded, fingerprinted aggregate of Worker version, active D1 writer state,
vector counts, pending queue, readiness reason, and verdict. That hostname is a
pinned manifest assertion, not independent proof of Cloudflare account or
domain ownership; the supervised field rung must reconcile the target.

Only `projection_ready: true` means the projection is ready. A short projection
is reported as `recoverable_queued_work`, not readiness, only when queued
upserts cover its full numeric deficit; a smaller or delete-only queue is
`projection_work_insufficient` and stops. Exact counts with pending work are
also non-ready. Zero queued against a short projection, visibility pending with
no queue, excess vectors, a paused or mixed generation, or malformed fields
stop. Every result says
`authorizes_update: false` and performs no Brain write, control-plane request,
deploy, install, browser launch, manifest or workspace write, skill write, or
support-journal write. The implementation and fixture tests in this working
tree remain local-only; immutable package, CI, and supervised field evidence
are still required before live use.

After installing the released CLI, start with the read-only plan:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent first_brain
```

That example is only for an owner who confirmed this is their first Brain. Use
the matching value above for every other route.

For a local coding agent, use the JSON form:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent first_brain --json
```

The JSON contains workflow state, dashboard links, proof boundaries, and the
next reviewed command. It contains no credentials. An agent may guide the
browser and explain each page. On macOS and Linux, for supported Google, Zoom,
and IMAP steps, the owner enters every token or secret into the provider page
or hidden terminal prompt. This candidate deliberately refuses those three
steps on Windows because its secure secret-entry bridge has not been physically
proven there. Do not route around that refusal with a visible prompt, command
flag, environment variable, or chat message.

**Bank connections are not part of ordinary onboarding yet.** They are still
being tested. You did nothing wrong, and there is no bank password,
verification code, or Plaid setup key to enter here. Ordinary onboarding leaves
bank connections off and the technician will never ask you to paste those
values into chat or a normal command. If this Brain is an already approved
pilot, its complete existing bank setup is left unchanged. If any saved piece
is missing, setup stops before changing a credential and explains the
separately reviewed next step.

Claude Code should offer to do the non-secret browser work. After the owner
approves the exact ceremony, it may open the provider's official page, navigate
to the correct form, and fill non-secret labels, permission rows, account scope,
app type, approved API switches, and expiry. It stops before sign-in, 2FA,
credential reveal or entry, OAuth consent, billing approval, and every secure
passkey window. Explain the provider, purpose, minimum permission, and one next
owner action before anything opens. Do not give the owner a page of setup
homework.

## Eight steps

### 1. Local tools

Use the owner-facing `/install` page to install Node.js, Claude Code, and the
released Brain CLI. Use a normal terminal as the current user, not `sudo`, root,
or Run as administrator. The owner signs in to Claude in their own browser.
Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent first_brain --run tools
```

On Windows, open PowerShell from the Start menu for the Brain installation.
Claude can explain the command and follow along, but do not execute the install
inside Claude Desktop's own shell. Windows may redirect files from a packaged
app into that app's private container. Both the preflight and the installation
bridge check native Windows package identity and stop before installing when
the process is packaged or its identity cannot be proven.

Before any Cloudflare resource can be created, this proves Node.js 22 or newer,
at least 2 GiB free on the actual per-user install drive (`LOCALAPPDATA` on
Windows), and a non-elevated current-user session. It also proves the Claude CLI
version and sign-in, installs and reads back the personal
`/financial-brain-technician` skill, runs Anthropic's interactive doctor, and
verifies pinned Wrangler 4. Claude Code's normal approval prompts stay enabled.

Open Claude Code and type `/skills`. Confirm `financial-brain-technician`
appears, then start the reviewed guide with:

```text
/financial-brain-technician
```

If Claude Code was already open before its first personal skill directory was
created, close and reopen it once. The skill contains no credential and does
not authorize deployment, account connection, upload, deletion, or access
changes. It begins by reading the release packet and printing the read-only
technician plan.

### 2. Cloudflare install

Begin by refreshing the read-only plan:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent first_brain
```

The bare `--run cloudflare` command is not a complete setup command. After the
owner confirms the person or company name, short Brain name, new or existing
Cloudflare account, exact account ID, Workers Paid status, and whether local AI
connections may change, Claude constructs the exact command from the plan. Read
that complete command back before approval. It must include the browser-sign-in,
name, slug, account choice, account ID, and Paid-confirmation flags. Add
`--no-connect` when the owner has not approved local MCP or workspace-guide
changes.

Before opening Cloudflare, explain that the official browser sign-in lets the
installer create and verify this Brain's Worker, D1 database, Vectorize index,
and Workers AI access inside the exact account the owner chooses. Browser
control may open the official page. The owner signs in, completes 2FA, chooses
the account, reviews Cloudflare's consent, and approves it. After Cloudflare
verifies that exact account, setup opens its Workers & Pages > Plans page. The
owner confirms it says Paid before setup creates anything. The narrow installer
session cannot read billing status, so successful product access is not plan
proof. Any plan change or billing approval belongs to the owner. Normal fresh
setup creates, reveals, and copies no API token. The protected named profile
stays in the owner's operating-system credential store. The setup command
performs the account check, provisioning, migrations, deploy, key persistence,
and health proof. After an interruption, refresh the plan and use only the exact
resume action it returns for that same Brain. When completion is unknown or no
resume action is available, pause for support instead of starting a fresh setup.

Describe the least-privilege hidden token path only if the released CLI says
browser sign-in is unavailable and the owner explicitly selects that recovery
path. It is not ordinary onboarding and must not be presented as a fresh-install
task. It also does not bypass any machine check or the exact account's separate
Workers Paid confirmation.

### 3. First-install smoke proof

With the owner present to approve the fixed public sample and its small Workers
AI embedding cost, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run smoke
```

This sends only the package's fixed, non-customer smoke document through the
deployed authenticated ingest path, verifies its receipt, and drains its vector
work. It reads no local source file or customer account. The document remains in
the Brain as durable first-install evidence.

### 4. Google

For the Monday supervised Windows x64 pilot, do not start this credential
ceremony. Use the manual local-folder source lane below. The Google, Zoom, and
IMAP instructions in the following sections apply only where the released CLI
reports their secure credential entry as supported.

Enable `google_drive`, `gmail`, and `calendar` in the manifest, then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run google
```

The owner creates a Desktop OAuth client in their Google Cloud project. The
client ID and optional client secret are entered at hidden prompts. Google
consent stays in the owner's browser. The launcher passes the values only to the
short-lived connector process and clears its input buffers afterward.
Browser control may navigate, fill non-secret project and app labels, choose
Desktop app, and enable only the APIs already approved in the manifest. The
owner takes over for Google sign-in, 2FA, credential reveal, and OAuth consent.

### Monday Windows x64 first-source lane

Ask what the owner wants the Brain to help with first. Create one dedicated
folder and place in it one owner-approved, low-sensitivity, text-readable test
document that can answer one distinctive question. Register that dedicated
folder as one manifest source and keep exactly one direct regular file in its
root. No subdirectory, link, junction, second file, or broader source tree is
allowed. This architecture gate fails closed: the native Windows
operating-system probe and the Node process must both report x64 before the
command reads the manifest, source, credential, or network. Any other or
uncertain architecture stops the pilot.

Use the manifest source id and the file's canonical source-relative name to
preview exactly that file. Copy `<64hex>` from the exact sealed package
receipt's `runtime_payload_sha256`, which must use
`identity_scheme: brain.runtime-payload.sha256.v1`. Do not substitute the
whole tarball SHA-256:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" ingest-file "$HOME\Financial Brain\brain.manifest.json" --source <id> --file <canonical-relative> --expect-runtime-sha256 <64hex> --json
```

The preview sends nothing and changes nothing. It returns one opaque
64-character approval fingerprint bound to the exact architecture, package,
manifest, source root, file bytes, and prepared item. Show the bounded scope,
then obtain approval for that exact fingerprint. Keep the expected runtime
value unchanged. Apply only with the matching approval value from the
unchanged preview:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" ingest-file "$HOME\Financial Brain\brain.manifest.json" --source <id> --file <canonical-relative> --expect-runtime-sha256 <64hex> --apply --approve <64hex>
```

This lane allows one exact native-text item only. It excludes OCR, removal,
reconciliation, a full-source walk, scheduling, and substitution of another
item. Prove that same document through Received, Saved, Search ready, and
Answer checked. Documentation of this contract is not implementation, test,
package, CI, physical Windows, or live-Brain proof.

### 5. Zoom

Enable `zoom` in the manifest. A paid Zoom seat with cloud recording is
required. Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run zoom
```

The Zoom admin creates a Server-to-Server OAuth app with
`cloud_recording:read:admin`. `user:read:admin` is used only to prove the plan.
The event subscription is `recording.transcript_completed`. The command probes
the account, writes the four Worker secrets, and proves the live validation
challenge before it prints the webhook URL to save in Zoom.
Browser control may fill non-secret app labels, scope rows, and event fields
after approval. The Zoom admin takes over for sign-in, 2FA, app consent, and
every credential reveal or entry.

### 6. IMAP

Enable `imap` in the manifest. Use the provider's IMAP host and an app password,
not the normal mailbox password:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run imap \
  --host imap.example.com --user owner@example.com
```

The app password is requested by the connector's hidden prompt. It is stored
only after a real mailbox read succeeds.
Browser control may find the provider's official app-password page and fill a
non-secret label. The owner takes over for sign-in, 2FA, creation approval, and
the displayed password. Use mail access only. Do not request contacts, sending,
calendar, or account-management access.

### 7. Owner passkey

Settle the final Brain hostname first. With the owner and intended device
present, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run passkey \
  --confirm-host brain.example.com
```

The confirmation exactly matches `brain.domain`. The command creates one
single-use link that expires in 15 minutes. The owner opens it on their device
and reads the explanation before choosing **Create my owner passkey**. That
click opens the device's secure passkey window. The owner follows it with Face
ID, fingerprint, device PIN, or screen lock. It confirms owner access without
connecting files, messages, accounts, or anything else on the device.

Before minting the link, explain this step and wait until the owner says they
are ready. Financial Brain and the Claude Code guide cannot see or store the
owner's passkey, Face ID, fingerprint, or device PIN. The device keeps the
secret; the Brain receives only the public sign-in record. If the hostname or
secure window looks unexpected, the owner chooses Cancel. Nothing is enrolled,
and the same private link can be tried again until it expires. This is the first
point where a physical passkey becomes proven.

### 8. Handoff checks

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --intent existing_this_computer --run verify
```

This runs doctor, health, source freshness, and enrolled-device checks in order.
It stops on the first failure and does not mark anything complete. Record a
connector as live-proven only after its exact acceptance event occurs.

Fresh setup and the local-tools step still require signed-in Claude Code. For a
manifest with provisioned Cloudflare resource identities, however, a Codex
client whose `codex login status` succeeds can guide this read-only verification.
In that case doctor reports missing or signed-out Claude Code as an optional
local-client gap and continues. A parseable pre-provision manifest or installed
but signed-out Codex does not relax the gate. If neither supported client is
signed in, or a real health or source check fails, verification still stops.

These enrolled-device checks are part of the explicit handoff ceremony. They
are not part of Optimize. Optimize may report whether the current CLI, skill,
or MCP registration is missing or outdated, including on a new computer, but
it must not run passkey enrollment or device review.

## What the owner does and what the technician does

| Action | Owner | Technician or agent |
|---|---:|---:|
| Sign in, 2FA, consent, billing | Yes | Guide only |
| Create a persistent token or OAuth app | Final click | Explain and verify fields |
| Read or retain a credential | Keep it in the provider or hidden prompt | Guide without seeing it |
| Enter a credential | Hidden terminal or provider UI | Hand control to the owner |
| Run installer and connector checks | May observe | Yes |
| Complete passkey gesture | Yes, on their device | Observe result only |
| Approve a named folder for Claude | Yes | Preview the named folder read-only |
| Record proof and unresolved gaps | Confirm result | Yes |

## Live acceptance events

An item being accepted is not proof that it is searchable. For every source,
record these four states separately and stop at the first state that is not
proved:

1. The source receipt reached a terminal state and names exact accepted,
   refused, unreadable, failed, and retryable counts. A connector counter is
   not a storage receipt.
2. One approved low-sensitivity test item exists as the expected logical family
   in D1, has chunks, and carries the correct source and extraction provenance.
3. That exact generation has a confirmed Vectorize receipt and no matching
   outbox work remains. Read health twice and require pending work to decline or
   stay at zero with no competing drain lease.
4. A distinctive phrase from the test item is returned by the supported search
   path with the expected source citation and provenance.

Keep source coverage, D1 storage, meaning-search projection, and query
visibility as independent results. A source error must remain visible even when
another source is healthy. A green health endpoint or an accepted-document
count cannot substitute for the exact readback above. Use the package's fixed
synthetic smoke item for first-install proof; use a customer-source item only
after the owner approves that exact low-sensitivity test.

The following are the shortest honest field gates:

- Cloudflare: fresh install, exact-version health, and one synthetic document
  survives a retry.
- Google Drive: complete first sweep, add, edit, trash, refuse, and incremental
  refresh against a test folder.
- Gmail: one known received message and one sent message appear with provenance,
  then an incremental rerun adds no duplicate.
- Calendar: one event with attendees and one cancellation appear; an unreadable
  calendar produces a partial result rather than a false empty result.
- Zoom: one new paid-seat cloud recording produces a transcript after the
  `recording.transcript_completed` event.
- IMAP: Inbox and Sent read successfully, excluded folders are named, and a
  second sync resumes from the UID watermarks.
- Passkey: enroll, sign out, sign back in, add a second device, revoke it, and
  confirm the owner-facing telemetry contains no credential or ceremony secret.

Fixture tests make these trials easier and safer. The events above are the live
proof that finishes each connector or device check.

## When a step pauses

Every saved issue note has a stable code and a matching plain-language recovery
guide. The code is safe to read aloud to a technician.

```bash
brain support --explain AUTH_REQUIRED
brain support --explain AUTH_REQUIRED --json
```

The guide says what happened, what stayed protected, whether the same command
is ready to retry, the next two steps, and when a technician can help. The JSON
form gives Claude Code or Codex the same reviewed recovery contract without
including private error text.
