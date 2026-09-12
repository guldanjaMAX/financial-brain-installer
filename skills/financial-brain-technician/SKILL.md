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
2. Use one total owner-question budget per owner-facing Optimize response across
   the optional goal, evidence clarification, and zoning, outside an owner-chosen
   guided Financial Map interview. First resolve the installed Brain quietly.
   If that requires an owner choice, use this
   response's one question for that choice and defer every audit blocker.
   Otherwise ask only the highest-priority pending blocker, in this order: a
   material evidence conflict, a whole-source zoning decision, then the
   optional goal. Skip the goal whenever a material evidence conflict or any
   zoning decision is pending. Only when neither is pending and the owner has
   not already stated a goal may you ask: "What would you most like your
   Financial Brain to help you understand or keep current?" Let the owner
   answer, say "not sure," or skip it. Asking it consumes this response's
   budget even when the owner skips. Once the response asks one question, state
   and defer every other blocker instead of asking another. Then say in ordinary owner
   language: "I can check your Brain without changing its data, settings,
   access, or indexes. I will run the read-only checks and report what I find.
   If a CLI check fails, it may save a private support note on this computer so
   the problem can be explained later." Do not narrate
   skill selection, source-code inspection, PATH archaeology, release research, or whether the
   workflow "shipped." Those are internal implementation details, not part of
   the owner's experience.
3. Resolve the installed `brain` executable and remembered manifest quietly
   using the packaged discovery path before asking the goal question. A normal
   successful lookup gets no status story. If there is no unambiguous Brain to
   check, state the one concrete blocker in plain language. Ask for the smallest
   owner choice only when this response's one-question budget remains; otherwise stop
   without disguising a second question as a suggestion, confirmation, or
   zoning choice.
4. The owner's request already authorizes the contract's read-only checks. Do
   not ask for a second approval. It does not authorize a repair, update,
   reindex, drain, refresh, zone change, grant change, connector action, or any
   other write.
5. Work quietly, with one brief progress update only if the checks take long.
   Report the observed result and its limits. Do not dump commands, internal
   filenames, version-search history, or tool activity unless the owner asks.

Make the Owner Financial Map state the first audit evidence after that opening
decision, whether the optional goal was asked or skipped. Immediately before
calling `brain_financial_map` with `mode: "read"`,
say: "I'm about to read your current Financial Map. This sends no Financial Map
snapshot and changes nothing. Your assistant may still show an approval prompt
because it is authorizing a private read from your Brain." Do not let a normal
host approval prompt arrive without that explanation. Then perform the read and
report whether the active map is current, stale, or not established, its
declared population state, and its unresolved items.

Treat every structured entity or account as a
possible mention until the owner confirms it. A missing, stale, incomplete, or unresolved map means the financial
completeness denominator is not established. Before making any financial
completeness conclusion, offer the guided Owner Financial Map interview. Do not
start it automatically. If the owner declines, continue the other read-only
checks and report that completeness remains unproven. If the owner chooses the
interview, ask one short adaptive question at a time. The interview itself is
read-only and creates only a conversational working draft; it does not submit a
preview, activate a map, confirm ledger rows, or authorize any other write.
Each interview response asks only that one adaptive map question and combines it
with no goal, evidence-clarification, or zoning question.

Track every planned check as **observed**, **named unavailable or refused from
an actual receipt**, or **not run**. Never describe a not-run check as checked,
passed, unavailable, or complete. Only after every planned check actually ran
and produced one of the first two states may the owner report begin, "Optimize complete. I made no changes to your
Brain, data, settings, access, or indexes." Otherwise begin, "Optimize stopped before every check could run. I made no
changes to your Brain, data, settings, access, or indexes," and name what was
not run. If a CLI check failed, add that it may have saved a private local support note
and that nothing was uploaded. Say, "Optimize checked this computer's Brain skill and MCP
connection but installed nothing and changed no
settings," only when both checks actually ran. Otherwise say exactly which one
was not run. For each observed check, say whether it is ready, missing, stale,
or unproven. Keep the rest to at most three short sections:
**Working**, **Needs attention**, and **Need from you**. Lead with
what the Brain can currently be trusted to do. List every material blocker, but
use **Need from you** to ask only the one highest-priority question allowed by
this response's shared question budget. State that lower-priority decisions are
deferred.
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

