# Your own brain

A private brain that answers questions from **your own documents**, with
citations, and that tells you plainly when your documents do not contain the
answer.

It lives entirely inside your own Cloudflare account. Your files, your search
index, your keys. Claude Code is included in the owner setup commitment, and
Codex remains an optional second client. The installer connects the Brain to
whichever supported clients are present without placing a key in their config.

---

## Install it

This checkout is the unreleased 0.4.7 candidate. No 0.4.7 customer release or
immutable release asset exists. The versioned URLs in the candidate examples
below are intentionally unavailable placeholders for release review. Do not
run or share those commands as customer installation instructions. Check the
guided page for the current release status before installing anything.

The guided install path is at `financialbrain.ai/install`. It uses one immutable
release asset and installs into a folder owned by your user account, so it needs
no Git, `sudo`, or administrator access. After the Brain is installed, continue
at `financialbrain.ai/onboard`; `financialbrain.ai/onboarding` opens that same
onboarding page.

Before running the install command, use a normal terminal as your current user,
not `sudo`, root, or Run as administrator. The computer needs Node.js 22 or
newer and at least 2 GiB free on the drive that holds the per-user install. On
Windows that is the `LOCALAPPDATA` drive.

Before the first `brain tools` run, explain that it is a local setup action,
not a read-only check. It verifies those prerequisites, installs or updates the
reviewed Financial Brain technician skill, and may write local bootstrap status
and may update the current user's PATH to include the Brain CLI folder. Ask the
owner
to approve those local changes before running it.
Optimize never runs `brain tools`; it uses the non-writing machine-continuity,
MCP discovery, and configuration checks instead.

Mac or Linux:

```bash
# Unavailable 0.4.7 candidate placeholder. Do not run until the public channel names this release.
npm install --global --ignore-scripts --no-audit --no-fund --prefix "$HOME/.financial-brain" "https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v0.4.7/brain-installer-0.4.7.tgz"
# Optional: makes the shorter `brain` examples work in this Terminal window.
export PATH="$HOME/.financial-brain/bin:$PATH"
```

Windows PowerShell:

```powershell
# Unavailable 0.4.7 candidate placeholder. Do not run until the public channel names this release.
npm.cmd install --global --ignore-scripts --no-audit --no-fund --prefix "$env:LOCALAPPDATA\FinancialBrain" "https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v0.4.7/brain-installer-0.4.7.tgz"
# Optional: makes the shorter `brain` examples work in this PowerShell window.
$env:Path = "$env:LOCALAPPDATA\FinancialBrain;$env:Path"
```

On Windows, open PowerShell from the Start menu before installing. Do not run
the install inside Claude Desktop or another app's embedded terminal. Windows
can redirect that install into the app's private container, where normal
PowerShell cannot see it. The guided installer checks the process's native
Windows package identity and stops before `npm.cmd` if it cannot prove the
window is ordinary PowerShell.

The full command path below is deliberate. It keeps working after Terminal is
closed, without `sudo`, administrator access, or a shell-profile change.

