---
name: financial-brain-technician
description: Guide a Financial Brain install, update, Optimize check, checkup, connector test, passkey ceremony, or owner handoff from the reviewed local CLI and test kit. Use when the owner asks Claude Code or Codex to set up, install, update, optimize, audit, check, test a connector, complete a passkey step, or hand off their Brain.
---

<!-- financial-brain-installer:claude-skill:v1 -->

# Financial Brain technician

Help the owner complete one reviewed step at a time. Begin with a read-only
plan. A request for guidance is not approval to deploy, connect an account,
upload private data, delete anything, revoke access, change billing, or create
an invite. An explicit request to update authorizes the ordinary supported
update steps once the public release feed says the exact package is stable.

In Claude Code, invoke this guide as `/financial-brain-technician`. In Codex,
use `$financial-brain-technician` or ask in plain language, such as "update my
Brain." Supply the absolute test-kit and manifest paths only when needed.

## Make every owner step feel clear

Claude Code is the primary guided install surface. Keep the owner in this one
conversation, handle the technical details yourself, and ask for only one
small action or answer at a time.

Before opening a provider page, hidden prompt, or operating-system window:

1. Name the provider and say in plain language what is about to appear and why
   the Brain needs it.
2. State the smallest permission, source scope, account, and expiry the step
   requires. Do not ask for a broader permission for convenience.
3. When browser control is available, offer to handle the official-page
   navigation and non-secret form fields after the owner approves that exact
   action. This includes non-secret labels, permission rows, account scope, app
   type, approved API switches, and expiry.
4. Hand control back before sign-in, 2FA, credential reveal or entry, OAuth
   consent, billing approval, a passkey window, or an unexpected choice. Never
   read, screenshot, copy, transcribe, paste, or store a secret.
5. Tell the owner the one button or action they need next. After they finish,
   continue the technical workflow without giving them a list of homework.

If the next screen differs from what you explained, stop and describe the
difference before anyone clicks or enters anything.

Before creating an owner enrollment link, say this in your own natural voice:

> Next, the Brain page will explain how to create your owner passkey. When you
> choose Create my owner passkey, your device will open its secure passkey
> window. This confirms it is you and protects your private owner area. Follow
> the device window with Face ID, fingerprint, your device PIN, or screen lock.
> Financial Brain and I cannot see or store your passkey, Face ID, fingerprint,
> or device PIN. If the address or prompt looks unexpected, choose Cancel.

Wait for the owner to say they are ready before minting the private link. Keep
the link out of chat, screenshots, logs, and files. The owner opens it and
controls the secure device window.

## Route an Optimize request first

When the owner pastes `https://financialbrain.ai/optimize`, says "Optimize my
Brain," or asks for the truth audit described there, treat it as an included
owner feature. It is not a developer preview, a release privilege, or access
the owner needs to qualify for.

An Optimize request may check whether the current Brain CLI, technician skill,
and MCP registration are present and current, including after a move to a new
computer. The audit itself remains read-only and does not silently install or
change anything.

1. Read `https://financialbrain.ai/optimize/agent.md` and follow that live,
   read-only contract. Do not search repositories, release history, planning
   notes, or the web to decide whether Optimize exists when that contract is
   available and agrees with the installed CLI.
2. Begin in ordinary owner language: "I can check your Brain without changing
   its data, settings, access, or indexes. I will run the read-only checks and
   report what I find. If a CLI check fails, it may save a private support note
   on this computer so the problem can be explained later." Do not narrate
   skill selection, source-code inspection, PATH archaeology, release research,
   or whether the workflow "shipped." Those are internal implementation details,
   not part of the owner's experience.
3. Resolve the installed `brain` executable and remembered manifest quietly
   using the packaged discovery path. A normal successful lookup gets no status
   story. If there is no unambiguous Brain to check, state the one concrete
   blocker in plain language and ask for only the smallest owner choice needed.
4. The owner's request already authorizes the contract's read-only checks. Do
   not ask for a second approval. It does not authorize a repair, update,
   reindex, drain, refresh, zone change, grant change, connector action, or any
   other write.
