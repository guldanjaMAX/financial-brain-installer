import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// These are call/await/throw interfaces, including the callees used by Gmail.
// Exact, unique source matches make a moved or newly split site a review event.
// The hook changes modules in memory only and never ships with the product.
export const points = [];
const add = (file, section, needle, identity, branch = "normal") => {
  const id = `${file}:${points.filter(point => point.file === file).length + 1}`;
  points.push({ id, file, section, needle, identity, branch });
};
const brain = (section, needle, identity = "id", branch) => add("brain.mjs", section, needle, identity, branch);
for (const needle of [
  "let policy = policyById.get(id);",
  "policy = await gmailRead(opts => gmail.messagePolicy",
  "const resumedVersion = await resumableStoredRevision(id);",
  "return { id, policyResult: policy, fetched: await gmailRead(opts => gmail.toEnvelope",
]) brain("const readGmailEntry =", needle);
for (const [needle, branch] of [
  ["gmailActiveUids.add(key);", "normal"],
  ["recordAcceptedDocumentState(state, {", "resumed"],
  ["gmailRemovalCauses[key] = r.removal_cause;", "skip"],
  ["holdGmailItem(id, r.skip.reason);", "retained"],
  ["checkpointResolvedGmail(key, r.policy_skip", "skip"],
  ["const scannerResumeAccepted = hasCredentialScannerProgress(", "normal"],
  ["recordAcceptedDocumentState(state, {", "unchanged"],
  ["const envelope = sanitizeIngestEnvelope(r.envelope);", "normal"],
  ["const refusal = credentialRefusalOf(envelope, scannerOn);", "normal"],
  ["const envelopes = splitOversized(envelope);", "normal"],
]) {
  // The two acceptance branches have deliberately identical first statements.
  const section = branch === "unchanged" ? "if (!gmailRetriesAtStart.has(id) && storedFamilyConfirmed &&" : "const prepareGmail =";
  brain(section, needle, "id", branch);
}
for (const needle of [
  "const part = await sendPreparedBatches({",
  "const outcome = remoteFamilyOutcomes(",
  "const settlement = remoteFamilySettlement(",
  "removalReview.remember(which === \"gmail\"",
  "await acknowledgeStoredOcrPages({",
  "recordAcceptedDocumentState(state, plan);",
  "if (which === \"gmail\") clearGmailRetry(state, plan.stateKey, sourceName);",
  "checkpointGmailBatch(state, outcome.completed.map",
  "if (outcome.completed.length || outcome.incomplete.length) saveState(statePath, state);",
]) brain("const consumeGroup =", needle, "group[0]?.stateKey");
brain("const consumeGroup =", "recordCredentialScannerProgress(state, scannerFingerprint, plan.stateKey, plan.hash);", "group[0]?.stateKey", "scanner");
brain("const consumeGroup =", "await paceSleep(delayMilliseconds);", "group[0]?.stateKey", "paced");
brain("const consumeGroup =", "recordGmailRetry(state, plan, sourceName);", "group[0]?.stateKey", "worker-failed");
brain("processEntry: async (id, item) =>", "await consumeGroup(group);", "id");
// The shared sender's I/O errors preserve their account/transport semantics.
// Ordinary processing exceptions at the same call interfaces remain local.
brain("async function sendBatches({", "const { saveState: persistState } = await ingestLib();", "groups[0]?.[0]?.stateKey");
brain("async function sendBatches({", "const docs = group.map((g) => g.envelope);", "group[0].stateKey");
brain("async function sendBatches({", "? await retryIngestFinalization({", "group[0].stateKey");
brain("async function sendBatches({", "results = validateBatchReceipt(body, group);", "group[0].stateKey");
brain("async function sendBatches({", "if (onResult) onResult(item, r);", "group[0].stateKey");
brain("async function sendBatches({", "saveState(statePath, state);\n    if (!quiet)", "group[0].stateKey");
for (const needle of [
  "response = await send(pending);",
  "const results = validate(JSON.parse(raw), pending);",
  "await sleep(2000 * (2 ** (attempt - 1)));",
]) add("operations/ingest-finalization-retry.mjs", "export async function retryIngestFinalization", needle, "docs[0].source_id", needle.startsWith("await sleep") ? "retry" : "normal");
for (const needle of [
  "r = await prepareOne(f);",
  "const envelopes = r.envelopes",
  "const n = envelopeBytes(envelope);",
  "const stmts = estimatedStatements(envelope);",
]) add("ingest/run.mjs", "export async function* batchStream", needle, "f.id");
for (const [section, needle] of [
  ["export async function messagePolicy", "msg = await api(getAccessToken,"],
  ["export async function messagePolicy", "const decision = gmailLabelDecision("],
  ["export async function toEnvelope", "msg = await api(getAccessToken,"],
  ["export async function toEnvelope", "const observedDecision = gmailLabelDecision("],
  ["export async function toEnvelope", "const got = await extract(fromB64Url(msg.raw), \"message.eml\");"],
  ["export async function toEnvelope", "const q = textQuality(got.text);"],
  ["export async function toEnvelope", "const ts = msg.internalDate ? Number(msg.internalDate) : null;"],
  ["export async function toEnvelope", "envelope: withFirstPartySourceProvenance({"],
]) add("connectors/gmail.mjs", section, needle, "id", "native");
add("operations/gmail-batch-window.mjs", "export function checkpointGmailBatch", "const timestamp = now();", "stateKeys[0]");

