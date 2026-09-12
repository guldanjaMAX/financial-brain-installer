# Your Financial Brain journey

This packet takes an owner from the first conversation to a useful,
supportable Financial Brain. The owner and technician work together in Claude
Code, one clear question or action at a time. The owner may pause, skip, or say
"I do not know" without losing progress.

The owner keeps control of every account, login, billing choice, permission,
passkey gesture, source connection, and private-data load. Claude Code should
do the safe navigation and routine checks it can do, then hand control back for
the moments that require the owner.

Choose the first source from what the owner wants to understand. A usual
value-first order is current client-call transcripts, recent high-value email,
messages and shared files, the main file store, then financial data when the
owner's goal requires it. Load older history after the first useful cited
answer works. Copy the [client onboarding scorecard](../10-client-onboarding-scorecard.md)
for every install so elapsed time, owner time, retries, proof, and gaps can
improve across clients without recording customer content.

## The whole journey

| Stage | Typical owner time | Finish line |
|---|---:|---|
| Gentle pre-interview | 15 to 45 minutes, with pauses welcome | A first goal, known people or entities, proposed sources, exclusions, and honest unknowns |
| Readiness and install | 60 to 90 minutes | The exact reviewed release is installed and reports healthy |
| First source | 45 to 90 minutes | One useful source is previewed, approved, loaded, and checked for freshness |
| Remaining sources | 30 to 90 minutes each, depending on provider | Each chosen source has its own receipt and honest proof level |
| Initial meaning index | 30 minutes to many hours | The vector backlog reaches zero; the command can resume after interruption |
| Owner-led acceptance | 20 to 45 minutes, then as useful | Evidence-derived checks and real owner questions establish what works and what remains unknown |
| Optional private regression suite | Only if the owner wants one | Owner-chosen cases are saved for later comparison |
| Acceptance and handoff | 30 to 45 minutes | Ownership, access, recovery, support, and the next update path are confirmed |

These are planning ranges, not promises. A large corpus, provider review, slow
internet, account controlled by another person, or missing export can extend
the schedule. The technician records actual time and remaining gates. No fixed
question count is required to complete install, acceptance, or handoff.

## What to have nearby

- The computer that will run setup and Claude Code, plus a current desktop
  browser. The Brain itself runs in the owner's Cloudflare account.
- The owner's Cloudflare and Claude accounts.
- A passkey-capable phone, tablet, or computer for the guided owner sign-in
  ceremony when that step is reached.
- One valuable folder or source that can be safely previewed first.
- Any pre-interview notes the owner already has. Preparing questions is
  optional.

Node.js 22 or newer is a behind-the-scenes technician prerequisite. So are at
least 2 GiB free on the actual per-user install drive and a normal non-elevated
terminal. On Windows the space check uses `LOCALAPPDATA`. The owner does not
need to learn Node.js or inspect a drive. The guided `brain tools` check does
that work and names one fix when anything is missing.

## Start the pre-interview in Claude Code

Copy this prompt into Claude Code:

```text
Read onboarding/00-pre-install-interview.md from my reviewed Financial Brain packet. Interview me gently, one question at a time, and adapt each follow-up to what I just told you. Build a private working map of my goals, confirmed owner statements, possible mentions, sources I may approve, exclusions, access boundaries, and honest unknowns. Do not invent facts or require a fixed set of questions. Do not ask me to paste a password, token, authentication code, bank credential, private key, invite link, passkey detail, or private file content. Stop before any login, account connection, upload, OCR run, deployment, deletion, billing change, passkey ceremony, or access grant.
```

## Start install or update in Claude Code

For a new install, open `https://financialbrain.ai/install` on the host
computer. After the core install is verified, continue at
`https://financialbrain.ai/onboard`. For an existing Brain, use the reviewed
update page before onboarding. In each case, tell Claude Code:

```text
Read the complete reviewed Financial Brain page for this job and guide me through it one action at a time. Begin read-only. Offer to use browser control for official-page navigation and safe non-secret fields. Return control to me before login, 2FA, credential or secret entry, consent, billing, or any secure passkey window. Explain why each owner-only moment is needed before it appears. Ask before every Cloudflare change, provider connection, private-data load, OCR run, deletion, revocation, billing change, or invite. Keep every secret in its provider page or hidden terminal prompt, never in this conversation.
```

The public page pins one immutable release and gives the person and Claude Code
the same commands. It does not deploy, connect, upload, or update anything by
itself.

## New or replacement computer

Start with a read-only local readiness check before changing the Brain or any
cloud account. Verify these separately:

1. the exact reviewed Brain CLI is installed and starts;
2. the `financial-brain-technician` skill is installed and readable;
3. the owner-assistant MCP registration, which is the private local connection
   between Claude Code and the Brain, exists and exposes the expected read,
   remember, and connection-check tools.

Missing is different from broken. Optimize may report that the CLI, technician
skill, or MCP registration is missing or outdated, but Optimize stays
read-only. It does not install a CLI, change the Brain, or inspect passkeys and
devices. If the exact installed release advertises a supported assistant repair,
Claude Code previews the selected local files and settings first. The owner
approves that repair as a separate action.

A passkey is handled only in the guided install or handoff ceremony. It is not
an Optimize check.

## Scans and OCR

Scanned PDFs can be read with OCR when the owner explicitly enables it. OCR is
off by default because every scanned page uses Workers AI in the owner's
Cloudflare account. Before an OCR-enabled load, show the owner the estimated
page count, cost range, time range, and daily spend cap. Machine-read text is
marked as OCR, and an unusable reading is refused.

Do not label every empty or failed extraction as a scan. If the system cannot
prove that a file is scan-only, its reading state remains unknown. Scan-only
material remains unreadable while OCR is off.

## Source-level access zones

One Brain can use multiple access zones across its registered sources. Each
registered source can have at most one zone label, and a named grant may include
one or more allowed zones. An unzoned source stays owner-only and is excluded
from every named zone grant.

Zones do not split individual items inside one source. If one source mixes
audiences, keep it owner-only until the technician can create safe separate
source scopes or the owner chooses a broader boundary. Acceptance checks the
source assignment, document and search projections, and a real scoped search.

## What counts as proof

The technician reports each item with one of these labels:

1. **Configured:** settings exist, but behavior has not been exercised.
2. **Locally validated:** the real local command or browser path worked without
   touching a live provider.
3. **Scripted or fixture proof:** deterministic tests passed with synthetic data.
4. **Live tested:** the named provider, account, device, or Cloudflare resource
   completed the stated action and returned a dated receipt.
5. **Accepted:** the owner reviewed the live result and signed the acceptance
   record.
6. **Blocked:** a named prerequisite is missing; the next safe action is stated.

A green test suite, visible button, packaged file, or fixture is never reported
as live provider proof.

## Continue through the packet

- [Technician runbook](./TECHNICIAN-RUNBOOK.md) covers install, the app, and
  source onboarding.
- [Acceptance and handoff](./ACCEPTANCE-AND-HANDOFF.md) covers adaptive
  owner-led acceptance, the optional private regression suite, ownership
  transfer, and future updates.
- [Support and offline recovery](./SUPPORT-AND-OFFLINE.md) covers interrupted
  work and the private support preview.
- [Data protection draft](./DATA-PROTECTION-DRAFT.md) is a factual product draft
  for privacy and legal review. It is not legal approval.
- `support-profile.example.json` is the single configurable support contact and
  response-target record. Replace it with the approved engagement profile
  before delivery.
