import { registerHooks } from "node:module";

// Each mutation changes one guard in memory, leaving reviewed source intact.
export const mutations = {
  cpu_classification: ["retry", "transientD1Failure(JSON.parse(raw)?.error)", "false"],
  http_status: ["retry", "if (res.status !== 400) return false;", "if (false) return false;"],
  member_status: ["retry", 'result.status === "failed" && (', "true && ("],
  finalization: ["retry", 'result.error === "ingest finalization failed; retry this document"', "false"],
  revision: ["retry", 'result.error === "ingest revision could not be verified; retry this document"', "false"],
  budget: ["retry", "const attempts = 5;", "const attempts = 1;"],
  lease: ["retry", "assertOwned?.();", "void 0;"],
  terminal_transport: ["retry", "if (error?.retryable !== true) throw error;", "if (false) throw error;"],
  receipt: ["retry", "const results = validate(JSON.parse(raw), pending);", "const results = JSON.parse(raw).results;"],
  accepted_subset: ["retry", "pending = pending.filter((doc) => retryIds.has(String(doc.source_id)));", "pending = pending;"],
  backoff: ["retry", "await sleep(2000 * (2 ** (attempt - 1)));", "await sleep(0);"],
  exhausted_failure: ["retry", 'source_id: doc.source_id, status: "failed",', 'source_id: doc.source_id, status: "unchanged",'],
  run_budget_guard: ["retry", "if (retryBudget.remaining <= 0) break;", "if (false) break;"],
  run_budget_spend: ["retry", "retryBudget.remaining--;", "void 0;"],
  run_budget_size: ["retry", "() => ({ remaining: 4 });", "() => ({ remaining: 0 });"],
  run_budget_scope: ["brain", "retryBudget: finalizationRetryBudget,", "retryBudget: createIngestFinalizationRetryBudget(),"],
  run_budget_forward: ["brain", "sleep: retrySleep, retryBudget,", "sleep: retrySleep,"],
  load_complete_flag: ["brain", "result.complete === false || heldForRetry > 0", "false || heldForRetry > 0"],
  load_held_count: ["brain", "result.complete === false || heldForRetry > 0", "result.complete === false || false"],
  load_partial: ["brain", "partial: !!(refused || excluded || incomplete),", "partial: !!(refused || excluded),"],
  load_refresh: ["brain", "refreshSucceeded: !incomplete,", "refreshSucceeded: true,"],
  load_outcome: ["brain", 'outcomeOf(refused || excluded || incomplete ? "partial" : "completed")', 'outcomeOf(refused || excluded ? "partial" : "completed")'],
  load_held_summary: ["brain", "if (heldForRetry) extra.push(", "if (false) extra.push("],
  cursor: ["brain", "Number(tally?.failed || 0) === Number(durableRetryFailures || 0) &&", "Number(tally?.failed || 0) === 0 &&"],
  durable_identity: ["brain", "state.gmail_retry[plan.stateKey] = true;", "void 0;"],
  durable_before_cursor: ["brain", "if (outcome.completed.length || outcome.incomplete.length) saveState(statePath, state);\n    if (paceReceiptError)", "if (outcome.completed.length && !outcome.incomplete.length) saveState(statePath, state);\n    if (paceReceiptError)"],
  retry_clear: ["brain", "if (which === \"gmail\") clearGmailRetry(state, plan.stateKey, sourceName);", "void 0;"],
  held_count: ["brain", "gmailPreviouslyHeldFailures += failedParts;", "gmailPreviouslyHeldFailures += 0;"],
  split_count: ["brain", "(rejectedFamilyParts.get(plan.stateKey) || statuses)", "statuses"],
  held_exit: ["brain", "failed: tally.failed - gmailPreviouslyHeldFailures,", "failed: tally.failed,"],
  held_receipt: ["brain", 'const finalStatus = hasRemoteGap ? "error" : "ready";', 'const finalStatus = "ready";'],
  held_summary: ["brain", "if (gmailRetryBacklog) info(", "if (false) info("],
  completion: ["brain", "complete: !hasRemoteGap", "complete: true"],
  retry_first: ["brain", "[...new Set([...retryIds, ...h.ids])]", "[...new Set([...h.ids, ...retryIds])]"],
  sweep_retry: ["brain", "if (authoritativeSnapshot && gmailRetriesAtStart.size > 0)", "if (false)"],
  sweep_dedup: ["brain", "if (!gmailRetriesAtStart.has(id)) yield id;", "yield id;"],
  sweep_policy: ["brain", "policyById.set(id, policy);", "void 0;"],
  sweep_resume: ["brain", "if (gmailRetriesAtStart.has(id)) return null;", "void 0;"],
  incremental_resume: ["brain", "if (!gmailRetriesAtStart.has(id) && storedFamilyConfirmed &&", "if (storedFamilyConfirmed &&"],
  coverage: ["brain", "gmailCredentialRefusalSkips - (which === \"gmail\" ? gmailDurableRetryFailures : 0)", "gmailCredentialRefusalSkips"],
};

const chosen = process.env.BRAIN_GMAIL_FINALIZATION_MUTANT;
if (chosen) {
  if (!Object.hasOwn(mutations, chosen)) throw new Error("Unknown finalization mutation");
  const [kind, target, replacement] = mutations[chosen];
  const suffix = kind === "brain" ? "/brain.mjs" : "/operations/ingest-finalization-retry.mjs";
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith(suffix)) return result;
    const source = String(result.source);
    if (source.split(target).length !== 2) throw new Error("Finalization mutation target missing or ambiguous");
    process.stderr.write(`MUTATION_APPLIED ${chosen}\n`);
    return { ...result, source: source.replace(target, replacement) };
  } });
}
