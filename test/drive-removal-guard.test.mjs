import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
  const directory = mkdtempSync(join(tmpdir(), "brain-drive-active-skips-"));
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

    const review = run();
    assert.equal(review.code, 1, review.output.slice(-1_200));
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(review.output)?.[1] || null;
    assert.ok(approval, `Drive active-skip review omitted its exact approval:\n${review.output.slice(-1_200)}`);

    const accepted = run(["--approve-removals", approval]);
    assert.equal(accepted.code, 0, accepted.output.slice(-1_200));
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.ingestBatchWrites, 0, "an adjudicated or locally refused file reached Worker ingest");
    assert.equal(evidence.retainedFamilyReachedForget, false, "an unchanged adjudicated family was removed");
    assert.equal(evidence.removedFamilies, 3, "the approved typed removals did not converge");
    assert.deepEqual(evidence.lastFinalReceipt, {
      status: "error",
      complete_sweep: false,
      walk_complete: true,
      docs_refused: 1,
      docs_failed: 0,
      issue_code: "INPUT_REFUSED",
      detail: null,
    }, "an adjudicated non-text skip inflated the measured credential-refusal count");

    environment.BRAIN_DRIVE_SKIP_MODE = "adjudicated-only";
    const adjudicatedReview = run(["--reset"]);
    assert.equal(adjudicatedReview.code, 1, adjudicatedReview.output.slice(-1_200));
    const adjudicatedApproval = /--approve-removals ([0-9a-f]{64})/.exec(adjudicatedReview.output)?.[1] || null;
    assert.ok(adjudicatedApproval,
      `Drive adjudicated-only review omitted its exact approval:\n${adjudicatedReview.output.slice(-1_200)}`);
    const adjudicatedAccepted = run(["--reset", "--approve-removals", adjudicatedApproval]);
    assert.equal(adjudicatedAccepted.code, 0, adjudicatedAccepted.output.slice(-1_200));
    const adjudicatedEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.deepEqual(adjudicatedEvidence.lastFinalReceipt, {
      status: "ready",
      complete_sweep: true,
      walk_complete: true,
      docs_refused: 0,
      docs_failed: 0,
      issue_code: null,
      detail: "drive sweep sync completed; skipped=1; policy_skipped=0; coverage_gaps=0; source_resolved=0; adjudicated_skips=1",
    }, `an adjudicated Drive skip blocked a zero-refusal completed walk:\n${adjudicatedAccepted.output.slice(-1_200)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/*
 * The real CLI path must preserve that ordering across process boundaries.
 * This fixture runs a due full sweep against 101 simulated stored families and
 * an empty Drive listing. It also injects one bounded forget failure so the
 * partial-write retry has to build and approve a fresh aggregate plan.
 */
{
  const directory = mkdtempSync(join(tmpdir(), "brain-drive-removal-guard-"));
  const manifestPath = join(directory, "fixture.manifest.json");
  const statePath = join(directory, ".brain-ingest-drive.json");
  const evidencePath = join(directory, "guard-evidence.json");
  const userRoot = join(directory, "isolated-user-root");
  const tokenRoot = join(userRoot, ".brain");
  const priorCursor = "fixture-prior-cursor";
  const priorFullSweep = "2000-01-01T00:00:00.000Z";
  const scannerFingerprint = credentialScannerFingerprint(true);
  const policyFingerprint = drivePolicyFingerprint({
    // Must match the manifest below: reviewed roots are part of the policy
    // identity now, so a fingerprint computed without them is a different one.
    rootFolderIds: ["root-fixture"],
    excludeFileIds: [],
    excludePaths: [],
    excludeNameParts: [],
    privatePrefixes: [],
  }, true);

  const stripAnsi = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
  const safeDiagnostic = (value) => stripAnsi(value)
    .replace(/drive:guard-family-[0-9]+/g, "[redacted-family]")
    .slice(-1_200);
  const assertNoFamilyLeak = (output) => {
    assert.equal(
      String(output).includes("drive:guard-family-"),
      false,
      "Drive guard CLI output exposed a document-family identifier",
    );
  };
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const readEvidence = () => JSON.parse(readFileSync(evidencePath, "utf8"));
  const assertCursorWithheld = () => {
    const state = readState();
    assert.equal(state.sync_token, priorCursor, "a stopped Drive run advanced its sync token");
    assert.equal(state.drive_policy_fingerprint, policyFingerprint, "a stopped Drive run changed its policy fingerprint");
    assert.equal(
      state.credential_scanner_fingerprint,
      scannerFingerprint,
      "a stopped Drive run changed its scanner fingerprint",
    );
    assert.equal(state.drive_last_full_sweep_at, priorFullSweep, "a stopped Drive run completed its full-sweep checkpoint");
    return state;
  };
  const approvalFrom = (output) => {
    const match = /--approve-removals ([0-9a-f]{64})/.exec(output);
    assert.ok(match, `stopped Drive run did not print an approval fingerprint:\n${safeDiagnostic(output)}`);
    return match[1];
  };

  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    NO_COLOR: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    BRAIN_DRIVE_GUARD_USER_ROOT: userRoot,
    BRAIN_DRIVE_GUARD_EVIDENCE: evidencePath,
    ADMIN_KEY: "fixture-admin",
  });

  const run = (extra = []) => {
    const result = spawnSync(process.execPath, [
      "--import", DRIVE_GUARD_FETCH,
      CLI, "ingest", manifestPath, "--from", "drive", ...extra,
    ], { encoding: "utf8", env: environment, timeout: 60_000 });
    assert.equal(result.error, undefined, String(result.error || ""));
    assert.equal(result.signal, null, `Drive guard CLI was terminated by ${result.signal}`);
    return { code: result.status, output: stripAnsi(`${result.stdout || ""}${result.stderr || ""}`) };
  };

  try {
    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
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
      done: {},
      skipped: {},
      sync_token: priorCursor,
      drive_policy_fingerprint: policyFingerprint,
      credential_scanner_fingerprint: scannerFingerprint,
      drive_last_full_sweep_at: priorFullSweep,
    }), { mode: 0o600 });

    const stopped = run();
    assert.equal(stopped.code, 1, safeDiagnostic(stopped.output));
    assertNoFamilyLeak(stopped.output);
    assert.match(stopped.output, /review required/i);
    assert.doesNotMatch(stopped.output, /unexpected error|This is a bug in the installer/i);
    const initialApproval = approvalFrom(stopped.output);
    const supportBytes = previewSupportJournal({ root: userRoot });
    const supportEvents = supportBytes.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(supportEvents.length, 1, supportBytes);
    assert.equal(supportEvents[0].command, "ingest");
    assert.equal(supportEvents[0].source, "drive");
    assert.equal(supportEvents[0].error_code, "SAFETY_REVIEW_REQUIRED");
    assert.deepEqual(Object.keys(supportEvents[0]), [
      "schema_version", "event_id", "timestamp", "product_version", "platform",
      "arch", "node_major", "command", "source", "error_code", "fingerprint",
    ]);
    assertNoFamilyLeak(supportBytes);
    assert.equal(supportBytes.includes(initialApproval), false, "support note retained the removal approval fingerprint");
    assertCursorWithheld();
    let evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 0, "an unapproved plan reached the forget route");
    assert.equal(evidence.removalRequests, 0, "an unapproved plan made a removal write");
    assert.equal(evidence.reconciliationRequests, 0, "an unapproved plan made a reconciliation write");
    assert.equal(evidence.ingestBatchWrites, 0, "the empty Drive walk unexpectedly wrote an ingest batch");
    assert.deepEqual(evidence.lastErrorReceipt, {
      issue_code: "SAFETY_REVIEW_REQUIRED",
      has_error: false,
      has_detail: false,
    }, "the real Drive catch did not preserve the safety stop as a private-text-free review receipt");

    const wrongApproval = `${initialApproval.slice(0, -1)}${initialApproval.endsWith("0") ? "1" : "0"}`;
    const wrong = run(["--approve-removals", wrongApproval]);
    assert.equal(wrong.code, 1, safeDiagnostic(wrong.output));
    assertNoFamilyLeak(wrong.output);
    assert.equal(approvalFrom(wrong.output), initialApproval, "a wrong approval changed an otherwise identical plan");
    assertCursorWithheld();
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 0, "a wrong fingerprint reached the forget route");
    assert.equal(evidence.removalRequests, 0, "a wrong fingerprint made a removal write");
    assert.equal(evidence.reconciliationRequests, 0, "a wrong fingerprint made a reconciliation write");

    // The first exact approval is valid, but its first bounded deletion gets a
    // synthetic 503. Later groups succeed, creating the mixed-write state that
    // must remain cursor-safe and retry through the aggregate guard.
    const interrupted = run(["--approve-removals", initialApproval]);
    assert.equal(interrupted.code, 1, safeDiagnostic(interrupted.output));
    assertNoFamilyLeak(interrupted.output);
    assert.match(interrupted.output, /source cursor was not advanced/i);
    const interruptedState = assertCursorWithheld();
    assert.equal(Object.keys(interruptedState.removed || {}).length, 50, "failed removals were not retained for retry");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 3, "the approved plan did not use bounded removal groups");
    assert.equal(evidence.removalRequests, 3, "approved deletion calls were not classified as removals");
    assert.equal(evidence.reconciliationRequests, 0, "the removal path performed an unrelated reconciliation");
    assert.equal(evidence.successfulRemovalFamilies, 51, "successful partial removals were not preserved");
    assert.equal(evidence.failedRemovalFamilies, 50, "the failed bounded group was not recorded by the fixture");

    const retryStopped = run();
    assert.equal(retryStopped.code, 1, safeDiagnostic(retryStopped.output));
    assertNoFamilyLeak(retryStopped.output);
    const retryApproval = approvalFrom(retryStopped.output);
    assert.notEqual(retryApproval, initialApproval, "partial writes did not produce a fresh exact-plan fingerprint");
    const retryState = assertCursorWithheld();
    assert.equal(Object.keys(retryState.removed || {}).length, 50, "a guarded retry discarded pending removals");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 3, "a failed removal retry bypassed the approval guard");
    assert.equal(evidence.reconciliationRequests, 0, "a failed removal retry bypassed the guard through reconciliation");

    const completed = run(["--approve-removals", retryApproval]);
    assert.equal(completed.code, 0, safeDiagnostic(completed.output));
    assertNoFamilyLeak(completed.output);
    const completedState = readState();
    assert.equal(completedState.sync_token, "fixture-next-cursor", "exact retry approval did not advance the Drive cursor");
    assert.equal(completedState.drive_policy_fingerprint, policyFingerprint);
    assert.equal(completedState.credential_scanner_fingerprint, scannerFingerprint);
    assert.notEqual(completedState.drive_last_full_sweep_at, priorFullSweep, "successful cleanup did not complete the full sweep");
    assert.ok(Number.isFinite(Date.parse(completedState.drive_last_full_sweep_at)), "full-sweep checkpoint is not an ISO date");
    assert.equal(Object.keys(completedState.removed || {}).length, 0, "successful cleanup left pending removal markers");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 4, "exact retry approval did not perform the remaining bounded deletion");
    assert.equal(evidence.removalRequests, 4);
    assert.equal(evidence.reconciliationRequests, 0);
    assert.equal(evidence.successfulRemovalFamilies, 101, "exact approvals did not delete the complete oversized plan");
    assert.equal(evidence.ingestBatchWrites, 0);
    assert.equal(evidence.receipts.ready, 1, "only the completed run should close as ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
    const directory = mkdtempSync(join(tmpdir(), `brain-drive-scope-${mode}-`));
    const manifestPath = join(directory, "fixture.manifest.json");
    const statePath = join(directory, ".brain-ingest-drive.json");
    const evidencePath = join(directory, "scope-evidence.json");
    const userRoot = join(directory, "isolated-user-root");
    const tokenRoot = join(userRoot, ".brain");
    const priorCursor = `fixture-prior-${mode}`;
    const priorFullSweep = full ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    Object.assign(environment, {
      NO_COLOR: "1",
      BRAIN_GOOGLE_TOKEN_STORE: "file",
      BRAIN_DRIVE_SCOPE_USER_ROOT: userRoot,
      BRAIN_DRIVE_SCOPE_EVIDENCE: evidencePath,
      BRAIN_DRIVE_SCOPE_MODE: mode,
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
        const firstObservedAt = new Date(Date.now() - (priorMaturedDays * 24 * 60 * 60 * 1000));
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
        const firstObservedAt = new Date(Date.now() - (priorChangeFeedDays * 24 * 60 * 60 * 1000));
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
        const firstObservedAt = new Date(Date.now() - (priorNotReturnedDays * 24 * 60 * 60 * 1000));
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
                  observed_at: new Date(Date.now() - priorConsistentObservationDays * 24 * 60 * 60 * 1000).toISOString(),
                  server_observed_at: new Date(Date.now() - priorConsistentObservationDays * 24 * 60 * 60 * 1000).toISOString(),
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
    const execute = (runArgs = []) => {
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
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  };

  const changedOutside = runScopeScenario("changed-outside");
  try {
    assert.equal(changedOutside.code, 0, changedOutside.output);
    assert.match(changedOutside.output, /rooted full comparison before reading content/i);
    const evidence = changedOutside.evidence();
    assert.equal(evidence.changesReads, 1);
    assert.equal(evidence.rootedWalks, 1, "an account-wide changed item did not trigger a rooted walk");
    assert.equal(evidence.outsideContentReads, 0, "an out-of-root changed file reached the content boundary");
    assert.equal(evidence.ingestBatchWrites, 0, "an out-of-root changed file reached ingest");
    assert.equal(evidence.forgetRequests, 0);
    assert.equal(evidence.inventoryLabelReads, 0,
      "a candidate-free sweep requested stored names or folders");
    const state = changedOutside.state();
    assert.equal(state.sync_token, "fixture-next-changed-outside");
    assert.notEqual(state.drive_last_full_sweep_at, changedOutside.priorFullSweep);
  } finally {
    changedOutside.cleanup();
  }

  for (const [mode, full] of [["full-unresolved", true], ["incremental-unresolved", false]]) {
    const unresolved = runScopeScenario(mode, { full });
    try {
      assert.equal(unresolved.code, 0, unresolved.output);
      assert.match(unresolved.output, full
        ? /Drive no longer returns this item to this credential/i
        : /denied access to the file metadata/i);
      assert.equal(unresolved.output.includes("missing-sensitive"), false, "ambiguous Drive id leaked to CLI output");
      const evidence = unresolved.evidence();
      assert.equal(evidence.absenceMetadataReads, 1, `${mode} did not classify the missing stored file`);
      assert.equal(evidence.rootedWalks, full ? 1 : 0);
      assert.equal(evidence.ingestBatchWrites, 0, "ambiguous absence allowed content writes");
      assert.equal(evidence.forgetRequests, 0, "ambiguous absence reached the destructive endpoint");
      assert.equal(evidence.inventoryUidFilteredReads, 1,
        `${mode} did not request labels only for its review candidate`);
      assert.deepEqual(evidence.inventoryUidBatchSizes, [1]);
      assert.equal(evidence.inventoryFullLabelReads, 0,
        `${mode} downloaded full-corpus labels from a filter-capable Worker`);
      assert.equal(evidence.receipts.error, 1, "ambiguous absence did not close its receipt as an error");
      const state = unresolved.state();
      assert.equal(
        state.sync_token,
        full ? `fixture-prewalk-${mode}` : `fixture-next-${mode}`,
        "a completed Drive walk did not save its cursor",
      );
      assert.equal(state.drive_removal_review.schema_version, 7);
      assert.equal(state.drive_removal_review.issue_code, "SAFETY_REVIEW_REQUIRED");
      assert.deepEqual(state.drive_removal_review.uids, ["drive:missing-sensitive"]);
      assert.deepEqual(state.drive_removal_review.source_deletion_candidates, []);
      if (full) {
        assert.deepEqual(state.drive_removal_review.counts, {
          unresolved_absences: 1,
          unresolved_access: 0,
          present_in_scope: 0,
          unresolved_transient: 0,
          unresolved_not_returned: 1,
          label_unavailable: 0,
          pending_source_deletions: 0,
        });
        assert.deepEqual(state.drive_removal_review.unresolved_access_uids, []);
        assert.deepEqual(state.drive_removal_review.present_in_scope_uids, []);
        const [record] = state.drive_removal_review.unresolved_not_returned;
        assert.equal(record.uid, "drive:missing-sensitive");
        assert.equal(record.observation_count, 1);
        assert.equal(
          Date.parse(record.grace_eligible_at) - Date.parse(record.first_observed_at),
          7 * 24 * 60 * 60 * 1000,
          "the bare-404 review did not record its seven-day grace boundary",
        );
      } else {
        assert.deepEqual(state.drive_removal_review.counts, {
          unresolved_absences: 1,
          unresolved_access: 1,
          present_in_scope: 0,
          unresolved_transient: 0,
          unresolved_not_returned: 0,
          label_unavailable: 0,
          pending_source_deletions: 0,
        });
        assert.deepEqual(state.drive_removal_review.unresolved_access_uids, ["drive:missing-sensitive"]);
        assert.deepEqual(state.drive_removal_review.present_in_scope_uids, []);
        assert.deepEqual(state.drive_removal_review.unresolved_not_returned, []);
      }
      if (full) {
        assert.notEqual(state.drive_last_full_sweep_at, unresolved.priorFullSweep,
          "a completed full walk did not save its sweep checkpoint");
      }
    } finally {
      unresolved.cleanup();
    }
  }

  const legacyInventoryWithoutLabels = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    priorNotReturnedNamed: false,
    localDoneLabels: false,
    inventoryLabelMode: "absent",
  });
  try {
    assert.equal(legacyInventoryWithoutLabels.code, 0, legacyInventoryWithoutLabels.output);
    assert.match(legacyInventoryWithoutLabels.output, /update the Brain to label review items/i);
    assert.doesNotMatch(legacyInventoryWithoutLabels.output, /unexpected error|INGEST_FAILED/i);
    assert.equal(legacyInventoryWithoutLabels.evidence().forgetRequests, 0);
    assert.equal(legacyInventoryWithoutLabels.state().sync_token,
      "fixture-prewalk-full-unresolved",
      "a legacy label-less inventory withheld the completed Drive cursor");
    assert.equal(legacyInventoryWithoutLabels.state().drive_removal_review.counts.label_unavailable, 1);
  } finally {
    legacyInventoryWithoutLabels.cleanup();
  }

  const structuredLabelRejection = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    priorNotReturnedNamed: false,
    localDoneLabels: false,
    inventoryLabelMode: "reject",
    inventoryDate: false,
  });
  try {
    assert.equal(structuredLabelRejection.code, 0, structuredLabelRejection.output);
    assert.doesNotMatch(structuredLabelRejection.output, /unexpected error|INGEST_FAILED/i);
    assert.equal(structuredLabelRejection.evidence().inventoryReads, 3,
      "the structured include_labels rejection did not restart without labels");
    assert.equal(structuredLabelRejection.evidence().inventoryUidFilteredReads, 2);
    assert.equal(structuredLabelRejection.evidence().inventoryFullLabelReads, 0);
    assert.equal(structuredLabelRejection.evidence().forgetRequests, 0);
    const state = structuredLabelRejection.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-unresolved");
    assert.equal(state.drive_removal_review.counts.unresolved_not_returned, 1);
    assert.equal(state.drive_removal_review.unresolved_not_returned[0].observations.at(-1).server_observed_at, null,
      "the rejected 400 response supplied the seven-day server anchor");
  } finally {
    structuredLabelRejection.cleanup();
  }

  for (const [field, options] of [
    ["include_labels", { inventoryLabelMode: "reject-after-first-page" }],
    ["uids", { inventoryUidFilterMode: "reject-after-first-page" }],
  ]) {
    for (const [mode, full] of [
      ["full-structured-page-rejection", true],
      ["incremental-structured-page-rejection", false],
    ]) {
      const rejected = runScopeScenario(mode, {
        full,
        inventoryDate: false,
        ...options,
      });
      try {
        assert.equal(rejected.code, 1,
          `${field} ${mode} did not fail closed:\n${rejected.output}`);
        const evidence = rejected.evidence();
        assert.equal(evidence.inventoryReads, 3,
          `${field} ${mode} did not stop after the pre-inventory and two-page capability walk`);
        assert.deepEqual(evidence.inventoryCursors.slice(-2), ["", "drive:structured-page-1"],
          `${field} ${mode} restarted after accepting page one`);
        assert.ok(evidence.inventoryAcceptedFamilies >= 6,
          `${field} ${mode} did not prove the pre-inventory and page-one families were read`);
        assert.equal(evidence.forgetRequests, 0,
          `${field} ${mode} reached the destructive endpoint`);
        assert.equal(rejected.stateBytes(), rejected.initialStateBytes,
          `${field} ${mode} changed source state after the rejected page`);
      } finally {
        rejected.cleanup();
      }
    }
  }

  for (const [mode, full] of [["full-unresolved", true], ["incremental-unresolved", false]]) {
    const unpageable = runScopeScenario(mode, { full, inventoryRouteMode: "unpageable-409" });
    try {
      assert.equal(unpageable.code, 1, unpageable.output);
      assert.match(unpageable.output, /not accepted \(409\)/i);
      const evidence = unpageable.evidence();
      assert.equal(evidence.inventoryReads, 1,
        `${mode} treated typed 409 as a first-page capability signal`);
      assert.deepEqual(evidence.inventoryCursors, [""]);
      assert.equal(evidence.forgetRequests, 0);
      assert.equal(unpageable.stateBytes(), unpageable.initialStateBytes,
        `${mode} changed source state after typed 409`);
    } finally {
      unpageable.cleanup();
    }
  }

  for (const [mode, full] of [["full-unresolved", true], ["incremental-unresolved", false]]) {
    const overlong = runScopeScenario(mode, { full, inventoryRouteMode: "overlong-tail-v048" });
    try {
      assert.equal(overlong.code, 1, overlong.output);
      assert.match(overlong.output, /update the Brain/i);
      assert.doesNotMatch(overlong.output, /unexpected error/i);
      const evidence = overlong.evidence();
      assert.equal(evidence.inventoryReads, 1,
        `${mode} attempted to send the over-long continuation token back to the Brain`);
      assert.equal(evidence.inventoryAcceptedFamilies, 1,
        `${mode} did not reach the over-long page-tail decision`);
      assert.equal(evidence.forgetRequests, 0);
      assert.equal(overlong.stateBytes(), overlong.initialStateBytes,
        `${mode} changed source state after the over-long continuation token`);
    } finally {
      overlong.cleanup();
    }
  }

  const legacyInventoryWithoutUidFilter = runScopeScenario("full-unresolved", {
    full: true,
    inventoryUidFilterMode: "reject",
  });
  try {
    assert.equal(legacyInventoryWithoutUidFilter.code, 0, legacyInventoryWithoutUidFilter.output);
    assert.doesNotMatch(legacyInventoryWithoutUidFilter.output, /unexpected error|INGEST_FAILED/i);
    const evidence = legacyInventoryWithoutUidFilter.evidence();
    assert.equal(evidence.inventoryReads, 3);
    assert.equal(evidence.inventoryUidFilteredReads, 1,
      "the CLI did not try the bounded uid filter before compatibility fallback");
    assert.equal(evidence.inventoryFullLabelReads, 1,
      "a Worker without uid filtering did not receive the one allowed full-label fallback");
    assert.equal(evidence.forgetRequests, 0);
    assert.equal(legacyInventoryWithoutUidFilter.state().sync_token, "fixture-prewalk-full-unresolved");
  } finally {
    legacyInventoryWithoutUidFilter.cleanup();
  }

  const shippedV048Inventory = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    priorNotReturnedNamed: false,
    localDoneLabels: false,
    inventoryLabelMode: "reject-v048",
  });
  try {
    assert.equal(shippedV048Inventory.code, 0, shippedV048Inventory.output);
    assert.doesNotMatch(shippedV048Inventory.output, /unexpected error|INGEST_FAILED/i);
    const evidence = shippedV048Inventory.evidence();
    assert.equal(evidence.inventoryReads, 4,
      "the v0.4.8 request-shape ladder did not make pre-inventory, labels+uids, labels, then bare reads");
    assert.equal(evidence.inventoryUidFilteredReads, 1);
    assert.equal(evidence.inventoryLabelReads, 2);
    assert.equal(evidence.inventoryFullLabelReads, 1);
    assert.ok(evidence.absenceMetadataReads >= 1,
      "the v0.4.8 fallback test never reached Drive absence classification");
    assert.equal(evidence.forgetRequests, 0);
    assert.match(shippedV048Inventory.output, /did not return Drive labels[\s\S]*Update the Brain/i);
    const state = shippedV048Inventory.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-unresolved");
    assert.equal(state.drive_removal_review.counts.label_unavailable, 1);
  } finally {
    shippedV048Inventory.cleanup();
  }

  const preUidFilterWorker = runScopeScenario("full-unresolved", {
    full: true,
    localDoneLabels: false,
    inventoryUidFilterMode: "reject-unstructured",
  });
  try {
    assert.equal(preUidFilterWorker.code, 0, preUidFilterWorker.output);
    assert.doesNotMatch(preUidFilterWorker.output, /unexpected error|INGEST_FAILED/i);
    const evidence = preUidFilterWorker.evidence();
    assert.equal(evidence.inventoryReads, 3);
    assert.equal(evidence.inventoryUidFilteredReads, 1);
    assert.equal(evidence.inventoryFullLabelReads, 1,
      "the pre-uid-filter Worker did not receive exactly one full labelled read");
    assert.ok(evidence.absenceMetadataReads >= 1,
      "the pre-uid-filter fallback test never reached Drive absence classification");
    assert.equal(evidence.forgetRequests, 0);
    const state = preUidFilterWorker.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-unresolved");
    assert.equal(state.drive_removal_review.counts.unresolved_not_returned, 1);
    assert.equal(state.drive_removal_review.unresolved_not_returned[0].name, "Owner tax return.txt");
  } finally {
    preUidFilterWorker.cleanup();
  }

  const boundedLabels = runScopeScenario("full-label-bounds", { full: true });
  try {
    assert.equal(boundedLabels.code, 0, boundedLabels.output);
    assert.doesNotMatch(boundedLabels.output, /unexpected error|INGEST_FAILED/i);
    const evidence = boundedLabels.evidence();
    assert.equal(evidence.inventoryUidFilteredReads, 26,
      "2,500 candidates were not partitioned into 26 bounded label requests");
    assert.deepEqual(evidence.inventoryUidBatchSizes, [
      ...Array.from({ length: 25 }, () => 97),
      75,
    ]);
    assert.equal(evidence.absenceMetadataReads, 2500,
      "not every labelled candidate reached Drive classification exactly once");
    assert.equal(evidence.forgetRequests, 0);
    const state = boundedLabels.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-label-bounds");
    assert.equal(state.drive_removal_review.counts.unresolved_access, 2500);
    assert.equal(new Set(state.drive_removal_review.unresolved_access_uids).size, 2500);
  } finally {
    boundedLabels.cleanup();
  }

  for (const [mode, full, expectedCursor] of [
    ["full-page-boundary", true, "fixture-prewalk-full-page-boundary"],
    ["incremental-page-boundary", false, "fixture-next-incremental-page-boundary"],
  ]) {
    const boundary = runScopeScenario(mode, { full });
    try {
      assert.equal(boundary.code, 0, boundary.output);
      assert.doesNotMatch(boundary.output, /unexpected error|INGEST_FAILED/i);
      assert.match(boundary.output, /3 stored items have malformed identities and are held/i);
      assert.ok(boundary.output.includes(pluralDiagnoseGuidance),
        `${mode} omitted the platform-rendered plural diagnose remediation`);
      const evidence = boundary.evidence();
      assert.deepEqual(evidence.inventoryCursors.slice(0, 2), ["", "drive:b "],
        `${mode} did not read each inventory page exactly once`);
      assert.equal(evidence.absenceMetadataReads, 1,
        `${mode} did not classify the legitimate family after the malformed page boundary`);
      assert.equal(evidence.forgetRequests, 0);
      const state = boundary.state();
      assert.equal(state.sync_token, expectedCursor);
      assert.deepEqual(state.drive_removal_review.malformed_identities,
        ["drive:a\t", "drive:b ", "drive:c\u0001"]);
      assert.equal(state.drive_removal_review.counts.malformed_identity, 3);
      assert.equal(state.drive_removal_review.counts.unresolved_not_returned, 1);
    } finally {
      boundary.cleanup();
    }
  }

  const v048ControlCursor = runScopeScenario("full-control-cursor-v048", { full: true });
  try {
    assert.equal(v048ControlCursor.code, 1, v048ControlCursor.output);
    assert.match(v048ControlCursor.output, /update the Brain/i);
    assert.doesNotMatch(v048ControlCursor.output, /unexpected error/i);
    const evidence = v048ControlCursor.evidence();
    assert.deepEqual(evidence.inventoryCursors, ["", "drive:a\t"]);
    assert.equal(evidence.forgetRequests, 0);
    assert.equal(v048ControlCursor.state().sync_token, "fixture-prior-full-control-cursor-v048");
  } finally {
    v048ControlCursor.cleanup();
  }

  {
    const originalFetch = globalThis.fetch;
    const sqliteOrdered = ["drive:a\uff5e", "drive:a\ud83d\ude00"];
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        source: "drive",
        families: sqliteOrdered,
        next_cursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
      const inventory = await listStoredSourceFamilies({
        base: "https://fixture.invalid",
        adminKey: "fixture-admin",
        source: "drive",
        includeServerObservedAt: true,
      });
      assert.deepEqual([...inventory.malformedIdentities], sqliteOrdered,
        "the client did not preserve SQLite UTF-8 byte ordering while quarantining rows");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const invisibleDriveIdentities = [
    "drive:abc\u200bdef",
    "drive:abc\u200ddef",
    "drive:abc\u202edef",
    "drive:abc\u2066def",
    "drive:abc\u3164def",
    "drive:abc\ufe0fdef",
    "drive:abc\ud800def",
    `drive:${"a".repeat(251)}`,
  ];
  for (const storedUid of invisibleDriveIdentities) {
    for (const [mode, full] of [["full-identity", true], ["incremental-identity", false]]) {
      const malformed = runScopeScenario(mode, { full, storedUid });
      try {
        assert.equal(malformed.code, 0, malformed.output);
        assert.match(malformed.output, /1 stored item has a malformed identity and is held/i);
        assert.equal(malformed.evidence().absenceMetadataReads, 0,
          `${JSON.stringify(storedUid)} reached Drive classification during ${mode}`);
        assert.equal(malformed.evidence().forgetRequests, 0);
        assert.deepEqual(malformed.state().drive_removal_review.malformed_identities, [storedUid]);
      } finally {
        malformed.cleanup();
      }
    }
  }

  for (const [mode, full] of [["full-identity", true], ["incremental-identity", false]]) {
    const boundaryUid = `drive:${"a".repeat(250)}`;
    const boundary = runScopeScenario(mode, { full, storedUid: boundaryUid });
    try {
      assert.equal(boundary.code, 0, boundary.output);
      assert.equal(boundary.evidence().absenceMetadataReads, 1,
        `the 256-byte Drive uid did not reach classification during ${mode}`);
      assert.equal(boundary.evidence().forgetRequests, 0);
    } finally {
      boundary.cleanup();
    }
  }

  const malformedStoredIdentity = runScopeScenario("full-malformed", { full: true });
  try {
    assert.equal(malformedStoredIdentity.code, 0, malformedStoredIdentity.output);
    assert.match(malformedStoredIdentity.output, /1 stored item has a malformed identity and is held/i);
    assert.ok(malformedStoredIdentity.output.includes(singularDiagnoseGuidance),
      "the real Drive command omitted the platform-rendered singular diagnose remediation");
    assert.doesNotMatch(malformedStoredIdentity.output, /malformed_identity/i);
    assert.doesNotMatch(malformedStoredIdentity.output, /unexpected error|INGEST_FAILED/i);
    assert.equal(malformedStoredIdentity.evidence().forgetRequests, 0,
      "a malformed stored family identity reached the destructive endpoint");
    assert.equal(malformedStoredIdentity.evidence().absenceMetadataReads, 0,
      "a malformed stored family identity reached the Drive metadata classifier");
    const state = malformedStoredIdentity.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-malformed");
    assert.equal(state.drive_removal_review.counts.malformed_identity, 1);
    assert.deepEqual(state.drive_removal_review.malformed_identities, ["drive:"]);
    assert.deepEqual(state.drive_removal_review.uids, []);
    assert.deepEqual(state.drive_removal_review.source_deletion_candidates, []);
  } finally {
    malformedStoredIdentity.cleanup();
  }

  for (const [mode, full, expectedGuidance] of [
    ["full-malformed", true, win32SingularDiagnoseGuidance],
    ["full-page-boundary", true, win32PluralDiagnoseGuidance],
  ]) {
    const rendered = runScopeScenario(mode, { full, win32: true });
    try {
      assert.equal(rendered.code, 0, rendered.output);
      assert.ok(rendered.output.includes(expectedGuidance),
        `${mode} omitted the win32-rendered diagnose remediation`);
      assert.doesNotMatch(rendered.output, bareDiagnoseCommand,
        `${mode} emitted bare diagnose guidance under the win32 preload`);
    } finally {
      rendered.cleanup();
    }
  }

  for (const storedUid of ["drive:", "drive:   ", "drive:\t", "drive: abc"]) {
    for (const [mode, full] of [["full-identity", true], ["incremental-identity", false]]) {
      const malformed = runScopeScenario(mode, { full, storedUid });
      try {
        assert.equal(malformed.code, 0, malformed.output);
        assert.match(malformed.output, /1 stored item has a malformed identity and is held/i);
        assert.equal(malformed.evidence().absenceMetadataReads, 0,
          `${JSON.stringify(storedUid)} reached Drive classification during ${mode}`);
        assert.equal(malformed.evidence().forgetRequests, 0,
          `${JSON.stringify(storedUid)} reached deletion during ${mode}`);
        assert.deepEqual(malformed.state().drive_removal_review.malformed_identities, [storedUid]);
      } finally {
        malformed.cleanup();
      }
    }
  }

  for (const [mode, full] of [["full-identity", true], ["incremental-identity", false]]) {
    const validShortIdentity = runScopeScenario(mode, { full, storedUid: "drive:a" });
    try {
      assert.equal(validShortIdentity.code, 0, validShortIdentity.output);
      assert.equal(validShortIdentity.evidence().absenceMetadataReads, 1,
        `a legitimate short source id did not reach Drive classification during ${mode}`);
      assert.equal(validShortIdentity.evidence().forgetRequests, 0);
      assert.equal(validShortIdentity.state().drive_removal_review.counts.unresolved_not_returned, 1);
    } finally {
      validShortIdentity.cleanup();
    }
  }

  {
    const lines = [];
    const zeroWidth = "drive:abc\u200bdef";
    const bidi = "drive:abc\u202edef";
    renderMalformedDriveIdentities([
      "drive:\t",
      zeroWidth,
      bidi,
      `drive:${"a".repeat(251)}`,
    ], { write: (line) => lines.push(line) });
    const output = lines.join("\n");
    assert.match(output, /drive:\\t/, "brain diagnose did not surface the escaped quarantined identity");
    assert.match(output, /\\u200b/);
    assert.match(output, /\\u202e/);
    assert.doesNotMatch(output, /\u200b|\u202e/,
      "brain diagnose emitted an invisible or bidi code point raw");
    assert.ok(output.length < 1000, "brain diagnose did not cap a malformed identity's display length");
  }

  const unresolvedPending = runScopeScenario("incremental-unresolved", {
    pendingRemoval: true,
  });
  try {
    assert.equal(unresolvedPending.code, 0, unresolvedPending.output);
    const evidence = unresolvedPending.evidence();
    assert.equal(evidence.absenceMetadataReads, 1);
    assert.equal(evidence.forgetRequests, 0,
      "an unresolved item inherited a deletion from an earlier pending marker");
    assert.equal(evidence.removedFamilies, 0);
    const state = unresolvedPending.state();
    assert.deepEqual(state.drive_removal_review, {
      schema_version: 7,
      issue_code: "SAFETY_REVIEW_REQUIRED",
      counts: {
        unresolved_absences: 1,
        unresolved_access: 1,
        present_in_scope: 0,
        unresolved_transient: 0,
        unresolved_not_returned: 0,
        label_unavailable: 0,
        pending_source_deletions: 0,
      },
      uids: ["drive:missing-sensitive"],
      unresolved_access_uids: ["drive:missing-sensitive"],
      present_in_scope_uids: [],
      unresolved_transient: [],
      unresolved_not_returned: [],
      label_unavailable: [],
      source_deletion_candidates: [],
    });
    assert.equal(
      state.removed?.["drive:missing-sensitive"],
      "2026-09-01T00:00:00.000Z",
      "the unresolved pending marker must remain visible for review rather than being applied",
    );
    const repeated403 = unresolvedPending.rerun();
    assert.equal(repeated403.code, 0, repeated403.output);
    assert.match(repeated403.output, /denied access to the file metadata/i);
    assert.equal(unresolvedPending.evidence().forgetRequests, 0,
      "a consecutive protected 403 run reached forget");
  } finally {
    unresolvedPending.cleanup();
  }

  for (const reset of [false, true]) {
    const staleMarker = runScopeScenario("incremental-stale-marker-404", {
      pendingRemoval: true,
      args: reset ? ["--reset"] : [],
    });
    try {
      assert.equal(staleMarker.code, 0, staleMarker.output);
      const evidence = staleMarker.evidence();
      assert.ok(evidence.absenceMetadataReads >= 1,
        "a stale retry marker was not checked against live Drive metadata");
      assert.equal(evidence.forgetRequests, 0,
        "a stale retry marker reached deletion without owner-reviewed absence proof");
      const state = staleMarker.state();
      assert.equal(state.removed?.["drive:missing-sensitive"], "2026-09-01T00:00:00.000Z");
      assert.equal(state.drive_removal_review?.unresolved_not_returned?.[0]?.uid, "drive:missing-sensitive");
      assert.equal(state.sync_token, reset
        ? "fixture-prewalk-incremental-stale-marker-404"
        : "fixture-next-incremental-stale-marker-404");
      if (!reset) {
        const repeated404 = staleMarker.rerun();
        assert.equal(repeated404.code, 0, repeated404.output);
        assert.match(repeated404.output, /Drive no longer returns this item to this credential/i);
        assert.equal(staleMarker.evidence().forgetRequests, 0,
          "a consecutive protected 404 run reached forget");
      }
    } finally {
      staleMarker.cleanup();
    }
  }

  const resetLifecycle = runScopeScenario("incremental-stale-marker-404", {
    pendingRemoval: true,
    args: ["--reset"],
  });
  try {
    assert.equal(resetLifecycle.code, 0, resetLifecycle.output);
    const firstState = resetLifecycle.state();
    const firstRecord = firstState.drive_removal_review?.unresolved_not_returned?.[0];
    assert.equal(firstRecord?.name, "Owner tax return.txt");
    assert.equal(firstRecord?.folder_path, "Reviewed Root/Tax");
    const agedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    firstRecord.first_observed_at = agedAt;
    firstRecord.last_observed_at = agedAt;
    firstRecord.grace_eligible_at = new Date(Date.parse(agedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
    firstRecord.observations[0].observed_at = agedAt;
    firstRecord.observations[0].server_observed_at = agedAt;
    resetLifecycle.writeState(firstState);

    const secondRun = resetLifecycle.rerun();
    assert.equal(secondRun.code, 1, secondRun.output);
    assert.match(secondRun.output, /Owner tax return\.txt \(folder: Reviewed Root\/Tax\)/);
    assert.match(secondRun.output, /--approve-removals [0-9a-f]{64}/);
    const thirdRun = resetLifecycle.rerun();
    assert.equal(thirdRun.code, 1, thirdRun.output);
    assert.match(thirdRun.output, /Owner tax return\.txt \(folder: Reviewed Root\/Tax\)/);
    assert.match(thirdRun.output, /--approve-removals [0-9a-f]{64}/,
      "the reset-created review did not remain approvable on its third run");
    assert.equal(resetLifecycle.evidence().forgetRequests, 0);
  } finally {
    resetLifecycle.cleanup();
  }

  const restoredStaleMarker = runScopeScenario("incremental-stale-marker-live", {
    pendingRemoval: true,
  });
  try {
    assert.equal(restoredStaleMarker.code, 0, restoredStaleMarker.output);
    const evidence = restoredStaleMarker.evidence();
    assert.equal(evidence.absenceMetadataReads, 1);
    assert.equal(evidence.forgetRequests, 0);
    const state = restoredStaleMarker.state();
    assert.equal(state.removed?.["drive:missing-sensitive"], undefined,
      "a live in-scope file left its stale retry marker behind");
    assert.equal(state.drive_removal_review, undefined);
    assert.equal(state.sync_token, "fixture-next-incremental-stale-marker-live");
  } finally {
    restoredStaleMarker.cleanup();
  }

  const presentInScope = runScopeScenario("incremental-stale-marker-live", {
    priorMaturedDays: 10,
  });
  try {
    assert.equal(presentInScope.code, 0, presentInScope.output);
    assert.match(presentInScope.output, /present on Drive under a reviewed folder; retained/i);
    assert.doesNotMatch(presentInScope.output, /denied access/i);
    const evidence = presentInScope.evidence();
    assert.equal(evidence.absenceMetadataReads, 1);
    assert.equal(evidence.forgetRequests, 0,
      "a file Drive reported present and in scope reached the destructive endpoint");
    const review = presentInScope.state().drive_removal_review;
    assert.equal(review.schema_version, 7);
    assert.equal(review.counts.present_in_scope, 1);
    assert.equal(review.counts.unresolved_access, 0);
    assert.deepEqual(review.present_in_scope_uids, ["drive:missing-sensitive"]);
    assert.deepEqual(review.unresolved_access_uids, []);
    assert.deepEqual(review.source_deletion_candidates, []);
  } finally {
    presentInScope.cleanup();
  }

  for (const priorReview of [false, true]) {
    const pendingNotReturned = runScopeScenario("full-unresolved-subthreshold", {
      full: true,
      pendingRemoval: true,
      priorReview,
    });
    try {
      assert.equal(pendingNotReturned.code, 0, pendingNotReturned.output);
      const evidence = pendingNotReturned.evidence();
      assert.equal(evidence.absenceMetadataReads, 1);
      assert.equal(evidence.forgetRequests, 0,
        "a bare 404 inherited a stale pending deletion below the routine size threshold");
      assert.equal(evidence.removedFamilies, 0);
      const state = pendingNotReturned.state();
      assert.equal(state.done?.["drive:missing-sensitive"] != null, true,
        "the protected Brain copy was removed from local accepted state");
      assert.equal(
        state.removed?.["drive:missing-sensitive"],
        "2026-09-01T00:00:00.000Z",
        "the pending retry marker disappeared while the item remained under review",
      );
      assert.ok(state.drive_removal_review, pendingNotReturned.output);
      assert.deepEqual(state.drive_removal_review.uids, ["drive:missing-sensitive"]);
      assert.deepEqual(state.drive_removal_review.unresolved_access_uids, []);
      assert.equal(state.drive_removal_review.unresolved_not_returned.length, 1);
      assert.equal(state.drive_removal_review.unresolved_not_returned[0].uid, "drive:missing-sensitive");
      assert.deepEqual(state.drive_removal_review.source_deletion_candidates, []);
      assert.equal(state.drive_removal_review.counts.unresolved_not_returned, 1);
      assert.equal(state.drive_removal_review.counts.pending_source_deletions, 0);
    } finally {
      pendingNotReturned.cleanup();
    }
  }

  const unresolvedBatch = runScopeScenario("incremental-unresolved-batch");
  try {
    assert.equal(unresolvedBatch.code, 0, unresolvedBatch.output);
    assert.match(unresolvedBatch.output, /Drive review required: 3 stored item\(s\)/i);
    const evidence = unresolvedBatch.evidence();
    assert.equal(evidence.absenceMetadataReads, 10, "the classifier stopped before all absence candidates were reviewed");
    assert.equal(evidence.forgetRequests, 1, "confirmed deletions did not reach the guarded removal plan");
    assert.equal(evidence.removedFamilies, 7, "an unresolved absence was deleted or a confirmed deletion was retained");
    assert.equal(evidence.receipts.error, 1);
    assert.equal(evidence.receipts.ready, 0);
    assert.deepEqual(evidence.lastErrorReceipt, {
      issue_code: "SAFETY_REVIEW_REQUIRED",
      walk_complete: true,
      docs_failed: 0,
    });
    const state = unresolvedBatch.state();
    assert.equal(state.sync_token, "fixture-next-incremental-unresolved-batch");
    assert.deepEqual(state.drive_removal_review, {
      schema_version: 7,
      issue_code: "SAFETY_REVIEW_REQUIRED",
      counts: {
        unresolved_absences: 3,
        unresolved_access: 3,
        present_in_scope: 0,
        unresolved_transient: 0,
        unresolved_not_returned: 0,
        label_unavailable: 0,
        pending_source_deletions: 0,
      },
      uids: [
        "drive:missing-batch-00",
        "drive:missing-batch-01",
        "drive:missing-batch-02",
      ],
      unresolved_access_uids: [
        "drive:missing-batch-00",
        "drive:missing-batch-01",
        "drive:missing-batch-02",
      ],
      present_in_scope_uids: [],
      unresolved_transient: [],
      unresolved_not_returned: [],
      label_unavailable: [],
      source_deletion_candidates: [],
    });
  } finally {
    unresolvedBatch.cleanup();
  }

  const transientBatch = runScopeScenario("incremental-transient-batch");
  try {
    assert.equal(transientBatch.code, 0, transientBatch.output);
    assert.match(transientBatch.output, /metadata lookup was temporarily unavailable/i);
    const evidence = transientBatch.evidence();
    assert.equal(evidence.absenceMetadataReads, 14,
      "the transient candidate did not exhaust its five attempts while the other probes continued");
    assert.equal(evidence.forgetRequests, 0);
    assert.equal(evidence.receipts.error, 1);
    const state = transientBatch.state();
    assert.equal(state.sync_token, "fixture-next-incremental-transient-batch",
      "a per-file transient lookup withheld the completed Drive change cursor");
    assert.equal(state.drive_removal_review.counts.unresolved_transient, 1);
    assert.equal(state.drive_removal_review.counts.unresolved_access, 9);
    assert.equal(state.drive_removal_review.unresolved_transient.length, 1);
    assert.equal(state.drive_removal_review.unresolved_transient[0].uid, "drive:missing-batch-00");
  } finally {
    transientBatch.cleanup();
  }

  const goneStoredFamilies = [
    "drive:missing-sensitive",
    ...Array.from({ length: 10 }, (_, index) =>
      `drive:retained-${String(index).padStart(2, "0")}`
    ),
  ].sort();
  const gonePlan = buildDriveRemovalPlan({
    storedFamilies: goneStoredFamilies,
    activeFamilies: [],
    policyCandidates: [],
    vanishedCandidates: ["drive:missing-sensitive"],
    intentionalCandidates: [],
  }, {
    safetyBaselineCount: goneStoredFamilies.length,
    fingerprintContext: "drive-strict",
  });
  assert.equal(gonePlan.tooLarge, false, "the gone fixture must prove owner approval below routine limits");

  const goneReviewOnly = runScopeScenario("incremental-gone", { priorReview: true });
  try {
    assert.equal(goneReviewOnly.code, 0, goneReviewOnly.output);
    assert.match(goneReviewOnly.output, /recorded seven-day grace date/i);
    assert.equal(goneReviewOnly.output.includes(gonePlan.fingerprint), false,
      "an open grace window advertised an exact deletion approval");
    assert.equal(goneReviewOnly.output.includes("missing-sensitive"), false,
      "the approval stop disclosed the raw Drive identity");
    assert.equal(goneReviewOnly.evidence().forgetRequests, 0,
      "a change-feed removal event reached the destructive endpoint");
    const review = goneReviewOnly.state().drive_removal_review;
    assert.equal(review.schema_version, 7);
    assert.deepEqual(review.counts, {
      unresolved_absences: 1,
      unresolved_access: 0,
      present_in_scope: 0,
      unresolved_transient: 0,
      unresolved_not_returned: 1,
      label_unavailable: 0,
      pending_source_deletions: 0,
    });
    assert.deepEqual(review.unresolved_access_uids, []);
    assert.deepEqual(review.present_in_scope_uids, []);
    assert.equal(review.unresolved_not_returned.length, 1);
    assert.equal(review.unresolved_not_returned[0].uid, "drive:missing-sensitive");
    assert.ok(Number.isFinite(Date.parse(review.unresolved_not_returned[0].change_feed_removed_at)),
      "the change-feed removal was not retained as a dated annotation");
    assert.deepEqual(review.source_deletion_candidates, []);
  } finally {
    goneReviewOnly.cleanup();
  }

  const goneDryRun = runScopeScenario("incremental-gone", {
    args: ["--dry-run"],
  });
  try {
    assert.equal(goneDryRun.code, 0, goneDryRun.output);
    assert.match(goneDryRun.output,
      /1 file\(s\) were reported by the change feed as removed; they will be verified and are never deleted on that signal/i);
    assert.doesNotMatch(goneDryRun.output, /WOULD be removed from the brain/i);
    assert.equal(goneDryRun.evidence().forgetRequests, 0);
  } finally {
    goneDryRun.cleanup();
  }

  const goneApprovalCannotShorten = runScopeScenario("incremental-gone", {
    priorReview: true,
    args: ["--approve-removals", gonePlan.fingerprint],
  });
  try {
    assert.equal(goneApprovalCannotShorten.code, 0, goneApprovalCannotShorten.output);
    assert.equal(goneApprovalCannotShorten.evidence().forgetRequests, 0,
      "exact plan approval bypassed an open grace window");
    assert.equal(goneApprovalCannotShorten.state().drive_removal_review?.unresolved_not_returned.length, 1,
      "the protected review record disappeared without a confirmed removal");
  } finally {
    goneApprovalCannotShorten.cleanup();
  }

  const legacyChangeFeedCandidate = runScopeScenario("incremental-gone", {
    priorChangeFeedDays: 2,
  });
  try {
    assert.equal(legacyChangeFeedCandidate.code, 0, legacyChangeFeedCandidate.output);
    assert.equal(legacyChangeFeedCandidate.evidence().forgetRequests, 0);
    const review = legacyChangeFeedCandidate.state().drive_removal_review;
    assert.equal(review.counts.unresolved_not_returned, 1);
    assert.equal(review.counts.pending_source_deletions, 0,
      "a stored change-feed candidate remained eligible for deletion");
    assert.equal(review.unresolved_not_returned[0].observation_count, 1);
    assert.ok(Number.isFinite(Date.parse(review.unresolved_not_returned[0].change_feed_removed_at)));
  } finally {
    legacyChangeFeedCandidate.cleanup();
  }

  const recentRepeat = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 2,
    priorObservation: true,
  });
  try {
    assert.equal(recentRepeat.code, 0, recentRepeat.output);
    assert.match(recentRepeat.output, /Drive no longer returns this item to this credential/i);
    assert.equal(recentRepeat.evidence().forgetRequests, 0,
      "a second 404 inside the grace window reached the deletion plan");
    const review = recentRepeat.state().drive_removal_review;
    assert.equal(review.counts.unresolved_not_returned, 1);
    assert.equal(review.counts.pending_source_deletions, 0);
    assert.equal(review.unresolved_not_returned[0].observation_count, 2);
    assert.ok(Date.parse(review.unresolved_not_returned[0].grace_eligible_at) > Date.now(),
      "the two-day repeat lost its still-open grace date");
  } finally {
    recentRepeat.cleanup();
  }

  const unnamedLegacy = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorNotReturnedNamed: false,
    priorObservation: true,
    localDoneLabels: false,
    inventoryLabels: false,
    args: ["--approve-removals", "0".repeat(64)],
  });
  try {
    assert.equal(unnamedLegacy.code, 0, unnamedLegacy.output);
    assert.match(unnamedLegacy.output, /no saved name and folder/i);
    assert.match(unnamedLegacy.output, /protected and retained/i);
    assert.equal(/--approve-removals [0-9a-f]{64}/.test(unnamedLegacy.output), false,
      "an unnamed legacy review record advertised an approval fingerprint");
    assert.equal(unnamedLegacy.evidence().forgetRequests, 0);
    const state = unnamedLegacy.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-unresolved",
      "an unlabelled protected family withheld the completed Drive cursor");
    assert.equal(state.drive_removal_review.counts.label_unavailable, 1);
    assert.deepEqual(state.drive_removal_review.label_unavailable.map((record) => record.uid), [
      "drive:missing-sensitive",
    ]);
    assert.deepEqual(state.drive_removal_review.source_deletion_candidates, []);
  } finally {
    unnamedLegacy.cleanup();
  }

  const offlineMintedUnnamed = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorNotReturnedNamed: false,
    priorObservation: true,
    localDoneLabels: false,
    inventoryLabels: false,
  });
  try {
    assert.equal(offlineMintedUnnamed.code, 0, offlineMintedUnnamed.output);
    const refusedState = offlineMintedUnnamed.state();
    const [record] = refusedState.drive_removal_review.label_unavailable;
    const offlineFingerprint = buildDriveRemovalPlan({
      storedFamilies: ["drive:missing-sensitive"],
      activeFamilies: [],
      policyCandidates: [],
      vanishedCandidates: ["drive:missing-sensitive"],
      intentionalCandidates: [],
    }, {
      safetyBaselineCount: 1,
      fingerprintContext: "drive-strict",
      fingerprintBinding: [{
        uid: record.uid,
        name: record.name || null,
        folder_path: record.folder_path || null,
        observation_id: record.approval_observation_id || null,
        observed_at: record.approval_observed_at || record.last_observed_at || null,
      }],
    }).fingerprint;
    const attemptedBypass = offlineMintedUnnamed.rerun([
      "--reset", "--approve-removals", offlineFingerprint,
    ]);
    assert.equal(attemptedBypass.code, 0, attemptedBypass.output);
    assert.match(attemptedBypass.output, /protected and retained/i);
    assert.equal(offlineMintedUnnamed.evidence().forgetRequests, 0,
      "an offline-minted fingerprint let an ineligible UID reach forget");
  } finally {
    offlineMintedUnnamed.cleanup();
  }

  const reviewStoredFamilies = [
    "drive:missing-sensitive",
    ...Array.from({ length: 10 }, (_, index) => `drive:retained-${String(index).padStart(2, "0")}`),
  ].sort();
  const currentReviewPlan = buildDriveRemovalPlan({
    storedFamilies: reviewStoredFamilies,
    activeFamilies: [],
    policyCandidates: [],
    vanishedCandidates: ["drive:missing-sensitive"],
    intentionalCandidates: [],
  }, {
    safetyBaselineCount: reviewStoredFamilies.length,
    fingerprintContext: "drive-strict",
    fingerprintBinding: [{
      uid: "drive:missing-sensitive",
      name: "Owner tax return.txt",
      folder_path: "Reviewed Root/Tax",
      observation_id: fixedReviewObservationId,
      observed_at: fixedReviewObservedAt,
    }],
  });

  const emptyWindowReview = runScopeScenario("incremental-review-empty", {
    priorMaturedDays: 10,
  });
  try {
    assert.equal(emptyWindowReview.code, 1, emptyWindowReview.output);
    assert.equal(emptyWindowReview.evidence().changesReads, 1);
    assert.equal(emptyWindowReview.evidence().absenceMetadataReads, 1,
      "a matured review candidate was offered without a live lookup in this run");
    assert.match(emptyWindowReview.output, new RegExp(currentReviewPlan.fingerprint));
    assert.equal(emptyWindowReview.evidence().forgetRequests, 0);
  } finally {
    emptyWindowReview.cleanup();
  }

  const approvedEmptyWindowReview = runScopeScenario("incremental-review-empty", {
    priorMaturedDays: 10,
    args: ["--approve-removals", currentReviewPlan.fingerprint],
  });
  try {
    assert.equal(approvedEmptyWindowReview.code, 0, approvedEmptyWindowReview.output);
    assert.equal(approvedEmptyWindowReview.evidence().absenceMetadataReads, 1);
    assert.equal(approvedEmptyWindowReview.evidence().forgetRequests, 1,
      "approval after a live repeated-not-returned observation was a no-op");
    assert.equal(approvedEmptyWindowReview.state().drive_removal_review, undefined);
  } finally {
    approvedEmptyWindowReview.cleanup();
  }

  const fullSweepApprovedReview = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
  });
  try {
    assert.equal(fullSweepApprovedReview.code, 1, fullSweepApprovedReview.output);
    const approval = /--approve-removals ([0-9a-f]{64})/.exec(fullSweepApprovedReview.output)?.[1];
    assert.ok(approval, "the full-sweep review did not print its approval fingerprint");
    const approved = fullSweepApprovedReview.rerun(["--approve-removals", approval]);
    assert.equal(approved.code, 0, approved.output);
    const evidence = fullSweepApprovedReview.evidence();
    assert.equal(evidence.forgetRequests, 1,
      "an approved full-sweep repeated absence did not reach one bounded forget");
    assert.equal(evidence.inventoryReads, 5,
      "the two full inventories, two targeted label reads, and post-forget readback did not all run");
    assert.equal(evidence.removedFamilies, 1);
    assert.equal(fullSweepApprovedReview.state().drive_removal_review, undefined);
  } finally {
    fullSweepApprovedReview.cleanup();
  }

  const expiredReviewPlan = buildDriveRemovalPlan({
    storedFamilies: reviewStoredFamilies,
    activeFamilies: [],
    policyCandidates: [],
    vanishedCandidates: ["drive:missing-sensitive"],
    intentionalCandidates: [],
  }, {
    safetyBaselineCount: reviewStoredFamilies.length,
    fingerprintContext: "drive-strict",
    fingerprintBinding: [{
      uid: "drive:missing-sensitive",
      name: "Owner tax return.txt",
      folder_path: "Reviewed Root/Tax",
      observation_id: fixedReviewObservationId,
      observed_at: expiredReviewObservedAt,
    }],
  });
  const expiredApproval = runScopeScenario("incremental-review-empty", {
    priorMaturedDays: 10,
    priorApprovalExpired: true,
    args: ["--approve-removals", expiredReviewPlan.fingerprint],
  });
  try {
    assert.equal(expiredApproval.code, 1, expiredApproval.output);
    assert.match(expiredApproval.output, /approval fingerprint expired after 24 hours/i);
    const freshFingerprint = /--approve-removals ([0-9a-f]{64})/.exec(expiredApproval.output)?.[1];
    assert.ok(freshFingerprint && freshFingerprint !== expiredReviewPlan.fingerprint,
      "an expired approval was not replaced by a fresh observation-bound fingerprint");
    assert.equal(expiredApproval.evidence().forgetRequests, 0);
  } finally {
    expiredApproval.cleanup();
  }

  let elapsedApproval = null;
  const backdatedLegacySingle = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
  });
  try {
    assert.equal(backdatedLegacySingle.code, 0, backdatedLegacySingle.output);
    assert.equal(backdatedLegacySingle.evidence().forgetRequests, 0);
    const review = backdatedLegacySingle.state().drive_removal_review;
    assert.equal(review.counts.unresolved_not_returned, 1);
    assert.equal(review.counts.pending_source_deletions, 0,
      "one current observation inherited maturity from a legacy local timestamp");
    assert.equal(review.unresolved_not_returned[0].observations.length, 1);
  } finally {
    backdatedLegacySingle.cleanup();
  }

  const clockSkewedRepeat = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    priorClockSkewHours: 48,
  });
  try {
    assert.equal(clockSkewedRepeat.code, 0, clockSkewedRepeat.output);
    assert.match(clockSkewedRepeat.output, /observation at .* disagreed with server time/i);
    assert.match(clockSkewedRepeat.output, /a new consistent observation is needed/i);
    assert.match(clockSkewedRepeat.output, /seven days must still elapse after a consistent observation/i);
    assert.doesNotMatch(clockSkewedRepeat.output, /run Drive ingestion again after the recorded seven-day grace date/i);
    const review = clockSkewedRepeat.state().drive_removal_review;
    assert.equal(review.counts.pending_source_deletions, 0,
      "a Drive absence matured despite a local/server clock disagreement over 24 hours");
    assert.equal(review.unresolved_not_returned[0].observations.length, 2);
  } finally {
    clockSkewedRepeat.cleanup();
  }

  const laterConsistentPair = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 20,
    priorObservation: true,
    priorClockSkewHours: 48,
    priorConsistentObservationDays: 9,
  });
  try {
    assert.equal(laterConsistentPair.code, 1, laterConsistentPair.output);
    assert.match(laterConsistentPair.output, /two walks at least seven days apart/i);
    assert.doesNotMatch(laterConsistentPair.output, /a new consistent observation is needed/i);
    const review = laterConsistentPair.state().drive_removal_review;
    assert.equal(review.counts.pending_source_deletions, 1,
      "an older skewed observation poisoned a later consistent seven-day pair");
    assert.equal(review.source_deletion_candidates[0].corroboration, "repeated_not_returned");
    assert.equal(laterConsistentPair.evidence().forgetRequests, 0);
  } finally {
    laterConsistentPair.cleanup();
  }

  const missingServerDate = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    inventoryDate: false,
  });
  try {
    assert.equal(missingServerDate.code, 0, missingServerDate.output);
    assert.match(missingServerDate.output, /did not provide a valid server time/i);
    assert.match(missingServerDate.output, /unanchored absence observations receive no credit/i);
    assert.match(missingServerDate.output, /two earlier qualifying server-anchored observations can still complete an approval/i);
    assert.doesNotMatch(missingServerDate.output, /unexpected error|INGEST_FAILED/i);
    assert.equal(missingServerDate.evidence().forgetRequests, 0);
    const state = missingServerDate.state();
    assert.equal(state.sync_token, "fixture-prewalk-full-unresolved",
      "a missing inventory Date header withheld the completed Drive cursor");
    assert.equal(state.drive_removal_review.counts.pending_source_deletions, 0);
    assert.equal(state.drive_removal_review.counts.unresolved_not_returned, 1);
    assert.ok(state.drive_removal_review.unresolved_not_returned[0].observations.some(
      (observation) => observation.server_observed_at === null,
    ), "the unanchored observation was not retained with a null server timestamp");
  } finally {
    missingServerDate.cleanup();
  }

  const elapsedRepeat = runScopeScenario("full-unresolved", {
    full: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
    args: ["--reset"],
  });
  try {
    assert.equal(elapsedRepeat.code, 1, elapsedRepeat.output);
    assert.match(elapsedRepeat.output, /two walks at least seven days apart/i);
    assert.match(elapsedRepeat.output, /Owner tax return\.txt \(folder: Reviewed Root\/Tax\)/);
    elapsedApproval = /--approve-removals ([0-9a-f]{64})/.exec(elapsedRepeat.output)?.[1];
    assert.ok(elapsedApproval, "the elapsed approval stop did not print an approval fingerprint");
    assert.ok(
      elapsedRepeat.output.includes(renderCliCommands(
        `brain ingest <manifest> --from drive --approve-removals ${elapsedApproval}`,
      )),
      "the elapsed approval stop did not show the exact platform-rendered retry command",
    );
    assert.equal(elapsedRepeat.evidence().forgetRequests, 0,
      "an elapsed grace window bypassed exact approval");
    const review = elapsedRepeat.state().drive_removal_review;
    assert.equal(review.counts.unresolved_not_returned, 0);
    assert.equal(review.counts.pending_source_deletions, 1);
    assert.equal(review.source_deletion_candidates[0].corroboration, "repeated_not_returned");
    assert.ok(
      Date.parse(review.source_deletion_candidates[0].last_observed_at) >=
        Date.parse(review.source_deletion_candidates[0].grace_eligible_at),
      "the elapsed candidate did not retain its dated grace proof",
    );
  } finally {
    elapsedRepeat.cleanup();
  }

  const boundedObservations = runScopeScenario("incremental-stale-marker-404", {
    pendingRemoval: true,
    priorNotReturnedDays: 8,
    priorObservation: true,
  });
  try {
    assert.equal(boundedObservations.code, 1, boundedObservations.output);
    for (let run = 2; run <= 30; run++) {
      const repeated = boundedObservations.rerun();
      assert.equal(repeated.code, 1, `Drive observation run ${run} failed:\n${repeated.output}`);
    }
    const [record] = boundedObservations.state().drive_removal_review.source_deletion_candidates;
    assert.equal(record.observation_count, 31,
      "the bounded review lost the cumulative prior-plus-30-run observation count");
    assert.ok(record.observations.length <= 11,
      `the bounded review retained ${record.observations.length} observation rows`);
    assert.equal(record.observations[0].run_id, "sync_fixture_prior_observation",
      "the bounded review discarded its first proof endpoint");
    assert.equal(new Set(record.observations.map((observation) => observation.run_id)).size,
      record.observations.length, "the bounded review retained duplicate run observations");
    assert.equal(record.corroboration, "repeated_not_returned",
      "the bounded observation shape no longer matured after seven days");
    assert.equal(boundedObservations.evidence().forgetRequests, 0);
  } finally {
    boundedObservations.cleanup();
  }

  const restoredReview = runScopeScenario("incremental-restored", { priorReview: true });
  try {
    assert.equal(restoredReview.code, 0, restoredReview.output);
    assert.equal(restoredReview.evidence().forgetRequests, 0);
    assert.equal(restoredReview.state().drive_removal_review, undefined,
      "a later complete walk that found the file left a stale Drive review record");
  } finally {
    restoredReview.cleanup();
  }

  for (const mode of ["incremental-trash", "incremental-left-scope"]) {
    const confirmed = runScopeScenario(mode);
    try {
      assert.equal(confirmed.code, 0, confirmed.output);
      const evidence = confirmed.evidence();
      assert.equal(evidence.absenceMetadataReads, 1, `${mode} did not classify the removed file`);
      assert.equal(evidence.rootedWalks, 0, `${mode} unexpectedly required a full walk`);
      assert.equal(evidence.forgetRequests, 1, `${mode} did not reach the guarded removal plan`);
      assert.equal(evidence.removedFamilies, 1);
      assert.equal(evidence.inventoryReads, 3,
        "confirmed removal lacked its base inventory, targeted label read, or exact readback");
      assert.equal(evidence.ingestBatchWrites, 0);
      const state = confirmed.state();
      assert.equal(state.sync_token, `fixture-next-${mode}`);
      assert.equal(state.drive_last_full_sweep_at, confirmed.priorFullSweep,
        "an incremental classified removal rewrote the full-sweep checkpoint");
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
const assertIndex = remote.indexOf(`assertDriveRemovalPlanSafe(${planName}`, buildIndex);
const firstTargetUseIndex = remote.indexOf(`${planName}.targets`, buildIndex);
const targetUseIndex = remote.indexOf(`${planName}.targets[category]`, assertIndex);
assert.match(
  remote,
  /const applyPreparedRemovals = options\.applyDriveRemovals \?\? applyDriveRemovals;/,
  "the injectable removal seam must default to the guarded production operation",
);
assert.match(
  remote,
  /const listPreparedSourceFamilies = options\.listStoredSourceFamilies \?\? listStoredSourceFamilies;/,
  "the injectable readback seam must default to the production inventory operation",
);
const applicationIndex = remote.lastIndexOf("applyPreparedRemovals(", targetUseIndex);
assert.ok(assertIndex > buildIndex, "the aggregate Drive removal plan must be checked");
assert.ok(firstTargetUseIndex > assertIndex, "plan targets must not be read before the guard passes");
assert.ok(
  applicationIndex > assertIndex && applicationIndex < targetUseIndex,
  "only guarded plan targets may reach Drive removal",
);
const readbackIndex = remote.indexOf("const afterRemoval = await listPreparedSourceFamilies", targetUseIndex);
const cursorPlanIndex = remote.indexOf("pendingCursor = {", readbackIndex);
assert.ok(
  readbackIndex > targetUseIndex,
  "planned Drive removals must be checked against a fresh stored-family inventory",
);
assert.ok(
  cursorPlanIndex > readbackIndex,
  "the Drive cursor plan must remain withheld until deletion readback succeeds",
);

const buildCall = remote.slice(buildIndex, assertIndex);
for (const field of ["storedFamilies", "activeFamilies", "policyCandidates", "vanishedCandidates", "intentionalCandidates"]) {
  assert.match(buildCall, new RegExp(`\\b${field}\\b`), `aggregate Drive removal plan is missing ${field}`);
}
const approvalCall = remote.slice(assertIndex, targetUseIndex);
assert.match(approvalCall, /(?:flags\["approve-removals"\]|removalApproval)/,
  "the CLI approval value must reach the aggregate guard");
if (/\bremovalApproval\b/.test(approvalCall)) {
  const approvalAssignment = remote.indexOf('const removalApproval = flags["approve-removals"]');
  const approvalValidation = remote.indexOf("typeof removalApproval", approvalAssignment);
  assert.ok(
    approvalAssignment !== -1 && approvalAssignment < approvalValidation && approvalValidation < buildIndex &&
      remote.slice(approvalValidation, buildIndex).includes("/^[0-9a-f]{64}$/"),
    "the approval alias must be the validated lowercase SHA-256 CLI value",
  );
}

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
const localGuardIndex = local.indexOf("assertDriveRemovalPlanSafe(localRemovalPlan", localBuildIndex);
const localTargetsIndex = local.indexOf("const localTruthTargets", localGuardIndex);
const localApplyIndex = local.indexOf("uids: localTruthTargets", localTargetsIndex);
const localReadbackIndex = local.indexOf("const afterLocalRemoval = await listPreparedSourceFamilies", localApplyIndex);
assert.ok(
  pendingIndex !== -1 && localInventoryIndex > pendingIndex && localBuildIndex > localInventoryIndex,
  "local removal retries must re-enter a plan built from authenticated stored families",
);
assert.doesNotMatch(
  local.slice(pendingIndex, localBuildIndex),
  /applyDriveRemovals\s*\(/,
  "a pending local removal must not bypass the current authenticated plan",
);
assert.match(
  local.slice(localBuildIndex, localGuardIndex),
  /storedFamilies:\s*storedLocalFamilies/,
  "local deletion must not use the resume file as its stored-family denominator",
);
assert.ok(
  localGuardIndex > localBuildIndex && localTargetsIndex > localGuardIndex && localApplyIndex > localTargetsIndex,
  "only guarded local plan targets may reach the destructive endpoint",
);
assert.match(
  local.slice(localTargetsIndex, localApplyIndex),
  /localRemovalPlan\.targets\.source_policy[\s\S]*localRemovalPlan\.targets\.intentional_skip/,
  "local source-truth deletion must use the exact categorized plan targets",
);
assert.ok(
  localReadbackIndex > localApplyIndex,
  "local folder deletion must read authenticated storage back before recording completion",
);
assert.match(
  local.slice(localReadbackIndex),
  /stillStored[\s\S]*state\.removed[\s\S]*throw new Error/,
  "a failed local deletion readback must retain retry state and fail the source run",
);

console.log("drive removal guard: all focused tests passed");
