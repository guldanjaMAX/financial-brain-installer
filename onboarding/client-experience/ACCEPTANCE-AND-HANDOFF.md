# Acceptance, handoff, and future updates

## Adaptive owner-led acceptance

Acceptance is a guided conversation, not a quiz. It starts with the actual
source receipts, financial picture inventory, and stored evidence. It does not
require the owner to prepare twenty questions or invent events that never
happened.

Claude Code guides one check at a time:

1. Read the current source, freshness, provenance, access-zone, extraction, and
   financial-picture receipts without changing anything.
2. Explain what is confirmed, what is only a possible mention, and what remains
   unknown, unavailable, partial, or not applicable.
3. Offer one evidence-derived question that tests something material in the
   evidence already present. State which source and readiness dimension it is
   meant to check.
4. Ask the owner whether that question matters. The owner may use it, reword
   it, replace it with a real question, or skip it.
5. Run only the question the owner chose. Review its citations, date and
   freshness signals, provenance, and access zone together.
6. Record the result as accepted, failed, blocked, or deferred, with the next
   safe action. Do not turn a missing answer into a guessed fact.
7. Ask whether the owner wants another check or is ready to stop.

Good coverage adapts to the evidence. When applicable, include a current fact,
a changed or conflicting fact, a question that needs more than one record, a
source-history boundary, a reading-quality or OCR boundary, and a scoped-access
check. If that kind of evidence does not exist, record the gap instead of
manufacturing a test case.

The acceptance session can finish with a short set of useful checks and an
honest gap list. There is no canned-question quota.

### Adaptive acceptance Claude Code prompt

```text
Start read-only. Read the current Financial Brain source and financial-picture receipts, then explain the confirmed evidence, possible mentions, conflicts, and gaps in kind plain language. Offer one evidence-derived acceptance question at a time and tell me why it matters. Let me use it, reword it, replace it with a real question, or skip it. Do not invent a person, entity, account, event, document, expected answer, or refusal case. After I choose a question, help me inspect the citations, freshness, provenance, OCR warning, and access zone. Record accepted, failed, blocked, or deferred, then ask whether I want one more check. Do not make any repair or other change during acceptance.
```

## Optional Golden 20 regression suite

Golden 20 is strictly optional. It is available only when the owner wants a
larger private suite for repeated comparison over time. It is not required for
install, acceptance, handoff, Optimize, support, or access to the Brain.

If the owner chooses it, run:

```text
brain eval <manifest> --golden-20
```

The owner chooses the questions. Claude Code may help organize real owner
questions into useful coverage groups, but it must not invent, rewrite, or
improve the substance, expected answer, or unsupported premise. The session
saves after every chosen question and may stop before twenty. An unfinished or
declined optional suite does not block handoff.

A completed suite is an owner-reviewed regression aid. It is not a release
certification, professional audit, or proof that every source and question is
covered.

## Guided passkey handoff

Passkey enrollment and sign-in belong in the guided install or owner handoff,
not in Optimize. Immediately before the passkey prompt, explain:

- choosing **Create my owner passkey** opens the device's secure passkey window;
- the purpose is to confirm owner access to the Brain's private owner area;
- the owner follows that device window using Face ID, fingerprint, device PIN,
  or screen lock, and may cancel if the hostname or prompt looks unexpected;
- Financial Brain and Claude Code cannot see or store the passkey, biometric,
  or device PIN;
- the passkey step does not connect files, messages, accounts, or other device
  data.

Claude Code may navigate safely to the correct owner page after approval, but
must return control before the secure passkey window. Record only whether the
ceremony succeeded and its proof level. Never record a passkey identifier,
biometric, PIN, recovery code, or screenshot of the secure prompt.

## Acceptance record

The private handoff receipt records each applicable item as accepted, blocked,
or deferred:

