# REVIEW-0419-PARTNER: independent review of the 0.4.19 release

Scope: `git diff main..claude/0419-release`, a85f56493d0e15614d3a13028ac36149d981948e to f8a7cd05a1e641d29d5b3af77fc91901a5281639 (98 files).
Method: Claude Code multi-agent review. One finder per area (Claude answers; the owner's Anthropic key; search-first routing and the broad-question guard; update fail-safes; owner data during update or daily refresh), one adversarial verifier per finding that tried to refute it and re-rated severity, then a completeness critic whose findings were verified the same way. 27 agents, all offline: no network, no real Brain, no Cloudflare, no keys. Focused tests and small probes only, run from a read-only checkout; probe scripts stayed outside the repository.

Result: 20 confirmed findings (1 P1, 8 P2, 11 P3); 1 refuted or uncertain. Severity below is the verifier's rating. P0 = owner data loss, secret exposure, or an update that can leave the Brain broken; P1 = a fail-safe that does not fail safe or a wrong result shown as right; P2 = real but bounded; P3 = minor.

Relevance to the store owner's update next week: that owner updates on the built-in model, so the findings that only fire on a Claude-configured Brain (the acceptance and answer-route items) do not fire on that path. The P1 lifecycle-lock finding does apply to any update that overlaps a daily refresh.

## Confirmed findings

### 1. [P1] Lifecycle lock is taken away from a live, running daily refresh when that process started slowly (age check removed, identity sources do not match)

- Area: owner-data. Finder severity P1, verifier severity P1.
- Location: `operations/brain-lifecycle-lock.mjs:408`; verifier: operations/brain-lifecycle-lock.mjs:408 (the reap condition). Contributing: lines 25 and 334-336 (Node start time compared with the Windows CreationTime) and line 103 (2,000 ms tolerance). Callers that make it reachable: operations/daily-refresh-scheduler.mjs:244, operations/daily-refresh-run.mjs:562, brain.mjs:31529.
- Inputs: The scheduled daily refresh starts at Task Scheduler Priority 7 (below normal; daily-refresh-scheduler.mjs:244) while the computer is busy, for example right after wake (WakeToRun) or login (StartWhenAvailable). It takes the lock with operation "daily-refresh". While it is still running, the owner or technician runs `brain update`, or Claude Code runs `brain load` or `ingest-file`.
- Wrong outcome: The second command deletes the live holder's owner file on its first try and gets the lock. The update then goes ahead while the daily refresh is still loading a source. The default daily runSource (daily-refresh-run.mjs:562) calls cmdLoad with lifecycleLockHeld:true and never re-checks ownership, so that whole source load keeps writing batches during the update's backlog checks and pause deploy. The daily run only notices `brain_lifecycle_lost` at the next source boundary. This bypasses the guard that test S2 ("active local ingest owns the update boundary until it releases custody") relies on. The update was meant to wait up to 120 s (brain.mjs:31528) and refuse.
- Fix: Take the lock away immediately only when the owner is confirmed dead (`!live`). For a live owner whose identity looks different, keep the old rule that the owner file must also be stale by mtime (`now - owner.mtimeMs > staleAfter`). Also compare like with like: store the OS start identity (processStartIdentity(process.pid)) in process_instance instead of Date.now() - uptime, or treat a stored `epoch:`/legacy value as unknown when the observed value is `win32:`. Add a test with isOwnerAlive true, mismatched identities and a fresh mtime that must stay brain_lifecycle_busy.
- Verifier's fix note: 1. In acquireBrainLifecycleLock, take over at once only when the owner is confirmed dead. A live owner whose identity looks different must also be stale by mtime, as in the base:

```js
const stale = currentTime().getTime() - owner.mtimeMs > staleAfter;
if (!live || (!sameProcess && stale)) {
  const current = readOwner(path, platform);
  const currentLive = isOwnerAlive(current.pid);
  const currentInstance = currentLive ? processInstance(current.pid) : null;
  const currentSame = currentLive && sameProcessIdentity(current.process_instance, currentInstance);
  const currentStale = currentTime().getTime() - current.mtimeMs > staleAfter;
  if (current.token === owner.token && current.mtimeMs === owner.mtimeMs &&
      (!currentLive || (!currentSame && currentStale))) {
    unlinkSync(current.path);
    rmdirSync(path);
    continue;
  }
}
```

This keeps the fast recovery of a dead lock (the test "confirmed dead lock is recovered without a 120-second update wait") and the PID-reuse test, which uses a stale mtime.

2. Compare like with like. On win32, store processStartIdentity(process.pid) as the holder's own process_instance. Failing that, make sameProcessIdentity treat an `epoch:` or legacy numeric value as unknown (same process) when the observed value is `win32:`.

3. Add a regression test. Holder: processInstance returns `epoch:N`. Contender: isOwnerAlive returns true, processInstance returns `win32:<ticks for N-5000>`, and the owner mtime is fresh. The contender must throw brain_lifecycle_busy, and holder.assertOwned() must still return true.

4. Optional hardening: pass the `{assertOwned}` argument through in the default daily runSource (daily-refresh-run.mjs:562) into cmdLoad options, and on into the leg runners, so a lost lock stops writing at the next batch instead of at the next source.
- Verification: All scratch files are in C:\offload\review-0419-scratch\verifier-lock-identity\. Nothing in C:\offload\review-0419 was changed.

1. Deterministic check (probe.mjs). The real acquireBrainLifecycleLock from the release head was run against the base a85f564 module, copied to old-lock.mjs. The holder stored epoch:N. The contender used isOwnerAlive=true and observed a win32 start time N-Î”. The owner file's mtime was 0-1 ms old.
   - Release head: Î”=500 and Î”=1999 gave brain_lifecycle_busy. Î”=2001, 3000 and 11401 gave contender ACQUIRED, then holder.assertOwned() threw brain_lifecycle_lost and holder.release() returned false.
   - Base: brain_lifecycle_busy for every Î”.

2. End to end with all real defaults (e2e.ps1, holder.mjs, contender.mjs; Node v24.18.0, 24 logical CPUs). The holder takes "daily-refresh" with `start /BELOWNORMAL`. After the load ends, a normal-priority contender takes "update", using real processStartIdentity through PowerShell and real ownerAlive.
   - No load: Node start minus Windows CreationTime was 15 ms. The contender got brain_lifecycle_busy. The holder kept the lock.
   - 30 CPU spinners for 9 s: the gap was 6,939 ms. The contender reported ACQUIRED_WHILE_HOLDER_ALIVE about 1.8 s after the holder acquired. 25 s later the holder's assertOwned gave brain_lifecycle_lost and its release returned false.

3. Focused suite: `node --test test/brain-lifecycle-lock.test.mjs` gave 11/11 passing. No test has a live owner with a mismatched identity and a fresh mtime.

4. Code trace confirmed:
   - daily-refresh-scheduler.mjs:244 `priority: 7`
   - daily-refresh-run.mjs:562 runSource does not pass assertOwned
   - the cmdLoad leg runners call ingest without options
   - brain.mjs:31529 `waitMs: options.lifecycleLockWaitMs ?? 120_000`
   - pauseDailyRefreshSchedule only disables the task and never checks whether an instance is running

### 2. [P2] Acceptance FAILs a healthy Claude answer setup when the probe answer comes from a no-model path, is correctly withheld by the Sonnet check, or hits the daily limit; during an update this stops the update after deploy

- Area: answers. Finder severity P2, verifier severity P2.
- Location: `acceptance.mjs:1118`; verifier: acceptance.mjs:1117-1138 (configured-answer block in tierRetrieval); root cause worker/src/index.js:1443/2030 (no model receipt on exact_contact_fact and quickbooks_observed_* answers)
- Inputs: Manifest has retrieval.answer_model claude-opus-5-5 and gate_model claude-sonnet-5-5 (answerSetupOf returns opus-sonnet), and at least one saved probe question (m.testing.probe_questions). The /api/rag/think reply for savedQuestions[0] is any one of: (a) a contact or QuickBooks fact answered by entityFactAnswer or the observed-balance path, which never calls a model, so the response has no `model` field; (b) a draft the Sonnet evidence gate correctly rejects (status answer_withheld, answer null); (c) answer_error = dailyLimit because the owner already spent the $5 day budget; (d) an Anthropic 429 or 529 (busy), which gives answer_error unavailable.
- Wrong outcome: acceptance records FAIL ('configured answer model matches: expected claude-opus-5-5; received none' for (a), or 'configured answer model returned an answer: ... no answer text was returned' for (b), (c) and (d)). Acceptance sets passed = counts.fail === 0, so verifyAcceptance throws Fatal('acceptance suite FAILED'). In brain update this happens at the 'full acceptance test' stage (brain.mjs:7242), after migrations and the Worker deploy and before the D1 version commit, so the owner sees 'The update is incomplete'. Case (a) is deterministic: every rerun fails until the probe list changes. Case (c) fails until midnight UTC. The same Brain on the built-in model gets PASS 'think degrades cleanly' for (b) through (d). This also contradicts connect anthropic, which treats daily_limit as a successful setup (answer-setup.mjs:490). `brain test` and the handoff reports (report.mjs, report-html.mjs) report FAIL the same way.
- Fix: Require the model receipt only when the Worker actually ran the answer model: skip 'configured answer model matches' when `model` is absent and evidence_gate.method is a deterministic method (exact_contact_fact, quickbooks_observed_*), or have the Worker emit an explicit `answer_method` receipt. Downgrade to WARN, not FAIL, when the null answer has a typed non-configuration cause: status answer_withheld, answer_error dailyLimit, spendCheckPaused, or unavailable/verificationUnavailable (busy). Keep FAIL for keyMissing, providerAccount, or a model receipt that names a different model. Add tests for the four shapes above.
- Verifier's fix note: In acceptance.mjs, before recording the two 'configured answer model ...' rows, check for a fixed answer:
`const deterministic = ["exact_contact_fact", "quickbooks_observed_balances", "quickbooks_observed_open_items"].includes(think.json?.evidence_gate?.method) && think.json?.model === undefined`.

When `deterministic` is true:
- Do not record 'configured answer model returned an answer' as PASS with the claim that Opus returned text.
- Do not record 'configured answer model matches' as FAIL.
- Instead, prove the configured model separately. Either POST /api/admin/brain/answer-check (the Worker route `connect anthropic` already uses) and require answer.model === answer_model and check.model === gate_model, or run think on the next saved probe that is not a fixed-answer one.
- If neither is available, record a WARN 'configured answer model not exercised: the probe was answered from an exact record'.

Better long-term fix: have the Worker emit an explicit `answer_method` receipt ("model", "exact_contact_fact", "quickbooks_observed_*", "ledger") and branch on it.

Add a regression test to test/acceptance-answer-model.test.mjs: a Claude manifest plus the real exact_contact_fact response shape (answer, citations, evidence_gate.method, no model) must give zero failures and must not claim the configured model produced the text.

Separately, get a ruling, as a policy decision rather than a bug fix, on whether the null-answer cases with daily_limit, spend_check_paused or busy should be WARN instead of FAIL during `brain update`. That would match `connect anthropic`.
- Verification: Wrote C:\offload\review-0419-scratch\answers-verify-model-receipt\probe-e2e.mjs.
- It imports the release worker/src/index.js and runs the real POST /api/rag/think, with the D1/Vectorize stubs copied from worker/test/entity-fact-answer.test.mjs.
- Worker env: ANSWER_MODEL=claude-opus-5-5, GATE_MODEL=claude-sonnet-5-5, network forbidden, AI.run throwing on any non-embedding model.
- Question: "What is Example Contact's email?"

Worker result:
- HTTP 200, 0 network calls, 0 LLM calls.
- answer "As of 2026-10-06, the record lists Example Contact's email as contact@example.invalid. [1]".
- No model field.
- evidence_gate {method: exact_contact_fact, supported: true, complete: true, evidence: [1]}.

I fed that exact response into the release Acceptance.tierRetrieval:
- Manifest {retrieval: {answer_model: claude-opus-5-5, gate_model: claude-sonnet-5-5}} gives passed=false with counts pass 7, fail 1. It records 'pass | configured answer model returned an answer | claude-opus-5-5 returned answer text' (a false detail), then 'fail | configured answer model matches | expected claude-opus-5-5; received none'. 'think returns an answer' and 'answer carries inline citations' both pass.
- Built-in manifest {} on the same response gives passed=true, 0 fail.

I also ran `node --test test/acceptance-answer-model.test.mjs`: 4 pass. None of those tests uses a response without a model field.

I traced brain.mjs:7242-7243, 7708 and 7307 for the update stop and the owner message.

### 3. [P2] A half-finished answer setup leaves a journal that nothing reads; the only fix offered deletes a working Claude setup and its stored key

- Area: completeness. Finder severity P2, verifier severity P2.
- Location: `operations/answer-setup-copy.mjs:29`; verifier: operations/answer-setup.mjs:360 (HALF_RUN refusal, journal never consumed); operations/answer-setup-copy.mjs:29-30 and :25-26 (HALF_RUN / ROLLBACK_INCOMPLETE point to disconnect); brain.mjs:20743-20761 (disconnect deletes ANTHROPIC_API_KEY regardless of journal.secret_name_existed)
- Inputs: An owner already on the Opus/Sonnet setup reaches the daily limit. As SKILL.md instructs, they run `brain connect anthropic <manifest> --keep-key --daily-cap <usd>`. The process is killed after the journal and manifest writes. Two things can kill it: the SKILL's 10-minute Bash timeout, or a stalled deploy. The internal 8-minute guard is only checked between steps, and a failed run then does another rollback deploy, so the total can pass 10 minutes. `.answer-setup-journal.json` stays next to the manifest. It records the previous models, the previous cap and `secret_name_existed: true`.
- Wrong outcome: The next connect refuses with HALF_RUN: run `brain disconnect anthropic`, then set it up again. Disconnect drops answer_model and gate_model and deletes the Worker's ANTHROPIC_API_KEY, then removes the journal. After that, `--keep-key` fails with KEEP_KEY_MISSING. The owner has to create a new key in the Console, because a key cannot be shown again. The journal held everything needed to restore the previous working state, but no command reads it once the process that wrote it has exited. Also, `brain update` never checks for the journal. It deploys whatever half-edited manifest is on disk, and the HALF_RUN warning only appears from cmdHealth, and only on Windows, where the pinned copy shares the manifest folder.
- Fix: Add a resume path that reads the journal, for example a `brain connect anthropic <manifest> --finish` mode, or have the next connect automatically roll back from the journal. It should rebuild the previous manifest with restoreManifestFromAnswerSetupJournal(current, journal). It should keep the secret when `secret_name_existed` is true and delete it only when this run wrote it. Then reconcile daily, deploy and remove the journal. Point HALF_RUN at that path. Use disconnect only when the previous setup was built-in. Make `brain update` refuse before the pause while the journal exists.
- Verifier's fix note: At the top of runAnthropicAnswerSetup, replace the bare HALF_RUN throw with a resume from the journal, inside the same lock:
1. Read and validate the journal (schema_version 1).
2. Load the current manifest and build `previous = restoreManifestFromAnswerSetupJournal(current, journal)`. If the previous setup is not built-in, run assertReviewedAnswerModels on it.
3. Save `previous` atomically. Call prepareDaily and reconcileDaily with rollback: true.
4. Delete ANTHROPIC_API_KEY only when `!journal.secret_name_existed && previous.retrieval?.rerank !== true` and the name is present, then read the list back. Keep the key when secret_name_existed is true.
5. Run verifyDeploy and deploy. Remove the journal only after the deploy succeeds. Log ROLLED_BACK_PREVIOUS, then either return "nothing_changed, rerun the same command" or continue with the requested setup.

Change HALF_RUN, and ROLLBACK_INCOMPLETE when the journal remains, to say "rerun the same command; it will first put your Brain back as it was". Keep `brain disconnect anthropic` only for an owner who wants the built-in model. As a guard, make `brain update` refuse before the pause while `.answer-setup-journal.json` exists, or run the same journal rollback first. That way it never deploys a half-edited manifest. Add a test: write a keep-mode journal with secret_name_existed true, run connect, and check that the previous cap and models come back, deleteSecret is never called, and the journal is removed.
- Verification: I wrote two probes in C:\offload\review-0419-scratch\verify-halfrun-journal\. Both use a real manifest file and the real default journal read and write from the release head, with injected Cloudflare stubs.

probe.mjs (no kill):
- Start state: opus/sonnet, cap 5, ANTHROPIC_API_KEY stored. Run `--keep-key --daily-cap 20`. Deploy throws "Cloudflare API 503" on both the forward deploy and the rollback deploy.
- run1 returns ANTHROPIC_ROLLBACK_INCOMPLETE.
- Disk after run1: manifest is back to opus/sonnet, cap 5 (the previous state); the secret is still stored; the journal still exists, with the previous models, cap 5, secret_name_existed true and mode keep.
- run2, after the outage ends, returns HALF_RUN: "run: brain disconnect anthropic ... Then set it up again."
- After cmdDisconnectAnthropic: retrieval is {rerank:false}, the secret list is empty, and the journal is gone. Disconnect prints "The Anthropic key was removed from your Brain..."
- run3 with --keep-key returns KEEP_KEY_MISSING.

probe-kill.mjs:
- A child process runs the same command and SIGKILLs itself while the deploy is in flight.
- On disk afterwards: the manifest has cap 20, the journal still exists, and the next connect returns HALF_RUN.

I read the code paths at answer-setup.mjs:333-363, 439-441, 494-556; brain.mjs:4292 and 20705-20770; doctor.mjs:886-895; and brain-lifecycle-lock.mjs, the stale-owner reclaim.

### 4. [P2] A manifest with a non-@cf answer model is stuck: update says run disconnect first, disconnect says run update first

- Area: owner-data. Finder severity P2, verifier severity P2.
- Location: `brain.mjs:30936`; verifier: brain.mjs:30936 (update gate). The dead-end recovery is at brain.mjs:20715-20723 (disconnect's live-version gate) and in the copy at operations/answer-setup-copy.mjs:37 and support-recovery.mjs:58.
- Inputs: An installed Brain on an older version (the live Worker reports an earlier version) whose manifest has retrieval.answer_model or gate_model set to a Claude ID outside the two reviewed ones, for example "claude-sonnet-4-5" (the old Worker default name). Before this release the schema allowed any string, and optionalWorkerSecretNames treated a non-@cf answer model as a supported way to keep an Anthropic key.
- Wrong outcome: `brain update` stops with ANSWER_MODEL_NOT_REVIEWED and says "First run brain disconnect anthropic <manifest>". `brain disconnect anthropic` stops with UPDATE_FIRST ("Update it first with: brain update ...") because the live Worker is not 0.4.19. `brain connect anthropic` also fails assertReviewedAnswerModels first (answer-setup.mjs:367). A non-technical owner can only get out by editing the manifest by hand.
- Fix: Let `brain disconnect anthropic` skip the live-version check, since it only removes Claude fields, deploys the built-in pair and deletes the key. Or have the update offer or perform the move to built-in for an unreviewed model instead of refusing. At minimum, make MODEL_NOT_REVIEWED name a path that works on an un-updated Brain (remove both fields from the manifest, then run brain update).
- Verifier's fix note: Do NOT make disconnect skip the version check and then deploy. That would push the 0.4.19 Worker onto a database that has not had migrations 0049-0056.

Instead, in cmdDisconnectAnthropic (brain.mjs:20715), when assertLiveAnswerSetupWorker fails and the manifest names an unreviewed model, do a manifest-only step:
- run the same prepareDaily, then saveManifestAtomically with retrieval.answer_model and retrieval.gate_model deleted, then reconcileDaily;
- skip cmdDeploy and the secret deletion;
- print "Your Brain will switch to the built-in model during the update. Now run: brain update <manifest>."

The next update passes the check at brain.mjs:30936 and deploys the built-in pair inside the gated sequence. ANTHROPIC_API_KEY is then no longer in optionalWorkerSecretNames, so the update reconciles it or reports it.

Simpler alternative: in cmdUpdateWithPrompts, before pinUpdateManifest, offer that same manifest-only revert to the built-in model, behind a yes/no prompt for the owner.

Either way, change MODEL_NOT_REVIEWED (or give the update path its own copy) and the support-recovery.mjs:58 steps so they name a path that works on a Brain that has not been updated yet. Extend test/answer-model-config.test.mjs:76 to run the named recovery command against a /health stub that reports an older version, and assert that it succeeds.
- Verification: I wrote a probe at C:\offload\review-0419-scratch\verifier-unreviewed-deadlock\probe.mjs. It uses a temp manifest (brain.version 0.4.8, retrieval.answer_model "claude-sonnet-4-5", rerank false) and imports C:\offload\review-0419\brain.mjs. Results:
(1) Full `cmdUpdate(manifest, {lifecycleLockHeld, discoverInstalledManifest})` threw supportCode ANSWER_MODEL_NOT_REVIEWED: "retrieval.answer_model is set to claude-sonnet-4-5, which this installer has not reviewed. Nothing was changed. First run brain disconnect anthropic <path> ...". The credential-adoption stub was never called.
(2) `cmdDisconnectAnthropic` with the real `assertLiveAnswerSetupWorker` and a /health stub reporting version 0.4.8 threw code UPDATE_FIRST: "Your Brain is on an older version than this installer. Update it first with: brain update <path>. Nothing was changed."
(3) `cmdConnectAnthropic --from-clipboard` threw ANSWER_MODEL_NOT_REVIEWED before any version check.
Calls recorded across all three: only ["/health"]. The manifest bytes were unchanged. I also read operations/answer-setup.mjs:49-77 and :358-375, brain.mjs:19686-19709, :20705-20777, :30915-30936, :31508-31540, and base brain.mjs:3257-3300 plus base worker/src/index.js:1374, which together show legacy Claude answer models were supported before this release.

### 5. [P2] Hosted /mcp connector skips the 0.4.19 built-in routing, the broad-question guard and the second-search rule

- Area: routing. Finder severity P2, verifier severity P2.
- Location: `worker/src/lib/mcp-endpoint.js:71`; verifier: worker/src/lib/mcp-endpoint.js:72 (built-in ask description), :686 (built-in initialize arm), :118 (Claude-mode fallback search description, no guard), :364 (one-search empty note); claims at CHANGELOG.md:21 and :47 and docs/release-evidence/v0.4.19-candidate-release-evidence-plan.md:114 and :118
- Inputs: Owner on a built-in Brain (ANSWER_MODEL and GATE_MODEL @cf) uses the OAuth remote connector, for example from the Claude app. Example questions: a short fact ("When does the March lease renew?"), a broad review ("Which business expenses did I pay personally?" or "Reconcile what my entities owe one another"), or any query whose search comes back empty.
- Wrong outcome: The built-in remote `ask` is still "Money and short lookups ... or a short single-fact lookup", so short non-money lookups go to the built-in model. The local MCP removed exactly that route for built-in Brains. No remote surface in either answer setup has the broad-question guard, so nothing stops the remote assistant from adding up amounts across excerpts, reconciling entities, or calling a list complete. An empty remote search tells the assistant to say "I didn't find a matching record in this search" after one search, with no second search. The Claude-mode remote fallback `search` description also has no guard. This contradicts the 0.4.19 changelog ("On a built-in Brain, the assistant searches first ... Broad reviews stay record by record") and release acceptance items 3 and 4, which do not exclude the hosted connector.
- Fix: Bring the hosted connector into line with the local MCP. For a built-in Brain, drop "short single-fact lookup" from ask and from the initialize arm, and make search/fetch the default for non-money questions. Add the broad-question guard paragraph to the remote initialize instructions and to the remote search description in both arms. Replace the remote empty-search note and the line-288 refusal text with the same two-search wording the local MCP uses. If the hosted path is meant to stay out of scope, say so in the CHANGELOG and in acceptance items 3 and 4 of the evidence plan, so the guard is not claimed for it.
- Verifier's fix note: Choose one, before sealing.

Option A: bring the hosted connector into line with the local MCP. These are metadata strings only and need no data or schema change.
1. Built-in arm:
   - In the TOOLS ask description (line 72), remove "or a short single-fact lookup". Replace "For anything else, use search, then fetch" with wording like the local one: use ask only for supported ledger money questions or when the owner explicitly asks for the Brain's own answer; for every other question, use search, then fetch, and write the answer with each fact's source title and date.
   - In the initialize arm (line 686), replace "ask is for money and short lookups" with the same search-first sentence.
2. Both arms:
   - Append the same Broad-question guard paragraph the local MCP uses to the hosted initialize instructions.
   - Append it to the search description in both arms: TOOLS search at line 81 and the Claude fallback at line 118. Replace "brain_think" with "ask" in the copy.
3. Line 364: replace the remote empty-search note with the two-search wording. For example: 'No hits in this search. This is not proof that no such record exists. Search again with different wording before saying "I didn't find a matching record in these searches". Name both searches and the next place you would check.' The remote search has no sort, so drop the "sort newest" clause.
4. Leave the line-288 ask refusal as it is. Its Next line already asks for a retry, and the sentence is shared with the app.
5. Tests: update the test/mcp-absence-honesty.test.mjs pins (REMOTE_NO_HITS, the /^Money and short lookups\./ assertion). Run broadQuestionGuard() over the hosted initialize text and the hosted search descriptions in both arms.

Option B: keep the hosted connector at 0.4.18 behavior on purpose, and say so.
- Scope CHANGELOG.md:21 and :47 to "the local assistant connection (Claude Code/Codex)".
- Add a Known issues line: the Claude/ChatGPT app connector keeps 0.4.18 routing on a built-in Brain, with no broad-question guard and no second-search rule.
- Scope evidence-plan acceptance items 3 and 4 to the local MCP. Otherwise acceptance run against the connector fails them.
- Verification: I wrote and ran C:\offload\review-0419-scratch\routing-verifier\probe.mjs. It imports handleMcp from C:\offload\review-0419\worker\src\lib\mcp-endpoint.js and calls initialize, tools/list and tools/call with injected think/search deps. I ran it twice: once with built-in env (ANSWER_MODEL and GATE_MODEL set to @cf/meta/llama-3.3-70b-instruct-fp8-fast) and once with the Claude pair (claude-opus-5-5 / claude-sonnet-5-5).

Results:
- Built-in arm: the ask description contains "single-fact lookup" (true). The initialize text contains "money and short lookups" (true).
- Both arms: no surface contains "Broad-question guard", "record by record" or "search again" (all false).
- Both arms: an empty search returns the note 'No hits in this search. This is not proof that no such record exists. Say "I didn't find a matching record in this search" and name the next search you would run.'
- A refused ask with no results returns "I didn't find a matching record in this search.\nNext: ask again with a name, date or exact phrase the record would contain."

I also ran `node --test --test-name-pattern="remote connector routing follows|remote empty search is scoped|local MCP routes non-money" test/mcp-absence-honesty.test.mjs` from C:\offload\review-0419. All 3 tests pass: the local search-first routing is asserted, and the hosted built-in arm is pinned as unchanged.

Other checks:
- A grep of worker/src finds no server-side broad-question guard.
- In the 0.4.18â†’0.4.19 diff of mcp-endpoint.js, only the Claude arm was added; the built-in strings and the line-364 note are untouched.
- CHANGELOG lines 21 and 47 and evidence-plan items 3 and 4 make the routing claims without excluding the hosted connector.

No files in C:\offload\review-0419 were modified.

### 6. [P2] Answer route is fixed when the guide is written and when the MCP process starts; after a return to the built-in model the assistant still sends every non-money question to brain_think and says Claude Opus wrote it

- Area: routing. Finder severity P2, verifier severity P2.
- Location: `operations/claude-workspace.mjs:134`; verifier: operations/claude-workspace.mjs:134 (route text); root cause at brain.mjs:20756-20768 (cmdDisconnectAnthropic never re-renders the guide), operations/answer-setup.mjs:535-575 (rollback to built-in never re-renders), components/brain-mcp.mjs:97-103,214,960 (route fixed when the process starts)
- Inputs: Mac owner with Claude answers on (answer_model claude-opus-5-5, gate_model claude-sonnet-5-5) runs `brain update`, which rewrites CLAUDE.md/AGENTS.md with CLAUDE_ANSWER_ROUTE and CLAUDE_MONEY_ROUTE. Later the Brain goes back to the built-in model, either through `brain disconnect anthropic` or through a `brain connect anthropic --from-clipboard` re-run with a rejected key, which rolls back to built-in (answer-setup.mjs:535-558). A second way in: an assistant session whose MCP server started while Claude was on stays open across the disconnect.
- Wrong outcome: The Worker now answers with @cf/meta/llama-3.3-70b. But the always-loaded workspace guide still says "For every non-money question, use brain_think first. The Brain's Claude Opus model writes the answer from the records and Claude Sonnet checks it." A running local MCP also keeps its Claude-mode instructions and tool descriptions. So the assistant routes every non-money question, broad reviews included, to the built-in model, which the release's own decision copy says got 16 of 43 answers wrong. It then tells the owner Opus wrote the answer and Sonnet checked it. brain_think output has no model receipt, so the assistant cannot see the mismatch. This is the built-in-Brain case the changelog says is search-first. The reverse also happens. Windows never rewrites an existing guide (brain.mjs:29705), and install day connects Claude after the guide is written. Those owners keep a search-first guide while their MCP says think-first, so the two routing sources disagree.
- Fix: Run writeAssistantWorkspaceGuide (Claude and Codex) after every successful connect, every disconnect, and every rollback in runAnthropicAnswerSetup. On Windows, where an existing guide is left alone, print the exact restart and re-render step. Add one line to DONE_LINES and DISCONNECT_LINE telling the owner to quit and reopen Claude Code or Codex so the MCP instructions reload. Pass the Worker's `model` receipt through brain_think's output, and make the Claude-mode route conditional on it: if the receipt is not claude-opus-5-5, treat the reply as a built-in answer and use brain_search first. That way a stale guide or process cannot present a built-in answer as an Opus answer.
- Verifier's fix note: (a) After the deploy in cmdDisconnectAnthropic succeeds, and after cmdConnectAnthropic returns (success, or a rollback to built-in or previous), call refreshWorkspaceGuideAfterUpdate(manifestPath, options, "claude") and the same with "codex". Pass workspaceGuideRun { action: "answer setup" }, and keep existingOnly so only managed guides are touched. (b) Add one line to DISCONNECT_LINE, DONE_LINES and ROLLED_BACK_BUILT_IN: "Quit and reopen Claude Code or Codex so it picks up the new answer route." On Windows, where an existing guide is kept, the same line should name `brain update <manifest>` as the step that refreshes the guide. (c) Close the gap a stale MCP process or a stale guide leaves. In brain-mcp.mjs's brain_think handler, re-read BRAIN_MANIFEST on each call. If answerSetupOf() now differs from the ANSWER_SETUP computed at startup, add a note to `out`: "This Brain now answers with the built-in model. Use brain_search first for non-money questions, do not attribute this answer to Claude, and ask the owner to restart the assistant." Add an `answer_setup` field to `out` so the assistant can see which model answered. A tighter version also has the Worker return its answer model id in the think response, and the MCP passes it through.
- Verification: Traced the call sites by grep: guide writers are called only in cmdSetup, cmdLocalTools and refreshWorkspaceGuideAfterUpdate. None is in cmdConnectAnthropic, cmdDisconnectAnthropic, runAnthropicAnswerSetup or cmdDeploy. Copied the claimant's probe to C:\offload\review-0419-scratch\verify-route\probe.mjs and added a fresh-render comparison. The probe writes CLAUDE.md for an opus-sonnet manifest with platformName darwin, then runs the real cmdDisconnectAnthropic with no-op cloud adapters. Output: "guide write: written", "before disconnect: think-first route present = true", "disconnect says: Your Brain now answers with the built-in Cloudflare model.", "manifest answer setup after disconnect: built-in", "after disconnect: guide unchanged = true", "after disconnect: think-first + Opus claim still present = true". For comparison, a fresh render for the built-in manifest gives "uses search-first = true" and "has Opus claim = false". Confirmed by reading that brain-mcp.mjs:97-103/214/960 are evaluated once at module load, and that brain_think's out object (603-631) has no model field. `git status --porcelain` in C:\offload\review-0419 is clean after the run.

### 7. [P2] Answer-aware acceptance never checks a configured Claude answer when no owner probe questions are saved, which is the default

- Area: update-failsafes. Finder severity P2, verifier severity P2.
- Location: `acceptance.mjs:968`; verifier: acceptance.mjs:968 (the early return at 968-975 sits ahead of the only configured-answer checks at acceptance.mjs:1115-1138; the default comes from templates/brain.manifest.json:488 and brain.mjs:7682)
- Inputs: A manifest with answer_model claude-opus-5-5 and gate_model claude-sonnet-5-5, and `testing.probe_questions: []`. That is the template default, and the runbook says never to ask the owner for questions. The Worker's ANTHROPIC_API_KEY has been deleted or revoked, or Claude answers otherwise fail. The owner runs brain update or brain test.
- Wrong outcome: tierRetrieval returns before the only /api/rag/think call, so the 'configured answer model returned an answer' and 'configured answer model matches' checks never run. Acceptance passes ('automated acceptance checks passed'), and the update commits the version and prints 'upgrade verified'. The CHANGELOG promises the opposite: 'acceptance now fails when a configured answer cannot be produced or checked'. The only other signal is a cmdHealth warning (anthropic_key_missing), which does not stop the update. provider-secret reconciliation lists ANTHROPIC_API_KEY as optional, not required.
- Fix: For any setup that is not built-in, run a fixed answer check in acceptance that does not depend on owner questions. Call the existing /api/admin/brain/answer-check endpoint (the receipt the connect flow verifies at brain.mjs:19755) and FAIL unless answer.model and check.model match resolvedAnswerModels(m) and both statuses are ok (or daily_limit, reported as WARN). Keep the probe-based think check as an extra, not the only gate.
- Verifier's fix note: In acceptance.mjs, add a configured-answer check that does not depend on saved questions, and run it before the early return at :968 (or as its own tier-3 step called from run()). When `answerSetupOf(this.m) !== "built-in"`, call `const r = await this.post("/api/admin/brain/answer-check", {})`. That handler is worker/src/index.js:542 and returns `{answer:{model,status}, check:{model,status}}`. Then:
- Record FAIL "configured answer check" unless r.ok, `r.json.answer.model === resolvedAnswerModels(this.m).answer_model` and `r.json.check.model === resolvedAnswerModels(this.m).gate_model`.
- Record FAIL unless both statuses are "ok". Map a daily-limit status to WARN and say so in the detail.
- Never copy provider text into the detail.

Keep the probe-based think checks at :1115-1138 as an extra check when questions exist. Add a test to test/acceptance-answer-model.test.mjs that calls `tierRetrieval([])` (or `run({probes: []})`) on a claude-opus-5-5/claude-sonnet-5-5 manifest with a failing answer-check stub and asserts a FAIL and `passed === false`. If the gate is not added, correct the wording at CHANGELOG.md:34 and in its technical notes instead.
- Verification: I wrote C:\offload\review-0419-scratch\verify-answer-noprobes\probe.mjs. It imports Acceptance and acceptanceVerdict from C:\offload\review-0419\acceptance.mjs with this manifest: `{retrieval:{answer_model:"claude-opus-5-5", gate_model:"claude-sonnet-5-5"}, testing:{probe_questions:[]}}`. It stubs `post` so /api/rag/think returns a null answer with an anthropic_key_missing gap (a revoked or missing key), stubs the other tiers to no-ops, and calls `suite.run({probes})`.

Output:
- probes [] gave thinkCalls 0, passed true, results ["optional owner-question checks: skip"], headline "automated acceptance checks passed".
- probes ["   "] gave the same: thinkCalls 0, passed true.
- probes ["What changed?"] gave thinkCalls 1 and passed false. The control shows the think path is reached and fails only when a question exists.

I also traced brain.mjs:7237-7258 (health, then acceptance, then D1 version commit, then manifest commit, then "upgrade verified" at :7348), brain.mjs:4293 (warn only), worker/src/index.js:3317 (flag set only when the key is absent), brain.mjs:3341-3362 and 3443-3470 (Anthropic key optional, never required), and test/acceptance-answer-model.test.mjs (always passes one probe).

### 8. [P2] A busy lifecycle lock during brain update is shown as 'Your internet connection dropped', so the new holder message never reaches the operator

- Area: update-failsafes. Finder severity P2, verifier severity P2.
- Location: `brain.mjs:24596`; verifier: brain.mjs:24596 (crash() treats the retryable lock error as a network drop). Root cause: brain.mjs:31525-31536 (cmdUpdate has no catch for lock errors) and brain.mjs:20773-20776 (cmdDisconnectAnthropic rethrows busy raw). Error source: operations/brain-lifecycle-lock.mjs:420-425.
- Inputs: Another Brain operation holds the manifest lifecycle lock, for example a daily refresh, ingest, load or answer-setup run, and the operator runs `brain update <manifest>` (or `brain disconnect anthropic`). The update waits its 120 s and then gives up.
- Wrong outcome: acquireBrainLifecycleLock throws a raw BrainLifecycleLockError {code:'brain_lifecycle_busy', retryable:true}. cmdUpdate does not convert it to a Fatal. The top-level catch sends every non-Fatal error to crash(), and crash() treats any `retryable === true` as a network drop. The operator sees 'Your internet connection dropped while talking to Cloudflare... Check your Wi-Fi or VPN, then run the same command again.' The new message ('the Brain lifecycle lock is held by <op> since <time>... Wait for it to finish') is thrown away. During the supervised update this sends the operator after a network fault that does not exist. A lock that is unsafe, for example an empty lock directory, prints 'unexpected error... This is a bug in the installer' instead.
- Fix: In cmdUpdate (and cmdDisconnectAnthropic, and any other CLI path that rethrows lock errors), catch BrainLifecycleLockError and rethrow it through dieWithSupportCode(error.message, busy ? 'UPDATE_BRAIN_BUSY' : 'BRAIN_LOCK_UNSAFE'). Also make crash() check `err instanceof BrainLifecycleLockError` (or `String(err.code).startsWith('brain_lifecycle_')`) before the retryable network branch, and limit that branch to real network error codes.
- Verifier's fix note: 1. In cmdUpdate, wrap the lockTask call (brain.mjs:31526) in a catch:
   if (error instanceof BrainLifecycleLockError || /^brain_lifecycle_/.test(String(error?.code))) dieWithSupportCode(error.message, error.code === "brain_lifecycle_busy" ? "UPDATE_BRAIN_BUSY" : "UPGRADE_FAILED"); otherwise rethrow.
   Import BrainLifecycleLockError from ./operations/brain-lifecycle-lock.mjs. UPDATE_BRAIN_BUSY already exists. For the unsafe case, the message should say a stale or damaged lock folder was found and name the next step, not call it an installer bug.
2. In cmdDisconnectAnthropic's catch (brain.mjs:20772), handle busy and unsafe the same way, through die or dieWithSupportCode.
3. As a backstop in crash() (brain.mjs:24595), before the retryable branch: if String(err?.code).startsWith("brain_lifecycle_"), print the lock's own message and exit 1.
   Do not narrow the general `retryable === true` network branch. Other callers may depend on it.
4. Add a CLI-level test that holds a real lock and runs `brain update`. It should assert the output contains "lock is held by" and does not contain "internet connection dropped".
- Verification: I ran the real CLI end to end with no network. Probe files: C:\offload\review-0419-scratch\verify-lockbusy\probe-cli-update-busy.mjs and C:\offload\review-0419-scratch\verify-lockbusy\holder.mjs.

Setup:
- The test helper cliTestEnvironment from the release, with an isolated user root and BRAIN_LIFECYCLE_LOCK_ROOT under the scratch run folder.
- A minimal manifest.
- A separate node process holding the real lifecycle lock as operation "daily-refresh", like a scheduled refresh would.
- Command: `node --import test/fixtures/isolate-support-root.mjs C:\offload\review-0419\brain.mjs update <manifest>`.

Result: it took 121 s and exited 1. Stdout was exactly:
"fail  Your internet connection dropped while talking to Cloudflare. / Nothing was lost: everything that finished is saved. / Check your Wi-Fi or VPN, then run the same command again. / Need help with this? Run: ... support --explain UPGRADE_FAILED". The "lock is held by daily-refresh since ..." text did not appear anywhere in stdout or stderr.

I also confirmed from code that base a85f564 has the same routing. I wrote a copy of the base brain.mjs to C:\offload\review-0419-scratch\verify-lockbusy\base-brain.mjs. A copy with identical content was also written by mistake to C:\offload\review-0419-scratch\base-brain.mjs; it may already have been there. Nothing in C:\offload\review-0419 was changed.

### 9. [P2] A configured Claude brain fails acceptance on correct deterministic answers (exact contact fact or QuickBooks observed balances), so every update stops at acceptance

- Area: update-failsafes. Finder severity P2, verifier severity P2.
- Location: `acceptance.mjs:1129`; verifier: acceptance.mjs:1128 (model-match FAIL when `model` is absent). The false PASS detail is at acceptance.mjs:1121-1124. Worker side: worker/src/index.js:1444 and 2030 (no model on the deterministic paths, as designed).
- Inputs: A configured Claude answer setup with a saved first probe question that the Worker answers without an LLM. Example: "What is Acme's phone number?" against a native contact card, which goes through entityFactAnswer. A QuickBooks balance or open-items question, which goes through observedAnswer, behaves the same.
- Wrong outcome: The Worker skips both the answer LLM and the verifier for these answers, so the response has no `model`. Acceptance records 'configured answer model returned an answer: claude-opus-5-5 returned answer text' (false, because no model ran) and then 'configured answer model matches: expected claude-opus-5-5; received none' as FAIL. cmdTest throws 'acceptance suite FAILED'. cmdUpgrade fails at the 'full acceptance test' stage after migrations and the active deploy, and leaves the version uncommitted. Every rerun fails the same way, because the deterministic answer is stable. The same response passes on a built-in manifest.
- Fix: Do not take model identity from the owner-question think response. Use the answer-check receipt from the previous finding for the model-match verdict. If the think check stays, treat a response whose evidence_gate.method is exact_contact_fact, quickbooks_observed_balances or quickbooks_observed_open_items and which has no model as 'answered without a model' (PASS/SKIP for the model check). Never print '<model> returned answer text' when `model` is absent.
- Verifier's fix note: In acceptance.mjs, make the check aware of the deterministic answer paths. Proposed code:

```js
const DETERMINISTIC = new Set(["exact_contact_fact", "quickbooks_observed_balances", "quickbooks_observed_open_items"]);
const deterministic = DETERMINISTIC.has(think.json?.evidence_gate?.method) && think.json?.evidence_gate?.supported === true && think.json?.model == null;
```

If `deterministic` is true:
- record "configured answer model returned an answer" as SKIP, with the detail "answered from an exact recorded field without a model; model identity not exercised by this question";
- skip the model-match record, or record it as SKIP;
- add "configured_answer_model" to this.untested.

Otherwise, keep the current PASS/FAIL checks. In every branch, change the PASS detail from "<model> returned answer text" to "answer text returned". The detail must name a model only when the response's `model` field names it.

A stronger fix: prove model identity from a probe that is guaranteed to go through generation, or from the connect-time answer-check receipt, not from the owner's first saved question.

Add a test in test/acceptance-answer-model.test.mjs. Feed it a configured manifest and a response with evidence_gate.method "exact_contact_fact" and no `model`. Assert that suite.summary().passed is true and that no record claims "claude-opus-5-5 returned answer text".
- Verification: I wrote C:\offload\review-0419-scratch\verifier-acc-model\probe-e2e.mjs. It imports the real Worker (worker/src/index.js) and the real Acceptance class from the release head. The fixture is copied from worker/test/entity-fact-answer.test.mjs: a native, reliably dated, 1-day-old contact card. The env sets ANSWER_MODEL=claude-opus-5-5 and GATE_MODEL=claude-sonnet-5-5, fetch is forbidden, and Workers AI generation throws if called.

The probe POSTs /api/rag/think with q="What is Example Contact's phone number?" and limit 5, exactly as acceptance does. The Worker result was: status 200, 0 network calls, 0 generation calls, answer "As of 2026-10-06, the record lists Example Contact's phone as +1 (202) 555-0123. [1]", evidence_gate.method exact_contact_fact, supported true, and `model` undefined.

I then fed that exact body into Acceptance.tierRetrieval:
- With manifest retrieval {answer_model: claude-opus-5-5, gate_model: claude-sonnet-5-5}: "pass configured answer model returned an answer: claude-opus-5-5 returned answer text", then "fail configured answer model matches: expected claude-opus-5-5; received none", passed=false.
- With the built-in manifest: every check passed, passed=true.

I also traced the caller chain: cmdUpgrade runStage "full acceptance test" (brain.mjs:7242) calls cmdTest with probe_questions (7682); `!out.passed` throws Fatal (7714); the D1 version commit (7244) and the manifest commit are never reached.

### 10. [P3] Worker answer-model check caps Claude at 128 output tokens while sending medium/high effort with always-on thinking; the CLI preflight uses effort low for the same probe

- Area: answers. Finder severity P3, verifier severity P3.
- Location: `worker/src/index.js:533`; verifier: worker/src/index.js:533 (checkAnswerModel's callLLM call; the cap resolves at worker/src/lib/core.js:568-572, effort is set at core.js:599-601, and the failure maps to check_problem at index.js:515)
- Inputs: brain connect anthropic runs POST /api/admin/brain/answer-check after deploy. checkAnswerModel calls callLLM with max_tokens: 128 and no anthropic_max_tokens. callLLMImpl then sends max_tokens 128 with output_config.effort 'medium' (Opus 5.5) or 'high' (Sonnet 5.5). On both models thinking cannot be disabled, and thinking tokens count against max_tokens.
- Wrong outcome: If the model's adaptive thinking on the probe uses about 128 tokens, the reply comes back stop_reason max_tokens with no text or with partial text. core.js then throws AnthropicEmptyResponseError or AnthropicIncompleteResponseError, and answerCheckStatus reports check_problem for a working key. The owner sees 'The answer model check could not be read completely... run the same check again' (CHECK_PROBLEM). Every rerun has the same odds. The effect is bounded: setup is kept, not rolled back. Not reproduced live; whether it happens depends on how long the model thinks.
- Fix: Pass anthropic_max_tokens (for example 1024) on the answer-model-check call so the probe has room for thinking. Optionally also send effort 'low' for this label only, as the CLI preflight does. Add a provider-routing test asserting the check's request body max_tokens.
- Verifier's fix note: 1. In checkAnswerModel (worker/src/index.js:527-535), pass `anthropic_max_tokens: 1024` (or 2048) alongside the existing `max_tokens: 128`. The Anthropic probe then has room for always-on thinking plus "OK". Workers AI is unaffected, because that branch reads max_tokens. The cost is trivial: actual usage is billed, and the timeout charge is about $0.02 on Opus.
2. Optionally, add a per-label effort override in core.js so that label 'answer-model-check' sends output_config.effort 'low', matching the CLI preflight at operations/answer-setup.mjs:141. The reference says low effort keeps thinking short and can skip it, but it does not promise thinking is skipped. Keep step 1 either way.
3. Add a worker test that captures the fetch body for handleAnswerCheck with Opus 5.5 and Sonnet 5.5. Assert max_tokens >= 1024, and assert the effort chosen for the check label.
- Verification: I wrote a probe, C:\offload\review-0419-scratch\answers-verify-maxtokens\probe.mjs, that imports handleAnswerCheck from C:\offload\review-0419\worker\src\index.js. It stubs globalThis.fetch to record each request body and returns the reply shape the vendor docs describe: content [{type:'thinking', thinking:'', signature:'x'}], stop_reason 'max_tokens'. The environment was ANSWER_MODEL=claude-opus-5-5, GATE_MODEL=claude-sonnet-5-5, with a fixture key and a stub DB.

Recorded bodies: [{"model":"claude-opus-5-5","max_tokens":128,"output_config":{"effort":"medium"}},{"model":"claude-sonnet-5-5","max_tokens":128,"output_config":{"effort":"high"}}]. No thinking field was sent.

Response: {"answer":{"model":"claude-opus-5-5","status":"check_problem"},"check":{"model":"claude-sonnet-5-5","status":"check_problem"}}.

I also read the existing test at worker/test/anthropic-answer-setup.test.mjs:189-204, which asserts that stop_reason max_tokens or an empty reply gives check_problem, and the CLI handling at operations/answer-setup.mjs:490-514 (transient, setup kept, CHECK_PROBLEM logged).

How long the model really thinks on this prompt was not measured live: no network.

### 11. [P3] During brain update, the reconnect-key next step prints the temporary pinned manifest path

- Area: owner-data. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:4295`; verifier: brain.mjs:4292 and brain.mjs:4295 (cmdHealth). The bad path comes from cmdUpgrade's health calls at brain.mjs:7113, 7211 and 7238, which pass executionPin.target.
- Inputs: `brain update` on a Brain set to Claude answers whose Worker has no ANTHROPIC_API_KEY (inventory.anthropic_key_missing true). Health runs inside update against executionPin.target, which on Windows is `.<manifest>.brain-update-<pid>-<hex>.tmp` in the manifest folder (brain.mjs:5903-5906).
- Wrong outcome: The update prints "Next: brain connect anthropic <...>.brain-update-<pid>-<hex>.tmp --from-clipboard". That file is deleted when the update finishes (removePinnedExecutionManifest), so the owner or assistant following the printed command gets a manifest-unavailable error.
- Fix: Pass the installed manifest path into cmdHealth (for example options.displayManifestPath) and use it for HALF_RUN and HEALTH_NEXT_STEP. Or skip these owner-facing lines when health runs inside update.
- Verifier's fix note: 1. Add an option to cmdHealth, `displayManifestPath = null`, and set `const ownerManifestPath = displayManifestPath ?? manifestPath;` at the top.
2. At 4292 use `answerSetupJournalPath(ownerManifestPath)` and `HALF_RUN(ownerManifestPath)`. At 4295 use `HEALTH_NEXT_STEP(ownerManifestPath)`.
3. In cmdUpgrade, pass `displayManifestPath: originalPin.target` in all three verifyHealth calls (7113, 7211, 7238). originalPin.target is the real manifest path, and it stays the same path after the version commit at 7272.
4. Pass the real setup manifest path the same way at 22413 and 22445.
5. Add a test that runs cmdUpgrade with a stub cmdHealth wired to the real cmdHealth and anthropic_key_missing true. It should check that the printed "Next:" line names the real manifest, not a `.brain-update-*.tmp` file.
- Verification: I wrote the probe C:\offload\review-0419-scratch\verify-health-next-step\probe.mjs. It imports cmdHealth from C:\offload\review-0419\brain.mjs and writes a manifest copy named exactly like the update's pinned file, `.store.manifest.json.brain-update-<pid>-0123456789abcdef.tmp`, with brain.domain set and Claude answer and gate models. It calls cmdHealth on that path with reachOnly, expectDrainMode "active", and a stub request: /health reports active, and /documents returns d1 with `anthropic_key_missing: true`. Then it deletes the copy, as cmdUpgrade's finally does. No network was used.

Output: health passed with no failure. It printed "warn  Answers are paused: this Brain is set to answer with Claude, but its Anthropic key is missing." and then "Next: & '...node.exe' '...brain.mjs' connect anthropic %TEMP%\probe-health-next-...\.store.manifest.json.brain-update-50032-0123456789abcdef.tmp --from-clipboard". After cleanup, "pinned exists after update: false".

The existing test at test/health-verify-exit.test.mjs:618-624 only checks that the line names whatever path health was given. No test covers health running inside update.

### 12. [P3] connect/disconnect anthropic deploy saves the workers.dev hostname after the daily definition was re-registered, so the next daily refresh refuses

- Area: owner-data. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19805`; verifier: brain.mjs:19805 (connect deploy dependency; used by both the primary deploy at operations/answer-setup.mjs:470 and the rollback deploy at :554) and brain.mjs:20740 (disconnect). The persist happens at brain.mjs:3210-3211 -> 2876-2877. The refusal is thrown at operations/daily-refresh-run.mjs:544-545.
- Inputs: A manifest with no brain.domain (a legacy workers.dev install; every `brain update` deploy uses persistDomain:false, so such manifests stay that way) with daily imports on. The owner runs `brain connect anthropic` or `brain disconnect anthropic` successfully.
- Wrong outcome: The flow re-registers the daily task for the edited manifest (answer-setup.mjs:445; disconnect brain.mjs:20736) and then deploys (answer-setup.mjs:470; brain.mjs:20740). That deploy is a plain cmdDeploy(path, { nextSteps: false }), so it calls persistWorkersDevDomain and rewrites the manifest with brain.domain (brain.mjs:3210 -> 2876-2877). The registered definition carries manifest_content_hash = digest(m) (daily-refresh-plan.mjs:262), so the next scheduled run throws "the manifest or source plan changed after daily refresh registration; run brain daily on <manifest>" (daily-refresh-run.mjs:533/548). Daily imports stop until someone notices.
- Fix: Pass `persistDomain: false` in the answer-setup and disconnect deploy calls (brain.mjs:19805, 20740) and in the rollback deploy. Or re-run reconcileDaily after the deploy, so the daily definition is bound to the final manifest bytes.
- Verifier's fix note: Change the answer-setup deploys to `cmdDeploy(path, { nextSteps: false, persistDomain: false })` at brain.mjs:19805 and brain.mjs:20740. The 19805 change also covers the rollback deploy, since answer-setup.mjs:554 uses the same deps.deploy. This matches `brain update`, and the later checkWorker/baseUrl already resolves a domain-less manifest through the account. If the token-free address should still be saved, there is another way: after deploy, reload the manifest, and if its bytes changed, run reconcileDailyDefinitionAfterManifestEdit again with previousManifest set to the pre-deploy manifest, so the registered definition matches the final manifest. Add a test with a domain-less manifest, the real reconcile, and a deploy that saves the domain, and assert that the next runDailyRefreshCli passes the definition guard.
- Verification: I wrote a probe at C:\offload\review-0419-scratch\verify-anthropic-domain\probe.mjs. It imports from the release head:
- the real runAnthropicAnswerSetup
- the real reconcileDailyDefinitionAfterManifestEdit (as both prepareDaily and reconcileDaily)
- the real buildConfiguredDailyPlan and installDailyRefreshSchedule, using an in-memory scheduler adapter, win32, and a fixed SID
- the real runDailyRefreshCli, with an expectedDefinitionHash equal to the registered definition

The manifest is domain-less (d1_database_id present, local_folder on, daily_refresh enabled). The deploy dependency makes the exact call cmdDeployWithPrompts makes at brain.mjs:3211: persistWorkersDevDomain, with a carried subdomain and verification stubbed to pass.

Result:
- "confirmed fixture-brain.ownersub.workers.dev is this brain and saved it"
- the manifest now has brain.domain
- the daily run threw "the manifest or source plan changed after daily refresh registration; run brain daily on <manifest> to reconcile it"

Control run (`node probe.mjs control`, where deploy does not save the domain): the same run passes the definition guard and reaches the source-run lock (REACHED_SOURCE_RUN).

I traced the cmdDeploy network layer (3075 reloads the manifest from disk; 3210 checks the condition) by reading the code, not by running it.

### 13. [P3] Cloudflare-side failures (secret write, deploy) are blamed on the owner's Anthropic key

- Area: owner-key. Finder severity P3, verifier severity P3.
- Location: `operations/answer-setup.mjs:559`; verifier: operations/answer-setup.mjs:558-559 (failure class set at :459-461 and :526; failureLine at :276)
- Inputs: `--from-clipboard` with a key that passed preflight. Then a Cloudflare step fails after the journal is written: putSecret throws (for example a Cloudflare auth or permission error), or cmdDeploy dies (for example 'could not set the drain cron').
- Wrong outcome: The rollback prints 'Your Brain could not answer with Claude using this key, so it was put back on the built-in model' and 'Anthropic refused the test message for a reason this installer does not recognize. Nothing was changed. Support code: ANTHROPIC_CHECK_FAILED.' Anthropic never refused anything, and the key is good. The owner is steered to the Claude Console to replace a working key, while the real fault (Cloudflare access or deploy) is only in the trailing error line.
- Fix: Use the key-blaming text (ROLLED_BACK_BUILT_IN and PREFLIGHT_COPY) only when `error.workerCheck` is present or the preflight failed. For other failures, log neutral rollback text that names the failed Cloudflare or local step (secret write, deploy, daily reconcile, time limit). Give them their own support code instead of ANTHROPIC_CHECK_FAILED.
- Verifier's fix note: In the rollback catch, use key-blaming copy only when the Worker returned a verdict: `const keyVerdict = Boolean(error?.workerCheck);`.

1. Change :558 to `log(rollbackTarget === "previous" ? ROLLED_BACK_PREVIOUS : keyVerdict ? ROLLED_BACK_BUILT_IN : ROLLED_BACK_STEP_FAILED);`.
2. Change :559 to `log(keyVerdict ? failureLine(failureClass) : error.message);`. error.message is already free of the key: putSecret uses a fixed string, and DAILY_RECONCILE_FAILED carries its own guidance.
3. Add ROLLED_BACK_STEP_FAILED to answer-setup-copy.mjs. Suggested text: "A setup step in Cloudflare or on this computer did not finish, so your Brain was put back on the built-in model. Your Anthropic key was not the problem. Fix the item below, then rerun the same command."
4. At :461, give the putSecret failure its own support code, for example ANTHROPIC_SECRET_WRITE_FAILED, instead of ANTHROPIC_CHECK_FAILED. Register it in support-journal.mjs and support-recovery.mjs, and add a runbook line.
5. Add a test that a putSecret failure and a first-deploy failure log neither ROLLED_BACK_BUILT_IN nor CHECK_FAILED.
- Verification: I wrote C:\offload\review-0419-scratch\owner-key-verify\cli-copy-probe.mjs. It drives the real exported cmdConnectAnthropic from brain.mjs (not just the inner function) with injected options: a built-in manifest, preflight ok, `--from-clipboard`, and console.log captured. Results:

(a) putSecret throws a Cloudflare 500. Stdout: "Your Brain could not answer with Claude using this key, so it was put back on the built-in model. Fix the item below, then rerun the same command." Then "Anthropic refused the test message for a reason this installer does not recognize. Nothing was changed. Support code: ANTHROPIC_CHECK_FAILED." The Fatal is "the Anthropic secret could not be stored" with supportCode ANTHROPIC_CHECK_FAILED.

(b) The first deploy throws "could not set the drain cron" and the rollback deploy succeeds. Stdout shows the same two lines, and the Fatal is "could not set the drain cron".

(c) Extra case: checkWorker throws "the answer model check did not return a valid receipt". Same two lines again.

(d) Control: the Worker returns key_rejected. Correct KEY_REJECTED copy.

In (a) through (c) the final manifest is built-in, no secret is left, and the journal is removed. So the rollback works and only the copy is wrong. I also read the top-level CLI handler (brain.mjs:33614-33634). It prints the Fatal as "fail <message>" after those stdout lines.

### 14. [P3] Dashboard mode can say 'Your key works' or 'Done' when nothing has checked the key

- Area: owner-key. Finder severity P3, verifier severity P3.
- Location: `operations/answer-setup.mjs:509`; verifier: operations/answer-setup.mjs:509 (also :493-506, where daily_limit leads to DONE_LINES; copy at operations/answer-setup-copy.mjs:25-26)
- Inputs: `--key-set-in-dashboard` (no local preflight). The Worker check returns only busy, spend_check_paused (no Anthropic call made) or daily_limit (blocked before any call). Or the deployed models do not echo back within 60 seconds.
- Wrong outcome: The run completes and removes the journal. The manifest stays on Claude, and the owner is told 'Your key works, but your Brain's own test could not finish yet' (or 'Done. Claude Opus now writes your answers...') though no request ever proved the pasted secret. A bad paste shows up later as paused answers.
- Fix: Count the key as proven only by `keyPreflightOk || statuses.includes("ok") || statuses.includes("check_problem")`. When the key is not proven (dashboard or keep with only busy, spend_check_paused, daily_limit or no echo), roll back through the journal, or keep it, and print text that says the key has not been verified yet. Never print 'Your key works' without proof.
- Verifier's fix note: After the statuses are computed at :488, add `const keyProven = keyPreflightOk || statuses.some((s) => s === "ok" || s === "check_problem");`. Only an Anthropic reply proves the key; busy, daily_limit, spend_check_paused and a missing model echo do not.

1. At :493-506, print DONE_LINES only when `keyProven`. When `dailyLimit && !keyProven`, print LIMIT_ALREADY_REACHED plus a new line that says the key has not been tested yet.
2. Replace the always-true guard at :509 with `if (transient)`. Then branch: when `keyProven`, keep today's CHECK_PENDING / CHECK_PROBLEM. Otherwise, either roll back through the journal (throw with `answerSetupClass` = "unverified", so a built-in owner returns to built-in and a dashboard secret they set is kept) or keep the change but print a new KEY_NOT_YET_TESTED line. Suggested wording: "Claude is set up, but your key has not been tested yet. In a few minutes, run: brain connect anthropic <manifest> --keep-key".
3. Never print "Your key works" or "Done. Claude Opus now writes your answers" without `keyProven`. This also covers the `--keep-key` rerun of a key that was only ever set in the dashboard.
4. Add a dashboard-mode test for each of busy, spend_check_paused, daily_limit and a stale model echo.
- Verification: Wrote C:\offload\review-0419-scratch\verify-owner-key-dashboard\probe.mjs. It imports runAnthropicAnswerSetup from the release head with every dependency injected: platform win32, the secret name present, a fake clock advanced by sleep. Output:

- **Dashboard from built-in, Worker busy:** manifest ends opus-sonnet, journal-remove called, no preflight call. Line: "Your key works, but your Brain's own test could not finish yet..."
- **Dashboard from built-in, spend_check_paused:** same result and the same "Your key works" line.
- **Dashboard over an existing Claude pair, daily_limit:** returns success and prints LIMIT_ALREADY_REACHED, then "Done. Claude Opus now writes your answers and Claude Sonnet checks them...".
- **Dashboard from built-in, Worker echoes the built-in model for 60s:** 31 Worker checks, then the manifest stays opus-sonnet, the journal is removed, and "Your key works..." is printed.
- **Control, dashboard + key_rejected:** rolls back to built-in correctly.
- **Control, clipboard + busy:** the preflight ran, so "Your key works" is true there.

I also read worker/src/lib/core.js callLLMImpl and confirmed daily_limit and spend_check_paused are thrown before any fetch to Anthropic.

### 15. [P3] --key-set-in-dashboard: a key the Worker rejects stays stored and is not rolled back, and the fix-it text sends the owner in a loop

- Area: owner-key. Finder severity P2, verifier severity P3.
- Location: `operations/answer-setup.mjs:527`; verifier: operations/answer-setup.mjs:527-531 (rollback target), with operations/answer-setup-copy.mjs:13 (KEY_REJECTED used for every mode) and support-recovery.mjs:61
- Inputs: Windows owner uses the masked Cloudflare field route: `brain connect anthropic <manifest> --key-set-in-dashboard`. The value pasted into the ANTHROPIC_API_KEY secret is not accepted by Anthropic, so the Worker answer-check returns key_rejected for both models. Case A: the Brain already ran the Claude pair (opus-sonnet) with an older key, and the owner replaced that secret in the dashboard. Case B: the Brain was on the built-in model.
- Wrong outcome: Case A: the rollback picks 'previous' and leaves the Brain on Claude Opus/Sonnet with the rejected secret. Answers stay paused with the 'Anthropic account needs attention' error, yet the owner is told 'your Brain was put back exactly as it was' and 'Nothing was changed'. That contradicts the reviewed promise 'A key that fails puts the built-in model back.' Case B: the Brain goes back to built-in, but the rejected secret is kept. The owner is told to 'create a new key ..., click Copy, and rerun the same command'. Dashboard mode never reads the clipboard. Because the secret name now exists, the rerun skips DASHBOARD_STEPS and re-tests the same rejected secret. It fails the same way on every rerun.
- Fix: Treat a Worker-confirmed rejection of the stored secret as rejected whoever wrote it: `const storedKeyRejected = Boolean(error?.workerCheck) && failureClass === "key_rejected" && (keyWritten || mode === "dashboard");`. Use it in place of writtenKeyRejected for keepPrevious and shouldDelete: roll back to built-in and delete the secret unless rerank needs it. In dashboard mode, replace KEY_REJECTED with dashboard steps: open the Worker, then Variables and Secrets, edit ANTHROPIC_API_KEY, paste the new key, Save, rerun. Drop 'Nothing was changed'. For --keep-key, point the owner to --from-clipboard with a new key, not 'the same command'. Add a test for dashboard mode with key_rejected, both with and without a prior Claude pair.
- Verifier's fix note: 1. In the catch block, separate "the Worker rejected the stored key" from "this run wrote the key":
   `const storedKeyRejected = Boolean(error?.workerCheck) && failureClass === "key_rejected";`
   Use storedKeyRejected in place of writtenKeyRejected inside keepPrevious, so a Worker-confirmed rejection always rolls back to built-in. That matches "A key that fails puts the built-in model back" and the support-recovery protection line.
2. Keep writtenKeyRejected for shouldDelete if the owner's own dashboard secret should not be deleted. Or delete it in dashboard mode too, so the next rerun shows DASHBOARD_STEPS again. Pick one, and make the copy match.
3. Make the key_rejected copy depend on the mode:
   - **Dashboard:** "Anthropic did not accept the key saved in Cloudflare. Create a new key in the Claude Console, then in Cloudflare open your Brain's Worker, Settings, Variables and Secrets, edit ANTHROPIC_API_KEY, paste the new key and Save. Then rerun the same command." Do not say "click Copy" and do not say "Nothing was changed" after a rollback.
   - **Keep-key:** point to `brain connect anthropic <manifest> --from-clipboard` with a new key, not "the same command".
4. Add tests for dashboard and keep-key with workerStatus key_rejected, both with an earlier built-in setup and with an earlier Opus/Sonnet pair. Assert the final setup is built-in and the printed next step can succeed.
- Verification: I wrote and ran C:\offload\review-0419-scratch\verify-ownerkey-dashboard\probe.mjs. It imports runAnthropicAnswerSetup from the release head with injected deps (fake secret store and a Worker check that returns key_rejected for both models) and runs 4 scenarios:
- **A, dashboard, earlier Opus/Sonnet, secret present:** setup=opus-sonnet, secret_stored=true, deleted=[], rolled_back=true, target=previous. Lines: ROLLED_BACK_PREVIOUS, KEY_REJECTED. Error: KEY_REJECTED / ANTHROPIC_KEY_NOT_ACCEPTED.
- **B, dashboard, earlier built-in, secret present, run twice:** both runs give setup=built-in, secret_stored=true, deleted=[], target=built-in, lines ROLLED_BACK_BUILT_IN and KEY_REJECTED. DASHBOARD_STEPS is never shown, and the second run repeats the same failure.
- **C, clipboard, earlier Opus/Sonnet (control):** setup=built-in, and the secret is deleted. This confirms the asymmetry comes only from keyWritten.
- **D, keep-key with --daily-cap, earlier Opus/Sonnet:** same result as A (target=previous, KEY_REJECTED).

I also confirmed:
- The Worker's handleAnswerCheck maps 401/403 to "key_rejected" (worker/src/index.js:514-522, 541-548).
- cmdConnectAnthropic passes the error through unchanged (brain.mjs:19771-19836).
- printSupportReceipt (brain.mjs:709-713) points to `brain support --explain`. For this code, support-recovery.mjs:61 says to retry with --from-clipboard.
- The test "keep, dashboard, and clipboard failures preserve a working pair" (test/anthropic-connect.test.mjs:590-605) uses only workerStatus "error". No test covers dashboard or keep mode with key_rejected.

### 16. [P3] The clipboard-clear warning says 'Claude answers are connected' on failed and rolled-back runs

- Area: owner-key. Finder severity P3, verifier severity P3.
- Location: `operations/answer-setup-copy.mjs:20`; verifier: operations/answer-setup-copy.mjs:20 (constant). Emitted from operations/answer-setup.mjs:347, reached through :556 and :570.
- Inputs: `brain connect anthropic <manifest> --from-clipboard` on Windows. The run fails or rolls back (preflight key_rejected or billing, or a Worker key_rejected), and the PowerShell Set-Clipboard call also fails.
- Wrong outcome: The owner sees 'Claude answers are connected, but this command could not clear the clipboard' right before 'Anthropic did not accept this key ... Nothing was changed', or after a rollback to built-in. The two lines contradict each other, and the owner may believe Claude answers are live.
- Fix: Make the warning neutral ('This command could not clear the clipboard. Clear it now before closing the key window; a clipboard history app may still keep a copy.'). Or pick the text from `completed`, so 'connected' appears only on the success paths.
- Verifier's fix note: Make the constant outcome-neutral in operations/answer-setup-copy.mjs:20: `export const CLIPBOARD_CLEAR_WARNING = "This command could not clear the clipboard. Clear it now before closing the key window; a clipboard history app may still keep a copy.";` That way it reads correctly on success, refusal and rollback. The existing success test at test/anthropic-connect.test.mjs:651 still passes, because it compares against the constant. Add a test that runs a preflight `key_rejected` with a throwing `clearClipboard` and asserts: the warning is logged, no logged line matches /answers are connected/i, and the thrown error is KEY_REJECTED. If the success-path wording should stay, choose the text inside `clearClipboardNow` instead: use `completed ? <connected wording> : <neutral wording>`.
- Verification: Wrote C:\offload\review-0419-scratch\verifier-clipboard\probe.mjs. It calls the real CLI entry `cmdConnectAnthropic` from C:\offload\review-0419\brain.mjs with `{ "from-clipboard": true }`, platform win32, injected fixtures and a `clearClipboard` that throws. Ran `node C:\offload\review-0419-scratch\verifier-clipboard\probe.mjs`. In all 5 cases stdout first printed "Claude answers are connected, but this command could not clear the clipboard. Clear it now before closing the key window; a clipboard history app may still keep a copy." Then a Fatal was thrown:
(1) preflight key_rejected -> "Anthropic did not accept this key ... Nothing was changed."
(2) preflight billing -> "Your Anthropic account needs credit ... Nothing was changed."
(3) clipboard read throws -> "clipboard command failed"
(4) half-run journal present -> "An earlier answer setup stopped halfway ..."
(5) clipboard holds "hello" -> "That does not look like an Anthropic API key ... Nothing was changed."
By code reading, the Worker key_rejected rollback path (:556 then :558) prints the same line before ROLLED_BACK_BUILT_IN. The release checkout was not modified.

### 17. [P3] --json success output silently drops the 'clipboard could not be cleared' warning

- Area: owner-key. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:19814`; verifier: C:\offload\review-0419\brain.mjs:19814 (also brain.mjs:19824-19831 JsonFatal payload; operations/answer-setup.mjs:292-304 resultReceipt and :337-350 clearClipboardNow)
- Inputs: `brain connect anthropic <manifest> --from-clipboard --json` (the documented flag). The run succeeds but clearCustomApiClipboard fails.
- Wrong outcome: Only the success receipt is printed. CLIPBOARD_CLEAR_WARNING is collected but never shown, and the receipt has no clipboard field. A caller or the owner cannot tell that the live API key is still on the clipboard, which is the one step meant to clean up the key after entry.
- Fix: Add `clipboard_cleared: <bool>` (null when not in clipboard mode) to resultReceipt and to the JsonFatal payload. In JSON mode, write CLIPBOARD_CLEAR_WARNING to stderr so stdout stays valid JSON.
- Verifier's fix note: 1. In operations/answer-setup.mjs, pass the clipboard state into resultReceipt and add one field: `clipboard_cleared: mode === "clipboard" ? clipboardCleared : null` (call sites at lines 507 and 514). Before rethrowing in the catch and finally paths, set `error.clipboardCleared = mode === "clipboard" ? clipboardCleared : null`.
2. In brain.mjs cmdConnectAnthropic:
   - Success branch (line 19814): when flags.json is true, keep stdout as the single JSON line, and write every logged line, or at least CLIPBOARD_CLEAR_WARNING when present, to stderr (process.stderr.write(line + "\n")). An operator watching the terminal then still sees it.
   - JsonFatal payload (lines 19824-19831): add `clipboard_cleared: error?.clipboardCleared ?? null` and write the same warning to stderr.
3. Split the copy so a failed run does not claim success. Keep CLIPBOARD_CLEAR_WARNING for the success path. Add a neutral variant, e.g. "This command could not clear the clipboard. Clear it now; a clipboard history app may still keep a copy.", and log that one when clearClipboardNow runs from the rollback or finally path without completed=true.
4. Add tests in test/anthropic-connect.test.mjs. Run cmdConnectAnthropic with {"from-clipboard": true, json: true} and a throwing clearClipboard, and assert all of these:
   - stdout parses as one JSON object with clipboard_cleared === false;
   - stderr contains the warning;
   - a key-rejected JSON failure carries clipboard_cleared === false in the JsonFatal payload.
- Verification: Probe at C:\offload\review-0419-scratch\verifier-owner-key-json-clipboard\probe.mjs. It imports cmdConnectAnthropic from C:\offload\review-0419\brain.mjs with injected deps, `--from-clipboard`, preflight ok, the Worker echoing claude-opus-5-5/claude-sonnet-5-5, and clearClipboard throwing. It captures process.stdout/stderr and console.*.
- json=false, worker ok: stdout starts with CLIPBOARD_CLEAR_WARNING, then the DONE lines (no "clipboard was cleared" line). Warning shown: true.
- json=true, worker ok: stdout is only `{"preset":"opus-sonnet",...,"key_written":true,"worker_check":{...},"rolled_back":false,"rollback_target":null}`. stderr is empty. Warning shown: false. Receipt keys: preset, answer_model, gate_model, daily_cap_usd, secret_name, key_written, worker_check, rolled_back, rollback_target (no clipboard field).
- json=true, worker busy (CHECK_PENDING success branch): same result. No warning, no clipboard field.
- Key leaked in any case: false.

Second probe at C:\offload\review-0419-scratch\verifier-owner-key-json-clipboard\probe-fail.mjs (preflight key_rejected, clear throws):
- json=true: nothing printed. JsonFatal payload is {schema_version, operation, status, error_code:"anthropic_key_not_accepted", rolled_back:false, rollback_target:null}. Warning printed: false.
- json=false: prints "Claude answers are connected, but this command could not clear the clipboard..." and then Fatal "Anthropic did not accept this key... Nothing was changed." The two messages contradict each other.

Caller check: grep across the release head (tests excluded) found no `connect anthropic ... --json` invocation. technician-setup.mjs:907-914 and claude-workspace.mjs:102/527 use --from-clipboard without --json.

### 18. [P3] Every resumed interrupted update is told 'An older CLI lowered the recorded value'

- Area: update-failsafes. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:6982`; verifier: brain.mjs:6979-6984 (warning text at brain.mjs:6982), cmdUpgrade, release head f8a7cd0
- Inputs: A schema-48 update that stops partway through migrations, for example after 0049-0052 were inserted into schema_migrations, then a rerun of brain update. This is the supported recovery for the supervised update.
- Wrong outcome: cmdMigrate writes install_state.schema_version only after all pending migrations. An interrupted run therefore always leaves recorded schema 48 below ledger max 52. On rerun, cmdUpgrade states as fact 'recorded schema 48 is below ledger maximum 52. An older CLI lowered the recorded value.' That diagnosis is wrong, and the operator may go looking for an old CLI that never ran.
- Fix: Word it as 'The recorded schema is behind the migration ledger (an interrupted update or an older CLI can cause this). This update will repair it.' Or tell the cases apart with the upgrade_runs 'failed' row or a saved migration intent.
- Verifier's fix note: In cmdUpgrade, replace the claim that states a cause with one that names both possible causes. Replace the string at brain.mjs:6982 so the warning reads: `recorded schema ${recordedSchema} is behind the migration ledger maximum ${ledger.maxAppliedVersion}. An interrupted update or an older CLI can cause this. This brain update will repair and verify it; if this run stops, run brain update again.`

Optional: name the specific cause only when it is proved. For example, if the newest upgrade_runs row has status 'failed' and detail 'stage:migration', say "the previous update stopped during its migrations". Keep the neutral wording as the fallback, because logRun('failed') is best-effort and may never have been written.

Add a case to test/fix-update-0419-ledger.test.mjs: install_state schema 48 with ledger appliedThrough(52). Assert that the update warning does not claim an older CLI as the cause, and that it still reports the repair.
- Verification: I wrote and ran the probe at C:\offload\review-0419-scratch\verify-older-cli-warning\probe.mjs. It imports the real brain.mjs from C:\offload\review-0419 and uses a fake in-memory D1. The intent directory and manifest are in the scratch folder. No network calls, no keys, and the review checkout stayed untouched (`git status` is clean).

Phase 1: the real cmdMigrate starts from ledger 1..48 and install_state schema_version 48. The fake D1 throws on the first statement after the 0052 ledger insert. Result: "phase1 error: synthetic: the connection dropped while applying 0053", "ledger max after phase1: 52", "install_state writes in phase1: 0 recorded schema still: 48".

Phase 2: the real cmdUpgrade reruns on the same state, and the run stops at bookmark capture. Result: plan ['pending: 0053-0056 (4)'], and warnings = ['recorded schema 48 is below ledger maximum 52. An older CLI lowered the recorded value. This brain update will repair and verify it; if this run stops, run brain update again.'].

The false diagnosis appears on the ordinary resume after an interrupted update.

### 19. [P3] The lock-busy message tells the owner to run commands that do not exist, and asserts 'still running' when the holder could not be identified

- Area: update-failsafes. Finder severity P3, verifier severity P3.
- Location: `operations/brain-lifecycle-lock.mjs:422`; verifier: operations/brain-lifecycle-lock.mjs:421-424 (message); operations/brain-lifecycle-lock.mjs:99 (null identity treated as same process); owner-visible via brain.mjs:19836 (`brain connect anthropic` -> die(error.message))
- Inputs: Lock contention where the contending operation name is internal, for example 'answer-setup-disconnect', 'daily-schedule', 'provenance-target-repair-approval', 'record' or 'plan'. Or a live PID whose start time PowerShell cannot read (blocked, constrained language, timeout), so processStartIdentity returns null.
- Wrong outcome: The message says 'Wait for it to finish, then run brain answer-setup-disconnect again', and no such command exists (the real one is `brain disconnect anthropic`). When the identity lookup fails, sameProcessIdentity(stored, null) returns true, and the message states 'That process is still running' even when the PID now belongs to an unrelated program.
- Fix: Have callers pass a user-facing retry command, or map the operation to a command, and leave out the 'run brain ...' clause when there is none. When observedInstance is null, say the holder 'appears to be running (its identity could not be verified)'. Show created_at in local time.
- Verifier's fix note: 1. Add an optional `retryCommand` to acquireBrainLifecycleLock and withBrainLifecycleLock(Wait). Callers pass the real CLI form, for example `brain connect anthropic <manifest>`, `brain disconnect anthropic <manifest>`, `brain daily on <manifest>`, `brain load <manifest>`, `brain update`. Append "then run <retryCommand> again" only when one was passed; otherwise say "then run the same command again." Never put the internal operation name after "brain".
2. Track whether the holder was verified. Set `verified = live && owner.process_instance && observedInstance && sameProcessIdentity(...)`. When verified, say "That process is still running." Otherwise say "A process with that ID is still running, but this computer could not confirm it is the same one; if nothing Brain-related is open, wait a few minutes or restart the computer, then try again." Keep the lock as it is today; not reaping is the safe choice.
3. Optionally show created_at in local time.
4. Related (separate, already in the base): make crash() not route BrainLifecycleLockError (code brain_lifecycle_busy) into the Cloudflare internet-drop branch. For example, check `err instanceof BrainLifecycleLockError` before the `retryable` test, or have the CLI lock wrappers convert busy into a Fatal. Otherwise disconnect, load, ingest, schedule and update never show the lock text at all.
5. Add a test that asserts the busy message for operation "answer-setup" names `brain connect anthropic`.
- Verification: I wrote a probe at C:\offload\review-0419-scratch\lockmsg-verify\probe.mjs. It imports operations/brain-lifecycle-lock.mjs from the release head, uses a scratch manifest and machineLockRoot, and replaces restrictWindowsDirectory with a no-op.

- Case 1: one acquire holds "daily-refresh" and a second requests "answer-setup". It threw brain_lifecycle_busy with retryable=true and "...held by daily-refresh since 2026-10-24T03:08:28.814Z. That process is still running. Wait for it to finish, then run brain answer-setup again." With "answer-setup-disconnect" it said "run brain answer-setup-disconnect again."
- Case 2: a hand-written owner file for a live child node PID, with stored process_instance "epoch:1000000000000" and processInstance returning null. The lock was not reaped and the message said "That process is still running ... then run brain load again."
- Case 3: the same owner, but the lookup returns a mismatched identity. The lock was reaped and acquired, which shows Case 2 depends only on the null lookup.

Code trace of the owner-visible path: cmdConnectAnthropic (brain.mjs:19712) -> runAnthropicAnswerSetup -> lock({operation:"answer-setup"}) at operations/answer-setup.mjs:358 -> catch at brain.mjs:19817 -> die(error.message) at brain.mjs:19836 -> top-level prints "fail  <message>".

The disconnect, load, ingest, schedule and update paths rethrow the raw error. crash() at brain.mjs:24596 matches `err?.retryable === true` and prints the Cloudflare internet-drop text instead.

test/brain-lifecycle-lock.test.mjs:103-105 only asserts "run brain update again", the one operation whose name is also a real command.

### 20. [P3] brain doctor reports a structurally invalid migration ledger as an optional 'not checked' warning, while update hard-refuses it

- Area: update-failsafes. Finder severity P3, verifier severity P3.
- Location: `brain.mjs:21458`; verifier: brain.mjs:21458 (buildChecksumDriftCheck); root cause at brain.mjs:21268-21273 (diagnoseChecksumDrift catch)
- Inputs: A ledger that the new shared validator rejects: an unknown row, a gap, or a name that differs from the sealed file. The operator runs `brain doctor <manifest>` as the pre-update checkup.
- Wrong outcome: diagnoseChecksumDrift returns {checked:false, reason:<validation message>} for MigrationLedgerValidationError, exactly as it does for a transport failure. buildChecksumDriftCheck turns that into D_WARN 'migration checksums: not checked: the migration ledger has a gap at 0049' with no fix line. Doctor closes with 'checkup complete (1 optional item(s) not set up)'. `brain update` then stops with 'update stopped before the pause because the migration ledger has a gap...'. The checkup that exists to catch update blockers before the session misses this one. repair-checksum also refuses it, so there is no named next step.
- Fix: Return a distinct result for MigrationLedgerValidationError from diagnoseChecksumDrift, for example {checked:true, invalid:message}. Have buildChecksumDriftCheck return D_FAIL 'brain update will refuse this ledger: <message>' with a fix line that routes to support or technician review. Keep D_WARN only for an unreadable ledger.
- Verifier's fix note: 1. In diagnoseChecksumDrift's catch (brain.mjs:21268), add a branch before the generic return: `if (error instanceof MigrationLedgerValidationError) return { checked: false, invalid: true, reason: String(error.message).slice(0, 160) };`. Keep `checked:false` so that printChecksumDriftDiagnosis and cmdRepairChecksum keep refusing instead of reading a missing `drift` array.

2. In buildChecksumDriftCheck, before the `!diagnosis.checked` WARN branch, add: `if (diagnosis.invalid) return { name: "migration checksums", status: D_FAIL, detail: `brain update will refuse this ledger: ${diagnosis.reason}`, fix: "The migration ledger does not match the sealed migration files. Nothing was changed.\n  Do not run brain update, --repair or --repair-checksum; none of them can fix a ledger structure problem.\n  Send this doctor output to [INSTALLER CONTACT] for technician review." };`. Keep D_WARN only for the unreadable or transport cases.

3. Optionally, in cmdRepairChecksum, die with the same technician-review wording when `diagnosis.invalid` is set.

4. Add a doctor test that asserts a gap ledger produces D_FAIL and a non-zero exit, while a read failure still produces D_WARN.
- Verification: 1. Ran the focused test `node --test test/fix-update-0419-ledger.test.mjs` from C:\offload\review-0419: 10/10 pass. These tests show:
   - migrate refuses an unknown row, a gap and a renamed row before any write.
   - cmdUpgrade refuses an unknown row with zero remote mutations.
   - diagnoseChecksumDrift returns checked:false for an unknown row.

2. Wrote and ran C:\offload\review-0419-scratch\verify-doctor-ledger\probe.mjs. It imports the release brain.mjs and calls the exported diagnoseChecksumDrift with an injected manifest, account and D1 query, against 56 sealed migrations. Results:
   - healthy ledger, rows 1-48: `{checked:true, drift:0}`
   - gap (rows 1-48 plus 50): `{checked:false, reason:"the migration ledger has a gap at 0049"}`
   - unknown row 99: `{checked:false, reason:"the migration ledger contains unknown migration row 0099"}`
   - row 48 renamed: `{checked:false, reason:"the migration ledger name for 0048 does not match the sealed file 0048_m"}`
   - transport failure: `{checked:false, reason:"could not read schema_migrations: fetch failed"}`. Same shape as the three invalid ledgers.
   - doctorClosingMessage(true, 1) returns "checkup complete (1 optional item(s) not set up)".

3. buildChecksumDriftCheck is not exported. Its mapping of checked:false to D_WARN with no fix (brain.mjs:21458-21459) I traced by reading, not by running it. cmdDoctor calls it with no options (brain.mjs:21583), so I could not inject a fake there offline.

4. Confirmed by reading that probeUpgradePause (around brain.mjs:21025-21059) only reads /health. I also saved the base brain.mjs to the scratch folder and confirmed the base diagnoseChecksumDrift had no structural validation.

## Refuted or uncertain

- [refuted] Disconnect returns the Brain to the built-in model but leaves the shared daily cap at the $5 that connect set, so the OCR budget is quietly halved (`brain.mjs:20727`). The mechanics are as described, but they are the intended, tested design, not a defect with a wrong outcome.

1. It is deliberate and covered by a test. test/anthropic-connect.test.mjs:843 is titled "disconnect clears both models, preserves the cap, reconciles, removes the secret, and is idempotent". It asserts `current.safety.daily_llm_spend_cap_usd` is unchanged after disconnect. The focused test passes on the release head. Disconnect is meant to reset only the answer models. `safety.daily_llm_spend_cap_usd` is a Brain-wide safety setting, not something that belongs to connect. Disconnect cannot tell a $5 that connect set from a $5 the owner chose.

2. The owner is told when the cap changes. Connect is the only step that lowers the cap, and on success it prints `Daily limit: $${cap}` (DONE_LINES, operations/answer-setup-copy.mjs:50). The decision text the owner approves before connect says the Brain stops at $5 (answer-setup-copy.mjs:84). The answer contract says "The same limit also covers reading scanned pages" (answer-setup-copy.mjs:97). Disconnect changes nothing about the cap, so it has no new limit to announce.

3. It fails safe. A lower spend ceiling can only reduce spending. When OCR hits the cap, ingest/ocr-client.mjs:266-270 stops with "No document was marked unreadable; re-run once the cap resets or raise safety.daily_llm_spend_cap_usd". So no data is lost or corrupted, no answer is wrong, no document is marked unreadable by mistake, and the message names the remedy. Scanned-page reading starts again at the UTC reset.

4. The journal is used only for rollback when connect fails. There, restoreManifestFromAnswerSetupJournal does restore the cap (operations/answer-setup.mjs:267, 528-534). That is the "undo a failed change" contract. A successful connect followed by a later, deliberate disconnect is a different operation. The design keeps the owner's current cap there, and the test says so.

What remains is a product choice: whether disconnect should give back the pre-Claude $10. That is a preference, not a guard that can be bypassed or a figure shown wrongly. It is also not on the store owner's schema 48 to 0049-0056 update path, which never runs connect or disconnect.

## Coverage by area

### answers

Read the full diff and the surrounding code for: worker/src/lib/core.js (callLLMImpl from start to end, anthropicRate, llmText, the Empty/Incomplete error classes, ANSWER_AND_CHECK_LABELS, anthropicEffort, timeout charging, classifyAnthropicFailure, readSpend/capUsdFor/degraded budget, logCall, and the Workers AI branch); worker/src/index.js (rerank, answerModelFor/gateModelFor, answerCheckStatus/checkAnswerModel/handleAnswerCheck and its admin-gated route placement, all of handleDocumentThink: answer/repair loop, synthesis gate null path, evidence gate callVerifier retry and unreadable verdict, answerWithheldGate, anthropic_key_missing gap, answer_resumes_at, plus the handleDocuments anthropic_key_missing flag and the doRerank gate); worker/src/lib/synthesis-answer.js; worker/src/lib/answer-render.js and frontend/src/lib/answer-render.js (I confirmed the bundled app-assets.js carries the new copy); worker/src/lib/query-timing.js; worker/src/lib/mcp-endpoint.js and the components/brain-mcp.mjs/brain-mcp-runtime.mjs diffs; acceptance.mjs (the think section, answerUnavailableDiagnostic, run/passed) and its update caller in brain.mjs (verifyAcceptance, the update stage failure path); operations/answer-setup.mjs (preflight, worker-check status handling, rollback); worker/src/lib/ledger-answer.js response shape; wrangler.toml.template, manifest.schema.json, templates/brain.manifest.json, CHANGELOG and the evidence-plan items for this area.

Checked and found sound: thinking-first or multi-block content parsing (llmText filters to text blocks; no content[0] readers remain in source); empty, max_tokens and refusal replies fail closed in the answer, synthesis gate and evidence gate (no truncated or unverified draft is returned); missing key on answer and check labels refuses without a Workers AI call and adds the gap; cap and degraded-guard errors map to the right reviewed copy; per-model rates match the claude-api reference ($4/$20, $2/$10, $0.10/$0.50, $1/$5); thinking tokens are not double-counted; timeouts are charged at the worst-case estimate and counted by readSpend (status != 'blocked'); effort is sent only for Opus/Sonnet 5.5 and not for the Haiku 4.5 rerank; no temperature is sent to Anthropic; the answer-check route sits behind the admin key. For a built-in owner (the scheduled update), Worker answer behavior is unchanged.

Not new and not reported: the cap is a pre-call check with a 60-second cross-isolate cache (pre-existing and now documented); a ledger-answer probe already fails acceptance's response contract (pre-existing).

Tests run (focused, read-only): node --test worker/test/provider-routing.test.mjs worker/test/anthropic-answer-setup.test.mjs (9/9 pass); node --test --test-name-pattern=... worker/test/routes.test.mjs (483 pass). Probes: C:\offload\review-0419-scratch\area1\probe-acceptance.mjs and probe-acceptance2.mjs.

Not checked: live Anthropic behavior (whether Opus/Sonnet thinking fits the 128/4000/8000 caps; the exact `model` echo in responses); the CLI connect flow beyond the worker-check status handling; doctor.mjs; recovery-adapter GATE_MODEL handling; update/migration stages.

### owner-key

I checked whether the key can leak and found no leak. All probes and focused tests ran against the read-only checkout C:\offload\review-0419. Scratch probes are in C:\offload\review-0419-scratch\area2\.

How I traced the key:
- Reading the clipboard (operations/custom-api-clipboard.mjs). The key is read from powershell.exe `Get-Clipboard -Raw` stdout. It is never placed in arguments, environment, files or output. Clearing uses `Set-Clipboard -Value $null`.
- Trimming the line ending. A PowerShell probe with dummy strings confirmed that -Command stdout adds exactly one "\r\n" and does not wrap at 300 characters, so stripping one line ending is correct.
- Key format check: validAnthropicKeyShape.
- preflightAnthropicKey: in-process fetch to a fixed host. Errors are swallowed and response bodies are read only to classify them, under a size limit.
- Writing the secret (putSecret, then cf/cfOnce/http in brain.mjs). Cloudflare errors never include the request body, and runAnthropicAnswerSetup replaces any secret-write error with a generic one.
- Other local outputs. The journal holds only models, cap and booleans. Also checked: resultReceipt, the JSON output and JsonFatal, every message in answer-setup-copy, cmdConnectAnthropic and cmdDisconnectAnthropic, and assertLiveAnswerSetupWorker.
- Support files. support-journal.mjs takes no free text, only the new codes. support-recovery.mjs is a fixed catalog.
- Doctor: checkAnthropicKey and checkAnthropicWorkerSecret read secret names only and ignore the environment.
- Environment variable: cmdSecrets now ignores ANTHROPIC_API_KEY from the environment and warns, and reconcileWorkerProviderSecrets and optionalWorkerSecretNames stay in step.
- Technician: childCommands and the child environment allowlist carry no key in arguments or environment.
- Deploy: there is one script upload path (keep_bindings secret_text). The custom_api token_secret prefix guard stops the Anthropic secret name being reused.
- Recovery: the recovery adapter handles secret names only and prints RECOVERY_KEY_LINE.
- Worker. In core.js, callLLM calls a fixed Anthropic host, and the missing-key block is in place. logCall stores label, model, status and micros only. Anthropic error text never echoes a key. Also checked: handleAnswerCheck (statuses and model ids only), the anthropic_key_missing boolean, admin-key gating of /api/admin/brain/answer-check, answer-render's reviewed text, and the MCP descriptions.
- Repository scans: env-dump search across worker/src, and the whole diff for key-shaped literals (none found).

Tests: the focused suites pass: test/anthropic-connect.test.mjs (34/34), test/doctor-anthropic-secret.test.mjs (4/4) and worker/test/anthropic-answer-setup.test.mjs (8/8).

Not checked:
- Live Anthropic, Cloudflare or Console behaviour, including whether 529 can arrive before authentication, how the dashboard edits a secret, and how Cloudflare versions or rollbacks handle secrets.
- Real Get-Clipboard and Set-Clipboard on this machine. I deliberately left the user's clipboard alone.
- Windows clipboard history, PowerShell transcription and other logging policies.
- Whether the 8-minute bound plus rollback deploy fits inside the skill's 10-minute Bash timeout (not measured).
- The --json stdout mixing with cmdDeploy's info lines.
- Lifecycle-lock and migration-ledger changes, which belong to other areas.

### routing

I read the full diff a85f564..HEAD for worker/src/lib/core.js (callLLMImpl provider routing, the label-based missing-key block, Anthropic rate, empty/incomplete-reply and timeout handling), worker/src/lib/mcp-endpoint.js (readToolsFor, usesClaudeAnswerPair, initialize arms, runAsk, runSearch), components/brain-mcp.mjs (ANSWER_SETUP, THINK/SEARCH descriptions, INSTRUCTIONS, brain_think/brain_search output and absence notes, filteredEmptyNote), components/brain-mcp-runtime.mjs, worker/src/index.js (answerModelFor/gateModelFor, handleDocumentThink answer/synthesis/evidence-gate model calls, the anthropic_key_missing gap, answer_resumes_at, handleAnswerCheck, the handleDocuments key flag, rerank gating), worker/src/lib/answer-render.js, synthesis-answer.js, query-timing.js, wrangler.toml.template, operations/answer-setup.mjs and answer-setup-copy.mjs, operations/claude-workspace.mjs (model-aware owner rules), the owner-contract templates, the SKILL.md routing section, cmdConnectAnthropic and cmdDisconnectAnthropic, workerBindings and optionalWorkerSecretNames, and both test diffs (mcp-absence-honesty, mcp-search-contract).

Verified sound, no finding:
- Every callLLM site (rerank, answer-model-check, rag-think/repair, synthesis gate, evidence gate, OCR) routes by configured model. A Claude answer or check model with no key is refused before any Workers AI call or spend for all five answer/check labels.
- A Cloudflare model never reaches Anthropic, even with a key present. A Cloudflare model without the AI binding is refused.
- OCR stays @cf-only.
- Rerank needs an explicit ?rerank and a key, and the MCP never sends that parameter.
- Local answerSetupOf and the Worker's usesClaudeAnswerPair agree on every manifest shape: built-in, opus-sonnet, custom, mixed, missing gate_model.
- A missing or unreadable BRAIN_MANIFEST falls back to the conservative search-first route.
- The anthropic_key_missing gap and answer_error copy pass through both MCPs.
- Absence notes stay scoped and never claim nothing is recorded.
- The ledger path makes no LLM call, so the "ledger templates keep working at the daily limit" claim holds.

Tests run, all passing, checkout left clean: worker/test/provider-routing, test/mcp-absence-honesty (32/32), test/mcp-search-contract (17/17), worker/test/anthropic-answer-setup, worker/test/degraded-absence.

Probes in C:\offload\review-0419-scratch\area3\: probe-stale-route.mjs and probe-mcp-static.mjs, which confirm finding 1.

Not checked, or judged prompt wording rather than defects:
- Whether real assistants obey the guard text. It is guidance only, with no Worker-side enforcement.
- In Claude mode, a broad question goes to Opus through brain_think and is limited only by the Worker's evidence and synthesis gates, which do not forbid cross-record totals. This looks intentional.
- The guard's last sentence points to a "plain search-first answer above" that is gone from the Claude-mode contract. This is a wording nit.
- The answer-setup ceremony, acceptance and migration areas belong to other reviewers.
- The store owner's Windows built-in update is not affected by finding 1. It is only exposed to the remote-connector gap in finding 2, and only if the hosted connector is used.

### update-failsafes

I reviewed the release head at C:\offload\review-0419 (f8a7cd0) against a85f564 for Area 4. I wrote nothing inside the checkout. Probes are in C:\offload\review-0419-scratch\area4\.

Files and functions read:
- operations/migration-ledger.mjs (all)
- operations/brain-lifecycle-lock.mjs (all, plus the old version at a85f564)
- acceptance.mjs: answerResponseContractDiagnostic, answerUnavailableDiagnostic, record, tierRetrieval, run/summary/acceptanceVerdict
- operations/answer-setup.mjs: resolvedAnswerModels, answerSetupOf, the end of runAnthropicAnswerSetup
- operations/verified-recovery.mjs diff, the recovery contract binding, and the init path
- brain.mjs: loadMigrations, d1Query/cf/cfOnce error text, cmdMigrate (whole), cmdStatus, cmdUpgrade (whole), cmdTest, cmdUpdate/cmdUpdateWithPrompts (lock and preflight), dispatchUpdateCli, the top-level CLI catch and crash(), diagnoseChecksumDrift/repair-checksum/buildChecksumDriftCheck/cmdDoctor, cmdDisconnectAnthropic
- worker/src/index.js think path (model, factAnswer, observedAnswer, refusal status, response) and worker/src/lib/core.js callLLM (Anthropic and Workers AI receipts)
- the CHANGELOG, runbook and UPDATE-AUDIT diffs
- tests: fix-update-0419-ledger, brain-lifecycle-lock, acceptance-answer-model

What checks out on the schema-48 C1c to 56 path:
- Migrations 0001-0048 are byte-identical since the Kit C1 commit 7562257. `git diff 7562257 HEAD -- migrations/d1` only adds 0049-0056, and history shows no renames.
- The ledger name format matches the only INSERT (mig.name, without .sql). The schema_migrations columns are NOT NULL.
- The ledger is read and validated before bookmark capture and before the paused deploy.
- Only an error containing "no such table: schema_migrations" counts as an empty ledger. cfOnce embeds the D1 error text, so a real missing table matches. Any other throw, or a missing results array, is a ReadError and dies with "Nothing was changed".
- Checksum drift stops before the pause. The schema-48 plan prints "pending: 0049-0056 (8)".
- cmdMigrate re-validates the ledger after the pause, and that failure is reported with the paused-state message.

Lock:
- A dead owner, or a live PID with a different start time, is reaped only after a second read with the same token and mtime.
- An unknown identity fails safe as busy.
- An old-format bare-epoch process_instance is handled.
- On this Windows host, Node's computed start time and Get-Process StartTime differed by about 20 ms, against the 2 s tolerance.

Acceptance: a configured null answer FAILs, and so does a model mismatch.

Focused tests run: `node --test test/fix-update-0419-ledger.test.mjs test/brain-lifecycle-lock.test.mjs test/acceptance-answer-model.test.mjs` gave 25 passed, 0 failed. test/upgrade-verify.test.mjs could not run outside an npm script (npm_cli_unavailable_run_through_npm_script). That is a harness requirement, not a product defect.

Not checked, or not proven:
- No real Windows field timing. Whether the 2 s identity tolerance holds under heavy AV or slow Node startup is unproven, so I did not report it.
- Whether Anthropic echoes "claude-opus-5-5" verbatim in response.model. If it returns a dated snapshot, both connect and acceptance would fail, but I could not verify this offline.
- Abnormal states are not cross-checked: install_state present at schema 48 while schema_migrations is missing would be accepted as an empty ledger, because there is no check for recorded schema above the ledger maximum. I found no realistic path to that state.
- By design and pinned by a test, a built-in setup still PASSes "think degrades cleanly" even when answer_error shows the built-in model failed. The store owner's update runs built-in, so its acceptance will not catch a broken built-in answer path. It only gives a WARN.
- Verified-recovery plans made before 0.4.19 will refuse to resume, because gate_model now feeds the runtime fingerprint. That fails closed and is outside the update path.
- The full test chain was not run.

### owner-data

I read the release diffs for brain.mjs, worker/src/index.js, worker/src/lib/core.js, ocr.js, mcp-endpoint.js, answer-render.js, synthesis-answer.js, manifest.schema.json, templates/brain.manifest.json, wrangler.toml.template, operations/technician-setup.mjs, claude-workspace.mjs, brain-lifecycle-lock.mjs, verified-recovery.mjs, cloudflare-recovery-adapter.mjs, acceptance.mjs and test/daily-refresh-update-production.test.mjs. I read all of the new operations/answer-setup.mjs, answer-setup-copy.mjs and migration-ledger.mjs. I also read the code they depend on: cmdUpgrade stage order and failure handler, cmdDeployWithPrompts, persistWorkersDevDomain, optionalWorkerSecretNames, reconcileWorkerProviderSecrets, cmdSecrets, cmdMigrate, loadMigrations, writePinnedExecutionManifest, daily-refresh-plan hashing, the scheduler definition, status and reconcile, the daily runner's definition-hash checks and runSource, and the OCR idempotency and cap paths.

Checked and found sound for the owner's update (built-in @cf manifest at schema 48):
- An update does not change retrieval. The focused test test/daily-refresh-update-production.test.mjs passed 99/99.
- ANTHROPIC_API_KEY eligibility during the update's provider-secret reconciliation is unchanged for built-in manifests; it only adds gate_model.
- cmdSecrets no longer takes the key from the shell environment.
- The OCR switch to llmText returns the same text for the Workers AI reply shape, and a cap refusal still releases the idempotency receipt without marking the page unreadable.
- The new POST /api/admin/brain/answer-check route needs the "administer" capability and writes only llm_call_log rows.
- The migration ledger reader fails closed instead of treating a failed read as an empty ledger. Ledger names come from loadMigrations' file names. Git history shows no renamed or deleted migration files. Pending computation keeps the old meaning.
- I reviewed the secret delete and replace logic in the answer-setup rollback and found no owner-data loss.

Not checked:
- Live Cloudflare, Anthropic, Task Scheduler or real-Brain behavior.
- End-to-end runs of connect, disconnect or rollback. Finding 3 comes from reading the code.
- The full test chain.
- test/owner-contract-workspace.test.mjs ran 159 pass and 3 fail; all 3 failures are Windows symlink EPERM in this environment, not product defects.

Scratch probes and outputs are in C:\offload\review-0419-scratch\area5\ (identity-probe.mjs, stress.ps1, holder.mjs, contender.mjs, repro.ps1, repro-old.ps1, old-lock.mjs, deadlock-probe.mjs, brain.diff). The CPU-load probes started about 30 busy Node processes for about 12-14 s on this machine. Nothing in C:\offload\review-0419 was modified.

### completeness critic

I found no new P0 or P1 on the store owner's built-in, schema-48 update path beyond what the five areas already reported. The two items above are real but bounded, and both are in the optional Claude setup.

What I read, at release head f8a7cd0 against a85f564:
- The full brain.mjs diff (saved to C:\offload\review-0419-scratch\critic\brain.diff), plus the surrounding code: cmdUpgrade start through the failure handler, writePinnedExecutionManifest, loadManifest, loadMigrations and the ledger INSERT, parseFlags/VALUE_FLAGS, cmdDeployWithPrompts, reconcileWorkerProviderSecrets, resolveAdminKey, http and guardBrainAdminFetch, withManifestCloudflareControl, the setup preflight runAll caller, and MCP registration (BRAIN_MANIFEST is set).
- All of migration-ledger.mjs, answer-setup.mjs and answer-setup-copy.mjs, and the lifecycle-lock diff with its old version.
- The diffs for technician-setup.mjs (including the child env allowlist), claude-skill.mjs (the 72 KiB bound against the 68,743-byte SKILL.md), claude-workspace.mjs and the owner-contract templates, verified-recovery.mjs, cloudflare-recovery-adapter.mjs, the cloudflare-disposable-deployment provider, the v048 worker-version contract and transport, and the other disposable-recovery files.
- Worker: index.js, core.js, answer-render (worker and frontend), synthesis-answer.js, ocr.js, mcp-endpoint.js, query-timing.js and the /health handler.
- acceptance.mjs (both diagnostics), doctor.mjs, components/brain-mcp.mjs and its runtime, support-journal and support-recovery, scripts/run-test-chain.mjs, and package.json's files allowlist (all of operations/ ships).
- Docs: SKILL.md, the runbook, CHANGELOG, the 0.4.19 evidence plan, UPDATE-AUDIT, update-incidents, README and the developer docs.

Checked and sound for the owner:
- The new modules ship and form no import cycle.
- Deploy uploads worker/src directly, so no stale Worker bundle can ship.
- The 0.4.8 template's answer_model is @cf, and loadManifest does no schema validation, so the stricter schema does not break 0.4.8 manifests.
- The lock owner's created_at field predates this diff, and 0.4.8 has no lifecycle lock.
- The repo history has no renamed or deleted migration files. Candidate branches did renumber 0049 and 0051 to 0050 and 0053, which matters only for brains that ran those candidates, not for a schema-48 brain.
- The technician child gets SYSTEMROOT from the case-insensitive process.env, so clipboard reads work through the technician path.
- resolveAdminKey is synchronous and http returns a native Response.
- The Anthropic requests send anthropic-version 2023-06-01 and no temperature. Per the claude-api reference, the 2026-10-21 rule that rejects sampling parameters with a 400 applies only to that newer version.

Focused tests run, read-only, with git status clean afterwards:
- `node --test test/answer-model-config.test.mjs test/answer-setup-copy.test.mjs test/current-version.test.mjs worker/test/query-timing.test.mjs`: 33 of 33 pass.
- `node --test test/technician-setup.test.mjs test/verified-recovery.test.mjs test/doctor.test.mjs`: 38 of 38 pass.
- Probes: C:\offload\review-0419-scratch\critic\probe-cap.mjs and probe-halfrun.mjs.

Not checked, which the operator should handle before the session:
- The repo history starts 2026-09-06, so I cannot prove that the owner's rows 0001-0046 carry today's file names. The new ledger name check would stop the update before the pause if they do not. A read-only `brain status <manifest>` with the 0.4.19 CLI on the owner's Brain before the session runs the full ledger validation without changing anything.
- The evidence plan says partner apps that pin the connector need a reviewed helper update before adopting 0.4.19. Confirm whether the store owner uses such an app.
- I did not measure live Anthropic behavior. The claude-api reference says Opus 5.5 thinking cannot be turned off (default effort medium), Sonnet 5.5 thinks by default at effort high, and thinking counts against max_tokens. That puts the 4000 and 8000 token caps on the answer, evidence gate and synthesis gate at the same risk Area 1 found for the 128-token check, but this is unmeasured.
- I ran no full chain and touched no live Cloudflare, Anthropic or Windows Task Scheduler.

## Limits

Offline review only. No live Anthropic, Cloudflare or Windows owner-machine behavior was exercised. No code in the release was changed; this branch adds only this report. Line numbers refer to f8a7cd05.

LANE REVIEW-0419-PARTNER: READY (review complete; 20 confirmed: 1 P1, 8 P2, 11 P3; 1 at P0/P1)