Normal setup and updates use an owner-controlled Cloudflare browser sign-in
saved as this Brain's named local profile. The owner signs in, completes 2FA,
chooses the exact account, and approves Cloudflare's consent page. No API token
is created, revealed, copied, or pasted during an ordinary fresh install. A
hidden token prompt appears only when the released CLI explicitly offers its
bounded recovery path and the owner chooses it. That recovery-only token uses
the minimum reviewed scope: Workers Scripts Edit, D1 Edit, Vectorize Edit, and
Workers AI Read. It receives a short expiry and never belongs in chat or a
command argument.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" whatsnew
"$HOME/.financial-brain/bin/brain" doctor
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" whatsnew
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" doctor
```

---

## Set it up

Want to see the owner experience before connecting anything? From a source
checkout, run `npm run rehearse:onboarding`. It opens the real owner-workspace
bundle with synthetic data and an unmistakable local-only banner. No account,
credential, manifest, or deployment is used.

On Windows, use
[the checked-in owner rehearsal launcher](onboarding/11-windows-onboarding-rehearsal.md)
instead of starting the physical walkthrough through `npm.cmd`. The launcher
verifies the technician-supplied SHA, clean repository root, non-administrator
PowerShell, and Node.js 22+, then starts Node directly. The first run may
download one additional small set of public frontend packages and can be quiet
for several minutes. Do not email the `.ps1` file or paste its body; use the
copy in the exact reviewed checkout.

The bounded headless contract is
`npm run rehearse:onboarding -- --smoke --no-open`. It builds the same bundle,
starts only loopback services, verifies the guide, app shell, and synthetic
owner API, then exits with a stable sanitized result. It does not test automatic
browser opening or replace a physical Windows owner rehearsal.

Want to see how recovery behaves before install day? Run
`npm run rehearse:hiccups` from the source checkout. It safely interrupts
synthetic setup, folder, connector, migration, search, owner-action, access, and
technician scenarios. The final receipt separates automatic proof from the
remaining live Cloudflare, provider, and physical-device checks.

For an install day, `brain technician <manifest>` prints the eight-step read-only
plan. Add `--json` when a local coding agent is guiding the session. Run one
reviewed step at a time with `--run tools`, `cloudflare`, `smoke`, `google`, `zoom`,
`imap`, `passkey`, or `verify`. The owner still handles login, 2FA, OAuth consent,
and the physical passkey gesture. For the supported Google, Zoom, and IMAP
steps, tokens and app secrets go only into hidden terminal prompts or provider
pages.

**Bank connections are not part of ordinary onboarding yet.** They are still
being tested. You did nothing wrong, and there is no bank password,
verification code, or Plaid setup key to enter here. Ordinary onboarding leaves
bank connections off and the technician will never ask you to paste those
values into chat or a normal command. If this Brain is an already approved
pilot, its complete existing bank setup is left unchanged. If any saved piece
is missing, setup stops before changing a credential and explains the
separately reviewed next step.

The complete guide is
[onboarding/09-technician-setup-and-rehearsal.md](onboarding/09-technician-setup-and-rehearsal.md).
Claude Code explains each provider, purpose, minimum permission, and next
owner action before anything opens. When browser control is available, it can
handle official-page navigation and non-secret fields. The owner takes over
only for sign-in, 2FA, credential reveal or entry, consent, billing, and the
secure passkey window.

Setup front-loads five prerequisites. After the owner approves the disclosed
local changes, `brain tools` checks the machine and tells you one clear fix for
anything missing. The Cloudflare sign-in can verify the
exact account and product access, but its narrow permission cannot read billing
status. After sign-in verifies the account, setup opens that exact account's
plan page. The owner confirms **Workers and Pages, Plans: Paid** before setup
creates any resource. The same stop applies when setup resumes a prepared
manifest or uses an approved recovery or automation path.

1. **Node.js 22 or newer.** This runs the Brain CLI and pinned Wrangler.
2. **At least 2 GiB free on the actual install drive.** On Windows the supported
   per-user target is on the `LOCALAPPDATA` drive.
3. **A normal current-user terminal.** Do not use `sudo`, root, or Run as
   administrator. This keeps every local file owned by the person using it.
4. **Claude Code and an eligible Claude account.** Install the current native
   CLI from Anthropic, sign in with `claude auth login`, then run `brain tools`.
   The command proves the version, sign-in, Anthropic installation doctor, and
   pinned Wrangler 4. It also installs and reads back the personal
   `/financial-brain-technician` skill. Open Claude Code, type `/skills` to
   confirm it appears, then type `/financial-brain-technician` whenever you want
   the reviewed install, connector, recovery, or handoff guide. Claude Code's
   normal approval prompts stay enabled.
5. **A Cloudflare account on the Workers Paid plan.** 5 USD a month minimum.
   Cloudflare now lets Free accounts create the meaning-search index, but Free
   has prototype-scale vector, daily database-write, and Worker CPU limits. Paid
   is the supported production baseline so a real corpus does not hard-stop.
Written answers use Cloudflare Workers AI through the same account. There is no
second AI-provider account or API key to create.

Then run the command for your computer. Setup creates the `Financial Brain`
folder if it does not exist and remembers this manifest location for updates.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" setup "$HOME/Financial Brain/brain.manifest.json"
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" setup "$HOME\Financial Brain\brain.manifest.json"
```

It asks three short questions and does everything else itself: creates the
database and search index in your account, deploys the worker, generates and
saves your key, checks it is alive, and connects the brain to Claude Code plus
an installed Codex client. Successful Claude wiring writes an owner-only
`CLAUDE.md` beside the manifest. It gives Claude the exact Brain CLI and
manifest paths, but it does not grant whole-disk access, permission bypass, or
unapproved Cloudflare changes. On macOS a standard setup declares and verifies a login-Keychain
item before generating the key. Windows stores only DPAPI CurrentUser
ciphertext; Linux uses an owner-only adjacent file. An existing legacy Mac
`.brain-admin-key` remains authoritative instead of being silently moved.

The local Claude Code and Codex connection uses **Owner assistant** access. It
can answer from the Brain, add or correct durable information when the owner
asks, check that the connection is working, and review the Owner Financial Map.
It may create a complete non-authoritative map preview after an owner interview.
It cannot activate that map, delete records, or change who has access. Setup
verifies that the expected tools are actually present,
so a silently read-only owner connection is a failed setup, not a success.
Keep the AI client's normal approval prompt enabled. Every `brain_remember`
write is advertised as a data-changing action so a compatible client can give
the owner the final click.
The owner remains the administrator of their Brain. Deletion and access
changes stay in explicit owner controls instead of becoming silent chat tools.

