# Technician setup and local rehearsal

The owner should not have to understand OAuth, webhook validation, terminal
environment variables, or passkey relying-party rules. The technician workflow
turns those details into seven small ceremonies. It does not hide the parts only
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

## Seven steps

### 1. Local tools

Use the owner-facing `/install` page to install Node.js, Claude Code, and the
released Brain CLI. Use a normal terminal as the current user, not `sudo`, root,
or Run as administrator. The owner signs in to Claude in their own browser.
Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run tools
```

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

### 3. Google

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

### 4. Zoom

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

### 5. IMAP

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

### 6. Owner passkey

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

### 7. Handoff checks

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
