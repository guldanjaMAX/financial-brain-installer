# REVIEW-GAPS-PARTNER: independent review of the answer-first, side-note coverage rule

Scope: `git diff 99bf39be..0ecf2b00` on branch `claude/0419-gapsfix`, 99bf39be808e967e5e1335ba0fcce690d16f54cb to 0ecf2b007ee4d64da5c72c3cf824e460ec2f0a08 (32 files, 2,747 insertions, 187 deletions; commits fabec95 and 0ecf2b0, the round 6 review snapshot). Later fix rounds are not in this snapshot.

Method: Claude Code multi-agent review. One finder per focus area (money figures only from the bank ledger; no absence claim when a source is paused; side-note dates and time zones; the "refuse only on a catastrophic primary-source gap" rule itself and anything else in the diff), one adversarial verifier per finding that tried to refute it and re-rated severity, then a completeness critic whose findings were verified the same way. 34 agents, all offline: no network, no real Brain, no Cloudflare, no keys. Focused tests and small probes only, run from a read-only checkout; probe scripts stayed outside the repository.

Result: 25 confirmed findings (8 P1, 12 P2, 5 P3); 4 refuted. No P0. Severity below is the verifier's rating. P0 = a wrong money figure presented as fact, a fabricated "nothing recorded" or other absence claim, or data exposure; P1 = a misleading answer or side note an owner would act on wrongly, or a guard that can be bypassed; P2 = real but bounded; P3 = minor.