Optimize asks at most one owner question per response across evidence
clarification, whole-source zoning, and its optional opening goal. A material
evidence conflict comes first, then a pending zoning choice, then the goal; a
pending conflict or zoning choice skips the goal. When records cannot support a
zone recommendation, Optimize states the whole-source choices and consequences
and lets the owner choose instead of guessing.

The Owner Financial Map is the denominator for later financial-completeness
work. Immediately after that opening decision, whether the goal was asked or
skipped, Optimize reads whether the map is current, stale, or not established
and reports its unresolved gaps.
Before the private read, it explains that no map snapshot will be sent, nothing
will change, and the assistant may still show an approval prompt for the read.
Before any financial-completeness conclusion, it offers an optional guided,
session-only interview, one short question at a time. It does not start the
interview automatically. If the owner declines, completeness remains unproven.
Structured records remain possible mentions until the owner confirms a complete
map. The interview submits nothing and changes nothing. Optimize ends before a
separately explained and approved preview may write one expiring,
non-authoritative review copy. The owner can add expected entities and accounts
that do not yet have ledger rows. Each entity-year separately records filing
units, required returns and forms, K-1 roles, books, payroll, and expected
sources. Activation is another separate owner decision and explained
fresh-passkey ceremony bound to that exact map and prior head. It never changes
ledger, source, tax, books, payroll, or account records.

### Repair a missing local assistant handoff

An Optimize audit stays read-only, including on a new computer. After the
report, the owner may select only the missing or stale local pieces they want
repaired. Preview them first:

```bash
brain assistant-repair ./brain.manifest.json --only technician-skill,claude-code-mcp,codex-mcp
```

The preview names every exact file or setting that would change, preserves
custom and disabled entries, and prints one state-bound plan ID. After the owner
approves that complete write set, run the exact apply command shown in the
preview. One approval covers the selected bundle. The command snapshots every
write destination before its first write, reads back each item exactly, and restores
the entire selected write set in reverse order if any item fails. The command
cannot replace the CLI and cannot change Brain records, sources, providers,
access, zones, passkeys, devices, or cloud resources. A CLI install or update
remains a separate release-controlled action.

### Audit a new computer before continuing a sync

Run the continuity audit before reconnecting sources or installing unattended
refresh on a replacement computer:

```bash
brain machine-continuity ./brain.manifest.json --json
```

It checks the exact local manifest and current package entrypoint, the saved owner
credential, connector credential readability, local source folders, supported
schedulers, source checkpoints, the technician skill, and the exact Claude
Code and Codex MCP configuration and protocol discovery. It may reuse the
Brain's authenticated read-only D1 source inventory, but it never opens a
browser, prompts, refreshes a provider, reads Cloudflare's control plane, or
changes anything.

The JSON contains only `ready`, `missing`, `unproven`, and `inapplicable`
statuses plus the smallest safe next step. It contains no customer name,
domain, source name, path, account or resource ID, credential, provider
identity, or cursor value. Today the D1 inventory deliberately masks cursor
values and does not echo Cloudflare resource IDs. Legacy local checkpoints also
do not carry a manifest binding. Local self-inspection cannot prove that its own
CLI bytes are the current authentic public release; that requires an
independently resolved release target and artifact receipt. The audit reports
all of those comparisons as `unproven`; it does not call matching source counts
or a self-declared version proof that a new computer can resume safely.

### Audit source receipts and plan provenance recovery

Optimize can read the Brain's own D1 source receipts without asking the owner
to sign in to Cloudflare or expose an admin key:

```bash
brain sources ./brain.manifest.json --json
```

The CLI resolves this Brain's existing owner credential from its reviewed
manifest and operating-system store, sends it only to the saved HTTPS Brain
domain, and returns one stable, complete source snapshot. It reports registered
source identity, a safe connector/provider label, zone, masked scope and cursor
receipts, first and last ingest evidence, complete-history-through, physical
and logical document counts, readable and unreadable counts, extraction method,
OCR state, derivation lineage, exact missing provenance fields, and the latest
validated Gmail failure receipt when one exists. That receipt is limited to a
closed operation category, HTTP status, canonical provider reason, aggregate
checkpoint counts, and cursor-preservation state. It never returns a provider
message, raw sync cursor or cursor value, configured root values, document
title, URI, provider id, document id, path, content, or secret. It does not infer
an entity, owner, tax year, or whether an empty document was a scan.
This is source-inventory contract v3. Inventory and recovery cursors are bound
to that version; a v2 response or cursor is refused instead of being
misinterpreted.

To inspect the exact records behind the recovery counts, request one bounded
preview page:

```bash
brain sources ./brain.manifest.json --json --recovery
brain sources ./brain.manifest.json --json --recovery --source drive
```

Each candidate has a stable opaque digest, closed reason codes, and only the
stored text and provenance state needed to plan a repair. Use the returned
`--cursor` value to request the next page. A changed corpus invalidates the
cursor instead of mixing two snapshots. Recovery mode does not run OCR,
reingest, repair, or any other write. A later write requires a separately
reviewed and approved repair path.

