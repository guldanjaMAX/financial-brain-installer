import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDriveRemovalPlanSafe,
  batchSourceFamilyLabelUids,
  buildDriveRemovalPlan,
  credentialScannerFingerprint,
  DRIVE_STORED_FAMILY_UID_MAX_BYTES,
  DRIVE_REMOVAL_MAX_COUNT,
  DRIVE_REMOVAL_MAX_RATIO,
  drivePolicyFingerprint,
  isRetryableDriveError,
  isCanonicalStoredFamilyUid,
  listStoredSourceFamilies,
  renderMalformedDriveIdentities,
  remoteFamilySettlement,
  safeIngestDisplay,
  VALUE_FLAGS,
} from "../brain.mjs";
import { driveVersion } from "../connectors/google-drive.mjs";
import { brainCliPrefix, renderCliCommands } from "../operations/cli-guidance.mjs";
import { previewSupportJournal } from "../support-journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const DRIVE_GUARD_FETCH = pathToFileURL(join(HERE, "fixtures", "drive-removal-guard-fetch.mjs")).href;
const DRIVE_SCOPE_FETCH = pathToFileURL(join(HERE, "fixtures", "drive-scope-boundary-fetch.mjs")).href;
const DRIVE_ACTIVE_SKIP_FETCH = pathToFileURL(join(HERE, "fixtures", "drive-active-skip-fetch.mjs")).href;
const guidanceSource = readFileSync(join(HERE, "..", "operations", "cli-guidance.mjs"), "utf8");
const commandAlternation = guidanceSource.match(
  /const COMMAND = \/\\bbrain\(\?=\\s\+\(\?:([^)]+)\)\\b\)\//
)?.[1];
assert.ok(commandAlternation, "the CLI renderer command vocabulary could not be read");
const diagnoseCommand = commandAlternation.split("|").find((command) => command === "diagnose");
assert.ok(diagnoseCommand, "the CLI renderer no longer covers diagnose guidance");
const bareDiagnoseCommand = new RegExp(String.raw`\bbrain\s+(?:${diagnoseCommand})\b`);

const CATEGORIES = ["source_policy", "source_deleted", "intentional_skip"];

const injectedDriveDouble = {
  classifyScopedAbsence: async () => {
    const error = new Error("temporary injected connector failure");
    error.name = "DriveError";
    error.retryable = true;
    throw error;
  },
};
let injectedDriveError = null;
try {
  await injectedDriveDouble.classifyScopedAbsence();
} catch (error) {
  injectedDriveError = error;
}
assert.equal(isRetryableDriveError(injectedDriveError), true,
  "an injected Drive double without a DriveError constructor was not recognized");
assert.equal(isRetryableDriveError({ name: "DriveError", retryable: false }), false);
assert.equal(isRetryableDriveError({ name: "OtherError", retryable: true }), false);

function ids(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);
}

function assertReviewListing(output, state) {
  const records = state.drive_removal_review.source_deletion_candidates;
  assert.equal(records.length, 1, "the listing fixture needs a nonempty two-walk plan");
  assert.ok(records.every((record) => record.name && record.folder_path),
    "every review item must have both stored labels");
  assert.deepEqual(output.split("\n").filter((line) => line.startsWith("- ")),
    records.map((record) => `- ${safeIngestDisplay(record.name)} (folder: ${safeIngestDisplay(record.folder_path)})`),
    "the approval stop must list exactly its eligible items with their stored name and folder");
}

