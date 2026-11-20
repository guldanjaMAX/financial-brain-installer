// "Clean my Brain" support codes. Every way this feature can stop has one stable
// code, the database's or provider's own (masked) message, and one line on the
// help page (docs/help/clean-my-brain.md, https://financialbrain.ai/help/<code>).
// A test fails the build if a code here has no help line or a help line has no code.

export const HELP_BASE = "https://financialbrain.ai/help";

/** code -> { summary: what happened, fix: what to do next, help: the help-page line } */
export const CLEAN_CODES = Object.freeze({
  CLEAN_LIST_INVALID: {
    summary: "The list of ids has a bad line, or it changed after it was reviewed.",
    fix: "Rebuild the list from the review sheet; it needs a matching .meta.json next to it.",
    help: "The id list has a bad line or changed after review; rebuild it from the review.",
  },
  CLEAN_USAGE: {
    summary: "The command is missing something or has an option it does not know.",
    fix: "Run it as shown in the usage lines above.",
    help: "The command is missing a value or has an unknown option; use the usage lines it prints.",
  },
  CLEAN_STAGE_TOO_LARGE: {
    summary: "This stage would remove more than 20% of the Brain.",
    fix: "Split the list into smaller stages and run them one at a time.",
    help: "Over 20% of the Brain in one stage; split it.",
  },
  CLEAN_BRAIN_SIZE_UNKNOWN: {
    summary: "The Brain did not report how many documents it holds, so the 20% check cannot run.",
    fix: "Run brain update (it adds the size check) or brain health, then try again. Nothing was removed.",
    help: "The Brain did not report its size, so the 20% check could not run; nothing was removed.",
  },
  CLEAN_WORKER_TOO_OLD: {
    summary: "This Brain cannot remember removals yet.",
    fix: "Run brain update first, then run brain clean again. Nothing was removed.",
    help: "Update the Brain first; it cannot remember removals yet.",
  },
  CLEAN_RESTORE_POINT_FAILED: {
    summary: "Cloudflare did not give a restore point, so nothing was removed.",
    fix: "Check the Cloudflare message below, fix it, and run the same command again.",
    help: "Cloudflare gave no restore point (its message is shown); nothing was removed.",
  },
  CLEAN_HEALTH_NOT_OK: {
    summary: "The Brain was busy or not healthy.",
    fix: "Wait a few minutes and run the same command; it resumes where it stopped.",
    help: "The Brain was busy or unhealthy; wait and rerun, it resumes.",
  },
  CLEAN_D1_BUSY: {
    summary: "The database was busy and did not finish a batch.",
    fix: "Run the same command later; it resumes. The database's own message is shown below.",
    help: "Database busy (the database message is shown); rerun later, it resumes.",
  },
  CLEAN_PLAN_CHANGED: {
    summary: "The complete removal plan is missing, changed or no longer matches the Brain.",
    fix: "Run --preview-all and review the plan. If a stage already started, review the remaining items in a new list.",
    help: "The complete plan is missing, changed or stale; review an exact plan for the remaining items.",
  },
  CLEAN_BATCH_UNVERIFIED: {
    summary: "A batch could not be proved either way.",
    fix: "Run the same command: it reads back exactly which ids are gone before doing anything else.",
    help: "A batch could not be proved; stop; the read-back shows exactly which ids are gone.",
  },
  CLEAN_LATE_RECEIPT: {
    summary: "A batch was removed but its receipt was lost; the read-back proved it, so the run continued.",
    fix: "Nothing to do. This is shown so the lost receipt is never a mystery.",
    help: "A batch committed but its receipt was lost; the read-back proved it and the run continued.",
  },
  CLEAN_COUNT_MISMATCH: {
    summary: "The Brain's document count did not drop by exactly the number removed.",
    fix: "New mail may have arrived during the run. Run brain clean again with the same list to re-check; nothing was lost.",
    help: "Counts disagree (new mail can cause this); rerun to re-check, nothing was lost.",
  },
  CLEAN_COUNTERS_DRIFTED: {
    summary: "The Brain's stored counts disagreed with the documents; they were repaired.",
    fix: "Nothing to do. The check read the real rows and corrected the totals.",
    help: "Stored counts disagreed with the documents and were repaired; nothing was lost.",
  },
  CLEAN_SOURCE_UNSUPPORTED: {
    summary: "Clean my Brain removes Gmail and Drive items only.",
    fix: "Take the other sources out of the list. Nothing was removed.",
    help: "Only gmail: and drive: items can be cleaned; remove other sources from the list.",
  },
  CLEAN_MANY_MISSING: {
    summary: "Many ids on the list are not in the Brain, so nothing more was remembered.",
    fix: "Open the already-gone list it names. If the ids are wrong, fix the list. If you removed them earlier on purpose, run the same command with --allow-missing.",
    help: "Over 20% of the ids are not in the Brain (a typo or the wrong account?); check the list or add --allow-missing.",
  },
  CLEAN_SETUP_FAILED: {
    summary: "This computer could not load the Brain's settings or address.",
    fix: "Check the manifest path and run brain doctor. The system's own message is shown below. Nothing was removed.",
    help: "The Brain's settings or address could not be loaded (its message is shown); nothing was removed.",
  },
  CLEAN_PROGRESS_NOT_SAVED: {
    summary: "The progress file could not be written next to the list.",
    fix: "Make that folder writable (on Windows, close anything holding the file), then run the same command; it checks what is already gone first.",
    help: "The progress or already-gone file could not be written (its message is shown); fix the folder and rerun.",
  },
  CLEAN_NOT_ON_THIS_BRAIN: {
    summary: "The owner key or exact Brain identity could not be verified.",
    fix: "Check the manifest, Cloudflare route and database, and use the plan and progress for this Brain.",
    help: "The owner key or exact Brain identity could not be verified; check the manifest and saved plan.",
  },
  OWNER_REMOVED: {
    summary: "You removed this item with Clean my Brain, so it was not loaded again.",
    fix: "To bring it back: brain clean <manifest> --restore <ids-file> --apply, then run ingest again.",
    help: "You removed this item; brain clean --restore brings it back.",
  },
});

