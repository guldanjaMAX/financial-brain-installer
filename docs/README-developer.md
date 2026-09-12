# brain-installer

Provisions a retrieval brain into a **client's own Cloudflare account**. Text and
keyword search live in D1, vectors live in Vectorize, and the Worker fuses them.
Nothing runs on our infrastructure. Normal setup uses an owner-approved named
Cloudflare browser profile in the owner's operating-system credential store; it
does not create or copy an API token.

**Status: unreleased 0.4.8/schema45 field candidate, held.** Provisioning,
retrieval, resumable ingest, guarded deletion, owner actions, exact entity
scope, document grants, passkey observability, financial imports, provenance
binding for eligible single-record local file ingests, bounded one-original
accepted-resolution evidence, and restart-safe migrations are covered by local
product and contract suites. Local proof is not field proof. At this freeze the
39-row release audit has 35 unresolved incidents, no renewed deferrals, and four
rows closed on reviewed evidence. No public 0.4.8 asset or customer update
exists. The earlier held 0.4.7 candidate was never tagged or published, and its
identity is retired rather than reused for these changed bytes. See "What is
not built," `CONNECTOR-BACKLOG.md`, and the
[0.4.8 candidate evidence plan](release-evidence/v0.4.8-candidate-release-evidence-plan.md)
before promising anything to anyone.

Engineering changes follow [the code, test, documentation, and tracking
standard](./ENGINEERING-STANDARDS.md). Architecturally significant choices are
recorded in [append-only decision records](./decisions/README.md), beginning
with the [Cloudflare-native install decision](./decisions/001-cloudflare-native-standard.md).
The [maintainer guide](./MAINTAINER.md) gives the exact safe change, package,
release, owner-update, rollback, credential, and issue-evidence workflow.

---

## Requirements

- Node 22 or newer (uses `node:sqlite` for the migration tests)
- At least 2 GiB free on the actual per-user install drive. On Windows this is
  the drive containing `LOCALAPPDATA`.
- A normal current-user shell without `sudo`, root, or Run as administrator.
- A Cloudflare account **on the Workers Paid plan**, 5 USD a month minimum.
  Vectorize has a Free allowance, but its vector capacity, D1 daily-write limit,
  and Worker CPU limit are prototype-scale. Paid is this product's supported
  production baseline.
- An owner-controlled Cloudflare browser sign-in to the exact account that will
  hold the Brain. The owner completes login, 2FA, account selection, and
  Cloudflare consent. The named install profile is stored through Wrangler's
  protected local credential store.

`brain tools` and setup check Node, the actual install drive, and elevation
before provisioning. The narrow Cloudflare session verifies account and product
access but does not prove billing state. After sign-in verifies the exact
account, setup opens its account-specific plan page. Before resource creation,
the owner must confirm **Workers & Pages > Plans > Paid** there. Do not widen the
session just to inspect billing. Prepared-manifest, recovery, and automation
setup paths have the same account-bound prerequisite.

A scoped Cloudflare token is a bounded legacy, automation, or recovery path,
not a fresh-install prerequisite. Use it only when that exact path is explicitly
selected and keep it inside the reviewed hidden prompt or approved no-history
launcher.

---

## Install

```bash
node brain.mjs doctor                        # check this machine first
node brain.mjs setup                         # owner browser sign-in, then one-command setup
```

`setup` runs everything below in the only order that works, generates the admin
key, and registers the brain with Claude Code and Codex. The steps are also
available individually:

```bash
cp templates/brain.manifest.json ./acme.manifest.json   # then edit it
# Low-level automation must inject the scoped Cloudflare token through an
# approved secret-manager-backed launcher. Never paste it into a shell command.

node brain.mjs verify     ./acme.manifest.json   # token, account, every service
node brain.mjs provision  ./acme.manifest.json   # D1 + Vectorize, writes IDs back
node brain.mjs migrate    ./acme.manifest.json   # schema
node brain.mjs deploy     ./acme.manifest.json   # worker, bindings, drain cron

# AFTER deploy, not before: a secret is set ON a worker script, so the script
# has to exist. Deploying without secrets is safe, because the deploy carries
# keep_bindings and later deploys preserve whatever is set here.
#
# `brain setup` generates the admin key itself. `brain secrets` is the one
# durable rotation path for both setup and manual use: after read-only account
# resolution, it updates and exactly verifies either operations.admin_key_secret's
# macOS Keychain item or .brain-admin-key, then applies that desired value to the
# Worker. Standard setup declares a deterministic Keychain locator automatically
# on macOS unless an existing legacy adjacent key must be preserved. On Windows
# the adjacent file contains DPAPI CurrentUser ciphertext, not the plaintext key,
# and the current-user ACL must succeed before that replacement is committed.
# Existing Windows plaintext key files remain readable until the next rotation.
# Setup, secrets, and upgrade list Worker secret names and remove only the known
# Supabase or Anthropic names disallowed by the manifest. Removal is read back;
# every unrecognized secret name is preserved.
# Beginner installs use `brain setup`, which generates and persists this key.
# A deliberate operator rotation must inject the replacement through an
# approved no-history credential launcher.
node brain.mjs secrets    ./acme.manifest.json
# If the remote write failed, rerun the same command with no credential entry.
# The verified durable value is reused until the Worker converges.

node brain.mjs health     ./acme.manifest.json   # prove it, including vector backlog

node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --dry-run
node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --source clientdocs

node brain.mjs test       ./acme.manifest.json   # full acceptance suite
```

The supported beginner update is `brain update [manifest]`. It verifies the
account, requires a pre-change D1 bookmark, deploys and verifies a paused
compatibility Worker, waits the declared 20-minute old-invocation window, and
migrates. While the write barrier remains active, schema 13 rebuilds a legacy
projection through durable 1,000-row batches with a bounded number of disjoint
mutations in flight. Exact `getByIds` generation readback acknowledges each
batch, and D1 receipts make interruption resumable. Update deploys active mode
only after the whole projection is verified, then reconciles allowed Worker
secrets, requires exact-version health plus the full acceptance suite, commits
and reads back D1 version state, and atomically commits and reads back the local
manifest version. Paused mode rejects every corpus and source mutation before
D1 access.
The older `brain upgrade` command uses the same engine and cannot
bypass those gates. Neither path restores D1 automatically because that would
discard writes made after the bookmark. Direct `brain migrate` refuses a live
D1 install when the pending writer-protocol migrations require this cutover.

The accelerated bootstrap keeps two separate time boundaries. Its six-hour
wall-clock deadline remains a hard stop. Its fifteen-minute no-movement budget
counts only intervals the updater could continuously observe, so a laptop sleep
or another unobserved local pause cannot by itself stand in for proof that the
remote projection stalled. Any stop still leaves writes paused and resumes only
through the same verified update path.

The observation budget uses a short, unreferenced event-loop heartbeat rather
than trusting the requested length of a poll or ownership-backoff timer. A
transport retry or aggregate-only 409 busy receipt also breaks the sequence of
comparable receipts; the fifteen-minute semantic window restarts only when the
next full receipt arrives. The raw deadline is rechecked after every awaited
pin hook, request, response body, retry wait, and postflight before completion.

Always `--dry-run` first. It walks, extracts and judges every file without
sending anything, and prints what would be skipped and why. On a real corpus
that list is the useful part: it is where you find out that 12,000 PDFs are not
supported yet, before rather than after.

`verify` and `provision` are safe to re-run. Migration execution itself is
restart-safe after every independently committed statement, but a live D1
install must use `brain update` whenever the pending migration changes the
Vectorize writer protocol. Provision adopts existing resources rather than
duplicating them, and **refuses** to adopt a Vectorize index with the wrong
dimensions or metric rather than silently writing vectors that would be
rejected or mis-ranked.

If a first setup stopped after creating part of the migration schema but before
its receipt/seed, rerun setup remains fail-closed. With no exact manifest Worker
it cannot distinguish that partial setup from a renamed live writer. It changes
no more D1 state and instructs the owner to run `brain update <manifest>` for
the verified paused-writer cutover, then rerun `brain setup <manifest>`.

Verified recovery uses the provider-neutral state machine in
`operations/verified-recovery.mjs` and the disposable-only Cloudflare adapter in
`operations/cloudflare-recovery-adapter.mjs`. The adapter can export the
reviewed source, restore only an exact empty `recovery-gate-<nonce>` target,
rebuild Vectorize while a reviewed paused Worker is deployed, promote only its
separately reviewed immutable active version to 100 percent, and run health
plus release evaluation. It cannot create, upload, route, delete, or destroy
resources. The two versions must have the same reviewed script hash and exact
bindings except for paused mode. The run requires six previewed approval
fingerprints, including the blocking source-export window, both pinned target
Worker versions and manually reviewed empty routes, and exact Keychain-backed
Wrangler wrapper and private release golden bytes. See
`docs/RECOVERY.md` for the private artifact rules and remaining live field
gate.

Run `node brain.mjs` with no arguments for the full command list.

---

## Two things about how this stores data

**There is no relevance floor.** Hybrid search always returns the
least-irrelevant documents, however far away they are. A query on a topic the
brain holds nothing about still returns rows. `/api/rag/think` is the only guard,
and it holds. Never show raw `/api/rag/unified` output as proof the brain "found
something".

**A chunk is keyword-searchable before it is semantically searchable.** There is
no transaction across D1 and Vectorize, so ingest writes the text and queues the
vector; a cron drains it every five minutes. Until it drains, both systems are
up and every probe passes while semantic search answers from a subset. This is
the most likely failure this design has and the least visible.

