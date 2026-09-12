# Windows onboarding rehearsal

This is a safe owner-experience test for a reviewed Financial Brain candidate.
It opens the real owner workspace with invented records. It does not install a
Brain, contact Cloudflare, connect an account, read a credential, or use a real
passkey.

The technician supplies two generated files before the test:

- the content-addressed sealed rehearsal ZIP;
- its adjacent `release.json` receipt.

## Prepare a generic handoff kit

The kit contains only deterministic instructions and a synthetic-rehearsal
manifest. It contains no executable checkout, customer name, customer data,
credential, manifest, or live-system authority. Run the read-only plan first
from a clean, non-shallow checkout of the exact candidate:

```bash
node scripts/build-windows-onboarding-kit.mjs --plan --json --expect-sha <exact-40-character-lowercase-SHA>
```

That command performs no write and creates no output. A draft can be prepared
in a new directory outside the checkout, but its receipt remains
`ready_to_send: false` and must not be shared as a ready kit:

```bash
npm run rehearsal:kit -- --draft --expect-sha <exact-40-character-lowercase-SHA> --output <new-directory-outside-checkout>
```

Only the production sealing form can set `ready_to_send: true`. It reads one
GitHub Actions `ci` push run through `gh` and refuses unless that run belongs to
the exact SHA, completed successfully, and contains successful public-history,
exact-package, preflight-trap, and Windows, macOS, and Ubuntu Node 22 and 24
jobs. It also binds the tested package artifact digest from that same run:

```bash
npm run rehearsal:kit -- --ci-run <github-actions-run-id> --expect-sha <exact-40-character-lowercase-SHA> --output <new-directory-outside-checkout>
```

Keep the generated `release.json` beside its content-addressed ZIP. The receipt
binds the archive, repository, exact source and tree, launcher digest, CI run and
jobs, tested package digest, seven-day handoff window, loopback-only purpose,
and pending physical-Windows result. Never substitute an older ZIP or receipt.
The ZIP still directs Claude Code to obtain a fresh detached checkout and use
the checked-in launcher below; it never replaces or embeds that launcher.

Do not guess the SHA, switch to `main`, or substitute the public installer. If
the public release feed is held, the rehearsal can continue but a real install
cannot.

Send only the sealed ZIP and its matching `release.json`. Do not substitute a
repository link, a bare SHA, this maintainer guide, a `.ps1` attachment, or a
copied script body for that pair. The sealed instructions already bind the
reviewed repository, exact SHA, and checked-in launcher without putting
executable code in the handoff archive.

## Maintainer reference: sealed Claude Code instructions

The builder above generates the recipient instructions from code and tests
their safety-critical phrases. This section is a maintainer reference, not an
alternate handoff. Do not paste it or send it in place of the sealed ZIP and
receipt.

````text
Help me test the Financial Brain owner experience on this Windows computer.
This is a local-only rehearsal with synthetic data, not an install.

Use only the reviewed repository link and exact 40-character lowercase commit SHA supplied by my technician. Open a normal PowerShell window from the Start menu, not an embedded app terminal and not Run as administrator. Start in a new empty folder. Do not reuse an earlier clone, working folder, or checkout with local edits. Clone the reviewed repository there and check out the supplied commit in detached-HEAD mode.

Do not reconstruct or paste a multi-line verification script. From the top-level folder of that exact checkout, run its checked-in launcher as this one command, replacing only the SHA placeholder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\onboarding\start-windows-rehearsal.ps1" -ExpectedSha "<EXACT 40-CHARACTER LOWERCASE SHA FROM THE TECHNICIAN>"
```

The checked-in launcher stops unless this is Windows, the PowerShell window is
not running as Administrator, the current directory is exactly the repository
root, `HEAD` exactly equals the supplied SHA, the checkout is clean, and Node.js
is version 22 or newer. It never changes directories for you, so an accidental
start in `C:\Windows\System32` or another unrelated folder cannot continue.

The first run may download one additional small set of public frontend
packages. This is separate from repository preparation. It uses no account
credential and can be quiet for several minutes while it installs and builds.
Leave PowerShell open and wait until the local address appears.

Do not run `npm ci`, `npm install`, or any other npm command yourself. The
checked-in launcher handles the local UI preparation it needs.

Do not run setup, provision, deploy, update, connect, ingest, OCR, repair, reindex, drain, forget, zone, grant, invite, or any live Cloudflare or provider command. Do not ask for a token, password, login, consent, billing approval, or real passkey. Do not work around a refusal.

When the browser opens, guide me through the synthetic screens one at a time. Ask what feels clear, confusing, too technical, or surprising. Pay special attention to the first passkey explanation, healthy-empty versus unavailable wording, partial data, conflicts, retries, guest access, and the Owner Financial Map review. When I am done, have me close the browser tab, return to the same PowerShell window, and press Control-C once. The launcher runs Node directly after preparation, so the ready rehearsal does not stop through the `npm.cmd` batch shim. If an older command does show `Terminate batch job (Y/N)?`, explain that `Y` stops it and `N` leaves it running; do not leave me guessing.

At the end, give me a short feedback note containing only: the exact commit SHA, Windows version, Node version, whether the browser opened automatically, which synthetic screens I reviewed, the three biggest points of confusion, what felt reassuring, and any step where I did not know what to click. Do not include my Windows username, local paths, account names, private data, credentials, or full environment output.
````

## What a passing rehearsal proves

- The exact reviewed source starts on a physical Windows computer.
- The local build and browser launch work without an administrator session.
- The owner can recognize that every screen uses synthetic data.
- The important empty, partial, unavailable, conflict, retry, access, passkey,
  and Financial Map states are understandable.

It does not prove an install, Windows credential protection, Cloudflare,
provider consent, a real source, a physical passkey, D1 storage, Vectorize
projection, or query-visible retrieval. Those remain separate gates.

Before a person receives the SHA, the same commit must pass this bounded
headless check in both Windows Node 22 and Node 24 CI lanes:

```powershell
npm.cmd run rehearse:onboarding -- --smoke --no-open
```

That automated check builds the owner app, starts only loopback services,
verifies the rehearsal guide, app shell, and synthetic owner API, then exits.
It does not replace the physical non-administrator Windows rehearsal or prove
that the default browser opens.

The `npm.cmd` command above is CI-only. A physical owner uses the checked-in
PowerShell launcher so stopping the ready rehearsal does not enter Windows batch
job handling.

## If something stops

Stop at the first error. Do not rerun with Administrator access and do not add
credentials. Send the technician the short final error and the safe feedback
note above. Do not send an entire environment dump or a screenshot containing
a username or private notification.