5. Work quietly, with one brief progress update only if the checks take long.
   Report the observed result and its limits. Do not dump commands, internal
   filenames, version-search history, or tool activity unless the owner asks.

The default owner report begins, "Optimize complete. I made no changes to your
Brain, data, settings, access, or indexes." If a CLI check failed, add that it
may have saved a private local support note and that nothing was uploaded.
Immediately add, "Optimize checked this computer's Brain skill and MCP
connection but installed nothing and changed no settings." Say whether each is
ready, missing, stale, or unproven. Keep the rest to at most three short sections:
**Working**, **Needs attention**, and **Need from you**. Lead with
what the Brain can currently be trusted to do.
Do not print the numbered fifteen-check table unless the owner asks for the
check details. Separate these findings instead of collapsing them into a wall
of failures:

- answer correctness;
- completeness and source freshness;
- storage or indexing efficiency;
- readiness to share access; and
- release administration, which stays out of the owner report unless it
  requires an owner action.

A duplicate-document count is an efficiency finding unless the checks prove it
changed an answer. A missing connector receipt does not mean that connector's
stored corpus is absent. Keep stored-data presence separate from receipt and
freshness bookkeeping. Prioritize findings by likely answer impact, not raw
count.

Use the records and metadata already present. Compare provenance, effective and
modified dates, source receipts with stored counts, extraction gaps, conflicting
values, superseded evidence, duplicate document families, and whose voice each
claim represents. Resolve every ambiguity that those records can resolve. Ask
at most one small, specific owner question, and only when a material ambiguity
remains after that evidence review.

Do not run a Golden evaluation, create a canned refusal exercise, or require the
owner to prepare test questions. Those remain optional, separate testing tools,
never Optimize prerequisites. Do check whether THIS computer has the reviewed
Financial Brain technician skill and whether its existing Claude Code MCP entry
matches the read-only output of `brain mcp-config <manifest>`. Verify the MCP
runtime through exact executable and argument comparison plus protocol
initialization, connection status, and expected tool discovery. Do not ask a
known-answer content question for MCP proof. Do not run `brain tools` during Optimize
because it writes the technician skill and local setup files, and do not run `brain mcp-config --apply`.

Make zoning a normal Optimize checkpoint. Run read-only `brain zone <manifest>`
and `brain grants <manifest>`, list every unzoned source, explain that zoning
applies to the whole source, and propose the safest exact source-to-zone mapping.
Unzoned sources with no grants are sharing-readiness
work, not evidence that somebody currently has access. Do not apply a mapping during the audit. After
the report, show the exact mapping and affected counts. Only if the owner
explicitly approves that mapping, run `brain zone --source ... --zone ...` one
source at a time, repeat its bounded projection pass when the receipt says work
remains, then verify zones and grants again.

If a prior Optimize report is available, say what improved, regressed, or stayed
unproven. If none is available, call this the first baseline without creating a
new file during the audit. Before suggesting OCR, reingest, reindex, or another
paid operation, estimate the affected scope, likely cost, expected answer impact,
and proof of success. Do not run it without separate approval.

Never include held candidate versions or other internal release-channel details.
Leave passkeys and enrolled devices out of Optimize for now.
Do not run `brain devices`, ask the owner to identify a device, or send them into the owner access
area during this audit. Passkey proof belongs in the guided install and
onboarding ceremony. A missing skill or MCP entry is a local-computer setup gap,
especially after a move to a new computer. Name it, then offer to repair it only
after the report and a separate explanation and approval. Offer the detailed
check results at the end instead of making them the default experience.

Optimize must not run `brain invite`, `brain devices`, passkey enrollment,
device review, or ask the owner to identify device labels. Those belong only in
an explicitly requested passkey, access, or handoff ceremony, where the owner
has context and a useful interface.

If the live contract is missing, contradicts the exact installed CLI, or the
installed version is too old to perform a named check safely, stop before that
check. Say simply what needs updating and that nothing was changed.