Shared root causes (the operator's grouping, judged from file:line and the fixes): #4, #10 and #19 all come from the side note not being shown by /app Ask or `brain ask`; #6 and #11 are the same email-family mapping at `worker/src/lib/retrieval-status.js:46`; #9 and #13 are the same bare-noun channel detection. So the 25 confirmed findings come down to about 21 distinct fixes. #19 is only partly shared: under 48 hours it has no side note at all.

Placeholder names: one probe used a made-up first and last name for a contact. This report uses the role name "Payer Taylor" (and "Taylor" for the card) instead. The behavior described is unchanged.

## The three focus questions, in short

1. **Money figures only from the bank ledger.** No path was found where a document figure replaces, or is mixed into, a recognized ledger answer. Every recognized ledger failure still hard-refuses, and ledger refusals return no results in both MCP renderers. The defects are around the ledger figure, not where it comes from:
   - A ledger window cut back to the covered days gives a bounded "No deposits", "No matching deposit" or "$0.00" answer marked complete, for a payment date or a day the feed never read (#1, #5). The base refused both cases.
   - Gaps in unrelated connectors (Zoom, a store feed) can put their date on a current ledger figure, or withhold it (#9, #13).
   - A balance can carry the wrong "As of" date (#12, #21).
   - QuickBooks money answers lost their stale-feed warning on the owner's own surfaces (#19).
2. **No "nothing recorded" when a source is paused.** Not met in several places:
   - Raw search drops the provisional status whenever any row comes back, so a never-synced, unswept or paused source reads as "fine", and `brain check` can report a review complete and open its `--set` gate (#2).
   - Local `brain_search`: the "As of" note replaces the empty-page guard, so a filtered page of a search that found records reads as empty (#3).
   - The side note, which now carries the paused-source warning, is not shown in /app Ask or `brain ask` (#4, #10, #19).
   - Never-synced IMAP or Microsoft 365 mail is not primary for an email question, so it is classified "fine" with no note (#6, #11).
   - An unreadable source registry is classified "fine" (#17).
   - The reverse error also exists: sources with no refresh expectation (owner uploads, webhook-only Zoom) get a false "may be missing" note and forward-window refusals (#8).
3. **Side-note dates and time zones.**
   - Month to date counts the UTC date of the last bank sync as a fully covered day (#5, P1).
   - The balance "As of" prefix uses the live member's old sync date while the amount comes from a newer manual snapshot (#12).
   - UTC and owner-local days are mixed (#22). The day before a midnight DST change returns no day end, which drops freshness (#23). Side-note dates leave out the year (#24).
   - Two date findings were refuted: the 48-hour quiet period measured from now, and the manual plus live account window.

Outside the three focus areas: the exact contact-fact path now answers "previous number" or "did it change" questions with the current value and no model or verifier (#7, P1); its name match can drop leading name words (#18); refusals carry the wrong label or remedy, and /app Ask drops the reviewed next step from hard ledger refusals (#14, #20); any gap makes a future date window catastrophic (#15); one unregistered legacy row refuses a whole raw search (#16); and a new gate test fails on Windows checkouts with core.autocrlf=true (#25).

## Confirmed findings

### 1. [P1] A payment check on one date gives a bounded 'No deposits' answer when the asked date is past the ledger's covered-through day

- Area: ledger-only-money. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/ledger-answer.js:121`; verifier: worker/src/lib/ledger-answer.js:120-125 (ledgerCoveragePlan coverage check), with the answer text at worker/src/lib/ledger-answer.js:353-357. Root cause: the asked date is dropped at worker/src/lib/ledger-question.js:235-236.
- Inputs: Live checking ****4321 covered through 2026-10-11, last synced 2026-10-11T22:00Z, now 2026-10-17T20:00Z. The owner asks: "Did the $500 payment from Acme arrive on October 16, 2026?" classifyLedgerQuestion (ledger-question.js:235-236) builds a synthetic window of the date ±7 days, 2026-10-09..2026-10-23. ledgerCoveragePlan (ledger-answer.js:120-154) refuses only when boundedTo < intent.from, so it cuts the window down to 2026-10-09..2026-10-11 and answers.
- Wrong outcome: The answer is "No deposits at all in this period in account ****4321 between 2026-10-09 and 2026-10-11; the bank feed covers through account ****4321: 2026-10-11." (ledger-answer.js:355). It comes with evidence_gate {supported:true, complete:true} and ledger.found:false. Oct 16, the day the owner asked about, was never read. The only hint is side_note ("activity from Oct 12 through Oct 23 may be missing"), and /app and `brain ask` do not show it. brain-mcp labels this a complete ledger answer ("Preserve the ledger answer's exact amounts..."). The owner reads it as "the payment has not arrived". In the reverse case, an earlier matching deposit inside the covered days (for example a previous $500 on Oct 10) is reported as "Found a deposit...", which reads as "the Oct 16 payment arrived". The base commit refused this case (period_outside_coverage). The same thing happens for a date in the near future, e.g. "arrive on October 25" asked on Oct 23. No test covers a dated payment under partial coverage.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus1-money\probe-payment-date.mjs. On head, case 2 printed the 'No deposits at all in this period ... between 2026-10-09 and 2026-10-11' answer with complete:true and found:false. probe-payment-date-base.mjs on 99bf39be printed the document fallback for the same three inputs. The ±7 window comes from ledger-question.js:235-236: `from: dates.length ? shiftLedgerDay(dates[0], -7) ...`, `to: dates.length ? shiftLedgerDay(dates[0], 7) ...`.
- Fix: Have classifyLedgerQuestion keep the asked date on the payment intent (e.g. intent.anchor = dates[0]). In ledgerCoveragePlan, when intent.kind === 'payment' and intent.anchor is set, return a catastrophic gapFor('period_outside_coverage') if boundedTo < intent.anchor. Also, for any payment intent whose window was cut short (partial), do not return 'No matching deposit' or 'No deposits at all'. Return a bounded "can't confirm yet; the ledger covers through X and the payment window runs through Y" with complete:false. Add tests for the dated-payment partial cases above.
- Verifier's fix note:

1. In classifyLedgerQuestion (ledger-question.js:234-236), keep the asked date on the payment intent:
`anchor: dates.length ? dates[0] : null`
The from/to window stays as it is.

2. In ledgerCoveragePlan (ledger-answer.js, right after boundedTo is computed), add:
`if (intent.kind === "payment" && intent.anchor && (!coveredThrough || boundedTo < intent.anchor)) { const catastrophic = gapFor("period_outside_coverage", accounts, intent); return { intent, gaps: [catastrophic], catastrophic }; }`
This restores the base refusal whenever the asked day itself is not covered.

3. For any payment intent whose window was cut (partial = boundedTo < requestedTo) and that has no match, do not emit "No matching deposit" or "No deposits at all" with found:false/complete:true. In ledgerAnswer, pass a `truncatedTo` (or a `partial` flag) on the plan intent. When matched is empty, return text like "I can't confirm yet: the bank ledger covers through <boundedTo>, and this check runs through <requestedTo>." with ledger.found:null and complete:false. Then evidence_gate.complete is false and brain-mcp does not take the complete-ledger branch.

4. Add tests in worker/test/ledger-answer.test.mjs:
- asked date after covered_to refuses with ledger_out_of_coverage;
- asked date inside a cut window with no match gives found:null and complete:false;
- a fresh sync with covered_to = yesterday and today's date asked gives a refusal or found:null, never "No deposits".

Optionally, render side_note in /app (answer-render.js) and in `brain ask`, so partial-coverage notes reach all three surfaces.

- Verifier's reasoning:

I traced the full path in the head and reproduced it.

1. The classifier (worker/src/lib/ledger-question.js:235-236) is unchanged from base. For a dated payment question it builds a window of the asked date minus 7 days to plus 7 days. The asked date itself is not kept anywhere on the intent.

2. ledgerCoveragePlan (worker/src/lib/ledger-answer.js:108-154) cuts `to` back to the lowest account covered_to (boundedTo). It refuses only when boundedTo < intent.from or the cut window is not covered. A window of Oct 9 to Oct 23, covered through Oct 11, becomes Oct 9 to Oct 11. The plan returns catastrophic:null plus a partial ledger_coverage_stale gap.

3. classifyQuestionCoverage (retrieval-status.js:358-430) gets periodStart = intent.from = Oct 9. The last good sync (Oct 11 22:00Z) is after that, so the gap is not outsidePeriod and not catastrophic. It becomes a side_note only. answer_prefix stays null because the feed is under 14 days old.

4. ledgerAnswer runs on the cut intent. With no inflows it returns, at ledger-answer.js:355, the text "No deposits at all in this period ... between 2026-10-09 and 2026-10-11". withLedgerAnswer (ledger-answer.js:632-637) then sends evidence_gate {supported:true, complete:true} with ledger.found:false. index.js:1109 returns this response as is.

5. Surfaces:
- The /app page shows only answerText(r) = r.answer. frontend/src/lib/answer-render.js:67-85 has no side_note handling, and the frontend is not in this diff.
- `brain ask` (brain.mjs cmdAsk) prints only the answer, the trust line and the gate reason. It never prints side_note.
- brain-mcp.mjs:729-734 hits the complete-ledger branch ("Preserve the ledger answer's exact amounts..."). It does forward side_note at line 631.

The asked day (Oct 16) is never read. Base 99bf39be refused this case: effectivePeriodCovered(from, to=Oct 23) failed, giving period_outside_coverage and a gap.

My probe C:\offload\review-gaps-scratch\verify-payment-date\probe.mjs reproduced every case on the head:
- Case A (asked Oct 16, covered through Oct 11, now Oct 17): "No deposits at all in this period in account ****4321 between 2026-10-09 and 2026-10-11..." with complete:true and found:false.
- Case E (no amount given): the same result.
- Case D (feed synced today and fresh, covered_to = yesterday, owner names today's date explicitly): "No deposits at all ... between 2026-10-05 and 2026-10-11". The asked day was skipped even though the feed is not stale.
- Case B (an earlier ACME $500 on Oct 10): "Found a deposit of $500.00 posted 2026-10-10" with found:true. This is weaker because the posted date is printed, and the ±7 window already behaved this way under full coverage.

No test covers a dated payment under partial coverage. The only partial-window test is practical-gaps-0419.test.mjs:282, and it covers a "so far this year" totals question, where cutting the window is the intended behavior.

Two things make this less severe than the claim says:
- The answer text itself names the window it read ("between 2026-10-09 and 2026-10-11; the bank feed covers through ... 2026-10-11"). The side_note is not the only hint.
- The MCP path does relay the side_note.

So it is not a fabricated unbounded absence, which would be P0. It is still a bounded "no deposits" with complete:true and found:false for a window that excludes the exact date the owner asked about, and two of the three surfaces show no side note. An owner would read it as "the payment has not arrived". P1.

- Reproduction:

Run from C:\offload\review-gaps:
`node C:\offload\review-gaps-scratch\verify-payment-date\probe.mjs`

Setup: money-fix fixture, live account ****4321, covered 2026-08-01..2026-10-11, last_synced_at 2026-10-11T22:00Z, now 2026-10-17T20:00Z.

Question: "Did the $500 payment from Acme arrive on October 16, 2026?"

What the head returns:
- intent: payment, from 2026-10-09, to 2026-10-23.
- answer: "No deposits at all in this period in account ****4321 between 2026-10-09 and 2026-10-11; the bank feed covers through account ****4321: 2026-10-11."
- side_note: "Side note: bank ledger is covered through Oct 11, so activity from Oct 12 through Oct 23 may be missing."
- evidence_gate {supported:true, complete:true}, ledger {found:false, from:2026-10-09, to:2026-10-11}.

Case D: fresh sync 2026-10-12T18:00Z, covered_to 2026-10-11, now 2026-10-12T20:00Z, asked "...on October 12, 2026?". Result: "No deposits at all ... between 2026-10-05 and 2026-10-11", complete:true. The asked day was never read.

/app (answer-render.js answerText) and `brain ask` (brain.mjs cmdAsk) show only `answer`, never `side_note`.


### 2. [P1] Raw search drops the provisional status for any non-empty result. Unswept, never-synced, recently paused or unreadable coverage is labelled "fine" with no note and no side note.

- Area: paused-absence. Finder severity P1, verifier severity P1.
- Location: `worker/src/index.js:888`; verifier: worker/src/index.js:888 (the status gate). Consumers that read only `status`: operations/check-run.mjs:66 and frontend/src/components/Documents.tsx:251. Classifier: worker/src/lib/retrieval-status.js:395-410. Dead `primary_source` branch: retrieval-status.js:398.
- Inputs: Gmail source has a recent last_ingest_at (1 hour ago) but no complete sweep. This is the normal state during install-day backfill, and it lasts as long as one message stays refused. One Gmail row matches. The owner asks "Did Acme send the signed NDA?" through hosted MCP search, local brain_search, /app Documents, or brain check. The same outcome occurs when (a) Gmail never synced and the row comes from an upload, (b) the coverage read fails (coverage_unavailable), or (c) Gmail was paused for safety review 20 hours ago.
- Wrong outcome: /api/rag/unified returns coverage_classification "fine" with no status, no notice and no side_note. Hosted search returns rows with no note. Local brain_search returns no search_status and no note, and squeezes the never-synced Gmail gap into other_source_gaps as {source,type}. The model is cleared to say "I didn't find a signed NDA" with no provisional caveat. brain check counts the category as checked and prints "Record review complete: the category was checked. No disagreement appeared...", which also opens the `--set` gate (brain.mjs:5558) so owner-confirmed operative values can be written while a source is unswept.
- Finder's evidence: I ran probes against head and against a base 99bf39be export (scratch C:\offload\review-gaps-scratch\focus2\probe-search2.mjs and probe-variants.mjs). Base returns status "coverage_incomplete" with the notice "...treat this result as provisional while records may still be loading", and brain check says "Record review still waiting" with coverage.complete=false. Head returns {coverage_classification:"fine", results:1, gaps:[history_unproven]}, no note, and brain check coverage.complete=true. All four variants (never_synced, coverage_unavailable, sync_review 20h) follow the same base-vs-head pattern. Root cause: index.js:888 now sets COVERAGE_INCOMPLETE only when rows are empty or the result is catastrophic. classifyQuestionCoverage (retrieval-status.js:403-410) puts a gap in `notable` only when last_good is at least 48h old, so null or fresh gaps disappear from the classification. renderCoverageSideNote skips the same gaps (retrieval-status.js:333). coverage_unavailable can never be catastrophic or notable because no code sets `primary_source` (retrieval-status.js:398 is dead). The 48h rule also ignores cadence: an every-minute iMessage source broken for 30h counts as fine. history_unproven with a fresh last ingest is never outsidePeriod even for a 2023 question, because a recent partial ingest is compared against the period start.
- Fix: Have classifyQuestionCoverage return an `absence_unproven` flag. Set it whenever any coverage gap is not rendered into side_note: never_synced, source_unregistered, history_unproven, sync_in_progress, sync_review, sync_broken or coverage_unavailable, regardless of age. Never return COVERAGE_FINE while such a gap exists. In searchState (index.js:888), keep status COVERAGE_INCOMPLETE and its notice, with rows still attached, whenever that flag is set, so all four consumers and brain check stay provisional. Add side-note wording for those gap types, e.g. "<source>'s full history is still loading / has never synced, so records only in <source> may be missing". Restore the provisional expectation in worker/test/complete-sweep-clears-provisional.test.mjs.
- Verifier's fix note:

1. In `classifyQuestionCoverage`, return `absence_unproven: true` whenever any coverage gap ends up in neither the catastrophic nor the notable list. That covers fresh `history_unproven`, `sync_in_progress`, `sync_review` under 48h, non-primary `never_synced` or `source_unregistered`, and `coverage_unavailable`.

2. In `searchState` (index.js:888), when that flag is set, keep `status: COVERAGE_INCOMPLETE` with `coverageIncompleteNotice(coverage.unavailable, rows.length > 0)` and keep the rows attached. Do not return classification "fine" in this case; use a provisional value. Supported answers on /think can keep their answer-first behavior, but the raw route must not let a non-empty result count clear coverage.

3. In `operations/check-run.mjs` `gather`, also set `coverage_warning` when the filtered subject rows are empty and `body.gaps` holds any coverage gap. A row the subject filter removed must never count as a checked category.

4. Restore the provisional expectation for same-source evidence in `worker/test/complete-sweep-clears-provisional.test.mjs`. Add a subject-filtered check regression in which every Worker row is unrelated to the subject and the result must stay provisional.

5. Either set `primary_source` on the `coverage_unavailable` gap or delete the dead branch at retrieval-status.js:398.

- Verifier's reasoning:

Confirmed for the raw route and for brain check. The MCP part of the claim is overstated.

1. The root cause is as claimed. Base `searchState` returned `status: coverage_incomplete` plus its notice whenever any source coverage gap existed. Head index.js:888 does that only when `rows.length === 0 || coverageDecision.refuse`. `classifyQuestionCoverage` (retrieval-status.js:383-410) leaves a gap out of both the catastrophic and notable lists in three cases:
   - `history_unproven` with a non-null `last_ingest_at`
   - a non-primary `never_synced` gap
   - `coverage_unavailable`, because nothing in worker/src, components, operations or brain.mjs ever sets `primary_source`, so line 398 can never fire.

   Those gaps also stay out of the 48h side note, so the response is `coverage_classification: "fine"` with no status, notice or side_note.

   Probe: Gmail last ingest 1 hour ago, no complete sweep, one Gmail row "Acme NDA draft", question "Did Acme send the signed NDA?". The head output was exactly that shape (`verify-search-provisional/probe.mjs`). The empty-result control still returns `coverage_incomplete`. So the status now depends on the result count. The unchanged comment at index.js:861 says the route must stop consumers from inferring coverage from a result count.

2. MCP: overstated. The `gaps` array still goes through with its full detail ("A missing result may still be outside confirmed coverage"):
   - Hosted search passes `gaps` on.
   - Local brain_search keeps the full gap when the row comes from the same source. It shrinks the gap to `{source,type}` only when the gap's source returned no rows.
   - The healthy-search wording already limits any absence to "in these searches".

   Whether the model relays the gap is a runtime question, so this alone would be P2.

3. /app Documents (`Documents.tsx:251`) and brain check (`check-run.mjs:66`) are unchanged and look only at `status`. Neither renders `gaps` or `side_note`. Documents now shows the hits with no coverage notice at all.

4. brain check is the clearest owner-visible failure, and it is worse than the claim says. `cmdCheck` always passes `--subject`, and `gather` filters rows by subject after the Worker has already set the status from the unfiltered rows.

   Probe (`verify-search-provisional/probe-check2.mjs`):
   - Setup: Gmail backfill unfinished (`history_unproven`, ingested 1 hour ago), one unrelated newsletter that shares words with the probes, subject "Acme Holdings".
   - All 14 categories have 0 subject rows and no coverage warning.
   - `coverage = {completed:14, absence_unproven:0, complete:true}`.
   - The report prints "Record review complete: all 14 categories were checked." and "No disagreement appeared in the returned records for 5 automatically comparable categories."
   - Base would have marked all 14 provisional ("Record review still waiting").

   `complete:true` also opens the `--set` gate (brain.mjs:5558), whose own text says "Do not use --set until every category completes".

   The head test already asserts that categories with found evidence count as complete, so treating found evidence as complete was deliberate. Its own assertion (every non-provisional item has `rows.length > 0`) shows the authors did not intend this zero-row case. A second probe (`probe-check.mjs`) shows a category completing from an irrelevant FTS match ("state" from the stem of "stated") in the very source whose sweep was cleared. That is the same-source case the head test covers in its second loop, despite its "unrelated found evidence" title.

Severity: P1. The completeness guard on `--set` can be bypassed, and the owner is told the review is complete while a source's history is unproven and the subject has zero records. No money figure is involved.

- Reproduction:

Use the C:\offload\review-gaps head; scratch is C:\offload\review-gaps-scratch\verify-search-provisional\.

(1) `node C:\offload\review-gaps-scratch\verify-search-provisional\probe.mjs`
- Fixture source `mail` (kind gmail): `last_ingest_at` = now-1h, `last_complete_sweep_at` NULL, `expected_refresh_seconds` 86400. One chunk "Acme sent the NDA draft for review, unsigned."
- POST /api/rag/unified with q "Did Acme send the signed NDA?".
- Head output: `{coverage_classification:"fine", results:1, gaps:[history_unproven mail]}`, with no status, notice or side_note.
- Hosted MCP search returns the rows and gaps with no note.
- An empty-result control on the same brain returns `status:"coverage_incomplete"`.

(2) `node C:\offload\review-gaps-scratch\verify-search-provisional\probe-check2.mjs`
- Same unswept Gmail source, plus one unrelated "Weekly newsletter" chunk. Run `gather(search,{probes:PROBES,subject:"Acme Holdings"})`, then `renderReport`.
- Every category has `[name, 0 subject rows, provisional=false]`.
- Coverage is `{total:14, completed:14, absence_unproven:0, complete:true}`.
- The report prints "Record review complete: all 14 categories were checked." and "No disagreement appeared in the returned records for 5 automatically comparable categories."

(3) `node C:\offload\review-gaps-scratch\verify-search-provisional\probe-check.mjs "Acme Holdings"`
- On the existing complete-sweep fixture with the owner-notes sweep cleared, "Postal code" is counted as checked with 0 subject rows.
- The Worker returned the owner note only through an irrelevant stem match on "state".

`node --test worker/test/complete-sweep-clears-provisional.test.mjs` passes in head (2/2).


### 3. [P1] Local brain_search: the "As of" prefix note replaces the empty-page guard, so a filtered or over-offset page of a search that found records reads as an empty result.

- Area: paused-absence. Finder severity P1, verifier severity P1.
- Location: `components/brain-mcp.mjs:848`; verifier: components/brain-mcp.mjs:848-855 (note ternary for brain_search; answerPrefix branch shadows the excluded/empty-page branches)
- Inputs: Worker returns 3 Gmail rows with unreliable dates, coverage_classification "stale_but_covering" and answer_prefix "As of 2026-10-03," (Gmail stopped about 20 days ago). The model calls brain_search with reliable_dates_only:true, or with offset:10 to fetch the next page.
- Wrong outcome: The tool returns count 0, results [], note "As of 2026-10-03, Begin any supported answer with this exact prefix." plus the side note. The guard "The Brain found 3 records for this search, but reliable_dates_only excluded all of them... An empty page is NOT 'nothing recorded on this'" is dropped. This invites "As of Oct 3, I found no matching records" about records the Worker actually returned. It happens only when the primary source is stale, which is exactly when the guard matters most.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus2\probe-local-search.mjs ran the real local MCP with a fetch hook. Head output for both calls: {count:0, note:"As of 2026-10-03, Begin any supported answer with this exact prefix.", results:0}. The control without answer_prefix (probe-local-search-control.mjs) returns the excluded note for both calls. In the ternary chain, `answerPrefix ? {note} : excluded ? {note: excluded} : rows.length ? {} : {note: filteredEmptyNote}` lets answerPrefix win.
- Fix: Build the note by composition instead of a first-match ternary. Always include `excluded` when workerRows > 0 and rows are empty. Include filteredEmptyNote when the page is empty and nothing was excluded. Append the prefix instruction only when rows.length > 0, e.g. `[excluded, !rows.length && !excluded ? filteredEmptyNote(requestBody) : '', rows.length && answerPrefix ? `${answerPrefix} Begin any supported answer with this exact prefix.` : ''].filter(Boolean).join(' ')`.
- Verifier's fix note:

Put the empty-page guards ahead of the prefix in the ternary, and emit the prefix instruction only when the page has rows. Replace lines 848-855 with:
```
          : excluded
            ? { note: excluded }
          : rows.length
            ? (answerPrefix ? { note: `${answerPrefix} Begin any supported answer with this exact prefix.` } : {})
            : { note: filteredEmptyNote(requestBody) }),
```
side_note and answer_prefix stay as top-level fields either way.

Add a test in test/mcp-absence-honesty.test.mjs. Reuse the existing `stale` body with 3 date_reliable:false rows. Call brain_search with reliable_dates_only:true, and again with offset:10. Assert count 0, note matches /An empty page is NOT/, and note does not match /Begin any supported answer/.

- Verifier's reasoning:

I traced the full path and reproduced it with the real Worker classifier feeding the real local MCP.

1. Worker side (worker/src/index.js:866-899). searchState calls classifyQuestionCoverage (worker/src/lib/retrieval-status.js:357-429). Take a Gmail gap with last_good_sync_at 20 days ago. store-d1.js:3784-3800 attaches source_kind and last_good_sync_at as non-enumerable fields. Take Gmail rows. That combination is classified "stale_but_covering", with refuse false and answer_prefix "As of 2026-10-03,". The prefix is set because the primary source is more than 14 days stale. When rows > 0 and refuse is false, searchState returns no `status`. So the body carries coverage_classification, answer_prefix, side_note and gaps, but not coverage_incomplete.

2. Local MCP (components/brain-mcp.mjs:756-855).
   - coverageIncomplete is false, catastrophicCoverage is false, and unavailable is false because workerRows is non-empty.
   - publicAnswerPrefix accepts the prefix.
   - reliable_dates_only:true (line 764) empties windowRows when no row has a reliable date. offset >= windowRows.length (line 772) empties rows.
   - `excluded` is computed correctly at lines 785-792. But the note ternary checks `answerPrefix` (line 848) before `excluded` (line 850), so the excluded guard is never emitted. Before this diff, `excluded` was reached directly. The prefix branch is new in fabec95/0ecf2b0.

3. Existing tests do not cover this. test/mcp-absence-honesty.test.mjs:786-790 checks the excluded note only without a prefix. The stale-prefix test at :839-873 uses a single row with no filter or offset.

The probe output matches the claim. For the reliable_dates_only call the response is count 0, results [], newest_record null, empty facets, and note "As of 2026-10-03, Begin any supported answer with this exact prefix." plus the side note. Nothing in that response tells the model that 3 records were found. For the offset:10 call, the same note appears; only the facets and newest_record hint that records exist. The control body (same rows and gaps, no prefix) returns the "The Brain found 3 records ... An empty page is NOT 'nothing recorded on this'" note for both calls.

Severity: P1, not P0. The server-level instructions still push toward a search-scoped "I didn't find a matching record in this search" rather than "nothing recorded". So the likely owner-facing output is "As of Oct 3, I didn't find a matching record", which is a false scoped no-match about records the Worker actually returned. It is a bypass of an existing anti-absence guard. It needs the model's own filter or paging choice and a primary source stale for more than 14 days, which is exactly when the owner most needs the guard.

- Reproduction:

Probe: C:\offload\review-gaps-scratch\verify-paused-absence\probe.mjs (run with `node` from C:\offload\review-gaps).

1. It builds the Worker body with the real classifyQuestionCoverage. Inputs: a sync_broken gap on source "mail" (non-enumerable source_kind gmail, last_good_sync_at 20 days before 2026-10-23T18:00Z), 3 mail/gmail rows with date_reliable:false, and question "vendor signed NDA". Classifier output: classification stale_but_covering, refuse false, answer_prefix "As of 2026-10-03,", and the side_note.
2. It spawns components/brain-mcp.mjs with a fetch hook that returns that body.
3. Results:
   - brain_search {reliable_dates_only:true} gives count 0, newest_record null, empty facets, note "As of 2026-10-03, Begin any supported answer with this exact prefix."
   - brain_search {offset:10} gives count 0 and the same note.
   - Control (prefix removed, classification fine) returns "The Brain found 3 records for this search, but reliable_dates_only excluded all of them ... An empty page is NOT \"nothing recorded on this\"." and the matching offset text.


### 4. [P1] side_note is never shown in /app Ask or `brain ask`. A ledger window cut short (previously refused) now shows "$0.00. No matching transactions found." without the missing-days warning.

- Area: paused-absence. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/ledger-answer.js:154`; verifier: The side note is dropped in frontend/src/components/Ask.tsx:302 and :412, which render only answerText. It is also dropped in brain.mjs:4486, which calls renderAnswerText (worker/src/lib/answer-render.js:89, mirrored in frontend/src/lib/answer-render.js:67). The note is produced at worker/src/lib/ledger-answer.js:154 (the silent `to` shortening) and :633-634 (side_note kept outside answer). The document-path regression is at worker/src/index.js:1967-1969: source-coverage gaps were removed from the in-answer "Heads up" and are carried only in side_note (index.js:2080).
- Same root cause as: #10, #19 (side_note is not shown by /app Ask or `brain ask`).
- Inputs: Live checking account ****4321 is covered through 2026-10-20 and last synced Oct 20. Today is Oct 23. The owner asks "How much did I spend at Costco this month?" in the /app Ask page or with `brain ask`.
- Wrong outcome: ledgerCoveragePlan silently shortens the window to Oct 1-20, and the Worker puts "Side note: bank ledger is covered through Oct 20, so activity from Oct 21 through Oct 23 may be missing." only in the separate side_note field. Both first-party renderers print only answerText(body): "Total spend for costco: $0.00. No matching transactions found." The shortened end date appears only in a later line ("2026-10-01 through 2026-10-20"). An owner who spent at Costco on Oct 22 is told $0.00 for "this month". Before this branch the question fell back with ledger_out_of_coverage and no $0.00. The same drop hides every stale or paused side note on document answers in the app and CLI.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus2\probe-ledger-render.mjs: the worker answer and side_note come out as above, and both frontend/src/lib/answer-render.js answerText and worker/src/lib/answer-render.js answerText (used by brain.mjs:4486) return the text without the side note. grep finds no `side_note` anywhere in frontend/src, brain.mjs or either answer-render.js. The MCP paths (mcp-endpoint.js:333, brain-mcp.mjs:631) are the only consumers.
- Fix: Render side_note after the answer in frontend Ask.tsx (both answer panels) and in cmdAsk (brain.mjs:4486), for example by having both answerText helpers append `\n\n${r.side_note}` for supported answers. Also, when ledgerCoveragePlan shortens `to`, put the shortened-window sentence on the first line of the ledger answer itself ("Covered only through Oct 20; Oct 21-23 are not in the ledger yet.") so no renderer can drop it.
- Verifier's fix note: Change both answerText helpers (frontend/src/lib/answer-render.js and worker/src/lib/answer-render.js) so a supported answer that carries a non-empty side_note returns `${r.answer}\n\n${r.side_note}`. That one change covers Ask.tsx (both panels) and cmdAsk with no change to either caller. Add tests: an app test and a `brain ask` CLI test, each asserting that the side_note text appears in rendered output for a ledger answer and for a document answer. Also, when ledgerCoveragePlan shortens `to` (partial = boundedTo < requestedTo), put the cut-off in the ledger answer's first line. For example, prefix the answer in withLedgerAnswer with "Bank ledger covers only through Oct 20; Oct 21-Oct 23 are not included." Then a renderer that ignores side_note still cannot show a bare "$0.00. No matching transactions found." for the full requested period. Set evidence_gate.complete=false or partial=true in that case, so the app shows "What the records did not cover" instead of "read from covered ledger rows".
- Verifier's reasoning:

I traced the full path in the head and reproduced it with a probe. Both claims hold.

1) Producer. handleThink (worker/src/index.js:1109) sends every owner question from /app Ask and `brain ask` into withLedgerAnswer. The test was "How much did I spend at Costco this month?" with today Oct 23. classifyLedgerQuestion sets from=2026-10-01 and to=today. ledgerCoveragePlan (ledger-answer.js:119-154) then sets boundedTo = covered_to (2026-10-20) and adds a ledger_coverage_stale gap with missing_from and requested_through. The last sync was 3 days ago, so classifyQuestionCoverage does not refuse, and it sets no answer_prefix (that only happens past 14 days). It does render side_note. ledger-answer.js:633-634 keeps the answer text and puts side_note in a separate JSON field. evidence_gate comes back {supported:true, complete:true, reason:"read from covered ledger rows"}.

2) Before this branch. ledgerAnswer checked effectivePeriodCovered(a, from, to=Oct 23) against covered_to Oct 20 and returned period_outside_coverage. That was not on the hard-refusal list, so the question fell back to next(gap), the document path. The ledger never printed $0.00 for that window. The claim's "before" description is right.

3) Consumers. No file under frontend/src mentions side_note. The same goes for brain.mjs and both answer-render.js files (`git grep side_note` lists only the MCP code, the worker producers, templates and tests). Ask.tsx:302 and :412 render only answerText(answer), plus the evidence gate note, Trust, next action and citations. Neither gaps nor side_note is rendered. cmdAsk (brain.mjs:4486) prints renderAnswerText(body), which is worker/src/lib/answer-render.js:89. That function returns r.answer unchanged, and the gate reason is printed only for refused, partial or provisional answers. Only mcp-endpoint.js:333 and brain-mcp.mjs:631/798 pass side_note through.

4) Document path is also a regression. In the base, index.js appended every gap to money and observed document answers as "Heads up: ...", including source-coverage gaps (gaps.unshift(...sourceCoverageGaps) at base line 1230, appended at base line 1913). The head filters source-coverage gaps out of that Heads up (index.js:1967-1969) and moves them to side_note only (index.js:2080). The app and CLI do not show side_note, so they lose a paused or stale source warning they used to show.

Probe output, with the fixture from practical-gaps-0419 (live checking ****4321, covered 2026-01-01..2026-10-20, synced 2026-10-20T18:00Z, one unrelated Oct 5 grocery row). Document-path calls: 0. side_note = "Side note: bank ledger is covered through Oct 20, so activity from Oct 21 through Oct 23 may be missing." Both the frontend answerText and the worker answerText return exactly:
"Total spend for costco: $0.00. No matching transactions found.
Unsorted: $0.00 .
Accounts: account ****4321; 2026-10-01 through 2026-10-20; account ****4321: covered through 2026-10-20.
Possible transfers are included in income and spend; no rows were removed as transfers."
The app then adds "Why this answer was shown: read from covered ledger rows." With covered_to Oct 22 the result has the same shape, and the 1-day missing note is also dropped.

Severity. I keep P1, not P0. The $0.00 is true for the window the answer prints on its third line ("2026-10-01 through 2026-10-20"), so the absence claim is bounded, not fabricated. But the owner asked about "this month". The headline line is "$0.00. No matching transactions found." The app adds a completeness note ("read from covered ledger rows"), and evidence_gate.complete is true. The one sentence the new policy relies on, "Oct 21 through Oct 23 may be missing", reaches only MCP clients. An owner who bought at Costco on Oct 22 would reasonably act on "$0 this month". The same loss applies to longer gaps: the shipped test "a recent connector attempt cannot hide a partial ledger interval" answers "so far this year" only through Sep 30. Its "Oct 1 through Oct 23 may be missing" note is invisible in the app and CLI.

- Reproduction: Probe: C:\offload\review-gaps-scratch\verify-sidenote-render\probe.mjs (run with `node` from C:\offload\review-gaps). It imports worker/test/product-contract-fixture.mjs, withLedgerAnswer, frontend/src/lib/answer-render.js and worker/src/lib/answer-render.js. Date.now is mocked to 2026-10-23T18:00Z. Seeded state: one live confirmed checking account, mask 4321; coverage complete 2026-01-01..2026-10-20; bank_feed_items.last_synced_at 2026-10-20T18:00Z; one outflow on 2026-10-05, "Grocery Store". Call: withLedgerAnswer({question:"How much did I spend at Costco this month?", grantScope:{all:true}, scopePrincipalKind:"owner", sourceCoverage:{unavailable:false,gaps:[]}}). Observed: no document fallback; ledger.from/to = 2026-10-01/2026-10-20; side_note set; evidence_gate.complete true. Both answerText helpers return the text starting "Total spend for costco: $0.00. No matching transactions found." with no side note. In the base (99bf39be), ledgerAnswer's effectivePeriodCovered(from, Oct 23) check returned period_outside_coverage and the question went to the document path.

### 5. [P1] A month-to-date answer counts the UTC date of the last bank sync as a fully covered day, producing a $0.00 or 'No matching deposit' result for a day the feed never saw

- Area: dates-timezones. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/ledger-answer.js:149`; verifier: worker/src/lib/ledger-answer.js:120 (coveredThrough/boundedTo in ledgerCoveragePlan), with missing_from at :149. Root convention: worker/src/lib/plaid-bank-feed.js:1099 (covered_to = UTC date of the sync, unchanged by this branch).
- Inputs: BRAIN_TIMEZONE=America/Phoenix. The live feed's last good sync is Sept 30 at 20:30 local (2026-10-01T03:30Z). The Plaid writer stores covered_to as the UTC date of the sync (plaid-bank-feed.js:1099, `substr(?,1,10)`), so covered_to = 2026-10-01. The next sync is missed. On Oct 2 at 08:00 local (2026-10-02T15:00Z) the owner asks 'How much money came in this month?' or 'Did the payment of $500.00 arrive this month?'.
- Wrong outcome: The head answers 'account ****4321, 2026-10-01 through 2026-10-01: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)' and 'No matching deposit in account ****4321 between 2026-10-01 and 2026-10-01', with evidence_gate.complete=true. The side note says 'activity from Oct 2 through Oct 2 may be missing', which tells the owner Oct 1 is complete. But the feed last read the bank before the owner's Oct 1 began. A deposit that posted Oct 1 is reported as absent. When the feed is more than 14 days old, the same answer opens with 'As of 2026-09-30,', which contradicts its own '2026-10-01 through 2026-10-01'. The base refused this question (period_outside_coverage, answer null; I ran the base ledger-answer against the same fixture). Even for a UTC owner, the sync day was only partly observed (3.5 hours) and is still reported as covered.
- Finder's evidence: Probe: C:\offload\review-gaps-scratch\focus3-dates\probe-period2.mjs (head) and probe-period2-old.mjs (base ledger-answer, answer null). In ledgerCoveragePlan, boundedTo = min(covered_to) (ledger-answer.js:120-121), and the side note's boundary is missing_from = covered_to + 1 (line 149). The classifier gets periodStart: intent.from (line 621). It parses that date-only value as UTC midnight (retrieval-status.js safeInstant), which is 7 hours before Phoenix midnight. So the 'primary stopped before the period' check (`lastGood < periodStartMs`, retrieval-status.js:387-393) accepts a sync from the owner's previous evening. probe-period.mjs shows the >14-day variant with the 'As of 2026-09-30,' prefix.
- Fix: In ledgerCoveragePlan, treat the last sync day as partial. For live members, cap boundedTo at the day before the owner-local calendar date of last_synced_at (use coverageCalendarDate(lastSync, timeZone) shifted back one day), and set missing_from to the first day not fully observed instead of covered_to + 1. Pass the classifier an owner-local period start, meaning the instant of local midnight on intent.from in BRAIN_TIMEZONE (a coverageCalendarDayStart that mirrors coverageCalendarDayEnd), so a sync before the period's local start is a catastrophic stop, as in the base.
- Verifier's fix note:

In ledgerCoveragePlan, stop counting a live sync's own UTC day as fully observed. Replace line 120 with a per-account bound:
  const fullyObservedThrough = (account) => {
    const syncs = (account.members || [account]).filter(m => m.feed_mode === "live").map(m => instant(m.last_synced_at)).filter(v => v !== null);
    const capped = syncs.length ? shiftLedgerDay(ledgerDay(Math.min(...syncs)), -1) : null;
    const stored = /^\d{4}-\d{2}-\d{2}$/.test(account.covered_to || "") ? account.covered_to : null;
    return stored && capped && capped < stored ? capped : stored;
  };
  const coveredThrough = accounts.map(fullyObservedThrough).filter(Boolean).sort()[0] || null;

What this changes:
- boundedTo stops at the last fully observed day. missing_from (line 149) then names the sync day itself.
- When boundedTo falls before intent.from, the existing period_outside_coverage refusal fires, as in the base.
- The ">14 days" path can no longer combine an "As of <day before>" prefix with a body that covers the sync day.

Also pass the same capped value to ledgerAnswer, so its "covered through" account line and the payment "covers through" text agree with the bounded period. In the trial, the line still printed the raw covered_to.

Optional: to keep the base's non-partial behavior unchanged, apply the cap only when covered_to < intent.to. Applying it always also removes the pre-existing same-day overclaim.

Tests to add:
- Live sync 2026-10-01T03:30Z, covered_to 2026-10-01, now 2026-10-02T15:00Z, in both UTC and America/Phoenix: "this month" and "$500 payment this month" refuse with answer null.
- "last 7 days" is bounded to 2026-09-30 with "Oct 1 through Oct 2 may be missing".
- Update practical-gaps-0419.test.mjs:226 to accept ledger_out_of_coverage as the lead refusal gap.

The owner-local periodStart change the reviewer proposed is not needed for this defect. It would also mix owner-local time into the ledger's UTC question calendar.

- Verifier's reasoning:

I traced the full path in the head and reproduced it. The claim holds. I keep it at P1 rather than P0 because the same overclaim already exists in the base on its normal path. This branch did not create that problem. It spreads it to a common new path.

How it happens:
1. The Plaid writer (plaid-bank-feed.js:1099, unchanged by this branch) stores covered_to as the UTC date of the sync start (`substr(observedAt,1,10)`). ledger-reader.js:30 relies on the same convention (`substr(b.finished_at,1,10)=c.covered_to`). So a sync at 2026-10-01T03:30Z stores covered_to=2026-10-01. That sync saw at most 3.5 hours of that UTC day. For a Phoenix owner it saw none of their Oct 1, and none of a US bank's Oct 1 posting day either (03:30Z is 23:30 ET on Sept 30).
2. The new ledgerCoveragePlan (ledger-answer.js:120-121) sets boundedTo = min(covered_to) = 2026-10-01. effectivePeriodCovered passes. The partial gap gets missing_from = covered_to + 1 = Oct 2 (line 149).
3. The classifier gets periodStart = intent.from, a date-only value (line 621). safeInstant parses it as UTC midnight, so `lastGood < periodStartMs` (retrieval-status.js:395) is false. The question is not treated as catastrophic. The partial gap becomes a side note only.
4. ledgerAnswer runs over 2026-10-01..2026-10-01.

What the owner sees in the head (Phoenix, asked Oct 2 at 15:00Z):
- "credits $0.00; debits $0.00 (no posted income or expenses in the covered period)"
- "No matching deposit in account ****4321 between 2026-10-01 and 2026-10-01"
- evidence_gate.complete = true
- Side note: "bank ledger is covered through Oct 1, so activity from Oct 2 through Oct 2 may be missing"

The side note tells the owner Oct 1 is complete, but the feed never observed it. The base refused all of these questions with period_outside_coverage and answer null. I reproduced the base result from a git-archive copy of 99bf39be.

The same thing happens for a UTC owner: the feed stalls at 03:30Z Oct 1, the owner asks Oct 3, and the head answers for "Oct 1 through Oct 1" with $0.00 and "No matching deposit". Because covered_to is always the UTC day of the last sync, any stalled live feed leaves a partly observed last day. The head now presents that day as covered in every period-to-date question ("this month", "last 7 days", the current named month, payment checks).

The >14-day variant is also confirmed. Asked on Oct 20, the answer reads "As of 2026-09-30, account ****4321, 2026-10-01 through 2026-10-01: credits $0.00…". The prefix comes from coverageCalendarDate(last_synced_at, Phoenix) and contradicts the answer's own dates.

What I could not refute: no guard in the head stops this. The only check that could fire, outsidePeriod, compares against UTC midnight.

Why P1 and not P0:
- The base already counts the sync's own UTC day as fully covered on its normal path. With covered_to = 2026-10-02 from a sync at 2026-10-02T03:30Z, both base and head answer "Oct 1 through Oct 2" as complete with no note.
- The new wrong statement is limited to one edge day, which the answer names explicitly.

It is still a misleading absence answer and side note that an owner could act on, for example by deciding a payment never arrived.

On the reviewer's proposed fix: the owner-local periodStart change is not needed. The UTC-day cap described below fixes both the Phoenix and UTC variants. It also stays consistent with covered_to's own UTC convention and the ledger's UTC question calendar, which worker/test/ledger-answer.test.mjs pins ("all period shapes use an injected UTC calendar").

- Reproduction:

All probes are in C:\offload\review-gaps-scratch\verify-dates-coveredto\. They use the head's product-contract fixture and a real SQLite fixture. No network.

1. `node probe-base-vs-head.mjs` (head versus a base copy exported with git archive into .\base). Fixture: BRAIN_TIMEZONE=America/Phoenix; one live checking account ****4321; bank_feed_items.last_synced_at=2026-10-01T03:30:00.000Z; coverage complete 2026-08-01..2026-10-01; now=2026-10-02T15:00:00.000Z.
   - Head, "How much money came in this month?": "account ****4321, 2026-10-01 through 2026-10-01: credits $0.00; debits $0.00 (no posted income or expenses in the covered period)…", side_note "bank ledger is covered through Oct 1, so activity from Oct 2 through Oct 2 may be missing.", evidence_gate.complete=true.
   - Head, "Did the payment of $500.00 arrive this month?": "No matching deposit in account ****4321 between 2026-10-01 and 2026-10-01…", complete=true.
   - Base, both questions: answer null, gap ledger_out_of_coverage:period_outside_coverage.
   - Same split for "during October 2026" and "last 7 days" (head answers 2026-09-26..2026-10-01).
   - Normal-cadence control (sync 2026-10-02T03:30Z, covered_to 10-02): base and head both answer Oct 1..Oct 2 as complete. This is the pre-existing overclaim.
2. `node probe-more.mjs`:
   - Phoenix, now=2026-10-20: head answer starts "As of 2026-09-30, account ****4321, 2026-10-01 through 2026-10-01: credits $0.00…"; base refuses.
   - UTC owner, sync 2026-10-01T03:30Z, asked 2026-10-03: head gives the same "$0.00" and "No matching deposit … between 2026-10-01 and 2026-10-01" with side note "Oct 2 through Oct 3 may be missing"; base refuses.
3. Fix trial: `patch2.cjs` applies the cap below to a scratch copy (.\fix); `probe-fix.mjs` runs it.
   - Stalled cases now refuse with coverage_incomplete and answer null, as the base did.
   - "last 7 days" is bounded to 2026-09-26..2026-09-30 with "Oct 1 through Oct 2 may be missing".
   - The focused tests (ledger-answer.test.mjs and practical-gaps-0419.test.mjs) were run on the scratch copy. One real behavior change: practical-gaps-0419.test.mjs:226 now gets ledger_out_of_coverage as its lead gap where it expects ledger_coverage_stale. It is still a refusal. The other failures are mutation-marker string checks (markers not found), and most of them point at code the patch did not touch.


### 6. [P1] Email questions never treat IMAP or Microsoft 365 mailboxes as primary, so a mailbox that never synced is classified 'fine' with no note

- Area: refusal-rule. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/retrieval-status.js:46`; verifier: worker/src/lib/retrieval-status.js:46 (QUESTION_PRIMARY_SOURCES.email = {"gmail"}). The effect shows at worker/src/index.js:888, where coverage_incomplete is now set only when rows.length===0 or the decision is refuse.
- Same root cause as: #11 (email questions treat only Gmail as the primary mailbox).
- Inputs: The owner's only mailbox is registered as kind 'imap' (labelled 'email' in store-d1 HISTORICAL_SOURCE_LABELS) or 'microsoft'. It is expected hourly and has never completed a sync, so the gaps are never_synced and history_unproven. A healthy Drive source has one unrelated memo. The question is 'Did the accountant email me about the extension?' and goes to /api/rag/unified (the brain_search / remote search route).
- Wrong outcome: The response has results:1, coverage_classification 'fine', and no status, notice or side_note. The identical setup with kind 'gmail' returns status coverage_incomplete and classification 'catastrophic'. The built-in setup uses search first for non-money questions, so the model treats this as a healthy search and reports that it did not find an email. The owner concludes no email came, but the email source has never been read. Before this diff, any source gap made this search coverage_incomplete. Now the never-synced guard is bypassed for every non-Gmail mailbox. The same gap applies to documents (dropbox, microsoft, notion), meetings (microsoft calendar) and texts (imessage, whatsapp, slack), which map to no family.
- Finder's evidence: QUESTION_PRIMARY_SOURCES.email = new Set(["gmail"]) at retrieval-status.js:46. REFRESHABLE_SOURCE_KINDS in store-d1.js:3740 includes imap and microsoft. A never-synced non-primary gap has lastGood null, so it is neither catastrophic nor notable (retrieval-status.js:393-405) and renders no side note. index.js:888 now marks coverage_incomplete only when rows.length===0 or refuse. Probe C:\offload\review-gaps-scratch\focus4\probe-imap.mjs printed: imap -> {cls:'fine', no status}; microsoft -> {cls:'fine', no status}; gmail -> {status:'coverage_incomplete', cls:'catastrophic'}.
- Fix: Map primary families to every registry kind that serves them: email {gmail, imap, microsoft}, documents {drive, upload, dropbox, microsoft, notion}, meetings {zoom, calendar, microsoft}, and add a texts family {imessage, whatsapp, slack} triggered by text/message wording. Also make never_synced, source_unregistered and lastGood-null history_unproven gaps produce a side note, even when they are not primary, so they are never silently 'fine'.
- Verifier's fix note:

1. In QUESTION_PRIMARY_SOURCES, map each family to every registry kind that serves it:
   - email: {gmail, imap, microsoft}
   - documents: {drive, upload, dropbox, microsoft, notion}
   - meetings: {zoom, calendar, microsoft}
   - add a texts family {imessage, whatsapp, slack, iphone-backup}, matched on text/texted/message/iMessage/WhatsApp/Slack wording.
2. Make gapSourceKind's name fallback list include imap and microsoft too, for unregistered rows.
3. Because the family mapping depends on wording, add a guard that does not:
   - In classifyQuestionCoverage, put any non-primary never-complete gap in a separate bucket. That means never_synced, source_unregistered, or history_unproven with lastGood null.
   - In handleUnified (index.js:888), keep status coverage_incomplete (provisional, not a refusal) when that bucket is non-empty, instead of returning 'fine' with no status.
   - Alternatively, render a side note such as "<label> has not finished its first sync, so anything only in <label> may be missing", so a never-read source is never classified 'fine'.
4. Add tests:
   - imap or microsoft mailbox never synced, plus a Drive hit: expect not 'fine'.
   - Gmail never synced, with a query that leaves out channel words: expect status coverage_incomplete.

- Verifier's reasoning:

I traced the claim in the head and reproduced it. I tried to refute it and could not. One part of the claim overstates what the owner sees.

Code path:
1. The question wording ("...email me...") routes to the email family at retrieval-status.js:183. contactFieldIntent does not match it.
2. QUESTION_PRIMARY_SOURCES.email is only {"gmail"} (retrieval-status.js:46). So the primary kinds are just "gmail" plus the kinds of the evidence that came back ("drive").
3. The store sets source_kind from the registry kind (store-d1.js:3790), so gapSourceKind returns "imap" or "microsoft". The gap is therefore not primary.
4. The gap is history_unproven or never_synced with lastGood null. A non-primary gap like that is neither catastrophic (retrieval-status.js:399) nor notable (it needs lastGood not null). The result is classification 'fine' and no side_note.
5. handleUnified (index.js:888) now sets coverage_incomplete only when rows.length===0 or the decision is refuse. With one Drive row the search returns no status. Before this diff, any source gap gave coverage_incomplete.

The state is reachable on install day. `brain connect imap` registers kind "imap" with expected_refresh_seconds null before the first sync (brain.mjs:20582). IMAP and Microsoft connectors ship in connectors/. Gmail in the same state comes back catastrophic, so mail sources are treated inconsistently.

Where the claim overstates:
- It says the gap is silent. It is not. The worker still returns `gaps`.
- The remote MCP search passes the gaps through with full detail, including "A missing result cannot be treated as proof..." (mcp-endpoint.js runSearch).
- The local brain_search shrinks them to other_source_gaps [{source:"imap", type:"history_unproven"}] with no detail and no search_status. That happens because the gap's source is not among the returned rows (compactSearchGaps).
- brain_think is not affected. sourceCoverageBlocksAbsence (index.js:2000) still treats any coverage gap as incomplete when the answer is a refusal.

So this is not a fabricated "nothing recorded" (P0). But on the search-first route the response says coverage is 'fine' and carries no provisional status while the only mailbox has never been read. The model is told to treat that as a healthy search, so a search-scoped "no email found" reaches the owner as if it settled the question. That is a bypassed guard the owner could act on: P1.

Also worth knowing: even Gmail gets 'fine' when the search text leaves out channel words (for example "extension accountant"). The family mapping only protects queries that name the channel. That is why the second part of the fix, which does not depend on the family, matters.

- Reproduction:

Probes are in C:\offload\review-gaps-scratch\refute-imap-email\. Run them with cwd C:\offload\review-gaps:
- `node C:\offload\review-gaps-scratch\refute-imap-email\probe.mjs`
- `node C:\offload\review-gaps-scratch\refute-imap-email\probe-mcp.mjs`

Fixture: createProductFixture with Date.now set to 2026-10-23T18:00Z.
- Drive source: fresh and fully swept, holding one memo, "Memo: accountant extension filing checklist".
- Mailbox source: kind imap, microsoft or gmail. Variant A is never synced and expected hourly, which gives never_synced plus history_unproven. Variant B is exactly what `brain connect imap` registers (expected null, no ingest), which gives history_unproven only.

POST /api/rag/unified with q="Did the accountant email me about the extension?":
- imap: results=1, status=null, coverage_classification='fine', side_note=null, gaps=[never_synced, history_unproven]
- microsoft: same as imap
- gmail: status='coverage_incomplete', classification='catastrophic'

Through the remote MCP handleMcp search:
- imap: the memo is returned, with coverage_classification 'fine', no note, and the gap detail attached.
- gmail: results [] and the refusal note.

With q="extension accountant", gmail also comes back 'fine' with no status.


### 7. [P1] The exact contact-fact path now answers questions that are not lookups (who / did / previous / old) with the current field value, with no model or verifier

- Area: completeness. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/entity-fact-answer.js:36`; verifier: worker/src/lib/entity-fact-answer.js:35-36 (questionFacts trusts contactFieldIntent). Root grammar at worker/src/lib/retrieval-status.js:70-72. Coverage email suppression at worker/src/lib/retrieval-status.js:180 and 191. Reached from worker/src/index.js:1459.
- Inputs: A contact card record ('Name: Example Contact / address / email / phone ...'), native text, reliably dated within 30 days, which is the only related row. BRAIN_OWNER set to that card's name for the owner-form questions. Questions: 'What was the previous phone number for Example Contact?', 'Who changed the address for Example Contact?', 'Which vendors still have the old address for Example Contact?', 'Did the bank change my address?', 'Did anyone reply to my email?'.
- Wrong outcome: Every one of these takes evidence_gate.method 'exact_contact_fact' with 0 model calls and returns a supported answer of the form 'As of 2026-10-06, the record lists Example Contact's phone as +1 (202) 555-0123. [1]'. An owner asking for the previous number gets the current number as a supported answer. An owner asking 'Did the bank change my address?' gets the address on file, which reads as 'no, it is still X'. At base 99bf39be, all five questions went through the normal draft-and-verifier path (method null, 2 model calls). The same intent parser also feeds coverage routing (retrieval-status.js coverageQuestionSources), so 'Did anyone reply to my email?' counts as a contact lookup and Gmail is not treated as primary for it.
- Finder's evidence: In base, questionFact used anchored grammars: POSSESSIVE/SUBJECT/OWNER_QUESTION = /^what(?: is|'s) .../. The head's questionFacts (entity-fact-answer.js:35-44) calls contactFieldIntent (retrieval-status.js:91). Its CONTACT_FIELD_LOOKUPS (retrieval-status.js:70-72) are unanchored at the start: '(?:^|\s)(my|our)\s+(field)$' and '(?:^|\s)(?:the\s+)?(field)\s+(?:of|for)\s+SUBJECT$'. So any question that ends in '<field> for X' or 'my <field>' matches. QUALIFIED_FACT is checked only against the row title and the value, never the question. Probe C:\offload\review-gaps-scratch\critic\probe-contact-route.mjs (generated by build-probe.cjs from the real /api/rag/think harness in entity-fact-answer.test.mjs) runs the real route against the head and the base export. Head: all 6 cases give method exact_contact_fact with model_calls 0. Base: only the 'What is ...' control does; the other 5 give method null with model_calls 2. The test 'the closed-prefix contact intent mutant is killed' (practical-gaps-0419.test.mjs:630) deliberately pins the open prefix, so no test covers non-lookup shapes.
- Fix: Keep the broad contactFieldIntent for coverage routing only. Give entityFactAnswer its own closed, start-anchored lookup grammar: 'what is|what's|find|look up|give me|show me|I need|please give me' + optional 'the/current' + field + 'of|for' + subject, plus the possessive and 'my <field>' forms with the same leads. Decline the exact path, falling back to the model and verifier, when the question has interrogatives or qualifiers outside that lead (who, when, why, which, did, does, has, still, previous, prior, old, former, original, changed, change, update, verify). In coverageQuestionSources, do not let a non-lookup match suppress the email channel. Add route tests for the five questions above.
- Verifier's fix note:

1. Exact path (entity-fact-answer.js). Keep contactFieldIntent broad for coverage routing, but give questionFacts its own closed grammar.
- Normalize the question: NFKC, curly apostrophes to straight ones, collapsed whitespace, trimmed.
- Strip one optional lead: `^(?:please\s+)?(?:what\s+(?:is|are)|what's|find|look\s+up|give\s+me|show\s+me|tell\s+me|i\s+need)\s+`.
- Require the WHOLE remainder to match one of three anchored forms:
  - `^(?:the\s+)?(?:current\s+)?(FIELD)\s+(?:of|for)\s+(SUBJECT)[.?!]*$`
  - `^(?:my|our)\s+(?:current\s+)?(FIELD)[.?!]*$`
  - `^(SUBJECT)'s?\s+(?:current\s+)?(FIELD)[.?!]*$`, with the subject taken whole. No dropping of leading words.
- If nothing matches, return [] so the question falls back to the model and verifier.
- Belt and braces: also return [] when the question matches `\b(?:was|were|did|does|do|has|have|had|who|whom|whose|when|why|which|how|still|previous|prior|old|former|original|earlier|past|before|changed?|updated?|moved|new|verify|correct|wrong|repl(?:y|ied)|respond(?:ed)?|sent|received)\b`.
- This keeps every positive case in the current test list passing: What is / What's / Find / Look up / Please give me / I need / Give me X's / Find X's / What are the email addresses for X / "Example Contact's email?".

2. Coverage routing (retrieval-status.js:180). Only suppress the email channel for a field lookup that carries no message verbs: `const contactFieldLookup = contactFieldIntent(q) !== null && !/\b(?:repl(?:y|ied|ies)|respond(?:ed)?|responses?|answered|sent|send|received|forward(?:ed)?|wrote|cc|bcc)\b/.test(q);`. "Did anyone reply to my email?" then makes Gmail primary again. "Find the email address for Example Contact." stays fine, so the closed-prefix mutant test still passes.

3. Tests.
- Add to fallbackCases in worker/test/entity-fact-answer.test.mjs, each asserting the method is not exact_contact_fact and answer + verifier calls equal 2: "What was the previous phone number for Example Contact?", "What was Example Contact's phone number?", "Who changed the address for Example Contact?", "Which vendors still have the old address for Example Contact?", "Did the bank change my address?", "Did anyone reply to my email?".
- Add a route case with a second, older row that holds the previous number, so the question cannot be answered with the card's current value.
- Add a classifier test: never_synced Gmail plus "Did anyone reply to my email?" puts gmail in primary_sources and is classified catastrophic.

- Verifier's reasoning:

I traced the path in the head and reproduced it through the real /api/rag/think route.

1. index.js:1459 calls entityFactAnswer for any question that is not money, tax, a binding-agreement question or a high-risk fact. Nothing earlier in the route looks at the question's tense or wording.
2. entity-fact-answer.js:35-36: questionFacts now takes its field and subject only from contactFieldIntent (retrieval-status.js:91). The lookup patterns at retrieval-status.js:70-72 are not anchored at the start. They begin with `(?:^|\s)`, and the possessive form has no lead at all. So a question that merely ENDS in "<field> for <Subject>", "my <field>" or "<Subject>'s <field>" counts as a lookup. Whatever comes before it is thrown away: previous, old, former, who, did, which, still, was.
3. The guards that come after only check the record, never the question. QUALIFIED_FACT is tested against the row title and the value. safeSubject is tested against the subject. resultNamesSubject only counts rows whose client is the subject or that carry a "Name:" style card label. The newestCurrentEvidence test deliberately rewrites the question as "What is X's current <field>?", so it cannot catch a historical question either.
4. The base (99bf39be) used three patterns anchored with `^what(?: is|'s)`, so all of these questions went to the model and the verifier.

Reproduction. I copied the reviewer's probe, which is built from the real test harness in entity-fact-answer.test.mjs, and ran it against the head checkout and a `git archive` of the base.
- Head: all 6 questions return method exact_contact_fact, supported, with 0 model calls. For example, "What was the previous phone number for Example Contact?" returns "As of 2026-10-06, the record lists Example Contact's phone as +1 (202) 555-0123. [1]". "Did the bank change my address?" and "Did anyone reply to my email?" return the owner's address and email on file.
- Base: only the "What is ..." control takes the exact path. The other 5 give method null with 2 model calls.

I added a stronger case of my own. A second retrieved Gmail row, dated 2026-09-28 with no client field, says "my previous phone number was +1 (202) 555-0199". The head still answers "What was the previous phone number / old phone number for Example Contact?", "Give me the former phone number for Example Contact." and "What was Example Contact's phone number?" with the CURRENT number. Each answer is supported, uses 0 model calls and has no side note. That gmail row does not count as related, so the record that actually answers the question is never used. The base sent all four to the model with both documents.

This also defeats the authors' own intent. fallbackCases lists "historical question" (What was Example Contact's address in 2024?) as a case that must fall back, but the "for X" and "What was X's" shapes skip that check.

Coverage side, confirmed with a direct classifyQuestionCoverage probe. Setup: Gmail never synced, upload evidence. "Did anyone reply to my email?" is classified fine, with primary sources [upload] and no side note. "Did anyone reply to my message?" is classified catastrophic with Gmail as primary. The impact is limited, because with zero results the route still returns coverage_incomplete (index.js:888) and the gaps reach the model. But the reply question loses its Gmail-primary refusal.

Severity. P1, not P0. The fields are contact fields only, the sentence is true about the record and carries its date, and no money figure or absence claim is involved. But it is a supported, cited answer that gives the current value when the owner asked for the previous one. Two examples of acting on it wrongly: telling a vendor to drop the "old" number and giving them the current one, or reading "Did the bank change my address?" as "no". It also skips the verifier the base applied to every one of these questions.

- Reproduction:

Scratch dir C:\offload\review-gaps-scratch\verify-contact-intent\.
- probe.mjs is a copy of the reviewer's route probe. `node probe.mjs C:/offload/review-gaps` gives method exact_contact_fact and model_calls 0 for all six questions. `node probe.mjs C:/offload/review-gaps-scratch/verify-contact-intent/base` runs against a `git archive 99bf39be worker` export; only the control takes the exact path and the other five give method null with model_calls 2.
- probe2.mjs adds a gmail row (client null, dated 2026-09-28) whose text holds a previous number of +1 (202) 555-0199, and sends limit 5. Head: "What was the previous phone number for Example Contact?", "What was the old phone number for Example Contact?", "Give me the former phone number for Example Contact." and "What was Example Contact's phone number?" each return "As of 2026-10-06, the record lists Example Contact's phone as +1 (202) 555-0123. [1]", supported true, model_calls 0, results 2. Base: all four give method null with model_calls 2.
- cov.mjs: with a never_synced Gmail gap and evidence ["upload"], "Did anyone reply to my email?" is classified fine with primary sources [upload] and no side note. "Did anyone reply to my message?" is classified catastrophic with primary sources [upload, gmail].


### 8. [P1] Sources with no refresh expectation (owner app uploads, webhook-only Zoom) get a false 'has not refreshed... may be missing' side note on every answer, an 'As of' opening, and forward-window refusals

- Area: completeness. Finder severity P1, verifier severity P1.
- Location: `worker/src/lib/retrieval-status.js:404`; verifier: worker/src/lib/retrieval-status.js:395 (outsidePeriod), :404-408 (notable and answer_prefix), :335 (side-note wording). Gap source: worker/src/lib/store-d1.js:4101-4122 (unscheduled history_unproven) with :3796 (non-enumerable last_good_sync_at). Row writers: worker/src/lib/owner-actions.js:1176-1181 and worker/src/lib/zoom.js:431.
- Inputs: A normal install where the owner uploads files through the app. owner-actions.js:1176-1181 writes sources('upload', kind upload, last_ingest_at = upload time) with no expected_refresh_seconds and no last_complete_sweep_at. The last upload was 20 days ago (a Zoom webhook-only source behaves the same: zoom.js:431 never writes a sweep). Questions: 'How much money came in October 2026?' (bank ledger), 'What does the office lease say about renewal?' (answered from an uploaded file), and 'What payments does the lease require next month?'.
- Wrong outcome: Side note on the bank ledger answer, and on every other answer: 'Side note: upload has not refreshed since Sat Oct 3, so anything only in upload after that date may be missing.' (and 'zoom has not refreshed since Sun Oct 18 ...' when there were simply no meetings). Nothing can be missing from an owner-initiated upload source, because any new upload advances last_ingest_at. Answers citing an uploaded document get the opening 'As of 2026-10-03,' (the last upload date) even though nothing is stale. The forward-window question answered from the uploaded lease is classified catastrophic and refused as 'the question's primary source does not cover the requested period'. Owners are told a source is broken when it is not, and every answer they read carries a false 'may be missing' warning.
- Finder's evidence: store-d1.js:4101-4122 emits history_unproven for an unscheduled source with no sweep, and its comment says 'no refresh expectation, so no staleness claim made'. The gap detail reads 'declared history is not yet proven complete', which is about completeness, not freshness. classifyQuestionCoverage (retrieval-status.js:395-409) ignores the gap type: any gap with lastGood older than 48h is pushed to `notable`, gets a prefix when older than 14 days and primary, and is outsidePeriod when lastGood < periodStart. renderCoverageSideNote then prints 'has not refreshed since'. Probe C:\offload\review-gaps-scratch\critic\probe-noschedule.mjs feeds the real store coverageGaps() the exact upload row shape. Output: ledger answer → stale_but_covering with the upload and Zoom side note. Upload-cited answer → answer_prefix 'As of 2026-10-03,' and the same note. Upload-cited answer with a Nov 1 window → catastrophic, refuse:true. Before this diff the same gap only blocked absence claims.
- Fix: In classifyQuestionCoverage, use lastGood as freshness evidence only for freshness gap types (coverage_stale, sync_broken, sync_review, sync_in_progress, never_synced, refresh_unscheduled, ledger_coverage_stale). Alternatively, have the store mark unscheduled history_unproven gaps (non-enumerable expected_refresh_seconds:null) and skip them for notable, answer_prefix and outsidePeriod. Keep history_unproven only as an absence blocker, with no 'has not refreshed' wording. Add tests for the upload and Zoom webhook source rows.
- Verifier's fix note:

In classifyQuestionCoverage, treat a gap's last good sync as freshness evidence only for freshness gap types. history_unproven is a completeness gap. It should keep blocking absence claims, and a history_unproven with no last good sync should stay catastrophic for a primary source, through the existing neverComplete branch. Minimal change at retrieval-status.js:395 and :404:

  const freshnessGap = gap.type !== "history_unproven";
  const outsidePeriod = freshnessGap && periodStartMs !== null && (lastGood === null || lastGood < periodStartMs);
  ...
  if (partialLedger || (freshnessGap && lastGood !== null && nowMs - lastGood >= 2 * DAY_MS)) {

An equivalent option is an explicit FRESHNESS_GAP_TYPES set (coverage_stale, sync_broken, sync_review, sync_in_progress, refresh_unscheduled, ledger_coverage_stale), used for both checks. For a belt-and-braces guard, also skip history_unproven in renderCoverageSideNote, so it can never print "has not refreshed".

Tests to add in worker/test/practical-gaps-0419.test.mjs, using the exact owner-app upload row (no expected_refresh_seconds, no last_complete_sweep_at, last_ingest_at 20 days ago) and a webhook-only Zoom row:
(a) A bank-ledger answer through /api/rag/think has no side_note.
(b) An upload-cited think answer has no "As of" prefix.
(c) With an explicit from after the last upload and an uploaded document dated inside the window, the answer is not refused.
(d) Controls: a scheduled coverage_stale Gmail source still gets its side note, and a never-completed primary source still refuses.

- Verifier's reasoning:

I tried to refute this and could not. I traced it through the real routes, not only the classifier.

1. The source rows are written as the claim says. owner-actions.js:1176-1181 writes ('upload','upload','ready', last_ingest_at = upload time) with no expected_refresh_seconds and no last_complete_sweep_at. Nothing else in worker/src or migrations/d1 ever sets a sweep or a schedule for the source named 'upload'. Zoom's recordZoomSourceReceipt (zoom.js:422-441) is called only when a recording is processed (zoom.js:522), so last_ingest_at stops moving during a week with no meetings. Its own comment warns that a refresh expectation "would make a quiet week look like a broken connector".

2. The store treats these as completeness gaps only. assessCoverageRows (store-d1.js:4101-4122) emits history_unproven for these rows and makes no staleness claim ("no refresh expectation, so no staleness claim made"). The new withCoverageGapContext (store-d1.js:3796) attaches a non-enumerable last_good_sync_at = last_ingest_at to that gap.

3. The new classifier ignores the gap type and reads that value as freshness, in classifyQuestionCoverage (retrieval-status.js:395-409):
   - Line 404: any gap whose last good sync is 48 or more hours old goes into `notable`.
   - Lines 406-408: if the source is primary and the age is over 14 days, the answer gets an "As of <date>," prefix.
   - Line 395: if the last good sync is before the requested period start, the gap is outsidePeriod, which makes it catastrophic for a primary source.
   - renderCoverageSideNote (line 335) then prints "has not refreshed since".

4. Nothing filters these gaps out before they reach the owner:
   - ledger-answer.js:617 passes every source coverage gap into the ledger decision and returns side_note (line 629).
   - index.js:864-898 does the same for search, and index.js:1930-1949 and 2080 for think.
   - mcp-endpoint.js:62 and :333, and brain-mcp.mjs:234 and :1028, tell the host to relay side_note word for word.

5. I reproduced it end to end with the product fixture (in-memory SQLite, real Worker routes, real coverage read):
   - **Bank ledger answer:** POST /api/rag/think "How much money came in October 2026?" with the owner-app upload row 20 days old and Zoom 5 days old. The answer is correct ($120.01). It carries "Side note: upload has not refreshed since Sat Oct 3, so anything only in upload after that date may be missing. zoom has not refreshed since Sun Oct 18, ...". The control without those rows has no side note.
   - **Search:** /api/rag/unified on an uploaded lease returns answer_prefix "As of 2026-10-03," and the same side note.
   - **Think on an upload-cited document:** the answer text becomes "As of 2026-10-03, The lease lets ..." with the side note. A control row that is identical except for last_complete_sweep_at gives "fine", with no prefix and no note.
   - **Explicit from:** with from=2026-11-01 and an uploaded document dated Nov 5, think withholds a supported answer with "the question's primary source does not cover the requested period" (catastrophic). The "next month" wording did not create a window, because money wording skips it. So the refusal needs an explicit from plus a document dated after its upload. That part is narrower.

6. No existing test covers this row shape. The upload route test seeds expected_refresh_seconds=86400 with a sweep. The entity-fact test ("a pause under 48 hours stays quiet") only covers a recent last_ingest_at. Before this diff the gap only blocked absence claims.

7. Severity: P1. No money figure is wrong and no absence is invented. But this misleading note appears on effectively every answer, bank-ledger money answers included, on any install that uses app uploads or webhook Zoom, from 48 hours after the last upload or meeting. It tells the owner that data "may be missing" and that a source has stopped refreshing when nothing can be missing. The owner may doubt a correct figure or try to fix a source that is working. It also dates current documents with a false "As of", and the window refusal withholds supported answers.

8. The proposed fix works. I applied it to a scratch copy: the upload and Zoom notes are gone, a really stale Gmail source (coverage_stale) is still noted, and a never-completed source is still catastrophic.

- Reproduction:

All in C:\offload\review-gaps-scratch\refute-noschedule\. Run from C:\offload\review-gaps.
1. `node --test C:\offload\review-gaps-scratch\refute-noschedule\e2e.test.mjs` uses the real Worker routes and createProductFixture, with the upload row inserted exactly as owner-actions.js:1176-1181 writes it.
   - "UPLOAD ledger": the answer is $120.01, side_note is "Side note: upload has not refreshed since Sat Oct 3, so anything only in upload after that date may be missing. zoom has not refreshed since Sun Oct 18, ...", and the gaps are history_unproven:upload and history_unproven:zoom.
   - "CONTROL ledger": no side_note.
   - "DOC unified": answer_prefix "As of 2026-10-03," plus the same note.
2. `node --test C:\offload\review-gaps-scratch\refute-noschedule\e2e-think.test.mjs` runs think with an approving verifier mock.
   - Owner-app row: the answer is "As of 2026-10-03, The lease lets the tenant renew ... [1]." with the side note.
   - Swept control (same row plus last_complete_sweep_at): "fine", no prefix, no note.
3. `node --test --test-name-pattern="^W " C:\offload\review-gaps-scratch\refute-noschedule\e2e-window.test.mjs`. In "W owner-app row: walkthrough with explicit from" (from=2026-11-01, uploaded document dated 2026-11-05), the answer is null, the classification is catastrophic, and evidence_gate.reason is "the question's primary source does not cover the requested period".
4. `node C:\offload\review-gaps-scratch\refute-noschedule\fixcheck.mjs` applies the fix to an in-memory copy. The upload and Zoom notes, the prefix and the refusal are gone. The stale-Gmail note and the never-completed-Drive refusal are kept.


### 9. [P2] Ledger answers treat merchant words and unrelated connector kinds as primary sources, so a paused Zoom, store or Plaid-kind connector misdates or blocks a current bank figure

- Area: ledger-only-money. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/ledger-answer.js:618`; verifier: worker/src/lib/ledger-answer.js:618-628 (the raw question goes to classifyQuestionCoverage; a refusal on any primary gap at 627-628); root cause in worker/src/lib/retrieval-status.js:194-197 (merchant words read as channels, explicit money type dropped) and :375-376 (channel sources added to primary); mislabel in worker/src/lib/ledger-answer.js:175-199 (lines 188-189 and 194-197 return 'fine' plus the document next action when the gap has no ledger reason)
- Same root cause as: #13 (bare nouns and merchant words make unrelated connectors primary).
- Inputs: Live ledger ****4321 covered through 2026-10-23 and synced today, with a $15.99 Zoom charge on 2026-10-05. sourceCoverage carries a Zoom meetings connector gap {type: sync_review, source_kind: zoom, last_good_sync_at: 2026-10-03}. Question: "How much did I spend at Zoom this month?" withLedgerAnswer passes the raw question to classifyQuestionCoverage. There, retrieval-status.js:194 (/\b(?:zoom|calendar)\b/) and :195 (store|shop|orders|products...) treat merchant words as channels, and :375-376 add those channels to the primary sources. QUESTION_PRIMARY_SOURCES.money (:45) also makes any registered plaid/stripe/square/payment/bank source primary for every ledger answer.
- Wrong outcome: With the Zoom connector last good on Oct 3, the answer is "As of 2026-10-03, Total spend for zoom: $15.99." The ledger figure carries a meeting connector's date even though the ledger covers through Oct 23. Without the gap the same answer has no prefix. With last good on Sep 25 the covered ledger answer is withheld: answer null, status answer_withheld, coverage_classification "fine", notice "The Zoom source is paused for safety review.", next_action "Next: ask about one record at a time, naming its title or date." hardLedgerRefusal (ledger-answer.js:175-199) labels any gap without a ledger reason as non-catastrophic and fine. brain-mcp then tells the model "This is a ledger refusal, not a source-coverage outage." "The Coffee Shop" with a stale custom-api store feed behaves the same way.
- Finder's evidence: Probes C:\offload\review-gaps-scratch\focus1-money\probe-zoom-merchant.mjs, probe-store-merchant.mjs and probe-refusal-label.mjs. The refusal-label probe also shows a retired Stripe-kind source last read in June blocking "How much money came in this month?" with status answer_withheld and classification fine. The ledger figure itself is correct and its "Accounts: ... covered through 2026-10-23" line contradicts the prefix.
- Fix: In withLedgerAnswer, make the refusal and answer_prefix decisions only from ledger gaps (plan.gaps, or gaps whose source_kind is 'ledger'). One way: add a primarySources override to classifyQuestionCoverage and pass ['ledger'] from the ledger path. Keep other sources' gaps for side-note clauses only. In hardLedgerRefusal, accept only gaps that have a LEDGER_REFUSAL_POLICIES reason, or set coverage_classification 'catastrophic' and a matching next action for classifier-made coverage refusals. Do not emit 'fine' with a document-path next action.
- Verifier's fix note:

1. In retrieval-status.js, add an optional `primarySources` argument to classifyQuestionCoverage. When it is given, set primarySourceKinds = new Set(primarySources.map(normalizedSource)) and skip coverageQuestionSources channel parsing for the primary set.
2. In withLedgerAnswer (ledger-answer.js:618), pass primarySources: ['ledger']. Ledger figures are read only from the bank ledger, and plan.gaps carry source_kind 'ledger'. Connector gaps (Zoom, calendar, custom_api, Gmail and the rest) can then only add side-note clauses. They can no longer set answer_prefix or a refusal.
3. In hardLedgerRefusal, when the gap has no LEDGER_REFUSAL_POLICIES reason (the coverage classifier made the refusal, for example a ledger_coverage_stale gap whose last good sync predates the period), return status COVERAGE_INCOMPLETE and coverage_classification COVERAGE_CATASTROPHIC. Use the period_outside_coverage next action, or refusalNextAction({status: COVERAGE_INCOMPLETE}). Never return 'fine' with the 'ask about one record at a time' document action.
4. Add regression tests:
   - "How much did I spend at Zoom this month?" with a Zoom sync_review gap last good before the period start: answers $15.99 with a side note, no prefix, no refusal.
   - Zoom last good Oct 3: no "As of" prefix.
   - "The Coffee Shop" with a stale custom_api feed: same as the Zoom case.
   - A ledger last synced before the period: refusal labeled catastrophic with the coverage next action.

- Verifier's reasoning:

I traced the claim end to end on the real store path, with no hand-built gap shapes. The connector gaps came from store-d1 coverageGapReport over an in-memory D1 that has a real `sources` row. That is the same producer handleThink uses through coverageForRead (index.js:1104), and it feeds sourceCoverage into withLedgerAnswer (index.js:1109).

1. The ledger question is classified correctly. classifyLedgerQuestion("How much did I spend at Zoom this month?") gives kind=merchant, match="zoom", from 2026-10-01, to 2026-10-23.

2. The raw question goes to the coverage classifier. withLedgerAnswer (ledger-answer.js:618-626) passes it to classifyQuestionCoverage with questionType "money" and evidenceSources ["ledger"].

3. The merchant word is read as a channel. In coverageQuestionSources, retrieval-status.js:194 matches \bzoom\b and adds the meetings sources (zoom, calendar). Because a channel was "named", line 197 returns early, so the explicit money type is ignored. Lines 375-376 then add zoom and calendar to the primary set next to ledger. "The Coffee Shop" hits line 195 (\bshop\b) the same way, which adds custom-api, store, shopify and square.

4. The store's real gaps carry the connector kind. For a Zoom source paused for review, store-d1 emits sync_review and coverage_stale gaps with the non-enumerable fields source_kind "zoom" and a full ISO last_good_sync_at. gapSourceKind reads those, so the Zoom gap counts as primary.

5. Outcome when the Zoom source was last good on Oct 3. outsidePeriod is false. The gap is more than 14 days old, so answer_prefix becomes "As of 2026-10-03,". The owner sees "As of 2026-10-03, Total spend for zoom: $15.99.", even though the same answer's Accounts line says the ledger is covered through 2026-10-23. A side note about zoom-recordings is added too. Control C (no Zoom source) gives no prefix.

6. Outcome when the Zoom source was last good on Sep 25. lastGood is before periodStart, so the gap is catastrophic. coverage.refuse is true and ledger-answer.js:627-628 calls hardLedgerRefusal with the Zoom gap. That gap has no reason, so policy is null and catastrophic is false. The owner gets: answer null, status answer_withheld, coverage_classification "fine", ledger_refusal_class "coverage_outage", the Zoom pause text as notice, and next_action "Next: ask about one record at a time, naming its title or date." brain-mcp.mjs:697-699 then tells the model "This is a ledger refusal, not a source-coverage outage." The same happens with plain staleness, without a review flag (case E). It also happens with a custom_api store feed last read Sep 20 and "The Coffee Shop" (case F); with that feed last read Oct 2 the answer gets the prefix "As of 2026-10-02," instead (case G).

7. Control D isolates the cause. With the same paused Zoom source and the question "How much did I spend this month?" (no merchant word), the ledger answers normally and only adds a side note. The merchant word alone causes the misdating or blocking.

8. The mislabel also happens for a real ledger gap. With the ledger last synced Sep 30 and an October question, hardLedgerRefusal also returns answer_withheld, "fine" and the document-path next action. So the hardLedgerRefusal half of the proposed fix stands as well.

Nothing guards this path. withLedgerAnswer does no ledger-only filtering. The tests pin channel-word precedence only for document-type questions ("What was store revenue?"). The money-path tests only cover ledger, Drive and Gmail gaps. No test covers a merchant name that collides with a channel word.

Partly not reproduced: the "retired Stripe-kind source" example. Registered source kinds (index.js:2607) exclude stripe and square, and a retired source's gap carries its registered kind. So the probe's source_kind "stripe" cannot come from a registered source. A smaller variant is reachable: gapSourceKind falls back to the source name for unregistered sources, so an unregistered document source whose name contains plaid, stripe or square becomes a never-complete primary gap. That would block every money ledger answer the same way. A registered plaid-kind source is possible, but it may be the bank feed itself.

Severity: I keep P2. No money figure is wrong, and nothing claims a record is absent. The defect is a misleading "As of" date on a correct figure, or a false refusal with the wrong classification and the wrong remedy. It needs a merchant name that collides with a channel or store word, plus a stale or paused connector of that kind.

- Reproduction:

Probe: C:\offload\review-gaps-scratch\refute-merchant-primary\probe-e2e.mjs, run from that folder with `node probe-e2e.mjs`. It uses the money-fix fixture and seeds install_state. It adds a live ledger ****4321 covered 2026-01-01..2026-10-23 and synced 2026-10-23T17:00Z, with a $15.99 ZOOM.US outflow on 2026-10-05. It inserts a real `sources` row (kind zoom, stale_reason SAFETY_REVIEW_REQUIRED, expected refresh 1 day). Gaps come from coverageGapReport(env, {now}), and withLedgerAnswer is called at now 2026-10-23T18:00Z.
Results:
(A) last_ingest Oct 3: the answer starts "As of 2026-10-03, Total spend for zoom: $15.99." The covered-through-2026-10-23 line is still in the same answer.
(B) last_ingest Sep 25: answer null, status answer_withheld, classification "fine", notice "The Zoom source is paused for safety review...", next_action "Next: ask about one record at a time, naming its title or date."
(C) no source: no prefix.
(D) same Sep 25 pause, question "How much did I spend this month?": answers $15.99 with a side note only.
(E) Zoom just stale (no review flag) since Sep 25: same refusal as B.
(F) custom_api feed "store-orders" last read Sep 20, question "...at The Coffee Shop this month?": same refusal as B.
(G) same feed last read Oct 2: answer prefixed "As of 2026-10-02,".
Second probe: C:\offload\review-gaps-scratch\refute-merchant-primary\probe-label.mjs. Ledger last synced Sep 30, question about October: status answer_withheld, classification "fine", next_action is the document-path one, gap ledger_coverage_stale.


### 10. [P2] side_note is not shown by /app Ask or `brain ask`; stale-source warnings moved out of the answer text disappear on those surfaces

- Area: ledger-only-money. Finder severity P2, verifier severity P2.
- Location: `worker/src/index.js:1967`; verifier: worker/src/index.js:1967 (coverage gaps removed from Heads up; side_note emitted at index.js:2080). Unrendered on: frontend/src/components/Ask.tsx:302 and :412, brain.mjs:4486-4487 (cmdAsk), frontend/src/lib/answer-render.js:67 / worker/src/lib/answer-render.js:89 (answerText ignores side_note)
- Same root cause as: #4, #19 (side_note is not shown by /app Ask or `brain ask`).
- Inputs: Case 1: a QuickBooks source with a daily refresh, last read 3 days ago, and the deterministic question "What bank and credit card accounts are in QuickBooks, and what are their current balances?" Case 2: any partial-period or 2-14-day-stale ledger answer, e.g. "How much money came in so far this year?" with coverage ending before today.
- Wrong outcome: On the base commit, the QuickBooks money answer text ends with "Heads up: ... The \"quickbooks\" source was last read 3 day(s) ago ... Material added since then is not in the brain". On head, index.js:1966-1970 filters source-coverage gaps out of the Heads up and moves them only into side_note (index.js:2080). The ledger path likewise puts "activity from X through Y may be missing" only in side_note. answerText (worker/src/lib/answer-render.js:89-93 and its frontend copy) ignores side_note. /app Ask renders only answerText (frontend/src/components/Ask.tsx:302), and `brain ask` prints only renderAnswerText (brain.mjs:4486). The owner's own app and CLI therefore show the QuickBooks money figure and partial ledger totals with no staleness or missing-days warning. Only the two MCP renderers relay side_note.
- Finder's evidence: C:\offload\review-gaps-scratch\focus1-money\probe-qb-stale.mjs run against head and against a 99bf39be export. The base answer text contains the coverage_stale sentence. The head answer text does not; head returns side_note "Side note: quickbooks has not refreshed since Sun Oct 4...". grep finds no side_note in frontend/src, worker/src/lib/app-assets.js or brain.mjs.
- Fix: Render side_note in the shared answerText (worker/src/lib/answer-render.js and frontend/src/lib/answer-render.js), for example by appending a blank line and side_note when an answer is shown. Have brain.mjs cmdAsk print it, then rebuild app-assets. Or, until the clients render it, also append side_note to the answer string server-side for supported answers.
- Verifier's fix note:

Do not put side_note inside the shared answerText, and do not append it to the server-side answer string. mcp-endpoint.js:333 already appends side_note after answerText, and brain-mcp.mjs relays it as its own field, so either change would print it twice on MCP.

Instead:
1. Add a `sideNoteText(r)` helper to both answer-render.js copies. It returns r.side_note only when it is a non-empty string, r.evidence_gate?.supported === true and r.answer is a supported answer. It returns nothing on COVERAGE_INCOMPLETE, an unavailable search or a refusal.
2. In Ask.tsx (both Ask and ScopedAsk), render it right after the answer paragraph as `<TruthNote>{sideNoteText(answer)}</TruthNote>`.
3. In brain.mjs cmdAsk, print it on its own line after the answer: `const side = sideNoteText(body); if (side) console.log(\`  ${side}\n\`)`.
4. Rebuild worker/src/lib/app-assets.js.
5. Add focused tests:
   - test/ask.test.mjs: a body with side_note prints it.
   - Ask.test.tsx: renders it.
   - A ledger partial-period body and a stale-QuickBooks body both show the note on the app and the CLI.

- Verifier's reasoning:

I traced the claim through the head code and reproduced it.

1) Worker document path. At worker/src/index.js:1966-1970 the head drops sourceCoverageGaps from the "Heads up" text it adds to observed or money-policy answers. Base added every gap there (base condition `... && gaps.length`, and the text used `gaps.map(...)`). The staleness wording now lives only in the separate `side_note` field (index.js:2080-2082), which comes from classifyQuestionCoverage/renderCoverageSideNote in retrieval-status.js.

Reproduction: the reviewer's QuickBooks probe, copied to my scratch dir and run against both trees. Base answer text: "Heads up: ... The \"quickbooks\" source was last read 3 day(s) ago ... Material added since then is not in the brain ...". Head answer text: only the keyword-index and single-corpus Heads-up lines. The head body carries side_note "Side note: quickbooks has not refreshed since Sun Oct 4, ..." plus coverage_classification stale_but_covering.

2) Ledger path. withLedgerAnswer (ledger-answer.js:631-634) now answers partial and stale periods. The "activity from X through Y may be missing" sentence goes only in side_note. My probe (probe-ledger-partial.mjs) shows answerText(body) never includes it.

3) Consumers.
- answerText in worker/src/lib/answer-render.js:89 and frontend/src/lib/answer-render.js:67 never reads side_note. The frontend copy is byte-identical to base.
- Ask.tsx renders only answerText plus the scanned, evidence-gate, Trust and next-action notes. This holds for both Ask (line 302) and ScopedAsk (line 412).
- The built bundle worker/src/lib/app-assets.js contains 0 occurrences of side_note.
- brain.mjs cmdAsk prints renderAnswerText, the scanned note, confidence, the gate reason (only when refused or partial), the next action, the meaning-search line and citations. It prints no side_note and no gaps.
- I ran the real cmdAsk with a mocked HTTP body carrying side_note (probe-cli.mjs). The printed output has no "Side note" or "may be missing" text.

Only mcp-endpoint.js:332-333 and brain-mcp.mjs (lines 631 and 798) relay it.

Design intent confirms this is a gap, not a choice. The MCP renderer prints answerText and then side_note. The new owner contracts (answer-contract-v1, money-rules-v3) say "give the answer first and then relay that one short note". The app and CLI were simply not updated.

Why P2 and not P1. Every ledger answer text still prints the bounded period and the covered-through date, e.g. "2026-01-01 through 2026-09-30 ... covered through 2026-09-30". Balance lines carry "as of <date>". An "As of <date>," prefix stays in the text when the primary source is more than 14 days stale. So no money figure is wrong and no absence claim goes unbounded. What is lost on the owner's own app and CLI is the explicit warning that a source is paused or stale, or that days may be missing. That is a regression from base on the QuickBooks/document money path, and the new partial-period caveat never reaches those surfaces. Real but bounded.

On the proposed fix: appending side_note inside the shared answerText (or to the server-side answer string) would print it twice in the MCP text renderer, because mcp-endpoint.js:333 already appends side_note after answerText. brain-mcp.mjs would also show it twice: inside answer and again as the side_note field.

- Reproduction:

Scratch dir: C:\offload\review-gaps-scratch\verify-sidenote-ask-cli\

(a) `node probe-qb-stale.mjs C:/offload/review-gaps` against head: the answer has no "last read 3 day(s) ago" text, and side_note = "Side note: quickbooks has not refreshed since Sun Oct 4, so anything only in quickbooks after that date may be missing." The same probe against C:/offload/review-gaps-scratch/focus1-money/base: the answer contains "Heads up: ... The \"quickbooks\" source was last read 3 day(s) ago ... Material added since then is not in the brain ...".

(b) `node probe-ledger-partial.mjs`: the question "How much money came in so far this year?" with coverage through 2026-09-30, synced today. answerText = "account ****4321, 2026-01-01 through 2026-09-30: credits $120.01 ... covered through 2026-09-30." side_note = "...activity from Oct 1 through Oct 23 may be missing." (it appears only in the field).

(c) `node probe-cli.mjs`: the real cmdAsk from brain.mjs with a mocked /api/rag/think body that carries side_note. The printed CLI output has no "Side note" or "may be missing" (regex check printed false).

(d) Code reading: Ask.tsx:302 and :412 render only answerText(answer). There are 0 side_note hits in frontend/src or worker/src/lib/app-assets.js.


### 11. [P2] Email, document and meeting families only map to gmail, drive+upload and zoom+calendar. Never-synced IMAP or Microsoft mail never counts as primary for an explicit email question.

- Area: paused-absence. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/retrieval-status.js:46`; verifier: worker/src/lib/retrieval-status.js:44-51 (QUESTION_PRIMARY_SOURCES); also gapSourceKind fallback list at :216-225
- Same root cause as: #6 (email questions treat only Gmail as the primary mailbox).
- Inputs: The owner's mail is an IMAP source (kind "imap") that has never synced, and an upload row matches. The owner asks "Did Acme email me the signed NDA?". Microsoft mail, Dropbox, Notion and Microsoft calendar sources behave the same way.
- Wrong outcome: Raw search returns coverage_classification "fine" with no status. With Gmail as the mail source, the identical question is "catastrophic" and refused. The explicit email question is answered from non-email rows, and an email absence is implied while the email source has never been read. When IMAP stopped before the requested period, the result is only stale_but_covering instead of the refusal Gmail gets.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus2\probe-variants.mjs. Head output: imap-never-synced gives {coverage_classification:"fine", results:1, gaps:[never_synced:work-mail, history_unproven:work-mail]}, while gmail-never-synced gives {status:"coverage_incomplete", coverage_classification:"catastrophic"}. QUESTION_PRIMARY_SOURCES.email is Set(["gmail"]), but store-d1 REFRESHABLE_SOURCE_KINDS includes imap, microsoft, dropbox and notion.
- Fix: Map families to every connector kind that serves them: email = gmail, imap, microsoft; documents = drive, upload, dropbox, notion, microsoft; meetings = zoom, calendar, microsoft. Better, derive them from one shared kind-to-family table next to REFRESHABLE_SOURCE_KINDS, and add an IMAP never-synced test that mirrors the Gmail catastrophic test.
- Verifier's fix note:

Change the family sets to cover every connector kind that serves each family:
- email: new Set(["gmail","imap","microsoft"])
- documents: new Set(["drive","upload","dropbox","notion","microsoft"])
- meetings: new Set(["zoom","calendar","microsoft"])

A better fix keeps one exported kind-to-family table next to REFRESHABLE_SOURCE_KINDS in store-d1.js (or a shared module) and derives QUESTION_PRIMARY_SOURCES from it, so a new connector cannot silently drop out of coverage routing. Also add "imap" (and "microsoft", "dropbox", "notion") to the gapSourceKind fallback list for gaps that lack source_kind.

Tests: add a raw /unified test and a classifyQuestionCoverage unit test with an 'imap' source that has never synced or has history_unproven, upload evidence, and q "Did Acme email me the signed NDA?". Expect coverage_classification "catastrophic" and status coverage_incomplete, mirroring the existing Gmail test in practical-gaps-0419.test.mjs. Add the same test for kind "microsoft", and an IMAP stopped-before-period test that expects a refusal rather than stale_but_covering.

- Verifier's reasoning:

I traced the claim through the code and could not refute it.

1. In worker/src/lib/retrieval-status.js:44-51, QUESTION_PRIMARY_SOURCES.email is Set(["gmail"]), documents is {drive, upload} and meetings is {zoom, calendar}.
2. coverageQuestionSources (178-214) sends "Did Acme email me...", "inbox", "message" and "sent mail" wording to that email family. contactFieldIntent returns null for these questions.
3. classifyQuestionCoverage (358-428) makes primarySourceKinds = the evidence kinds plus the family set. A gap is catastrophic only when gapSourceKind(gap) is in that set (lines 386-401).
4. gapSourceKind takes the non-enumerable source_kind that store-d1.js coverageGapContext (~3790) copies from sources.kind. For an IMAP mailbox that kind is "imap": brain.mjs:20582 registers it with kind "imap" when the mailbox is connected. Microsoft 365 mail, calendar and files all sync under kind "microsoft" (connectors/microsoft-graph.mjs).
5. So when the only matching row is an upload, a never-synced or history_unproven IMAP or Microsoft gap is not primary. lastGood is null, so it is not "notable" either, and the result is classified "fine".
6. In worker/src/index.js:863-899 (raw /unified), status is set only when rows.length===0 or the decision refuses. Here neither holds, so the response has no status.
7. components/brain-mcp.mjs brain_search (756-845) then reports no search_status and no note. compactSearchGaps moves the IMAP gap into other_source_gaps as a one-line {source,type} entry. In /think (index.js 1930-1946), the IMAP case answers from the upload row. The source-coverage gaps are no longer added to the answer's "Heads up" (head change at 1966-1970), and with lastGood null there is no side_note.
8. With Gmail as the mail source, the identical setup is catastrophic. The answer is withheld, the rows are hidden, and status is coverage_incomplete.
9. The head's own test requires this refusal: practical-gaps-0419.test.mjs ~389 says "an actual email-message request still requires Gmail". It only exercises kind gmail.
10. This is also a regression from the base. In 99bf39be, raw search returned COVERAGE_INCOMPLETE whenever any source coverage gap existed.

Why P2 and not P1: the system itself never states that nothing was recorded. With zero rows, raw search still returns coverage_incomplete, and a /think refusal is still blocked by sourceCoverageBlocksAbsence. The IMAP gap still rides in the payload (gaps on think, other_source_gaps on search). The harm is that a supported mail setup misses the explicit-channel refusal and the provisional framing that Gmail owners get. An owner using IMAP or Microsoft mail gets a "fine" answer from non-email records to an explicit email question, while the mailbox has never been read.

Caveat on the proposed fix: adding "microsoft" to the email family also refuses an email question when the Microsoft source syncs only files or calendar. That over-refusal is acceptable given the fail-closed goal.

- Reproduction:

Probe at C:\offload\review-gaps-scratch\verify-imap-primary\probe2.mjs (plus probe.mjs, a copy of the claimant's probe). It uses worker/test/product-contract-fixture.mjs and POSTs to /api/rag/unified.

Setup: an upload source holding one row, "Acme NDA draft for review, unsigned", plus a mail source 'work-mail' with last_ingest_at and last_complete_sweep_at NULL.

Output at head 0ecf2b0:
- imap, kind as registered at connect time (expected_refresh_seconds NULL), q "Did Acme email me the signed NDA?": {cls:"fine", results:1, gaps:[history_unproven:work-mail]}, no status.
- Same setup with kind gmail: {status:"coverage_incomplete", cls:"catastrophic"}.
- microsoft, never synced (expected 86400): {cls:"fine", gaps:[never_synced, history_unproven]}, no status.
- imap with "Find the inbox message from Acme about the NDA.": cls "fine". Gmail with the same question: "catastrophic".

The base (99bf39be) handleUnified returned status coverage_incomplete for any non-empty sourceCoverageGaps.


### 12. [P2] The current-balance 'As of' prefix takes the live member's old sync date while the amount comes from a newer manual snapshot, so one figure carries two conflicting dates

- Area: dates-timezones. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/ledger-answer.js:91`; verifier: worker/src/lib/ledger-answer.js:91 (oldest observation chosen across live members and the selected row). The false detail sentence is at ledger-answer.js:104 and the prefix is prepended at ledger-answer.js:633. The prefix comes from retrieval-status.js:425-427.
- Inputs: Approved manual+live pair. The live feed last synced 2026-09-20T18:00Z, with a live balance as of 2026-09-20. The owner's newer manual snapshot is as of 2026-10-11 ($543.21). On 2026-10-12 the owner asks 'What is my current balance?'.
- Wrong outcome: The answer reads 'As of 2026-09-20, account ****4321: $543.21 as of 2026-10-11 [1].' The prefix tells the owner the balance is a Sept 20 figure. The amount is the Oct 11 manual observation. The answer contradicts itself about which date the money figure belongs to. The base had no prefix.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus3-dates\probe-balance.mjs, CASE1. balanceCoveragePlan adds every live member's last_synced_at to the observations (ledger-answer.js:77-89) and picks the oldest (line 91). classifyQuestionCoverage then renders `As of ${calendarDay || coverageCalendarDate(instant)}` from that oldest instant (retrieval-status.js:407-427). The test at worker/test/ledger-answer.test.mjs:232-268 asserts that this prefix appears for the '$543.21' manual amount.
- Fix: Keep the live member's staleness in the side note, but build the prefix from the date of the selected balance row (its as_of_date or last_synced_at). Or drop the prefix when the selected observation is newer than the stale member and let the side note carry the staleness. The prefix and the 'as of <date>' inside the answer must name the same observation.
- Verifier's fix note:

Split the two facts in balanceCoveragePlan:
(a) Compute the "selected balance" observation only from the selected balance rows (each row's last_synced_at, otherwise its as_of_date day-end). Use it alone for covered_through, the detail sentence and anything that can become an answer prefix.
(b) When a live member of the same effective account last synced earlier than its selected row, still emit a staleness gap so the side note survives. Mark that gap as not prefix-eligible (for example `prefix_eligible: false`, honoured in classifyQuestionCoverage before setting oldestCoveringPrimary). Word its detail as something like: "The live feed for ****4321 last synced 2026-09-20; the balance shown is the newer recorded snapshot of 2026-10-11."

A simpler alternative: for intent.kind === "balance", do not prepend coverage.answer_prefix at ledger-answer.js:633, because every balance line already carries its own "as of <row date>". Let the side note carry the live-member staleness.

Either way, update the boundary test in worker/test/ledger-answer.test.mjs ("a selected manual balance retains every approved live member's freshness"). It should assert that any prefix date equals the selected row's as_of date, or that no prefix appears, and it should keep the side-note assertions.

- Verifier's reasoning:

I could not refute this. The path runs end to end, and nothing between the plan and the owner-facing text removes or reconciles the prefix.

1. withLedgerAnswer (ledger-answer.js:613-616) reads the selected balances with readEffectiveBalances. It passes them to ledgerCoveragePlan, which hands balance questions to balanceCoveragePlan. In an approved manual+live pair, the reader picks the newer manual snapshot (as_of 2026-10-11, last_synced_at null). The probe confirms this pick.
2. balanceCoveragePlan (lines 77-89) puts every live member's last_synced_at (2026-09-20T18:00Z) into the same observations list as the selected row's as_of_date. Line 91 takes the oldest, which is the live member. It then emits a ledger_coverage_stale gap with covered_through 2026-09-20 and last_good_sync_at set to the live sync time. Its detail says "The selected bank balance was last proved current on 2026-09-20". That is false for the row actually selected, which is dated 2026-10-11.
3. classifyQuestionCoverage (retrieval-status.js:401-427) treats that gap as primary (the evidence source is the ledger) and more than 14 days old. It sets answer_prefix to "As of 2026-09-20,".
4. ledger-answer.js:633 prepends the prefix to the balance line, and that line already says "as of ${row.as_of_date}". The response sends the answer as one string with no separate coverage_classification or answer_prefix field. So the MCP-side publicAnswerPrefix filter in components/brain-mcp.mjs never sees it, and the string reaches the owner unchanged. index.js:1109 returns the withLedgerAnswer response directly.

No guard compares the prefix date with the selected row's date. The existing test (ledger-answer.test.mjs, "a selected manual balance retains every approved live member's freshness") only checks that some `As of YYYY-MM-DD,` prefix is present next to $543.21. It does not check that the date matches. In effect it locks in the contradiction.

The base commit had no staleness logic and no prefix for balances, so this is new in the diff.

Severity: P2. The money figure is correct and keeps its true date. The error makes the balance look older, not newer. But one sentence gives a single money figure two dates, and the gap detail states a false fact about the selected balance. An owner who repeats "as of Sept 20 I had $543.21" would be passing on a wrong date. This is bounded and does not produce a wrong amount, so it is not P0/P1.

- Reproduction:

I wrote the probe at C:\offload\review-gaps-scratch\verify-asof-prefix\probe.mjs and ran it with `node C:\offload\review-gaps-scratch\verify-asof-prefix\probe.mjs` from C:\offload\review-gaps. It builds a product fixture with an approved manual+live pair on mask 4321. The live feed's last_synced_at is 2026-09-20T18:00Z and the live balance snapshot is as_of 2026-09-20 ($987.65). The manual snapshot is as_of 2026-10-11 ($543.21). The question is "What is my current balance?" with now = 2026-10-12T18:00Z.

The output was the same in UTC and America/Phoenix:
- selected row: manual-account, as_of 2026-10-11, last_synced_at null
- answer: "As of 2026-09-20, account ****4321: $543.21 as of 2026-10-11 [1]."
- side_note: "Side note: bank ledger has not refreshed since Sun Sep 20, so anything only in bank ledger after that date may be missing."
- gap detail: "The selected bank balance was last proved current on 2026-09-20; newer activity may be missing."
- ledger.accounts[0].as_of: "2026-10-11"


### 13. [P2] Bare nouns ('zoom', 'store', 'inventory', 'order', 'drive', 'calendar') make unrelated connectors primary, which refuses fully covered bank-ledger answers

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/retrieval-status.js:193`; verifier: worker/src/lib/retrieval-status.js:193-195 (bare-noun channel regexes, returned before explicitType at :196-203); worker/src/lib/ledger-answer.js:618-627 (ledger path derives primaries from question text)
- Same root cause as: #9 (bare nouns and merchant words make unrelated connectors primary).
- Inputs: The bank ledger is fresh and covers Jan 1 to Oct 23. A Zoom recordings connector was last read Aug 15 (coverage_stale), or a custom_api store feed has never completed history (history_unproven, last_ingest_at NULL). The owner asks 'How much did I spend at Zoom last month?', 'How much did I spend on inventory last month?' or 'How much did I spend at the Apple Store last month?'. On the document path the inputs are 'What did the court order say about custody?' or 'How many miles did I drive for client visits?' with a never-synced store feed or Drive source.
- Wrong outcome: The ledger question is refused. Answer is null, the notice is the Zoom or store connector's staleness text plus 'Reconnect Zoom...', and next_action is 'ask about one record at a time'. The same ledger with 'Acme' in place of 'Zoom' answers $25.00, and Zoom answers $15.99 when no connector gap exists. Named-channel words also override questionType 'money', so a non-catastrophic stale Zoom gap older than 14 days adds 'As of <Zoom date>,' to a current bank figure. On the document path, a question about a court order, 'in order to', products or driving is refused when an unrelated store or Drive connector never completed.
- Finder's evidence: coverageQuestionSources returns the named-channel set before considering explicitType (retrieval-status.js:190-200). The store regex at :195 matches order(s), products, inventory, shop and store. The meetings regex at :194 matches 'zoom' and 'calendar'. withLedgerAnswer classifies with questionType 'money' but receives the channel set (ledger-answer.js:615-626). Probe probe-ledger-e2e.mjs: Zoom merchant with stale zoom connector -> answer null, status answer_withheld; Acme control -> answered; inventory category with an incomplete store feed -> refused; software control -> answered. probe-classify.mjs: 'court order' and 'drive' (miles) -> catastrophic.
- Fix: In the ledger path, primary sources must be exactly {ledger} plus the source feeds of the selected accounts, and must ignore channel words in merchant or category text. Pass an explicit primary set instead of re-deriving it from the question. For documents, detect channels only from explicit channel phrases ('in Gmail', 'my calendar', 'Zoom call/recording', 'my store feed/orders in Shopify'), not bare nouns such as order, products, drive or calendar year.
- Verifier's fix note:

1. Ledger path. Stop deriving primary sources from the question text:
   - Add an explicit `primarySources` option to `classifyQuestionCoverage`. When it is given, use it instead of `coverageQuestionSources`. Keep the evidence sources.
   - In `withLedgerAnswer`, pass `primarySources: QUESTION_PRIMARY_SOURCES.money` (ledger, plaid, bank, bank-feed, payment, stripe, square). Do not pass the raw question for source detection.
   - A Zoom, store, Drive or calendar gap then stays a side note and can never refuse a bank-ledger figure or add an "As of" prefix.

2. Document path. Count a channel only when the owner actually names one:
   - Zoom: "zoom call/meeting/recording" or "in/on zoom".
   - Calendar: "my/the calendar" or "calendar event/invite", but not "calendar year".
   - Drive: "google drive", "my drive", "in drive", "drive folder/file". Not the verb "drive".
   - Store: "shopify", "my/online store", "store feed/orders/sales", "units sold". Not bare "order(s)", "in order to", "products", "inventory" or "shop".

3. Tests:
   - Add regressions with a stale Zoom gap and a never-completed custom_api gap. "spend at Zoom last month", "spend at the Apple Store", and "spend on inventory" must answer from the ledger with only a side note and no "As of" prefix.
   - "court order", "in order to", and "drive" (miles) must not refuse when only an unrelated store or Drive source is incomplete.

- Verifier's reasoning:

The code reads as claimed and the full path reproduces through the real Worker route.

How it happens: `coverageQuestionSources` (retrieval-status.js:178-213) turns bare nouns into "named channels". These are:
- :193: drive
- :194: zoom, calendar
- :195: store, shop, orders, inventory, products

It returns that channel set before it looks at `explicitType`. `withLedgerAnswer` (ledger-answer.js:618-626) passes the owner's raw question with `questionType: "money"` and `evidenceSources: ["ledger"]`. So a merchant or category word in a bank-ledger question makes an unrelated connector a primary source. Any gap on that connector then goes through the primary checks in `classifyQuestionCoverage` (:392-401). A `coverage_stale` gap counts as `outsidePeriod` once its last good read is before the period start. A `history_unproven` gap with a null last ingest counts as `neverComplete`. Either sets `refuse: true`. ledger-answer.js:627 then calls `hardLedgerRefusal`.

Nothing upstream stops this. The new test "named channels ... outrank generic money words" (practical-gaps-0419.test.mjs:102) only covers real channel names (Gmail, QuickBooks, "store revenue") with no questionType. No test covers a merchant or category word on the ledger path. The bank figure never reads the Zoom or store feeds, so their staleness cannot make it incomplete.

Severity is P2, not P1:
- No wrong figure is shown.
- No false "nothing recorded" claim is made.
- Nothing is exposed.
- The over-refusal and the wrong date label are bounded. The answer body still states the true covered dates.
The owner is still misled in two ways:
- The notice tells them to reconnect Zoom or fix the store API.
- The next step tells them to "ask about one record at a time".
Asking again keeps failing until the unrelated connector is fixed. The response also contradicts itself: `coverage_classification` "fine" next to `status` "answer_withheld".

- Reproduction:

Scratch probes (repo untouched): C:\offload\review-gaps-scratch\verify-bare-nouns\probe-e2e.mjs, probe-e2e-2.mjs (real /api/rag/think route, SQLite product fixture, Date.now = 2026-10-23, ledger covered 2026-01-01..2026-10-23, txns ZOOM.US $15.99 on 09-12 and ACME SUPPLY $25.00 on 09-14) and probe-classify.mjs (direct classifier). Run from C:\offload\review-gaps with `node <probe>`.

Results:
1. Zoom source with last_ingest 2026-08-15, expected daily refresh. "How much did I spend at Zoom last month?" -> answer null, status answer_withheld, coverage_classification "fine". The notice is the Zoom source staleness text plus "Reconnect Zoom...". next_action is "ask about one record at a time". The same fixture with "Acme" answers $25.00 with only a side note. With no connector gaps, Zoom answers $15.99.
2. Same Zoom gap. "How much did I spend at Zoom in the last 90 days?" (period 07-26..10-23) -> "As of 2026-08-15, Total spend for zoom: $15.99 ... covered through 2026-10-23". The Acme control has no prefix.
3. custom_api store source, never completed. "How much did I spend at the Apple Store last month?" -> refused, with the custom-API notice. "...on inventory last month?" -> refused. "...on software" answers.
4. Classifier, document path:
   - "What did the court order say about custody?" with a never_synced store feed and upload evidence -> catastrophic, refuse:true. The same question without "order" -> fine.
   - "What did the lease say in order to renew?" -> catastrophic.
   - "How many miles did I drive for client visits?" with a never_synced Drive and gmail evidence -> catastrophic. With "travel" in place of "drive" -> fine.
   - index.js:1930-1947 then nulls a supported document answer when refuse is true.


### 14. [P2] Coverage refusals that come from the classifier are labelled answer_withheld / 'fine' with the wrong remedy, and the local MCP says 'not a source-coverage outage'

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/ledger-answer.js:177`; verifier: worker/src/lib/ledger-answer.js:177 (hardLedgerRefusal derives catastrophic only from ledgerRefusalPolicy(gap.reason)); caller at worker/src/lib/ledger-answer.js:627-628; downstream text at components/brain-mcp.mjs:697-699 and worker/src/lib/mcp-endpoint.js:267-285; templates/owner-contract/money-rules-v3.md (and v2, v2-windows, v3-windows) Side note / Refused bullets
- Inputs: (a) A live account last synced Sep 30 with covered_to Oct 22, asked 'What were my deposits in October 2026?'. This is the repo's own test 'the real ledger refuses when its last good sync predates the requested period'. (b) The Zoom, store or second-bank registry gaps from the other findings.
- Wrong outcome: The response is status 'answer_withheld', coverage_classification 'fine', ledger_refusal_class 'coverage_outage', no code, and evidence_gate.reason 'the recognized ledger question could not be answered...'. In case (a) the notice says 'The bank ledger is covered through 2026-10-22...' for a refused October question, and next_action is 'Next: ask about one record at a time, naming its title or date.' The local brain_think note (brain-mcp.mjs:697-699) tells the model 'This is a ledger refusal, not a source-coverage outage... Relay the exact code', but there is no code. The owner is told the opposite of the real cause and to rephrase instead of refreshing the bank feed. The money-rules templates describe ledger_coverage_stale only as 'give the ledger answer first, then relay side_note', so they contradict this refusal.
- Finder's evidence: hardLedgerRefusal derives catastrophic from ledgerRefusalPolicy(gap.reason). ledger_coverage_stale and source-registry gaps have no reason, so catastrophic=false, which yields ANSWER_WITHHELD and COVERAGE_FINE (ledger-answer.js:175-207). The call site passes coverage.catastrophic_gaps[0] (:627-628). Probe probe-ledger-label.mjs output: {status:'answer_withheld', coverage_classification:'fine', next_action:'Next: ask about one record at a time, naming its title or date.'}. The existing test only asserts answer null and the gap type.
- Fix: Pass an explicit catastrophic flag: hardLedgerRefusal(gap, gaps, { catastrophic: Boolean(plan.catastrophic) || coverage.refuse }). Emit COVERAGE_INCOMPLETE plus COVERAGE_CATASTROPHIC, and derive next_action from the gap (refresh the bank feed, or name the source and its remedy). Add the ledger_coverage_stale refusal case to the money-rules 'Refused' bullet.
- Verifier's fix note:

1. Give hardLedgerRefusal an explicit flag: `hardLedgerRefusal(gap, allGaps, { catastrophic } = {})` with `const isCatastrophic = catastrophic === true || policy?.catastrophic === true`.
2. At :627-628, call it as `hardLedgerRefusal(plan.catastrophic || coverage.catastrophic_gaps[0], allCoverageGaps, { catastrophic: true })`. Both branches are catastrophic by construction (`coverage.refuse` is true only when the classification is COVERAGE_CATASTROPHIC). The response then carries status COVERAGE_INCOMPLETE and coverage_classification COVERAGE_CATASTROPHIC, so the remote MCP takes its "primary source cannot cover this request" branch and the local MCP sets catastrophicCoverage.
3. When the gap has no policy, take next_action from the gap rather than the answer_withheld default:
   - for `gap.source_kind === 'ledger'`, use the `period_outside_coverage` or `live_feed_never_synced` next_action (refresh or finish the bank feed sync);
   - otherwise use `refusalNextAction({ status: COVERAGE_INCOMPLETE })` ('say "check my Brain" to see which source...').
4. Build the notice so it names the real cause: the source label plus its last good sync date, compared against `intent.from` (for example, 'The bank ledger last synced 2026-09-30, before the requested period starts on 2026-10-01.'). Set evidence_gate.reason to 'primary source coverage predates the requested period'.
5. Leave `ledger_refusal_class` unset for non-policy gaps, so the local MCP does not print 'not a source-coverage outage ... relay the exact code'.
6. In the four money-rules templates, add to the "Refused" bullet: a `ledger_coverage_stale` gap that comes with no answer and status coverage_incomplete means the ledger's last good sync is older than the period start. Relay that sync date and refresh the bank feed; do not treat it as a side note.
7. Extend the practical-gaps test 'the real ledger refuses when its last good sync predates the requested period' to assert status, coverage_classification, and that next_action is not the answer_withheld text.

- Verifier's reasoning:

I traced the path in the head and reproduced it with a probe. The claim holds.

1. withLedgerAnswer (ledger-answer.js:627-628) refuses when `plan.catastrophic || coverage.refuse`. When the planner itself flags nothing, it passes `coverage.catastrophic_gaps[0]`, a gap picked by classifyQuestionCoverage (retrieval-status.js:358-427).
   - That gap can be a `ledger_coverage_stale` gap whose last good sync is earlier than the start of the requested period (the `outsidePeriod` branch at :394-401).
   - It can also be any registry gap whose source kind counts as primary. For `questionType: "money"`, Stripe, Square, Plaid, bank and payment all count (:45).
2. hardLedgerRefusal (:175-207) works out `catastrophic` only from `ledgerRefusalPolicy(gap?.reason)`. These classifier gaps carry no `reason`, so `catastrophic` is false and the response gets:
   - `status: answer_withheld` and `coverage_classification: fine`;
   - `ledger_refusal_class: coverage_outage`, with no code;
   - `next_action` from `refusalNextAction({status: answer_withheld})`, which is the document-search remedy.
3. Nothing later in the chain changes these labels:
   - index.js:1109 returns the response as is.
   - Remote MCP (mcp-endpoint.js:267-285): because the label is 'fine', it skips the catastrophic branch ("The question's primary source cannot cover this request") and uses the ledger-refusal branch, which prints the gap detail, "Why: the recognized ledger question could not be answered from readable covered ledger rows", and "Next: ask about one record at a time, naming its title or date."
   - Local MCP (brain-mcp.mjs:697-699): the note says "This is a ledger refusal, not a source-coverage outage... Relay the exact code", but no code exists.
4. The money-rules templates (money-rules-v3.md and its siblings) describe `ledger_coverage_stale` only under "Side note: give the ledger answer first". The "Refused" bullet names only `ledger_out_of_coverage` and `ledger_not_consulted`, so the templates conflict with this refusal.

Why not higher than P2:
- No money figure is shown (`answer` is null, `citations` and `results` are empty), so no wrong figure reaches the owner.
- `answer_withheld` still counts as "absence unproven" (`absenceUnproven`), so there is no fabricated "nothing recorded".
- The harm is a wrong cause and remedy on a refusal. Case (a) also says "covered through 2026-10-22" and never mentions the Sep 30 sync that actually caused the refusal.

Reachability:
- Case (a) needs `covered_to` to be on or after the period start while `last_synced_at` is before it. With consistent data, `covered_to` usually tracks the last sync, which routes to `period_outside_coverage` and is labelled correctly. So case (a) is the less common path, though the repo's own test pins it.
- Case (b) is ordinary: a fresh bank ledger plus a Stripe registry source that stopped before the period gives the same wrong labels. Whether a Stripe gap should block a ledger answer at all is a separate finding.

- Reproduction:

Probe: C:\offload\review-gaps-scratch\verify-refusal-label\probe.mjs. It reuses the fixture from worker/test/practical-gaps-0419.test.mjs with NOW 2026-10-23T18:00Z and the question 'What were my deposits in October 2026?'. Run it with `node C:\offload\review-gaps-scratch\verify-refusal-label\probe.mjs` from C:\offload\review-gaps.

Case A (covered_to 2026-10-22, live feed last synced 2026-09-30T18:00Z) returns:
- status 'answer_withheld', coverage_classification 'fine', ledger_refusal_class 'coverage_outage', no code;
- notice 'The bank ledger is covered through 2026-10-22; activity after that date may be missing from the requested period through 2026-10-23.';
- next_action 'Next: ask about one record at a time, naming its title or date.';
- evidence_gate.reason 'the recognized ledger question could not be answered from readable covered ledger rows';
- gaps[0].type 'ledger_coverage_stale', with last_good_sync_at 2026-09-30 present in the gap but absent from the notice.

Case B (fresh ledger synced 2026-10-23T17:00Z, plus a sourceCoverage gap {type:'coverage_stale', source:'Stripe', source_kind:'stripe', last_good_sync_at:'2026-09-20T12:00Z'}) returns status 'answer_withheld', coverage_classification 'fine', notice 'Stripe last synced Sep 20.' and the same document-search next_action.


### 15. [P2] Any future date window is 'catastrophic' when the primary source has any gap, even one synced minutes ago

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/retrieval-status.js:395`; verifier: worker/src/lib/retrieval-status.js:395 (consumed by worker/src/index.js:864-896 and rendered by components/brain-mcp.mjs:759-762,836-838; hosted mcp-endpoint search is not reachable because it never sends from)
- Inputs: A calendar source synced 10 minutes ago, with history not yet certified complete (history_unproven, common in the first days or for a connector that never sends complete_sweep). It holds a dentist event dated next Tuesday. brain_search runs with q 'dentist appointment', from 2026-10-26, to 2026-11-01, as the MCP instructions tell the model to do for 'next week'.
- Wrong outcome: /api/rag/unified returns status coverage_incomplete and coverage_classification 'catastrophic'. Both MCP renderers then drop the matching row and say 'The question's primary source cannot cover this request, so this is a refusal.' The same search without from is 'fine', and before this diff it was provisional with the row kept. Every 'what's on my calendar next week' style question is refused, and the refusal falsely tells the owner that the source does not cover the period.
- Finder's evidence: outsidePeriod = periodStartMs !== null && (lastGood === null || lastGood < periodStartMs). For a future period, lastGood < periodStart always holds, and any COVERAGE_GAP_TYPES gap qualifies. Probe probe-future-e2e.mjs: completeSweep null + from 2026-10-26 -> {results:1, status:'coverage_incomplete', classification:'catastrophic'}; no window -> 'fine'.
- Fix: Treat 'stopped before the period' only for periods that have started: outsidePeriod = periodStartMs !== null && periodStartMs <= nowMs && (lastGood === null || lastGood < periodStartMs). For future windows, fall back to the staleness side note.
- Verifier's fix note:

In classifyQuestionCoverage, count "stopped before the period" only for a period that has already started:

  const periodStarted = periodStartMs !== null && periodStartMs <= nowMs;
  const outsidePeriod = periodStarted && (lastGood === null || lastGood < periodStartMs);

A future window then falls through to the existing staleness branch: no note if the sync was under 2 days ago, a side note otherwise. A never-synced source stays catastrophic through NEVER_COMPLETE_GAPS and history_unproven with lastGood null, so nothing is lost there.

Add a regression test in worker/test/practical-gaps-0419.test.mjs: a calendar history_unproven gap synced 10 minutes ago, with periodStart next Monday, expects "fine" and refuse false. Add a twin with the gap synced 3 days ago that expects "stale_but_covering" and a side note. Keep the existing past-period test (ledger stopped 23 days before Oct 1 is catastrophic) as the control.

- Verifier's reasoning:

I could not refute this. I traced the path in the head and reproduced it end to end.

1. Gap production (worker/src/lib/store-d1.js:4101-4161). A registered calendar source whose last_ingest_at is 10 minutes ago and whose last_complete_sweep_at is NULL produces a history_unproven gap. That gap carries source_kind "calendar" and last_good_sync_at set to the recent sync (store-d1.js:3786-3803). The state is realistic, and it can last. last_complete_sweep_at is only written by a receipt with complete_sweep true (index.js:2842-2877). The calendar connector sends that only after a full traversal with `result.summary.skipped === 0` (brain.mjs:14925-14926). A single event with no title, attendees or description counts as skipped (connectors/google-calendar.mjs:920), so the gap can stay. sync_in_progress and refresh_unscheduled behave the same way in the classifier.

2. Primary source. The query "dentist appointment" matches the meetings family through "appointment" (retrieval-status.js:207), which makes calendar primary. The returned row's source_kind "calendar" also adds it through evidenceSources (retrieval-status.js:375).

3. Classification (retrieval-status.js:393-401). neverComplete is false because lastGood is not null. But outsidePeriod = `periodStartMs !== null && (lastGood === null || lastGood < periodStartMs)`. For any future window, lastGood < periodStart always holds, so the gap goes into catastrophicGaps and the result is classification "catastrophic" with refuse true. Neither line 395 nor its caller checks whether the period has started.

4. Route (index.js:828, 864-896). explicitFrom comes from the body's `from` (index.js:251-265). With rows present and coverageDecision.refuse true, the route returns status coverage_incomplete and coverage_classification catastrophic.

5. Renderer (components/brain-mcp.mjs:759-762, 836-838). Local brain_search sets workerRows to [] and returns the note "The question's primary source cannot cover this request, so this is a refusal. Do not answer from candidate excerpts." Before this diff, the same request returned coverage_incomplete with the row kept as provisional (diff of index.js searchState).

6. Probe. C:\offload\review-gaps-scratch\verify-future-window\probe-calendar-next-week.mjs uses the real migrated fixture and the real /api/rag/unified route:
   - future from/to (2026-10-26..2026-11-01), history_unproven: results 1, source_kind calendar, status coverage_incomplete, classification catastrophic.
   - same with no window: classification fine.
   - same future window after a complete sweep: classification fine.
   - from = today: classification fine.
   - Unit check: history_unproven, sync_in_progress and refresh_unscheduled with a sync 10 minutes ago are each catastrophic for a future periodStart, and fine with no window or a past one.

Correction to the claim: it is not both MCP renderers. The hosted `search` tool calls deps.search({q, limit}) with no from (mcp-endpoint.js:373). Hosted and local `ask`/brain_think send no from either. Their only window comes from retrievalTimeWindow, which by design never builds a future window (query-intent.js:154-205). So only the local brain_search reaches this, but the server instructions tell the model to turn "next" into from/to there.

Severity: P2, as claimed. This is a false refusal that hides a real recorded event and wrongly says the source cannot cover the period. It is not a wrong money figure or a "nothing recorded" claim. It only happens on local brain_search with an explicit future from, and only while the primary source has some coverage gap. Money is unaffected, because ledger questions take the ledger path and the money families have no future-window case.

- Reproduction:

Command: cd C:\offload\review-gaps; node C:\offload\review-gaps-scratch\verify-future-window\probe-calendar-next-week.mjs

Setup: sources row ('calendar','calendar','ready', last_ingest_at = now-10min, last_complete_sweep_at = NULL, expected_refresh_seconds 86400). One document and chunk "Dentist appointment" dated next Tuesday 12:00Z.

Request: POST /api/rag/unified {q:"dentist appointment", from:"2026-10-26", to:"2026-11-01"}.

Observed:
- {results:1, result_source_kind:"calendar", status:"coverage_incomplete", coverage_classification:"catastrophic", gap_types:["history_unproven"]}
- Controls: no from gives "fine"; a complete sweep with the same future window gives "fine"; from = today gives "fine".
- Unit check: history_unproven, sync_in_progress and refresh_unscheduled with last_good_sync_at = now-10min give future = "catastrophic" and none/past = "fine".

Local brain_search then drops the row (brain-mcp.mjs:762) and returns the refusal note (brain-mcp.mjs:838).


### 16. [P2] Raw search treats every ranked row as primary evidence, so one unregistered legacy row refuses the whole search and drops healthy answers

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/index.js:868`; verifier: worker/src/index.js:868. Root cause is the raw route feeding every candidate row into classifyQuestionCoverage, whose rule at worker/src/lib/retrieval-status.js:375 makes evidence sources primary. Refusal surfaces: index.js:888, components/brain-mcp.mjs:762, worker/src/lib/mcp-endpoint.js:393.
- Inputs: A fully swept, fresh Drive source holds 'Roof quote ... 18,400 dollars'. One legacy note sits under a source name with no registry entry (gap source_unregistered). The query is 'What did the roofing contractor quote?' (or 'roofing contractor quote').
- Wrong outcome: /api/rag/unified returns coverage_classification 'catastrophic' and status coverage_incomplete. brain_search and remote search return results:[] and 'this is a refusal'. The Drive record that answers the question is withheld because a different row in the ranked window (up to 50) came from a legacy source. Before this diff the search was provisional with both rows.
- Finder's evidence: searchState passes evidenceSources: rows.flatMap(row => [row.source_kind, row.source]) for all returned rows. source_unregistered is in NEVER_COMPLETE_GAPS, so any matching row makes the search catastrophic (retrieval-status.js:105, 393, 399). Probe probe-unregistered.mjs: {results:['drive','legacy-notes'], status:'coverage_incomplete', cls:'catastrophic'}.
- Fix: On the raw search route, derive primary sources only from explicit channel wording, not from candidate rows. Alternatively, drop just the rows whose own source is catastrophic and keep the rest with a side note. Only the think path, where the answer relies on approved evidence, should use evidence sources.
- Verifier's fix note:

Split the raw route's decision into two parts in handleUnified's searchState (index.js:863-900).

1. Decide the refusal from the question only. Call classifyQuestionCoverage with `evidenceSources: []`, so that only explicit channel wording such as "Gmail" or "bank" makes a source primary. A catastrophic gap on a channel the owner named still refuses. The existing Gmail-receipt, explicit-from and contact-field tests keep passing.

2. Keep candidate rows from never-complete sources out of that decision. Build the set of sources that have a never-complete or explicitly unreadable gap. If any returned row's `source` or `source_kind` is in that set, return status COVERAGE_INCOMPLETE with the existing provisional notice and keep all rows. Optionally mark those rows (for example `coverage_unproven: true`) so the model knows not to rely on them alone. Do not set coverage_classification to catastrophic.

Leave the think path as it is: there `approvedDocs` are the records the answer actually relies on, so treating their sources as primary is correct.

Add a regression test to worker/test/practical-gaps-0419.test.mjs: a fresh, fully swept Drive row plus one unregistered row (and the first-sync Gmail variant) under a question with no channel words. Assert:
- /unified returns both rows, coverage_classification not "catastrophic", status "coverage_incomplete";
- the hosted MCP `search` and the local brain_search keep the Drive row.

- Verifier's reasoning:

I traced the claim end to end and reproduced it with the real Worker and the hosted MCP. I could not refute it.

1. On the raw search route, every returned row counts as evidence. worker/src/index.js:868 builds `evidenceSources` from `source_kind` and `source` of every row in the ranked window. That window is up to 50 rows, because the local brain_search always asks for WORKER_RESULT_CAP = 50 (components/brain-mcp.mjs:421). The hosted search asks for 10.

2. In `classifyQuestionCoverage`, every evidence source becomes a primary source (retrieval-status.js:375, "Retrieved evidence is always primary for the answer that relies on it"). On the raw route, the rows are only candidates, and no answer relies on them yet.

3. A `source_unregistered` gap has no `source_kind`. So `gapSourceKind` falls back to the source name ("legacy-notes"), which matches the legacy row's `source`. The gap type is in NEVER_COMPLETE_GAPS (line 105), so the source is never complete. Primary plus never complete pushes the gap into `catastrophicGaps` (around line 399), and the result is `refuse=true`.

4. index.js:888 then returns status `coverage_incomplete` and `coverage_classification` "catastrophic". The rows are still in the Worker body.

5. Both MCP renderers then drop every row:
   - brain-mcp.mjs:762 sets `workerRows = []`.
   - mcp-endpoint.js:393 returns `results: []` with "The question's primary source cannot cover this request, so this is a refusal. Do not answer from candidate excerpts."

So a healthy Drive record that answers the question is hidden, and the refusal states something false: Drive is fully covered. This breaks the new contract in answer-contract-v1.md and SKILL.md: "Refuse for coverage only when the question's primary source cannot be read, has never completed a sync...". Before this diff the same body was `coverage_incomplete` with the rows kept and a "provisional" note.

Nothing guards against it:
- The question has no channel words, so `coverageQuestionSources` returns type "other" with no sources. Only the candidate rows decide what is primary.
- Generic ingest (`handleIngest`) does not register sources, so a source with no registry entry is a real state. It has its own gap type, migration tests and degraded-absence tests.
- No existing test pins the case "an unrelated candidate row makes the search catastrophic". The tests that expect catastrophic on unified either name the channel (Gmail) or have the only row in the window come from the catastrophic source.

The same mechanism has a wider reach than the claim states. On install day, a Gmail source still in its first sync has `sync_in_progress` and `history_unproven` gaps with `last_good_sync_at` null, which counts as never complete. Any search whose window holds one Gmail candidate then refuses the fully covered Drive answer (see the third probe below).

Severity stays at P2. No wrong figure is shown and no absence is claimed. The harm is an over-refusal: a false "primary source cannot cover" message on questions the Brain can answer. It is bounded because a retry filtered to source "drive" comes back "fine" with the row (probe-remote.mjs shows this). But the model is told "this is a refusal", so it is unlikely to retry that way on its own.

- Reproduction:

Probe files are in C:\offload\review-gaps-scratch\refusal-rule-verifier\. Each builds the real SQLite product fixture from C:\offload\review-gaps.

1) probe.mjs. Setup: a `drive` source of kind drive, fresh, fully swept, refreshing every 86400 s. One Drive document, "Roof quote", with the text "Roof quote from the roofing contractor: 18,400 dollars...". One `legacy-notes` document with no `sources` row: "Call the roofing contractor back about the quote." Results from POST /api/rag/unified:
   - Control, no legacy row: results [drive], cls "fine", status null.
   - With the legacy row, q "What did the roofing contractor quote?" (same with limit 50, and with q "roofing contractor quote"): results [drive, legacy-notes/unregistered], status "coverage_incomplete", cls "catastrophic", gaps [source_unregistered legacy-notes].

2) probe-remote.mjs sends that Worker body through the hosted MCP `search` tool (handleMcp):
   - Returned: {"results":[],"cls":"catastrophic","note":"The question's primary source cannot cover this request, so this is a refusal. Do not answer from candidate excerpts. Relay the source coverage gaps."}
   - Control retry with source "drive": results [drive], cls "fine".

3) probe-firstsync.mjs is the install-day variant. Gmail source `mail` has status indexing, last_ingest_at NULL and an unfinished sync_run, and holds one row "The roofing contractor will send the quote this week." Same query returns results [drive, mail], cls "catastrophic", gaps [sync_in_progress mail null, history_unproven mail null].

Run with: node <probe>.mjs from that folder.


### 17. [P2] If the source registry cannot be read, coverage is classified 'fine' and the search is no longer marked provisional

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/retrieval-status.js:398`; verifier: worker/src/lib/retrieval-status.js:396-411 (classifier, plus renderCoverageSideNote at 317-337); worker/src/index.js:888-899 (handleUnified searchState)
- Inputs: coverageGapReport fails because the D1 read of the sources table throws, so coverageForRead returns {unavailable:true} and sourceCoverageGaps = [{type:'coverage_unavailable'}]. Any search or think question returns at least one row.
- Wrong outcome: classifyQuestionCoverage returns 'fine' with no side_note. handleUnified returns coverage_classification 'fine' with no status or notice. Before this diff it was COVERAGE_INCOMPLETE with 'Source coverage could not be checked'. Answered think responses carry no note. The owner gets answers and not-found results labelled as healthy coverage when coverage was never checked.
- Finder's evidence: The coverage_unavailable gap has no source, so it is never primary. Its only catastrophic path requires gap.primary_source === true, which no production code sets (grep finds only the classifier). Its lastGood is null, so it is not notable. probe-classify.mjs 'coverage_unavailable' -> {c:'fine', note:null}. index.js:888-899.
- Fix: Treat coverage_unavailable as unknown rather than fine. Return a distinct classification, or at least COVERAGE_STALE_BUT_COVERING with a fixed side note ('Source freshness could not be checked; recent material may be missing'). Keep the coverage_incomplete status on raw search. Remove the dead primary_source branch or set it.
- Verifier's fix note:

1) Change classifyQuestionCoverage in retrieval-status.js so that a gap with type === "coverage_unavailable" and no source is pushed to `notable`, even though lastGood is null. That makes the classification COVERAGE_STALE_BUT_COVERING, with no answer_prefix (prefixes are only set when lastGood is known).

2) In renderCoverageSideNote, emit a fixed clause for that gap before the lastGood check, for example: "Source freshness could not be checked, so recent material from a paused source may be missing." The existing `Side note:` wrapper adds the prefix.

3) Delete the dead `gap.type === "coverage_unavailable" && gap.primary_source === true` branch at line 398. Alternatively, set primary_source where a per-source read failure is actually known.

4) In handleUnified at index.js 888, keep the raw-route provisional contract when the registry itself was unreadable: `if (sourceCoverageGaps.length && (rows.length === 0 || coverageDecision.refuse || coverage.unavailable))`. This restores status coverage_incomplete and the "could not be checked" notice for brain_search. It also stops a "fine" classification from sitting beside a coverage_unavailable gap.

5) Add tests in worker/test/degraded-absence.test.mjs, using mkEnv({ rows:[row], vectorIds:[row.chunk_uid], coverageUnavailable:true }):
- /unified returns status coverage_incomplete and coverage_classification !== "fine".
- An answered /think returns coverage_classification "stale_but_covering" and a side_note matching /could not be checked/.

- Verifier's reasoning:

I reproduced the core claim, but parts of the stated outcome go too far.

Path traced in the head:
- If the sources-table read or sourcesInScope throws, coverageGapAssessment (store-d1.js ~4173) or coverageForRead (index.js 941-955) returns {unavailable:true}.
- handleUnified (index.js 851-856) and handleDocumentThink (index.js 1167-1172) then build sourceCoverageGaps = [{type:"coverage_unavailable", detail}], with no source and no primary_source.
- In classifyQuestionCoverage (retrieval-status.js 386-411), gapSourceKind of that gap is "", so it is never primary. The only catastrophic branch for this gap type needs gap.primary_source === true, and nothing in worker/src or components sets it (grep finds only line 398), so that branch is dead code. lastGoodInstant is null, so the gap is not notable either. Result: classification "fine", no side_note, no prefix.

Probes (scratch dir), head vs base 99bf39be, one retrieved row, sources read throws:
- /unified with rows: head returns {coverage_classification:"fine", gaps:["coverage_unavailable"]} with no status and no notice. Base returned status coverage_incomplete with the notice "Source coverage could not be checked, so treat this result as provisional". The cause is the new condition at index.js 888, `rows.length === 0 || coverageDecision.refuse`.
- Downstream on brain_search: local MCP (brain-mcp.mjs ~766-840) now sends search_status undefined, coverage_classification "fine" and no provisional note. Remote MCP runSearch (mcp-endpoint.js ~412-422) does the same.
- Answered /think: head adds coverage_classification "fine" and no side_note. The new nonCoverageGaps filter (index.js ~1966) also drops the "Heads up: Source coverage could not be checked" line that base appended to observed and money document answers.
- The classifier alone, for both a document question and a money question, gives {c:"fine", refuse:false, note:null}.

What is overstated:
- Not-found results are still provisional. Zero-row /unified still gets COVERAGE_INCOMPLETE (index.js 888), and a /think refusal with candidates still gets status coverage_incomplete with the "could not be checked" notice. Only the new coverage_classification field contradicts it ("fine").
- The coverage_unavailable gap and its detail still reach the model in every gaps array. The entity-fact test "an unavailable coverage registry does not discard exact retrieved evidence" shows that answering is intended.
- Ledger money figures stay bounded by the ledger's own coverage plan (ledger-answer.js 616-628). No wrong money figure and no fabricated absence claim results, so this is not P0 or P1.

Net effect: when an infrastructure read fails, the owner gets an answer or results that are positively labelled "fine", with no side note and no provisional status on raw search, while a paused source could be silently missing. That is a real, reproduced, but bounded mislabel: P2.

- Reproduction:

Probes are in C:\offload\review-gaps-scratch\verify-covunavail\.

1) probe.mjs, run as `node probe.mjs head` and `node probe.mjs base`. The base copy was extracted with git archive into the scratch dir. The probe copies the degraded-absence mkEnv harness: the D1 `FROM sources s` read throws, retrieval returns one drive row, and the question is "what does the synthetic record support".

Head output:
- unified: {"coverage_classification":"fine","gaps":["coverage_unavailable"],"n":1}, with no status and no notice.
- think-answered: {"coverage_classification":"fine","gaps":["coverage_unavailable",...],"answer":"The retrieved record supports the answer [1].","confidence":75}, with no side_note.
- think-refused: {"status":"coverage_incomplete","notice":"...Source coverage could not be checked...","coverage_classification":"fine"}.

Base output:
- unified: {"status":"coverage_incomplete","notice":"The search found candidate records, but they did not support an answer. Source coverage could not be checked, so treat this result as provisional until source status is available.","gaps":["coverage_unavailable"],"n":1}.

2) probe-classify.mjs calls classifyQuestionCoverage with gaps [{type:"coverage_unavailable"}]:
- An email question with gmail evidence returns {c:"fine", refuse:false, note:null}.
- A money question with ledger evidence returns {c:"fine", refuse:false, note:null}.

3) Grep: primary_source is never set anywhere in worker/src or components. Its only occurrence is retrieval-status.js:398.


### 18. [P2] Exact contact-fact path drops leading name words, so 'Payer Taylor' can be answered from a card for 'Taylor'

- Area: refusal-rule. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/retrieval-status.js:82`; verifier: worker/src/lib/retrieval-status.js:83 (suffix loop in possessiveSubjectCandidates), consumed at worker/src/lib/entity-fact-answer.js:40-43 and :151-160
- Inputs: The question is 'What is Payer Taylor's email?'. The only labelled card in the retrieved window is 'Name: Taylor email: taylor@example.invalid' (a different entity sharing the surname), dated 5 days ago, native text, source_record lineage.
- Wrong outcome: The deterministic route (no model, no Sonnet check) answers 'As of 2026-10-18, the record lists Taylor's email as taylor@example.invalid. [1]' to a question about Payer Taylor. Before this diff, the possessive regex captured exactly 'Payer Taylor', so no row matched and it fell back. The 'the email for Payer Taylor' form still correctly returns null.
- Finder's evidence: possessiveSubjectCandidates emits every word suffix ('What is Payer Taylor', 'is Payer Taylor', 'Payer Taylor', 'Taylor'). questionFacts keeps all of those that pass safeSubject (entity-fact-answer.js:35-44). factFromCard then accepts the first candidate that equals the card's Name. Probe probe-entity.mjs reproduced the answer above.
- Fix: Strip only a closed set of leading request words (what is / what's / give me / find / look up / please / I need) and keep the remaining name whole. Never emit shorter suffixes of the name itself.
- Verifier's fix note:

Do not emit word suffixes of the name. In possessiveSubjectCandidates, strip one optional leading request phrase from a closed set, then an optional "the", and return the rest whole as the only candidate. The closed set: please, what is / what's / what’s, give me, find, look up, show me, tell me, I need.

Example:
const rest = value.trim().replace(/^(?:please\s+)?(?:what(?:\s+is|['’]s)|give\s+me|find|look\s+up|show\s+me|tell\s+me|i\s+need)\s+/i, "").replace(/^the\s+/i, "");
return rest ? [rest] : [];

A minimal alternative keeps the loop but accepts a suffix only when every dropped word is in that closed request-word set. Under either fix, "Payer" is never dropped, so the "Taylor" card does not match and the question falls back to the verified general path.

Add a regression case to worker/test/entity-fact-answer.test.mjs: "What is Payer Taylor's email?" with only a "Name: Taylor" card must not use exact_contact_fact. The existing positive cases ("Give me Example Contact's email address.", "Find Example Contact’s email address.", "Example Contact's email?") must still pass.

- Verifier's reasoning:

I traced the path in the head and could not refute it.

1. contactFieldIntent (retrieval-status.js:91-103). For "What is Payer Taylor's email?", the third lookup captures "What is Payer Taylor". possessiveSubjectCandidates (retrieval-status.js:76-89) has a loop at line 83 that emits every word suffix: "What is Payer Taylor", "is Payer Taylor", "Payer Taylor", "Taylor". The only early exit is for my/our/their/his/her/its.
2. questionFacts (entity-fact-answer.js:35-44) keeps every candidate that passes safeSubject. All four pass, because safeSubject bans only and/or/former/previous/old/not/unknown/my/our/the/their/this/that.
3. resultNamesSubject (entity-fact-answer.js:28-33) accepts a row if any candidate equals its card label. "name: taylor " matches the bare suffix "taylor", so related.length === 1 and the single-record guard at line 135 passes.
4. The loop at entity-fact-answer.js:151-160 takes the first candidate that factFromCard accepts. factFromCard (line 83) compares the card's Name to the candidate, not to the full asked name, so "Taylor" wins.
5. The route-level checks in worker/src/index.js do not stop it:
   - newestCurrentEvidence and currentEvidence (index.js:1360, 1460) pass.
   - PRESENT_STATUS_ASSERTION applies only when the question explicitly asks about the present.
   - The verdict for factAnswer is hard-coded to supported/complete (index.js ~1668).
   - The verifier model is skipped for factAnswer (index.js ~1643).

Reproduction:
- Pure function: the claimant's probe, copied to my scratch folder, gives the claimed output.
- Full route: I ran a copy of the repo's own /think harness, which uses the real worker/src/index.js with an in-memory D1/Vectorize stub and no network. "What is Payer Taylor's email?" with only a "Name: Taylor" card returns answer "As of 2026-10-06, the record lists Taylor's email as taylor@example.invalid. [1]". The evidence gate is method exact_contact_fact, supported:true, complete:true, with answer model calls 0 and verifier calls 0. This happens with client null and with client "Taylor".
- Controls: "What is the email for Payer Taylor?" falls back to the general path. With both a "Taylor" card and a "Payer Taylor" card in the window, it also falls back, because related.length is 2.
- Base 99bf39be: the same probe against the base module (git archive into scratch) returns null for both question forms. The old POSSESSIVE_QUESTION captured exactly "Payer Taylor" and required the record text to include it. So this diff introduced the regression.

Severity: P2, as claimed. The answer is a contact fact presented as verified, for a different entity, with the identity check skipped. That check is the one the general path's rule 6 and the verifier exist to enforce. It also hits exactly when the asked person's card is missing, which is when the owner should get a fallback, not someone else's email. It is not money and not an absence claim. It is bounded:
- It needs a card whose Name equals a trailing word-suffix of the asked name. Company names are a realistic case, for example "North Star Plumbing" vs "Star Plumbing".
- No card for the full name can be in the window.
- The answer prints the card's own name ("Taylor's"), which an attentive owner might notice.
An owner who reads it as the answer about Payer Taylor and emails that address acts on wrong information, which is close to P1.

- Reproduction:

Scratch dir C:\offload\review-gaps-scratch\verify-possessive-suffix\

(1) probe-entity.mjs is the pure-function probe against the head. Output:
- "What is Payer Taylor's email?" => {answer:"As of 2026-10-18, the record lists Taylor's email as taylor@example.invalid. [1]", ...}
- "What is the email for Payer Taylor?" => null

(2) probe-base.mjs runs the same probe against base 99bf39be (extracted with git archive into scratch\base). It returns null for both questions.

(3) e2e.test.mjs copies the /think harness from worker/test/entity-fact-answer.test.mjs, pointed at C:\offload\review-gaps\worker\src\index.js. Run `node --test e2e.test.mjs`. The case uses rows=[{client:null, text:"Name: Taylor\nemail: taylor@example.invalid", native, source_record lineage, dated 1 day before the anchor}] and q="What is Payer Taylor's email?".
- Result: body.answer = "As of 2026-10-06, the record lists Taylor's email as taylor@example.invalid. [1]", evidence_gate = {method:"exact_contact_fact", supported:true, complete:true}, counts.answer=0, counts.verifier=0.
- The same result occurs with client:"Taylor".
- Control: a card for "Payer Taylor" answers correctly.
- The of-form question and the two-card window both fall back to the model path. Those two arms fail only on the copied harness's premise_temporal timing assertion, which is a harness artifact and not relevant.


### 19. [P2] QuickBooks money answers (observed balances and open items, money-policy answers) now carry no source-coverage warning at all, although the prompt still tells the model the app will add one

- Area: completeness. Finder severity P2, verifier severity P2.
- Location: `worker/src/index.js:1967`; verifier: worker/src/index.js:1967 (Heads up filter). Rendering gap: worker/src/lib/answer-render.js:89 and frontend/src/lib/answer-render.js:67 (answerText ignores side_note; used by brain.mjs:4486 and frontend/src/components/Ask.tsx:302). Stale prompt text: worker/src/index.js:1444.
- Same root cause as: #4, #10 (side_note is not shown by /app Ask or `brain ask`).
- Inputs: QuickBooks connected and its sync failing (sync_broken) since 30 hours ago, so lastGood is under 48h. Owner asks 'What QuickBooks invoices are still open?' or 'What are my QuickBooks bank balances?', which go to quickBooksOpenItemsAnswer or quickBooksBalanceAnswer (no model), or to a money-policy answer.
- Wrong outcome: At base, the answer text ended with 'Heads up: The "quickbooks" source stopped updating 1 day(s) ago: the last sync reported an error. Anything added since is not in the brain.' At head the answer has no Heads up and no side_note, because the gap is under 48h. From 48h on, the warning exists only in side_note, which /app Ask and `brain ask` do not show. The owner sees a list of 'still open' invoices or balances with no sign that the feed is broken, and may chase an invoice paid after the sync stopped.
- Finder's evidence: index.js:1966-1971 now drops every sourceCoverageGaps member from the Heads up. The gaps are the same objects, added by reference at index.js:1264. The answer-model prompt for money-policy answers (index.js:1444) still says 'Do not write a Heads up line; the application appends the computed gaps after verification', and observed answers use no model at all. So for these money paths the app was the only carrier of the warning. Found by code reading, not executed. The refusal-rule reviewer listed the Heads up change as an unfiled design risk; this adds the prompt contradiction and the observed-answer path that has no model to fall back on.
- Fix: For observedAnswer and moneyPolicy answers, keep appending source-coverage gaps for the answer's primary or evidence sources whose type is sync_broken, sync_review, coverage_stale or never_synced, whatever their age. Or add those gaps to side_note without the 48h quiet window. Also update the money-policy prompt text so it matches what the app actually appends.
- Verifier's fix note:

1. Have classifyQuestionCoverage (retrieval-status.js) also return the gap objects it put in `notable`, as notable_gaps.

2. At index.js:1966-1971, for observedAnswer || moneyPolicy answers, remove from the Heads up only the source-coverage gaps that are in questionCoverage.notable_gaps, since side_note already carries those. Keep every other sourceCoverageGap whose gapSourceKind is in questionCoverage.primary_sources, such as a sync_broken, sync_review or coverage_stale gap under 48h on the QuickBooks source. Equivalently: for money answers, emit a side_note for primary-source sync_broken and sync_review gaps whatever their age.

3. Make the side note visible on the owner surfaces. In answerText (both answer-render.js copies), when r.answer is a supported answer and typeof r.side_note === 'string', return `${r.answer}\n\n${r.side_note}`. Then drop the separate side_note push in mcp-endpoint.js:333 so it is not shown twice.

4. Change the money-policy sentence at index.js:1444 to say the application appends non-coverage gaps and that source freshness is reported in the side note.

5. Add a head test: a QuickBooks observed open-items answer with a <24h snapshot and status='error' must show a QuickBooks freshness line in answerText(body).

- Verifier's reasoning:

The regression is real, but the claim's example inputs cannot happen.

Unreachable as stated. A QuickBooks sync broken 30h ago cannot produce a list of "still open" invoices or balances. Both observed paths drop any balance snapshot older than 24h: quickbooks-open-items.js:53 and quickbooks-balance.js:51 (now - time > 86400000 returns null). The money contract does the same at quickbooks-money.js:125. With a 30h-old snapshot, quickBooksOpenItemsAnswer returns null and the contract lists no invoice money lines (I dumped the prompt to check). So no figure is shown, and the claimed "From 48h on" outcome for observed answers is also unreachable.

Reachable, and reproduced on head vs base (99bf39be, run from a git-archive copy):
(1) Observed path. The last good snapshot is 20h old and the next sync errored (sources.status='error', so a sync_broken gap). At base the answer ends with 'Heads up: ... The "quickbooks" source stopped updating 0 day(s) ago: the last sync reported an error. Anything added since is not in the brain.' At head that sentence is gone. Classification is "fine" and there is no side_note, because the gap is under 48h.
(2) Money-policy path on historical QuickBooks records. BillPayment rows have no 24h age gate (quickbooks-money.js:119-125). Question: 'How much did we spend with Vendor One in QuickBooks...'. With the feed broken for 30h or 72h, base names the broken QuickBooks feed in the Heads up. Head drops it at both ages. At 72h head sets only side_note.

Why the warning disappears:
- index.js:1966-1971 now filters every sourceCoverageGaps member out of the Heads up. The gaps are the same object references unshifted at index.js:1264.
- The money-policy prompt (index.js:1444) and the contract text (quickbooks-money.js:167) forbid the model from writing a Heads up. The observed path uses no model at all. So the app was the only carrier.
- side_note covers only gaps 48h or older (renderCoverageSideNote, retrieval-status.js). Even then it is ignored by answerText (worker/src/lib/answer-render.js:89; frontend copy :67). answerText is the only renderer for `brain ask` (brain.mjs:4486) and /app Ask (frontend/src/components/Ask.tsx:302). The branch changed neither.
- Hosted MCP prints side_note but not gaps (mcp-endpoint.js:332-333). Local MCP still passes the raw gaps.

Mitigation that weakens the claim: the confidence line, which both the CLI and /app Trust show, still adds the unnamed basis 'a source has stopped updating recently' for sync_broken (confidence.js gapAdjustments). It gives no hint for coverage_stale or sync_review. Observed lines also carry 'as of <date>'.

The stale prompt sentence at :1444 has no owner-visible effect on its own. No wrong figure is presented, so this is a bounded, misleading omission: P2.

- Reproduction:

Probes in C:\offload\review-gaps-scratch\verify-qb-headsup\ (probe2.test.mjs, probe3.test.mjs). Each uses createProductFixture from the head checkout, ingests real syncQuickBooksOnline output with snapshotAt = NOW - N hours, then runs UPDATE sources SET status='error', last_ingest_at=snapshotAt, last_complete_sweep_at=snapshotAt, expected_refresh_seconds=604800, then POSTs /api/rag/think. Run with `node --test probe2.test.mjs`. PROBE_ROOT points to a git-archive copy of 99bf39be for the base run.

probe2, age 20h, 'Which customers have unpaid invoices in QuickBooks, and how much does each one owe?':
- Head: evidence_gate.method=quickbooks_observed_open_items, three 'owes USD 7x.00 ... as of 2026-10-06' lines. The Heads up has only the keyword_only_indexing and single_corpus text. coverage_classification=fine, side_note=null.
- Base: the same answer plus 'The "quickbooks" source stopped updating 0 day(s) ago: the last sync reported an error...'.
- Ages 30h and 72h: no observed answer and no contract money lines (the 24h gate), so the claim's exact scenario cannot occur.

probe3, BillPayment rows, 'How much did we spend with Vendor One in QuickBooks, and what were the bills or payments for?':
- Base at 30h and 72h: the Heads up includes the named QuickBooks 'stopped updating 1/3 day(s) ago' text.
- Head at 30h: no QuickBooks warning, side_note=null.
- Head at 72h: no warning in the answer, side_note='Side note: quickbooks has not refreshed since Sun Oct 4...'. answerText(body) does not include it.
- On every head run the confidence line still ends with 'a source has stopped updating recently'.


### 20. [P2] /app Ask drops the reviewed next step from every hard ledger refusal and mislabels it 'Answer withheld by an evidence check' or 'This result is provisional'

- Area: completeness. Finder severity P2, verifier severity P2.
- Location: `frontend/src/lib/retrieval-status.js:108`; verifier: frontend/src/lib/retrieval-status.js:108 (app allowlist has no ledger:* entries); frontend/src/lib/answer-render.js:106-127 (confidenceText labels by status alone; nextActionText drops unknown next_action). For the entity-selector input: worker/src/lib/ledger-answer.js:186-206 (the hardLedgerRefusal body echoes no entity_scope), so the body is rejected at frontend/src/components/Ask.tsx:235-238.
- Inputs: Signed-in /app Ask with a business or entity scope selected, asking 'What is my balance?' (retrieval_scope_restricted). Or any owner whose ledger read fails (ledger_unavailable), whose feed never synced, or who has no linked account.
- Wrong outcome: /app shows the notice, then 'Answer withheld by an evidence check. No confidence percentage is shown.' (non-coverage refusals) or 'Source coverage is incomplete. This result is provisional.' (catastrophic refusals), and no Next line. The only remedy, e.g. 'Next: ask again as the full owner without a source, document or entity filter.' or 'Next: retry once, then check the Brain's ledger health...', is hidden. An owner using the entity selector cannot tell that the selector causes every bank question to be refused.
- Finder's evidence: The Worker's REFUSAL_NEXT_ACTIONS now adds ledger:* actions (worker/src/lib/retrieval-status.js:534-545), and hardLedgerRefusal sends them as next_action. The app renders with its own copy (frontend/src/lib/retrieval-status.js:108-118, unchanged by the diff, no ledger keys). Its nextActionText (frontend/src/lib/answer-render.js:124-127) returns null for any next_action outside that copy, and confidenceText (lines 106-112) labels by status alone. Probe C:\offload\review-gaps-scratch\critic\probe-app-next.mjs feeds real withLedgerAnswer refusal bodies to both renderers. worker_cli_next shows the action; app_next is null for both the entity-scope and the unreadable-ledger refusal; app_confidence prints the two misleading labels above.
- Fix: Have the frontend import the Worker's REFUSAL_NEXT_ACTIONS and LEDGER_REFUSAL_POLICIES, or add the ledger:<reason> entries to the frontend copy. Render a ledger-specific line keyed on ledger_refusal_class instead of the generic withheld or provisional text. Rebuild worker/src/lib/app-assets.js and add a parity test between the two allowlists.
- Verifier's fix note:

1. Add every `ledger:<reason>` next action to the app allowlist. Either import LEDGER_REFUSAL_POLICIES into frontend/src/lib/retrieval-status.js, or copy the 16 entries into it. Then extend frontend refusalNextAction to accept ledgerReason, matching the Worker's version.

2. In frontend answer-render.js, when ledger_refusal_class is present, have confidenceText return a ledger-specific line instead of the generic withheld or provisional text. For example: "The bank ledger did not answer this question. No figure is shown."

3. In withLedgerAnswer, pass entityScope into hardLedgerRefusal. When entityScope.applied is set, add `entity_scope: entityScope` to the refusal body, the same way the document path echoes it. Then Ask.tsx renders the refusal and its Next line ("ask again as the full owner without a source, document or entity filter") instead of the "could not prove narrowed" banner.

4. Rebuild worker/src/lib/app-assets.js. Add a test that feeds real hardLedgerRefusal bodies (whole-Brain, plus one with entity scope) through frontend nextActionText and scopedAnswerLabel, and asserts the Worker's next_action is shown. Also add a parity check: every Worker REFUSAL_NEXT_ACTIONS key exists in the app map. Keep the existing per-surface wording for coverage_incomplete.

- Verifier's reasoning:

I could not refute this one for whole-Brain owner asks. For asks with the entity selector on, the claim describes the wrong screen, and its fix would not reach that case.

Path (head 0ecf2b0):
- /app Ask (frontend/src/components/Ask.tsx:207-312) posts to /api/rag/think.
- handleThink (worker/src/index.js:1109) wraps every ask in withLedgerAnswer.
- Before this diff, most ledger reasons fell through to the document path through next(gap). Only six reasons returned a bare refusal, and that refusal had no status and no next_action.
- Now every ledger refusal reason goes to hardLedgerRefusal (worker/src/lib/ledger-answer.js:175-207, called at lines 628 and 645). That function sets status to answer_withheld or coverage_incomplete and sets next_action from refusalNextAction({ledgerReason}).
- refusalNextAction returns the new ledger:* entries (worker/src/lib/retrieval-status.js:534-554). Those entries were added by this diff.

The app never shows those actions:
- The app renders with its own copy. frontend/src/lib/retrieval-status.js:108-118 was not changed by the diff and has no ledger keys.
- The built bundle worker/src/lib/app-assets.js was not rebuilt either. It holds 0 copies of the ledger action text.
- nextActionText (frontend/src/lib/answer-render.js:124-127) returns null whenever a next_action key is present but not in that local list.
- Trust (Ask.tsx) shows confidenceText only when unavailableSearch is true. absenceUnproven is true for both statuses, so the generic label is what the owner sees.

My probe (C:\offload\review-gaps-scratch\refute-app-next\probe-all-reasons.mjs) builds each refusal body from the Worker's own policy table. For all 16 entries in LEDGER_REFUSAL_POLICIES, app_next is null. The 9 non-catastrophic reasons get "Answer withheld by an evidence check...". The 7 catastrophic ones get "Source coverage is incomplete. This result is provisional."

Concrete case: a whole-Brain owner whose ledger read fails, or whose asked period is outside coverage, or who has no linked account, or whose balance is unavailable. In those cases the notice gives only the cause. For example: "The ledger's proven history does not reach the start of the requested period. ****NNNN: covered through ..." The reviewed remedy is the only instruction, and it is hidden. Here "Source coverage is incomplete" also names the wrong cause for a ledger that could not be read.

Exception: for cash_flow, the two merchant reasons, coverage_review_required, bank_export_overlap and account_link, the gap detail already contains the remedy. So the loss there is small.

No existing test catches this. test/integration-0417-contract.test.mjs checks the app only against bodies that have no next_action key. The degraded-absence test checks the Worker map only.

Correction for the entity-selector case: in Ask.tsx the app never reaches the renderers the claim describes. hardLedgerRefusal echoes no entity_scope. So scopedAnswerLabel (frontend/src/lib/owner.ts:113-122) returns null, and Ask.tsx:235-238 shows an error banner instead of the answer: "The Brain could not prove that this answer was narrowed to <label>. No whole-Brain answer is being shown as narrowed to that selection." Probe probe-ask-flow.mjs reproduces this.

So an owner with the selector on still gets no Next line, and still cannot tell that the selector is why every bank question is refused. The banner points them at a scoping failure instead. This is also a regression from base: before the diff, this case fell through to the document path, which echoes entity_scope.

Severity: P2. Nothing shows a wrong figure or an absence claim, and the cause notice still renders. But every hard ledger refusal on the main signed-in surface loses its reviewed remedy, and the entity-selector case shows a misleading error.

- Reproduction:

Scratch dir: C:\offload\review-gaps-scratch\refute-app-next.

1. `node C:\offload\review-gaps-scratch\refute-app-next\probe-all-reasons.mjs` builds a body from refusalNextAction({status, ledgerReason}) for each LEDGER_REFUSAL_POLICIES reason. It feeds the body to frontend answer-render.nextActionText and confidenceText. Every reason gives app_next = null, plus the generic withheld or provisional label.

2. `node C:\offload\review-gaps-scratch\refute-app-next\probe-ask-flow.mjs` follows the Ask.tsx submit and render steps on real withLedgerAnswer bodies. It uses the shipped frontend answer-render.js and owner.ts, with a resolve hook for imports that have no file extension.
   - Whole-Brain owner with an unreadable DB, asking "What were my deposits in October 2026?":
     - text: "The bank ledger could not be read for this request. No authorized account coverage was available. Document dates do not measure bank-feed freshness."
     - gate note: "Why no answer was shown: The bank ledger could not be read for this request."
     - trust: "Source coverage is incomplete. This result is provisional."
     - next: null. The Worker sent "Next: retry once, then check the Brain's ledger health before asking again."
   - Entity scope set (entity_slug and entityScope.applied), asking "What is my balance?":
     - the body has no entity_scope, so Ask shows the error "The Brain could not prove that this answer was narrowed to Acme LLC. No whole-Brain answer is being shown as narrowed to that selection."

3. `grep -c "ask again as the full owner without a source" C:\offload\review-gaps\worker\src\lib\app-assets.js` prints 0, so the shipped bundle lacks the ledger actions.

The critic's probe C:\offload\review-gaps-scratch\critic\probe-app-next.mjs reproduces the renderer-level output it claims.


### 21. [P3] Multi-account balance answer puts the oldest account's 'As of' date in front of every account line

- Area: ledger-only-money. Finder severity P3, verifier severity P3.
- Location: `worker/src/lib/ledger-answer.js:633`; verifier: worker/src/lib/ledger-answer.js:633 (prefix comes from worker/src/lib/retrieval-status.js:425 via balanceCoveragePlan oldest-observation selection at worker/src/lib/ledger-answer.js:94-106)
- Inputs: Fresh live checking ****1111 with a balance as of 2026-10-23, and a manual savings ****2222 snapshot as of 2026-09-20. Question: "What are my account balances?" balanceCoveragePlan (ledger-answer.js:72-106) picks the oldest observation, and classifyQuestionCoverage turns it into a single answer_prefix.
- Wrong outcome: The answer reads "As of 2026-09-20, account ****1111: $5,000.00 as of 2026-10-23 [1].\naccount ****2222: $800.00 as of 2026-09-20 [2]." The fresh checking figure is introduced with the stale savings date. The per-line as-of dates are still correct.
- Finder's evidence: C:\offload\review-gaps-scratch\focus1-money\probe-balance-prefix.mjs output.
- Fix: For balance answers, skip the whole-answer prefix and rely on the per-line 'as of' dates plus the side note, or attach the stale date only to the stale account's line.
- Verifier's fix note:

At ledger-answer.js:633, do not put the whole-answer prefix on a balance answer that has more than one account line. Each line already carries its own "as of" date, and the side note still names the stale source. For example:

const usePrefix = coverage.answer_prefix && !(plan.intent.kind === "balance" && answer.citations.length > 1);
answer: usePrefix ? `${coverage.answer_prefix} ${answer.answer}` : answer.answer

This keeps the single-account prefix behavior that ledger-answer.test.mjs:110, :263 and :403 assert.

Alternative: put the stale date only on the line or lines whose as_of_date (or live-member sync day) equals the prefix date.

Either way, add a test with a fresh live account and a manual account more than 14 days stale. It should assert that the fresh account's line is not introduced with the stale date.

- Verifier's reasoning:

I traced the path in the head and reproduced the claim with my own probe. The defect is real, and P3 is the right severity.

How the path works:
1. For a balance question, ledgerCoveragePlan (ledger-answer.js:109) sends it to balanceCoveragePlan (ledger-answer.js:72-106). That function collects every live-member sync time and every balance row's as_of_date, then takes the oldest (line 94). Here that is the manual savings snapshot, 2026-09-20. The function emits one ledger_coverage_stale gap carrying that date as calendarDay.
2. withLedgerAnswer (ledger-answer.js:617-625) passes the gap to classifyQuestionCoverage with evidenceSources ["ledger"]. The ledger is therefore the primary source. The gap is more than 14 days old, so retrieval-status.js:401-404 sets oldestCoveringPrimary, and line 425 returns answer_prefix "As of 2026-09-20,".
3. ledger-answer.js:633 adds that prefix to the front of the whole balance answer. ledgerAnswer (ledger-answer.js:290) builds that answer as one line per account, each with its own "as of" date. Nothing between these steps limits the prefix to the stale account. The prefix is new in this diff: the base returned answer.answer unchanged, and retrieval-status had no answer_prefix.

My probe used realistic data: the live checking snapshot has feed provenance and a feed sync on 2026-10-23, the timezone is America/Phoenix, and the manual savings snapshot is 2026-09-20. It returned "As of 2026-09-20, account ****1111: $5,000.00 as of 2026-10-23 [1].\naccount ****2222: $800.00 as of 2026-09-20 [2]." So the fresh checking figure is introduced with the stale savings date. Controls:
- Asking only for the checking balance gives no prefix.
- Savings only 5 days old gives no prefix, only the side note.

The defect therefore needs a multi-account balance answer with at least one account more than 14 days stale.

I could not refute it. No guard or test covers multi-account balances with mixed dates. The existing prefix tests (ledger-answer.test.mjs:110, :263, :403) all use a single effective account.

Why P3 and not higher: every money figure is correct and carries its own correct as-of date. The side note names the stale date. No figure is fabricated and no absence is claimed. The harm is a self-contradictory opening clause that wrongly dates the fresh account. An owner, or the host model relaying it, could read the checking figure as dated Sep 20, but the line itself says otherwise. That is bounded and minor.

- Reproduction:

Probe: C:\offload\review-gaps-scratch\verify-balance-prefix\probe.mjs. Run it with node from C:\offload\review-gaps.

Setup, using the money-fix fixture:
- Live checking ****1111: feed last synced 2026-10-23T17:00Z. Balance snapshot $5,000.00 as of 2026-10-23, provenance feed.
- Manual savings ****2222: account_kind savings, covered to 2026-09-20. Balance snapshot $800.00 as of 2026-09-20.
- now = 2026-10-23T18:00Z, BRAIN_TIMEZONE America/Phoenix.
- withLedgerAnswer called with question "What are my account balances?", owner scope, grantScope {all: true}.

Output:
- answer: "As of 2026-09-20, account ****1111: $5,000.00 as of 2026-10-23 [1].\naccount ****2222: $800.00 as of 2026-09-20 [2]."
- side_note: "Side note: bank ledger has not refreshed since Sun Sep 20, ..."

Controls:
- "What is my checking balance?" returns no prefix.
- With the savings snapshot at 2026-10-18 (5 days old), the answer has no prefix and only the side note.


### 22. [P3] Balance coverage dates mix UTC and owner-local days: the gap says 'last proved current on 2026-10-21' while the side note says 'not refreshed since Tue Oct 20'

- Area: dates-timezones. Finder severity P3, verifier severity P3.
- Location: `worker/src/lib/ledger-answer.js:94`; verifier: worker/src/lib/ledger-answer.js:94
- Inputs: BRAIN_TIMEZONE=America/Phoenix. Live feed synced 2026-10-21T03:30Z (Oct 20 at 20:30 local). Asked on 2026-10-23 ('What is my current balance?'). Plaid stores the balance's as_of_date as the UTC date of the sync (plaid-bank-feed.js:1039).
- Wrong outcome: The gap's covered_through and detail read 'The selected bank balance was last proved current on 2026-10-21'. The side note reads 'bank ledger has not refreshed since Tue Oct 20'. With real Plaid data the answer itself reads '... as of 2026-10-21'. The owner (or the local MCP model, which relays gaps) sees a balance 'as of Oct 21' next to 'not refreshed since Oct 20'. When the feed is more than 14 days old, the 'As of 2026-09-30,' prefix sits next to a gap that says 2026-10-01.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus3-dates\probe-balance.mjs, CASE2 and CASE3. Line 94 builds coveredThrough with `new Date(oldest.instant).toISOString().slice(0, 10)` (UTC), while formatCoverageGapDate and the prefix use the owner's time zone (retrieval-status.js:304-308, 427).
- Fix: Build coveredThrough with the owner time zone (export coverageCalendarDate and call it with timeZone), and say in the balance answer which convention its as_of date uses, or convert it the same way. One calendar convention should apply to every date in a single response.
- Verifier's fix note:

1. Export coverageCalendarDate from worker/src/lib/retrieval-status.js (line 273).
2. At ledger-answer.js:94, use `const coveredThrough = oldest.calendarDay || coverageCalendarDate(oldest.instant, timeZone);`. This puts covered_through and detail on the same owner-local day as the side note and the answer prefix.
3. Optionally, also set `coverage_calendar_date: coveredThrough` on the gap, so formatCoverageGapDate prints that same day.
4. For the in-answer contradiction ("As of 2026-09-30 ... as of 2026-10-01"), the balance answer needs the same convention. Either render a live balance's as-of day from the snapshot's recorded_at/observedAt instant in the owner's time zone, or drop the classifier prefix for balance answers that already carry their own as-of date. Converting Plaid's stored as_of_date at write time (plaid-bank-feed.js:1039-1041) would also work, but that changes existing stored data.

- Verifier's reasoning:

I traced the claim in the head and it holds. It is a real defect, but the damage is limited.

1. balanceCoveragePlan (worker/src/lib/ledger-answer.js:72-102) is new in this diff. When the oldest observation comes from a live member's last_synced_at, calendarDay is null. Line 94 then falls back to `new Date(oldest.instant).toISOString().slice(0, 10)`, which is a UTC day. That value goes into both `covered_through` and `detail` ("The selected bank balance was last proved current on ...").

2. The side note comes from renderCoverageSideNote (retrieval-status.js:330-335) via formatCoverageGapDate (retrieval-status.js:304-308). gapCalendarDay finds no plain YYYY-MM-DD value: coverage_calendar_date is absent, and last_good_sync_at is a full ISO instant. So the side note formats the instant in the owner's time zone. The answer prefix at retrieval-status.js:427 also uses the owner's time zone, through coverageCalendarDate.

3. Plaid writes a balance's as_of_date as `substr(observedAt,1,10)`, the UTC date of the sync (plaid-bank-feed.js:1039-1041). That code is older than this diff.

4. The output is reachable. withLedgerAnswer returns `gaps: allCoverageGaps` next to `side_note` (ledger-answer.js:633-635). components/brain-mcp.mjs:642 passes the gaps through unchanged, and its instructions (line 1028) tell the local model to "Keep every returned gap". No test pins the balance staleness gap; a grep for "proved current" finds it only in the source.

I reproduced it with a copy of the probe at C:\offload\review-gaps-scratch\verify-balance-utc\probe-plaid-utc.mjs, using Plaid-style UTC as_of_date values and BRAIN_TIMEZONE=America/Phoenix:
- Case 2 (sync 2026-10-21T03:30Z, asked 10-23): the answer says "as of 2026-10-21". The side note says "has not refreshed since Tue Oct 20". The gap says "last proved current on 2026-10-21".
- Case 3 (sync 2026-10-01T03:30Z): the answer itself reads "As of 2026-09-30, account ****4321: $987.65 as of 2026-10-01 [1]." The gap says 2026-10-01 and the side note says Wed Sep 30.

Severity: the money figure is correct and nothing claims an absence, so this is not P0. It is also not P1. The gap overstates freshness by at most one owner-local day, and only for syncs in the local evening, after UTC midnight. The visible harm is a one-day contradiction between the dates. The claimed P3 stands.

- Reproduction:

From C:\offload\review-gaps, run `node C:\offload\review-gaps-scratch\verify-balance-utc\probe-plaid-utc.mjs`. It builds a fixture with BRAIN_TIMEZONE=America/Phoenix and one live checking account whose feed last_synced_at is 2026-10-21T03:30:00Z (Oct 20 at 20:30 local). The balance snapshot as_of_date is 2026-10-21, matching Plaid's UTC substr. It then asks "What is my current balance?" at now=2026-10-23T18:00Z.

Observed:
- answer: "account ****4321: $987.65 as of 2026-10-21 [1]."
- side_note: "...has not refreshed since Tue Oct 20..."
- gaps[0].covered_through: "2026-10-21", detail: "...last proved current on 2026-10-21..."

With sync 2026-10-01T03:30Z, the answer becomes "As of 2026-09-30, account ****4321: $987.65 as of 2026-10-01 [1]." and the gap says 2026-10-01.


### 23. [P3] coverageCalendarDayEnd returns null for the day before a DST change at midnight, which silently drops freshness for manual ledger data

- Area: dates-timezones. Finder severity P3, verifier severity P3.
- Location: `worker/src/lib/retrieval-status.js:302`; verifier: worker/src/lib/retrieval-status.js:302 (non-converging loop at 289-301; null consumed at worker/src/lib/ledger-answer.js:87-89 and 133-135)
- Inputs: BRAIN_TIMEZONE=America/Santiago (also America/Havana, Africa/Cairo, Asia/Beirut). A manual account whose covered_to and balance as_of_date are 2026-09-05, the day before Chile's DST starts at local midnight. Asked 2026-10-23: 'What is my current balance?'.
- Wrong outcome: The answer is 'account ****4321: $987.65 as of 2026-09-05 [1].' It has no side note, no 'As of' prefix and no gaps, even though the data is 48 days old. The same fixture with covered_to 2026-09-04 gets the prefix and the 'has not refreshed since Fri Sep 4' side note.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus3-dates\probe-dayend.mjs returns NULL for Santiago 2026-09-05, Havana 2026-03-07, Cairo 2026-04-23 and Beirut 2026-03-28. probe-dst.mjs shows the missing note end to end. The 4-step correction loop (retrieval-status.js:289-302) cannot land on a local midnight that does not exist. The observation then becomes null and is filtered out (ledger-answer.js:87-89, 133-135).
- Fix: When the loop does not converge, return the last instant whose local date is still `day`: search between nextDay - 36h and nextDay + 36h for the first instant whose local date is the next day, and subtract 1 ms. Never return null for a valid date and a supported time zone.
- Verifier's fix note:

Replace `return null;` at retrieval-status.js:302 with a fallback that cannot fail. Set lo = nextDay - 36h and hi = nextDay + 36h. Binary-search for the first millisecond whose coverageCalendarDate(ms, zone) is later than `day`: while hi - lo > 1, take mid, and set hi = mid if coverageCalendarDate(mid, zone) > day, else lo = mid. Return hi - 1. A well-formed day in a supported zone then never returns null. Verified in the scratch sketch: Santiago 2026-09-05 gives 2026-09-06T03:59:59.999Z, Havana 2026-03-07 gives 2026-03-08T04:59:59.999Z, Cairo 2026-04-23 gives 2026-04-23T21:59:59.999Z, and Beirut 2026-03-28 gives 2026-03-28T21:59:59.999Z.

Add unit tests for those four zone/day pairs. Also add a ledger-answer test: a Santiago manual account with as_of_date 2026-09-05, asked on 2026-10-23, must carry the ledger_coverage_stale gap and the "has not refreshed since" side note.

Optionally, defense in depth: in ledger-answer.js, when a well-formed calendar day yields a null observation, fall back to Date.parse(`${day}T23:59:59.999Z`) rather than dropping it. A stale manual account then cannot vanish from the oldest-observation calculation.

- Verifier's reasoning:

I traced the code and reproduced the bug. coverageCalendarDayEnd (worker/src/lib/retrieval-status.js:278-303) is new in this diff. It starts at nextDay = UTC midnight and runs up to 4 correction steps toward the owner-local midnight. In zones where DST starts at local midnight, that midnight does not exist. In America/Santiago, local 2026-09-06 00:00 is skipped and the clock goes from 23:59:59 -04 to 01:00 -03 at 04:00Z. The loop then bounces between 03:00Z (local 23:00 on 09-05, adjustment +1h) and 04:00Z (local 01:00 on 09-06, adjustment -1h). It never reaches adjustment 0, so it falls through to `return null` at line 302.

Both callers drop a null observation. In balanceCoveragePlan (ledger-answer.js:87-89, then `.filter(Boolean)`), if nothing else is observed, the early return `if (!observations.length) return { gaps: [] }` fires. In the period path (ledger-answer.js:133-135), lastGood is null, so `stale` is false.

The installer sets BRAIN_TIMEZONE straight from the machine's IANA zone (brain.mjs:3019, 22082). There is no allowlist, so an owner whose machine is set to one of these zones reaches this path. No test covers these zones.

I ran copies of the probes from my scratch dir on Node 24.18. coverageCalendarDayEnd returns NULL for Santiago 2026-09-05, Havana 2026-03-07, Cairo 2026-04-23 and Beirut 2026-03-28. US zones are correct, including both New York transitions. End to end, with a manual account (covered_to and as_of_date both 2026-09-05, now 2026-10-23), the owner sees "account ****4321: $987.65 as of 2026-09-05 [1]." with no side note and 0 gaps. The same fixture with 2026-09-04 gets the "As of" prefix and the "has not refreshed since Fri Sep 4" side note.

The same drop has a second form. If a live account synced recently sits next to a manual account stuck on the affected day, the null observation is filtered out and the fresh one is the oldest left, so again no note appears.

Severity stays P3. The money figure is correct, and the answer line still shows the inline "as of 2026-09-05" date, so the owner is not told a false fact. What is lost is the staleness side note and prefix. That happens only for manual (calendar-day) observations dated exactly on the day before a midnight DST change, which is about one day a year in a few non-US zones. A period answer that runs past covered_to still gets its partial-coverage note, because `partial` is computed separately.

- Reproduction:

Run `node C:\offload\review-gaps-scratch\verify-dst-dayend\probe-dayend.mjs`. Santiago 2026-09-05, Havana 2026-03-07, Cairo 2026-04-23 and Beirut 2026-03-28 all print NULL. New York and Phoenix print correct local 23:59:59.999 ends.

Run `node C:\offload\review-gaps-scratch\verify-dst-dayend\probe-dst.mjs`. It uses createProductFixture with BRAIN_TIMEZONE=America/Santiago and a manual account 4321 whose fin_account_coverage.covered_to and fin_balance_snapshots.as_of_date are both 2026-09-05. It calls withLedgerAnswer with "What is my current balance?" at now=2026-10-23T18:00Z. Output: answer "account ****4321: $987.65 as of 2026-09-05 [1].", side_note undefined, gaps 0. The control run with 2026-09-04 gives answer "As of 2026-09-04, ..." and the side note "bank ledger has not refreshed since Fri Sep 4...", gaps 1.

`C:\offload\review-gaps-scratch\verify-dst-dayend\probe-fix.mjs` checks the fallback sketch. It returns 2026-09-06T03:59:59.999Z for Santiago and the correct ends for the other three zones, where local is still the day and +1ms is the next day.


### 24. [P3] Side-note dates leave out the year, so a source paused for 13 months reads like a recent pause

- Area: dates-timezones. Finder severity P3, verifier severity P3.
- Location: `worker/src/lib/retrieval-status.js:270`; verifier: worker/src/lib/retrieval-status.js:268-271 (formatCoverageDate), called from formatCoverageGapDate at 305-309 and from renderCoverageSideNote at 335
- Inputs: A non-primary source (for example Gmail on a ledger balance question) with a sync_review gap whose last good sync is 2025-09-01T18:00Z. Asked 2026-10-23.
- Wrong outcome: The side note reads 'Gmail has been paused since Mon Sep 1, so anything only in Gmail after that date may be missing.' The owner reads that as this year's Sep 1, about 7 weeks ago, when the pause is over a year old. A non-primary source gets no 'As of YYYY-MM-DD,' prefix, so nothing shows the year.
- Finder's evidence: Probe C:\offload\review-gaps-scratch\focus3-dates\probe-window.mjs ('year-old non-primary pause'). formatCoverageDate formats only weekday, month and day (retrieval-status.js:268-271). shortLedgerDay also drops the year (line 310-315).
- Fix: Add the year to formatCoverageDate and shortLedgerDay when the date is not in the owner-local current year, or when it is more than about 300 days before now. For example: 'Mon Sep 1, 2025'.
- Verifier's fix note:

1. Pass `nowMs` from `renderCoverageSideNote` through `formatCoverageGapDate` into `formatCoverageDate`.
2. In `formatCoverageDate`, also request `year: "numeric"`. Compare that year with the owner-local year of `nowMs` (the same timezone; use UTC for the calendar-day branch). When they differ, return `${weekday} ${month} ${day}, ${year}`, for example "Mon Sep 1, 2025".
3. Optional: do the same in `shortLedgerDay(day, nowMs, timeZone)` so a ledger range that crosses a year boundary also shows the year.
4. Add a test in the coverage tests: a non-primary `sync_review` gap with last good 2025-09-01, asked on 2026-10-23, must have a side note containing "Sep 1, 2025". A same-year gap must keep the short form.

- Verifier's reasoning:

The path runs end to end and nothing guards against it.
1. store-d1.js:4080-4088 creates a `sync_review` gap for any source whose `stale_reason` is NO_VERIFIED_WORK or the source-review code. That code stays set until the owner resolves the review, so the gap can last for months. store-d1.js:3772-3803 attaches a non-enumerable `last_good_sync_at`, taken from `last_ingest_at`, through `gapWithRemedy` and `withCoverageGapContext`. `sync_broken` gaps are built the same way.
2. index.js:1102-1112 reads the source coverage once and passes it to `withLedgerAnswer`. ledger-answer.js:157-163 passes those gaps through unchanged. ledger-answer.js:617-635 calls `classifyQuestionCoverage` with `evidenceSources ["ledger"]`, so Gmail is not a primary source here.
3. retrieval-status.js:403-410: a non-primary gap that is at least 2 days old goes into `notable`, and there is no upper age limit. `oldestCoveringPrimary` only counts primary gaps, so `answer_prefix` stays null and no "As of YYYY-MM-DD," prefix is shown.
4. retrieval-status.js:330-335 builds the clause with `formatCoverageGapDate`, which calls `formatCoverageDate` (lines 268-271). That function formats only the weekday, month and day.
5. mcp-endpoint.js:331-333 shows only the answer text and this side note on a supported answer. The gaps array, which holds the full ISO date, is not shown.

So the owner sees only "Mon Sep 1", and nothing else on screen gives the year. Only the weekday separates the two years: Sep 1 2026 is a Tuesday, Sep 1 2025 a Monday, and no owner would catch that. A `sync_broken` source last good on 2025-10-30 is worse: asked on 2026-10-23, "has not refreshed since Thu Oct 30" reads as a date a week in the future.

Why P3 and not higher: this only happens for non-primary sources. When Gmail is the primary source for a question, a gap over 14 days adds the "As of YYYY-MM-DD," prefix with the year, and a pause that started before the requested period is refused as catastrophic. The side note also still says the source is paused and still points to the same fix, reconnecting it. What goes wrong is that the owner underestimates how far back the missing records go (about 13 months, not about 7 weeks). They would only act on that if they later trusted that source for that period, and the primary-path guards cover that case.

`shortLedgerDay` (lines 311-316) also drops the year. Its only use is the primary-ledger `ledger_coverage_stale` clause, where any gap over 14 days already carries the year in `answer_prefix`, so that part is cosmetic.

- Reproduction:

Probe at C:\offload\review-gaps-scratch\verify-dates-year\probe.mjs, run with `node` from C:\offload\review-gaps. It calls `classifyQuestionCoverage({question:"What is my balance?", questionType:"money", evidenceSources:["ledger"], now:"2026-10-23T17:00:00.000Z", timeZone:"America/Phoenix", gaps:[gmail gap]})`. Each gap has non-enumerable `source_kind` and `last_good_sync_at`, the same shape store-d1 produces.
- `sync_review`, last good 2025-09-01T18:00Z: "Side note: gmail has been paused since Mon Sep 1, so anything only in gmail after that date may be missing." Prefix: null.
- `sync_broken`, last good 2025-10-30T18:00Z: "...has not refreshed since Thu Oct 30..." Prefix: null. Asked on Oct 23, this reads as a date in the future.
- `sync_review`, last good 2026-09-01T18:00Z: "...paused since Tue Sep 1..." Only the weekday differs from the year-old case.


### 25. [P3] New test added to the gate fails on Windows checkouts with core.autocrlf=true

- Area: refusal-rule. Finder severity P3, verifier severity P3.
- Location: `scripts/run-test-chain.mjs:19`; verifier: worker/test/practical-gaps-0419.test.mjs:483 and :587 (two unnormalized reads; their markers are at :491 and :589/:591). Wired into the gate at scripts/run-test-chain.mjs:19.
- Inputs: A local Windows checkout with core.autocrlf=true (this review checkout: i/lf w/crlf) runs npm test or the local Windows gate.
- Wrong outcome: worker/test/practical-gaps-0419.test.mjs fails 2 of 26 tests ('the four pure review mutants are killed' and 'the field-name source override restored mutant is killed'). Their mutation markers contain '\n', but retrieval-status.js is checked out with CRLF. The chain now runs this file, so the local Windows gate goes red with no product fault.
- Finder's evidence: node --test worker/test/practical-gaps-0419.test.mjs printed 'pass 24, fail 2' with 'mutation marker exists: "history_unproven",' false and 'the evidence-source union marker exists' false. git ls-files --eol shows w/crlf. .gitattributes pins only migrations to LF.
- Fix: Normalize the source before matching (source.replace(/\r\n/g, '\n')) in each mutant helper, or add 'worker/src/**/*.js text eol=lf' to .gitattributes.
- Verifier's fix note:

Use the repo's own convention (worker/test/money-veto-mutations.test.mjs:22). Normalize the source at every readFileSync of retrieval-status.js in worker/test/practical-gaps-0419.test.mjs (lines 453, 483, 525, 587, 610, 632):
`const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");`
This fixes the two failing markers and stops the same failure in any future multi-line marker.

Optional second layer: add `worker/src/lib/retrieval-status.js text eol=lf` to .gitattributes, with a comment like the existing brain.mjs entry. Existing Windows checkouts only pick that up after a renormalize or re-checkout, so the test-side fix is the one that should land.

- Verifier's reasoning:

I could not refute this one. The failure is real, it is caused only by line endings, and it is now part of the gate.

1. The test is in the gate. scripts/run-test-chain.mjs:19 adds "node --test worker/test/practical-gaps-0419.test.mjs" to POST_LAUNCHER_TEST_COMMANDS.

2. The working file has CRLF line endings. In this checkout core.autocrlf=true, and `git ls-files --eol` shows worker/src/lib/retrieval-status.js as "i/lf w/crlf attr/" with no attribute. .gitattributes pins many byte-sensitive files to LF (brain.mjs, upload-extract.js, bank-export.js, and others) but not this one.

3. Two tests search the raw file for markers that contain "\n".
   - "the four pure review mutants are killed" (worker/test/practical-gaps-0419.test.mjs:481) reads the file at :483 without normalizing it. It then looks for the marker '  "history_unproven",\n' at :491.
   - "the field-name source override restored mutant is killed" (:585) reads the file at :587. It looks for the two-line evidenceUnion marker at :589/:591.
   Each test asserts its marker exists before mutating, so both fail on a CRLF checkout.

4. The six other mutant tests in the file pass because their markers are single-line.

5. The established convention elsewhere in the repo is to normalize first. Other mutation tests do this: worker/test/money-veto-mutations.test.mjs:22, temporal-guard.test.mjs:281, plaid-reassignment-preview.test.mjs:10 and pending-short-projection-activates.test.mjs:23. The new file breaks that convention.

6. Wider reach (likely, not verified offline): .github/workflows/ci.yml runs `npm test -- --continue-on-failure` (:615) on a windows-latest matrix (:379), checked out by actions/checkout with no autocrlf override anywhere in the workflows. GitHub's Windows runners normally check out with CRLF, so the Windows CI lane would probably go red too, not just local Windows gates.

Severity: P3. This is test infrastructure only. The product code is correct; the LF blob at HEAD contains both markers. No wrong figure, false absence claim or bypassable guard reaches the owner. The cost is a red Windows gate with no product fault, which can hide real failures or push someone to ignore the lane.

- Reproduction:

Focused test in the review checkout (core.autocrlf=true):
`node --test worker/test/practical-gaps-0419.test.mjs`
Result: tests 26, pass 24, fail 2. The errors are "mutation marker exists:   \"history_unproven\"," (actual false) and "the evidence-source union marker exists" (actual false).

Probe script: C:\offload\review-gaps-scratch\crlf-verify\probe.mjs
It compares the working file, the HEAD blob (from `git show HEAD:worker/src/lib/retrieval-status.js`) and the working file with CRLF normalized. Output:
- worktree has CR: true; blob has CR: false
- history marker: worktree false, blob true, normalized worktree true
- union marker: worktree false, blob true, normalized worktree true

So the only cause is CRLF in the working file. Normalizing the line endings makes both markers match.


## Refuted or uncertain

- [refuted] For an approved manual+live account pair, the bounded window uses only the live member's covered_to, which cuts off covered manual rows and adds a false 'may be missing' note (`worker/src/lib/ledger-answer.js:120`; area dates-timezones; finder P2, verifier re-rated P3).

The code reading is right. groupAccounts returns {...primary} with the live member as primary (ledger-reader.js:100-108), and ledgerCoveragePlan bounds intent.to by min(account.covered_to) (ledger-answer.js:120-121). That covered_to is the live member's, and the plan never checks the member intervals that effectivePeriodCovered uses. With seeded rows, the claimant's probe reproduces the stated BASE and HEAD output.

The precondition cannot happen in production, though. The bug needs the manual member's coverage row to be coverage_status='complete', basis 'confirmed', and not flagged coverage_review_required. No writer in the head, or anywhere in the visible history since 95efd58, produces that row:
- Manual coverage comes only from fin-import.js coverageStatement (lines 471-474), which always inserts 'partial'. The comment there says "never complete". On conflict it keeps 'complete' only if the row was already complete, and that path writes the "Read from a bank export covering ..." basis note.
- ACCOUNTS_SQL (ledger-reader.js:22-23) flags that note on a complete row as coverage_review_required. ledgerCoveragePlan returns early on that flag (ledger-answer.js:116-118), and both base and head refuse with ledger_not_consulted:coverage_review_required.
- The other coverage writer, plaid-bank-feed.js:1087ff, writes only slugs that the same batch upserts with feed_mode='live' (plaid-bank-feed.js:1003-1021). So it never certifies a manual twin.
- Every other file that mentions fin_account_coverage only reads it, including financial-picture, fin-d1, qbo, plaid-account-entities, plaid-connection-review and the recovery adapter. No owner action writes coverage.
- The clean 'complete' manual row exists only in test fixtures, seeded by raw SQL with provenance 'owner_stated'.

With production-shaped data the head is correct. Manual coverage is 'partial' from an import, so effectivePeriodCovered ignores the manual member, and Sep 21-30 really is not certified. The head then answers "2026-09-01 through 2026-09-20: credits $100.00" with a true side note that Sep 21-30 may be missing. The base refused that same question outright (period_outside_coverage). So for reachable data this change is an improvement, not a regression.

What remains is a latent inconsistency: the plan's bound and the twin-aware coverage check disagree. It would matter only if a future writer certified manual statements as complete. Hence P3.

Reproduction: Probe: C:\offload\review-gaps-scratch\verify-linked-window\probe.mjs (run `node probe.mjs` from that folder; it imports the head and a base copy, old-ledger-answer.mjs, copied there). It uses the claim's scenario: approved manual+live pair ****4321, live 2026-09-01..09-20 last synced 2026-09-20T15:00Z, manual 2026-08-01..10-15, $100 live on Sep 10 and $700 manual on Sep 25, question "How much money came in September 2026?" asked at 2026-10-23.
(1) Manual coverage shaped as fin-import writes it ('partial', export note): BASE refuses with period_outside_coverage. HEAD gives $100 through 09-20 and a side note that Sep 21-30 may be missing. That note is accurate, since Sep 21-30 is not certified.
(2) Legacy 'complete' with the export note: BASE and HEAD both refuse with coverage_review_required.
(3) Test-only 'complete' with a clean note, a row no production writer creates: BASE gives $800 through 09-30. HEAD gives $100 through 09-20 with the side note. This is the only case where the claimed outcome appears.

- [refuted] When the question has a time window, the 48-hour quiet period is measured from now rather than from the window, so a source that broke inside the window gets no note at all (`worker/src/lib/retrieval-status.js:404`; area dates-timezones; finder P2, verifier re-rated P3).

The trace is right that classifyQuestionCoverage returns 'fine' with no side_note for a sync_broken Gmail gap under 48 hours old. But the claim's framing, that the quiet period is "measured from now rather than from the window", misreads what the rule does, and the claimed outcome overstates what the owner gets.

1) The window changes nothing, because the rule measures how long the pause has lasted. My probe runs the same 12-hour Gmail break as a "this week" question and as an unwindowed "What did the vendor email me?" question. Both return 'fine' with side_note null. The 33-hour "yesterday" case is also 'fine'. A 50-hour break with the same window returns stale_but_covering plus a side note. In every unwindowed question about recent mail, anything after lastGood is missing in exactly the same way. So this is the uniform 48-hour tolerance, not a window-handling mistake.

2) The 48-hour quiet is deliberate, documented and tested:
- Code: retrieval-status.js:333 and :404.
- Test: worker/test/practical-gaps-0419.test.mjs:57, "a six-hour Gmail pause is quiet", plus the exact boundary test at :155-171.
- Owner contract: templates/owner-contract/money-rules-v3.md:27 (and the v2 and windows copies) says "A pause under 48 hours may have no note."
- Policy: "answer first ... refuse only on catastrophic". This branch intentionally removed the base behavior where any gap marked every non-empty search coverage_incomplete.

Changing this is a product-policy call, not a code defect.

3) "Nothing in the answer or note says the rest is missing" is not accurate for the raw route. When rows exist and the classification is not catastrophic, handleUnified still returns `gaps: sourceCoverageGaps` (index.js:897-899). That includes the sync_broken gap, whose detail reads "...stopped updating 0 day(s) ago: <reason>. Anything added since is not in the brain." (store-d1.js:4074-4078). brain-mcp compactSearchGaps (brain-mcp.mjs:512-533) keeps that gap in full beside the Gmail rows, because the gap's source matches the rows' source. It is returned at brain-mcp.mjs:806. The MCP instructions (brain-mcp.mjs:1028) and answer-contract-v1.md:6 both say "Keep every returned gap, and never turn incomplete coverage into an absence claim." What really changed is a weaker instruction: the "describe as provisional" note is gone. The gap itself is not hidden.

4) Empty results are still covered. If the window has no matching rows, rows.length === 0 still yields coverage_incomplete (index.js:888), so no false "nothing recorded" claim follows.

What is left is at most a design refinement: a known sync_broken error could be treated differently from ordinary lag. That is bounded and documented, so it is not a real defect.

Reproduction: Probe at C:\offload\review-gaps-scratch\verify-window-quiet\probe.mjs. It imports classifyQuestionCoverage from C:\offload\review-gaps\worker\src\lib\retrieval-status.js with now=2026-10-24T01:00Z (18:00 Phoenix), timeZone America/Phoenix, evidenceSources ['gmail'] and a sync_broken gmail gap. Output:
- "this week" window, lastGood 12h old: fine, side_note null
- the same gap with NO window: fine, side_note null (identical, so the window is irrelevant)
- "yesterday" window, lastGood 33h old: fine, side_note null
- "this week" window, lastGood 50h old: stale_but_covering, with the side note "gmail has not refreshed since Wed Oct 21..."

Code reading: index.js:897-899 still returns the gap in `gaps` when there are rows, and brain-mcp.mjs:512-533 and :806 pass it through in full beside the Gmail rows.

- [refuted] A bank connection that has never synced blocks ledger questions scoped to a different, healthy account (`worker/src/lib/ledger-answer.js:615`; area refusal-rule; finder P2, verifier re-rated P3).

The code does what the claim says, but the input it starts from cannot come from adding a bank connection. If a `sources` row with kind 'plaid' and an expected refresh exists, withLedgerAnswer refuses even a mask-scoped question. Line 617 merges every registry gap into the list, retrieval-status.js:45 counts 'plaid' as a money primary, and retrieval-status.js:399 treats never_synced as catastrophic. The claim says "a second bank connection was just added" creates that row. It does not.

1. Plaid connections are stored in bank_feed_items and fin_accounts. Neither plaid-bank-feed.js nor bank-feed.js writes to `sources`, `source_events` or `sync_runs`.
2. The only bank-related `sources` row is the bank activity documents source (bank-activity-doc.js:13-14, kind "bank_activity"). recordSourcePass sets its expected_refresh_seconds=NULL, so it can never produce never_synced. Its kind normalizes to "bank-activity", which is not in the money primary set.
3. No migration, daily plan entry, provider scheduler or install step registers a plaid-kind source. A pickaxe search of the git history found no writer of one either.
4. A newly added connection that has never synced is handled by the ledger's own check, neverSyncedLiveGap (ledger-answer.js:60). That check runs only on the selected accounts, after the mask filter at line 605.

A probe against the real fixture DB, with the real coverageGapReport and withLedgerAnswer, showed this:
- Realistic state (second Plaid item never synced, its account ****9999 live with no sync): the registry gaps list is empty. "How much money came in this month in account ending 4321?" answers "credits $120.01". The all-accounts question refuses with live_feed_never_synced, as designed.
- The claimed state can only be produced by hand: `brain sources <manifest> --add second-bank --kind plaid` plus `--refresh daily`. Only in that state does the refusal appear. No product path creates that row and no doc tells anyone to create it.

What remains is a hardening note: a hand-registered plaid source would also never be updated, so it would block every money question. That is P3, not the claimed P2 field failure.

Reproduction: Probe at C:\offload\review-gaps-scratch\refute-plaid-registry\probe.mjs. Run it with `node C:\offload\review-gaps-scratch\refute-plaid-registry\probe.mjs` from C:\offload\review-gaps. It builds two states with createProductFixture, computes sourceCoverage with coverageGapReport(env, {allowedSources:null}), the same call coverageForRead makes for an owner, then calls withLedgerAnswer.

(A) Realistic: account ****4321 synced today, plus bank_feed_items 'second-feed' with last_synced_at NULL and a fin_accounts row ****9999, live, source_feed bank-feed:second-feed.
- registryGaps=[]
- Scoped question: answer "account ****4321, 2026-10-01 through 2026-10-23: credits $120.01; debits $0.00 [1]."
- All-accounts question: status coverage_incomplete, reason live_feed_never_synced (intended).

(B) Hand-inserted `sources` row ('second-bank', 'plaid', expected_refresh_seconds 86400, last_ingest_at NULL).
- Both questions: status answer_withheld, reason never_synced. This matches the claim's mechanics, but only under a manual registration that no product path creates.

Supporting reads:
- worker/src/lib/bank-activity-doc.js:13-14 and :355-362 (expected_refresh_seconds=NULL)
- worker/src/lib/ledger-answer.js:60-70 and :605
- no writes to `sources` in plaid-bank-feed.js or bank-feed.js

- [refuted] Same-name records without a card label are now ignored when checking for conflicting contact facts (`worker/src/lib/entity-fact-answer.js:28`; area refusal-rule; finder P3, verifier re-rated P3).

The code reading is right, but the harm is not caused by this diff. In the head, resultNamesSubject (worker/src/lib/entity-fact-answer.js:28-33) only counts a row whose `client` equals the subject, or whose snippet has a `name:/contact:/subject:/entity: <subject>` label. A prose email that names the subject is no longer counted, so `related.length` is 1 and the exact path answers. The base version used a substring scan, counted both rows, and returned null.

Returning null does not show the owner a different answer. In the route (worker/src/index.js:1300), `docs = results.slice(0, 12)`. The model prompt renders only `docs` (renderDocs at :1427), and the verifier checks only cited docs. In the claimed scenario the newer email sits outside the twelve docs, so the base fallback model saw only the same card. It would answer with the same old address, or with "the documents do not answer". The owner-visible outcome is the same before and after the diff. The existing test "conflict after the citation window" also shows `body.results` is capped at 12, so that row is never shown either way.

When the newer email is inside docs with a reliable date, the head still falls back. The `newest` check at :164-166 uses newestCurrentEvidence, which matches entity anchors anywhere in the client, title, text or snippet. The newer email outranks the card, so the card is not in `newest` and the result is null. My probe confirmed this (case B: head null, base null).

What remains:
(1) The comment at :126-128 is stale. It still says same-name records without a parseable card are "never silently ignored".
(2) One bounded variant outside this claim: an unlabelled conflicting record inside the twelve docs with an unreliable date (case C), or one with an exactly identical timestamp (case D), is skipped by both the label scan and the newest check. The exact path then answers where the base would have let the model see the conflict. The answer stays a true dated statement ("As of <day>, the record lists ..."), and the product's own rule 10/11 lets an undated record establish only history, not present status. So that variant is P3 at most.

None of this is a wrong money figure, a fabricated absence claim, or a regression an owner would act on wrongly in the claimed scenario.

Reproduction: Probe: C:\offload\review-gaps-scratch\verify-unlabelled-conflict\probe.mjs. It imports the head module, plus the base module from C:\offload\review-gaps-scratch\verify-unlabelled-conflict\base-entity-fact-answer.mjs. The base module comes from `git show 99bf39be` with its two imports pointed at head modules that this diff did not change. docs are built exactly as the route builds them: results.slice(0, 12) with n = index + 1, and currentEvidence = newestCurrentEvidence(q, docs).

Question: "What is Example Contact's email?"
A. The card is at rank 1, eleven filler cards follow, and the newer unlabelled email is at rank 13. Head returns the old address; base returns null. The docs the base model would see do NOT contain the new address, so the base fallback has only the same card to answer from.
B. The same email at rank 2 with a reliable newer date: head null, base null. The newest-evidence check catches it.
C. The same email at rank 2 with date_reliable 0: head returns the old address, base null. This is the bounded residual, not the claimed scenario.
D. The same email at rank 2 with a timestamp identical to the card's: head returns the old address, base null. Contrived tie.

Run: `node probe.mjs` from the scratch dir.

## Coverage by area

### ledger-only-money

I read the full diff 99bf39be..HEAD for ledger-answer.js, ledger-reader.js, retrieval-status.js, entity-fact-answer.js, index.js (handleThink, handleDocumentThink, unified search state), mcp-endpoint.js, components/brain-mcp.mjs, store-d1.js and the money-rules/answer-contract templates. I also read the surrounding code they rely on: classifyLedgerQuestion periods and windows, readEffectiveAccounts/Transactions/Balances, effectivePeriodCovered, ledgerAnswer text for every intent kind, Plaid coverage and balance writes, coverage gap assembly, answer-render, the /app Ask component and brain.mjs cmdAsk.

Every recognized ledger failure now hard-refuses: fallbackWithGap is unreachable because every gapFor reason is in LEDGER_REFUSAL_REASONS. I found no path where a document figure replaces or mixes into a recognized ledger answer. Ledger refusals carry results: [] in both MCP renderers. Entity-fact answers cover contact fields only, so no money is involved. Bounded totals, merchant, recurring and largest answers all print their bounded from..to and covered-through lines. For balances, a never-synced live member is refused, and a selected manual snapshot cannot hide it.

Probes are in C:\offload\review-gaps-scratch\focus1-money\. Base-commit comparisons ran against a `git archive` export there, with a junction to the existing node_modules. I ran the focused test worker/test/practical-gaps-0419.test.mjs: 24 passed and 2 failed. Both failures are mutation-marker string mismatches caused by the CRLF Windows checkout, not product defects. The review checkout was not modified (git status clean).

Not checked: the full test chain; generic Plaid feed (bank-feed.js) page-level last_synced_at semantics beyond reading them; bank_activity derived documents used by document-path money answers (unchanged by this diff); and whether a 'plaid'-kind document source is actually registered in real installs. The retrieval-status money set makes such a source primary for ledger answers, per finding 2.

### paused-absence

I did not modify the review checkout (git status stays clean). Probe scripts and a base 99bf39be export (via `git archive`) are in C:\offload\review-gaps-scratch\focus2\.

Checked and found sound for absence:
- Ledger absence paths:
  - A live feed that never synced gives a catastrophic refusal.
  - A requested period entirely after covered_to gives a catastrophic refusal.
  - Multi-account answers use the minimum covered_to.
  - Linked manual/live pairs use effectivePeriodCovered.
  - Balance staleness gets a side note.
  - Shortened windows restate their bounds in the `bounded` line.
  - All zero/"No ... found" texts use the shortened intent.to.
- The think route's zero-result branch and categorical refusals are still blocked by sourceCoverageBlocksAbsence (COVERAGE_INCOMPLETE).
- A catastrophic result inside an otherwise supported answer nulls the answer and becomes COVERAGE_INCOMPLETE.
- Hosted runAsk/runSearch and local brain_think/brain_search catastrophic branches drop rows and refuse.
- Entity facts only ever produce positive "As of" statements.
- Side-note dedupe and ordering: partial ledger gaps render first, and same-source gaps share last-good, so nothing is hidden.

Non-enumerable gap context (store-d1 withCoverageGapContext) survives everywhere the classification runs. It runs only in-Worker on the same objects.

Running the focused tests: complete-sweep-clears-provisional passes. practical-gaps-0419 passes 24 of 26. The 2 failures are the source-text mutant tests ("mutation marker exists"), which look like CRLF/line-ending markers on this Windows checkout, not a product defect.

Out of focus and not verified, worth a separate look:
- Every gapFor reason is now in LEDGER_REFUSAL_REASONS, so fallbackWithGap is dead code. Tax-scoped (ledgerEligible=false → unsupported_question) and grant/scope-restricted money-worded questions are hard-refused and no longer reach the document path.
- A store-family keyword in a ledger question ("spend at the Apple Store") makes a never-synced custom_api store feed primary, which could refuse an otherwise covered ledger answer.
- A stray row from an unregistered source makes that source primary, which turns the whole raw search catastrophic.

### dates-timezones

Scope: FOCUS 3 (side-note dates and time zones). Everything was read-only. I ran probes from C:\offload\review-gaps-scratch\focus3-dates\ (probe-balance.mjs, probe-period.mjs, probe-period2.mjs, probe-period2-old.mjs, old-ledger-answer.mjs, probe-linked.mjs, probe-dayend.mjs, probe-dst.mjs, probe-window.mjs, probe-window2.mjs). They import head modules from C:\offload\review-gaps. The base comparisons use a copy of 99bf39be's ledger-answer.js with its imports pointed at the head modules (those are unchanged except for one new column in ledger-reader).

Checked and found sound:
- formatCoverageGapDate formats a calendar-only date at noon UTC, so the weekday is right.
- The 48-hour and 14-day thresholds agree between the classifier (>=2d notable, >14d prefix) and the renderer (<2d skip), and give the same result for a numeric or an ISO `now`.
- The lastGoodInstant fallback chain handles explicit nulls correctly.
- The document-route periodStart comes from owner-local window instants (retrievalTimeWindow) or from brain-mcp's from, which is min(local midnight, UTC midnight). It is correct for Phoenix, UTC and Tokyo.
- coverageCalendarDayEnd is correct across US DST changes (New York, Mar 8 and Nov 1), Lord Howe's half-hour shift, Scoresbysund's 23:00 change and Kiritimati UTC+14. It fails only where DST changes at midnight (finding 6).
- store-d1's last_good_sync_at is last_ingest_at, which advances only on verified work (index.js:2875-2894), so 'paused/not refreshed since' really is the last success. The non-enumerable context fields survive because the gaps are passed by reference, never spread or copied, all the way to classifyQuestionCoverage.
- Multiple gaps per source are de-duplicated by label, first one wins. Store order puts sync_broken/sync_review first, so 'paused' wins when it applies.

Pre-existing, not reported as diff defects:
- Ledger intent days are UTC (ledger-question.js:13 ledgerDay). For a Phoenix owner, 'this month'/'today' flip at 17:00 local, and requested_through can name tomorrow's local date.
- Plaid stores covered_to and balance as_of_date as the UTC date of the sync (plaid-bank-feed.js:1039, 1099; ledger-reader.js:30). Findings 1 and 4 are new because the diff now bounds answers to that date and prints owner-local dates beside it.
- East-of-UTC owners (Tokyo) can get a conservative refusal for a period whose first local morning was synced, because covered_to is still the previous UTC day.

Not covered: primary-source mapping and the hard-refusal policy (other focuses). One example I saw: a tax question with ledgerEligible=false now hard-refuses with unsupported_question instead of falling through to documents. Tests pin this as intended, so I did not report it.

Focused test run: `node --test worker/test/practical-gaps-0419.test.mjs` had one failure at line 591. The cause is environmental: this checkout has CRLF line endings, and the test's multi-line source marker uses "\n". I did not run the full chain.

### refusal-rule

Scope: FOCUS 4, the refusal rule. I read the full diff for retrieval-status.js, ledger-answer.js, index.js (handleUnified, handleThink, handleDocumentThink), mcp-endpoint.js, brain-mcp.mjs, entity-fact-answer.js, store-d1.js (gap context, plus assessCoverageRows and sourceFreshnessSql), ledger-question.js, the four money-rules templates, answer-contract-v1.md, technician SKILL.md and run-test-chain.mjs. Probes are in C:\offload\review-gaps-scratch\focus4\. They use the repo's real SQLite product fixture, with no network and no keys: probe-classify, probe-ledger-e2e, probe-ledger-label, probe-future-e2e, probe-unregistered, probe-plaid-registry, probe-imap, probe-entity, probe-partial. I ran one focused test, worker/test/practical-gaps-0419.test.mjs: 24 pass, and 2 fail only because of CRLF. I did not modify the checkout; git status is clean.

Checked and sound:
- Recognized ledger refusals no longer fall back to document money figures.
- The non-enumerable gap context survives from coverageGapReport to the classifier and is dropped from JSON as intended.
- Partial-period ledger answers print the bounded from/to in the answer and keep zero or absence claims bounded.
- A balance only refuses on a never-synced live member or a missing observation.
- The MCP answer_prefix regex matches the classifier format.
- SKILL.md routing (search first on the built-in setup, think first on the Claude pair) matches the brain-mcp descriptions.
- The templates' 48-hour and 14-day thresholds match the code.

Design risks I did not file as defects, because they match the stated policy and templates:
- A bank feed that stopped Feb 1 still answers 'What was my profit so far this year?' with a one-month figure, an 'As of 2026-02-01,' prefix and a side note. There is no materiality threshold before a partial-period answer.
- Ledger answers carry side notes about unrelated Drive and Gmail pauses. The tests assert this is intended.
- The Heads up line no longer repeats source-coverage gaps for QuickBooks or money-policy answers. Only gaps 48 hours or more stale reach the side note.

Not checked: the /app UI rendering of the new fields, the full test chain, and live Cloudflare behaviour.

### completeness critic

I did not modify the review checkout; `git -C C:\offload\review-gaps status --short` stays empty. Probes are in C:\offload\review-gaps-scratch\critic\: build-probe.cjs, which generates probe-contact-route.mjs from the real /think harness in entity-fact-answer.test.mjs; probe-noschedule.mjs; probe-app-next.mjs; probe-tax.mjs; probe-qbo.mjs. Base comparisons import from the existing read-only base export C:\offload\review-gaps-scratch\focus2\base. I ran no repo test files, only these probes.

What I read: the full diffs for components/brain-mcp.mjs, worker/src/lib/mcp-endpoint.js, worker/src/index.js (unified, think, document think), retrieval-status.js, ledger-answer.js, ledger-reader.js, entity-fact-answer.js, store-d1.js, all templates, SKILL.md and run-test-chain.mjs. I also read every modified test hunk, looking for weakened guards. Removed assertions include the entity-fact 'coverage unavailable' fallback (already filed as registry-unreadable), proxy access.principal, and the money-round document fallbacks (intended under the ledger-only rule). Outside the diff I read brain.mjs cmdAsk, frontend Ask.tsx with its own answer-render.js and retrieval-status.js copies, owner-actions/zoom/source-receipt/bank-activity source registration, sourceFreshnessSql/assessCoverageRows, claude-workspace.mjs template rendering, and the Plaid/SimpleFIN/bank-feed last_synced_at writers.

Checked and sound, or already filed by others:
- Every live feed path writes bank_feed_items.last_synced_at with a 'bank-feed:' source_feed, so the new never-synced gate does not misfire on synced SimpleFIN or Plaid accounts.
- The hosted MCP runs as owner, and grant coverage stays empty, so the new gaps and side_note fields expose nothing new.
- The /think document path nulls catastrophic answers on the server. Raw /unified still returns rows on catastrophic and relies on the clients, which matches base provisional behaviour.
- Template installs re-render from the packaged files, so existing workspaces pick up the new contract text.

Not checked: the full test chain, live Cloudflare, real installs (whether app-only upload installs commonly lack a sweep receipt is inferred from the code paths), the eval/ and acceptance harnesses, and brain check output beyond the modified test.

Severity calls: finding 1 is P1 because a deterministic, verifier-free 'supported' answer gives the current value for a 'previous/old' question. Finding 2 is P1 because the false 'may be missing' note attaches to every answer, bank figures included, and can also refuse answerable upload questions. Finding 3 overlaps the refusal-rule reviewer's unfiled design note and adds the prompt contradiction and the observed-answer path. Finding 4 is bounded: the notice is still shown and only the remedy line is lost.

## Limits

Offline review only. No live Anthropic, Cloudflare, bank feed or Windows owner-machine behavior was exercised, and no full test chain was run. Focused tests ran from a read-only checkout on Windows; `worker/test/practical-gaps-0419.test.mjs` gave 24 passed and 2 failed there, both mutation-marker string mismatches from the CRLF checkout (see #25), not product defects. No code on the branch was changed; this branch adds only this report. Line numbers refer to 0ecf2b00.

LANE REVIEW-GAPS-PARTNER: READY (review complete; 25 confirmed: 8 P1, 12 P2, 5 P3; 8 at P0/P1)
