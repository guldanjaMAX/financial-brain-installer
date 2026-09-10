# Technician setup and local rehearsal

The owner should not have to understand OAuth, webhook validation, terminal
environment variables, or passkey relying-party rules. The technician workflow
turns those details into nine small ceremonies. It does not hide the parts only
the account owner can do.

Copy and use the [client onboarding scorecard](./10-client-onboarding-scorecard.md)
from intake through the day 29 check-in. It separates customer effort, waiting
time, connector proof, and the four source-readiness dimensions so each install
can improve the next one.

## Try the owner experience with no accounts

From a source checkout:

```bash
npm run rehearse:onboarding
```

The command installs only the local UI test dependencies when needed, builds
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

Stop it with Control-C. Nothing is deployed, no manifest or credential store is
read, and no account is contacted.

This proves local layout, navigation, API response handling, access-surface
separation, and empty-versus-unavailable language. It does not prove Cloudflare,
Google consent, a real mailbox, Zoom delivery, or a physical passkey ceremony.

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

After installing the released CLI, start with the read-only plan:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json"
```

For a local coding agent, use the JSON form:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --json
```

The JSON contains workflow state, dashboard links, proof boundaries, and the
next reviewed command. It contains no credentials. An agent may guide the
browser and explain each page, but the owner enters every token or secret into
the provider page or hidden terminal prompt.

Claude Code should offer to do the non-secret browser work. After the owner
approves the exact ceremony, it may open the provider's official page, navigate
to the correct form, and fill non-secret labels, permission rows, account scope,
app type, approved API switches, and expiry. It stops before sign-in, 2FA,
credential reveal or entry, OAuth consent, billing approval, and every secure
passkey window. Explain the provider, purpose, minimum permission, and one next
owner action before anything opens. Do not give the owner a page of setup
homework.

## Nine steps

### 1. Local tools

Use the owner-facing `/install` page to install Node.js, Claude Code, and the
released Brain CLI. Use a normal terminal as the current user, not `sudo`, root,
or Run as administrator. The owner signs in to Claude in their own browser.
Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run tools
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

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run cloudflare
```

Before opening Cloudflare, explain that the official browser sign-in lets the
installer create and verify this Brain's Worker, D1 database, Vectorize index,
and Workers AI access inside the exact account the owner chooses. Browser
control may open the official page. Before setup creates anything, navigate to
Workers & Pages > Plans and have the owner confirm the exact account says Paid.
The narrow installer session cannot read billing status, so successful product
access is not plan proof. The owner signs in, completes 2FA, chooses and confirms
the account, reviews Cloudflare's consent, and approves it. Any plan change or
billing approval belongs to the owner. Normal fresh setup creates, reveals, and
copies no API token. The protected named profile stays in the owner's
operating-system credential store. The setup command performs the account check,
provisioning, migrations, deploy, key persistence, and health proof. It is safe
to rerun after an interruption.

Describe the least-privilege hidden token path only if the released CLI says
browser sign-in is unavailable and the owner explicitly selects that recovery
path. It is not ordinary onboarding and must not be presented as a fresh-install
task.

### 3. First-install smoke proof

With the owner present to approve the fixed public sample and its small Workers
AI embedding cost, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run smoke
```

This sends only the package's fixed, non-customer smoke document through the
deployed authenticated ingest path, verifies its receipt, and drains its vector
work. It reads no local source file or customer account. The document remains in
the Brain as durable first-install evidence.

### 4. Google

Enable `google_drive`, `gmail`, and `calendar` in the manifest, then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run google
```

The owner creates a Desktop OAuth client in their Google Cloud project. The
client ID and optional client secret are entered at hidden prompts. Google
consent stays in the owner's browser. The launcher passes the values only to the
short-lived connector process and clears its input buffers afterward.
Browser control may navigate, fill non-secret project and app labels, choose
Desktop app, and enable only the APIs already approved in the manifest. The
owner takes over for Google sign-in, 2FA, credential reveal, and OAuth consent.

### 5. Zoom

Enable `zoom` in the manifest. A paid Zoom seat with cloud recording is
required. Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run zoom
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
brain technician "$HOME/Financial Brain/brain.manifest.json" --run imap \
  --host imap.example.com --user owner@example.com
```

The app password is requested by the connector's hidden prompt. It is stored
only after a real mailbox read succeeds.
Browser control may find the provider's official app-password page and fill a
non-secret label. The owner takes over for sign-in, 2FA, creation approval, and
the displayed password. Use mail access only. Do not request contacts, sending,
calendar, or account-management access.

### 7. Plaid application setup, held field plan only

