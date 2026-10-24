import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";

const target = process.env.BRAIN_RENAME_WRITER_TARGET;
const eventsPath = process.env.BRAIN_RENAME_WRITER_EVENTS;
const mode = process.env.BRAIN_RENAME_WRITER_MODE;
assert.ok(target && eventsPath && ["control", "transient", "terminal"].includes(mode));
const manifest = JSON.parse(fs.readFileSync(process.env.BRAIN_RENAME_WRITER_INPUT, "utf8"));
const verifierUrl = new URL("../../operations/package-bundle-verifier.mjs", import.meta.url).href;

// Only generation input is synthetic. The actual CLI parses its arguments,
// stages its manifest, retries the native rename, and handles terminal errors.
registerHooks({ load(url, context, nextLoad) {
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
  if (mode === "terminal" || (mode === "transient" && stats.calls === 1)) {
    throw Object.assign(new Error("synthetic rename refusal"), { code: "EACCES" });
  }
  return originalRename(from, to);
};
syncBuiltinESMExports();
process.once("exit", () => fs.writeFileSync(eventsPath, JSON.stringify(stats)));
