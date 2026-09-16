#!/usr/bin/env node
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PackageBundleVerificationError,
  REVIEWED_BUNDLE_MANIFEST_RELATIVE,
  assertPackedBundleArchive,
  buildReviewedBundleManifest,
  readStableNpmPackMetadata,
  resolveNpmCacheContentRoot,
} from "../operations/package-bundle-verifier.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name.slice(2)}_required`);
  return value;
}

function help() {
  return `Verify an already-built package:
  node scripts/verify-package-bundles.mjs --package <tgz> --metadata <npm-pack.json> \\
    [--cache-content-root <npm-cache>/_cacache/content-v2/sha512] [--json]

Regenerate the reviewed compact manifest from exact npm cache integrity objects:
  node scripts/verify-package-bundles.mjs --generate \\
    --cache-content-root <npm-cache>/_cacache/content-v2/sha512 \\
    --output privacy/reviewed-package-bundles.json [--replace]

Generation never contacts a registry. Review the complete manifest diff before accepting it.`;
}

function writeManifest(path, manifest, replace) {
  const output = resolve(path);
  if (existsSync(output) && !replace) throw new Error("manifest_exists_use_replace");
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  renameSync(temporary, output);
}

async function main(argv) {
  if (argv.includes("--help")) {
    console.log(help());
    return;
  }
  const root = resolve(option(argv, "--root") || ROOT);
  if (argv.includes("--generate")) {
    const cacheContentRoot = option(argv, "--cache-content-root");
    const output = option(argv, "--output") ||
      resolve(root, REVIEWED_BUNDLE_MANIFEST_RELATIVE);
    if (!cacheContentRoot) throw new Error("cache_content_root_required");
    const manifest = buildReviewedBundleManifest({ root, cacheContentRoot });
    writeManifest(output, manifest, argv.includes("--replace"));
    console.log(`PASS generated ${manifest.bundles.length} lock-integrity bundle records at ${output}`);
    return;
  }
  const archivePath = option(argv, "--package");
  const metadataPath = option(argv, "--metadata");
  if (!archivePath || !metadataPath) throw new Error("package_and_metadata_required");
  const cacheContentRoot = option(argv, "--cache-content-root") ||
    resolveNpmCacheContentRoot(process.env);
  const proof = assertPackedBundleArchive({
    root,
    archivePath: resolve(archivePath),
    metadata: readStableNpmPackMetadata(resolve(metadataPath)),
    cacheContentRoot,
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ status: "passed", ...proof }));
    return;
  }
  console.log(
    `PASS package bundles: ${proof.bundle_count} packages, ` +
    `${proof.bundle_file_count} files, ${proof.bundle_bytes} bytes, ` +
    `inventory sha256:${proof.inventory_sha256}, ` +
    `runtime identity ${proof.identity_scheme} ` +
    `sha256:${proof.runtime_payload_sha256}, ` +
    `package sha256:${proof.archive_sha256}`,
  );
}

main(process.argv.slice(2)).catch((error) => {
  const code = error instanceof PackageBundleVerificationError
    ? error.code
    : String(error?.message || "package_bundle_verification_failed")
      .toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")
      .slice(0, 80);
  console.error(`Package bundle verification failed: ${code || "package_bundle_verification_failed"}`);
  process.exitCode = 1;
});
