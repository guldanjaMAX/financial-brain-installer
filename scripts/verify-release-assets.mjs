#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyRelease({ phase, release, tag, assetPaths }) {
  if (phase !== "draft" && phase !== "published") {
    throw new Error("phase must be draft or published");
  }
  // `gh release view --json` uses GraphQL-style camelCase while `gh api`
  // returns the REST shape. Accept both so the publish gate can validate the
  // exact numeric release rather than resolving the tag a second time.
  const releaseTag = release?.tagName ?? release?.tag_name;
  const isDraft = release?.isDraft ?? release?.draft;
  const isImmutable = release?.isImmutable ?? release?.immutable;
  if (releaseTag !== tag) {
    throw new Error(`release tag ${releaseTag ?? "missing"} does not match ${tag}`);
  }
  const tagMatch = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!tagMatch) throw new Error(`release tag ${tag} is not vMAJOR.MINOR.PATCH`);
  const requiredNames = new Set([
    `brain-installer-${tagMatch[1]}.tgz`,
    "brain-installer.tgz",
    `brain-installer-${tagMatch[1]}-runtime-identity.json`,
  ]);
  const suppliedNames = new Set(assetPaths.map((path) => basename(path)));
  if (assetPaths.length !== 3 || suppliedNames.size !== 3 ||
      [...requiredNames].some((name) => !suppliedNames.has(name))) {
    throw new Error(
      `asset paths must be brain-installer-${tagMatch[1]}.tgz, ` +
      `brain-installer.tgz, and brain-installer-${tagMatch[1]}-runtime-identity.json`,
    );
  }
  if (phase === "draft" && isDraft !== true) {
    throw new Error("release must remain a draft during byte verification");
  }
  if (phase === "published" && (isDraft !== false || isImmutable !== true)) {
    throw new Error("published release is not immutable");
  }

  const expected = assetPaths.map((path) => ({
    name: basename(path),
    size: statSync(path).size,
    digest: `sha256:${sha256(path)}`,
  }));
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (assets.length !== expected.length) {
    throw new Error(`release has ${assets.length} assets, expected ${expected.length}`);
  }

  const actualByName = new Map();
  for (const asset of assets) {
    if (!asset?.name || actualByName.has(asset.name)) {
      throw new Error(`release contains an invalid or duplicate asset name: ${asset?.name ?? "missing"}`);
    }
    actualByName.set(asset.name, asset);
  }
  for (const item of expected) {
    const asset = actualByName.get(item.name);
    if (!asset) throw new Error(`release is missing ${item.name}`);
    if (asset.state !== "uploaded") throw new Error(`${item.name} is not fully uploaded`);
    if (asset.size !== item.size) {
      throw new Error(`${item.name} size ${asset.size} does not match ${item.size}`);
    }
    if (asset.digest !== item.digest) {
      throw new Error(`${item.name} digest ${asset.digest ?? "missing"} does not match ${item.digest}`);
    }
  }

  const expectedByName = new Map(expected.map((item) => [item.name, item]));
  const versioned = expectedByName.get(`brain-installer-${tagMatch[1]}.tgz`);
  const canonical = expectedByName.get("brain-installer.tgz");
  if (!versioned || !canonical || versioned.size !== canonical.size ||
      versioned.digest !== canonical.digest) {
    throw new Error("canonical and versioned assets are not byte-identical");
  }
  return expected;
}

function main(argv) {
  if (argv.length !== 6) {
    throw new Error(
      "usage: verify-release-assets.mjs <draft|published> <release.json> <tag> " +
      "<versioned.tgz> <canonical.tgz> <runtime-identity.json>",
    );
  }
  const [phase, jsonPath, tag, ...assetPaths] = argv;
  const release = JSON.parse(readFileSync(jsonPath, "utf8"));
  const verified = verifyRelease({ phase, release, tag, assetPaths });
  for (const asset of verified) {
    console.log(`${asset.name} ${asset.size} ${asset.digest}`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`release asset verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