```bash
node brain.mjs health <manifest>                     # reads the backlog
node brain.mjs drain <manifest>                      # empties it safely now
```

An oldest-queued timestamp over 30 minutes means the cron is not running.
The drain's human completion receipt names `actual_vectors` as the total
query-visible count and `drained` as the number newly confirmed during this
command. Its returned object preserves `drained`, `submitted`, and `remaining`
and adds `confirmed_this_run`, `expected_vectors`, `actual_vectors`, and
`vector_ready`. A no-op over a populated, ready index must never look like an
empty index.

---

## Loading material

`brain ingest` walks a folder, extracts text, and sends it in batches.

**Resumable by design.** Progress is keyed by content hash and saved after every
batch, so re-running the same command continues an interrupted load rather than
restarting it. That is the normal way a large import finishes, not a recovery
procedure. A file whose contents have not changed is never re-sent.

**Nothing is skipped silently.** Every file that does not make it in is recorded
with a reason, grouped at the end of the run and kept in the state file. A brain
that quietly omits 12,000 documents is confidently ignorant of them, which is
the exact failure this product exists to avoid.

**Formats today:** `.pdf .docx .xlsx .xlsm .xls .pptx .rtf .eml .mbox .vtt .srt
.ics .csv .tsv .json .txt .md .markdown .text .log .rst .adoc .html .htm .xhtml
.xml`

Five of those carry no dependency at all. `.vtt` and `.srt` run through
`worker/src/lib/vtt.js`, the SAME function the Zoom connector uses on the
transcripts Zoom delivers — a second transcript parser would drift from the
first invisibly, both still producing text while one slowly got worse. `.ics`
is converted into the shape `renderEvent` in `connectors/google-calendar.mjs`
already accepts and rendered by it, so an event reads identically whether it
arrived through the calendar connector or as an exported file. `.rtf` is a
hand-written state machine (`ingest/rtf.mjs`) rather than a fifth dependency:
the format is control words and braces, and the hard part is discarding the
font, style and embedded-picture destinations, not parsing.

`.mbox` is the one that is not a document. `ingest/run.mjs` splits it and loads
each message separately, through the same `parseEmailMessage` the `.eml` path
uses, so one archive becomes many citable documents with their own subjects and
Date headers. The registry also holds a single-document `.mbox` reader for
callers that cannot express one-file-many-documents (Drive), rendering every
message through that same reader: coarser, never different.

Four dependencies carry the binary formats: `unpdf`, `fflate`, `@e965/xlsx` and
`postal-mime`. 11 MB total, pure JavaScript, no node-gyp, no postinstall scripts,
zero advisories. That matters because this installs on the client's own machine
during a live session, and a native build failing on their Windows box is not a
problem you want to debug in front of them. Install with `npm ci --ignore-scripts`.

There is deliberately **no optional dependency tier**. An optional extractor
fails *silently correct*: the run reports 61,000 files ingested and every
contract is missing because a flag nobody set was not passed.

**Scanned PDFs are refused unless OCR is explicitly enabled.** A scan has no
text layer, so indexing the empty extraction would create a document the brain
counts but cannot answer from. Measured on a random sample of 70 PDFs from a
real 4,458-file corpus: 79% had a usable text layer, 7% were thin (under 100
characters per page, flagged and indexed anyway), and 14% had zero text.

`safety.ocr.enabled` is off by default. When enabled, the existing PDF child
extracts page images without a native dependency and sends each page through
`POST /api/admin/brain/ocr` to Workers AI in the owner's Cloudflare account.
The daily spend cap applies to every page. A scan is stored only when the
transcription clears the normal quality floor; unreadable pages are named
inline, and a majority-unreadable or descriptive response refuses the whole
document. `documents.text_source` and `text_reliable` carry the OCR provenance
through retrieval and citations. Local synthetic scans prove this contract;
real typed, fax-quality, and handwritten scans remain a private field gate.

`brain ocr-preflight <manifest> --path <folder> --json` is the no-model planning
boundary for that local PDF path. `ingest/extract.mjs` forwards the PDF parser's
closed `observation`, and `ingest/run.mjs#prepare` retains its structured
scan-only state and authoritative page count even when the human ingest result
is a skip. The command calls the real walker and preparer with `ocr: null`, does
not load ingest state, and is exempt from the process-wide Wrangler session.
It imports the existing `estimateOcrCost` and price contract lazily and sends
only content-free observations into `operations/ocr-preflight.mjs`.

The schema-v1 receipt is exact and aggregate-only. It separates known affected
pages from unknown page counts, pages admitted or omitted by the per-document
limit, and filesystem traversal gaps from a proved zero. Cost/time values are
either the complete reviewed-default-model range, a named known-page lower
bound, or null. The exact OCR model and pricing-basis version are public receipt
fields and private fingerprint inputs. A nondefault model or price-contract
drift is unpriced instead of borrowing the default model's range. The daily cap
is included only when the manifest actually configures it; absence is null with
`daily_spend_cap_source: "not_configured"` and keeps the plan incomplete.
`estimated_fits_configured_cap` compares the unrounded estimated high value with
the full configured cap only, so display rounding cannot create a positive fit.
Because the high value is not a guaranteed upper bound and
the cap is shared with other model calls, remaining daily headroom and actual
affordability remain explicit unknowns. A SHA-256 plan fingerprint binds the
private root identity, exact model, versioned pricing basis, relevant policy,
private-prefix policy, PDF byte receipts, observations, and walk skips without
returning those private inputs. The receipt has explicit false flags only for
application-controlled OCR, HTTP, key-store access, Brain writes, checkpoints,
cursors, ingest state, and filesystem writes. A cloud-synced read may make the
operating-system file provider hydrate data, so its network, credential, and
filesystem effects stay unknown. Failed commands print only a fixed failure
code through `JsonFatal`, so neither raw paths nor parser errors enter output or
the support journal.

Every corpus write also carries the exact `metadata.provenance_receipt` v1
object: `version`, `status`, `reason`, and sorted unique `root_ids`. `complete`
means only that lineage and text-origin fields were recorded. It says nothing
about date coverage, extraction quality, or factual correctness. A producer
that cannot assess provenance is normalized to `text_source: "unknown"`,
`text_reliable: false`, status `unavailable`, and reason
`provenance_unavailable`; omission is never promoted to native/reliable.
Malformed explicit claims are refused. Legacy rows whose only provenance is
migration 0020's `native/1` column backfill remain unproven until a receipt
validates against the row's source or recorded family identity. Inventory and
authority code must use `storedProvenanceAssessment(row)` rather than trusting
those columns directly.

CSV and TSV are rendered row-wise as `Header: value` rather than as a bare grid,
because `15234.11` on its own is unretrievable while `Balance: 15234.11` answers
a question about a balance.

A local-folder run also reconciles DELETIONS: a file this source loaded before
and can no longer find is removed, through the same aggregate removal plan and
the same safety limits Drive uses. The plan denominator comes from the
authenticated Worker inventory, not the local resume file, and exact targets
are read back after deletion before completed source state is recorded. Pending
deletions re-enter the current plan rather than bypassing it. Suppressed under
`--limit`, where an unexamined file is not a deleted one.

**`safety.private_path_prefixes` is enforced on local-folder and Google Drive
ingest**, per path segment. Drive also enforces `corpora.google_drive` exact
file-id, path-prefix and filename-part exclusions before downloading content.
An excluded document already present in the brain is removed rather than left
stranded. Gmail has no folder path and does not use these rules.

Flags: `--dry-run`, `--source <name>`, `--limit <n>`, `--reset`, Drive-only
`--dry-run --json` for a bounded aggregate assistant preview, and the
exact-plan acknowledgement `--approve-removals <fingerprint>` when a Drive,
Gmail, IMAP, or local-folder cleanup exceeds its routine safety limits.

---

## Using it: Claude Code and Codex

The brain has no web interface, deliberately. It is used through the tools people
already work in, over MCP.

```bash
node brain.mjs mcp-config ./acme.manifest.json
```

The generated registration carries only the URL, display name, executable path,
absolute manifest locator, and the nonsecret `owner-assistant` profile. That
local profile can read, add or correct owner notes, and run a basic connection
check. It can also read the Owner Financial Map and create a non-authoritative
complete preview after a guided interview. It cannot activate the map. Each
accepted owner-note write lands in the registered, non-refreshable
`owner-notes` source with a visible local or remote MCP provenance label. It is
treated as recollection, not current authoritative source evidence. The source
stays outside named grants until the owner assigns it a zone; the owner and an
explicitly approved Brain connector can still use it. The profile cannot delete
records or change access. The MCP process
reads the current admin key from the manifest's validated durable Keychain or
protected-file backend at runtime.

Do not disable the AI client's normal approval prompt for `brain_remember`.
The tool is advertised as data-changing but non-destructive: it creates a durable
record without deleting or replacing another one. Tool copy limits it to a
direct owner request, but copy is not authorization enforcement; the owner must
retain the final click.

`brain setup` reconciles installer-owned Claude Code and Codex registrations and
accepts them only after an exact local readback plus an MCP tool-list check that
proves `brain_remember` is present. It never relies on a name-only listing or
prints a stored legacy credential. Claude Desktop remains a manual config
update; replace its entry with the locator-only JSON from `mcp-config` and
restart it after a rotation.

---

## Remote sources: Google Drive, Gmail and IMAP

