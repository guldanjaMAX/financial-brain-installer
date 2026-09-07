# The release gate

`/update` gets run often, by people we are not on a call with, at times we do
not choose. So the question a release has to answer is not "do the tests pass"
but "does an update finish on a brain shaped like the ones that exist".

Nothing is tagged until every line below is true, and the receipt is pasted
into the release PR.

## 1. The suite

Full `npm test`, `EXIT=0`, on the exact commit being tagged. The log goes in
`~/brain-work/doctor/logs/`, never `/tmp`, which is wiped and took a day of
receipts with it on 2026-09-03.

## 2. The update rehearsal, on a real brain

A throwaway brain provisioned at an old version, loaded, its outbox poisoned
into the not-yet-visible shape, then updated with the candidate. Required legs:

| Leg | From | Why |
|---|---|---|
| Floor | the oldest version any CLIENT brain runs | the worst case that actually exists |
| n-1 | the previous release | the common case, a client one release behind |

The floor is a fact about the field, not a preference. It moves up only when
the last client on that version has updated. As of 2026-09-03 it is **0.2.0**
(a founding client). Brains built from a working branch are excluded by definition: no
published release can update them, and the schema guard refuses them.

A third leg from the oldest published tarball is worth running occasionally,
not every release.

## 3. The bytes under test are the bytes published

Hash the candidate tarball, hash the asset downloaded from the finished GitHub
release, and compare. Both machines did this independently on 2026-09-03 and it
is the property that makes the whole receipt mean anything: without it the
receipt describes a build nobody will ever install.

## 4. The receipt says what it did NOT cover

A receipt that lists only what passed is the same defect as a check that
reports its conclusion without its evidence. On 2026-09-03 the queued delete
row silently failed to be created, so the serial delete path was not exercised;
the receipt said so, and the release notes did not claim delete coverage.

`node scripts/audit-updates.mjs --release` prints the mechanical form of this
rule as a "This release does NOT cover" block, one line per deferred incident.
Paste it into the release note. Section 11 says how an incident gets there.

## 5. Fresh installs, the way a new client does one

Browser sign-in, no token, a clean prefix, `--no-connect`. Mac on every
candidate. Windows, in the VM bench, on every candidate that touches
provisioning, credentials or paths, and weekly otherwise: a field install failed
on Windows for two hours on 2026-09-02 and nobody could read why.

Induced conditions, each of which must name its cause on screen rather than
die with a generic sentence: a sign-in token with under five minutes left
(2026-09-02, 20:52, "GET /accounts failed (403)" blamed a token nobody typed);
a metadata index that takes three minutes to activate (the 90 s wait died on
2026-09-02, 15:32); an account not on Workers Paid; a database read refused.

The acceptance suite runs, and its headline says whether retrieval was actually
exercised.

## 6. Refusals: prove the tool says no

Negative legs. Each expects a refusal, and the refusal must carry both numbers
or both names, so the person reading it can act:

- a brain whose schema is ahead of the release (32 against 22 shipped) is
  refused by name, not waved through as an upgrade because 0.1.16 sorts before
  0.3.5;
- a version-string downgrade is refused;
- a migration ledger with a gap is refused;
- teardown refuses a protected name, refuses an unanchored match such as
  `owner-latest-backup`, refuses to run with the protected list unset, and
  prints the rule behind every allow and every refuse;
- a database quota refusal reaches the screen as a quota refusal, with the
  reset time and the plan that removes it, not as "could not verify".

## 7. The field inventory

A table of every live brain: name, Cloudflare account, owner, line (release or
field), product version, schema version, last update, safe to update. Refreshed
by one command against `/health` once `schema_version` ships there, by
`brain status` until then. The floor in section 2 is read from this table, not
from memory. The release note names, by brain, anything that must NOT take the
update; on 2026-09-03 that is the maintainer's own brain and the partner UI test brain,
and a partner's real brains stay listed as unread until someone reads them.

## 8. The path is the gate; the rate is a warning

The 2026-09-03 defect was 205,791 rows crawling through the legacy drain at
~150 rows/min, 23 hours for one client, and the leg that measured it passed
every check it had. So this gate exists. But the thing to fail on is the PATH,
not the rate.

**Fail** when the rows took the wrong path, which is ours and is directly
observable: bootstrap batches must exist, and the legacy phase must have
handled deletes only. Fail, too, when a leg does not finish inside the
deadline.

**Warn** on rate. Throughput belongs to the provider, not to us: it moves with
account tier, region and time of day. A gate that goes red for reasons outside
our code teaches everyone to override it, and an overridden gate is worse than
none. Compute the warning from the LARGEST corpus in the section 7 inventory
rather than from a fixed number, because any number derived from today's
biggest client is stale the day a bigger one arrives, and warn when the
projection exceeds half the six-hour deadline.

Reference points measured 2026-09-03: bulk rebuild ~1,740 rows/min (the maintainer's
epoch 1, 736,049 rows in 7h03m); legacy drain ~150 rows/min; the drain's own
steady state ~100 rows/min, one batch per confirmation.

## 9. Cadence