for (const [needle, branch] of [
  ['throw new Error("the response has no per-document results array");', "receipt-array"],
  ['if (!sourceId) throw new Error("a sent document has no source_id");', "request-id"],
  ['if (expected.has(sourceId)) throw new Error(`the request contains duplicate source_id ${sourceId}`);', "request-duplicate"],
  ['if (!expected.has(sourceId)) throw new Error(`the response acknowledged an unknown source_id ${sourceId || "(empty)"}`);', "receipt-unknown"],
  ['if (received.has(sourceId)) throw new Error(`the response acknowledged source_id ${sourceId} more than once`);', "receipt-duplicate"],
  ['throw new Error(`the response used an unknown status for source_id ${sourceId}`);', "receipt-status"],
  ['throw new Error(`${missing.length} sent document(s) were not acknowledged, including ${missing[0]}`);', "receipt-missing"],
]) brain("export function validateBatchReceipt", needle, 'group[0]?.stateKey || group[0]?.envelope?.source_id', branch);

add("operations/gmail-entry.mjs", "export async function processGmailEntries", "value: await read(id)", "id");
add("operations/gmail-entry.mjs", "export async function processGmailEntries", "await processEntry(entry.id, entry.value);", "entry.id");
add("ingest/extract.mjs", "export async function extract", "const out = await entry.fn(buf, { name, ...opts });", "globalThis.__gmailEntryIdentity", "native");
add("ingest/formats.mjs", "export async function parseEmailMessage", "const mail = await new PostalMime({ maxHeadersSize: 256 * 1024 }).parse(buf);", "globalThis.__gmailEntryIdentity", "native");
add("ingest/formats.mjs", 'register(".eml", async (buf) =>', "const parsed = await parseEmailMessage(buf);", "globalThis.__gmailEntryIdentity", "native");
brain("export async function requestIngestBatch", "return await retryTransient(async () => {", "docs[0].source_id");
brain("export async function requestIngestBatch", "const res = await http(url, {", "docs[0].source_id");
brain("export async function requestIngestBatch", "raw = await res.text();", "docs[0].source_id");
points.at(-1).scope = "transport";
brain("async function http(url, opts = {},", "return await guardBrainAdminFetch(fetchImpl, url, {", 'JSON.parse(opts.body || "{}").docs?.[0]?.source_id');
points.at(-1).scope = "transport";

add("operations/gmail-entry.mjs", "export function gmailDeadlineSleep", "await pause(Math.min(ms, remaining));", "globalThis.__gmailEntryIdentity", "bounded-retry");