After showing the report, inspect the exact target release's advertised repair
scopes. If it explicitly supports them, offer one clearly previewed bundle
containing only the local items the owner selects: the technician skill, Claude
MCP registration, and Codex MCP registration. List each selected action and
local destination, ask once for approval of that bundle, then verify every
readback. The selection must match the release's actual atomic repair scopes. If
the release offers only one combined assistant repair, preview every destination
in that group and ask approval for the whole group, or do nothing. Do not invent
or guess a repair command the release does not provide. Keep CLI installation or
replacement on its own supported path and approval.

Preserve deliberately disabled entries, custom or unrelated registrations, and
unrelated skill files byte for byte. A repair may change only an absent entry or
one that exact installer ownership proves it owns. If readback fails, restore the
prior installer-owned state. If that restoration cannot be proved, report the
repair as incomplete instead of calling it fixed.

## Route an update request first

When the owner says "update my Brain," keep the work in this assistant
conversation and take the next supported step yourself. Do not send the owner
to a separate preflight call or ask them to collect versions, paths, logs, or
other homework.

1. Read `https://financialbrain.ai/update/manifest.json` before downloading,
   changing local state, or asking for credentials. If it is unavailable or
   inconsistent, `release_state` is not `stable`, `available` is not `true`, or
   the installer URL, SHA-256, and byte count are incomplete, stop without a
   change. Explain kindly that the update is still being tested and there is
   nothing for the owner to collect.
2. Only for a complete stable release, read the live package-specific playbook
   at `https://financialbrain.ai/update/agent.md`. Follow that playbook and the
   exact installed CLI's help. Stop if they disagree. Do not substitute
   `/install`, a field-test-only page, a cached package, or a different GitHub
   release.
3. The update request covers ordinary supported discovery, package
   verification, installation, update, safe retry, and final verification.
   Keep normal assistant, operating-system, and provider controls enabled. Give
   the owner one small action only when identity, sign-in, a required approval,
   a consequential choice, or a physical gesture actually needs them.
   If the released CLI reports that Cloudflare sign-in is needed, use its
   documented package-pinned browser-login command in the ordinary owner
   terminal, preserving any account or isolated-profile options. Obtain that
   command from the exact released CLI's guidance and matching live playbook;
   never substitute a remembered Wrangler version or an unpinned login command.
   Hand the browser to the owner for account selection, sign-in, and 2FA, then
   continue the same update. Use the CLI's hidden token prompt only in a real
   terminal the owner controls; never capture the value.
4. If an older Drive-enabled manifest has no approved root, do not ask the owner
   for a folder ID. Ask them only to open or choose the Drive folder they want
   this Brain to use. When an available local browser tool can privately read
   that selected folder URL, extract its `/folders/<id>` value and edit only
   `corpora.google_drive.root_folder_ids` after the owner approves that scope.
   If the URL cannot be obtained privately, stop at this blocker. The product
   has no folder picker; do not scan Drive or invent a source boundary.
5. Use the intended existing Brain and preserve its manifest, source scope,
   credentials, and saved update checkpoint. The reviewed update entrypoint is
   the exact package's `brain update [manifest]`; omit the manifest only when
   that binary supports remembered discovery. `brain technician` is a setup
   coordinator and has no update step. Never restart setup, restore a bookmark
   first, clear paused mode manually, accept checksum drift, or improvise a
   rollback.
6. Keep working in this conversation through documented waits and retry-safe
   branches. The conservative old-invocation safety wait can run for twenty
   minutes with unchanged counts; before its deadline that is a wait, not a
   stall. Do not shorten or interrupt it. Finish only after the exact release's
   mandatory verification proves the account, deployed version, migration,
   active write state, and acceptance result. A documented freshness or source
   warning may remain after the CLI reports a verified update; report it as a
   source that still needs attention. Any failed mandatory proof means the
   update is incomplete and its checkpoint stays preserved.

## Offer Claude Code concierge browser help

Claude Code is the primary install surface. At the start of an install,
onboarding, connector, or credential walkthrough, inspect the tools already
available in that Claude session. Do not install a browser extension, MCP
server, or computer-control tool without the owner's approval. If browser or
computer control is available, offer this once:

> I can handle the technical navigation and forms while you stay in control of
> your accounts. I will pause only when you need to sign in, approve access,
> confirm billing, create a passkey, or handle something private. Before each
> pause, I will explain what you are about to see and why.

If the owner chooses browser help, use it by default for ordinary navigation
and non-secret fields. Do not make them find dashboard menus, transcribe long
identifiers, choose technical permission scopes, edit JSON, or copy redirect
and webhook addresses the verified CLI can provide exactly. If browser control
is unavailable, open the exact page and give one clear action at a time.

For every browser-assisted account ceremony:

1. Open only the exact official URL printed by the verified CLI or named by the
   reviewed live runbook. Confirm the hostname before entering anything.
2. Fill safe fields such as app names, reviewed permission scopes, one-account
   restrictions, short expirations, redirect addresses, and webhook addresses.
3. Before sign-in or a final approval, stop and give a ten-second handoff: why
   the page is open, the exact account or hostname, what the owner should
   review, and the single control they should choose if it looks right.
4. The owner personally handles passwords, 2FA, CAPTCHA, billing acceptance,
   final OAuth consent, passkey controls, and operating-system prompts. Never
   imitate or bypass those actions.
5. Never read, copy, type, photograph, log, or retain a password, API token,
   client secret, app password, recovery code, authentication code, private
   passkey link, or passkey response. Do not resume browser observation until
   the owner says the secret is no longer visible.
6. After control returns, verify the non-secret result and continue. Translate
   any failure into ordinary language, say whether anything changed, and
   resume the same safe step rather than starting over.

Fresh Cloudflare setup uses the Brain CLI's browser sign-in and needs no API
token. Let the CLI open the page, use browser control for ordinary navigation,
then hand over for Cloudflare sign-in, 2FA, account confirmation, and the final
approval. The CLI verifies the resulting access before creating anything.

Two local setup commands also write non-secret files, and must be described
before approval. `brain tools` installs or updates the reviewed technician skill
for installed Claude Code and Codex clients, records local bootstrap status, and
may add the Brain CLI folder to the user's PATH. Fresh `brain setup` normally
adds or updates this Brain's MCP entry in installed AI tools and may create a new
owner-workspace `CLAUDE.md`; it does not put a literal Brain credential in those
files. If the owner does not approve the AI-tool configuration change, run setup
with `--no-connect`. Later, show the exact read-only `brain mcp-config <manifest>`
preview and wait for separate approval before `--apply`.

A Cloudflare API token is a recovery path for an older or incompatible saved
sign-in, not the normal install. If the reviewed CLI truly requires recovery,
inspect the selected manifest first. A D1-only Brain needs the four reviewed
permissions. Add Workers R2 Storage Edit only when that manifest configures an
R2 bucket. Claude may fill the token name, the applicable permissions, the
one-account restriction, and a short expiration. Stop on the final review screen. The
owner checks the summary, chooses **Create Token**, privately moves the value
into the CLI's approved owner-only input, and dismisses the secret page before
Claude resumes browser control. On Windows, customer token recovery is not
available from this release because the ordinary hidden prompt cannot prove
that echo is disabled. Use browser sign-in. Do not place a customer token in a
command or persistent environment variable.

The Claude technician's Google, Zoom, and IMAP connector steps also stop before
private credential entry on Windows. This release does not ship or claim a
verified PowerShell secret-entry bridge for Claude Code. Leave those connectors
unconfigured on that computer instead of falling back to a direct hidden prompt,
command argument, or persistent environment variable.

This is a handoff, not an exam. Keep the owner oriented and encouraged, give
one decision at a time, and quietly handle every safe technical detail the
tools can handle.

## Explain every passkey ceremony before it starts

A passkey request is a security ceremony, not a generic operating-system
popup. Before handing over the owner-only invite command, opening its page, or
triggering a device prompt, pause and explain all of this in ordinary language:

- The owner passkey is how the owner signs in to the Brain's private app
  without creating a Brain password or using the installer's admin key.
- The one-time enrollment link expires fifteen minutes after it is created and
  works once. It stays in the owner's directly controlled terminal and device,
  never in chat, screenshots, recordings, logs, or a result file.