function errorMessage(plan, approval) {
  try {
    assertDriveRemovalPlanSafe(plan, approval);
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}

function reportsCount(message, label, count) {
  const between = "[^0-9]{0,32}";
  return new RegExp(`(?:${label}${between}${count}\\b|\\b${count}${between}${label})`, "i").test(message);
}

assert.equal(DRIVE_REMOVAL_MAX_COUNT, 100);
assert.equal(DRIVE_REMOVAL_MAX_RATIO, 0.10);
assert.equal(DRIVE_STORED_FAMILY_UID_MAX_BYTES, 256);

for (const uid of ["drive:", "drive:   ", "drive:\t", "drive: abc"]) {
  assert.equal(isCanonicalStoredFamilyUid(uid, "drive"), false, JSON.stringify(uid));
  assert.throws(() => buildDriveRemovalPlan({
    storedFamilies: [uid],
    policyCandidates: [],
    vanishedCandidates: [uid],
    intentionalCandidates: [],
  }), /malformed document identity/i, `${JSON.stringify(uid)} produced an approval fingerprint`);
}
assert.equal(isCanonicalStoredFamilyUid("drive:a", "drive"), true);
const invalidDriveIdentities = [
  "drive:abc\u200bdef",
  "drive:abc\u200ddef",
  "drive:abc\u202edef",
  "drive:abc\u2066def",
  "drive:abc\u3164def",
  "drive:abc\ufe0fdef",
  "drive:abc\ud800def",
  `drive:${"a".repeat(251)}`,
];
for (const uid of invalidDriveIdentities) {
  assert.equal(isCanonicalStoredFamilyUid(uid, "drive"), false, JSON.stringify(uid));
  assert.throws(() => buildDriveRemovalPlan({
    storedFamilies: [uid],
    vanishedCandidates: [uid],
  }), /malformed document identity/i, `${JSON.stringify(uid)} produced a deletion fingerprint`);
}
assert.equal(isCanonicalStoredFamilyUid(`drive:${"a".repeat(250)}`, "drive"), true);

const legitimateFamilyShapes = [
  "drive:file",
  "drive:file#part1of2",
  "gmail:message",
  "imap:message",
  "calendar:event",
  "message:hash",
  "imessage:chat",
  "whatsapp:chat",
  "zoom:meeting",
  "curated:item",
  "upload:WhatsApp Chat with Fixture.txt",
];
for (const uid of legitimateFamilyShapes) {
  assert.equal(isCanonicalStoredFamilyUid(uid), true, `${uid} was rejected`);
}

{
  const originalFetch = globalThis.fetch;
  try {
    for (const uid of legitimateFamilyShapes) {
      const source = uid.slice(0, uid.indexOf(":"));
      globalThis.fetch = async () => new Response(JSON.stringify({
        source,
        families: [uid],
        next_cursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
      const inventory = await listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source,
      });
      assert.deepEqual([...inventory], [uid], `${uid} did not survive source-family inventory`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const candidates = Array.from({ length: 2500 }, (_, index) =>
    `drive:batch-${String(index).padStart(4, "0")}`
  );
  const batches = batchSourceFamilyLabelUids({ source: "drive", uids: candidates });
  assert.equal(batches.length, 26);
  assert.ok(batches.every((batch) => batch.length <= 97));
  assert.deepEqual(batches.flat(), candidates,
    "source-family label batching duplicated, reordered or dropped a candidate");
  assert.equal(new Set(batches.flat()).size, candidates.length);

  const longCandidates = Array.from({ length: 7 }, (_, index) =>
    `drive:${index}-${"a".repeat(10_000)}`
  );
  const byteBatches = batchSourceFamilyLabelUids({ source: "drive", uids: longCandidates });
  assert.ok(byteBatches.length > 1, "the serialized-byte ceiling did not split synthetic long ids");
  for (const batch of byteBatches) {
    const bytes = new TextEncoder().encode(JSON.stringify({
      source: "drive",
      limit: 1000,
      include_labels: true,
      uids: batch,
    })).length;
    assert.ok(bytes < 32 * 1024, `label request was ${bytes} bytes`);
  }
  assert.deepEqual(byteBatches.flat(), longCandidates);
}

{
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [413, 500]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ error: "fixture refusal" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
      await assert.rejects(
        listStoredSourceFamilies({
          base: "https://fixture.invalid",
          adminKey: "fixture-admin",
          source: "drive",
          includeLabels: true,
          uids: ["drive:a"],
        }),
        new RegExp(`not accepted \\(${status}\\)`, "i"),
      );
      assert.equal(calls, 1, `HTTP ${status} was treated as a capability signal`);
    }

    let pageCalls = 0;
    globalThis.fetch = async (_input, options = {}) => {
      pageCalls++;
      const body = JSON.parse(String(options.body || "{}"));
      if (!body.cursor) {
        return new Response(JSON.stringify({
          source: "drive",
          families: ["drive:a"],
          family_details: [{ uid: "drive:a", name: "A", folder_path: null }],
          next_cursor: "drive:a",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "source-family request has unknown fields" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        includeLabels: true,
        uids: ["drive:a"],
      }),
      /not accepted \(400\)/i,
    );
    assert.equal(pageCalls, 2, "a page-two 400 restarted or widened the inventory walk");

    let unexpectedFieldCalls = 0;
    globalThis.fetch = async (_input, options = {}) => {
      unexpectedFieldCalls++;
      const body = JSON.parse(String(options.body || "{}"));
      if (body.include_labels || body.uids) {
        return new Response(JSON.stringify({
          error: "wording is deliberately unrelated to compatibility detection",
          code: "unknown_field",
          field: "limit",
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        source: "drive",
        families: [],
        next_cursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const requestShapedFallback = await listStoredSourceFamilies({
      base: "https://fixture.invalid",
      adminKey: "fixture-admin",
      source: "drive",
      includeLabels: true,
      uids: ["drive:a"],
    });
    assert.equal(unexpectedFieldCalls, 3,
      "an unrelated structured field changed or looped the request-shaped fallback ladder");
    assert.equal(requestShapedFallback.families.size, 0);

    let controlCursorCalls = 0;
    globalThis.fetch = async (_input, options = {}) => {
      controlCursorCalls++;
      const body = JSON.parse(String(options.body || "{}"));
      if (!body.cursor) {
        return new Response(JSON.stringify({
          source: "drive",
          families: ["drive:a\t"],
          family_details: [{ uid: "drive:a\t", name: null, folder_path: null }],
          next_cursor: "drive:a\t",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        error: "wording is deliberately unrelated to compatibility detection",
        code: "unknown_field",
        field: "include_labels",
      }), { status: 400, headers: { "content-type": "application/json" } });
    };
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        includeLabels: true,
      }),
      /update the Brain/i,
    );
    assert.equal(controlCursorCalls, 2,
      "a structured page-two error hid the older Brain's control-cursor incompatibility");

    for (const status of [413, 429, 500]) {
      let laterStatusCalls = 0;
      globalThis.fetch = async (_input, options = {}) => {
        laterStatusCalls++;
        const body = JSON.parse(String(options.body || "{}"));
        if (!body.cursor) {
          return new Response(JSON.stringify({
            source: "drive",
            families: ["drive:a"],
            family_details: [{ uid: "drive:a", name: "A", folder_path: null }],
            next_cursor: "drive:a",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "fixture later-page refusal" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
      await assert.rejects(
        listStoredSourceFamilies({
          base: "https://fixture.invalid",
          adminKey: "fixture-admin",
          source: "drive",
          includeLabels: true,
        }),
        new RegExp(`not accepted \\(${status}\\)`, "i"),
      );
      assert.equal(laterStatusCalls, 2, `HTTP ${status} on page two restarted the inventory walk`);
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      source: "drive",
      families: ["drive:a"],
      next_cursor: "gmail:a",
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(
      listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
      }),
      (error) => /invalid next cursor/i.test(String(error?.message || error)) &&
        !/update the Brain/i.test(String(error?.message || error)),
      "the over-long-tail guidance swallowed an unrelated invalid cursor shape",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* Candidate sets are intersected with live stored families and categorized once. */
const overlapPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:policy", "drive:deleted", "drive:skip", "drive:overlap", "drive:untouched"],
  policyCandidates: ["drive:not-stored-policy", "drive:overlap", "drive:policy", "drive:policy"],
  vanishedCandidates: ["drive:deleted", "drive:overlap", "drive:not-stored-deleted"],
  intentionalCandidates: ["drive:skip", "drive:overlap", "drive:not-stored-skip"],
});
assert.equal(overlapPlan.stored, 5);
assert.equal(overlapPlan.total, 4);
assert.deepEqual(Object.keys(overlapPlan.counts).sort(), [...CATEGORIES].sort());
assert.deepEqual(Object.keys(overlapPlan.targets).sort(), [...CATEGORIES].sort());

const overlapTargets = CATEGORIES.flatMap((category) => {
  assert.equal(overlapPlan.counts[category], overlapPlan.targets[category].length);
  return overlapPlan.targets[category];
});
assert.equal(overlapTargets.length, overlapPlan.total);
assert.equal(new Set(overlapTargets).size, overlapPlan.total);
assert.deepEqual(
  [...overlapTargets].sort(),
  ["drive:deleted", "drive:overlap", "drive:policy", "drive:skip"],
);
assert.equal(CATEGORIES.reduce((sum, category) => sum + overlapPlan.counts[category], 0), overlapPlan.total);

/* A restored active file beats a stale failed-deletion marker on retry. */
const restoredPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: [],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: [],
});
assert.equal(restoredPlan.total, 0);
assert.deepEqual(restoredPlan.targets.source_deleted, []);

const restoredButRefusedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: [],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: ["drive:restored"],
});
assert.equal(restoredButRefusedPlan.total, 1);
assert.deepEqual(restoredButRefusedPlan.targets.source_deleted, []);
assert.deepEqual(restoredButRefusedPlan.targets.intentional_skip, ["drive:restored"]);

const restoredButExcludedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: ["drive:restored"],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: [],
});
assert.equal(restoredButExcludedPlan.total, 1);
assert.deepEqual(restoredButExcludedPlan.targets.source_policy, ["drive:restored"]);
assert.deepEqual(restoredButExcludedPlan.targets.source_deleted, []);

/* Worker refusals join the guarded plan; storage failures preserve old data. */
const refusedFamilies = ids("drive:worker-refused", 101).map((uid) => ({
  stateKey: uid,
  base_doc_uid: uid,
  keep_doc_uids: [`${uid}#part1of2`, `${uid}#part2of2`],
}));
const refusedSettlement = remoteFamilySettlement(
  { completed: [], incomplete: refusedFamilies },
  new Map(refusedFamilies.map((plan) => [plan.stateKey, ["refused"]])),
);
assert.deepEqual(refusedSettlement.reconciliations, []);
assert.equal(refusedSettlement.intentionalRemovalUids.length, 101);
const refusedPlan = buildDriveRemovalPlan({
  storedFamilies: refusedFamilies.map((plan) => plan.base_doc_uid),
  activeFamilies: refusedFamilies.map((plan) => plan.base_doc_uid),
  policyCandidates: [],
  vanishedCandidates: [],
  intentionalCandidates: refusedSettlement.intentionalRemovalUids,
});
assert.equal(refusedPlan.total, 101);
assert.equal(refusedPlan.tooLarge, true);
assert.ok(errorMessage(refusedPlan), "101 pre-existing refused families must stop at the aggregate guard");

const failedSettlement = remoteFamilySettlement(
  { completed: [], incomplete: refusedFamilies },
  new Map(refusedFamilies.map((plan) => [plan.stateKey, ["failed"]])),
);
assert.deepEqual(failedSettlement.reconciliations, []);
assert.deepEqual(failedSettlement.intentionalRemovalUids, []);

const acceptedFamily = refusedFamilies[0];
const completedSettlement = remoteFamilySettlement(
  { completed: [acceptedFamily], incomplete: [] },
  new Map(),
);
assert.deepEqual(completedSettlement.reconciliations, [{
  base_doc_uid: acceptedFamily.base_doc_uid,
  keep_doc_uids: acceptedFamily.keep_doc_uids,
}]);

/* The approval identity is canonical, opaque, and binds both target and category. */
const reorderedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:untouched", "drive:overlap", "drive:skip", "drive:deleted", "drive:policy"],
  policyCandidates: ["drive:policy", "drive:overlap", "drive:not-stored-policy"],
  vanishedCandidates: ["drive:not-stored-deleted", "drive:overlap", "drive:deleted", "drive:deleted"],
  intentionalCandidates: ["drive:overlap", "drive:skip"],
});
assert.match(overlapPlan.fingerprint, /^[a-f0-9]{64}$/);
assert.equal(reorderedPlan.fingerprint, overlapPlan.fingerprint);

const fingerprintFixture = {
  storedFamilies: ["drive:a", "drive:b", ...ids("drive:retained", 18)],
  policyCandidates: ["drive:a"],
  vanishedCandidates: [],
  intentionalCandidates: [],
};
const targetChanged = buildDriveRemovalPlan({
  ...fingerprintFixture,
  policyCandidates: ["drive:b"],
});
const categoryChanged = buildDriveRemovalPlan({
  ...fingerprintFixture,
  policyCandidates: [],
  vanishedCandidates: ["drive:a"],
});
assert.notEqual(buildDriveRemovalPlan(fingerprintFixture).fingerprint, targetChanged.fingerprint);
assert.notEqual(buildDriveRemovalPlan(fingerprintFixture).fingerprint, categoryChanged.fingerprint);
const displayedReviewPlan = buildDriveRemovalPlan(fingerprintFixture, {
  fingerprintBinding: [{
    uid: "drive:a",
    name: "Owner tax return.txt",
    folder_path: "Reviewed Root/Tax",
    observation_id: "sync_review_a",
    observed_at: "2026-09-18T08:00:00.000Z",
  }],
});
const renamedReviewPlan = buildDriveRemovalPlan(fingerprintFixture, {
  fingerprintBinding: [{
    uid: "drive:a",
    name: "Renamed tax return.txt",
    folder_path: "Reviewed Root/Tax",
    observation_id: "sync_review_a",
    observed_at: "2026-09-18T08:00:00.000Z",
  }],
});
assert.notEqual(displayedReviewPlan.fingerprint, renamedReviewPlan.fingerprint,
  "the approval fingerprint must bind the displayed local name");

/* The limits are strict exceedance checks, with count and ratio enforced independently. */
const emptyPlan = buildDriveRemovalPlan({
  storedFamilies: [],
  policyCandidates: [],
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(emptyPlan.total, 0);
assert.equal(emptyPlan.ratio, 0);
assert.equal(emptyPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(emptyPlan));

const smallStored = ids("drive:small", 20);
const smallPlan = buildDriveRemovalPlan({
  storedFamilies: smallStored,
  policyCandidates: [smallStored[0]],
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(smallPlan.ratio, 0.05);
assert.equal(smallPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(smallPlan));

const boundaryStored = ids("drive:boundary", 1_000);
const boundaryPlan = buildDriveRemovalPlan({
  storedFamilies: boundaryStored,
  policyCandidates: boundaryStored.slice(0, 100),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(boundaryPlan.total, 100);
assert.equal(boundaryPlan.ratio, 0.10);
assert.equal(boundaryPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(boundaryPlan));

const countStored = ids("drive:count", 2_000);
const countLimitedPlan = buildDriveRemovalPlan({
  storedFamilies: countStored,
  policyCandidates: countStored.slice(0, 101),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(countLimitedPlan.total, 101);
assert.ok(countLimitedPlan.ratio < DRIVE_REMOVAL_MAX_RATIO);
assert.equal(countLimitedPlan.tooLarge, true);

const ratioStored = ids("drive:ratio", 10);
const ratioLimitedPlan = buildDriveRemovalPlan({
  storedFamilies: ratioStored,
  policyCandidates: ratioStored.slice(0, 2),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(ratioLimitedPlan.total, 2);
assert.equal(ratioLimitedPlan.ratio, 0.20);
assert.equal(ratioLimitedPlan.tooLarge, true);

const oneTypedPlan = buildDriveRemovalPlan({
  storedFamilies: ["gmail:one"],
  policyCandidates: [],
  vanishedCandidates: ["gmail:one"],
  intentionalCandidates: [],
}, { ratioFloorCount: 1, fingerprintContext: "gmail-current-typed" });
assert.equal(oneTypedPlan.ratio, 1);
assert.equal(oneTypedPlan.tooLarge, false);
assert.notEqual(oneTypedPlan.fingerprint, buildDriveRemovalPlan({
  storedFamilies: ["gmail:one"],
  policyCandidates: [],
  vanishedCandidates: ["gmail:one"],
  intentionalCandidates: [],
}, { fingerprintContext: "gmail-strict" }).fingerprint);

let gmailRefusal = null;
try {
  assertDriveRemovalPlanSafe(ratioLimitedPlan, null, { sourceLabel: "Gmail" });
} catch (error) {
  gmailRefusal = error.message;
}
assert.match(gmailRefusal || "", /^Gmail cleanup would remove/);

/* A refusal is aggregate-only and tells the operator how to approve this exact plan. */
const rawUids = {
  source_policy: "drive:RAW_POLICY_UID_DO_NOT_PRINT",
  source_deleted: "drive:RAW_DELETED_UID_DO_NOT_PRINT",
  intentional_skip: "drive:RAW_SKIP_UID_DO_NOT_PRINT",
};
const approvalStored = [...Object.values(rawUids), ...ids("drive:approval-retained", 17)];
const approvalPlan = buildDriveRemovalPlan({
  storedFamilies: approvalStored,
  policyCandidates: [rawUids.source_policy],
  vanishedCandidates: [rawUids.source_deleted],
  intentionalCandidates: [rawUids.intentional_skip],
});
assert.equal(approvalPlan.total, 3);
assert.equal(approvalPlan.stored, 20);
assert.equal(approvalPlan.tooLarge, true);

const refusal = errorMessage(approvalPlan);
assert.ok(refusal, "an unusually large plan must be refused without approval");
assert.ok(reportsCount(refusal, "source[_\\s-]*policy", 1), refusal);
assert.ok(reportsCount(refusal, "source[_\\s-]*(?:deleted|deletion)", 1), refusal);
assert.ok(reportsCount(refusal, "intentional[_\\s-]*skip", 1), refusal);
assert.ok(
  (reportsCount(refusal, "total", 3) && reportsCount(refusal, "stored", 20)) ||
    /remove[^0-9]{0,16}3[^0-9]{0,16}of[^0-9]{0,16}20[^0-9]{0,16}stored/i.test(refusal),
  refusal,
);
assert.match(refusal, /nothing[^\n.]{0,80}(?:was |has been )?removed/i);
assert.match(refusal, /cursor (?:was |is )?(?:not advanced|withheld)/i);
assert.ok(refusal.includes(`--approve-removals ${approvalPlan.fingerprint}`), refusal);
for (const uid of Object.values(rawUids)) assert.ok(!refusal.includes(uid), refusal);

assert.doesNotThrow(() => assertDriveRemovalPlanSafe(approvalPlan, approvalPlan.fingerprint));
const wrongFingerprint = `${approvalPlan.fingerprint.slice(0, -1)}${approvalPlan.fingerprint.endsWith("0") ? "1" : "0"}`;
for (const malformed of [undefined, true, "", "not-a-sha256", wrongFingerprint, ` ${approvalPlan.fingerprint}`]) {
  assert.ok(errorMessage(approvalPlan, malformed), `approval ${JSON.stringify(malformed)} must not bypass the guard`);
}

/*
 * A walked non-text file is an adjudicated source skip, not a refused ingest
 * attempt. A locally detected credential is a refusal. Exercise both in one
 * real Drive command so the receipt cannot inflate docs_refused with every
 * source-policy decision while still preserving the credential outcome.
 */
{
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-drive-active-skips-")));
  const manifestPath = join(directory, "fixture.manifest.json");
  const statePath = join(directory, ".brain-ingest-drive.json");
  const evidencePath = join(directory, "active-skip-evidence.json");
  const userRoot = join(directory, "isolated-user-root");
  const tokenRoot = join(userRoot, ".brain");
  const scannerFingerprint = credentialScannerFingerprint(true);
  const policyFingerprint = drivePolicyFingerprint({
    rootFolderIds: ["fixture-root"],
    excludeFileIds: [],
    excludePaths: [],
    excludeNameParts: [],
    privatePrefixes: [],
  }, true);
  const migratedFile = {
    id: "active-migrated", name: "migrated.png", mimeType: "image/png", size: "200",
    createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-20T00:00:00Z",
    md5Checksum: "migrated-current", parents: ["fixture-root"],
  };
  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "USERNAME", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    NO_COLOR: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    HOME: userRoot,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_DRIVE_SKIP_USER_ROOT: userRoot,
    BRAIN_DRIVE_SKIP_EVIDENCE: evidencePath,
    BRAIN_DRIVE_SKIP_MODE: "mixed",
    ADMIN_KEY: "fixture-admin",
  });
  const run = (extra = []) => {
    const result = spawnSync(process.execPath, [
      "--import", DRIVE_ACTIVE_SKIP_FETCH,
      CLI, "ingest", manifestPath, "--from", "drive", ...extra,
    ], { encoding: "utf8", env: environment, timeout: 60_000 });
    assert.equal(result.error, undefined, String(result.error || ""));
    assert.equal(result.signal, null, `Drive active-skip CLI was terminated by ${result.signal}`);
    return {
      code: result.status,
      output: String(`${result.stdout || ""}${result.stderr || ""}`).replace(/\x1b\[[0-9;]*m/g, ""),
    };
  };

  try {
    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, ".brain-admin-key"), "fixture-admin", { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { google_drive: { root_folder_ids: ["fixture-root"] } },
    }));
    writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
      google: {
        client_id: "fixture-client",
        client_secret: null,
        refresh_token: "fixture-refresh",
        scopes: ["drive"],
      },
    }), { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      done: {
        "drive:active-migrated": driveVersion(migratedFile, "Reviewed Root"),
        "drive:active-stale": "prior-stale-version",
        "drive:active-sensitive": "prior-sensitive-version",
        "drive:source-missing": "prior-missing-version",
      },
      skipped: {},
      sync_token: "fixture-prior-cursor",
      drive_policy_fingerprint: policyFingerprint,
      credential_scanner_fingerprint: scannerFingerprint,
      drive_last_full_sweep_at: "2000-01-01T00:00:00.000Z",
    }), { mode: 0o600 });

    const readEvidence = () => JSON.parse(readFileSync(evidencePath, "utf8"));
    // Packet 10: an unchanged daily run reads only the changes feed and
    // removes nothing; the additive --reset pass never removes either.
    const daily = run();
    assert.equal(daily.code, 0, daily.output.slice(-1_200));
    assert.equal(readEvidence().removedFamilies, 0, "an unchanged daily run removed a document");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).sync_token, "fixture-skip-no-change-cursor");

    const additive = run(["--reset"]);
    assert.equal(additive.code, 0, additive.output.slice(-1_200));
    let evidence = readEvidence();
    assert.equal(evidence.ingestBatchWrites, 0, "an adjudicated or locally refused file reached Worker ingest");
    assert.equal(evidence.removedFamilies, 0, "the additive pass removed a document");
    assert.deepEqual(evidence.lastFinalReceipt, {
      status: "error",
      complete_sweep: false,
      walk_complete: true,
      docs_refused: 1,
      docs_failed: 0,
      issue_code: "INPUT_REFUSED",
      detail: null,
    }, "an adjudicated non-text skip inflated the measured credential-refusal count");

    // The one-time cleanup removes the trashed file and the credential-refused
    // file, and keeps the two files the connector simply cannot read.
    const cleanup = run(["--cleanup"]);
    assert.equal(cleanup.code, 0, cleanup.output.slice(-1_200));
    evidence = readEvidence();
    assert.equal(evidence.ingestBatchWrites, 0);
    assert.equal(evidence.retainedFamilyReachedForget, false, "an unchanged adjudicated family was removed");
    assert.equal(evidence.removedFamilies, 2, "cleanup did not remove the trashed and the refused file");
    assert.match(cleanup.output, /1 trashed or not found at Google; 0 outside every root; 0 excluded by the current settings; 1 refused by the credential scanner/);

    environment.BRAIN_DRIVE_SKIP_MODE = "adjudicated-only";
    const adjudicatedAccepted = run(["--reset"]);
    assert.equal(adjudicatedAccepted.code, 0, adjudicatedAccepted.output.slice(-1_200));
    const adjudicatedEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(adjudicatedEvidence.lastFinalReceipt.status, "ready",
      `an adjudicated Drive skip blocked a zero-refusal completed walk:\n${adjudicatedAccepted.output.slice(-1_200)}`);
    assert.equal(adjudicatedEvidence.lastFinalReceipt.docs_refused, 0);
    assert.equal(adjudicatedEvidence.lastFinalReceipt.issue_code, null);
    assert.match(adjudicatedEvidence.lastFinalReceipt.detail || "", /coverage_gaps=0; source_resolved=0; adjudicated_skips=1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/*
 * Retired with packet 10: the 101-family oversized approval, wrong-approval and
 * partial-write retry scenario tested the daily Drive approval gate, which no
 * longer exists. Bulk removal of stored files a walk no longer sees is the
 * one-time --cleanup's job (test/drive-simple-sync.test.mjs).
 */

/*
 * Drive changes are account-wide. Changed files must be re-enumerated through
 * reviewed roots, while removed or omitted stored files need typed metadata
 * evidence before they can enter the deletion plan.
 */
{
  const scannerFingerprint = credentialScannerFingerprint(true);
  const policyFingerprint = drivePolicyFingerprint({
    rootFolderIds: ["root-fixture"],
    excludeFileIds: [],
    excludePaths: [],
    excludeNameParts: [],
    privatePrefixes: [],
  }, true);
  const stripAnsi = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
  const fixedReviewObservationId = "sync_fixture_review_observation";
  const fixedReviewObservedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const expiredReviewObservedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const singularDiagnoseGuidance = renderCliCommands(
    "Run brain diagnose to see the quarantined identity."
  );
  const pluralDiagnoseGuidance = renderCliCommands(
    "Run brain diagnose to see the quarantined identities."
  );
  const win32Rendering = {
    platform: "win32",
    nodePath: process.execPath,
    scriptPath: CLI,
    env: { PATH: "" },
    existsSync: () => false,
  };
  const win32Prefix = brainCliPrefix(win32Rendering);
  assert.notEqual(win32Prefix, "brain", "the win32 Drive guidance seam did not take effect");
  const win32SingularDiagnoseGuidance = renderCliCommands(
    "Run brain diagnose to see the quarantined identity.",
    win32Rendering,
  );
  const win32PluralDiagnoseGuidance = renderCliCommands(
    "Run brain diagnose to see the quarantined identities.",
    win32Rendering,
  );

  const runScopeScenario = (mode, {
    full = false,
    clockAnchor = null,
    pendingRemoval = false,
    priorReview = false,
    priorNotReturnedDays = null,
    priorNotReturnedNamed = true,
    priorObservation = false,
    priorClockSkewHours = 0,
    priorConsistentObservationDays = null,
    priorChangeFeedDays = null,
    priorMaturedDays = null,
    priorApprovalExpired = false,
    localDoneLabels = true,
    inventoryLabels = true,
    inventoryLabelMode = "stored",
    inventoryDate = true,
    inventoryUidFilterMode = "available",
    inventoryRouteMode = "available",
    storedUid = "drive:",
    win32 = false,
    args = [],
  } = {}) => {
    const fixtureNow = () => clockAnchor ?? Date.now();
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), `brain-drive-scope-${mode}-`)));
    const manifestPath = join(directory, "fixture.manifest.json");
    const statePath = join(directory, ".brain-ingest-drive.json");
    const evidencePath = join(directory, "scope-evidence.json");
    const userRoot = join(directory, "isolated-user-root");
    const tokenRoot = join(userRoot, ".brain");
    const priorCursor = `fixture-prior-${mode}`;
    const priorFullSweep = full ? "2000-01-01T00:00:00.000Z" : new Date(fixtureNow()).toISOString();
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    Object.assign(environment, {
      NO_COLOR: "1",
      BRAIN_GOOGLE_TOKEN_STORE: "file",
      HOME: userRoot,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_DRIVE_SCOPE_USER_ROOT: userRoot,
      BRAIN_DRIVE_SCOPE_EVIDENCE: evidencePath,
      BRAIN_DRIVE_SCOPE_MODE: mode,
      ...(clockAnchor === null ? {} : { BRAIN_DRIVE_SCOPE_NOW: String(clockAnchor) }),
      BRAIN_DRIVE_SCOPE_LABELS: inventoryLabels ? inventoryLabelMode : "none",
      BRAIN_DRIVE_SCOPE_DATE: inventoryDate ? "server" : "none",
      BRAIN_DRIVE_SCOPE_UID_FILTER: inventoryUidFilterMode,
      BRAIN_DRIVE_SCOPE_ROUTE_MODE: inventoryRouteMode,
      BRAIN_DRIVE_SCOPE_STORED_UID: storedUid,
      BRAIN_DRIVE_SCOPE_STORED_UID_JSON: JSON.stringify(storedUid),
      ...(win32 ? { BRAIN_DRIVE_SCOPE_WIN32_GUIDANCE: "1" } : {}),
      ADMIN_KEY: "fixture-admin",
    });

    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, ".brain-admin-key"), "fixture-admin", { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { google_drive: { root_folder_ids: ["root-fixture"] } },
    }));
    writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
      google: {
        client_id: "fixture-client",
        client_secret: null,
        refresh_token: "fixture-refresh",
        scopes: ["drive"],
      },
    }), { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      done: {
        ...(localDoneLabels ? {
          "drive:missing-sensitive": JSON.stringify([
            "2026-09-02T00:00:00Z",
            "restored-version",
            mode === "incremental-restored" ? "Restored fixture.txt" : "Owner tax return.txt",
            "text/plain",
            mode === "incremental-restored" ? "Reviewed Root" : "Reviewed Root/Tax",
          ]),
        } : {}),
        ...(["full-malformed", "full-unresolved-subthreshold", "incremental-stale-marker-404", "incremental-stale-marker-live", "incremental-review-empty"].includes(mode)
          ? Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
              const suffix = String(index).padStart(2, "0");
              return [`drive:retained-${suffix}`, JSON.stringify([
                "2026-09-02T00:00:00Z",
                `retained-version-${suffix}`,
                `Retained ${suffix}.txt`,
                "text/plain",
                "Reviewed Root",
              ])];
            }))
          : {}),
      },
      skipped: {},
      sync_token: priorCursor,
      drive_policy_fingerprint: policyFingerprint,
      credential_scanner_fingerprint: scannerFingerprint,
      drive_last_full_sweep_at: priorFullSweep,
      drive_folders: {
        "root-fixture": { name: "Reviewed Root", parents: [] },
      },
      removed: pendingRemoval ? { "drive:missing-sensitive": "2026-09-01T00:00:00.000Z" } : {},
      ...(Number.isFinite(priorMaturedDays) ? (() => {
        const firstObservedAt = new Date(fixtureNow() - (priorMaturedDays * 24 * 60 * 60 * 1000));
        return {
          drive_removal_review: {
            schema_version: 5,
            issue_code: "SAFETY_REVIEW_REQUIRED",
            counts: {
              unresolved_absences: 0,
              unresolved_access: 0,
              unresolved_not_returned: 0,
              pending_source_deletions: 1,
            },
            uids: ["drive:missing-sensitive"],
            unresolved_access_uids: [],
            unresolved_not_returned: [],
            source_deletion_candidates: [{
              uid: "drive:missing-sensitive",
              first_observed_at: firstObservedAt.toISOString(),
              last_observed_at: firstObservedAt.toISOString(),
              grace_eligible_at: new Date(firstObservedAt.getTime() + (7 * 24 * 60 * 60 * 1000)).toISOString(),
              observation_count: 2,
              name: "Owner tax return.txt",
              folder_path: "Reviewed Root/Tax",
              corroboration: "repeated_not_returned",
              approval_observation_id: fixedReviewObservationId,
              approval_observed_at: priorApprovalExpired ? expiredReviewObservedAt : fixedReviewObservedAt,
              observations: [
                {
                  run_id: "sync_fixture_first_observation",
                  observed_at: firstObservedAt.toISOString(),
                  server_observed_at: firstObservedAt.toISOString(),
                },
                {
                  run_id: fixedReviewObservationId,
                  observed_at: priorApprovalExpired ? expiredReviewObservedAt : fixedReviewObservedAt,
                  server_observed_at: priorApprovalExpired ? expiredReviewObservedAt : fixedReviewObservedAt,
                },
              ],
            }],
          },
        };
      })() : Number.isFinite(priorChangeFeedDays) ? (() => {
        const firstObservedAt = new Date(fixtureNow() - (priorChangeFeedDays * 24 * 60 * 60 * 1000));
        return {
          drive_removal_review: {
            schema_version: 3,
            issue_code: "SAFETY_REVIEW_REQUIRED",
            counts: {
              unresolved_absences: 0,
              unresolved_access: 0,
              unresolved_not_returned: 0,
              pending_source_deletions: 1,
            },
            uids: ["drive:missing-sensitive"],
            unresolved_access_uids: [],
            unresolved_not_returned: [],
            source_deletion_candidates: [{
              uid: "drive:missing-sensitive",
              first_observed_at: firstObservedAt.toISOString(),
              last_observed_at: firstObservedAt.toISOString(),
              grace_eligible_at: new Date(firstObservedAt.getTime() + (7 * 24 * 60 * 60 * 1000)).toISOString(),
              observation_count: 1,
              ...(priorObservation ? {
                observations: [{
                  run_id: "sync_fixture_prior_observation",
                  observed_at: new Date(firstObservedAt.getTime() + priorClockSkewHours * 60 * 60 * 1000).toISOString(),
                  server_observed_at: firstObservedAt.toISOString(),
                }],
              } : {}),
              corroboration: "change_feed_removed",
            }],
          },
        };
      })() : priorReview ? {
        drive_removal_review: {
          schema_version: 1,
          issue_code: "SAFETY_REVIEW_REQUIRED",
          counts: { unresolved_absences: 1 },
          uids: ["drive:missing-sensitive"],
        },
      } : Number.isFinite(priorNotReturnedDays) ? (() => {
        const firstObservedAt = new Date(fixtureNow() - (priorNotReturnedDays * 24 * 60 * 60 * 1000));
        return {
          drive_removal_review: {
            schema_version: 3,
            issue_code: "SAFETY_REVIEW_REQUIRED",
            counts: {
              unresolved_absences: 1,
              unresolved_access: 0,
              unresolved_not_returned: 1,
              pending_source_deletions: 0,
            },
            uids: ["drive:missing-sensitive"],
            unresolved_access_uids: [],
            unresolved_not_returned: [{
              uid: "drive:missing-sensitive",
              first_observed_at: firstObservedAt.toISOString(),
              last_observed_at: firstObservedAt.toISOString(),
              grace_eligible_at: new Date(firstObservedAt.getTime() + (7 * 24 * 60 * 60 * 1000)).toISOString(),
              observation_count: 1,
              ...(priorObservation ? {
                observations: [{
                  run_id: "sync_fixture_prior_observation",
                  observed_at: new Date(firstObservedAt.getTime() + priorClockSkewHours * 60 * 60 * 1000).toISOString(),
                  server_observed_at: firstObservedAt.toISOString(),
                }, ...(Number.isFinite(priorConsistentObservationDays) ? [{
                  run_id: "sync_fixture_later_consistent_observation",
                  observed_at: new Date(fixtureNow() - priorConsistentObservationDays * 24 * 60 * 60 * 1000).toISOString(),
                  server_observed_at: new Date(fixtureNow() - priorConsistentObservationDays * 24 * 60 * 60 * 1000).toISOString(),
                }] : [])],
              } : {}),
              ...(priorNotReturnedNamed ? {
                name: "Owner tax return.txt",
                folder_path: "Reviewed Root/Tax",
              } : {}),
            }],
            source_deletion_candidates: [],
          },
        };
      })() : {}),
    }), { mode: 0o600 });

    const initialStateBytes = readFileSync(statePath, "utf8");
    const win32Preload = join(directory, "win32-platform.mjs");
    if (win32) {
      writeFileSync(win32Preload,
        'globalThis.__enableWin32Guidance = () => Object.defineProperty(process, "platform", ' +
          '{ value: "win32", configurable: true });\n',
        { mode: 0o600 });
    }
    const executeDirect = (runArgs = []) => {
      const result = spawnSync(process.execPath, [
        ...(win32 ? ["--import", pathToFileURL(win32Preload).href] : []),
        "--import", DRIVE_SCOPE_FETCH,
        CLI, "ingest", manifestPath, "--from", "drive",
        ...runArgs,
      ], { encoding: "utf8", env: environment, timeout: 30_000 });
      assert.equal(result.error, undefined, String(result.error || ""));
      assert.equal(result.signal, null, `Drive scope CLI was terminated by ${result.signal}`);
      return {
        code: result.status,
        output: stripAnsi(`${result.stdout || ""}${result.stderr || ""}`),
      };
    };
    const execute = (runArgs = []) => {
      const approvalIndex = runArgs.indexOf("--approve-removals");
      if (approvalIndex < 0 || runArgs.includes("--apply-removals")) return executeDirect(runArgs);
      let plan = JSON.parse(readFileSync(statePath, "utf8")).ingest_removal_plan;
      let stopped;
      if (!plan) { stopped = executeDirect(runArgs); plan = JSON.parse(readFileSync(statePath, "utf8")).ingest_removal_plan; }
      if (!plan || plan.sourcePlan.fingerprint !== runArgs[approvalIndex + 1]) return stopped || executeDirect(runArgs);
      const applied = executeDirect(["--source", "drive", "--apply-removals", plan.fingerprint,
        "--approve-removals", runArgs[approvalIndex + 1]]);
      if (applied.code !== 0) return applied;
      return executeDirect();
    };
    const result = execute(args);
    return {
      code: result.code,
      output: result.output,
      priorCursor,
      priorFullSweep,
      initialStateBytes,
      stateBytes: () => readFileSync(statePath, "utf8"),
      state: () => JSON.parse(readFileSync(statePath, "utf8")),
      writeState: (nextState) => writeFileSync(statePath, JSON.stringify(nextState), { mode: 0o600 }),
      evidence: () => JSON.parse(readFileSync(evidencePath, "utf8")),
      rerun: (runArgs = []) => execute(runArgs),
      apply: () => {
        const plan = JSON.parse(readFileSync(statePath, "utf8")).ingest_removal_plan;
        assert.ok(plan && plan.targets.length > 0, "exact apply control needs a nonempty saved plan");
        const applied = executeDirect(["--source", "drive", "--apply-removals", plan.fingerprint,
          ...(plan.sourcePlan.tooLarge || plan.requireSourceApproval ? ["--approve-removals", plan.sourcePlan.fingerprint] : [])]);
        assert.equal(applied.code, 0, applied.output);
        return executeDirect();
      },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  };

  // Packet 10: an out-of-root change is read from the feed alone. Nothing is
  // walked, downloaded, sent or removed, and the cursor advances.
  const changedOutside = runScopeScenario("changed-outside");
  try {
    assert.equal(changedOutside.code, 0, changedOutside.output);
    const evidence = changedOutside.evidence();
    assert.equal(evidence.changesReads, 1);
    assert.equal(evidence.rootedWalks, 0, "the daily path must not re-walk the roots");
    assert.equal(evidence.outsideContentReads, 0, "an out-of-root changed file reached the content boundary");
    assert.equal(evidence.ingestBatchWrites, 0, "an out-of-root changed file reached ingest");
    assert.equal(evidence.forgetRequests, 0);
    const state = changedOutside.state();
    assert.equal(state.sync_token, "fixture-next-changed-outside");
  } finally {
    changedOutside.cleanup();
  }

  // The daily approval gate for trashed and moved-out files is retired
  // (packet 10). A removed file in the feed loses its stored document in the
  // same run, through the Worker's preview then apply route.
  for (const mode of ["incremental-trash", "incremental-left-scope"]) {
    const confirmed = runScopeScenario(mode);
    try {
      assert.equal(confirmed.code, 0, confirmed.output);
      const evidence = confirmed.evidence();
      assert.equal(evidence.rootedWalks, 0, `${mode} unexpectedly required a full walk`);
      assert.equal(evidence.forgetRequests, 1, `${mode} did not remove the stored file at once`);
      assert.equal(evidence.removedFamilies, 1);
      assert.equal(evidence.planApplies, 1);
      assert.equal(evidence.ingestBatchWrites, 0);
      assert.doesNotMatch(confirmed.output, /--apply-removals|--approve-removals/);
      const state = confirmed.state();
      assert.equal(state.ingest_removal_plan, undefined, "no removal plan is saved");
      assert.equal(state.sync_token, `fixture-next-${mode}`);
    } finally {
      confirmed.cleanup();
    }
  }
}