export class CleanError extends Error {
  constructor(code, { providerMessage = null, detail = null, committed = null, cause } = {}) {
    super(CLEAN_CODES[code]?.summary || code, cause ? { cause } : undefined);
    this.name = "CleanError";
    this.code = code;
    this.providerMessage = providerMessage ? maskProviderMessage(providerMessage) : null;
    this.detail = detail;
    this.committed = committed;
  }
}

/** The provider's own first line with anything that could identify a person or key removed. */
export function maskProviderMessage(text) {
  return String(text ?? "").split(/\r?\n/)[0]
    .replace(/(["'`]).*?\1/g, "...")
    .replace(/\bBearer\s+\S+/gi, "Bearer ...")
    .replace(/\S+@\S+/g, "...")
    .replace(/\b(?:sk|pk|rk|key|tok)[-_][A-Za-z0-9_-]{8,}/gi, "...")
    .replace(/[0-9a-f]{12,}/gi, "#")
    .replace(/\d{6,}/g, "#")
    .slice(0, 200);
}

/** Lines for a terminal: code, what happened, the provider's words, the next step, the help link. */
export function formatCleanError(error) {
  const info = CLEAN_CODES[error?.code];
  if (!info) return [`Clean my Brain stopped: ${maskProviderMessage(error?.message || "unexpected error")}`];
  return [
    `${error.code}: ${info.summary}`,
    ...(error.providerMessage ? [`  The system said: ${error.providerMessage}`] : []),
    ...(error.detail ? [`  ${error.detail}`] : []),
    `  Next: ${info.fix}`,
    `  More: ${HELP_BASE}/${error.code}`,
  ];
}