For one source that has recovery candidates, inspect the legacy recovery plan:

```bash
brain provenance-repair ./brain.manifest.json --source drive
```

The preview is read-only. It checks that the exact source is one
manifest-declared local folder, Drive, Gmail, or Calendar source; that this
computer can still read the required source and saved credential; and that no
supported local scheduler can race the rewalk. Its plan ID binds the manifest,
selected source/configuration and exact saved credential identity, complete
source inventory, exact opaque candidate set and reasons, reset/no-limit mode,
and OCR policy. Worker snapshot
timestamps are shown as observations but do not make an otherwise unchanged
plan stale.

Schema 1 is inventory-only and always reports `can_apply: false`. It has no
durable candidate-resolution ledger, so a candidate disappearing after a
rewalk could mean repair, deletion, replacement, refusal, or skip. The CLI
therefore prints no apply command. Any legacy `--apply` invocation stops before
reading the manifest, credentials, remote state, or source, and changes
nothing.

Migration 0042 adds a separate foundation for direct evidence about one to ten
explicit local-upload originals. A private admin route can seal raw
source-relative locators into stable opaque IDs, append a closed observation
outcome, and later revalidate that observation against the exact stored
document family. Schema 42 accepts only gaps, failures, and adjudicated
exclusions; accepted repair remains blocked. Raw locators are neither copied
into the observation ledger nor returned by that route.
Read-only local assessment disables OCR and does no filename or
content-similarity matching. This bounded contract is not a whole-source
enumeration, is not connected to the legacy repair CLI, and does not itself
authorize OCR, reingest, deletion, or repair.

Migration 0043 makes the missing raw-original binding representable without
enabling repair. The full-admin-authorized local ingest path attaches a private
hash and byte count from the exact file bytes it extracted. The Worker
HMAC-seals the existing `source_id` or structural `part_of` locator, assigns a
fresh
`document_revision_id`, and commits an immutable
`source_original_result_bindings` receipt in the same D1 transaction that
commits the revision's final content hash. The raw locator is not copied into
the immutable receipt or ledger. It remains in the existing document identity
fields needed for retrieval and source lifecycle. Exact replay is unchanged,
but different raw bytes with identical extracted text create a distinct
revision and cannot inherit the prior binding. Structural `#partNofM` families
are supported; ambiguous
multi-record `family_of` exports and legacy rows remain explicitly unbound.
This is a full-admin-authorized assertion, not cryptographic proof of the
producer binary or a server-side recomputation over uploaded raw bytes. Both
the schema-43 D1 guard and the Worker still reject every accepted observation,
and no OCR, backfill, repair, or deployment is implied.

Schema 43 is necessary but not sufficient for acceptance. A later stacked gate
must add a database-enforced result-family receipt that binds the original to
every current document revision and the exact resulting chunk set, including
title prefixes. That gate must also prove target outbox zero, global vector
readiness, deterministic private retrieval, and citation to the same family.
Accepted outcomes stay fail-closed until that complete chain is separately
reviewed and proven.

### Inventory the financial picture

Optimize can read the structured financial evidence without searching prose or
changing anything:

```bash
brain financial-picture ./brain.manifest.json --json
```

The receipt always names entities and possible mentions separately, exact
stored periods, masked accounts, non-disclosing QuickBooks company references, tax and
filing evidence, custody, provenance, supersession, and structured conflicts.
Nested reconciliation targets are keyed references, never raw transaction or
provider IDs.
Optimize uses those records and blocking gaps as an interview map: it resolves
what the stored provenance can answer first, then asks only a material question
the evidence cannot resolve. An interview answer never auto-confirms a mapping
or authorizes a write. Any correction, supersession, OCR, reingest, or
reconciliation ruling remains a separate previewed action that requires the
owner's explicit approval.
Every section reports its total, returned count, truncation, cursor, applied
filters, schema limitations, and page-bounded verification gaps. Each record
names stored extraction state and exact missing provenance or freshness fields,
plus whether the gap blocks financial verification. Payroll applicability,
filing-unit identity, tax form, K-1 issuer-versus-recipient role, rejected
scan-only versus empty documents, and freshness evaluation policy are currently
reported as Unavailable because the schema cannot prove them. An empty list
never stands in for one of those gaps.

Use `--entity <exact-id>`, `--year <YYYY>`, `--period-start YYYY-MM-DD`,
`--period-end YYYY-MM-DD`, `--sections <comma-separated-names>`, or `--limit
<1-500>` to narrow the receipt. Continue a truncated section by requesting only
that section with its returned `--cursor`. Each page is a separate snapshot;
compare `database_version_ref` when it is available before combining pages.
The content hash binds the exact page plus its as-of, consistency, and keyed
database-version metadata, and will differ across separately captured pages. The
command reads the durable admin credential from the owner's configured
protected store only and deliberately ignores an ambient `ADMIN_KEY`
environment variable. It requires a saved valid HTTPS `brain.domain` and fails
before any account lookup, Wrangler session, credential read, or request when
that domain is missing or invalid. It has no flag for a literal key. With
`--json`, even a failure is one sanitized machine-readable error receipt rather
than prose.