/* CLI wiring keeps the aggregate approval guard ahead of every planned deletion. */
assert.ok(VALUE_FLAGS.has("approve-removals"), "a bare --approve-removals must be rejected as a missing value");
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");
const remoteStart = source.indexOf("async function cmdIngestRemote(");
const remoteEnd = source.indexOf("\nasync function ", remoteStart + 1);
assert.notEqual(remoteStart, -1, "cmdIngestRemote must exist");
const remote = source.slice(remoteStart, remoteEnd === -1 ? source.length : remoteEnd);
assert.equal(remote.includes("Drive removal plan retained a protected review item"), false,
  "the Drive lane must not advertise an unreachable post-construction invariant");
assert.equal(remote.includes("unclassifiedPendingDriveUids"), false,
  "the Drive lane must not retain an unreachable shadow classification guard");
const consumeStart = remote.indexOf("const consumeGroup = async (group) => {");
const consumeEnd = remote.indexOf("\n  try {\n  if (!dry)", consumeStart);
assert.ok(consumeStart !== -1 && consumeEnd > consumeStart, "remote group consumer must be inspectable");
const consumeGroup = remote.slice(consumeStart, consumeEnd);
assert.doesNotMatch(
  consumeGroup,
  /outcome\.incomplete[\s\S]{0,240}keep_doc_uids:\s*\[\]/,
  "an incomplete remote family must never be immediately reconciled to empty",
);
assert.doesNotMatch(
  consumeGroup,
  /catch \(error\)[\s\S]{0,500}keep_doc_uids:\s*\[\]/,
  "a thrown remote batch must preserve the prior family for retry",
);

