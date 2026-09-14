import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  PackageBundleVerificationError,
  assertPackedBundleArchive,
  assertPackedBundleMetadata,
  assertPackedBundleRows,
  buildReviewedBundleManifest,
  bundleManifestInventorySha256,
  inspectNpmArchiveBytes,
  loadVerifiedBundleContract,
  materializeVerifiedBundleCache,
  readStableNpmPackMetadata,
  readStableRegularFile,
  resolveNpmCacheContentRoot,
} from "../operations/package-bundle-verifier.mjs";
import { deriveUpdateRuntimePayloadSha256 } from "../operations/update-preview.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_CONTENT_ROOT = resolveNpmCacheContentRoot(process.env);
const BUNDLE_COUNTS = Object.freeze({
  "@e965/xlsx": 26,
  fflate: 17,
  "postal-mime": 26,
  unpdf: 157,
});

let temporary;
let metadata;
let archivePath;
let archiveRows;

function safeEnvironment(root) {
  return {
    PATH: process.env.PATH || "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    HOME: root,
    USERPROFILE: root,
    NPM_CONFIG_CACHE: join(root, "npm-cache"),
    NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "npm-globalrc"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NO_UPDATE_NOTIFIER: "1",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function privateTemporary(prefix) {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  assert.ok(bytes.length <= length, `tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  assert.equal(text.length, length - 1);
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function craftedUstarEntry({
  path,
  name = null,
  prefix = null,
  content = Buffer.from("x"),
  mode = 0o644,
  magicVersion = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30]),
}) {
  const header = Buffer.alloc(512);
  const archivedPath = path ? `package/${path}` : null;
  writeTarText(header, 0, 100, name || archivedPath);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  assert.equal(magicVersion.length, 8);
  magicVersion.copy(header, 257);
  if (prefix) writeTarText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  assert.equal(checksumText.length, 6);
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return [header, padded];
}

function craftedUstar(entries, {
  terminalBlocks = 2,
  dirtyTerminatorOffset = null,
  tail = Buffer.alloc(0),
} = {}) {
  const parts = entries.flatMap(craftedUstarEntry);
  const terminator = Buffer.alloc(terminalBlocks * 512);
  if (dirtyTerminatorOffset !== null) terminator[dirtyTerminatorOffset] = 1;
  const tar = Buffer.concat([...parts, terminator, tail]);
  try {
    return gzipSync(tar, { level: 9, mtime: 0 });
  } finally {
    tar.fill(0);
  }
}

function expectCode(code) {
  return (error) => error instanceof PackageBundleVerificationError && error.code === code;
}

function verificationOptions(extra = {}) {
  return { root: ROOT, cacheContentRoot: CACHE_CONTENT_ROOT, ...extra };
}

function filesBelow(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

before(() => {
  temporary = privateTemporary("brain-package-bundle-verifier-");
  const result = spawnSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", temporary,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: safeEnvironment(temporary),
    shell: process.platform === "win32",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  metadata = report[0];
  archivePath = join(temporary, metadata.filename);
  archiveRows = inspectNpmArchiveBytes(readFileSync(archivePath)).rows;
});

after(() => {
  rmSync(temporary, { recursive: true, force: true });
});

test("the exact packed archive contains all four reviewed lock-derived bundles", () => {
  const proof = assertPackedBundleArchive(verificationOptions({ metadata, archivePath }));
  const archive = readFileSync(archivePath);
  assert.equal(proof.archive_bytes, metadata.size);
  assert.equal(
    proof.archive_sha256,
    createHash("sha256").update(archive).digest("hex"),
  );
  assert.equal(
    proof.archive_integrity,
    `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  );
  assert.equal(proof.archive_shasum, createHash("sha1").update(archive).digest("hex"));
  assert.equal(proof.archive_file_count, metadata.entryCount);
  assert.equal(proof.archive_unpacked_bytes, metadata.unpackedSize);
  assert.equal(proof.identity_scheme, "brain.runtime-payload.sha256.v1");
  assert.equal(
    proof.runtime_payload_sha256,
    deriveUpdateRuntimePayloadSha256(
      archiveRows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    ),
  );
  assert.deepEqual(Object.keys(proof).sort(), [
    "archive_bytes",
    "archive_file_count",
    "archive_integrity",
    "archive_sha256",
    "archive_shasum",
    "archive_unpacked_bytes",
    "bundle_bytes",
    "bundle_count",
    "bundle_file_count",
    "identity_scheme",
    "inventory_sha256",
    "runtime_payload_sha256",
  ]);
  assert.deepEqual({
    bundle_count: proof.bundle_count,
    bundle_file_count: proof.bundle_file_count,
    bundle_bytes: proof.bundle_bytes,
    inventory_sha256: proof.inventory_sha256,
  }, {
    bundle_count: 4,
    bundle_file_count: 226,
    bundle_bytes: 11_340_570,
    inventory_sha256: "0e86bf795f93b456e16b9000efc10a5579ee2ea9c606411f9d50de3e5ecfc08e",
  });
  for (const [name, count] of Object.entries(BUNDLE_COUNTS)) {
    assert.equal(
      archiveRows.filter((row) => row.path.startsWith(`node_modules/${name}/`)).length,
      count,
    );
  }
});

test("the original npm receipt is digest-bound to the final compressed archive", () => {
  const fixture = privateTemporary("brain-bundle-archive-binding-");
  const changedArchivePath = join(fixture, metadata.filename);
  const originalReceipt = JSON.stringify(metadata);
  try {
    const changedArchive = Buffer.from(readFileSync(archivePath));
    changedArchive[0] ^= 1;
    writeFileSync(changedArchivePath, changedArchive, { mode: 0o600 });
    changedArchive.fill(0);
    assert.throws(
      () => assertPackedBundleArchive(verificationOptions({
        metadata,
        archivePath: changedArchivePath,
      })),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH"),
    );

    const wrongIntegrity = clone(metadata);
    const integrityIndex = "sha512-".length;
    wrongIntegrity.integrity = `${wrongIntegrity.integrity.slice(0, integrityIndex)}` +
      `${wrongIntegrity.integrity[integrityIndex] === "A" ? "B" : "A"}` +
      `${wrongIntegrity.integrity.slice(integrityIndex + 1)}`;
    assert.throws(
      () => assertPackedBundleArchive(verificationOptions({
        metadata: wrongIntegrity,
        archivePath,
      })),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH"),
    );

    const wrongShasum = clone(metadata);
    wrongShasum.shasum = `${wrongShasum.shasum[0] === "0" ? "1" : "0"}` +
      wrongShasum.shasum.slice(1);
    assert.throws(
      () => assertPackedBundleArchive(verificationOptions({
        metadata: wrongShasum,
        archivePath,
      })),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_METADATA_MISMATCH"),
    );

    const malformedIntegrity = clone(metadata);
    malformedIntegrity.integrity = `SHA512-${metadata.integrity.slice("sha512-".length)}`;
    assert.throws(
      () => assertPackedBundleMetadata(verificationOptions({ metadata: malformedIntegrity })),
      expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
    );

    const malformedShasum = clone(metadata);
    malformedShasum.shasum = `A${metadata.shasum.slice(1)}`;
    assert.throws(
      () => assertPackedBundleMetadata(verificationOptions({ metadata: malformedShasum })),
      expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
    );
    assert.equal(JSON.stringify(metadata), originalReceipt);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("crafted archives require exact USTAR magic and version before applying prefix", () => {
  const valid = craftedUstar([{ name: "x", prefix: "package" }]);
  assert.deepEqual(inspectNpmArchiveBytes(valid).rows.map(({ path }) => path), ["x"]);

  const invalidMagicVersions = [
    Buffer.from("ustar 00", "ascii"),
    Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0, 0, 0]),
  ];
  for (const magicVersion of invalidMagicVersions) {
    const archive = craftedUstar([{ name: "x", prefix: "package", magicVersion }]);
    assert.throws(
      () => inspectNpmArchiveBytes(archive),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
    );
  }
});

test("crafted archives require aligned output and two complete terminal zero blocks", () => {
  const entry = { path: "x" };
  assert.throws(
    () => inspectNpmArchiveBytes(craftedUstar([entry], { terminalBlocks: 1 })),
    expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
  );
  assert.throws(
    () => inspectNpmArchiveBytes(craftedUstar([entry], { tail: Buffer.alloc(1) })),
    expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
  );
  assert.throws(
    () => inspectNpmArchiveBytes(craftedUstar([entry], {
      dirtyTerminatorOffset: 512 + 7,
    })),
    expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
  );
  assert.equal(
    inspectNpmArchiveBytes(craftedUstar([entry], { terminalBlocks: 3 })).rows.length,
    1,
  );
});

test("crafted archives reject raw mode bits outside 0777", () => {
  assert.throws(
    () => inspectNpmArchiveBytes(craftedUstar([{ path: "x", mode: 0o1644 }])),
    expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
  );
});

test("crafted archives reject extraction-unsafe portable path forms", () => {
  const unsafePaths = [
    "C:/escape.txt",
    "/absolute.txt",
    "../parent.txt",
    "back\\slash.txt",
    "stream:name",
    "less<than.txt",
    "greater>than.txt",
    "double\"quote.txt",
    "pipe|name.txt",
    "star*name.txt",
    "bad?.txt",
    "CON.txt",
    "AUX.js",
    "COM1.log",
    "LPT9",
    "CONIN$.txt",
    "CONOUT$",
    "COM¹.txt",
    "LPT³.log",
    "trailing-dot.",
    "trailing-space ",
    "cafe\u0301.js",
  ];
  for (const path of unsafePaths) {
    assert.throws(
      () => inspectNpmArchiveBytes(craftedUstar([{ path }])),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
      path,
    );
  }
});

test("crafted archives reject canonical duplicates and file-ancestor collisions", () => {
  const collisions = [
    ["same", "SAME"],
    ["a", "a/b"],
    ["a/b", "a"],
    ["A", "a/b"],
  ];
  for (const paths of collisions) {
    assert.throws(
      () => inspectNpmArchiveBytes(craftedUstar(paths.map((path) => ({ path })))),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
      paths.join(" + "),
    );
  }
});

test("empty or wrong npm bundled metadata is refused", () => {
  const empty = clone(metadata);
  empty.bundled = [];
  assert.throws(
    () => assertPackedBundleMetadata(verificationOptions({ metadata: empty })),
    expectCode("PACKAGE_BUNDLE_SET_MISMATCH"),
  );

  const wrong = clone(metadata);
  wrong.bundled = ["@e965/xlsx", "fflate", "postal-mime", "unexpected"];
  assert.throws(
    () => assertPackedBundleMetadata(verificationOptions({ metadata: wrong })),
    expectCode("PACKAGE_BUNDLE_SET_MISMATCH"),
  );

  const duplicate = clone(metadata);
  duplicate.bundled.push(duplicate.bundled[0]);
  assert.throws(
    () => assertPackedBundleMetadata(verificationOptions({ metadata: duplicate })),
    expectCode("PACKAGE_BUNDLE_SET_MISMATCH"),
  );

  const wrongType = clone(metadata);
  wrongType.bundled = "fflate";
  assert.throws(
    () => assertPackedBundleMetadata(verificationOptions({ metadata: wrongType })),
    expectCode("PACKAGE_BUNDLE_SET_MISMATCH"),
  );

  const reordered = clone(metadata);
  reordered.bundled.reverse();
  assert.equal(
    assertPackedBundleMetadata(verificationOptions({ metadata: reordered })).bundle_count,
    4,
  );
});

test("npm pack metadata limits and canonical path invariants fail closed", () => {
  const cases = [
    ["archive byte count above cap", (value) => { value.size = 128 * 1024 * 1024 + 1; }],
    ["fractional archive byte count", (value) => { value.size = 1.5; }],
    ["entry count mismatch", (value) => { value.entryCount += 1; }],
    ["fractional file byte count", (value) => { value.files[0].size = 0.5; }],
    ["negative file byte count", (value) => { value.files[0].size = -1; }],
    ["string file byte count", (value) => { value.files[0].size = "1"; }],
    ["string mode", (value) => { value.files[0].mode = "420"; }],
    ["raw mode above 0777", (value) => { value.files[0].mode = 0o1000; }],
    ["unpacked byte mismatch", (value) => { value.unpackedSize += 1; }],
    ["unsafe path", (value) => { value.files[0].path = "C:/escape"; }],
    ["canonical ancestor collision", (value) => {
      value.files[0].path = "canonical-parent";
      value.files[1].path = "CANONICAL-PARENT/child";
    }],
    ["too many bundled names", (value) => {
      value.bundled = Array.from({ length: 20_001 }, (_, index) => `bundle-${index}`);
    }],
    ["too many file records", (value) => {
      value.files = Array.from({ length: 20_001 }, (_, index) => ({
        path: `files/${index}`,
        size: 0,
        mode: 0o644,
      }));
      value.entryCount = value.files.length;
      value.unpackedSize = 0;
    }],
    ["aggregate unpacked bytes above cap", (value) => {
      value.files = [
        { path: "large/a", size: 256 * 1024 * 1024, mode: 0o644 },
        { path: "large/b", size: 256 * 1024 * 1024 + 1, mode: 0o644 },
      ];
      value.entryCount = value.files.length;
      value.unpackedSize = 512 * 1024 * 1024 + 1;
    }],
  ];
  for (const [label, mutate] of cases) {
    const changed = clone(metadata);
    mutate(changed);
    assert.throws(
      () => assertPackedBundleMetadata(verificationOptions({ metadata: changed })),
      (error) => error instanceof PackageBundleVerificationError,
      label,
    );
  }
});

test("the stable metadata reader rejects symlinks, hardlinks, directories, and oversized input", () => {
  const fixture = privateTemporary("brain-bundle-metadata-reader-");
  const path = join(fixture, "pack.json");
  const linked = join(fixture, "pack-hardlink.json");
  const symlink = join(fixture, "pack-symlink.json");
  const oversized = join(fixture, "oversized.json");
  try {
    writeFileSync(path, `${JSON.stringify([metadata])}\n`, { mode: 0o600 });
    assert.deepEqual(readStableNpmPackMetadata(path), metadata);

    linkSync(path, linked);
    assert.equal(lstatSync(path).nlink, 2);
    assert.throws(
      () => readStableNpmPackMetadata(linked),
      expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
    );

    try {
      symlinkSync(path, symlink, "file");
      assert.throws(
        () => readStableNpmPackMetadata(symlink),
        expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
      );
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
    }

    assert.throws(
      () => readStableNpmPackMetadata(fixture),
      expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
    );
    writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    assert.throws(
      () => readStableNpmPackMetadata(oversized),
      expectCode("PACKAGE_BUNDLE_METADATA_INVALID"),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the CLI reads stable metadata and emits the complete verifier receipt", () => {
  const fixture = privateTemporary("brain-bundle-verifier-cli-");
  const metadataPath = join(fixture, "npm-pack.json");
  try {
    writeFileSync(metadataPath, `${JSON.stringify([metadata])}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "scripts/verify-package-bundles.mjs",
      "--package", archivePath,
      "--metadata", metadataPath,
      "--cache-content-root", CACHE_CONTENT_ROOT,
      "--json",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: safeEnvironment(fixture),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const proof = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(proof).sort(), [
      "archive_bytes",
      "archive_file_count",
      "archive_integrity",
      "archive_sha256",
      "archive_shasum",
      "archive_unpacked_bytes",
      "bundle_bytes",
      "bundle_count",
      "bundle_file_count",
      "identity_scheme",
      "inventory_sha256",
      "runtime_payload_sha256",
      "status",
    ]);
    assert.equal(proof.status, "passed");
    assert.equal(proof.archive_integrity, metadata.integrity);
    assert.equal(proof.archive_shasum, metadata.shasum);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the stable reader accepts only a pinned exact regular-file byte range", () => {
  const fixture = privateTemporary("brain-bundle-stable-reader-");
  const path = join(fixture, "value.bin");
  try {
    writeFileSync(path, "stable bytes", { mode: 0o600 });
    assert.equal(readStableRegularFile(path).toString("utf8"), "stable bytes");
    assert.throws(
      () => readStableRegularFile(path, { maxBytes: 2 }),
      expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a missing file from any of the four bundles is refused", () => {
  for (const name of Object.keys(BUNDLE_COUNTS)) {
    const changedMetadata = clone(metadata);
    const path = `node_modules/${name}/package.json`;
    const removed = changedMetadata.files.find((entry) => entry.path === path);
    changedMetadata.files = changedMetadata.files.filter((entry) => entry.path !== path);
    changedMetadata.entryCount = changedMetadata.files.length;
    changedMetadata.unpackedSize -= removed.size;
    const changedRows = archiveRows.filter((entry) => entry.path !== path);
    assert.throws(
      () => assertPackedBundleRows(verificationOptions({
        metadata: changedMetadata,
        rows: changedRows,
      })),
      expectCode("PACKAGE_BUNDLE_METADATA_INVENTORY_MISMATCH"),
    );
  }
});

test("an extra ignored or test-warmed bundled file is refused", () => {
  const path = "node_modules/unpdf/dist/test-warmed-synthetic.txt";
  const bytes = 34;
  const mode = 0o644;
  const changedMetadata = clone(metadata);
  changedMetadata.files.push({ path, size: bytes, mode });
  changedMetadata.entryCount = changedMetadata.files.length;
  changedMetadata.unpackedSize += bytes;
  const changedRows = [...archiveRows, {
    path,
    bytes,
    mode,
    sha256: createHash("sha256").update("x".repeat(bytes)).digest("hex"),
  }];
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({
      metadata: changedMetadata,
      rows: changedRows,
    })),
    expectCode("PACKAGE_BUNDLE_METADATA_INVENTORY_MISMATCH"),
  );
});

test("a same-size content change in any of the four bundles is refused", () => {
  for (const name of Object.keys(BUNDLE_COUNTS)) {
    const path = `node_modules/${name}/package.json`;
    const changedRows = archiveRows.map((entry) =>
      entry.path === path ? { ...entry, sha256: "0".repeat(64) } : entry);
    assert.throws(
      () => assertPackedBundleRows(verificationOptions({ metadata, rows: changedRows })),
      expectCode("PACKAGE_BUNDLE_CONTENT_INVENTORY_MISMATCH"),
    );
  }
});

test("already-inspected row inputs are capped before inventory comparison", () => {
  const sha256 = "0".repeat(64);
  const tooMany = Array.from({ length: 20_001 }, (_, index) => ({
    path: `node_modules/fflate/generated/${index}`,
    bytes: 0,
    mode: 0o644,
    sha256,
  }));
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({ metadata, rows: tooMany })),
    expectCode("PACKAGE_BUNDLE_ARCHIVE_INVALID"),
  );

  const aggregateTooLarge = [
    {
      path: "node_modules/fflate/large-a",
      bytes: 256 * 1024 * 1024,
      mode: 0o644,
      sha256,
    },
    {
      path: "node_modules/fflate/large-b",
      bytes: 256 * 1024 * 1024 + 1,
      mode: 0o644,
      sha256,
    },
  ];
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({
      metadata,
      rows: aggregateTooLarge,
    })),
    expectCode("PACKAGE_BUNDLE_INVENTORY_INVALID"),
  );
});

test("a renamed file or executable-mode change is refused", () => {
  const originalPath = "node_modules/fflate/package.json";
  const renamedPath = "node_modules/fflate/package-renamed.json";
  const renamedMetadata = clone(metadata);
  renamedMetadata.files.find((entry) => entry.path === originalPath).path = renamedPath;
  const renamedRows = archiveRows.map((entry) =>
    entry.path === originalPath ? { ...entry, path: renamedPath } : entry);
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({
      metadata: renamedMetadata,
      rows: renamedRows,
    })),
    expectCode("PACKAGE_BUNDLE_METADATA_INVENTORY_MISMATCH"),
  );

  const executablePath = "node_modules/unpdf/package.json";
  const modeMetadata = clone(metadata);
  const metadataEntry = modeMetadata.files.find((entry) => entry.path === executablePath);
  metadataEntry.mode |= 0o111;
  const modeRows = archiveRows.map((entry) =>
    entry.path === executablePath ? { ...entry, mode: entry.mode | 0o111 } : entry);
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({
      metadata: modeMetadata,
      rows: modeRows,
    })),
    expectCode("PACKAGE_BUNDLE_METADATA_INVENTORY_MISMATCH"),
  );
});

test("a self-consistent edited manifest cannot replace lock-derived bundle truth", () => {
  const manifest = clone(buildReviewedBundleManifest({
    root: ROOT,
    cacheContentRoot: CACHE_CONTENT_ROOT,
  }));
  manifest.bundles[0].content_inventory_sha256 = "0".repeat(64);
  manifest.inventory_sha256 = bundleManifestInventorySha256(manifest.bundles);
  const fixture = mkdtempSync(join(tmpdir(), "brain-bundle-manifest-drift-"));
  const manifestPath = join(fixture, "reviewed-package-bundles.json");
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => loadVerifiedBundleContract({
        root: ROOT,
        cacheContentRoot: CACHE_CONTENT_ROOT,
        manifestPath,
      }),
      expectCode("PACKAGE_BUNDLE_MANIFEST_LOCK_DERIVATION_MISMATCH"),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the private cache receives only four verified archives and rejects changed bytes", () => {
  const fixture = privateTemporary("brain-bundle-private-cache-");
  const destination = join(fixture, "npm-cache", "_cacache", "content-v2", "sha512");
  const requestedDestination = process.platform === "darwin" &&
      destination.startsWith("/private/tmp/")
    ? destination.replace(/^\/private\/tmp/u, "/tmp")
    : destination;
  try {
    const proof = materializeVerifiedBundleCache({
      root: ROOT,
      sourceCacheContentRoot: CACHE_CONTENT_ROOT,
      destinationCacheContentRoot: requestedDestination,
    });
    assert.deepEqual(proof, {
      cache_content_root: destination,
      bundle_count: 4,
      inventory_sha256: "0e86bf795f93b456e16b9000efc10a5579ee2ea9c606411f9d50de3e5ecfc08e",
    });
    const privateFiles = filesBelow(destination);
    assert.equal(privateFiles.length, 4);
    assert.deepEqual(
      buildReviewedBundleManifest({ root: ROOT, cacheContentRoot: destination }),
      buildReviewedBundleManifest({ root: ROOT, cacheContentRoot: CACHE_CONTENT_ROOT }),
    );

    const changed = readFileSync(privateFiles[0]);
    changed[0] ^= 1;
    writeFileSync(privateFiles[0], changed);
    changed.fill(0);
    assert.throws(
      () => loadVerifiedBundleContract({ root: ROOT, cacheContentRoot: destination }),
      expectCode("PACKAGE_BUNDLE_CACHE_INTEGRITY_MISMATCH"),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a post-create materialization failure removes only the call-created pinned tree", () => {
  const fixture = privateTemporary("brain-bundle-private-cache-cleanup-");
  const destination = join(fixture, "npm-cache", "_cacache", "content-v2", "sha512");
  try {
    assert.throws(
      () => materializeVerifiedBundleCache({
        root: ROOT,
        sourceCacheContentRoot: CACHE_CONTENT_ROOT,
        destinationCacheContentRoot: destination,
        writeArchive() { throw new Error("synthetic_write_failure"); },
      }),
      expectCode("PACKAGE_BUNDLE_CACHE_MATERIALIZATION_FAILED"),
    );
    assert.equal(existsSync(join(fixture, "npm-cache")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("cleanup refuses a replacement whose pinned root identity changed", () => {
  const fixture = privateTemporary("brain-bundle-private-cache-swap-");
  const firstCreated = join(fixture, "npm-cache");
  const moved = join(fixture, "call-created-moved");
  const destination = join(firstCreated, "_cacache", "content-v2", "sha512");
  const sentinel = join(firstCreated, "replacement-sentinel");
  try {
    assert.throws(
      () => materializeVerifiedBundleCache({
        root: ROOT,
        sourceCacheContentRoot: CACHE_CONTENT_ROOT,
        destinationCacheContentRoot: destination,
        writeArchive() {
          renameSync(firstCreated, moved);
          mkdirSync(firstCreated, { mode: 0o700 });
          writeFileSync(sentinel, "replacement", { mode: 0o600 });
          throw new Error("synthetic_root_swap");
        },
      }),
      expectCode("PACKAGE_BUNDLE_CACHE_MATERIALIZATION_FAILED"),
    );
    assert.equal(readFileSync(sentinel, "utf8"), "replacement");
    assert.equal(existsSync(moved), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a pre-existing destination is refused without deleting its sentinel", () => {
  const fixture = privateTemporary("brain-bundle-private-cache-existing-");
  const destination = join(fixture, "npm-cache", "_cacache", "content-v2", "sha512");
  const sentinel = join(destination, "sentinel");
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    writeFileSync(sentinel, "preserve", { mode: 0o600 });
    assert.throws(
      () => materializeVerifiedBundleCache({
        root: ROOT,
        sourceCacheContentRoot: CACHE_CONTENT_ROOT,
        destinationCacheContentRoot: destination,
      }),
      expectCode("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID"),
    );
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a symlink or junction ancestor is refused without outside writes or deletion", (t) => {
  const fixture = privateTemporary("brain-bundle-private-cache-link-");
  const outside = privateTemporary("brain-bundle-private-cache-outside-");
  const link = join(fixture, "npm-cache");
  const sentinel = join(outside, "sentinel");
  const existingThroughLink = join(outside, "existing");
  const destination = join(link, "existing", "nested", "sha512");
  try {
    writeFileSync(sentinel, "outside", { mode: 0o600 });
    mkdirSync(existingThroughLink, { mode: 0o700 });
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip(`symlink or junction unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => materializeVerifiedBundleCache({
        root: ROOT,
        sourceCacheContentRoot: CACHE_CONTENT_ROOT,
        destinationCacheContentRoot: destination,
      }),
      expectCode("PACKAGE_BUNDLE_CACHE_DESTINATION_INVALID"),
    );
    assert.equal(readFileSync(sentinel, "utf8"), "outside");
    assert.equal(existsSync(join(existingThroughLink, "nested")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("lock root and complete inBundle declarations are part of the contract", () => {
  const sourcePackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const sourceLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const manifestPath = join(ROOT, "privacy", "reviewed-package-bundles.json");
  const directBundleKeys = new Set(
    sourcePackage.bundleDependencies.map((name) => `node_modules/${name}`),
  );
  const extraLockKey = Object.keys(sourceLock.packages).find((key) =>
    key.startsWith("node_modules/") && !directBundleKeys.has(key));
  assert.ok(extraLockKey);
  const cases = [
    ["lockfile v3", (pkg, lock) => { lock.lockfileVersion = 2; }],
    ["package bundle list", (pkg) => { pkg.bundleDependencies.pop(); }],
    ["package bundle order", (pkg) => { pkg.bundleDependencies.reverse(); }],
    ["lock root bundle list", (pkg, lock) => { lock.packages[""].bundleDependencies.pop(); }],
    ["lock root bundle order", (pkg, lock) => {
      lock.packages[""].bundleDependencies.reverse();
    }],
    ["lock root dependency version", (pkg, lock) => {
      lock.packages[""].dependencies.fflate = "0.0.0";
    }],
    ["missing direct inBundle", (pkg, lock) => {
      lock.packages["node_modules/fflate"].inBundle = false;
    }],
    ["extra inBundle entry", (pkg, lock) => {
      lock.packages[extraLockKey].inBundle = true;
    }],
    ...["dev", "devOptional", "link", "optional"].map((flag) => [
      `direct bundle ${flag}`,
      (pkg, lock) => { lock.packages["node_modules/fflate"][flag] = true; },
    ]),
    ["non-HTTPS registry resolution", (pkg, lock) => {
      lock.packages["node_modules/fflate"].resolved =
        lock.packages["node_modules/fflate"].resolved.replace("https://", "http://");
    }],
    ["wrong registry host", (pkg, lock) => {
      lock.packages["node_modules/fflate"].resolved =
        lock.packages["node_modules/fflate"].resolved.replace(
          "registry.npmjs.org",
          "registry.invalid",
        );
    }],
    ["registry URL query", (pkg, lock) => {
      lock.packages["node_modules/fflate"].resolved += "?changed=1";
    }],
    ["noncanonical integrity", (pkg, lock) => {
      lock.packages["node_modules/fflate"].integrity =
        lock.packages["node_modules/fflate"].integrity.replace("sha512-", "SHA512-");
    }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = privateTemporary("brain-bundle-lock-contract-");
    try {
      const packageJson = clone(sourcePackage);
      const lock = clone(sourceLock);
      mutate(packageJson, lock);
      writeFileSync(join(fixture, "package.json"), `${JSON.stringify(packageJson)}\n`);
      writeFileSync(join(fixture, "package-lock.json"), `${JSON.stringify(lock)}\n`);
      assert.throws(
        () => loadVerifiedBundleContract({
          root: fixture,
          cacheContentRoot: CACHE_CONTENT_ROOT,
          manifestPath,
        }),
        expectCode("PACKAGE_BUNDLE_CONTRACT_INVALID"),
        label,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test("the source-only package shape with every bundle omitted is refused", () => {
  const sourceOnly = clone(metadata);
  sourceOnly.bundled = [];
  sourceOnly.files = sourceOnly.files.filter((entry) => !entry.path.startsWith("node_modules/"));
  sourceOnly.entryCount = sourceOnly.files.length;
  sourceOnly.unpackedSize = sourceOnly.files.reduce((sum, entry) => sum + entry.size, 0);
  assert.throws(
    () => assertPackedBundleRows(verificationOptions({
      metadata: sourceOnly,
      rows: archiveRows.filter((entry) => !entry.path.startsWith("node_modules/")),
    })),
    expectCode("PACKAGE_BUNDLE_SET_MISMATCH"),
  );
});