To prove that a later ingest did not introduce new provenance debt, pass the
exact `snapshot.as_of` from the earlier receipt:

```bash
brain financial-picture ./brain.manifest.json --json \
  --sections entities,periods,accounts,books,tax_returns,filing_payments,evidence,conflicts \
  --provenance-baseline 2026-09-10T12:00:00.000Z
```

The gate considers only durable rows whose stored `recorded_at` is strictly
later than that cutoff. Future cutoffs are refused. It returns
`insufficient_scope` instead of passing when a page or nested derivation-root
list is truncated, a timestamp cannot be classified, or the selected registry
has no records. Counts are provenance-record occurrences and can overlap when
the same evidence appears in more than one requested section. Source lineage
status and reason codes remain separate from mapping assertions. Because the
current schema has no owner-actor receipt for entity or mapping confirmation,
an `owner_stated` and `confirmed` tuple remains a stored assertion and produces
a current owner confirmation gap rather than an owner-confirmed state. Each
material entity field, including kind, status, holdings, ownership percentage,
tax class, and relationship, carries its own confirmed or unconfirmed state so
Optimize cannot present a stored guess as settled owner truth. A stored
owner-stated assertion also remains provenance debt until the schema can prove
the owner actor and ceremony. Any requested Unavailable section forces a
baseline result to `insufficient_scope`; it cannot be excluded into a pass.
Raw corpus document UIDs, feed keys, source names, and structured source
locators stay inside the Worker because they can contain provider identifiers.
The receipt exposes domain-separated HMAC-SHA-256 references plus explicit
presence and resolution states instead. Those references are keyed by the
Brain's secret, stay equal across its pages until that secret rotates, and
cannot be dictionary-tested without the secret. Missing signing material fails
closed before records are returned. Only connector kinds from a closed
allowlist may be readable; every actual source or feed key remains hash-only.
The Worker and CLI enforce the same closed version-2 response schema and reject
unknown or raw-looking nested identifier fields before output. Orphaned coverage or statement
rows are counted tenant-wide, remain visible as unresolved period evidence,
and force `insufficient_scope` even when an entity filter cannot attribute
them.

This inventory reports what the Brain can cite. It does not decide that the
financial picture is complete or that the books or tax filings are correct.
Its gap output is recovery planning only and cannot OCR, reingest, or repair a
record.

Legacy `documents.text_source` and `text_reliable` values are not extraction
proof. Financial Picture runs every linked corpus row through the shared
`storedProvenanceAssessment` receipt validator and exposes normalized text
fields only when that assessment succeeds. A missing, malformed, or
row-mismatched receipt makes extraction unavailable and counts as provenance
debt. Source coverage is likewise projected by the shared coverage helper from
the registry row and one exact latest sync-run receipt carried through the same
D1 batch. A clean older range is never combined with newer refused, failed, or
unmeasured counts, and the route still does not claim that a source is current
or that the owner's machine is the blocker from a raw registry status. Grouped
QuickBooks provenance materializes at most 50 ordered receipts; the full exact
evidence count remains visible and every unmaterialized member is explicit
unassessed debt.

If a first setup is interrupted after D1 commits only part of a migration, the
next setup does not guess that the database is unused. It stops before another
write and prints two exact commands: run `brain update <manifest>` to establish
the verified paused-writer boundary, then rerun `brain setup <manifest>`. If the
update later stops because setup has not saved its admin key yet, still rerun
setup as instructed; the migration boundary is already safe and resumable.

## Update it

First install the exact release named on `financialbrain.ai/update`. Then run
the update command from any folder. It uses the manifest location saved by
setup, even after Terminal has been closed and reopened.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" update
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" update
```

If this Brain was installed before manifest remembering existed, name the full
manifest path once. Every later update can use the no-manifest command above:

```bash
"$HOME/.financial-brain/bin/brain" update "$HOME/Financial Brain/brain.manifest.json"
```

On Windows, use:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" update "$HOME\Financial Brain\brain.manifest.json"
```

The update verifies the Cloudflare account, requires a D1 restore bookmark,
deploys and verifies a temporary paused Worker, waits for older Worker requests
to finish, and applies migrations. A legacy corpus is then rebuilt in durable
1,000-vector batches while writes remain paused. Several disjoint batches may
be accepted at once, but exact-generation readback is what confirms each vector
before its batch is acknowledged. An interrupted run resumes from D1 instead of
starting over. Only after that proof does update deploy active mode, run
exact-version health and the full acceptance suite, read the committed version
back from D1, and update the local manifest. Paused mode rejects every
corpus/source write, not only vector drain. A failed update keeps the bookmark
and tells you the safe rerun path. It never restores automatically because
restoring would discard newer writes.