brain("const gmailRead = async task =>", "try { return await task({", "globalThis.__gmailEntryIdentity");
add("operations/gmail-entry.mjs", "export async function processGmailEntries", "await hold(entry.id, error);", "entry.id", "held-failure");
points.at(-1).scope = "persistence";
add("operations/gmail-entry.mjs", "export async function processGmailEntries", "await onDeadline(entry.id);", "entry.id", "deadline-after-sleep");
points.at(-1).scope = "persistence";
add("operations/gmail-entry.mjs", "export async function processGmailEntries", "if (entry.error) throw entry.error;", "entry.id", "held-failure");
add("operations/gmail-entry.mjs", "export async function processGmailEntries", "if (!isItemFailure(error)) throw error;", "entry.id", "auth-failure");
points.at(-1).scope = "auth";
for (const [needle, branch] of [
  ["if (remaining <= 0) throw gmailDeadlineError();", "deadline-before-sleep"],
  ["if (now() >= deadlineAt) throw gmailDeadlineError();", "deadline-after-sleep"],
]) {
  add("operations/gmail-entry.mjs", "export function gmailDeadlineSleep", needle, "globalThis.__gmailEntryIdentity", branch);
  points.at(-1).scope = "deadline";
}
brain("export async function requestIngestBatch", "if (timeoutMs <= 0) throw gmailDeadlineError();", "docs[0].source_id", "send-expired");
points.at(-1).scope = "deadline";

brain("const prepareGmail =", "const gmailParts = planGmailParts(state,", "id");
brain("const consumeGroup =", "if (acceptGmailPart(state,", "item.stateKey");
brain("const consumeGroup =", "saveState(statePath, state);\n        }\n      },", "item.stateKey");
points.at(-1).scope = "persistence";
add("operations/ingest-finalization-retry.mjs", "export async function retryIngestFinalization",
  "await onAccepted?.(", "pending[0].source_id");

let selected = null;
export function arm(point, kind = "item") {
  globalThis.__gmailEntryIdentity = null;
  selected = { point, kind, reached: 0 };
  return selected;
}
export function disarm() { selected = null; globalThis.__gmailEntryIdentity = null; }
const inject = (id, identity) => {
  if (!selected || selected.point.id !== id || (!/(?:^|:)fault-entry(?:#|$)/.test(String(identity)) && !["request-id", "request-duplicate", "receipt-unknown"].includes(selected.point.branch))) return;
  if (selected.reached++) return;
  const error = new Error("synthetic per-entry failure");
  if (selected.kind === "auth") Object.assign(error, { name: "DriveError", status: 401, providerStatus: 401, needsReauth: true });
  if (selected.kind === "transport") Object.assign(error, { transport: "connection", code: "ECONNRESET" });
  if (selected.point.scope === "persistence") error.ingestStateWriteFailed = true;
  if (selected.point.scope === "auth") error.needsReauth = true;
  if (selected.point.scope === "deadline") Object.assign(error, { name: "TimeoutError", reason: "requestDeadline" });
  throw error;
};
globalThis.__gmailEntryFault = inject;

export function install() {
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const matching = points.filter(point => url.endsWith(`/${point.file}`));
    if (!matching.length) return result;
    let source = String(result.source);
    // Expression sites need an expression-safe comma; all others are statements.
    for (const point of matching) {
      let start = source.indexOf(point.section);
      assert.ok(start >= 0, `missing section ${point.id}`);
      let at = source.indexOf(point.needle, start);
      assert.ok(at >= start, `missing point ${point.id}`);
      // The first duplicate acceptance call belongs to resumed; the second to unchanged.
      const call = `globalThis.__gmailEntryFault(${JSON.stringify(point.id)}, ${point.identity})`;
      if (point.needle === "value: await read(id)") {
        source = source.slice(0, at) + source.slice(at).replace(point.needle, `value: await (${call}, read)(id)`);
      } else if (point.needle.startsWith("if (") && point.needle.includes(" throw ")) {
        const split = point.needle.indexOf(" throw ");
        const condition = point.needle.slice(0, split);
        const throwing = point.needle.slice(split + 1);
        source = source.slice(0, at) + source.slice(at).replace(point.needle, `${condition} { ${call}; ${throwing} }`);
      } else if (point.needle.startsWith("? await")) {
        source = source.slice(0, at) + source.slice(at).replace("? await retryIngestFinalization({", `? await (${call}, retryIngestFinalization)({`);
      } else if (point.needle.startsWith("envelope:")) {
        source = source.slice(0, at) + source.slice(at).replace("envelope: withFirstPartySourceProvenance({", `envelope: (${call}, withFirstPartySourceProvenance)({`);
      } else if (point.needle === "response = await send(pending);") {
        source = source.slice(0, at) + source.slice(at).replace(point.needle, `response = await (${call}, send)(pending);`);
      } else {
        source = source.slice(0, at) + `${call};\n` + source.slice(at);
      }
    }
    return { ...result, source };
  } });
}