General bank invitations remain held. Use this step only for the named,
version-scoped disposable candidate or a separately approved production pilot.
It prepares the native connector but does not open Plaid Link or contact a bank.
Plaid secret entry is currently held on Windows because the shared terminal
reader cannot prove that PowerShell suppressed echo. Do not type or export the
values there. Windows needs a separately reviewed native masked-input bridge
and physical field proof before this step can run.

In the owner's Plaid Dashboard, select the same environment recorded in
`corpora.bank_feed.environment`. For Production, the owner must see that their
Plaid account has Production access. Register and save these exact non-secret
values, replacing the hostname with the final `brain.domain`:

```text
Redirect URI: https://brain.example.com/app/connect/bank
Webhook URL:  https://brain.example.com/api/webhooks/plaid
```

Record those exact saved values in `registered_redirect_uris` and
`registered_webhook_uris` in the manifest. A local assistant with browser
control may navigate to the right Plaid page and fill these two non-secret URLs.
The owner handles sign-in, 2FA, environment selection, Production-access review,
and the final save. Do not let browser control, chat, screenshots, or logs read
the client ID or secret.

Then run the command printed by the read-only technician plan. For a Production
candidate it has this shape:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run plaid \
  --confirm-environment production \
  --confirm-redirect https://brain.example.com/app/connect/bank \
  --confirm-webhook https://brain.example.com/api/webhooks/plaid \
  --confirm-single-setup-machine \
  --confirm-production-access
```

For Sandbox, use `sandbox` and omit `--confirm-production-access`. Keep every
other flag, including `--confirm-single-setup-machine`. That confirmation means
one nominated owner computer is running one supervised setup session. The local
lock prevents two runs on that computer, but Cloudflare does not provide this
workflow a remote compare-and-swap for a brand-new wrapping key. Do not start
the ceremony from another computer or terminal at the same time.

The command refuses before asking for a credential unless the manifest,
environment, both exact URLs, direct-owner terminal, and single-machine
confirmation agree. It also derives the authenticated proof address from the
resolved Cloudflare account and Worker, rather than trusting the public Brain
hostname. The exact Worker's workers.dev route must be enabled even when the
owner uses a custom Brain hostname; if the check refuses, fix Cloudflare route
access and rerun `brain deploy` before this ceremony. When the context screen
appears, hand the terminal to the owner. The client ID and
environment-specific Plaid secret are entered at two hidden prompts and never
placed in argv, shell history, the plan, or a support note.

The installer generates an independent `BANK_FEED_WRAPPING_KEY_V2` or reuses
the exact protected value from a prior attempt. It commits and reads that key
back in macOS Keychain, a Windows DPAPI CurrentUser encrypted file, or an atomic
mode-0600 Linux file before changing Cloudflare. It then uses Cloudflare's
script secrets-bulk operation to atomically apply only
`BANK_FEED_CLIENT_ID`, `BANK_FEED_SECRET`, and
`BANK_FEED_WRAPPING_KEY_V2`, and reads back only those three binding names.
It proves the deployed Worker's wrapping-key fingerprint before replacing an
existing binding, keeps that proof stable across the bounded propagation
window, and proves it again after the patch. Cloudflare propagation can take up
to one minute. If any other session may have just changed the key, stop and
settle or recover that exact custody first. An interruption keeps the same
protected wrapping key as desired state, so rerun the same ceremony with the
same provider values on that nominated computer.

If this Worker already has a wrapping key but the protected local copy is
missing, the step stops without replacing it. Recover that owner's key custody
before continuing so retained bank connections do not become unreadable.
`brain secrets` refuses bank-feed values from environment variables, and the
custom-provider credential path remains held because it has no reviewed setup
ceremony. Neither is a substitute for this native Plaid step.

### 8. Owner passkey

Settle the final Brain hostname first. With the owner and intended device
present, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run passkey \
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

After passkey enrollment succeeds and only while the approved field plan is
active, run `brain connect bank <manifest>` with the owner present. The owner
signs in with that passkey, completes Plaid Link and their bank's 2FA privately,
then assigns each masked account. Unassigned accounts stay staged.

### 9. Handoff checks

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run verify
```

This runs doctor, health, source freshness, and enrolled-device checks in order.
It stops on the first failure and does not mark anything complete. Record a
connector as live-proven only after its exact acceptance event occurs.

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
- Plaid: the exact candidate and environment pass owner passkey sign-in, private
  Link, masked-account assignment with unassigned accounts staged, real signed
  webhook delivery, scheduled reconciliation, repair, disconnect, and resume.
  Fixture or API-only proof does not open general invitations.
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