The fifteen-minute no-movement check counts only continuously observed waiting.
If the computer sleeps during the rebuild, waking it resumes the durable work
instead of treating the sleep interval as proof that the index stalled. The
separate six-hour wall-clock safety limit still bounds the phase. If that limit
ends the command, rerun the same update; the Worker remains safely paused until
the exact projection proof succeeds.

---

## Load your documents

```bash
brain ingest ./brain.manifest.json --path "/a/folder/that/matters" --dry-run
```

The dry run sends nothing. It reports what it **would** load, and more usefully,
what it would skip and why. Read that list. It is where you find out what your
brain will not know.

When a local assistant needs to run a Google Drive or Calendar preview, add
`--aggregate-json`. This explicit mode prints one versioned JSON object with
counts only. It never prints filenames, titles, event subjects, document or
source IDs, URLs, content, credentials, or raw provider errors. The ordinary
dry run remains the detailed owner-terminal view. A complete aggregate preview
exits zero; a bounded, incomplete, or failed one still prints the same safe JSON
shape and exits nonzero so automation cannot mistake partial coverage for proof.
A Drive preview does not read the Brain inventory, so it reports
Brain-dependent send, unchanged, and removal-effect counts as `null` and exits
incomplete instead of turning missing comparison evidence into zero. Provider
observation and skip counts remain available.

Then drop `--dry-run` to load it for real. Large loads are resumable: if it is
interrupted, run the same command again and it continues from where it stopped.

Drive, Gmail, IMAP, and local-folder refreshes may discover material that was
deleted, newly excluded, or no longer readable. Each refresh combines every
removal reason into one plan. Up to 100 documents and 10% of what that source
loaded can be reconciled as routine source changes. One current Gmail deletion
or policy exclusion is also routine, so a small mailbox can converge. A plan
crossing the applicable limit stops before deleting anything or advancing the
source cursor. It prints aggregate counts and an opaque approval fingerprint,
never filenames or document IDs. Review the cause, then add the exact
`--approve-removals <fingerprint>` value only when the plan is expected.
Drive treats an inaccessible file differently: a 403 or 404 cannot prove
whether the file was deleted or access was revoked, so cleanup and cursor
advancement stop until visible trash or a visible move outside the reviewed
roots provides source proof.

Gmail reads additions, deletions, and label changes from its typed history. A
complete pass also compares the filtered mailbox snapshot with the live D1
inventory, so a stale stored message cannot survive simply because history
expired. Every planned Gmail removal is read back before its history cursor or
credential-scanner version is marked complete. Scanner v5 makes local folders,
Drive, Gmail, and IMAP recheck previously accepted documents with the corrected
credential rules.
Promotions, Social, and Forums are excluded by default. Updates stays included
so statements, confirmations, and reminders are not silently missed.

The local-folder guard matters because a folder that failed to mount looks
exactly like a client who deleted everything in it.

Ask directly in the terminal, even if you do not have Claude Code or Codex:

```bash
brain ask ./brain.manifest.json
```

The command prompts for the question so it does not enter your shell history.
Ask something only your documents could answer, then something they definitely
do not cover. The second answer matters as much as the first.

If you run `brain drain <manifest>` after a load, its completion line separates
the total vectors currently available to search from the vectors newly
confirmed during that command. A healthy no-op can therefore report an existing
query-visible total and zero newly confirmed, rather than making the index look
empty.

## Check changing facts and access zones

```bash
brain check ./brain.manifest.json
```

`brain check` is read-only by default. It searches for returned records that
give different values for changing facts such as a mailing address, phone
number, email address, or recurring amount. Each value is shown beside the
source rule that gave it an evidence tier. A source tier is a review aid, not
an automatic winner. A partial or degraded search is labeled as unchecked, and
an empty search result is never called proof that the corpus contains nothing.
The record review first says exactly how many categories completed. If source
history is not yet proven or the search index is still building, an all-unchecked
run is labeled as waiting and makes no agreement finding. It never presents
zero completed categories as a clean result. If even one category is still
unchecked, `brain check --set` exits nonzero without prompting or writing, so
an agent or script cannot mistake a refused partial review for success.

The same report reads the Brain's access-zone readiness proof. It shows the
grouped source, document, and chunk counts for context, while the source
registry remains the authorization authority. The aggregate proof also counts
documents and chunks outside that registry, plus stored zone projections that
disagree with it. Only an explicit `ready` state with none of those gaps is
shown as complete. Missing, partial, or inconsistent proof is unavailable
rather than clear. The command never assigns a zone. Use `brain zone` only
after the owner decides that access boundary.

A zone assignment repairs a bounded pass and saves each completed pass in D1.
If Cloudflare returns the specific HTML 500 seen in the field after one of
those passes, the CLI says that the pass may already be saved and retries the
same idempotent source-to-zone checkpoint after 1, 2, and 4 seconds. It prints
every retry and stops after three. JSON errors, other HTTP statuses, transport
failures, zone listings, and incomplete assignment arguments are never replayed.