- Every push: section 1.
- Every release candidate, one command, about 90 minutes: sections 3, 5 (Mac),
  2 (floor and n-1, poisoned, with the delete row asserted present), 6, and the
  harness self-checks, with section 7 refreshed.
- Every Worker change and at least weekly: section 5 (Windows), the settled
  leg with the outbox proven empty by row count, and a strand-then-rerun
  recovery leg. A first-run update on a brain with rows mid-submission takes
  the full 20-minute writer pause (2026-09-03, 64 checks, 100 rows in flight);
  the receipt records how long that pause took and why.

## Harness rules, learned the hard way

- **Never edit a rehearsal script while it is running.** macOS bash reads a
  running script by byte offset. Editing one mid-run cost an hour on
  2026-09-02. Write a new file and fold it in afterwards.
- **Build injected SQL in a real language, not in shell quoting.** On
  2026-09-03 a `${VAR:+...}` expansion inside a double-quoted region emitted
  `'''upsert'''`, which SQLite read as an 8-character string including its
  quotes. The UPDATE matched nothing, succeeded, and reported success. A
  broken injection and a working one were indistinguishable in the output,
  which is the worst possible failure for a test harness.
- **Check the provision log before trusting anything after it.** A brain whose
  provision failed on a quota error still gets "updated" by the CLI, against an
  empty database, and every check after that describes nothing.
- **Treat a provider quota refusal as bench noise, not a code signal**, and say
  which it was in the receipt.
- **Every injection asserts its own effect.** Poisoned rows > 0, delete rows
  > 0, documents created = documents requested. A zero is a FAIL. The delete
  injection above reported "0 queued delete row(s)" and the leg went on.
- **Probe the quota before, scan for it after.** Three consecutive write+read
  passes a minute apart on a throwaway database before a leg; `grep 7500` over
  every log after it.
- **No `curl | grep -q` under pipefail.** grep exits on the first match, curl
  gets EPIPE, and a correct page reads as a FAIL (2026-09-03, 09:19). Download,
  then grep.
- **One provision at a time on the bench account**, enforced by a PID wait, not
  by remembering.
- **Teardown by exact resource name with the protected list set, then a 404
  on the worker's health URL.** "3 already gone" for a bare slug looks exactly
  like a successful teardown of the suffixed name.
- **The bench account is on Workers Paid and holds no live brain.** Until the partner's
  preview brain moves off it, it is on the protected list by name.

## 10. The repoint is verified by reading what is served

Moving the pin is not the same as having moved it. On 2026-09-03 `repoint-kit.sh`
updated the install guide, reported "guide pins: v0.3.5", passed its own check,
and left the UPDATE guide telling clients to download the previous release. The
only thing that caught it was fetching the live document and looking.

So: after any repoint, fetch every served guide and assert the version in the
document, then follow its download link and hash what comes back against the
tested tarball. Trust the artifact, never the script's report of itself.

## 11. The incident gate is scoped to the version being cut

**This section is a narrowing of the gate, and it should be read as one.**
Until now `audit-updates.mjs --release` held a release until every incident in
`docs/update-incidents.json` reached `verified`. That is a smaller gate now, and
the reason is worth stating plainly rather than dressing up.

### Why an unsatisfiable gate was itself the risk

The registry holds 26 incidents. Their acceptance texts demand real field
evidence, correctly: UPDATE-012 says hosted x64 CI is insufficient and requires
a physical Windows ARM64 machine, UPDATE-022 requires two real institutions and
a separately approved production pilot, UPDATE-011 requires a disposable restore
rehearsal. Requiring every incident ever opened to be field-verified before ANY
release cannot be satisfied by any release, ever. It is not a high bar, it is a
closed door with a sign on it.

A gate that can never go green is a gate people learn to walk around, and that
is exactly what happened. v0.3.6 was published 69 seconds before its own CI
reported failure, and a partner audit then found 22 defects. The gate did not
stop that release. It taught somebody that gates are the sort of thing you get
past. That is a worse outcome than a smaller gate that is actually obeyed.

### The rule

An incident blocks a release unless it is `verified` OR it carries a current,
well formed, permitted `deferral` on its own row in the registry:

```json
"deferral": {
  "version": "0.4.0",
  "blocked_on": "physical_hardware_unavailable",
  "reason": "prose: why the acceptance cannot be satisfied for THIS version",
  "unproven": "prose: what ships without field proof as a direct result"
}
```

A deferral never changes a status. `open` and `local-only` keep their meanings,
and the word `verified` never appears next to a deferred incident.

Six properties hold, and each is pinned by an assertion in
`test/update-audit.test.mjs`:

1. **Scope expires.** `deferral.version` must equal `package.json` `version`
   exactly. Bumping 0.4.0 to 0.4.1 invalidates every deferral in the file at
   once and the audit goes red until each is re-declared. That friction is the
   mechanism, not a side effect: re-declaring is a diff in which every deferred
   line changes, which is the review you want at the moment a new version is
   cut. `release.yml` already pins the tag to `package.json`, so the chain is
   deferral, package version, tag, tested commit. A deferral cannot outlive the
   artifact it excused.
