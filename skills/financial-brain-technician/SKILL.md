---
name: financial-brain-technician
description: Guide a Financial Brain install, update, checkup, connector test, passkey ceremony, or owner handoff from the reviewed local CLI and test kit. Use when the owner asks Claude Code or Codex to set up, install, update, check, test a connector, complete a passkey step, or hand off their Brain.
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

## Keep Optimize separate

An Optimize request may check whether the current Brain CLI, technician skill,
and MCP registration are present and current, including after a move to a new
computer. The audit itself remains read-only and does not silently install or
change anything.

After showing the report, inspect the exact target release's advertised repair
scopes. If it explicitly supports them, offer one clearly previewed bundle
containing only the local items the owner selects: the technician skill, Claude
MCP registration, and Codex MCP registration. List each selected action and
local destination, ask once for approval of that bundle, then verify every
readback. Do not invent or guess a repair command the release does not provide.
Keep CLI installation or replacement on its own supported path and approval.

Optimize must not run `brain invite`, `brain devices`, passkey enrollment,
device review, or ask the owner to identify device labels. Those belong only in
an explicitly requested passkey, access, or handoff ceremony, where the owner
has context and a useful interface.

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
  provisioning, help them navigate to **Workers & Pages > Plans** and have the
  owner confirm that the exact account says **Paid**. The named browser session
  can verify the account and product access, but its narrow permission cannot
  read billing status. Never turn Vectorize access into a claim that the plan
  is Paid.
- Browser control may handle the approved non-secret navigation. Stop for
  Cloudflare sign-in, 2FA, account choice, any plan change, payment, billing
  approval, and consent. Ask only for the one current action.

If a machine prerequisite fails, explain the one fix it names and stop. Do not
start an account ceremony, write a manifest, or create a resource while it is
unresolved.

1. Ask which of those jobs the owner wants. Ask for the absolute
   `brain.manifest.json` path, creating no file yet when this is fresh.
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
   exact action.

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