The subject defaults to `client.display_name` in the manifest. If the Brain is
about a different person or organization, state it explicitly:

```bash
brain check ./brain.manifest.json --subject "Example Organization"
```

Only add `--set` while the owner is present. It asks one question per returned
conflict and writes one uniquely identified, dated confirmation record from
the answers they give. Pressing Enter or choosing an invalid option leaves that
item unresolved and writes nothing for it. If the owner resolves no item, no
record is written.

---

## What it reads

PDF, Word, Excel, PowerPoint, rich text, email, mail archives, meeting
transcripts and subtitles, calendar exports, CSV, HTML, Markdown, JSON and
plain text.

**A file with many things in it becomes many documents.** A `.mbox` mail
archive is a mail folder, not a document: indexed whole it would be one
enormous blob dated by whichever message came first, and every citation into it
would point at a filename. It is split, so a citation points at one message.

**Transcripts keep their speakers.** A `.vtt` or `.srt` is read as
`Name: what they said`, because "who agreed to that" is unanswerable from an
undifferentiated wall of sentences. It is the same converter the live Zoom
connector uses, so a call saved by hand and a call delivered by webhook read
identically.

**Scanned PDFs can be read, and are marked when they are.** A scan is a picture
of a page with no text in it, and in a real corpus that is roughly one PDF in
seven. With OCR turned on, each page is sent to a model inside YOUR OWN
Cloudflare account and transcribed. Three things are true about that, and the
product says all three rather than the first one:

- **A machine read it, so it can be wrong.** Every document read this way is
  marked as OCR, and every answer that leans on one says so and scores lower
  for it. A blurry read never looks like a clean one.
- **A page it could not read is named, not skipped.** Unreadable pages appear
  in the text as `[[page N: could not be read]]`. Nothing is quietly missing.
- **A bad reading is still refused.** If the model described the page instead
  of transcribing it, or produced too little to be a page, the file is reported
  exactly as it was before OCR existed. Refusing beats a confident wrong answer.

It is **off by default**, because it spends money on your account, once per
scanned page. Turn it on with `safety.ocr.enabled` in the manifest. Before a run
the installer prints what the pages will cost and how long they will take.

---

## Undo

```bash
brain forget ./brain.manifest.json --source documents
```

Shows you exactly what would be removed. Nothing goes until you add `--yes`.
The preview also proves that the deployed Worker can remove the source registry
row and record the audit event behind the same write barrier. If it cannot,
the CLI refuses before authorizing document deletion.

---

## Honest limits, so none of them are a surprise

- **OCR is optional and off by default.** Local synthetic scans prove the
  extraction, refusal, provenance, spend-cap, and citation paths. A private
  real-scan field gate is still required before calling it production-proven.
- **Outlook .msg and PST are not supported.** Export to .eml or .mbox and load
  the folder. Both of those are read: an `.eml` is one document, and an `.mbox`
  is split into its individual messages, each keeping its own subject, sender
  and date. (Before this version half that sentence was false — there was no
  `.mbox` reader and the archive was silently skipped.)
- **Google Drive OAuth and resumable partial real-account ingest are verified.**
  A complete no-limit first sweep and the live add, edit, refuse, recover,
  trash, and incremental-refresh cycle remain field gates. Gmail is covered by
  the same OAuth and cursor-safety test harness, including typed deletion,
  relabeling, guarded cleanup, and exact D1 readback. Promotions, Social, and
  Forums are excluded by default; Updates remains searchable. Gmail has not yet
  completed a real-account production run. Each client registers their own
  Google OAuth app, which takes about fifteen minutes.
- **Google Drive can refresh itself on macOS.** Its schedule is declared in the
  manifest and installed as a per-user LaunchAgent. Windows and Linux still
  require manually re-running the Drive refresh.
- **WhatsApp exports are the safer path.** The separate live paired-device
  connector is unofficial, violates WhatsApp's Terms of Service, and may lead
  to an account restriction or ban. Business automation should use Meta's
  official WhatsApp Business Platform, which is not built into this Brain yet.
- **One local folder can refresh itself too, also macOS only.** Name it in the
  manifest and `brain schedule <manifest> --install --folder` reloads it on a
  schedule: new files load, edited files reload, deleted files are removed. It
  is what makes "export it into this folder and forget about it" true for a
  folder that is not inside Google Drive. Hourly by default, so it is a drop
  box, not a live feed. Elsewhere, run the same load yourself.
- **The admin key is operator-only; people use passkeys.** An owner passkey has
  the owner's full workspace. A scoped person sees only exact documents granted
  to that session, and an unknown or unavailable grant fails closed. These
  contracts pass locally against the real Worker and migration code. A physical
  passkey ceremony on the final customer domain and devices remains a required
  field test before calling this production-proven.