```bash
node brain.mjs connect google --scopes drive,gmail
node brain.mjs ingest ./acme.manifest.json --from drive --dry-run
node brain.mjs ingest ./acme.manifest.json --from drive --dry-run --limit 25 --json
node brain.mjs ingest ./acme.manifest.json --from drive
node brain.mjs ingest ./acme.manifest.json --from gmail
```

The ordinary Drive dry run is for a person reviewing individual files and may
name files or paths. An assistant must add `--json`: that path validates every
reviewed root, reads at most 25 Drive entries by default (and refuses a limit
over 100), emits only aggregate counts, performs no OCR, sends no Brain
documents or receipts, and writes no checkpoint or cursor. Its
`scope_complete: false` receipt is a sample, never deletion or completeness
evidence.

Every mutating local-folder, Drive, Gmail, and Calendar ingest takes a
nonblocking per-source owner lease under `~/.brain/locks` before it reads
credentials or contacts a service. Direct commands, provenance repair,
scheduled children, and `brain load` therefore cannot write the same adjacent
resume state concurrently on macOS, Windows, or Linux. The owner record is
private, heartbeated, and recoverable after a stale dead process; `--dry-run`
remains concurrent because it writes neither resume state nor source receipts.
Manifest-file symlinks resolve to the target's adjacent state identity. A
manifest with multiple hard links is refused with a path-free safety error,
because separate parent directories cannot portably share one adjacent state.
Drive, Gmail, and Calendar take the source lease first and then a shared
`provider:google` credential-record lease. `brain connect google` takes that
same shared lease, so credential migration and replacement cannot overlap a
source run. A mutating `brain load` inspects only credential-store metadata
during preflight; the real credential is opened after both leases are held.
Dry-run source reads use a dedicated non-migrating loader, including for legacy
Windows plaintext and macOS file-backed records.

For a mailbox that is not Gmail:

```bash
node brain.mjs connect imap ./acme.manifest.json --host imap.mail.yahoo.com --user owner@example.test
node brain.mjs ingest  ./acme.manifest.json --from imap --dry-run
node brain.mjs ingest  ./acme.manifest.json --from imap
node brain.mjs disconnect imap ./acme.manifest.json
```

`connectors/imap.mjs` speaks the read-only subset of RFC 3501 directly on
`node:tls` and adds no dependency; the doctrine and its reason are in
`ingest/extract.mjs`. It uses `EXAMINE`, never `SELECT`, so it cannot set
`\Seen`. Raw `BODY.PEEK[]` octets go through the same postal-mime `.eml` reader
the Gmail connector and the mbox splitter use, so one message renders
identically whichever door it came through.

Incremental sync is `UIDVALIDITY` plus a per-folder highest-accepted UID, and
the two traps are handled explicitly: `UID SEARCH n:*` always returns the
highest existing UID (RFC 3501 6.4.8) so the result is floored client-side, and
a `UIDVALIDITY` change re-searches the folder with `ALL` rather than resuming
from a number that no longer means anything. The document id is the message's
own `Message-ID` (or a content hash when absent), not `<folder>:<uid>`, so a
`UIDVALIDITY` roll resolves to `unchanged` per message instead of silently
duplicating the mailbox. Per-folder positions are merged, never assigned, and a
new `UIDVALIDITY` is only ever written together with the watermark it covers.

The mailbox app password is entered hidden and stored through the SAME storage
code as the Google record, under its own item: service `brain-installer.imap`,
account `imap-<source name>`, file fallback `~/.brain/imap-credentials.json`,
backend selected by `BRAIN_IMAP_CREDENTIAL_STORE`. It is never a flag and never
an environment variable. Entry goes through `readHiddenInput` in `brain.mjs`,
the single raw-mode reader that `readHiddenCloudflareToken` also uses; the
prompt, the acceptable bytes and the finaliser are the only per-caller
differences, and a space is legal in a mailbox password precisely because
providers display app passwords in groups of four.

Folders are sorted into five outcomes and each is reported with its own true
reason: read, skipped by policy, identified but not read (an `Archive` folder is
the real case), unidentified, and `\Noselect` containers that are not mail
folders at all. Collapsing the middle three into one "could not be classified"
message is a false statement about a folder that was in fact identified.

**The connector has never been run against a real mailbox**;
`test/imap-connector.test.mjs` drives it against a scripted IMAP server on a
plain TCP socket, which does not exercise TLS.

**The client registers their own Google OAuth client, and we never hold it.**
Not only a custody preference: every Drive and Gmail read scope is *restricted*,
so one vendor-owned OAuth client serving many customers would require Google
verification plus a paid annual CASA security assessment. `brain connect google`
prints the full console walkthrough when `GOOGLE_CLIENT_ID` is unset. The refresh
token is stored in the local macOS login Keychain by default and never
transmitted. The Keychain item is deliberately identifiable as service
`brain-installer.google-oauth`, account `local-google-connection`. Windows uses
an atomically replaced, read-back-verified file at
`~/.brain/google-tokens.json`, encrypted for the current Windows user with
DPAPI. A legacy Windows plaintext file is migrated on its next successful read;
the prior credential is retained or restored if encryption cannot be verified.
Before that migration, `brain doctor` identifies the legacy plaintext state as
pending migration instead of claiming the file is already DPAPI encrypted.
Linux uses the same path as an owner-only mode-0600 file, and macOS can
explicitly select that fallback with `BRAIN_GOOGLE_TOKEN_STORE=file`. A legacy
macOS token file is deleted only after the full credential record has been
written to Keychain and read back exactly. Browser, Keychain, Expect, ACL, and
DPAPI helper processes receive a small allowlisted environment rather than the
Terminal's ambient credentials.
Planning and dry-run reads never trigger either legacy migration. A real source
run performs migration only while holding both its source lease and the shared
Google credential-record lease; `brain connect google` holds the shared lease
for its complete OAuth and verified storage ceremony.

Choose OAuth client type **Desktop app**. Desktop clients accept the local
loopback callback automatically. Google Cloud does not provide, or require, a
field for manually adding `http://127.0.0.1:47811` as an authorised redirect
URI. The connector sends that callback during sign-in and binds its temporary
server to loopback only.

**On a personal gmail.com account the consent screen must be PUBLISHED.** An app
left in "Testing" is issued refresh tokens that expire after **seven days**, and
the failure arrives a week later as an unattended sync that stopped working. A
Google Workspace account should use "Internal" instead and avoids this entirely.

**The second run is incremental.** Drive uses the changes feed. Gmail reads the
complete typed history window and reduces each message to its final action:
additions and label additions or removals are fetched and classified again,
while deletions become removal candidates. The terminal `historyId` is saved in
the same state file as the content hashes, so a re-sync is proportional to what
changed rather than to the corpus. Promotions, Social, and Forums are excluded;
Updates remains included because statements, confirmations, and reminders are
commonly classified there.

**Drive, Gmail, and IMAP deletions are applied.** Each connector intersects
source-policy, source-deletion, and intentional-skip candidates with the
authenticated stored-family inventory, deduplicates them, and checks one
aggregate plan. More than 100 removals or more than 10% of the stored source
corpus stops before any planned deletion or cursor advancement. One current
typed Gmail deletion or policy exclusion remains routine so a small mailbox can
converge. The refusal shows category counts and an opaque SHA-256 fingerprint,
never source IDs. Only the exact `--approve-removals <fingerprint>` value can
authorize that exact plan. Pending deletions return through the same gate, and
a currently accepted message wins over a stale pending marker. A complete IMAP
pass also compares its stable message identities with D1 and reads every planned
removal back before committing folder watermarks.

Drive never treats access loss as deletion evidence. Any account-wide changed
item is rebuilt through the reviewed-root traversal before content is read. A
stored file omitted from that traversal is removed only when Drive still shows
visible trash or a visible move outside the reviewed roots. A 403, 404, or
inconsistent in-scope omission stops cleanup and cursor advancement for review.

A Gmail full pass is an authoritative snapshot. It compares every message
allowed by the default query with the live D1 family inventory, so messages
missed after history expiry, deletion, or relabeling are reconciled without
trusting the local resume file. Planned removals are read back from D1 before the
history cursor or credential-scanner fingerprint can commit. Scanner v5 forces
local folders, Drive, Gmail, and IMAP through a complete recheck of previously
accepted documents and does not mark that migration complete until the snapshot
and cleanup both pass.

Oversized Drive documents are reconciled as a family. A revision that changes
from one document to several parts, changes its part count, or becomes small
again removes only the obsolete representation after every replacement part is
accepted. A document-level failure leaves the Drive cursor unadvanced so the
same change is retried instead of being acknowledged and lost.

Calendar uses the same completion boundary. Its new sync token is saved only
after every event receipt and cancellation removal is accepted. A failed or
refused event, or a pending cancellation cleanup, closes the source receipt as
incomplete and leaves the prior token in place so the same Google window is
retried idempotently.
Its dry run returns the same common preview receipt as every other source. If
any declared calendar cannot be read, the preview reports what it did see and
then exits nonzero with the reconsent or provider fix instead of presenting a
zero-event partial read as a successful preview.

Message command adapters use the same result boundary. `documents_sent` means
the conversation reached the Worker boundary; `documents_accepted` counts only
created, updated, or unchanged receipts. Credential refusals are returned as a
`partial` outcome and are excluded from the accepted total, so `brain load`
cannot promote a submitted-but-refused conversation to completed work. Dry-run
passes for iMessage, WhatsApp, and iPhone backup report `would_send` from the
real sessionizer while resolving no admin key, posting no receipt, sending no
batch, and saving no state. Any explicit `--limit` also makes the command result
`partial`, even when the available fixture happens to fit inside the bound.
Non-dry credential refusals persist a redacted `refusal_reason` in the sync run,
and direct command output stays warning-shaped rather than printing a green
accepted-count line.