Treat a failed or stale source as a scoped finding. Continue the independent
read-only Optimize checks for other sources and for the local CLI, technician
skill, MCP registrations, storage, indexes, zones, and grants. Positive evidence
from available sources remains usable, but never treat the failed source as
proof that its stored corpus is absent or its history is complete. Qualify every
conclusion that depends on it as unproven. Only a whole-Brain access failure may
prevent the remote checks that require that access, and it must not prevent
independent local checks.

Use the records and metadata already present. Compare provenance, effective and
modified dates, source receipts with stored counts, extraction gaps, conflicting
values, superseded evidence, duplicate document families, and whose voice each
claim represents. Resolve every ambiguity that those records can resolve. Do
not ask more than one owner question in the response outside an owner-chosen
guided map interview. Ask an evidence clarification only when a material
ambiguity remains after that review and it is the highest-priority pending
blocker. It uses the same per-response question budget as the optional goal and
zoning; it is not an additional question. Never split the goal, clarification,
and zoning into separate question budgets.

For the Financial Picture stage, run the read-only
`brain financial-picture <manifest> --json` inventory. Use its exact entity,
possible-mention, business, account, tax-year, period, custody, extraction,
supersession, and conflict records as an interview map. Start with the bounded
full inventory, then use only its exact entity, year, or period filters when a
focused follow-up is needed. Never turn an empty, Unavailable, truncated, or
unresolved section into an answer. Never infer or auto-confirm ownership,
entity-to-account scope, a tax period, or a supersession target from a name or
raw identifier. Treat `owner_stated` plus `confirmed` as a stored assertion, not
proof of who performed a confirmation ceremony. The inventory requires current
owner confirmation because the schema has no owner-actor receipt for these
mappings. If the one owner question for this response should be an evidence
clarification, choose it from a material blocking gap or conflict that the cited
provenance cannot resolve, and name the evidence that made the question
necessary. Otherwise report the gap without asking another question.

An owner's interview answer does not authorize a write. Keep any correction,
mapping confirmation, supersession, OCR, reingest, or reconciliation ruling
outside Optimize. Offer it only after the read-only report through a supported,
exactly previewed mutation path, and run it only after separate explicit owner
approval.

Do not turn an entity, account, ownership claim, tax year, or field found in
documents or structured records into owner-confirmed truth. A map that cannot
establish the denominator does not mean the owner has no other entities or
accounts.

Do not run Golden Questions, a Golden evaluation, a canned refusal exercise, a
known-answer control question, or require the owner to prepare test content.
Those remain optional, separate testing tools,
never Optimize prerequisites. Do check whether THIS computer has the reviewed
Financial Brain technician skill and whether its existing Claude Code MCP entry
matches the read-only output of `brain mcp-config <manifest>`. Verify the MCP
runtime through exact executable and argument comparison plus protocol
initialization, connection status, and expected tool discovery. Do not ask a
known-answer content question for MCP proof. If configuration or protocol
discovery is absent, fails, is refused, or is not run, report that exact state.
Never claim an MCP or other Optimize check ran without its actual receipt.
Report an absent, failed, refused, or not-run MCP check as that exact state, and
never call Optimize complete while any planned check is not run. Do not run `brain tools` during Optimize
because it writes the technician skill and local setup files, and do not run `brain mcp-config --apply`.

Make zoning a normal Optimize checkpoint. Run read-only `brain zone <manifest>`
and `brain grants <manifest>`, list every unzoned source, and explain that zoning
applies to the whole source. Recommend an exact source-to-zone mapping only when
source-specific evidence establishes the boundary for the entire source. The
observed source scope and purpose, existing allowed zones, and an owner-confirmed
Financial Map or prior owner statement must support that exact choice; cite the
evidence. A source label, connector kind, document count, or plausible guess is
not enough. Without supporting evidence, never propose or recommend a zone.
State the available whole-source choices, including leaving the source unzoned,
explain each consequence, and say that the records do not determine the choice.
When zoning is the highest-priority blocker, ask the owner to choose among those
whole-source options; that question uses this response's one question budget.
When a material evidence conflict has higher priority, defer the zoning choice
to the next response.
Unzoned sources with no grants are sharing-readiness
work, not evidence that somebody currently has access. Do not apply a mapping during the audit. After
the report, show an exact mapping and affected counts only when it is either an
evidence-backed recommendation or the owner's selected choice. Label which one
it is. Only if the owner separately and explicitly approves that mapping, run
`brain zone --source ... --zone ...` one
source at a time, repeat its bounded projection pass when the receipt says work
remains, then verify zones and grants again.

