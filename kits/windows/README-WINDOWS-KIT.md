# Financial Brain — Windows kit for Sunday 2026-09-20

Written 2026-09-17 18:57 MST. Build `e44a38b`, version 0.4.8, a **held candidate** — not a public
release. The technician is on the call the whole time.

---

## Read this first: Sunday is a rehearsal, and a refusal is the expected result

We are going as far as **`preview`** and stopping there. We are almost certain the preview will
**refuse**, and that refusal is the thing we came to get.

Why: your Brain is on 0.4.0. A Brain's Worker only started reporting its own version number to the
updater in **0.4.4**. The 0.4.8 updater checks that number before it will plan anything, and the
one fallback it has is only for Brains on 0.4.6. So on yours there is nothing for it to check
against, and it stops — read-only, without touching anything.

**That is not a fault, not something you did, and not damage.** It is a missing piece on our side,
we know exactly where it is, and Sunday's receipts are what we need to finish it. The real update
runs on the next build, the week of the 21st.

Everything else Sunday proves is just as valuable: whether the install works on Windows at all,
whether the execution policy bites, whether the Cloudflare sign-in works there, how long each step
takes. The script's offline `selftest` runs on Windows PowerShell 5.1 and PowerShell 7 in GitHub
Actions. **No mode has contacted or changed a Brain on Windows.** Every field claim in this kit is
read out of the code, not measured.

---

## 1. What you download

Five files, in one folder, sent together. Nothing else — never a repo link, never a bare hash.

| File | What it is |
|---|---|
| `brain-installer-0.4.8.tgz` | the package itself, 6,456,411 bytes |
| `field-prepare-receipt.json` | the build's own signed-off test record |
| `brain-windows-update.ps1` | the script you run |
| `README-WINDOWS-KIT.md` | this file |
| `SHA256SUMS` | the checksums of the other four |

The script checks all of them against `SHA256SUMS` before it will do anything, and then checks the
package against the receipt as well. If any of that fails: **stop, do not install, tell the technician, and
we re-send the kit.**

`SHA256SUMS` cannot authenticate itself. On the call, the technician reads you the three out-of-band hashes
for `brain-windows-update.ps1`, `README-WINDOWS-KIT.md`, and `SHA256SUMS`. The private download page prints the package and
runtime hashes. Compare those anchors before trusting the files in this folder.

## 2. Where to unzip it

**`C:\FinancialBrain-kit`** — exactly that, and nothing with a space in it.

This matters more than it looks. `cmd.exe` re-parses arguments and can split a path at a space
without saying so. The script quotes every path it passes, and it will still **refuse** to install
into a path containing a space, because quoting is not a guarantee here.

Everything the script writes stays inside that folder:

- `C:\FinancialBrain-kit\prefix\` — the installed CLI
- `C:\FinancialBrain-kit\receipts\` — every output file, and the log

## 3. Before you start — ten things, and they are all quick

1. **Native x64 Windows, x64 Node.** `node -p "process.arch + ' ' + process.platform"` must print
   `x64 win32`. ARM64 is a stop, including x64 Node under emulation.
2. **Node 22 or newer** (24 preferred), at a stable path. A version-manager shim (nvm4w, fnm,
   volta) is a stop: the update bakes the absolute path into your local registrations.
3. **PowerShell from the Start menu.** Not an app's built-in terminal, not Claude Desktop, not
   "Run as administrator". 5.1 and 7 both work.
4. **Do not change the execution policy.** The script only ever calls `npm.cmd`, never `npm`.
5. **Never paste a token.** You will not be asked for one. The CLI refuses to take a Cloudflare
   token on Windows at all — browser sign-in is the only path. (A PowerShell 5.1 prompt echoed a
   live token on 2026-09-08; that is why.)
6. **Cloudflare sign-in, pinned:** `npx.cmd wrangler@4.73.0 login` — that exact version, as the
   CLI prints it. You have two Cloudflare accounts: **match the account by its id, not by its
   display name.** Your Brain's id is in your manifest; `discover` prints where the manifest is.
7. **`curl.exe`, never `curl`** — in PowerShell the bare name is something else entirely.
8. **Plugged in, sleep off, one window, left open.** Never pipe anything here through `findstr`
   or `more`.
9. **One thing at a time on your Brain** — no other Brain command, no scheduled task, no ingest.
10. **Your Plaid pipeline is not involved.** Your 8 Production Items live in your own Python/CSV
    work; this update does not touch that lane.

## 4. The exact lines to run

Open PowerShell from the Start menu, then:

```powershell
cd C:\FinancialBrain-kit
```

**Step 0 — run the offline selftest. It contacts no Brain and makes no network request.**

```powershell
.\brain-windows-update.ps1 selftest
```

It must end with `0 failed`. Exit code **2** means this kit failed its own checks. Stop and tell
the technician; do not continue to `discover`, `install`, or `preview`.

**Step 1 — discover. Read-only, and it makes no network request at all.**

```powershell
.\brain-windows-update.ps1 discover
```

It prints your Node, npm and PowerShell versions, where your manifest is, what version it records,
whether the prefix exists yet, and the kit's checksums. Nothing is installed and your Brain is
never contacted. Screenshot the end of it.

**Step 2 — Cloudflare sign-in (only if the technician says so on the call).**

```powershell
npx.cmd wrangler@4.73.0 login
```

One Allow click in the browser. Match the **account id**, not the name.

**Step 3 — install. Offline as far as your Brain is concerned.**

```powershell
.\brain-windows-update.ps1 install
```

It installs into `C:\FinancialBrain-kit\prefix` with an explicit `--prefix`, then checks **five
separate build signatures** inside what landed. The bank-feed module is signature 4 of 5. It also
checks the CLI version and, when present, the wrapper usage text. All checks must pass. A version
number alone cannot tell this build from one missing a fix.

**Step 4 — preview. Read-only. One health check, then one look at your Brain.**

```powershell
.\brain-windows-update.ps1 preview
```

This is where we expect to stop. See §5.

**Step 5 — only if the preview produced a real plan, which we do not expect:**

```powershell
.\brain-windows-update.ps1 apply -Run -Approval "<the exact sentence the preview printed>"
```

The technician reads you a plain-language paragraph first and you say yes to that. The long sentence is the
*record* of what you agreed to, not something you have to read aloud. It must be pasted back
character for character; the script compares it byte for byte and refuses anything else.

The bare update command does **not** enforce the runtime hash. The runtime hash in the sentence
names the kit being run; only the read-only preview can bind that hash before the update.

## 5. What each exit code means

Run `echo $LASTEXITCODE` right after a command to see it.

| Code | Meaning | What to do |
|---|---|---|
| **0** | the step did what it is for | carry on |
| **3** | **the expected refusal on a pre-0.4.4 Brain** | **this is Sunday's result.** Stop. Zip `receipts\` and send it. Nothing was changed. |
| **4** | the preview returned something that is neither a plan nor the refusal we expect | STOP. Do nothing else. Send `receipts\` and tell the technician. |
| **64** | you left off a switch, or used a mode name that does not exist | re-read the line and run it again |
| **65** | a hard stop: the kit, a guard, the prefix, the approval sentence or a freshness check | read the STOP line — it says exactly which. Do not work around it. |
| **2** | `selftest` had failures | tell the technician; do not run anything else from this kit |

## 6. If the update ever stops partway (not expected on Sunday)

If a real update ever stops with `UPGRADE_FAILED` at **"paused vector-drain health verification"**,
that is a known, unfixed defect in this build — the check that confirms the deploy looks one moment
too early. **The deploy landed.** Your Brain is left *paused*: it still answers questions and
refuses new material with a 503.

Then, and only then:

1. Do **not** Ctrl-C, retry, clear `VECTOR_DRAIN_MODE`, restore the D1 bookmark, or run `reindex`,
   `drain`, `ingest`, `forget` or `setup`.
2. `.\brain-windows-update.ps1 resume-preview` — **both commands inside it are supposed to exit non-zero.**
   That is the correct answer for a paused Brain, not a failure.
3. The technician reads you the RESUME sentence, you say yes, then
   `.\brain-windows-update.ps1 resume -Run -Approval "<that sentence>"`.
4. That sentence **expires after 20 minutes.** If the conversation runs long, run `resume-preview`
   again and use the fresh one. That is intended, not a fault.

`OPUS-CHECKPOINT` records the technician's Mac resume from 17:07:52 to 17:32:51 on 2026-09-17, 24 minutes
59 seconds with exit 0. That is a measurement of the technician's Mac, not a Windows estimate.

## 7. Never, on any day

- Never Ctrl-C the update, never close the window, never retry blindly.
- Never clear `VECTOR_DRAIN_MODE` by hand.
- Never restore the D1 bookmark as a first response.
- Never run `wrangler d1 export` against your Brain.
- Never run `brain drain` to hurry a queue.
- Never run `brain setup` on a paused Brain.
- On any stop: save the output, report it, and do nothing else that session. Recovery, rollback and
  repair each need a new approval on another day.

## 8. What to send back Sunday night

To **the technician through the agreed private channel**. **Nothing with a credential, a record, a
private path or a full environment dump in it.**

1. **The whole `receipts\` folder, zipped.** It contains local paths, the full JSON receipts,
   complete stdout and stderr captures, approval records, fingerprints, hashes, timings, and the
   log. Those files are **not redacted**. The script's own manifest summary hides account IDs,
   credential locators, profile values, display names, and probe text, and it is designed not to
   print credentials or record content. Still treat the folder as private and send it only to
   the technician in the agreed channel.
2. **Timings per step**, wall clock: discover, install, preview. The most useful single number.
3. **The exit code from `preview`**, and the `error_code` it printed.
4. **Your environment, confirmed rather than assumed**: Windows build, PowerShell major version,
   Node version, what `process.arch` said, and the install path — say whether it had a space.
5. **Which of the ten prerequisites actually bit you**: execution policy, the `.cmd` shims, an
   `%APPDATA%` redirect, quoting, the wrangler pin, the account picker, `curl.exe`, anything else.
6. **Did the Cloudflare sign-in work on Windows?** This is the single biggest open question in the
   whole path. Nobody has ever done it there.
7. **Screenshots** of: the five-signature output, the preview result, and any stop. Crop out your
   username and paths.
8. **Three sentences in your own words**: what was confusing, what was reassuring, and where you
   did not know what to do next.

That last one is worth as much as the receipts.

---

*If anything at all looks wrong, stop and say so. Stopping is always the right call here, and
nothing in this kit is on a clock.*