A family is addressed by ONE uid, and there are two ways to belong to it.
**Structural**: `splitOversized` names each slice `<base>#part1of3`, so the base
is a literal prefix of every member. **Declared**: one message export (a
WhatsApp `.txt`, an SMS Backup & Restore `.xml`, a Google Voice Takeout page)
becomes many conversation-session documents that keep their own
`message:<first message id>` identity, so nothing in their names points back at
the file they came from. Each one carries `metadata.family_of` holding the
fully qualified uid of that file instead. `forgetFamilies` covers both, and it
refuses any `keep_doc_uids` entry that is neither, because the delete scope
comes from the base alone: a keep list expressed in the wrong identity space
protects nothing while the scope is real, and cleanup would then remove the
revision it was called to reconcile. Any new producer that turns one input into
many documents must stamp `family_of`; leaving it out is a hard refusal at plan
time rather than a silently unreconcilable source.

`family_of` is a storage and deletion relationship, not an evidence-authority
claim. When a producer generates a report, pack, staging note, or other document
from existing records, it must also send this versioned lineage metadata:

```json
{
  "evidence_lineage": {
    "version": 1,
    "kind": "derived_record",
    "root_ids": ["upload:stable-source-id"]
  }
}
```

Use `source_record` only when the producer is preserving a direct source
artifact; it may omit `root_ids` to use its own fully qualified document uid.
Use `agent_derived` for agent-written content and include every supporting id
returned by Brain search when available. Unknown legacy lineage remains
retrievable, but it cannot earn independent-confirmation credit or gain T1/T2
authority from a suggestive filename.

A Google Doc is exported as text, a Sheet as CSV, and a Google Form not at all.

`modifiedTime` is deliberately **not** used as a document date. A sync or a
permission change rewrites it, and storing it once made 80% of a corpus look
like it was written this year, silently disabling staleness reporting. Drive's
`createdTime` is the fallback, and a date in the filename beats both.

### Unattended Drive refresh on macOS

`operations.ingest_cron` is the standard source of truth for the Drive refresh
schedule. Use the public `brain schedule` command for install, status and
remove:

```bash
node brain.mjs schedule ./acme.manifest.json --install
node brain.mjs schedule ./acme.manifest.json --status
node brain.mjs schedule ./acme.manifest.json --remove
```

The public install command writes a per-user LaunchAgent under
`~/Library/LaunchAgents` and sets the matching Drive freshness expectation on
the Worker. Calling `operations/drive-scheduler.mjs` directly is an internal
operation and neither sets nor clears that remote expectation. A failed remote
expectation write can leave the local LaunchAgent installed; re-running the
public install safely completes both halves. The LaunchAgent runs
`brain ingest <manifest> --from drive`, uses macOS's native per-client advisory
lock to prevent two scheduler-launched syncs from overlapping, and writes
separate stdout and stderr logs under `~/.brain/logs`. Manual `brain ingest`
runs and scheduled children also share the command's cross-platform per-source
lease, so they fail closed before credential or network access instead of
overlapping. Read-only dry runs do not contend. Remove preserves the logs as an
audit trail.
LaunchAgent calendar times use the Mac's local timezone; status reports a
mismatch with `client.timezone` instead of silently presenting the wrong
schedule. Cron fields are numeric; month and weekday names are not accepted
today.

`RunAtLoad` is deliberately true. A calendar firing missed while this Mac is
asleep is coalesced by launchd and runs after wake, but a firing missed while
the Mac is powered off or the user is logged out is dropped and never made up.
On a laptop with a fixed daily time that is not an occasional miss: if the
machine is routinely off at that hour the job never runs at all, and the only
symptom is a source that silently stops updating. Running at load catches that
up. The cost is one extra run per login, bounded by the same `lockf` wrapper,
incremental ingest and `ThrottleInterval` as any other firing. It also means
installing a schedule performs the first sync immediately instead of waiting
for tomorrow's calendar time.

The interpreter in `ProgramArguments[0]` is the absolute path of the Node that
installed the schedule, on purpose: resolving `node` through `PATH` at run time
would let the ambient environment choose the interpreter, which is the
authority the sanitized child environment exists to remove. The cost is that a
version-manager path (`~/.nvm/versions/node/vNN`, `node@NN`, Volta, fnm, asdf)
stops existing after a routine Node upgrade and every scheduled run then fails
to start. That is made detectable rather than silent: install warns when the
interpreter path carries a version, `--status` warns the moment the interpreter
is gone (`interpreter_present: false`), and per-source freshness fails
acceptance once the source stops refreshing. The repair is to reinstall the
schedule.

The plist contains paths, schedule data and a non-secret configuration hash
only. Google credentials continue to come from the normal token store. Standard
macOS setup declares a deterministic, non-secret Keychain locator for the brain
admin key. A legacy adjacent `.brain-admin-key` is preserved rather than moved
silently. A direct manual run can use `ADMIN_KEY`, but LaunchAgents do not
inherit Terminal exports:

```json
"operations": {
  "ingest_cron": "0 9 * * *",
  "admin_key_secret": "keychain://acme-brain-admin/owner",
  "google_token_store": "auto"
}
```

Only the service and account identifiers are stored. The scheduler reads the
value at run time and places it only in the ingest child process. The installed
configuration hash binds that Keychain locator and `brain.domain`; changing
either in the manifest stops before Keychain access until the scheduler is
reinstalled. The child receives a minimal allowlisted environment, so unrelated
desktop credentials and all Cloudflare deployment credentials are absent.

`google_token_store` persists the connection's storage choice because launchd
does not inherit `BRAIN_GOOGLE_TOKEN_STORE=file` from the Terminal that ran
OAuth. Use `auto` for the normal macOS Keychain default, or `file` only when that
fallback was chosen deliberately. Status compares the installed plist with the
current manifest and code paths, reports definition drift, and surfaces
launchd's run count and last exit code. Windows and Linux schedulers are not
built yet and fail with a platform-specific explanation rather than pretending
the manifest schedule took effect.

Scheduler stdout and stderr remain private mode `0600`. At install, after each
lock-owning ingest child exits, and at removal, each stream is cut back to a
5 MiB tail with two exact retained history files. A lock-contention skip does
not rotate another writer's logs. A currently running noisy or hung process can
exceed that cap until it exits, so stale-run monitoring still matters. Rotation
refuses links, hard links, foreign-owned files, and paths outside the per-user
`.brain` runtime.

### Unattended watched-folder refresh on macOS

The third consumer of the same generalized scheduler, after Drive and iMessage.
`operations/folder-scheduler.mjs` supplies only a `SCHEDULER_SPEC`; every piece
of hardening above — atomic plist staging with rollback, the native advisory
lock, bounded symlink-refusing log rotation, the config-hash guard against a
stale agent reading credentials for an edited manifest — is the same code.

```bash
node brain.mjs schedule ./acme.manifest.json --install --folder
node brain.mjs schedule ./acme.manifest.json --folder
node brain.mjs schedule ./acme.manifest.json --remove --folder
```

It reads `corpora.local_folder` (`enabled`, `path`, `source`) and
`operations.folder_ingest_cron`, hourly by default. The tick runs
`brain ingest <manifest> --path <folder> --source <name>` — the ORDINARY local
ingest, not a new code path — so it inherits that command's content-hash resume
state exactly: new file loads, changed file re-sends, unchanged file costs one
read, interrupted run resumes. The folder and source name are bound into the
config hash, so an installed agent cannot be repointed at another tree by
editing the manifest afterwards.

`validateExtras` refuses a relative path (launchd's working directory is not the
client's shell), a folder that does not currently exist (a schedule pointing at
nothing loads nothing and reports success forever), and a source name outside
`^[a-z0-9][a-z0-9_-]*$` (the name is the deletion scope). Status and remove stay
reachable when the folder is later deleted, so a loaded agent is never stranded.

**Deletions.** The local ingest lane now reconciles files that are gone, through
the same `buildDriveRemovalPlan` / `assertDriveRemovalPlanSafe` aggregate guard
the Drive lane uses, with the same 100-document and 10% limits and the same
`--approve-removals <fingerprint>` acknowledgement. `removedSinceLastRun` in
`ingest/run.mjs` computes the candidates from the resume state and the set of
paths the walk saw — including paths it SKIPPED, so a file skipped this run for
being empty, oversized or private is not mistaken for a deleted one. It is
suppressed entirely under `--limit`, where an unexamined file is not a deleted
file, and an incomplete walk already aborts the run before this point. That
matters most unattended: a cloud folder that failed to materialize is
indistinguishable from an owner deleting everything in it.

Candidates are not deletion truth. Before the guard, the lane reads the live
family set through the authenticated Worker route, including `family_of`
families produced by message exports, and intersects candidates with that set.
Only the categorized plan targets reach the forget route. It then inventories
the source again and leaves a retry marker plus an error receipt if any exact
target remains. A pending retry goes back through this current plan and cannot
reuse an earlier denominator or bypass a changed fingerprint.

### Legacy curated collections during migration