Never claim that zoning, grants, MCP, sources, storage, indexing, or any other
check ran unless its actual command or tool returned an observed receipt in this
Optimize run. A plan, remembered result, inferred state, or missing output is
not a performed check.

When model selection is available, use `gpt-5.6-luna` at medium reasoning for
routine Optimize. Use `gpt-5.6-terra` at low reasoning as the fallback or
escalation for harder evidence conflicts. This floor has synthetic behavioral
evidence only, not live Brain proof. Do not pin `gpt-5.6-sol` or infer Optimize
completeness from model choice.

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

When the owner chooses the guided Owner Financial Map interview before the
financial completeness conclusion, use plain names instead of internal ids.
Cover the finite tax-year horizon, whether the whole entity and account
population is complete, every possible entity and account exactly once, every
entity-year pair, and each independently assessed material field. Ask what
entities and accounts the owner expects but the current records do not show.
Keep those as owner-declared working rows with opaque local IDs and no ledger
link. Do not create or alter a ledger row to make the evidence look complete.

For each entity and each year, separately ask about its filing unit, required
returns, required forms, K-1 roles, books and bookkeeping company, payroll
applicability, and expected sources. A confirmed empty list, unknown, unavailable,
and not applicable are different answers. Preserve that distinction. When a
material entity or account field is confirmed, record the owner's value
separately from the current ledger value so any mismatch remains visible. Never
infer a missing answer or use one answer to confirm a different field.

When the interview is complete, finish the remaining read-only checks and end
Optimize without submitting the working draft. Explain that previewing will
create a complete non-authoritative version 1 preview by writing one expiring
review copy to the owner's Brain, and changes no ledger, source, tax, books,
payroll, or account record. Ask for separate explicit owner approval outside Optimize before calling
`brain_financial_map` in preview mode. If approved, report only the returned
state, counts, unresolved count, and expiration. Do not echo the submitted
private map, expose a selector, or place an activation value in chat. Ask the
owner to open **Financial Map** in the signed-in owner app, where they can review
the entire exact map, its differences from the last confirmed map, and every
unresolved item. A preview has no authority. The MCP has no activation operation.

Activation requires another separate owner decision after preview and remains a
separate owner ceremony outside Optimize. Explain that the fresh passkey
confirms the exact reviewed map, denominator, and current map head, then let the
owner choose whether to continue in the Financial Map owner screen. Browser
control may open that screen and scroll the complete review, but it must stop
before the one confirmation button. Never put a review selector in a URL,
browser storage, clipboard, or chat. Never trigger a passkey prompt from
Optimize and never substitute the admin key.

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

## Offer one exact provenance repair only after Optimize

Finish and show the read-only Optimize report first. A provenance gap in that
report is not approval to repair it. Confirm that the exact installed stable
release advertises the one-target provenance lane before naming or running it.
The held 0.4.8 candidate is not a customer release and must not be used on a
customer Brain.

When a supported release is available, offer this lane only for one exact file
the owner chooses from the manifest's enabled local folder source:

```bash
brain provenance-repair "/absolute/path/to/brain.manifest.json" --source <name> --target <source-relative-file>
```

Never infer or guess the target from a gap, filename, search result, entity, or
document content. The source must be registered as an upload source. The file
must resolve to one complete `native_readable` record with reliable extraction.
OCR stays off. Stop on a scan, partial or failed extraction, password-protected
file, unsupported format, empty result, multi-record export, or ambiguous
target.

The preview obtains the source lease before reading the private manifest,
source file, saved credential, or Brain state. It checks the complete source
inventory and observation history, the exact local bytes and extraction, and
the current schema and vector state. Explain that preview leaves no lasting
Brain or configuration change and that its public output hides the local root,
file locator, private query, hashes, document IDs, and sealed internal receipts.

