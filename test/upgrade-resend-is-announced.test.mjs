import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialScannerFingerprint } from "../brain.mjs";

/* UPDATE-042.
 *
 * A state file written by 0.3.x carries no credential_scanner_fingerprint,
 * because credentialScannerFingerprint did not exist then. The ingest path
 * compares `state.credential_scanner_fingerprint !== scannerFingerprint`, so on
 * that state the answer is `undefined !== <hash>`, always true, and every
 * "unchanged, skip it" branch is disabled. Every document is re-sent.
 *
 * That re-check is correct. Doing it without telling the owner is not. A client
 * found it on 2026-09-09 only because her agent ran a dry run first: 11,217
 * documents to send, 0 unchanged, against a 164,000 chunk backlog, with a
 * watched folder that would have acted on it unattended.
 *
 * Read as source rather than executed because the warning sits inside a long
 * command that needs a live worker; what must not regress is that the branch
 * exists, is reached on a fingerprint-less state, and says the two things an
 * owner has to act on: everything is re-sent, and pause an unattended schedule.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// CRLF-normalised. A multi-line anchor silently fails to match a Windows
// checkout, which is how a regression here passed on Windows once already.
const src = readFileSync(resolve(ROOT, "brain.mjs"), "utf8").replace(/\r\n/g, "\n");
const fail = [];
const check = (name, cond) => { if (cond) console.log(`PASS  ${name}`); else { fail.push(name); console.log(`FAIL  ${name}`); } };

// 1. The absent fingerprint really does read as changed. This is the premise;
//    if it ever stops being true the whole incident is moot and this test says so.
const fp = credentialScannerFingerprint(true);
check("a state file with no fingerprint compares as changed",
  undefined !== fp && String(fp).length === 64);

// 2. The guard exists, on the same condition the skip branches use, and is
//    scoped to sources that actually have prior documents.
const guard = src.indexOf("if (scannerPolicyChanged && previouslyKnownKeys.size && !flags.reset) {");
check("the announcement is guarded on scannerPolicyChanged with prior documents", guard !== -1);

// 3. It is a warning, not an info line. This is the difference between an owner
//    seeing it and an owner scrolling past it.
const body = guard === -1 ? "" : src.slice(guard, guard + 1200);
check("it is raised as a warning", /^\s*warn\(/m.test(body));

// 4. It states the count, so the owner can compare it against what the run then does.
check("it names how many documents will be re-sent",
  body.includes("previouslyKnownKeys.size"));

// 5. It names the unattended case, which is the one that causes harm.
check("it tells the owner to pause an unattended schedule or watched folder",
  /watched folder/i.test(body) && /pause/i.test(body));

// 6. It must not fire on a reset, which already re-sends everything by request.
check("a deliberate --reset does not get the warning", body.length > 0 && src.slice(guard, guard + 90).includes("!flags.reset"));

// 7. The premise it protects: the skip branches really are disabled by this flag.
//    Without this, the warning could survive while the behaviour it describes
//    quietly changed, and it would then be telling owners something false.
check("the unchanged fast path is still gated on the same flag",
  src.includes("if (!scannerPolicyChanged && r.hash && state.done[key] === r.hash)"));

if (fail.length) { console.error(`\n${fail.length} FAILURES`); process.exit(1); }
console.log("\nupgrade re-send announcement: all checks passed");