`operations/curated-dual-sync.mjs` is the internal rollback-compatible path for
a small Markdown collection that already has a live legacy ingest target. It is
not part of a fresh install. A private mode-0600 sidecar plan names the exact
expected files, their authoritative, superseded or plain role, their existing
legacy identities, both target manifests, each target's fixed backend contract,
the private coverage-ledger destination, and an optional unattended scheduler
slug, cron, and timezone. The plan and ledger are ignored by Git and never
belong in the package. `legacy_target.backend` must be
`legacy_notes_supabase`; `cloudflare_target.backend` must be `cloudflare_d1`.

The operation has three explicit modes. `--dry-run` reads no credential and
makes no request. `--audit` reads the Cloudflare Drive-family inventory but
writes no document. `--sync` builds every transformed envelope once and sends
the same title, content and metadata independently to the existing endpoint and
to the Cloudflare identity `curated:brain:<legacy source type>:<legacy source
id>`. The legacy write stays in place until retrieval evaluation approves a
cutover.

Enumeration is the first gate. A missing root, an unreadable directory, zero
Markdown files, a count change, an unexpected file, a missing planned file or a
role-count change stops before Keychain access and before either network target.
This matters for unattended macOS jobs because a privacy-denied cloud mount can
look like an empty successful walk. Every final title, metadata value and content
body then passes the same confirmed-credential scanner as Worker ingest. The
entire corpus is rejected as one bounded aggregate if any transformed envelope
fails. Finally, every source is reopened through a no-follow descriptor and its
raw SHA-256 is compared with the first pass. All of these checks finish before
an admin key can be read or a request can be made.

Each target manifest is read once through a stable no-follow descriptor before
Keychain access. The same inspected object supplies the HTTPS origin, backend,
and durable-key locator used by the request path, so a second path read cannot
redirect a credential. HTTPS origins are normalized,
legacy and Cloudflare must use distinct origins and backends, and every
authenticated fetch uses manual redirect handling. A redirect is a target
failure, never an invitation to forward a key. Cloudflare POST receipts must
echo the exact deterministic document identity, then the operation reads the
curated source-family inventory back from the same origin and confirms every
identity. The legacy endpoint has no equivalent exact identity readback, so its
bounded document receipt remains the strongest available proof. After a valid
preflight, failure of one target cannot suppress the other. The command exits
unsuccessfully unless every target receipt is complete, so rerunning is the
recovery path.

The atomically replaced owner-only ledger contains salted logical fingerprints,
content SHA-256 values, canonical target-neutral envelope SHA-256 values, roles,
bounded target receipt states and aggregate raw Drive history findings. The
corpus fingerprint includes the envelope hash, so a title-only or metadata-only
change cannot hide behind unchanged content. The ledger contains no filenames,
paths, source IDs, URLs, document content or credentials. Before replacement,
an existing ledger must parse as a supported schema. The ledger path must not
alias the plan, a corpus source, either target manifest, an adjacent admin-key
sidecar, or the raw Drive state file, including through a real-path or hard-link
collision.

Raw Drive comparison is explicitly historical evidence, not live deletion
proof. A historical checksum match means the local raw MD5 equals the checksum
recorded in the resume state and a family with that historical identity is
currently present. A driveVersion value that is merely a file size, or has no
checksum, is reported as historical unverified presence. A different MD5 is a
historical mismatch. Every ledger sets `raw_drive_evidence.deletion_eligible`
to `false`. Deletion remains forbidden until a server endpoint can bind the
currently stored family to a specific revision and return a content hash for
that revision.

Each Markdown revision is opened with the operating system's no-follow flag,
read from that descriptor, and checked with descriptor metadata before and
after the read. The path must still name the same regular, current-user-owned
file with the same device, inode, size and source modification time. File
Provider change time is not revision identity because hydration can update it
during a read without changing source bytes. The collection is enumerated again
after all reads. A cloud-sync replacement or an inventory change therefore
stops the run before either target is contacted.

`operations/curated-sync-scheduler.mjs` supplies the unattended execution rails
for a reviewed plan. Its LaunchAgent definition contains only the plan locator
and a configuration hash. That hash binds the normalized plan plus both complete
target-manifest fingerprints, including domains and Keychain locators; changing
any of them stops before Keychain access until the service is reviewed and
reinstalled. The public `run` command requires that exact 64-character hash and
rejects missing, empty, duplicate, or unknown CLI arguments. Its internal child
command is omitted from public usage and requires the same hash. `run` strips
ambient credentials, opens and validates the owner-only lock without following
links, and passes that already-open descriptor to a nonblocking native `lockf`.
Before Keychain or network access, the child proves fd 3 is the same stable lock
inode, its parent is the native `lockf`, and an independent descriptor observes
active contention. Merely opening the lock or copying the hash cannot bypass
that gate. A complete
dual-target confirmation atomically advances an owner-only aggregate freshness
receipt. A normal child
failure records one bounded local support-journal event and returns a dedicated
handled exit code; every other nonzero result is parent-owned, so a missing
command, runtime startup failure, abnormal signal, or pre-child wrapper failure
still produces one event without duplicating the handled child. macOS
`lockf` translates a signaled or stopped child to exit 70, so the wrapper treats
that exact result as abnormal even though Node receives no signal name. Neither
receipt contains paths, source identities, document names, URLs, content, raw
errors, or credentials. Freshness rejects malformed aggregates and timestamps
more than five minutes ahead of the local clock, and any configuration change is
always stale.

The scheduler wrapper and plist renderer do not silently install or replace a
LaunchAgent. Production rollout still requires independent review, one
supervised successful sync, a staged rollback-safe service replacement, and a
fresh status read. The existing medical job must remain untouched until those
checks pass; copying the Drive job's plist or command would use the wrong lock
identity and could report false freshness.

---

## Private local issue journal

Each recognized public CLI failure attempts to write one immutable,
metadata-only event under `~/.brain/support/events/` when that private path is
writable. Concurrent commands never rewrite one another's event files. After
each successful write, best-effort retention may remove older complete event
files, but it never changes the event that triggered cleanup.
Unknown commands and failures of the support command itself are not recorded,
and journal failure never replaces the original error. This is local support
evidence, not telemetry: no network call exists in the journal module, and
the installer does not upload or send journal data.

```bash
brain support
brain support --preview
brain support --export brain-support-review.jsonl
brain support --clear --yes
```

The schema accepts only installer version, platform, architecture, Node major,
command, connector class, typed error code, timestamp, random event ID, and an
optional product-code fingerprint. The fingerprint is derived only after an
existing stack frame resolves inside the installed package and its sanitized
product-relative module and line pass the strict location validator. Raw stack
text and outside paths are never stored or hashed. The schema cannot accept raw
errors, stacks, argv, environment values, paths, URLs, manifests, account or
document IDs, filenames, queries, answers, indexed content, request bodies,
response bodies, or logs.
On POSIX, directories are `0700`, files are `0600`, and links, foreign
ownership, and nonregular files are refused. Windows keeps the journal inside
the current user profile and preserves the same schema and no-network boundary,
but this release does not claim equivalent ACL, ownership, or hard-link
enforcement there. Preview and export include only the newest 200 valid events,
at most 30 days and 2 MiB, and they use the same canonical bytes. The default
status reports the count in that recent shareable view, not the total number of
physical event files, and it does not print the user-profile path. A partial or
invalid event file is skipped rather than exported.

Physical retention is automatic and best effort after a new event is durable.
Cleanup considers only canonical event basenames and complete events that still
have the same file identity observed during scanning. It never deletes the
current event. A ten-minute freshness grace protects a process that is still
closing or syncing its event, and partial events are never cleanup candidates.
Concurrent cleaners choose the same oldest events and recheck identity before
unlinking. A rapid burst can temporarily exceed the physical count until a
later write runs after the grace period. Invalid or unsafe artifacts may remain
outside automatic retention. `brain support --clear --yes` removes partial or
invalid regular files only after the entire journal passes safety checks. It
refuses links and special files for manual review. Any cleanup error is
discarded so support housekeeping cannot replace the command's original
failure. Export refuses to overwrite an existing file. The installer does not
upload or send the export; a sync service may upload it when the chosen
destination is in a synced folder.

Cross-install collection is deliberately a later, opt-in feature. If built, it
needs a separate write-only support credential and an exact payload preview. It
must never reuse a brain admin key or a client's Cloudflare token.

---

## What remains unproven or not built

Read this before scoping an engagement.

- **No owner-facing corpus deletion workflow.** The owner workspace can upload,
  approve, close periods, explore, manage targets and preferences, and use
  document grants. Corpus forget remains an operator-only, preview-first admin
  command until a separate deletion contract is reviewed.
- **The owner workspace is not field-proven by its local suite.** Passkey,
  entity-scope, and document-grant contracts run against the real Worker code
  with an in-memory D1-shaped adapter. The final domain and physical devices
  still need the weekend ceremony and access-control gate.
- **Several provider connectors remain behind field gates.** Slack, Notion,
  Microsoft 365, Dropbox, QuickBooks Online, Plaid, and HubSpot have runnable
  product code and scripted provider-I/O proof. None has an accepted real
  workspace, tenant, sandbox company, Plaid Item, or account receipt yet. Box
  and Airtable still have no native API connector; use a reviewed export or a
  watched folder where suitable.
- **No official WhatsApp Business Platform connector.** Safe WhatsApp chat
  exports are supported. The separate live paired-device connector is
  unofficial, violates WhatsApp's Terms of Service, is opt-in, and is not
  real-account proven. A WhatsApp Business App account does not make that
  connector official.