Before asking for approval, read the preview's workflow and explain its effects
in ordinary language. For `exact_original_repair`:

- one exact native-readable file will be reingested with OCR off;
- stale siblings may be removed only from that file's exact result family;
- the shared vector drain may also process unrelated work already queued;
- reingest and drain may create embeddings; and
- the four proof operations run eight private retrieval probes in total and
  may create ordinary aggregate usage records.

For `accepted_resolution_reverification`, explain instead that the exact
accepted observation already exists. The run repeats only schema-44 record and
verify plus schema-45 record and verify. It still runs eight private retrieval
probes and may create ordinary aggregate usage records, but it does not record
a discovery gap, reingest the file, remove family members, or drain the shared
vector queue. Use this fresh approval after a lost response, stale activation,
or verified recovery. Never reuse the earlier approval hash.

Also say what it will not do: it will not advance a source-wide receipt or
cursor, perform source-wide removal, claim that the source is complete, change
zones or access, inspect devices, start a passkey ceremony, alter providers, or
change Cloudflare deployment state.

Ask for separate explicit approval of the exact preview hash. A generic request
to fix provenance is not that approval. Apply must reacquire the lease and
recheck all private state. For `exact_original_repair`, its order is exact-target
ingest, exact-family reconcile, global vector drain, schema-44 `result_family`
record, schema-44 verify, schema-45 `accepted_resolution` record, and schema-45
verify. For `accepted_resolution_reverification`, only the final four proof
operations run. Do not skip the schema-44 record or verification even if old
evidence exists. Stop on
lease loss, stale history, changed bytes, an unexpected response, a mismatched
receipt, recovery without fresh local activation, or any failed verification.
Never report success unless the final schema-45 verify says the one exact
resolution is current and still states `whole_source_complete: false`.

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
3. Before sign-in, a financial-provider handoff, or a final approval, stop and
   give a ten-second handoff: why
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

## Optimize and repair a new computer

Optimize is a read-only audit. It may check the installed CLI, this technician
skill, the Claude Code MCP entry, and the Codex MCP entry, but it must not
install or rewrite any of them during the audit. Leave passkeys and enrolled
device review out of Optimize.

After the report, first require the independent public release target to be
stable, available, and to advertise the exact Owner assistant profile, five
tools, and every selected local repair scope. A missing or older CLI is a
separate executable replacement and never belongs in the local assistant
bundle below.

For any owner-selected combination of `technician-skill`, `claude-code-mcp`,
and `codex-mcp`, use the exact released CLI to preview one bundle:

```bash
brain assistant-repair "/absolute/path/to/brain.manifest.json" --only technician-skill,claude-code-mcp,codex-mcp
```

The preview is read-only. Show the owner its exact write set, preserved custom
or disabled entries, per-item rollback and verification, excluded scopes, and
the state-bound plan ID. Remove any item whose release scope is not advertised.
One explicit owner approval may cover the complete remaining bundle. After
that approval, run the preview's exact apply command once, including its plan
ID. A stale plan stops before writing. Do not substitute `brain tools`, generic
`brain mcp-config --apply`, setup, or onboarding.

After apply, require exact file or setting readback. Each repaired MCP entry
must initialize as `owner-assistant` and expose exactly `brain_think`,
`brain_search`, `brain_remember`, `brain_health`, and `brain_financial_map`. A custom or disabled entry
is preserved. The CLI snapshots the complete selected write set before the
first write; any failed item restores every destination in reverse order to its
previewed bytes or absence. A failed verification is a blocker, not permission
to keep rewriting it. This repair never changes Brain records, sources,
providers, access, zones, passkeys, devices, cloud resources, or the CLI
executable.

## Route a sealed synthetic Windows rehearsal first

When the owner supplies a ZIP with an adjacent `release.json`, inspect the
receipt before entering any installed-Brain workflow. If `artifact_kind` is
`financial_brain_windows_onboarding_rehearsal`, this route replaces **Start
here** and the private install-kit check below:

1. Explain that this opens an invented, local owner experience so the owner can
   test the walkthrough. It does not install or inspect their Brain. Do not run
   `brain --version`, `brain tools`, the packaged preflight, setup, update,
   provisioning, or any connector command for this route.
2. Require schema version 1, `status: sealed_for_supervised_rehearsal`,
   `ready_to_send: true`, `ready_for_live_accounts: false`, purpose
   `synthetic_local_owner_experience_only`, physical Windows execution
   `pending`, and loopback origin exactly `http://127.0.0.1:4176`. Stop if the
   receipt is expired or any boundary allows customer data, credentials, or a
   live action.
3. Verify that the adjacent ZIP has the exact filename, byte count, and SHA-256
   in `archive`. Require the exact public Financial Brain repository, one
   40-character source SHA, a successful exact-SHA `ci` push run, and the
   checked-in launcher path `onboarding/start-windows-rehearsal.ps1`. This
   rehearsal ZIP is not the tested npm package, so do not compare its digest to
   an installed package and do not require an intended hostname.
4. Inspect the ZIP before extracting it. It must contain only
   `REHEARSAL-MANIFEST.json` and `RUN-WITH-CLAUDE-CODE.txt` beneath one folder.
   Verify the inner manifest path, bytes, and SHA-256 from the receipt, and
   require its source, launcher, CI, expiry, and safety boundaries to match the
   outer receipt. Extract only into a new empty local folder.
5. Follow `RUN-WITH-CLAUDE-CODE.txt` exactly. Handle its repository, detached
   checkout, hash checks, launcher, and local browser steps for the owner. Ask
   the owner only for the small choices and feedback named there. Stop at the
   first mismatch. Never request a credential, real passkey, provider login,
   live account, or customer record.

If the receipt has another artifact kind, continue below and apply that kit's
own contract. Never infer an install-kit contract from the filename
`release.json` alone.

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
3. If a private install test kit was supplied, read its `release.json`. The
   sealed synthetic Windows rehearsal route above must never reach this step.
   Stop if
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
- Ordinary onboarding must leave the bank feed disabled and must not run `brain
  connect bank`. Bank application-credential setup remains held. `brain setup`,
  `brain secrets`, and the generic technician workflow must never ask for,
  accept, or write `BANK_FEED_CLIENT_ID`, `BANK_FEED_SECRET`, or
  `BANK_FEED_WRAPPING_KEY_V2`. Do not improvise an entry path through chat,
  browser control, environment variables, command arguments, or a hidden
  prompt. An approved enabled pilot may preserve a complete existing
  three-binding set. If any binding is missing, stop without changing a local
  or Worker secret or rotating the core keys, and explain that a separately
  reviewed owner-custody process is required.
- Only inside a separately approved bank field plan, read
  [the Plaid release gate](../../docs/PLAID-RELEASE-GATE.md), then use the owner
  bank page to add any missing person or business and assign each whole account.
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
- A manifest with provisioned Cloudflare resource identities may continue its
  read-only doctor and handoff checks from Codex only when `codex login status`
  succeeds. In that narrow case, a missing or signed-out Claude Code is an
  advisory local-client gap, not a Brain-health failure. Report that Claude Code
  is not ready, but continue to health and source evidence. A pre-provision
  manifest or signed-out Codex does not relax the gate. Fresh setup and `brain
  tools` still require signed-in Claude Code, and no local skill or MCP repair is
  implied or authorized by the read-only check.
- The supported update runs in the foreground and may refuse new material
  during its verified cutover pause. Let documented waits finish. Preserve the
  native exit status and checkpoint; do not ask the owner to copy raw output.
- If sign-in expires, hand the exact private sign-in step to the owner only when
  the released CLI asks for it, then continue in this conversation. Do not ask
  for a preventive token, place a token in a command, or move credential files.
- Zero owner-authored questions are required for setup, adaptive acceptance, or
  handoff. Before calling a Brain proven, use the source receipts and prove the
  same approved low-sensitivity item as accepted, stored with source and
  extraction provenance, projected with its exact generation confirmed, and
  query-visible with the expected citation and provenance. Stop at the first
  unproven state. `testing.probe_questions` remains an optional private
  regression list that may be added later; it never replaces that evidence gate.
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