- exact installed release and package digest;
- final hostname and Cloudflare account ownership;
- live health, migration, search-readiness, and vector-backlog results;
- guided passkey enrollment, sign-out, sign-in, and recovery path;
- app desktop, keyboard, and mobile-width checks;
- every approved source with counts, freshness, provenance, extraction or OCR
  state, proof level, and unresolved gap;
- every registered source's zone, any unzoned owner-only source, projection
  agreement, and one real scoped-search result when named access is used;
- exclusion and leak-tripwire results;
- the adaptive questions the owner accepted and the remaining gap list;
- the optional Golden 20 result and private local suite location, only if the
  owner chose to run it;
- support contact, coverage window, response targets, and offline path;
- access removed, retained, or time-limited for each technician or collaborator;
- owner-approved retention and deletion decisions;
- the next update check date.

Keep secrets, raw private content, questions, answers, filenames, paths, invite
links, passkey identifiers, and authentication details out of the receipt.

## Owner handoff

Guide these one action at a time. Do not present them as a batch of homework.
Before closing the session, the owner should be able to:

1. open the app and complete the explained passkey sign-in;
2. ask one real question and understand an honest unknown or unavailable state;
3. see source freshness, provenance, OCR warnings, and access zones;
4. run `brain doctor <manifest>` with guidance;
5. preview the local support note with `brain support --preview`;
6. identify the manifest and any private local evaluation suite without sharing
   their paths publicly;
7. confirm the named Cloudflare browser profile is bound to the exact owner
   account and, if a fallback API token was used, revoke that token and verify
   the Brain still works;
8. explain who can access the Brain, which source zones a named grant includes,
   and how to remove that access;
9. find the approved support profile and update page;
10. open `https://financialbrain.ai/optimize`, give its request to the connected
    assistant, and understand which source dimensions it could and could not
    inspect. This is assistant-launch guidance, not a signed-in dashboard.

## Optimize check-ins

Open `https://financialbrain.ai/optimize` with the owner at handoff and again on
days 15, 22, and 29, then give its request to the connected assistant. Reconcile
only the supported findings it actually returns with the private
[client onboarding scorecard](../10-client-onboarding-scorecard.md) and its
latest receipt. This public route is assistant-launch guidance, not a signed-in
source dashboard. Keep every unreadable or unavailable dimension explicit. A
combined percentage must not hide an incomplete dimension, and ranked search
must not be used as a complete source inventory.

Optimize is read-only. It may report a missing or outdated Brain CLI,
technician skill, or MCP registration on a new computer. It does not install or
repair those items, enroll a passkey, list devices, or ask the owner to
recognize devices. A repair is a separate previewed action after the report.

At each check-in, begin with the evidence and offer one material question or
improvement at a time. The owner chooses whether it matters. Record the
baseline, elapsed time, owner time, retries, and answer gap. At the next
check-in, keep, revise, or revert the change based on the new receipt. Never
copy the client's raw question, answer, transcript, message, filename, or
financial value into the shared scorecard.

## Future update notification

The public release feed is `https://financialbrain.ai/update/manifest.json` and
the human and Claude Code guide is `https://financialbrain.ai/update`. A client
app may report **update available**, **current**, or **update check unavailable**.
Unavailable is not the same as current.

An update notice never performs a background update. It points the owner to the
reviewed page and this copyable prompt:

```text
Open https://financialbrain.ai/update, read the whole page, compare the reviewed release with my installed Brain, and explain the changes one action at a time. Begin read-only. Offer browser control for official-page navigation and safe non-secret fields, then return control before login, 2FA, secret entry, consent, billing, or a secure passkey window. If an update is available, ask before the Cloudflare update and keep every credential in its provider page or hidden terminal prompt. Finish with exact version, health, source freshness, vector backlog, and the owner-led acceptance checks I choose.
```

After a successful update, record the exact version, recovery bookmark, health,
source freshness, vector backlog, release notes, and any live acceptance the
owner chooses to repeat. If the feed cannot be reached or validated, do not
claim the client is current.