- **Some manifest declarations are still inert.** Google Drive source policy
  and the macOS `operations.ingest_cron` scheduler are wired. Other undeveloped
  corpora, health/report/webhook operations, most of `retrieval`,
  `access.authorized_emails`, `kv_namespace` and `r2_bucket` are read by nothing.
  `manifest.schema.json` marks the important boundaries. Do not tell a client an
  unwired declaration takes effect.

---

## Scale is an evaluation gate, not a guessed cutoff

The standard product backend is D1 plus Vectorize inside the client's
Cloudflare account. Vectorize currently caps a query at 100 returned candidates
when values and metadata are omitted. That is a candidate-depth constraint, not
evidence for a 100k or 250k corpus-size cutoff.

The retrieval path reduces the risk in three ways: metadata filters run before
topK, D1 FTS5 supplies an independent keyword candidate list, and reciprocal
rank fusion combines both lists. Full-corpus evaluation decides whether that is
good enough. Do not move a client to another backend based on chunk count alone.
Require a measured failure on the golden set, a diagnosed cause, and an approved
architecture change.

`brain diagnose` follows the same refusal to guess at scale. It pins the current
maximum integer `chunks.id`, then keyset-pages through that fixed range in
50,000-row statements. One page derives the total, blank, oversized, orphan,
document-source mismatch, and source-zone mismatch counts together. The report
also brackets the complete run with durable schema, outbox, `corpus_stats`,
source-event, source-count, and vector-projection markers. `brain zone` writes a
source event in the same transaction as its bounded projection repair, including
same-zone retries. Store parity is attempted only when the durable projection is
verified and its outbox is empty, then requires exact count equality. A page
failure, fixed-range coverage gap, statement or page budget, or changed marker
produces `complete: false`; partial counts never become a healthy verdict.
Exact duplicate-text and per-document
outlier grouping remain `observable: false` above their safe bound because they
require a second whole-corpus grouping pass. A disposable D1 field gate at
roughly 1.5 million synthetic chunks remains required before this is called
provider-scale proof.

---

## Tests

### Local owner-onboarding rehearsal

`npm run rehearse:onboarding` builds the current React owner workspace without
rewriting the committed Worker asset module, starts the existing synthetic API
fixture on loopback, and proxies it through a local safety page. The proxy adds
a persistent rehearsal banner and exposes populated, sign-in, empty, partial,
degraded, conflict, replay, owner, and exact-document grant states. It reads no
manifest or credential store and makes no live service call.

Physical Windows owner rehearsals are handed off only as the content-addressed
ZIP and matching `release.json` produced by
`scripts/build-windows-onboarding-kit.mjs` from one successful exact-SHA `ci`
push run. The archive contains instructions and a manifest, not executable
code. Those instructions have Claude Code obtain a fresh detached checkout and
start its checked-in `onboarding/start-windows-rehearsal.ps1`, never an emailed
or pasted script body and never the `npm.cmd` package-script shim. The launcher
requires the sealed SHA, a clean current directory equal to the checkout root,
Node.js 22+, and a non-administrator PowerShell window. After frontend
preparation it invokes the Node rehearsal entrypoint directly, which keeps
Control-C out of `cmd.exe` batch job handling. The first run may download a
separate small public frontend dependency set and may be quiet for several
minutes.

`test/onboarding-sandbox.test.mjs` protects the safety labeling, state menu,
scenario routing, and absence of credential fields. This is browser-contract
and layout evidence only. Cloudflare install, provider OAuth, webhook delivery,
mailbox access, and physical WebAuthn remain field gates.

Every npm, Vite, fixture, and browser child in this rehearsal receives a strict
operating-system allowlist instead of the desktop environment. npm also reads
neither ambient npm credential variables nor the owner's user or machine-wide
configuration, so an ordinary registry token cannot cross into this
public-dependency install. Before dependency installation and again before the
Vite build, the rehearsal refuses every `frontend/.env*` entry. This prevents an
ignored local Vite file from restoring a value that the child allowlist removed.
Windows Node 22 and 24 CI run
`npm.cmd run rehearse:onboarding -- --smoke --no-open`; the bounded mode
builds the app, verifies the loopback guide, app shell, and synthetic owner API,
then closes both local servers. The hosted Windows runner is elevated, so this
is not proof of a physical non-administrator session or browser launch.

`npm run rehearse:hiccups` is the matching offline failure rehearsal. It runs a
curated set of product tests for interrupted setup, missing mounts and removal
guards, partial connectors, lost-response idempotency, restart-safe migrations,
vector backlog recovery, passkey and document scope, and technician support.
The child environment is allowlisted so ambient provider and API credentials do
not reach the test processes. Its receipt pairs every automatic proof with the
exact real-service or physical-device field gate still outstanding. Use
`-- --list`, `-- --only <scenario>`, or `-- --json` for targeted and agent-led
runs.

`brain technician <manifest>` is the matching install-day coordinator. Its
default and `--json` forms are read-only. A selected `--run` step launches the
existing command in a child process with an allowlisted environment. Google,
Zoom, and IMAP values are collected by the shared hidden-input primitive, never
placed in argv, and cleared from the coordinator's buffers and child environment
object after the command exits. Tests assert ordering, rerun behavior,
ambient-secret scrubbing, exact hostname confirmation before invite creation,
and stop-on-fail
verification.

Claude Code remains a blocking prerequisite for fresh setup and `brain tools`.
For plain doctor on a manifest with provisioned Cloudflare resource identities,
a successful `codex login status` makes a missing or signed-out Claude Code
result advisory so the read-only technician sequence can reach health and
source evidence. The warning explicitly says that Claude Code was not proven.
An installed but signed-out Codex does not relax the gate. If Codex is also
unavailable or signed out, Claude remains fatal. Later health, source, and
device failures remain nonzero and preserve the technician coordinator's
stop-on-first-failure contract.

Plaid application-credential setup is intentionally absent from generic setup.
`brain setup`, `brain secrets`, and `brain technician` never accept or write the
three bank-feed credential bindings. For an approved enabled feed, a complete
existing binding set is preserved. A missing or partial set refuses before
provider cleanup, local key mutation, core-key rotation, or any Worker write.

Technician plan schema 4 also carries the owner briefing for every ceremony:
what will open, why it is needed, the minimum access, the safe non-secret work
a browser controller can do, the owner's handoff point, and the privacy
boundary. The CLI renders that briefing before each provider command. The
direct invite command renders the passkey briefing before it mints a link, and
the enrollment page requires a device-neutral owner click before WebAuthn is
invoked. Optimize is a separate read-only audit. It may detect a missing CLI,
skill, or MCP registration, but it does not invoke passkey or device checks.
After its report, the exact release may advertise a separately previewed local
repair bundle for owner-selected skill, Claude MCP, and Codex MCP items. That
bundle receives one approval and exact readback; CLI replacement stays separate.

Optimize source evidence comes from `POST /api/admin/brain/sources`, not from
Wrangler or the Cloudflare D1 control plane. The route accepts either the full
admin key or a positively identified owner session with its companion CSRF
header. It rejects scoped grants, including a grant that carries `administer`.
All responses are private and `no-store`. The handler issues D1 `SELECT`
statements only and does not touch passkeys, source receipts, sync cursors,
credential storage, OCR, or the corpus.

Optimize also reads `POST /api/admin/brain/financial-map/read`. Migration 0041
starts with no map history and never promotes existing structured rows by
backfill. The response calls those rows possible mentions, exposes current,
stale, or not-established map state, and returns the complete unresolved-item
list. Each owner-facing Optimize response has one question budget. An
installed-Brain discovery choice consumes that response's budget. Within the
audit, the budget is shared by material evidence clarification, whole-source
zoning, and the optional opening goal, in that priority order. A pending
evidence conflict or zoning choice skips the goal. An unsupported zoning
recommendation is forbidden: the host states the whole-source choices and
consequences, says the evidence does not choose among them, and uses the one
question only when zoning is the highest-priority blocker. Routine Optimize
compares actual records, receipts, and provenance; Golden Questions, Golden
evaluation, canned refusal exercises, known-answer controls, and owner-prepared
test content are separate optional testing tools rather than defaults. This map
read is the first audit evidence after that opening decision, whether the goal
was asked or skipped. Before the read, the host explains that it sends no map
snapshot and changes nothing, even if the assistant displays an approval prompt
for the private read. Before
any financial-completeness conclusion, the host offers the optional guided,
session-only interview and asks one short question at a time if the owner
accepts. The interview submits nothing and changes nothing. If the owner
declines, the report keeps completeness unproven. Optimize ends before
`brain_financial_map` may submit a full version 1 preview under a separate,
explicit owner approval. The full map can add owner-declared entities and
accounts with no current ledger row, and records filing units, return and form
obligations, K-1 roles, books, payroll, and expected sources for every
entity-year. Nullable ledger evidence stays separate from owner truth and no
`fin_*` row is synthesized. Preview writes only an expiring non-authoritative
receipt. Activation is a separate owner passkey ceremony with no admin-key or
MCP fallback. It appends a sealed linear snapshot and changes no existing
financial or source record. See `docs/OWNER-WORKSPACE-API.md` for the closed
snapshot contract.

Optimize never promotes a planned, absent, or unrun MCP probe into an observed
check. The host reports an absent, failed, refused, or not-run MCP check as that
exact state and cannot call Optimize complete while any planned check is not
run. The current synthetic behavioral floor for routine Optimize is
`gpt-5.6-luna` at medium reasoning, with `gpt-5.6-terra` at low reasoning as the
fallback or escalation for harder evidence conflicts. That is synthetic
behavioral evidence only, not live Brain proof. Do not pin `gpt-5.6-sol` or
infer completeness from the selected model.