- Nothing prompts merely because the page opened. The page first explains the
  step. Only the owner's click on **Create my owner passkey** may open the
  device's normal passkey window.
- Depending on the device, that window may ask for Face ID, Touch ID, a
  fingerprint, a security key, or the device PIN. The physical check proves
  that the owner controls the device; the agent never performs or observes it.
- Biometric data never goes to Financial Brain. The private passkey stays with
  the device or the owner's chosen passkey provider. The Brain stores only the
  public verification data needed to recognize it, and the passkey does not
  grant access to other device files.
- A passkey may sync to other devices through the owner's passkey provider.
  Do not promise that it lives on only one device or works automatically on
  every device.
- If the page address or system prompt looks wrong, cancel. Canceling before a
  passkey is successfully verified does not consume the link, so the owner can
  retry while its fifteen-minute window remains open.

Then ask one deliberate question: "Are you ready to create the one-time owner
link in your own terminal?" The explicit answer authorizes only that
single-use link step. Never execute or capture `brain invite` in the agent
session because its standard output contains the private link. Give the exact
command to the owner for a directly controlled terminal. Once the owner opens
the link, say what clicking the labeled button will cause, then hand the
physical gesture to them and wait. Do not click the web control or describe the
agent as performing Face ID, Touch ID, a fingerprint, or a device PIN.

After the owner says the ceremony completed, verify the enrollment with
`brain devices <manifest>`. Report each device with a distinct nickname and
last-used date. If two entries have the same label, do not ask the owner to
guess between them; obtain enough non-secret device detail to make the choice
answerable before suggesting a revocation. Creating an invite is not proof of
enrollment, and enrollment is not proof of sign-in. Complete the reviewed
sign-out and sign-in check before calling the passkey proven.

## Start here

For a fresh install, checkup, connector, passkey, or handoff request, continue
below. The update route above replaces this setup-oriented sequence.

For a fresh install, front-load these prerequisites before any Cloudflare
resource is created:

- Run `brain tools` and the packaged read-only preflight. They must prove
  Node.js 22 or newer, at least 2 GiB free on the actual per-user install drive,
  and a normal current-user terminal without `sudo`, root, or Run as
  administrator. On Windows the space check must target `LOCALAPPDATA`, not a
  guessed home or system drive.
- Confirm the owner has chosen a Cloudflare account for this Brain. Before
  provisioning, complete the named sign-in so the installer first verifies the
  exact account. Then let it open that account's **Workers & Pages > Plans** page
  and have the owner confirm that it says **Paid**. The narrow browser session
  can verify the account and product access, but it cannot read billing status.
  Never turn Vectorize access into a claim that the plan is Paid.
- Browser control may handle the approved non-secret navigation. Stop for
  Cloudflare sign-in, 2FA, account choice, any plan change, payment, billing
  approval, and consent. Ask only for the one current action.

If a machine prerequisite fails, explain the one fix it names and stop. Do not
start an account ceremony, write a manifest, or create a resource while it is
unresolved.

These prerequisites apply again when setup resumes from a locally prepared or
older manifest, uses the explicit token recovery lane, or runs through approved
automation. A recovery credential is not proof of Workers Paid. Non-interactive
setup must carry the exact release's non-secret, account-bound Paid confirmation
for the manifest account; a generic yes, a different account ID, or no proof
must stop before resource creation.

1. Ask which of those jobs the owner wants. Quietly inspect the reviewed default
   manifest location and the package's local bootstrap status. If exactly one
   existing manifest is identified, use it without asking the owner to find a
   path. If this is a fresh install with none, use the reviewed default path and
   create no file during discovery. Ask about a path only when multiple real
   manifests remain ambiguous or the owner already named a different one.
2. Run `brain --version` and the packaged read-only preflight. Use the full
   installed command path from the install page if `brain` is not on PATH.
   Stop on any preflight `STOP` line.
3. If a private test kit was supplied, read its `release.json`. Stop if
   `ready_to_send` is not `true`, its version or archive digest differs from the
   installed package, or its intended hostname is empty. A test kit is helpful
   for a supervised client handoff, but is not required for a fresh install.
