import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  cmdProvenanceAssess,
  pinProvenanceAssessmentRoot,
  revalidateProvenanceAssessmentRoot,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import * as assessmentLib from "../operations/provenance-source-assessment.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_MANIFEST = "/private/owner/brain.manifest.json";
const PRIVATE_ROOT = "/private/owner/source";
const PRIVATE_TARGET = "sensitive-first-record.txt";

function manifestPin(overrides = {}) {
  return {
    manifest: {
      corpora: {
        local_folder: {
          enabled: true,
          source: "localdocs",
          path: PRIVATE_ROOT,
          ...overrides,
        },
      },
      safety: { private_path_prefixes: [] },
    },
  };
}

async function safeAssessment() {
  return assessmentLib.assessLocalProvenanceSource({
    sourceKind: "upload",
    root: PRIVATE_ROOT,
    relativeLocators: [PRIVATE_TARGET],
  }, {
    listOriginals: async () => ({
      originals: [{ _assessmentLocator: PRIVATE_TARGET }],
      traversal_complete: true,
      traversal_gap_count: 0,
      target_resolution_complete: true,
      missing_target_count: 0,
    }),
    observeOriginal: async () => ({
      state: "native_readable",
      format: "txt",
      text_reliable: true,
      extraction_complete: true,
    }),
  });
}

test("standalone assessment parses before manifest IO and emits one identity-free JSON receipt", async () => {
  let manifestReads = 0;
  await assert.rejects(
    cmdProvenanceAssess([PRIVATE_MANIFEST, "--source", "localdocs", "--json"], {
      assessmentLib,
      pinManifest() { manifestReads += 1; },
    }),
    (error) => error?.payload?.blockers?.[0] === "invalid_request",
  );
  assert.equal(manifestReads, 0);

  const output = [];
  const receipt = await cmdProvenanceAssess([
    PRIVATE_MANIFEST,
    "--source", "localdocs",
    "--target", PRIVATE_TARGET,
    "--json",
  ], {
    assessmentLib,
    pinManifest: () => manifestPin(),
    pinRoot: () => ({ path: PRIVATE_ROOT, stat: Object.freeze({}) }),
    revalidateRoot: () => true,
    assess: safeAssessment,
    write: (line) => output.push(line),
  });
  assert.equal(receipt.assessment_complete, true);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), receipt);
  for (const privateValue of [PRIVATE_MANIFEST, PRIVATE_ROOT, PRIVATE_TARGET, "localdocs"]) {
    assert.equal(output[0].includes(privateValue), false);
  }
});
test("manifest, root, and assessment failures remain fixed and perform no later boundary", async () => {
  let rootReads = 0;
  let assessments = 0;
  await assert.rejects(cmdProvenanceAssess([
    PRIVATE_MANIFEST, "--source", "localdocs", "--target", PRIVATE_TARGET, "--json",
  ], {
    assessmentLib,
    pinManifest: () => manifestPin({ source: "another-source" }),
    pinRoot() { rootReads += 1; },
    assess() { assessments += 1; },
  }), (error) => error?.payload?.blockers?.[0] === "manifest_policy_invalid");
  assert.equal(rootReads, 0);
  assert.equal(assessments, 0);

  await assert.rejects(cmdProvenanceAssess([
    PRIVATE_MANIFEST, "--source", "localdocs", "--target", PRIVATE_TARGET, "--json",
  ], {
    assessmentLib,
    pinManifest: () => manifestPin(),
    pinRoot: () => { throw new Error(PRIVATE_ROOT); },
    assess() { assessments += 1; },
  }), (error) => error?.payload?.blockers?.[0] === "source_unavailable");
  assert.equal(assessments, 0);

  await assert.rejects(cmdProvenanceAssess([
    PRIVATE_MANIFEST, "--source", "localdocs", "--target", PRIVATE_TARGET, "--json",
  ], {
    assessmentLib,
    pinManifest: () => manifestPin(),
    pinRoot: () => ({ path: PRIVATE_ROOT, stat: Object.freeze({}) }),
    assess: safeAssessment,
    revalidateRoot: () => { throw new Error(PRIVATE_TARGET); },
  }), (error) => error?.payload?.blockers?.[0] === "assessment_failed");
});

test("assessment is exempt from the process-wide Wrangler credential boundary", async () => {
  let commandCalls = 0;
  let wrapperCalls = 0;
  const result = await runCliCommandWithCredentialBoundary("provenance-assess", async () => {
    commandCalls += 1;
    return "local";
  }, {
    withWranglerSession: async () => {
      wrapperCalls += 1;
      return "remote";
    },
  });
  assert.equal(result, "local");
  assert.equal(commandCalls, 1);
  assert.equal(wrapperCalls, 0);
});

test("real root pinning detects a source-directory scope change", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "brain-provenance-assess-pin-")));
  try {
    const pin = pinProvenanceAssessmentRoot(fixture);
    writeFileSync(join(fixture, "new.txt"), "changed");
    const changed = pinProvenanceAssessmentRoot(fixture);
    assert.notDeepEqual(changed.directEntries, pin.directEntries);
    // NTFS may not expose an immediate parent-directory timestamp change. Make
    // that observed blind spot explicit and prove the entry fingerprint closes it.
    const timestampBlindPin = Object.freeze({ ...pin, stat: changed.stat });
    assert.throws(
      () => revalidateProvenanceAssessmentRoot(timestampBlindPin),
      /changed during assessment/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("real root pinning refuses a linked ancestor", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "brain-provenance-assess-link-")));
  const targetParent = join(fixture, "target");
  const targetRoot = join(targetParent, "source");
  const linkedParent = join(fixture, "linked");
  try {
    mkdirSync(targetRoot, { recursive: true });
    symlinkSync(targetParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => pinProvenanceAssessmentRoot(join(linkedParent, "source")),
      /assessment source root is not direct/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installed CLI succeeds locally and failures create no support journal", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "brain-provenance-assess-cli-")));
  const home = join(fixture, "home");
  const source = join(fixture, "source");
  const manifest = join(fixture, "brain.manifest.json");
  mkdirSync(home);
  mkdirSync(source);
  writeFileSync(join(source, "first.txt"),
    "A sufficiently clear native first document for the exact local provenance assessment.");
  writeFileSync(manifest, `${JSON.stringify({
    corpora: { local_folder: { enabled: true, source: "localdocs", path: source } },
    safety: { private_path_prefixes: [] },
  })}\n`);
  const env = {
    PATH: process.env.PATH || "",
    HOME: home,
    USERPROFILE: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
  try {
    const good = spawnSync(process.execPath, [
      join(ROOT, "brain.mjs"), "provenance-assess", manifest,
      "--source", "localdocs", "--target", "first.txt", "--json",
    ], { cwd: fixture, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(good.status, 0, good.stderr || good.stdout);
    assert.equal(good.stderr, "");
    assert.equal(JSON.parse(good.stdout).assessment_complete, true);

    const bad = spawnSync(process.execPath, [
      join(ROOT, "brain.mjs"), "provenance-assess", manifest,
      "--source", "localdocs", "--target", "first.txt", "--apply", "--json",
    ], { cwd: fixture, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr, "");
    assert.equal(JSON.parse(bad.stdout).blockers[0], "invalid_request");
    assert.equal(readdirSync(home).length, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