The default request mode returns stable source-id pages. The source set and
all aggregates are read from one bounded D1 statement, hashed with an as-of
receipt, and sorted by source id. A continuation cursor binds its last source,
as-of time, total, and snapshot hash. If any returned source field changes,
the next page returns `source_inventory_changed` instead of combining moments.
The CLI collects every source page before printing JSON and refuses incomplete,
duplicated, unordered, or privacy-invalid output.

Each inventory row includes `last_failure`. It is `null` unless the newest run
has a Gmail failure receipt that passes the closed source-failure validator.
The only permitted fields are the fixed operation class, HTTP status, canonical
provider reason, aggregate checkpoint counts/readback state, and the
cursor-preservation category. Raw provider messages, IDs, paths, cursor values,
content, and secrets are neither selected for this receipt nor rendered by the
CLI. Invalid stored evidence fails closed to `null`; invalid response evidence
is rejected by the CLI.

Adding the required `last_failure` row key advances the shared inventory and
recovery response/cursor contract to v3. The Worker rejects v2 cursors and the
CLI rejects v2 responses. On schema 39, the inventory performs one exact
missing-`failure_evidence` fallback that projects `last_failure: null`; every
other query failure is rethrown and becomes the ordinary unavailable response.

`mode: "recovery"` returns one bounded record-candidate page. Stable opaque
document digests permit a later before/after comparison without revealing raw
document ids, provider locators, paths, titles, URIs, or metadata. Candidate
selection is limited to recorded conditions: no nonblank chunks, partial OCR,
missing extraction/readability receipts, missing source identity, or missing
or unrecognized lineage. The top-level summary groups candidates by safe source
identity with exact closed reason counts and stored-evidence priority signals.
The cursor carries no raw locator. Opening and closing corpus markers refuse a
page that overlaps supported writes, and a later marker mismatch returns 409.
The schema cannot prove that an empty document is scan-only, so that field is
explicitly unavailable. Recovery mode is a plan only and contains no repair
operation.

`brain sources <manifest> --json` and `--json --recovery` resolve the existing
durable admin credential with `ignoreEnvironment: true` only after validating
the saved HTTPS Brain origin. They use the shared redirect-refusing transport,
do not accept a literal key option, and bypass the Wrangler session wrapper.
This source-inventory feature does not widen MCP authority. The five local
Owner assistant tools are `brain_think`, `brain_search`, `brain_remember`,
`brain_health`, and `brain_financial_map`. The last tool can read map state and
store an expiring preview, but it has no activation operation.

The current ingest boundary validates evidence lineage and versioned text-origin
receipts on new writes, and it refuses a later write that weakens established
proof. Migration defaults and legacy `native/1` columns are still explicitly
unassessed. Inventory labels that debt as partial or unavailable rather than
retrospectively upgrading it.

`brain provenance-repair <manifest> --source <name>` schema 1 is now a legacy
inventory preview only. The canonical semantic plan still binds every source
row, candidate, reason and count while excluding observation-time pagination
noise. It also records the proposed whole-source reset/no-limit method and OCR
policy so the historical plan remains auditable. It always returns
`can_apply: false`. A missing candidate after a rewalk could have been deleted,
replaced, refused, or skipped, so set difference is not repair proof. Any
`--apply` invocation throws before manifest, credential, network, scheduler, or
source access, and schema-1 readback keeps all prior candidates unresolved.

The local assessment boundary accepts one to ten explicit source-relative
locators for a manifest-approved upload root. It resolves them by exact
equality through the existing no-follow file walk, reads content only for the
resolved targets, and fails the target set closed if traversal or exact
resolution is incomplete. OCR is passed explicitly as disabled. Native text,
reliable OCR, partial OCR, scan-only, empty, password-protected, unsupported,
extraction-failed, and unavailable are separate states. PDF page count is
included only when the PDF parser directly established a positive count. A
public receipt contains only ordinals and closed outcome fields; the private
handoff retains exact locators and original-byte hashes for the Worker contract
and must never be printed or persisted as a public artifact. Multi-record
archives remain an explicit ambiguity rather than being matched by filename or
content similarity.

Migration 0042 adds the independent opaque-ID key and append-only
`source_original_observations` ledger. `POST
/api/admin/brain/source-original-observations` is D1-only and full-admin-only;
scoped grants and owner sessions do not inherit it. Seal, inventory, and verify
are read-only. Record uses one bounded D1 batch, exact readback, immutable
replay hashes, and the upgrade write-pause guard. Schema 42 can record and
revalidate only gap, failure, and adjudicated-exclusion observations. The
Worker rejects every accepted outcome, and a D1 trigger applies the same guard
to recovery imports and direct writes.

Migration 0043 adds the previously missing binding substrate. Ordinary
single-record local ingestion measures the exact extracted file bytes and sends
a private four-field receipt. The Worker derives the opaque original ID from
the schema-42 key and the envelope's existing single or structural-family
locator. It does not copy that locator into the immutable binding receipt or
ledger; the existing document identity fields still retain it for retrieval
and source lifecycle. Every changed corpus write receives a new
revision ID. A bound revision commits its final content hash and immutable raw
hash, byte count, provenance digest, and binding hash in one D1 transaction;
exact readback recomputes the complete receipt. Unchanged detection includes
the binding, so the same extracted text from different raw bytes is a new
revision. Legacy rows, unbound writes, and multi-record `family_of` exports are
not upgraded or guessed. The trust claim is only a full-admin-authorized local
ingest assertion over exact descriptor bytes. It neither proves the producer
binary nor recomputes the raw file because the Worker never receives it.
The schema-43 D1 trigger and Worker rejection still block every accepted
outcome because the complete acceptance chain is not implemented. Missing rows, deletion, replacement bytes, refused or unavailable
originals, and changed or incomplete document families remain unresolved. The
route always states that its target set is bounded and that whole-source
completeness is false. The legacy no-target CLI never turns this evidence
contract into OCR, reingest, repair, or deletion authority. The separate exact
one-target lane described below can reingest only an owner-selected eligible
original after a new state-bound preview and approval.

Migration 0044 adds the non-authorizing result-family receipt on the same
private endpoint. Use an explicit operation even though omission defaults to
`record`:

```json
{
  "contract_version": 1,
  "mode": "result_family",
  "operation": "record",
  "source": "localdocs",
  "locator_kind": "source_relative_path",
  "locator": "statements/example.pdf",
  "original_content_sha256": "<64 lowercase hex characters>",
  "original_byte_count": 1234,
  "retrieval_query": "a private exact query for this original"
}
```

The route accepts only registered upload sources, at most 256 current
revisions and 500 chunks, and a normalized nonempty retrieval query of at most
4096 UTF-8 bytes. A schema-43-bound document upgraded with null chunk receipts
must pass once through authoritative ingest before it can be sealed. Each new
ingest writes a digest over the revision ID, chunk index, title, and exact
stored text, including the title prefix. The portable member rows and family
header contain only opaque revision IDs and hashes. Recovery can replay older
headers only inside the schema-44 empty-target import marker. Binding-ledger
validation remains active, and the generated artifact closes and checks the
marker after all portable rows are restored.

`record` computes and atomically stores the portable family plus one
deployment-local verification. `verify` reruns the current proof but refuses
to create a missing row. Both operations require target and global outbox zero,
the same outbox generation and Vectorize mutation fence observed by the global
readiness check, exact vector-count parity, and two identical calls to the
production unrestricted-owner retrieval path with reranking bypassed. The top
result and its projected citation must resolve to the sealed family. A final D1
trigger rechecks the current family, queue, generation, and mutation fence in
the write transaction.

Neither the locator nor the raw query is returned or persisted. Durable proof
rows also exclude document IDs, chunk IDs, titles, text, answers, and citation
references. The response explicitly reports
`accepted_outcome_authorized: false`. Ordinary `result_family` and observation
recording remain non-authorizing, so schema 44 alone cannot authorize an
accepted observation, OCR, reingest, deletion, or a whole-source claim.

Migration 0045 adds `mode: "accepted_resolution"` to the same full-admin-only
`POST /api/admin/brain/source-original-observations` endpoint. It accepts
exactly one sealed target and requires an explicit
`operation: "record"` or `operation: "verify"`. The request supplies the same
private exact-original and retrieval inputs used to build the schema-44 proof,
plus the prior unresolved observation it resolves. Both operations reseal the
all-and-only current result family and rerun the deployment-local Vectorize and
production owner retrieval verification. Cached proof is not enough.

The exact portable family must first be persisted through ordinary
`mode: "result_family"`, `operation: "record"`. Accepted-resolution admission
requires that preexisting non-authorizing family header and its members; it
never creates them implicitly.

`record` uses one guarded D1 batch to bind the prior unresolved observation,
exact original hash and byte count, family receipt, fresh verification receipt,
and accepted observation atomically. The D1 admission trigger repeats the
current family, chunk, binding, install-state, outbox, generation, and mutation
checks inside the write transaction. Exact replay creates no duplicate history;
conflicting replay and any observed drift fail without a partial admission.
`verify` performs the same fresh proof without writing and returns current only
when the exact portable resolution also has a matching activation for the
current deployment-local verification.

Recovery exports the portable accepted-resolution history after its observation,
binding, and family dependencies. It excludes in-flight admissions,
deployment-local verifications, and resolution activations. The recovery marker
can close only when the portable accepted observations and resolutions form an
exact bijection and all local-only acceptance state is empty. The restored
history is therefore not current acceptance proof. After Vectorize is rebuilt,
the exact target must pass `accepted_resolution` `record` again to add a fresh
local verification and activation.