- **Facebook Messenger has an export path, not a live connector.** Select
  Messages and JSON in Meta's Download Your Information flow, then load the
  exported `message_*.json` files through Drive or the watched folder. The
  parser is fixture-tested and has not yet processed a reviewed real export.
- **Slack and Notion are built behind field gates.** Their OAuth, pagination,
  incremental read, retry, and disconnect paths pass scripted provider tests.
  Neither has completed an accepted real-workspace run, so use an approved
  export or watched folder until that gate passes for the client.
- **Meeting transcripts arrive two ways, neither of them a transcription
  service.** Zoom cloud recordings deliver themselves to a webhook on your own
  worker. Worker maintenance checks an initial recent 30-day window and then a
  two-day overlap, but it does not provide complete historical backfill. A paid
  Zoom seat is required. A transcript you save by hand as `.vtt` or `.srt` is
  read from any folder that is ingested. Nothing here transcribes audio; there
  is no speech recognition in this product.

---

## If something goes wrong

Installer commands are designed to resume or adopt completed work. The typed
recovery guide below says whether the same command is ready now, ready after one
step, or worth reviewing with the technician first.

```bash
brain doctor                          # what is wrong with this machine
brain health ./brain.manifest.json    # what is wrong with the brain
brain diagnose ./brain.manifest.json  # what is missing or stored incorrectly
brain secrets ./brain.manifest.json   # exact durable ADMIN_KEY rotation command
```

Fresh setup and `brain tools` require signed-in Claude Code. Once a manifest
contains its provisioned Cloudflare resource identities, `brain doctor
<manifest>` may continue its read-only checks when `codex login status` proves
Codex is signed in, while reporting missing or signed-out Claude Code as an
optional local-client gap. This does not prove or repair Claude Code, its skill,
or its MCP registration. If neither supported client is signed in, doctor still
stops.

`brain diagnose` is read-only and safe to rerun. On a large corpus it fixes one
chunk high-water mark and checks bounded keyset pages, so no individual page has
to scan the whole database. The report says `not verified` instead of zero when
a page, statement budget, or closing corpus marker prevents a complete count.
Duplicate-chunk and per-document outlier measurements are explicitly marked as
not observable when their exact grouping would require another whole-corpus
pass.

The failures most likely to hit a working install, each with what you see, why
it happens, and the exact command, are in
[onboarding/06-runbook-top-ten-failures.md](onboarding/06-runbook-top-ten-failures.md).
It ships inside this package, so it is on your machine already and readable with
no network.

For an admin-key rotation, use an approved no-history credential launcher to
provide the replacement only to `brain secrets`, keeping it out of shell
commands and exported environment values. After a read-only Cloudflare account check, the
command updates and verifies the manifest's declared Keychain item or adjacent
protected file, then applies that durable desired value to the Worker. If the
remote write fails, rerun the same command without supplying the replacement
again; the verified durable copy is reused. Standard macOS setup creates the
non-secret Keychain locator
automatically; it is not a credential and is safe to keep in the manifest.
Setup, secrets, and upgrade also remove only the known Supabase or Anthropic
Worker secrets that the manifest does not allow. Other secret names are left
untouched, and every removal is read back from Cloudflare.

For technical detail on any error, put `BRAIN_DEBUG=1` in front of the same
command.

Recognized command failures attempt to leave a private, sanitized issue note on
this machine whenever its local journal is writable. A note contains the
installer version, command, platform, and a typed failure code. Its fixed schema
has no place for document text, filenames, paths, account IDs, URLs, questions,
answers, logs, stack traces, or credentials. The installer keeps these notes on
this machine. An export written to a synced destination may be uploaded by that
sync service.

Each typed code also has a calm recovery guide. It explains what happened, what
stayed protected, whether retrying is safe, and the next useful step:

```bash
brain support --explain AUTH_REQUIRED
brain support --explain AUTH_REQUIRED --json  # for a local coding assistant
```

Preview and export contain only recent shareable notes: at most the newest 200
valid events from the last 30 days, capped at 2 MiB. After a successful write,
the installer makes a best-effort cleanup of complete private events outside
those retention bounds. Fresh and concurrently written files are protected by
a grace period. Partial or unsafe artifacts are not deleted automatically and
may remain. Confirmed clear removes partial or invalid regular files after
safety checks; links and special files are refused for manual review. Cleanup
failure never replaces the command's original result.

```bash
brain support                                  # recent shareable count and limits
brain support --preview                       # exact bounded shareable bytes
brain support --explain <issue-code>           # plain-language recovery
brain support --export brain-support-review.jsonl  # destination sync may upload
brain support --clear --yes                    # clear the journal after safety checks
```

---

## For developers

Architecture, testing, the storage design and the retrieval measurement gates are in
[docs/README-developer.md](docs/README-developer.md).

```bash
npm ci --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm --prefix frontend run test:browser:install
npm test
npm --prefix frontend test
npm run audit:regressions
```
