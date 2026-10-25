import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { pinStagingMtime, rewriteStagingInPlace } from "./rename-retry-staging.mjs";

const target = process.env.BRAIN_RENAME_WRITER_TARGET;
const eventsPath = process.env.BRAIN_RENAME_WRITER_EVENTS;
const mode = process.env.BRAIN_RENAME_WRITER_MODE;
assert.ok(target && eventsPath && ["control", "transient", "terminal", "fstat-refusal", "race-destination", "race-staging", "race-staging-in-place"].includes(mode));
const manifest = JSON.parse(fs.readFileSync(process.env.BRAIN_RENAME_WRITER_INPUT, "utf8"));
pinStagingMtime(dirname(target));
const helperUrl = new URL("../../operations/rename-retry.mjs", import.meta.url).href;
const verifierUrl = new URL("../../operations/package-bundle-verifier.mjs", import.meta.url).href;

// Only generation input is synthetic. The actual CLI parses its arguments,
// stages its manifest, retries the native rename, and handles terminal errors.
registerHooks({ load(url, context, nextLoad) {
  if (url === helperUrl && process.env.BRAIN_RENAME_TEST_PLATFORM) {
    const result = nextLoad(url, context);
    const parts = String(result.source).split("platform = process.platform,");
    assert.equal(parts.length, 4, "baseline capture and both rename APIs expose their platform default");
    return { ...result, source: parts.join("platform = process.env.BRAIN_RENAME_TEST_PLATFORM ?? process.platform,") };
  }
  if (url !== verifierUrl) return nextLoad(url, context);
  return {
    format: "module", shortCircuit: true,
    source: `
      export class PackageBundleVerificationError extends Error {}
      export const REVIEWED_BUNDLE_MANIFEST_RELATIVE = "reviewed.json";
      export function buildReviewedBundleManifest(options) {
        if (!options.root || !options.cacheContentRoot) throw new Error("missing synthetic generation options");
        return ${JSON.stringify(manifest)};
      }
      export function assertPackedBundleArchive() { throw new Error("unexpected archive verification"); }
      export function readStableNpmPackMetadata() { throw new Error("unexpected metadata read"); }
      export function resolveNpmCacheContentRoot() { throw new Error("unexpected cache lookup"); }
    `,
  };
} });
const originalRename = fs.renameSync;
const stats = { calls: 0, samePath: true, sameBytes: true, sameInode: true };
let staged;
let bytes;
let inode;

if (mode === "fstat-refusal") {
  const nativeOpen = fs.openSync, nativeStat = fs.fstatSync, nativeClose = fs.closeSync;
  let createdDescriptor;
  stats.createFstatFailed = false;
  stats.createdDescriptorClosed = false;
  fs.openSync = (path, flags, ...args) => {
    const descriptor = nativeOpen(path, flags, ...args);
    if (path === `${target}.tmp` && flags === "wx") createdDescriptor = descriptor;
    return descriptor;
  };
  fs.fstatSync = (descriptor, ...args) => {
    if (descriptor === createdDescriptor && !stats.createFstatFailed) {
      stats.createFstatFailed = true;
      throw Object.assign(new Error("synthetic staging stat refusal"), { code: "EIO" });
    }
    return nativeStat(descriptor, ...args);
  };
  fs.closeSync = descriptor => {
    if (descriptor === createdDescriptor) stats.createdDescriptorClosed = true;
    return nativeClose(descriptor);
  };
}

// The rename injection changes only the synthetic destination.
fs.renameSync = (from, to) => {
  if (to !== target) return originalRename(from, to);
  stats.calls++;
  staged ??= from;
  bytes ??= fs.readFileSync(from);
  inode ??= fs.statSync(from).ino;
  stats.samePath &&= staged === from;
  stats.sameBytes &&= bytes.equals(fs.readFileSync(from));
  stats.sameInode &&= inode === fs.statSync(from).ino;
  if (mode.startsWith("race-") && stats.calls === 1) {
    if (mode === "race-staging-in-place") {
      rewriteStagingInPlace(from);
      stats.inPlaceInvisible = true;
    } else {
      const substitute = `${target}.substitute`;
      fs.writeFileSync(substitute, "synthetic concurrent replacement\n", { flag: "wx" });
      const changed = mode === "race-destination" ? to : from;
      if (fs.existsSync(changed)) originalRename(changed, `${from}.displaced`);
      originalRename(substitute, changed);
      stats.replacementInode = fs.lstatSync(changed, { bigint: true }).ino.toString();
    }
    throw Object.assign(new Error("synthetic rename refusal"), { code: "EACCES" });
  }
  if (mode === "terminal" || (mode === "transient" && stats.calls === 1)) {
    throw Object.assign(new Error("synthetic rename refusal"), { code: "EACCES" });
  }
  return originalRename(from, to);
};
syncBuiltinESMExports();
process.once("exit", () => fs.writeFileSync(eventsPath, JSON.stringify(stats)));