The SQL currentness views cover the fixed retrieval contract plus mutations
performed through supported Worker, D1, and outbox paths. Direct FTS repair,
out-of-band Vectorize mutation, and retrieval-code deployment sit outside that
generation fence. Rerun the full `accepted_resolution` proof before relying on
an accepted result after any of those boundary changes.

Successful receipts remain scoped to one original and state
`whole_source_complete: false`. The schema-45 route itself does not run OCR,
reingest, deletion, deployment, or customer execution. Ordinary
`result_family` responses continue to report
`accepted_outcome_authorized: false`.

Migration 0046 makes every new observation an optimistic append against the
latest same-original D1 sequence. Normal `record` targets supply
`predecessor_observation_hash`, using `null` only for an observed empty
history. The Worker stores chain version 1 and D1 atomically refuses a stale
predecessor. Exact record replay succeeds only while that same observation is
still the head. Accepted admission expects the resolved gap as head for a new
resolution, or the accepted observation as head for exact replay and recovery
reactivation. A newer exclusion, gap, or failure therefore demotes and blocks
the old acceptance. Recovery accepts legacy version-zero rows as a prefix and
checks every schema-46 immediate predecessor before its marker closes. A
schema-45 version-zero accepted row that resolved an earlier non-immediate gap
remains restorable historical evidence, but it is noncurrent under schema 46
and reactivation returns `history_advanced`.

`observation_hash` continues to digest the event receipt fields from the
schema-42 contract. It is not a self-authenticating chain hash and does not
include the predecessor edge. The authenticated whole recovery artifact and
the independent recovery-close predecessor checks bind the portable version-one
chain. A future receipt-contract version may digest that edge; schema 46 keeps
existing observation hashes stable.

`brain provenance-repair <manifest> --source <name> --target
<source-relative-file>` is a separate exact one-original lane in this held
candidate. The owner must choose the source and exact source-relative file. The
CLI never guesses a target from a candidate, filename, search result, entity,
or inferred gap. The source must be the manifest's enabled
`corpora.local_folder`, registered in the Brain as an upload source, and the
file must resolve to exactly one complete, reliably extracted
`native_readable` record. Multi-record exports, incomplete extraction, scans,
and every OCR-dependent target stop. OCR is explicitly off for both preview and
apply.

Preview acquires the source lease before reading the private manifest, source
file, saved credential, or Brain state. Under that lease it reads the complete
authenticated source and observation history, prepares the exact one-file
ingest envelope, checks the current schema-46 Brain and vector state, and seals
a state-bound plan. It releases the lease without changing Brain data,
configuration, source receipts, cursors, or removals. Public output excludes the
local root, locator, private retrieval query, content hashes, document IDs,
sealed receipt internals, and private plan IDs.

Apply requires the exact approval hash from that preview. It reacquires the
lease, repeats every private check, and refuses if the file, manifest, source
configuration, complete observation history, Brain release, schema, queue, or
vector state has drifted. It then performs one exact target reingest with OCR
off, reconciles only that target's structural family, drains the shared vector
outbox, records and verifies the schema-44 `result_family`, records the
schema-45 `accepted_resolution`, and verifies it again. Schema 44 must be
recorded and verified before schema 45 is attempted. A missing response field,
unexpected status, stale or mismatched receipt, lease loss, replay conflict, or
failed final verification stops without claiming success.

The preview explains the real effects before approval. Exact-family
reconciliation may remove stale siblings belonging only to the selected
original. The shared drain may process unrelated work already queued in this
Brain. Reingest and drain create embeddings, and the two schema-44 plus two
schema-45 proof operations run eight private retrieval probes in total. Those
probes can create ordinary aggregate usage records. The lane never advances a
source-wide receipt or cursor, never performs source-wide removal, and never
claims that the source is complete. It does not change zones, grants, passkeys,
devices, providers, Cloudflare resources, or deployment state.

`brain assistant-repair <manifest> --only <scopes>` is the matching post-audit
local handoff lane. Its only accepted scopes are `technician-skill`,
`claude-code-mcp`, and `codex-mcp`; there is deliberately no CLI, setup,
passkey, device, corpus, source, access, zone, provider, or Cloudflare scope.
Without `--apply` it only inspects safe local files, starts the packaged MCP
runtime for an offline initialize and exact tool-list exchange, and prints a
SHA-256 plan ID bound to the manifest and current destination bytes. Apply also
requires `--approve <plan-id>`, recomputes the plan, and stops before writes if
anything drifted. The MCP reconciler receives exactly one selected target at a
time, refuses custom and disabled entries, uses a credential-scrubbed child
environment, and restores a safe prior locator or absence when exact readback
fails. The skill scope treats its Claude and Codex copies as one transaction
and restores completed writes if either destination fails. Before the first
selected write, the command snapshots all repairable skill and MCP destinations
in memory. Failure in any later scope rolls the full selected write set back in
reverse order; restoration refuses a concurrent custom replacement and reports
the exact scope that needs inspection.

Current connector proof levels and the ranked acceptance backlog are maintained
in [CONNECTOR-BACKLOG.md](./CONNECTOR-BACKLOG.md). Fixture coverage is never a
substitute for the named real-system field gate.

Every value in `SUPPORT_ERROR_CODES` also has one entry in
`support-recovery.mjs`. `brain support --explain <code>` renders the human form;
`--json` returns the same fixed recovery contract for a local assistant. The
catalog is deliberately separate from private issue events: a stored event
keeps only its durable code, while wording and recovery steps can improve. Tests
require complete catalog coverage, stable typed-error precedence, inviting
language, and absence of secret-bearing fields.

```bash
npm test
npm run test:eval
```

The eval lane is separate so retrieval metric, provenance, template, and
artifact changes can be exercised quickly. It uses only synthetic fixtures and
starts a local HTTP brain; it never reads an installed brain or private golden
set. See `docs/EVALUATION.md` for the v2 contracts, release gates, and staged
diagnosis model.

`test/live/d1-release-field-gate.mjs` is the opt-in real-service release gate.
It is never part of `npm test` because it creates billable Cloudflare resources.
Run it only against a newly provisioned manifest whose name explicitly says
`Synthetic Field Gate`. It exercises changed, unchanged, mixed, concurrent,
high-chunk, embedding, retrieval, diagnosis, and confirmed cleanup behavior,
then prints an aggregate-only receipt. Preserve the sanitized receipt under
`docs/release-evidence/` and delete the exact disposable Worker, D1 database,
Vectorize index, and temporary admin-key item. The harness refuses ordinary
client manifests and never accepts or prints a private corpus.

`brain eval <manifest>` uses the `smoke` profile by default. It is diagnostic,
not certification. `brain eval <manifest> --profile release` fails before
reading the admin key or contacting the brain unless the private suite has at
least 60 cases, explicit risk, domain, format, and query-kind declarations, and
at least five cases in every declared slice. That is a v1 retrieval-suite
coverage gate. Query-kind coverage comes from executable `kind`, and every
release unanswerable case must run and pass even when it is not marked critical.
Answerable v1 cases may opt into a deterministic `/think` canary through
`answer_expect`: a literal phrase or typed value must appear inside one sentence
with an inline citation resolving to an allowed evidence slot. Every declared
release canary and every critical smoke canary must run and pass. Existing v1
cases remain retrieval-only. `--no-think` is smoke-only.

An install may add a private corpus completeness gate:

```bash
brain eval <manifest> --corpus-contract ./brain.corpus-contract.json
```

The mode-0600 contract is validated twice before credential use and is bound to
the manifest `client.slug`. A complete contract and complete per-connector
snapshots reconcile every expected logical source family against the
authenticated read-only D1 family inventory. Private family identities and
cursors travel in JSON POST bodies, never URLs, and the response is private and
no-store. The complete source set is derived from live D1 documents instead of
denormalized corpus statistics. Eligible sources must exist;
excluded, quarantined, and tombstoned sources must not; and unknown indexed
families fail. Aggregate slice counts and stage-specific codes enter the normal
JSON, JSONL, CSV, and JUnit artifacts. Private locators, source identities,
document names, content hashes, versions, and content never do.

This shipped gate proves logical source-family presence and expected policy
absence only. D1's current family observation does not expose content-version,
extraction, connector-failure, or per-family vector evidence, so those stages
remain explicitly not observable. General answer correctness, additional-claim
and faithfulness review, semantic citation support, authorization,
confidence-bound, latency-budget, and cost certification remain v2 work.

`test/migrations.test.mjs` applies every migration to a real SQLite database and
asserts the FTS5 triggers actually keep the index in step. It exists because
migration 0004 once shipped broken: the SQL splitter shredded its trigger bodies,
and the store tests use mocks, so no test had ever executed a migration file.

The published package includes the reviewed eval runtime, configuration, and
blank golden-set template. Private baselines and client golden question files
are excluded. `package.json` uses an allowlist rather than a denylist so private
evaluation data cannot be included by accident.

`brain eval --artifacts <new-directory>` writes a sanitized internal v1 report
set with opaque case IDs. The directory and files are owner-only, are never
overwritten, and are never uploaded. Deterministic answer results contain only
counts, booleans, and typed failure codes, never expected phrases, values,
answers, citation identities, or source titles. It is intentionally not labeled
as the v2 run-artifact schema described in `docs/EVALUATION.md`.
