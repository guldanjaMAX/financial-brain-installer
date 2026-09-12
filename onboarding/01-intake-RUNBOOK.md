# Running the intake (internal, not for the client)

The questionnaire does three jobs. Only one of them is obvious to the client.

| Job | Where it happens | What it protects |
|---|---|---|
| Captures the owner's **goal and acceptance context** | §1 and §6 | The first useful source and later evidence-derived checks stay tied to what the owner values, without requiring prepared questions |
| Asks the **Workspace vs Gmail** question | §5.1 | A consumer-Gmail client whose OAuth app is left in Testing has refresh tokens revoked every 7 days. The Brain silently stops updating about a week after handoff and looks like it broke on its own |
| Establishes **source and access boundaries** | §3 and §4.2 | Mixed-audience material stays owner-only unless it can be separated into safe source scopes; a name in a document never becomes a confirmed owner, entity, or account |

## How to run it

**Live on a call, not async.** Send it ahead so the owner can think, then walk
it together in Claude Code. Ask one short question at a time, explain why it
matters, and adapt each follow-up to the answer. The owner may pause, skip, or
say "I do not know."

**Use 15 to 45 minutes as a planning range, not a quota.** A first pass is
enough when you can name the owner's goal, one useful low-risk source to
preview, its likely owner and scope, important exclusions, and any blocking
unknown.

**Take owner statements in their own words.** Do not tidy them into technical
language or promote a possible mention to a fact. If a useful question comes up
naturally, keep it as an optional acceptance candidate. Zero owner-authored
questions is also valid. Acceptance begins from actual receipts and evidence,
not from homework.

## The three answers that change everything

### §4.2, the permission question

If some users must not see some content, identify which whole registered
sources can safely share one audience. Zones do not split individual files,
messages, or accounts inside one source. Keep a mixed source owner-only until a
safe separate source scope exists or the owner explicitly chooses the broader
boundary. Do not promise item-level separation that is not built.

### §5.1, Workspace or consumer Gmail

**Workspace:** register the OAuth client as user type Internal inside their own
organization. Confirm they are a real Workspace or Cloud Identity organization,
since Internal is available only there.

**Consumer Gmail:** Internal is not available. The app must be published to
production, not left in Testing. Testing status expires refresh tokens after
seven days, and that failure looks like the product broke by itself.

`calendar.events.readonly` is a sensitive scope, not a restricted one, so no
CASA assessment applies. The client may see a one-time Google warning screen
during setup. Explain it before it appears. If they decline this path, record
the source as deferred or unavailable rather than pressuring them.

### §2.4, the single highest-value folder

This sets the **priority slice**. It goes in first, gets proven, and everything
else streams in behind it.

Do not ingest chronologically. Ingest by likely answer value, which is usually
recent high-value material plus current meeting transcripts. The owner's goal
and approved boundaries still decide the order.

Prove one approved low-sensitivity item through Accepted, Stored with
provenance, Projected with no matching outbox work, and Query-visible with the
expected citation. Stop at the first unproven checkpoint; a connector count is
not acceptance.

## After the call

1. Copy [the client onboarding scorecard](./10-client-onboarding-scorecard.md)
   and assign an opaque client ID. Start its source order and timing fields now.
2. Keep the owner's goal, owner statements, possible mentions, unknowns, and
   any optional real questions in the private owner record. Do not automatically
   turn intake notes into `testing.probe_questions`.
3. Copy §2.1 and §3 into the private manifest as proposed sources and
   exclusions. Discovery does not authorize connection or ingestion.
4. Record the §5.1 answer in the private manifest. It determines the OAuth path.
5. Set the priority slice from §2.4.
6. Send the client the effort table from §7 as a standalone one-pager, so their
   commitments are in writing and separate from the questionnaire. Offer Golden
   20 later only if the owner wants an optional private regression suite.

## What to listen for beyond the answers

**"It's all in my head."** The material may not be written down anywhere, and
the Brain can read only what exists in an approved source or what the owner
separately asks it to remember. Say so during intake, not at kickoff. It is not
a reason to decline, but it changes what you promise.

**Hesitation on §3.** Someone who cannot name an exclusion may not have thought
about what is in their files. Prompt gently with categories such as personal,
HR, legal, health, or another person's confidential material. Unknown stays
visible.

**Someone else controls the accounts (§5.3).** An outsourced IT provider or
agency becomes a dependency you do not control. Get that person into the plan
or scope the access work separately. Do not contact them without owner approval.

**They cannot answer §9.2.** If the owner cannot yet define what "worth it"
looks like, return to the opening goal. After the first source is ready, offer
one evidence-derived check they may use, reword, replace, or skip. Do not turn
that uncertainty into a required question-writing exercise.