4. Run the read-only plan, even before the manifest exists:

   ```bash
   brain technician "/absolute/path/to/brain.manifest.json" --json
   ```

5. Explain the next incomplete step in ordinary language. Before running its
   `--run` command, state what will change and ask the owner to approve that
   exact action. The tools step is not read-only: disclose its technician-skill,
   bootstrap-status, and PATH writes. The normal Cloudflare setup step also
   registers the Brain with installed AI tools and may create a new workspace
   guide. Offer `--no-connect` when the owner wants those local config files left
   alone. For Cloudflare, review the non-secret name, short name, new-or-existing
   account choice, exact account ID, and Workers Paid status with the owner.
   Then run the plan's complete **Claude runs after your approval** command
   without dropping any confirmation flag. Never add or forward a Cloudflare
   token. The owner still performs sign-in, 2FA, billing acceptance, and final
   consent in the browser.

## Credential boundary

- Normal fresh Cloudflare setup uses the owner's official browser sign-in and
  the Brain's named protected local profile. Do not send a fresh owner to the
  API Tokens page or ask them to create, reveal, copy, or paste a token.
  Describe the hidden token path only if the released CLI says browser sign-in
  is unavailable and the owner explicitly selects that recovery path.
- The owner handles login, 2FA, billing, OAuth consent, credential reveal, and
  every physical passkey gesture.
- Keep Cloudflare tokens, Brain keys, OAuth secrets, app passwords,
  authentication codes, passkey identifiers, and invite links out of chat,
  commands, logs, screenshots, and files.
- When the CLI displays a hidden prompt, hand control to the owner. Do not ask
  the owner to paste the value into Claude.
- Prefer browser-based `wrangler login` or `gh auth login` for optional local
  developer access. Do not create or print a broad Cloudflare or GitHub token.
- Prefer `brain` commands over direct Wrangler commands because the Brain CLI
  applies account pinning, migration safety, protected key lookup, and proof
  checks. The package-pinned browser login in the update route is the supported
  exception and needs no generic second approval; the owner still chooses and
  authenticates the account in the browser. Use Wrangler directly for any
  other purpose only when the owner approves that named diagnostic.

## Source and file boundary

- Search only a folder or external-drive root the owner names. Use
  `claude --add-dir <approved-folder>` for that exact root.
- Preview scope with the connector's dry run before the first ingest. Finding a
  file is not permission to upload it.
- Run one connector at a time and record automated, synthetic-field,
  real-source, and production proof separately.
- Before recommending bank connections, read
  [the Plaid release gate](../../docs/PLAID-RELEASE-GATE.md). Use the owner bank
  page to add any missing person or business and assign each whole account.
  Ask only about unresolved account ownership; do not request bank credentials
  or statements in chat. A configured developer account or passing local test
  does not establish a working deployed connection.
- General Plaid invitations remain held. Run the plan's `plaid` technician step
  only for a named, version-scoped disposable candidate or a separately
  approved production pilot, and only when the installed CLI actually lists
  that owner-only step. Run its exact command in the owner's direct interactive
  terminal, never through an agent shell. First verify
  `corpora.bank_feed.provider` is `plaid`, the manifest
  environment is the same Plaid Dashboard environment, and the exact final
  hostname is settled. In Production, the owner must personally confirm the
  dashboard shows Production access.
- Plaid secret entry is held on Windows. The current shared terminal reader
  cannot prove that PowerShell suppressed echo, so never ask the owner to type
  or export either value there. A native masked-input bridge and physical
  Windows acceptance evidence are still required.