const buildMatch = /const\s+([A-Za-z_$][\w$]*)\s*=\s*buildDriveRemovalPlan\s*\(\s*\{/.exec(remote);
assert.ok(buildMatch, "Drive ingest must build one aggregate removal plan");
const planName = buildMatch[1];
const buildIndex = buildMatch.index;
const boundaryIndex = remote.indexOf("await removalReview.finish({", buildIndex);
const cursorPlanIndex = remote.indexOf("pendingCursor = {", boundaryIndex);
assert.ok(boundaryIndex > buildIndex, "Drive source removal must enter the saved-plan boundary");
assert.ok(cursorPlanIndex > boundaryIndex, "a removal stop must withhold the source cursor");
assert.match(remote.slice(boundaryIndex, cursorPlanIndex), /sourcePlan: driveRemovalPlan/);
const buildCall = remote.slice(buildIndex, boundaryIndex);
for (const field of ["storedFamilies", "activeFamilies", "policyCandidates", "vanishedCandidates", "intentionalCandidates"]) {
  assert.match(buildCall, new RegExp(`\\b${field}\\b`), `aggregate Drive removal plan is missing ${field}`);
}
assert.doesNotMatch(remote, /reconcilePreparedFamilies\(/,
  "remote obsolete-family cleanup must not bypass the separate decision");
assert.match(remote, /removalReview\.remember\(outcome\.completed\)/,
  "accepted families must retain their review checkpoint");
const boundarySource = readFileSync(new URL("../operations/ingest-removal-plan.mjs", import.meta.url), "utf8");
const approvalIndex = boundarySource.indexOf("assertDriveRemovalPlanSafe(plan.sourcePlan");
const applyIndex = boundarySource.indexOf('action: "apply"');
assert.ok(approvalIndex > 0 && applyIndex > approvalIndex,
  "the additional aggregate guard must run before any approved deletion");
assert.match(boundarySource.slice(applyIndex), /preview\(plan\.families, marker\)/,
  "an exact readback must prove absence after the approved deletions");

const outerCatchIndex = remote.lastIndexOf("} catch (error) {");
assert.notEqual(outerCatchIndex, -1, "cmdIngestRemote must keep its outer failure receipt path");
const outerCatch = remote.slice(outerCatchIndex);
if (/flushIntentionalRemovals/.test(outerCatch)) {
  assert.match(
    outerCatch,
    /if\s*\(\s*which\s*===\s*"imap"[^)]*\)\s*\{[\s\S]*?flushIntentionalRemovals/,
    "Drive and Gmail failure cleanup must not bypass their aggregate guards by deleting intentional skips",
  );
}

/* Watched-folder deletion uses the same authenticated truth and readback. */
const localStart = source.indexOf("export async function cmdIngestLocal(");
const localEnd = source.indexOf("\nexport function validateForgetReceipt", localStart);
assert.notEqual(localStart, -1, "local folder ingest must exist");
assert.ok(localEnd > localStart, "local folder ingest must be inspectable");
const local = source.slice(localStart, localEnd);
const pendingIndex = local.indexOf("const pendingLocalUids");
assert.match(
  local,
  /const listPreparedSourceFamilies = options\.listStoredSourceFamilies \?\? listStoredSourceFamilies;/,
  "the local injectable inventory seam must default to the production operation",
);
const localInventoryIndex = local.indexOf("const storedLocalFamilies = await listPreparedSourceFamilies", pendingIndex);
const localBuildIndex = local.indexOf("const localRemovalPlan = buildDriveRemovalPlan", localInventoryIndex);
const localBoundaryIndex = local.indexOf("await removalReview.finish({ sourcePlan: localRemovalPlan", localBuildIndex);
assert.ok(
  pendingIndex !== -1 && localInventoryIndex > pendingIndex && localBuildIndex > localInventoryIndex,
  "local removal retries must re-enter a plan built from authenticated stored families",
);
assert.doesNotMatch(local.slice(pendingIndex, localBuildIndex), /applyDriveRemovals\s*\(/,
  "a pending local removal must not bypass the current authenticated plan");
assert.match(local.slice(localBuildIndex, localBoundaryIndex), /storedFamilies:\s*storedLocalFamilies/,
  "local deletion must not use the resume file as its stored-family denominator");
assert.ok(localBoundaryIndex > localBuildIndex,
  "local source removals must enter the separate saved-plan decision");
assert.doesNotMatch(local, /reconcilePreparedFamilies\(/,
  "local replacement cleanup must not bypass the separate decision");
assert.match(local, /removalReview\.remember\(outcome\.completed\)/);

console.log("drive removal guard: all focused tests passed");
