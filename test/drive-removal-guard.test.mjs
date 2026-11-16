import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";
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
// The legacy source_deleted category carries no item-specific deletion evidence.
assert.equal(approvalPlan.targetCauses[rawUids.source_deleted], "unknown");
assert.ok(reportsCount(refusal, "source[_\\s-]*removal", 1), refusal);
assert.doesNotMatch(refusal, /\bdelet(?:ed|ion)\b/i);
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

/* The reviewed Drive entry keeps full-walk review read-only. Re-pin the three
 * CLI blocks below to that boundary: old flags and saved candidates cannot
 * authorize a mutating walk. Exact-apply safety remains covered independently
 * by the plan tests above and the authenticated apply/readback checks below. */
function readOnlyDriveScenario({ preload, prefix, mode = null, root = "fixture-root", done = {}, extra = [], previewEnabled = true }) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-read-only-")));
  const userRoot = join(directory, "home");
  const statePath = join(directory, ".brain-ingest-drive.json");
  const manifestPath = join(directory, "fixture.manifest.json");
  const auditPath = join(directory, "audit.json");
  const evidencePath = join(directory, "evidence.json");
  mkdirSync(join(userRoot, ".brain"), { recursive: true, mode: 0o700 });
  writeFileSync(join(userRoot, "launchctl-fixture"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(directory, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(join(userRoot, ".brain/google-tokens.json"), JSON.stringify({ google: {
    client_id: "fixture-client", client_secret: null, refresh_token: randomBytes(32).toString("hex"), scopes: ["drive"],
  } }), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: { google_drive: { root_folder_ids: [root] } },
  }));
  writeFileSync(statePath, JSON.stringify({ version: 1, done, skipped: {}, sync_token: "fixture-prior-cursor",
    drive_last_full_sweep_at: "2000-01-01T00:00:00.000Z",
    drive_policy_fingerprint: drivePolicyFingerprint({ rootFolderIds: [root], excludeFileIds: [],
      excludePaths: [], excludeNameParts: [], privatePrefixes: [] }, true),
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
  }), { mode: 0o600 });
  const before = readFileSync(statePath, "utf8");
  const environment = cliTestEnvironment(userRoot, {
    NO_COLOR: "1", BRAIN_GOOGLE_TOKEN_STORE: "file", BRAIN_DRIVE_READ_ONLY_AUDIT: auditPath,
    BRAIN_TEST_LAUNCHCTL: join(userRoot, "launchctl-fixture"),
    [`${prefix}_USER_ROOT`]: userRoot, [`${prefix}_EVIDENCE`]: evidencePath,
    ...(mode ? { [`${prefix}_MODE`]: mode } : {}),
    ...(prefix === "BRAIN_DRIVE_SCOPE" ? { BRAIN_DRIVE_SCOPE_STORED_UID: "drive:fixture-item",
      BRAIN_DRIVE_SCOPE_NOW: String(Date.parse("2026-11-01T12:00:00Z")) } : {}),
  });
  const run = args => {
    if (process.env.BRAIN_LANE_NODE_WAIT) {
      const quiet = spawnSync("/bin/sh", ["-c", process.env.BRAIN_LANE_NODE_WAIT], { encoding: "utf8" });
      assert.equal(quiet.status, 0);
    }
    const child = spawnSync(process.execPath, ["--import", new URL("./fixtures/drive-read-only-audit.mjs", import.meta.url).href,
      "--import", preload, CLI, "ingest", manifestPath, "--from", "drive", "--full-walk-review", ...args],
    { encoding: "utf8", env: environment, timeout: 60_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    return { code: child.status, output: `${child.stdout}${child.stderr}`.replace(/\x1b\[[0-9;]*m/g, ""),
      calls: JSON.parse(readFileSync(auditPath, "utf8")) };
  };
  try {
    const refused = run(extra);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /Drive full-walk review is read-only/, "the intended entry decision was reached");
    assert.deepEqual(refused.calls, { reads: 0, writes: 0 }, "refusal precedes credentials and transport");
    assert.equal(readFileSync(statePath, "utf8"), before, "refusal preserves exact state and cursor");
    if (!previewEnabled) return refused.output;
    const preview = run(["--dry-run"]);
    assert.equal(preview.code, 0, `${mode || prefix}: ${preview.output}`);
    assert.ok(preview.calls.reads > 0, "the green dry-run reached the simulated provider");
    assert.equal(preview.calls.writes, 0, "a dry-run cannot write receipts, ingest or forget");
    assert.doesNotMatch(preview.output, /drive:guard-family-/, "the preview cannot expose raw stored family IDs");
    assert.equal(readFileSync(statePath, "utf8"), before, "preview preserves exact state and cursor");
    assert.doesNotMatch(preview.output, /--apply-removals|--approve-removals/, "a read-only walk cannot mint deletion authority");
    return preview.output;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// Block 1: both adjudicated and mixed skips remain a read-only preview.
{
  for (const mode of ["mixed", "adjudicated-only"]) {
    const output = readOnlyDriveScenario({ preload: DRIVE_ACTIVE_SKIP_FETCH, prefix: "BRAIN_DRIVE_SKIP", mode,
      done: { "drive:active-migrated": "prior", "drive:active-stale": "prior", "drive:active-sensitive": "prior" } });
    assert.match(output, /dry run, nothing was sent/i);
    if (mode === "mixed") assert.match(output, /WOULD be removed/i, "a populated skip reached the removal preview");
  }
}

// Block 2: the old 101-family fixture and an approval flag cannot reopen the
// mutating full-walk entry. Preview intentionally does not inventory D1.
{
  const output = readOnlyDriveScenario({ preload: DRIVE_GUARD_FETCH, prefix: "BRAIN_DRIVE_GUARD", root: "root-fixture",
    extra: ["--approve-removals", "a".repeat(64)] });
  assert.match(output, /full walk of 1 reviewed Drive root/, "the dry-run walked the reviewed root");
  assert.match(output, /dry run, nothing was sent/i);
}

// Block 3: scope and absence variants hit the same refusal before transport.
// The populated skip preview above and the rooted full-unresolved peer below
// are green controls; other modes stop before a provider read is possible.
{
  for (const mode of ["changed-outside", "full-malformed", "full-label-bounds", "full-page-boundary",
    "full-structured-page-rejection", "full-control-cursor-v048", "full-identity", "full-unresolved",
    "full-unresolved-subthreshold", "incremental-unresolved", "incremental-page-boundary",
    "incremental-structured-page-rejection", "incremental-identity", "incremental-unresolved-batch",
    "incremental-gone", "incremental-restored", "incremental-trash", "incremental-left-scope",
    "incremental-stale-marker-404", "incremental-stale-marker-live", "incremental-review-empty", "incremental-transient-batch"]) {
    readOnlyDriveScenario({ preload: DRIVE_SCOPE_FETCH, prefix: "BRAIN_DRIVE_SCOPE", mode, root: "root-fixture",
      previewEnabled: mode === "full-unresolved" });
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
assert.match(remote, /removalReview\.remember\(which === "gmail"\s+\? outcome\.completed\.filter\(gmailNeedsFamilyReconciliation\) : outcome\.completed\)/,
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
