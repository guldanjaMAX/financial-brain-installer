# Windows onboarding rehearsal

This is a safe owner-experience test for a reviewed Financial Brain candidate.
It opens the real owner workspace with invented records. It does not install a
Brain, contact Cloudflare, connect an account, read a credential, or use a real
passkey.

The technician supplies two things before the test:

- the reviewed repository or pull-request link;
- the exact commit SHA that passed the automated Windows checks.

Do not guess the SHA, switch to `main`, or substitute the public installer. If
the public release feed is held, the rehearsal can continue but a real install
cannot.

## Paste this into Claude Code on the Windows computer

````text
Help me test the Financial Brain owner experience on this Windows computer.
This is a local-only rehearsal with synthetic data, not an install.

Use only the reviewed repository link and exact commit SHA supplied by my technician. Open a normal PowerShell window from the Start menu, not an embedded app terminal and not Run as administrator. Verify Node.js is version 22 or newer. Then run `npm.cmd run rehearse:onboarding` from the repository root only after the exact checkout checks below pass.

Start in a new empty folder. Do not reuse an earlier clone, a working folder, or a checkout with local edits. Clone the reviewed repository there, then check out the supplied commit in detached-HEAD mode. Set `$ExpectedSha` to the complete 40-character SHA from my technician and prove exact equality before installing dependencies or starting the rehearsal:

```powershell
$ExpectedSha = "<EXACT 40-CHARACTER SHA FROM THE TECHNICIAN>"
if ($ExpectedSha -notmatch '^[0-9a-f]{40}$') { throw 'STOP: the reviewed commit SHA was not supplied exactly' }
git fetch --no-tags origin $ExpectedSha
if ($LASTEXITCODE -ne 0) { throw 'STOP: the reviewed commit could not be fetched' }
git checkout --detach $ExpectedSha
if ($LASTEXITCODE -ne 0) { throw 'STOP: the reviewed commit could not be checked out' }
$ActualSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualSha.Trim() -ne $ExpectedSha) { throw 'STOP: this checkout is not the reviewed commit' }
$Dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $Dirty.Count -ne 0) { throw 'STOP: this checkout is not clean' }
```

Printing a SHA is not enough. Continue only when the exact equality check passes and `git status --porcelain` returns no lines.

Do not run setup, provision, deploy, update, connect, ingest, OCR, repair, reindex, drain, forget, zone, grant, invite, or any live Cloudflare or provider command. Do not ask for a token, password, login, consent, billing approval, or real passkey. Do not work around a refusal.

When the browser opens, guide me through the synthetic screens one at a time. Ask what feels clear, confusing, too technical, or surprising. Pay special attention to the first passkey explanation, healthy-empty versus unavailable wording, partial data, conflicts, retries, guest access, and the Owner Financial Map review. Stop the rehearsal with Control-C when I am done.

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

## If something stops

Stop at the first error. Do not rerun with Administrator access and do not add
credentials. Send the technician the short final error and the safe feedback
note above. Do not send an entire environment dump or a screenshot containing
a username or private notification.