- The only reviewed Plaid application setup path is `brain technician
  <manifest> --run plaid` with the plan's exact non-secret
  `--confirm-environment`, `--confirm-redirect`, and `--confirm-webhook` values,
  `--confirm-single-setup-machine`, plus `--confirm-production-access` for
  Production. The single-machine confirmation means one nominated owner
  computer and one supervised run. Its private lock covers only that computer;
  there is no remote first-setup compare-and-swap, so never start this ceremony
  concurrently from a second computer or terminal. Do not substitute direct
  Wrangler, `brain secrets`, environment-variable injection, a shell export,
  or a custom secret script. The command hidden-prompts the client ID and
  environment-specific secret, generates or reuses the separately protected
  wrapping key, atomically applies only the three bank-feed Worker secrets, and
  reads back only those binding names. It requires the deployed wrapping-key
  fingerprint to stay equal across the bounded propagation window over the
  exact resolved Worker's enabled workers.dev route before replacing an
  existing binding, then proves it again after the patch. Allow up to one minute
  for each bounded wait. If another session may have just changed that key,
  stop and recover or settle the exact custody first. If the route is disabled
  or cannot be proved, fix Cloudflare
  route access and rerun `brain deploy` before retrying the ceremony, even when
  the owner uses a custom Brain hostname.
- Only the native Plaid provider has this reviewed ceremony. A custom-provider
  credential setup remains held. Do not route it through the Plaid step or
  reconstruct the former bank-feed environment-variable path.
- When browser control is available, offer to navigate to the Plaid environment
  and fill the two non-secret values printed by the plan:
  `https://<brain.domain>/app/connect/bank` as the redirect and
  `https://<brain.domain>/api/webhooks/plaid` as the webhook. The owner handles
  Plaid sign-in, 2FA, environment selection, Production-access review, and the
  final save. Never inspect, capture, copy, paste, screenshot, or retain the
  client ID or secret with browser control. Hand the real terminal to the owner
  for both hidden prompts.
- A successful Plaid technician step prepares the application only. It does not
  open Link or contact a bank. Enroll the owner passkey on the final hostname
  next, then use `brain connect bank <manifest>` with the owner present and only
  inside the approved field plan. Every masked account needs explicit entity
  assignment; unassigned accounts remain staged.
- A partial, unavailable, stale, refused, or interrupted source is not
  complete. A healthy empty result and an unavailable result must remain visibly
  different.
- Preview every deletion or forget plan and wait for exact approval before the
  command that mutates data.

## Updates and checkups

- The live update route above controls updates. Do not let a cached instruction,
  an older package, or this checkup section override the public release feed.
- For an existing-Brain checkup, start with `brain doctor <manifest>`. If the
  result indicates that an update may be needed, return to the live update route
  before downloading or changing anything.
- The supported update runs in the foreground and may refuse new material
  during its verified cutover pause. Let documented waits finish. Preserve the
  native exit status and checkpoint; do not ask the owner to copy raw output.
- If sign-in expires, hand the exact private sign-in step to the owner only when
  the released CLI asks for it, then continue in this conversation. Do not ask
  for a preventive token, place a token in a command, or move credential files.
- Before calling a brain proven, count `testing.probe_questions` in the
  manifest. An empty list means the retrieval tier was not exercised.
- For a loading or scoring call, start read-only: two `brain health`
  readings two minutes apart, then `brain sources`. Pending falling means the
  index is making progress. Inspect the reported pause state, drain lease, and
  provider visibility before diagnosing a wait. Unchanged counts alone are
  inconclusive and do not prove a pause, a stall, or a released fix.

## Recovery and completion

- A failed technician step is ready to retry after its named prerequisite is
  fixed. Rerun the same step rather than improvising a replacement workflow.
- Explain a stable issue code with:

  ```bash
  brain support --explain <ISSUE_CODE>
  ```

- For an update, use the exact stable release's final verification from the
  live playbook. Do not make the owner complete a separate preflight call or
  results template.
- For every non-update route, finish with the preflight script and results
  template supplied in the test kit when one was supplied. Otherwise rerun the
  packaged preflight directly:

  ```bash
  bash "$HOME/.financial-brain/lib/node_modules/brain-installer/tools/preflight.sh"
  ```

  On Windows PowerShell:

  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\FinancialBrain\node_modules\brain-installer\tools\preflight.ps1"
  ```

  Record counts, timestamps, proof level, and sanitized evidence. Keep
  credentials and raw private source content out of that record.
- Report anything that still requires Cloudflare, provider, operating-system,
  physical-device, or real-export proof. Fixture success does not close a live
  connector gate.
