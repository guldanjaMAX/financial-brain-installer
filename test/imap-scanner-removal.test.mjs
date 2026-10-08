/**
 * IMAP scanner migration and cleanup, exercised through the complete CLI.
 *
 * This uses the scripted RFC 3501 server for mailbox reads and a preload
 * fixture for the authenticated Brain routes. All identities are invented.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { credentialScannerFingerprint, resolveAdminKey } from "../brain.mjs";
import { BULK_POLICY, imapPolicyFingerprint } from "../connectors/imap.mjs";
import { Folder, ScriptedImapServer } from "./fixtures/imap-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "brain.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "imap-scanner-removal-fetch.mjs")).href;
const SOURCE = "mailbox";
const UIDVALIDITY = 7101;
const SYNTHETIC_KEY = `sk-proj-${"A7".repeat(16)}`;
const strip = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`);
  console.log(`PASS  ${name}`);
};

const message = ({ messageId, subject, body }) =>
  `Message-ID: <${messageId}>\r\n` +
  "From: Synthetic Sender <sender@example.invalid>\r\n" +
  "To: Synthetic Owner <owner@example.invalid>\r\n" +
  `Subject: ${subject}\r\n` +
  "Date: Mon, 31 Aug 2026 09:00:00 -0700\r\n" +
  "MIME-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
  body;
const versionOf = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
const stateKeyOf = (messageId) => `${SOURCE}:mid:${messageId.toLowerCase()}`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

async function runCli({ manifestPath, evidencePath, statePath, userRoot, port, run, approval = null, apply = null }) {
  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    NO_COLOR: "1",
    HOME: userRoot,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_IMAP_CREDENTIAL_STORE: "file",
    BRAIN_IMAP_SCANNER_EVIDENCE_PATH: evidencePath,
    BRAIN_IMAP_SCANNER_USER_ROOT: userRoot,
    BRAIN_IMAP_SCANNER_STATE_PATH: statePath,
    BRAIN_IMAP_SCANNER_PORT: String(port),
    BRAIN_IMAP_SCANNER_RUN: String(run),
  });
  const args = ["--import", FIXTURE, CLI, "ingest", manifestPath, "--from", "imap", "--source", SOURCE];
  if (approval) args.push("--approve-removals", approval);
  if (apply) args.push("--apply-removals", apply);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 86) reject(new Error("the IMAP fixture reached a forbidden host process"));
      else resolve({ code, signal, output: strip(output) });
    });
  });
}

// The real credential reader rejects linked parent directories, including the
// system temporary-directory alias on macOS. Exercise a physical fixture path.
const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-imap-scanner-removal-")));
const manifestPath = join(directory, "fixture.manifest.json");
const statePath = join(directory, `.brain-ingest-${SOURCE}.json`);
const evidencePath = join(directory, "evidence.json");
const userRoot = join(directory, "isolated-user-root");
const credentialRoot = join(userRoot, ".brain");
const server = new ScriptedImapServer({
  username: "owner@example.invalid",
  password: "synthetic-app-password",
  folders: [new Folder("INBOX", { uidvalidity: UIDVALIDITY })],
});

try {
  const inbox = server.folder("INBOX");
  const sensitive = [];
  for (let index = 1; index <= 101; index++) {
    const suffix = String(index).padStart(3, "0");
    const messageId = `scanner-sensitive-${suffix}@example.invalid`;
    const raw = message({
      messageId,
      subject: `Synthetic scanner refusal ${suffix}`,
      body:
        `This invented mailbox message contains a synthetic credential-shaped test value ${SYNTHETIC_KEY}. ` +
        "It exists only to verify that a scanner migration cannot delete a surprising set without review.",
    });
    inbox.add(raw, { internaldate: "31-Aug-2026 16:00:00 +0000" });
    sensitive.push({ key: stateKeyOf(messageId), version: versionOf(raw) });
  }
  const replayId = "scanner-replay@example.invalid";
  const replayRaw = message({
    messageId: replayId,
    subject: "Synthetic D1 replay",
    body:
      "This invented ordinary message was recorded in local scanner progress, but its family is absent from D1. " +
      "The migration must post it again instead of trusting the local unchanged marker.",
  });
  inbox.add(replayRaw, { internaldate: "31-Aug-2026 16:01:00 +0000" });
  const replayKey = stateKeyOf(replayId);
  const replayVersion = versionOf(replayRaw);

  const adminKey = randomBytes(32).toString("hex");
  writeFileSync(join(directory, ".brain-admin-key"), adminKey, { mode: 0o600 });
  mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }), { mode: 0o600 });
  // A credential-fixture refusal must not masquerade as a missing IMAP SEARCH.
  // Compare only a boolean so a failed assertion can never print key bytes.
  check("the isolated file credential passes the real reader before IMAP begins",
    resolveAdminKey(manifestPath, { ignoreEnvironment: true }) === adminKey);
  await server.listen();
  writeFileSync(join(credentialRoot, "imap-credentials.json"), JSON.stringify({
    imap: {
      host: "mail.example.invalid",
      port: server.port,
      username: server.username,
      password: server.password,
    },
  }), { mode: 0o600 });

  const scannerV4 = credentialScannerFingerprint(true, 4);
  const scannerV5 = credentialScannerFingerprint(true, 5);
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: Object.fromEntries([...sensitive.map((item) => [item.key, item.version]), [replayKey, replayVersion]]),
    skipped: {},
    imap_folders: { INBOX: { uidvalidity: UIDVALIDITY, last_uid: 101 } },
    imap_policy_fingerprint: imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles),
    credential_scanner_fingerprint: scannerV4,
    credential_scanner_progress: {
      fingerprint: scannerV5,
      accepted: { [replayKey]: replayVersion },
    },
  }), { mode: 0o600 });
  writeFileSync(evidencePath, JSON.stringify({
    stored_families: sensitive.map((item) => item.key).sort(),
    ingested_ids: [],
    forget_targets: [],
    events: [],
  }), { mode: 0o600 });

  const review = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 1,
  });
  const approval = /--approve-removals ([0-9a-f]{64})/.exec(review.output)?.[1] || null;
  const reviewEvidence = readJson(evidencePath);
  const reviewState = readJson(statePath);

  check("scanner v5 rereads the complete IMAP folder instead of starting after its saved UID",
    server.log.some((line) => /SEARCH ALL/.test(line)) &&
      !server.log.some((line) => /SEARCH UID 102:\*/.test(line)), server.log.join(" | "));
  check("more than 100 prior IMAP families stop at one aggregate removal review",
    review.code !== 0 && approval !== null &&
      /101 stored document\(s\) would be removed/.test(review.output), review.output.slice(-1400));
  check("the stopped review prints only an exact reusable approval fingerprint",
    /--approve-removals [0-9a-f]{64}/.test(review.output) &&
      !review.output.includes("scanner-sensitive-") && !review.output.includes(SYNTHETIC_KEY), review.output.slice(-1400));
  check("no deletion request reaches the Worker before that approval",
    reviewEvidence.forget_targets.length === 0 &&
      !reviewEvidence.events.some((entry) => entry.run === 1 && entry.kind === "forget"),
    JSON.stringify(reviewEvidence.events));
  check("the review withholds both the new scanner fingerprint and the new IMAP watermark",
    reviewState.credential_scanner_fingerprint === scannerV4 &&
      reviewState.imap_folders.INBOX.last_uid === 101,
    JSON.stringify({ fingerprint: reviewState.credential_scanner_fingerprint, cursor: reviewState.imap_folders }));

  check("a local done and scanner-progress family absent from D1 is posted again",
    reviewEvidence.ingested_ids.length === 1 && reviewEvidence.ingested_ids[0] === `mid:${replayId}` &&
      reviewEvidence.events.some((entry) => entry.run === 1 && entry.kind === "ingest" && entry.count === 1),
    JSON.stringify({ ingested: reviewEvidence.ingested_ids, events: reviewEvidence.events }));

  server.log.length = 0;
  assert.ok(reviewState.ingest_removal_plan?.targets.length > 0,
    "separate apply must name a saved nonempty plan");
  const applied = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 2, approval,
    apply: reviewState.ingest_removal_plan.fingerprint,
  });
  const appliedState = readJson(statePath);
  const appliedEvidence = readJson(evidencePath);
  check("separate scanner cleanup applies the nonempty plan and preserves the old checkpoint",
    applied.code === 0 && reviewState.ingest_removal_plan.targets.length === 101 &&
      appliedEvidence.forget_targets.length === 101 && server.log.length === 0 &&
      appliedState.credential_scanner_fingerprint === scannerV4 &&
      appliedState.imap_folders.INBOX.last_uid === 101);
  const approved = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 2,
  });
  const approvedEvidence = readJson(evidencePath);
  const approvedState = readJson(statePath);
  const runTwoEvents = approvedEvidence.events.filter((entry) => entry.run === 2);
  const lastForget = runTwoEvents.map((entry) => entry.kind).lastIndexOf("forget");
  const readback = runTwoEvents.findIndex((entry, index) => index > lastForget && entry.kind === "source_families");
  const scannerCommit = runTwoEvents.findIndex((entry, index) =>
    index > readback && entry.kind === "state_write" &&
    entry.scanner_fingerprint === scannerV5 && entry.inbox_last_uid === 102);

  check("the same persisted approval completes the unchanged IMAP cleanup plan",
    approved.code === 0 && !/--approve-removals [0-9a-f]{64}/.test(approved.output), approved.output.slice(-1600));
  check("approved cleanup removes every reviewed prior family in bounded requests",
    approvedEvidence.forget_targets.length === 101 &&
      runTwoEvents.filter((entry) => entry.kind === "forget").length === 3,
    JSON.stringify(runTwoEvents));
  check("authenticated source-family readback follows deletion and precedes scanner/cursor commit",
    lastForget >= 0 && readback > lastForget && scannerCommit > readback,
    JSON.stringify(runTwoEvents));
  check("only readback-confirmed cleanup commits scanner v5 and the complete IMAP watermark",
    approvedState.credential_scanner_fingerprint === scannerV5 &&
      approvedState.imap_folders.INBOX.last_uid === 102 &&
      !Object.keys(approvedState).some((key) => key.includes("imap") && key.includes("removal") && key.includes("baseline")),
    JSON.stringify(approvedState));
  check("the replayed D1 family remains while all approved sensitive families are absent",
    approvedEvidence.stored_families.length === 1 &&
      approvedEvidence.stored_families[0] === replayKey &&
      approvedEvidence.ingested_ids.length === 1,
    JSON.stringify({ stored: approvedEvidence.stored_families, ingested: approvedEvidence.ingested_ids }));

  // Once the scanner migration is complete, both removal kinds must preserve
  // the saved UID on review/apply and resume incrementally after exact apply.
  // Obsolete parts and source refusals take different paths to the boundary.
  for (const [index, kind] of ["family", "source"].entries()) {
    const beforeState = readJson(statePath);
    const beforeEvidence = readJson(evidencePath);
    const savedUid = beforeState.imap_folders.INBOX.last_uid;
    const itemId = `incremental-${kind}@example.invalid`;
    const itemKey = stateKeyOf(itemId);
    const removalTarget = kind === "family" ? `${itemKey}#part1of2` : itemKey;
    const addedId = `incremental-${kind}-addition@example.invalid`;
    const addedKey = stateKeyOf(addedId);
    // Keep the source plan strictly below both aggregate approval thresholds.
    beforeEvidence.stored_families = [...new Set([
      ...beforeEvidence.stored_families, removalTarget,
      ...Array.from({ length: 20 }, (_, n) => `${SOURCE}:mid:baseline-${n}@example.invalid`),
    ])].sort();
    writeFileSync(evidencePath, JSON.stringify(beforeEvidence), { mode: 0o600 });
    const changedRaw = message({ messageId: itemId, subject: "Synthetic incremental revision",
      body: kind === "family"
        ? "This accepted synthetic revision replaces an obsolete split representation."
        : `This invented message contains a synthetic credential-shaped value ${SYNTHETIC_KEY}.`,
    });
    const addedRaw = message({ messageId: addedId, subject: "Synthetic incremental addition",
      body: "This accepted synthetic addition must remain durable while removal waits for review.",
    });
    inbox.add(changedRaw, { internaldate: "31-Aug-2026 16:06:00 +0000" });
    inbox.add(addedRaw, { internaldate: "31-Aug-2026 16:07:00 +0000" });
    const run = 8 + index * 4;
    const args = { manifestPath, evidencePath, statePath, userRoot, port: server.port };
    server.log.length = 0;
    const stopped = await runCli({ ...args, run });
    const stoppedState = readJson(statePath);
    const stoppedEvidence = readJson(evidencePath);
    const plan = stoppedState.ingest_removal_plan;
    check(`${kind} removal review reads only after the saved UID and reaches a nonempty exact plan`,
      stopped.code !== 0 && plan?.targets.length === 1 && plan.targets[0] === removalTarget &&
        server.log.some((line) => line === `UID SEARCH UID ${savedUid + 1}:*`) &&
        !server.log.some((line) => /SEARCH ALL/.test(line)) &&
        stoppedEvidence.events.some((entry) => entry.run === run && entry.kind === "plan_preview") &&
        plan.sourcePlan.tooLarge === false);
    check(`${kind} removal review saves accepted work without forgetting or advancing the checkpoint`,
      stoppedEvidence.ingested_ids.includes(`mid:${addedId}`) &&
        stoppedState.done[addedKey] === versionOf(addedRaw) &&
        (kind !== "family" || stoppedState.done[itemKey] === versionOf(changedRaw)) &&
        stoppedEvidence.forget_targets.length === beforeEvidence.forget_targets.length &&
        stoppedState.imap_folders.INBOX.last_uid === savedUid &&
        stoppedState.credential_scanner_fingerprint === scannerV5);

    const mismatch = await runCli({ ...args, run: run + 1,
      apply: (plan.fingerprint[0] === "0" ? "1" : "0") + plan.fingerprint.slice(1) });
    const mismatchEvidence = readJson(evidencePath);
    check(`${kind} removal refuses a mismatched fingerprint after the plan decision was reached`,
      mismatch.code !== 0 && /No matching saved removal plan/.test(mismatch.output) &&
        readJson(statePath).ingest_removal_plan.fingerprint === plan.fingerprint &&
        mismatchEvidence.forget_targets.length === beforeEvidence.forget_targets.length &&
        !mismatchEvidence.events.some((entry) => entry.run === run + 1 && entry.kind === "plan_apply"));

    server.log.length = 0;
    const applied = await runCli({ ...args, run: run + 2, apply: plan.fingerprint });
    const appliedState = readJson(statePath);
    const appliedEvidence = readJson(evidencePath);
    check(`${kind} matching apply removes exactly the reviewed item while preserving the saved UID`,
      applied.code === 0 && server.log.length === 0 &&
        appliedEvidence.events.some((entry) => entry.run === run + 2 && entry.kind === "plan_apply") &&
        appliedEvidence.forget_targets.length === beforeEvidence.forget_targets.length + 1 &&
        appliedEvidence.forget_targets.at(-1) === removalTarget &&
        appliedEvidence.stored_families.includes(addedKey) &&
        appliedState.imap_folders.INBOX.last_uid === savedUid &&
        appliedState.credential_scanner_fingerprint === scannerV5);

    const resumed = await runCli({ ...args, run: run + 3 });
    const resumedState = readJson(statePath);
    const resumedEvidence = readJson(evidencePath);
    check(`${kind} refresh resumes after the saved UID and commits only after removal readback`,
      resumed.code === 0 &&
        server.log.some((line) => line === `UID SEARCH UID ${savedUid + 1}:*`) &&
        !server.log.some((line) => /SEARCH ALL/.test(line)) &&
        resumedState.imap_folders.INBOX.last_uid === savedUid + 2 &&
        resumedState.credential_scanner_fingerprint === scannerV5 &&
        !resumedState.ingest_removal_plan &&
        resumedEvidence.ingested_ids.length === stoppedEvidence.ingested_ids.length &&
        resumedEvidence.forget_targets.length === appliedEvidence.forget_targets.length);
  }

  server.log.length = 0;
  const settledUid = readJson(statePath).imap_folders.INBOX.last_uid;
  const settledEvidence = readJson(evidencePath);
  const noChanges = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 16,
  });
  const noChangesEvidence = readJson(evidencePath);
  check("a zero-removal incremental refresh keeps its UID and does not fetch the prior messages again",
    noChanges.code === 0 &&
      server.log.some((line) => line === `UID SEARCH UID ${settledUid + 1}:*`) &&
      !server.log.some((line) => /SEARCH ALL|UID FETCH/.test(line)) &&
      readJson(statePath).imap_folders.INBOX.last_uid === settledUid &&
      noChangesEvidence.ingested_ids.length === settledEvidence.ingested_ids.length &&
      noChangesEvidence.forget_targets.length === settledEvidence.forget_targets.length);

  // A prior removal receipt can be pending when the source message reappears.
  // If its current bytes no longer yield a stable identity, the pending family
  // might be that restored message. The connector must preserve both until it
  // can prove whether they are the same logical document.
  inbox.messages.clear();
  inbox.nextUid = 1;
  inbox.add("", { uid: 1, internaldate: "31-Aug-2026 16:02:00 +0000" });
  const pendingIdentity = `${SOURCE}:mid:pending-restored@example.invalid`;
  const fillerFamilies = Array.from(
    { length: 10 },
    (_, index) => `${SOURCE}:mid:inventory-${String(index + 1).padStart(2, "0")}@example.invalid`,
  );
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: Object.fromEntries(
      [pendingIdentity, ...fillerFamilies].map((uid) => [uid, "sha256:prior-synthetic-version"]),
    ),
    skipped: {},
    removed: { [pendingIdentity]: "2026-09-01T00:00:00.000Z" },
    imap_folders: { INBOX: { uidvalidity: UIDVALIDITY, last_uid: 0 } },
    imap_policy_fingerprint: imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles),
    credential_scanner_fingerprint: scannerV4,
    credential_scanner_progress: { fingerprint: scannerV5, accepted: {} },
  }), { mode: 0o600 });
  writeFileSync(evidencePath, JSON.stringify({
    stored_families: [pendingIdentity, ...fillerFamilies].sort(),
    ingested_ids: [],
    forget_targets: [],
    events: [],
  }), { mode: 0o600 });

  const unidentified = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 3,
  });
  const unidentifiedEvidence = readJson(evidencePath);
  const unidentifiedState = readJson(statePath);
  check("an unidentified current message cannot authorize deletion of a pending stored family",
    unidentifiedEvidence.forget_targets.length === 0 &&
      unidentifiedEvidence.stored_families.includes(pendingIdentity) &&
      unidentifiedState.removed?.[pendingIdentity] === "2026-09-01T00:00:00.000Z",
    JSON.stringify({ evidence: unidentifiedEvidence, state: unidentifiedState }));
  check("an unresolved IMAP identity withholds both the scanner migration and folder cursor",
    unidentifiedState.credential_scanner_fingerprint === scannerV4 &&
      unidentifiedState.imap_folders.INBOX.last_uid === 0 &&
      /IMAP source snapshot gap\(s\) remained unresolved/.test(unidentified.output),
    JSON.stringify({ state: unidentifiedState, output: unidentified.output.slice(-1200) }));

  // The opposite side of the same crash boundary: a prior forget may have
  // reached D1 before its response or follow-up inventory was lost. When D1's
  // pre-run inventory proves the pending family is already absent, a current
  // retain-existing skip has nothing left to preserve and must not wedge the
  // folder cursor forever.
  inbox.messages.clear();
  inbox.nextUid = 1;
  const alreadyRemovedId = "pending-already-removed@example.invalid";
  const alreadyRemovedKey = stateKeyOf(alreadyRemovedId);
  inbox.add(`Message-ID: <${alreadyRemovedId}>\r\n\r\n`, {
    uid: 1,
    internaldate: "31-Aug-2026 16:03:00 +0000",
  });
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: { [alreadyRemovedKey]: "sha256:prior-synthetic-version" },
    skipped: {},
    removed: { [alreadyRemovedKey]: "2026-09-01T00:00:00.000Z" },
    imap_folders: { INBOX: { uidvalidity: UIDVALIDITY, last_uid: 0 } },
    imap_policy_fingerprint: imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles),
    credential_scanner_fingerprint: scannerV4,
    credential_scanner_progress: { fingerprint: scannerV5, accepted: {} },
  }), { mode: 0o600 });
  writeFileSync(evidencePath, JSON.stringify({
    stored_families: [],
    ingested_ids: [],
    forget_targets: [],
    events: [],
  }), { mode: 0o600 });

  const alreadyRemoved = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 4,
  });
  const alreadyRemovedEvidence = readJson(evidencePath);
  const alreadyRemovedState = readJson(statePath);
  check("D1 absence settles a stale pending IMAP removal without another forget",
    alreadyRemovedEvidence.forget_targets.length === 0 &&
      !Object.hasOwn(alreadyRemovedState.removed || {}, alreadyRemovedKey) &&
      !Object.hasOwn(alreadyRemovedState.done || {}, alreadyRemovedKey),
    JSON.stringify({ evidence: alreadyRemovedEvidence, state: alreadyRemovedState }));
  check("an already-absent retained IMAP family cannot wedge scanner or folder progress",
    alreadyRemoved.code === 0 &&
      alreadyRemovedState.credential_scanner_fingerprint === scannerV5 &&
      alreadyRemovedState.imap_folders.INBOX.last_uid === 1 &&
      !/IMAP source snapshot gap\(s\) remained unresolved/.test(alreadyRemoved.output),
    JSON.stringify({ state: alreadyRemovedState, output: alreadyRemoved.output.slice(-1200) }));

  // Folder exclusions and message skips use different units. A single Spam
  // folder must not erase a single unreadable INBOX message from coverage.
  server.folders.set("Spam", new Folder("Spam", {
    uidvalidity: UIDVALIDITY + 1,
    flags: ["\\Junk"],
  }));
  inbox.messages.clear();
  inbox.nextUid = 1;
  const unreadableId = "folder-count-cannot-hide-message-gap@example.invalid";
  inbox.add(`Message-ID: <${unreadableId}>\r\n\r\n`, {
    uid: 1,
    internaldate: "31-Aug-2026 16:04:00 +0000",
  });
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: {},
    skipped: {},
    imap_folders: { INBOX: { uidvalidity: UIDVALIDITY, last_uid: 0 } },
    imap_policy_fingerprint: imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles),
    credential_scanner_fingerprint: scannerV5,
  }), { mode: 0o600 });
  writeFileSync(evidencePath, JSON.stringify({
    stored_families: [],
    ingested_ids: [],
    forget_targets: [],
    events: [],
  }), { mode: 0o600 });

  const folderCountGap = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 5,
  });
  const folderCountEvidence = readJson(evidencePath);
  const folderCountReceipts = folderCountEvidence.events.filter(
    (entry) => entry.run === 5 && entry.kind === "receipt",
  );
  check("an excluded IMAP folder cannot cancel an unreadable message coverage gap",
    folderCountGap.code === 0 &&
      folderCountReceipts.at(-1)?.status === "error" &&
      folderCountReceipts.at(-1)?.issue_code === "INGEST_FAILED" &&
      !folderCountReceipts.some((entry) => entry.status === "ready"),
    JSON.stringify({ receipts: folderCountReceipts, output: folderCountGap.output.slice(-1200) }));

  // SEARCH can name a UID that FETCH omits. Without a stable Message-ID there
  // is no family to reconcile, so an incremental watermark must wait and retry
  // that UID rather than silently stepping over it.
  inbox.messages.clear();
  inbox.nextUid = 1;
  const fetchRetryId = "fetch-missing-retry@example.invalid";
  inbox.add(message({
    messageId: fetchRetryId,
    subject: "FETCH retry coverage",
    body: "This synthetic message remains on the server after one deliberately incomplete FETCH response.",
  }), { uid: 1, internaldate: "31-Aug-2026 16:05:00 +0000" });
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: {},
    skipped: {},
    imap_folders: { INBOX: { uidvalidity: UIDVALIDITY, last_uid: 0 } },
    imap_policy_fingerprint: imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles),
    credential_scanner_fingerprint: scannerV5,
  }), { mode: 0o600 });
  writeFileSync(evidencePath, JSON.stringify({
    stored_families: [],
    ingested_ids: [],
    forget_targets: [],
    events: [],
  }), { mode: 0o600 });
  server.omitNextFetchUid = 1;

  const fetchMissing = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 6,
  });
  const fetchMissingEvidence = readJson(evidencePath);
  const fetchMissingState = readJson(statePath);
  const fetchMissingReceipts = fetchMissingEvidence.events.filter(
    (entry) => entry.run === 6 && entry.kind === "receipt",
  );
  check("an incremental FETCH omission without stable identity withholds the folder cursor",
    fetchMissing.code === 0 &&
      fetchMissingState.imap_folders.INBOX.last_uid === 0 &&
      fetchMissingReceipts.at(-1)?.status === "error" &&
      /1 IMAP source snapshot gap\(s\) remained unresolved/.test(fetchMissing.output),
    JSON.stringify({ state: fetchMissingState, receipts: fetchMissingReceipts, output: fetchMissing.output.slice(-1200) }));

  const fetchRetried = await runCli({
    manifestPath, evidencePath, statePath, userRoot, port: server.port, run: 7,
  });
  const fetchRetriedEvidence = readJson(evidencePath);
  const fetchRetriedState = readJson(statePath);
  const fetchRetriedReceipts = fetchRetriedEvidence.events.filter(
    (entry) => entry.run === 7 && entry.kind === "receipt",
  );
  check("the withheld UID is ingested and committed on the next complete FETCH",
    fetchRetried.code === 0 &&
      fetchRetriedEvidence.ingested_ids.includes(`mid:${fetchRetryId}`) &&
      fetchRetriedState.imap_folders.INBOX.last_uid === 1 &&
      fetchRetriedReceipts.at(-1)?.status === "ready" &&
      /folder_policy_skipped=1/.test(fetchRetriedReceipts.at(-1)?.detail || ""),
    JSON.stringify({ state: fetchRetriedState, receipts: fetchRetriedReceipts, evidence: fetchRetriedEvidence }));

  console.log(`\nimap scanner removal: all ${ran} checks passed`);
} finally {
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}
