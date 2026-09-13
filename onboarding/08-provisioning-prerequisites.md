# Provisioning prerequisites

Everything that must be true **before** an install session starts. Verified
against live Cloudflare and current Cloudflare limits on 2026-08-24.

Supersedes the Supabase account steps in `02-client-effort-and-timeline.md`.
The brain no longer needs Supabase: it runs on the client's own Cloudflare
account alone.

---

## What the client needs

| # | Thing | Time | Why |
|---|---|---|---|
| 1 | Claude Code plus an eligible Claude account | 5 min | Claude Code is part of the owner handoff and is connected directly to the Brain |
| 2 | Node.js 22 or newer | 5 min | Runs the Brain CLI and the pinned Wrangler 4 command |
| 3 | At least 2 GiB free on the actual install drive | 2 min | Prevents a partial install. On Windows this means the `LOCALAPPDATA` drive |
| 4 | A normal non-elevated terminal | 1 min | Keeps files owned by the current user. Do not use `sudo`, root, or Run as administrator |
| 5 | A Cloudflare account | 5 min | Everything lives here. Theirs, not ours |
| 6 | **Workers Paid plan on it** | 2 min | 5 USD/month minimum. The Free plan is prototype-scale, not a supported production home for a real corpus |

No Supabase, database password, or separate answer-model API key is required.
The Claude account is for the owner's Claude Code client, not for Worker answers.

## Local tools before Cloudflare

Install Claude Code only from Anthropic's official installer. The owner signs in
in their own browser. Do not use `sudo`, a permission-bypass mode, or a copied
Claude credential.

Before the first `brain tools` run, tell the owner that this is a local setup
action, not a read-only check. It installs or updates the reviewed Financial
Brain technician skill and may write local bootstrap status and may update the
current user's PATH to include the Brain CLI folder. Ask the owner to
approve those local changes. Optimize never runs `brain tools`; it uses the
non-writing machine-continuity, MCP discovery, and configuration checks instead.
First ask whether this is the owner's first Brain, an existing Brain on this
computer, an existing Brain being reconnected on a new computer, an interrupted
setup on this computer, or whether they are unsure. Never infer a first Brain
from a missing file. After approval, run the matching explicit intent:

```bash
brain tools "/absolute/path/to/brain.manifest.json" --intent <selected-intent>
```

The automated part then proves the Claude version, `claude auth status`, and
the pinned Wrangler version in a credential-scrubbed child environment. It also
checks Node 22+, at least 2 GiB free on the actual per-user install drive, and a
non-elevated current-user session. In a real
terminal it also opens `claude doctor`, which owns an interactive terminal UI
and therefore cannot be truthfully replaced by a headless fixture.

Wrangler is fetched on demand at pinned major version 4. It is not installed
globally and it does not receive ambient Brain, Google, Zoom, bank, or mail
credentials just to print its version.

---

## Workers Paid is the prerequisite that bites

Vectorize now has a Free allowance, but that does not make the Free plan a safe
production baseline for this product. At 768 dimensions, its 5 million stored
vector dimensions hold only about 6,500 chunks. The Free plan also hard-stops at
100,000 D1 row writes per day and 10 ms of Worker CPU per request. A normal
personal or company corpus can cross those limits during its first load.

**Confirm it before any resource is created.** First let the named sign-in
verify the exact Cloudflare account. Setup then opens that account's Workers and
Pages, Plans page. It should say Paid. Upgrading takes about two minutes and a
card, and every billing action belongs to the owner. `brain doctor` can prove
product access, but the narrow installer sign-in cannot read billing status, so
the owner's dashboard confirmation remains the plan proof. Never infer Paid
from successful Vectorize access.

Current limits:

- Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/

---

## Normal Cloudflare approval: browser sign-in

`brain setup` opens Cloudflare's official browser sign-in. The owner signs in,
completes 2FA, chooses the exact account, reviews Cloudflare's consent page, and
approves it. Wrangler saves this Brain's named profile in the owner's protected
operating-system credential store. Normal fresh setup creates, reveals, copies,
and pastes no API token.

When browser control is available, the assistant may open the official page and
continue the installer after the owner finishes. The owner controls sign-in,
2FA, account selection, and consent. If the account or consent screen differs
from the explanation, stop before approval.

### Recovery-only scoped token

A scoped token remains available for a reviewed legacy, automation, or recovery
path. Describe it only when the released CLI says browser sign-in is unavailable
and the owner explicitly chooses that path. It is not a normal fresh-install
prerequisite.

Those paths do not bypass the Node, free-space, elevation, exact-account, or
Workers Paid prerequisites. An unattended setup launcher must provide the
released CLI's non-secret account-bound Paid confirmation for the exact manifest
account. A generic yes or a different account ID must stop before provisioning.

That recovery token uses only Workers Scripts Edit, D1 Edit, Vectorize Edit,
and Workers AI Read at account scope. Add R2 Storage Edit only when the manifest
sets an R2 bucket, and use a short expiry. The owner enters it only into the
Brain CLI's hidden prompt. Never email it, message it, place it in a command, or
let an assistant read, copy, screenshot, transcribe, or store it.

---

## Verify before you start

Run `node brain.mjs setup <manifest>` for a new install or
`node brain.mjs update <manifest>` for an existing install. For a new install,
complete the owner-controlled Cloudflare browser sign-in and confirm the exact
account when prompted. A hidden token prompt is a separately selected recovery
path, not an ordinary setup step.

The preflight should show five green lines: account resolved, R2, D1, Workers,
Vectorize. A
warning on R2 is survivable and the brain runs without it. **A warning on
Vectorize is not** — it means the install would come up keyword-only, which
looks healthy and answers badly, and that is far worse than failing loudly.

---

## What "keyword-only" actually costs

Worth being able to say out loud, because a client will ask why Paid is our
supported production baseline.

Without Vectorize, the brain can only find documents that **repeat the words in
the question**. Ask "how do we stop overwhelming a new customer with decades of
paperwork" and it finds nothing, because the document that answers it says
"without ordering up twenty years of homework" and shares not one word with the
question.

With Vectorize, that query returns the right document as the top hit. Verified
on 2026-08-17. That gap is the entire difference between a search box and a
brain, and it costs five dollars a month.