2. **Every deferral carries a written reason.** `reason` and `unproven` are
   required prose past a real minimum length, so "hardware" and "later" do not
   pass. `blocked_on` is a closed enum naming why the evidence CANNOT YET EXIST:
   `physical_hardware_unavailable`, `live_third_party_account_required`. There
   is deliberately no value meaning "no time", "low risk", "CI is flaky" or "it
   is scheduled". A deferral that fits none of these is not a deferral, it is an
   unfinished gate. Adding a value is a reviewed code and test change.
3. **Deferrals stay visible, and so does every closure.** Deferrals print in
   full in every mode, with their real status, under a heading that says NOT
   verified, and again in the "This release does NOT cover" block that goes in
   the release note. `verified` rows print too, under "CLOSED on reviewed
   evidence", each naming the document it rests on. Every incident lands in
   exactly one of held, deferred or closed, and `releaseAdjudication` returns
   all three so the guarantee is tested rather than left to the print loop. A
   row that stops blocking can never do it silently, whichever route it took.
4. **A stale deferral fails, it is not ignored.** This mirrors
   `evaluateStrictRelease` in `scripts/scan-git-history-privacy.mjs`, which
   fails on stale credential dispositions for exactly this reason. Because the
   deferral lives on the incident it excuses, it cannot name an id that does not
   exist. What remains fatal: a deferral naming a version nobody is cutting, a
   deferral left behind on an incident that has since been verified, an unknown
   key inside the object (a mistyped `versoin` must not degrade into "no
   expiry"), a malformed shape, and a deferral on an undeferrable incident.
5. **The safe direction is the default.** An incident with no deferral blocks. A
   valid deferral with no version supplied blocks. An older copy of the script
   that predates this change ignores the unknown key entirely and blocks, so a
   registry from the future can never unblock an older gate.
6. **Three incidents are undeferrable, and their acceptance text is pinned.** UPDATE-010 governs what gets published,
   UPDATE-026 governs whether the published bytes are the tested bytes, and
   UPDATE-014 governs whether a brain reports its executable, package, manifest,
   Worker and D1 versions honestly. Their acceptance is a property of the
   release mechanism, not of a feature. Deferring one does not defer evidence
   about the product, it defers the ability to trust any other deferral, any
   receipt, and any claim about which bytes are running. Sections 3, 7 and 10
   all rest on them. A gate waivable by the process it governs is not a gate.
   The protection binds to an ID, so `test/update-audit.test.mjs` also pins a
   digest of what each of those three IDs actually says. Hollowing out an
   acceptance text while keeping its number would leave the set nominally
   intact and mean nothing; changing a digest is the reviewed moment to ask
   whether the set still holds.

### The other way past the gate, and why it needed the same treatment

`verified` is the second route, and it used to be the cheaper and quieter one:
one word plus any existing path under `test/`, `scripts/` or `docs/`. Both of
these exited 0 with all 26 incidents closed, including the three that may never
be deferred:

```json
"evidence": ["test/update-audit.test.mjs"]    a local test, in a gate whose own
                                              receipt ends "Local tests are not
                                              field recovery proof"
"evidence": ["docs/update-incidents.json"]    the registry citing itself
```

Making deferral written, scoped, expiring and published while leaving that
beside it would have been worse than useless: a maintainer under pressure picks
whichever exit is cheaper, and the cheap one left no trace in the receipt. So
`verified` now carries three mechanical rules, each of them enforcing what
`docs/UPDATE-AUDIT.md` step 8 already required in prose. Evidence must be a
document under `docs/`, never a test. It may not be one of the documents that
define the gate (this file, `UPDATE-AUDIT.md`, `PLAID-RELEASE-GATE.md`,
`MAINTAINER.md`, `update-incidents.json`, `docs/decisions/`), because a document
that says what must be proven cannot be the record of having proven it. And the
document must name the incident it closes and carry a tested package SHA-256,
so a file that was never about this incident cannot close it.

Adding an incident whose acceptance is about the release mechanism rather than
about a feature? Add its ID to `UNDEFERRABLE_INCIDENTS` in the same change. The
set does not grow by itself, and a new process incident is deferrable until
someone puts it there.

### What this does not defend against

A maintainer with commit rights who writes a plausible but false reason and
merges it, or who writes a fabricated evidence document that satisfies every
mechanical rule. Nothing in a repository stops either. The reviewer still has to
read the evidence; the rules above only stop a pointer at a file that was never
about the incident at all. What the rule removes is every
version of the abuse that is quiet, ambiguous, accidental or permanent: it
converts an unattributed filter change into a written, version-scoped,
published claim that expires on the next version bump. Do not describe it as
more than that.

### Attribution comes from git, not from a field

There is deliberately no `approved_by` in the shape. `update-incidents.json` is
tracked and packaged, `test/package-privacy.test.mjs` scans it for private
identity, and UPDATE-026's own acceptance says the all-ref history privacy gate
must not be waived. A human name in a deferral would fail the release on the
privacy gate. The commit, its author and its review are the record, and they
cannot be typed in by the person seeking the exemption. The same applies to the
prose: no person, client, account id or domain belongs in a `reason`.
