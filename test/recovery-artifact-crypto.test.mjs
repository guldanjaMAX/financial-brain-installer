import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  RECOVERY_ARTIFACT_PLAINTEXT_PREFIX,
  assertNoRecoveryPlaintextResidue,
  decryptRecoveryArtifact,
  encryptRecoveryArtifact,
  generateRecoveryArtifactKey,
  recoveryPlaintextResidues,
  recoveryArtifactResidues,
  withDecryptedRecoveryArtifact,
} from "../operations/recovery-artifact-crypto.mjs";
import {
  hasRecoveryArtifactResiduePathComponent,
  isRecoveryArtifactResiduePathComponent,
} from "../operations/recovery-artifact-residue-policy.mjs";

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "brain-recovery-artifact-"));
  chmodSync(directory, 0o700);
  return directory;
}

function errorTreeIncludes(error, expected, seen = new Set()) {
  if (error === expected) return true;
  if ((typeof error !== "object" && typeof error !== "function") || error === null ||
      seen.has(error)) return false;
  seen.add(error);
  if (errorTreeIncludes(error.cause, expected, seen)) return true;
  return Array.isArray(error.errors) &&
    error.errors.some((entry) => errorTreeIncludes(entry, expected, seen));
}

function classifiedResidues(directory) {
  return readdirSync(directory).filter(isRecoveryArtifactResiduePathComponent).sort();
}

test("every provenance-protection temporary name is policy-classified and cleaned", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const failed = join(directory, "failed.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 12));
  const observed = [];
  const observeLink = (temporary, destination) => {
    observed.push(temporary);
    linkSync(temporary, destination);
  };
  writeFileSync(source, "synthetic residue-policy body", { mode: 0o600 });

  await encryptRecoveryArtifact(source, encrypted, key, { linkSyncImpl: observeLink });
  await decryptRecoveryArtifact(encrypted, restored, key, { linkSyncImpl: observeLink });
  await withDecryptedRecoveryArtifact(
    encrypted,
    directory,
    key,
    (plaintext) => {
      observed.push(plaintext);
      return null;
    },
    { linkSyncImpl: observeLink },
  );
  assert.equal(observed.length, 4);
  assert.equal(observed.every((path) =>
    isRecoveryArtifactResiduePathComponent(basename(path)) &&
      hasRecoveryArtifactResiduePathComponent(path)), true);
  assert.deepEqual(classifiedResidues(directory), []);

  const activeRuntime = join(directory, ".brain-recovery-runtime-active-fixture");
  mkdirSync(activeRuntime, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(activeRuntime, 0o700);
  assert.deepEqual(recoveryArtifactResidues(directory), [
    ".brain-recovery-runtime-active-fixture",
  ]);
  assert.deepEqual(recoveryArtifactResidues(directory, {
    activeResidueDirectoryPath: activeRuntime,
  }), []);
  rmSync(activeRuntime, { recursive: true, force: false });
  assert.deepEqual(classifiedResidues(directory), []);

  const failedCleanup = [];
  await assert.rejects(
    encryptRecoveryArtifact(source, failed, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, 13),
      writeSyncImpl: () => { throw new Error("synthetic residue-policy write failure"); },
      cleanupUnlinkSyncImpl: (path) => {
        failedCleanup.push(path);
        unlinkSync(path);
      },
    }),
    /synthetic residue-policy write failure/,
  );
  assert.equal(failedCleanup.length, 1);
  assert.equal(failedCleanup.every((path) =>
    isRecoveryArtifactResiduePathComponent(basename(path)) &&
      hasRecoveryArtifactResiduePathComponent(path)), true);
  assert.deepEqual(classifiedResidues(directory), []);
});

test("provenance-protection key generator scratch bytes are always wiped", () => {
  const validScratch = Buffer.alloc(32, 21);
  const key = generateRecoveryArtifactKey(() => validScratch);
  assert.match(key, /^v1\./);
  assert.equal(validScratch.every((byte) => byte === 0), true);

  const invalidScratch = Buffer.alloc(31, 22);
  assert.throws(
    () => generateRecoveryArtifactKey(() => invalidScratch),
    /exactly 32 random bytes/,
  );
  assert.equal(invalidScratch.every((byte) => byte === 0), true);
});

test("the encrypted provenance artifact is authenticated ciphertext", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const body = "-- synthetic only\nINSERT INTO documents VALUES ('fixture');\n";
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 23));
  writeFileSync(source, body, { mode: 0o600 });

  await encryptRecoveryArtifact(source, encrypted, key);
  assert.notEqual(readFileSync(encrypted, "utf8").includes("synthetic only"), true);
  await decryptRecoveryArtifact(encrypted, restored, key);
  assert.equal(readFileSync(restored, "utf8"), body);
});

test("wrong key and tampering never produce plaintext", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  writeFileSync(source, "private synthetic body", { mode: 0o600 });
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 31));
  const wrong = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 32));
  await encryptRecoveryArtifact(source, encrypted, key);
  await assert.rejects(
    decryptRecoveryArtifact(encrypted, join(directory, "wrong.sql"), wrong),
    /failed its integrity check/,
  );
  assert.equal(recoveryPlaintextResidues(directory).length, 0);

  const tampered = Buffer.from(readFileSync(encrypted));
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  writeFileSync(join(directory, "tampered.sql.fbrenc"), tampered, { mode: 0o600 });
  await assert.rejects(
    decryptRecoveryArtifact(
      join(directory, "tampered.sql.fbrenc"),
      join(directory, "tampered.sql"),
      key,
    ),
    /failed its integrity check/,
  );
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("an interrupted encryption write cannot close a recycled descriptor", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const sentinel = join(directory, "sentinel.txt");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 41));
  let writes = 0;
  let sentinelDescriptor;
  writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 7), { mode: 0o600 });
  writeFileSync(sentinel, "sentinel", { mode: 0o600 });
  try {
    await assert.rejects(
      encryptRecoveryArtifact(source, encrypted, key, {
        randomBytesImpl: (length) => Buffer.alloc(length, 42),
        writeSyncImpl: (...args) => {
          writes++;
          if (writes === 2) throw new Error("synthetic encrypted destination failure");
          return writeSync(...args);
        },
      }),
      /synthetic encrypted destination failure/,
    );
    sentinelDescriptor = openSync(sentinel, "r");
    assert.equal(fstatSync(sentinelDescriptor).size, 8);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(fstatSync(sentinelDescriptor).size, 8);
    assert.deepEqual(recoveryArtifactResidues(directory), []);
  } finally {
    if (sentinelDescriptor !== undefined) closeSync(sentinelDescriptor);
  }
});

test("same-size source mutation is refused before artifact publication", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 43));
  writeFileSync(source, "ORIGINAL", { mode: 0o600 });
  utimesSync(source, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  let writes = 0;
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, 44),
      writeSyncImpl: (...args) => {
        const written = writeSync(...args);
        writes++;
        if (writes === 3) writeFileSync(source, "MUTATED!", { mode: 0o600 });
        return written;
      },
    }),
    /SQL source changed while creating the encrypted provenance artifact/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("source mutation during artifact publication is refused", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 91));
  writeFileSync(source, "ORIGINAL", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      linkSyncImpl: (temporary, destination) => {
        linkSync(temporary, destination);
        writeFileSync(source, "MUTATED!", { mode: 0o600 });
      },
    }),
    /SQL source changed while creating the encrypted provenance artifact/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("invalid destination write progress is fail-closed", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 45));
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  for (const [index, invalid] of [0, Number.NaN, 10_000].entries()) {
    const encrypted = join(directory, `invalid-${index}.fbrenc`);
    await assert.rejects(
      encryptRecoveryArtifact(source, encrypted, key, {
        randomBytesImpl: (length) => Buffer.alloc(length, 46 + index),
        writeSyncImpl: () => invalid,
      }),
      /provenance-protection output write made invalid progress/,
    );
    assert.equal(existsSync(encrypted), false);
  }
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("an invalid temporary-name nonce cannot escape the private directory", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 92));
  let calls = 0;
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => {
        calls++;
        return calls < 3 ? Buffer.alloc(length, 93) : "../../../escaped";
      },
    }),
    /temporary-file name generator must return exactly 12 random bytes/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("staging permission drift is refused before publication", async () => {
  if (process.platform === "win32") return;
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const randomByte = 94;
  const temporary = join(
    directory,
    `.brain-recovery-encrypted.tmp-${Buffer.alloc(12, randomByte).toString("hex")}`,
  );
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 95));
  let writes = 0;
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, randomByte),
      writeSyncImpl: (...args) => {
        const written = writeSync(...args);
        writes++;
        if (writes === 1) chmodSync(temporary, 0o644);
        return written;
      },
    }),
    /provenance-protection output staging file changed/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("a replaced staging pathname is refused instead of published", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const randomByte = 49;
  const temporary = join(
    directory,
    `.brain-recovery-encrypted.tmp-${Buffer.alloc(12, randomByte).toString("hex")}`,
  );
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 48));
  let writes = 0;
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, randomByte),
      writeSyncImpl: (...args) => {
        const written = writeSync(...args);
        writes++;
        if (writes === 1) {
          unlinkSync(temporary);
          writeFileSync(temporary, "RACED", { mode: 0o600 });
        }
        return written;
      },
    }),
    /provenance-protection output staging file changed/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.equal(readFileSync(temporary, "utf8"), "RACED");
  unlinkSync(temporary);
});

test("same-inode staging content mutation is refused instead of published", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const randomByte = 52;
  const temporary = join(
    directory,
    `.brain-recovery-encrypted.tmp-${Buffer.alloc(12, randomByte).toString("hex")}`,
  );
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 51));
  let writes = 0;
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, randomByte),
      writeSyncImpl: (...args) => {
        const written = writeSync(...args);
        writes++;
        if (writes === 3) {
          const size = fstatSync(args[0]).size;
          writeFileSync(temporary, Buffer.alloc(size, 82), { mode: 0o600 });
        }
        return written;
      },
    }),
    /provenance-protection output content changed/,
  );
  assert.equal(writes, 3);
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("an ambiguously reported hard-link publish is cleaned by inode", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 47));
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await assert.rejects(
    encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, 48),
      linkSyncImpl: (temporary, destination) => {
        linkSync(temporary, destination);
        throw new Error("synthetic ambiguous hard-link result");
      },
    }),
    /synthetic ambiguous hard-link result/,
  );
  assert.equal(existsSync(encrypted), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("chunk boundaries round-trip without truncation", async () => {
  const chunk = 1024 * 1024;
  for (const [index, length] of [0, 1, chunk - 1, chunk, chunk + 1, (2 * chunk) + 17].entries()) {
    const directory = privateDirectory();
    const source = join(directory, "source.bin");
    const encrypted = join(directory, "source.bin.fbrenc");
    const restored = join(directory, "restored.bin");
    const body = Buffer.alloc(length, index + 1);
    const key = generateRecoveryArtifactKey((size) => Buffer.alloc(size, 50 + index));
    writeFileSync(source, body, { mode: 0o600 });
    await encryptRecoveryArtifact(source, encrypted, key, {
      randomBytesImpl: (size) => Buffer.alloc(size, 60 + index),
    });
    await decryptRecoveryArtifact(encrypted, restored, key, {
      randomBytesImpl: (size) => Buffer.alloc(size, 70 + index),
    });
    assert.deepEqual(readFileSync(restored), body);
  }
});

test("interrupted decryption wipes plaintext and preserves descriptor ownership", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const sentinel = join(directory, "sentinel.txt");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 80));
  let capturedPlaintext;
  let sentinelDescriptor;
  writeFileSync(source, Buffer.alloc((2 * 1024 * 1024) + 17, 81), { mode: 0o600 });
  writeFileSync(sentinel, "sentinel", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key, {
    randomBytesImpl: (length) => Buffer.alloc(length, 82),
  });
  try {
    await assert.rejects(
      decryptRecoveryArtifact(encrypted, restored, key, {
        randomBytesImpl: (length) => Buffer.alloc(length, 83),
        writeSyncImpl: (_descriptor, bytes) => {
          capturedPlaintext = bytes;
          throw new Error("synthetic plaintext destination failure");
        },
      }),
      /synthetic plaintext destination failure/,
    );
    assert.ok(capturedPlaintext?.length > 0);
    assert.equal(capturedPlaintext.every((byte) => byte === 0), true);
    assert.equal(existsSync(restored), false);
    assert.deepEqual(recoveryArtifactResidues(directory), []);
    sentinelDescriptor = openSync(sentinel, "r");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(fstatSync(sentinelDescriptor).size, 8);
  } finally {
    if (sentinelDescriptor !== undefined) closeSync(sentinelDescriptor);
  }
});

test("a raced decryption destination is never deleted or overwritten", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 84));
  writeFileSync(source, "synthetic source", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key, {
    randomBytesImpl: (length) => Buffer.alloc(length, 85),
  });
  await assert.rejects(
    decryptRecoveryArtifact(encrypted, restored, key, {
      randomBytesImpl: (length) => Buffer.alloc(length, 86),
      writeSyncImpl: () => {
        writeFileSync(restored, "raced owner file", { mode: 0o600 });
        throw new Error("synthetic destination race");
      },
    }),
    /synthetic destination race/,
  );
  assert.equal(readFileSync(restored, "utf8"), "raced owner file");
  assert.deepEqual(recoveryArtifactResidues(directory), []);
  unlinkSync(restored);
});

test("encrypted-source mutation during plaintext publication is refused", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 96));
  writeFileSync(source, "ORIGINAL", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);
  const mutated = Buffer.from(readFileSync(encrypted));
  mutated[Math.floor(mutated.length / 2)] ^= 0x01;

  await assert.rejects(
    decryptRecoveryArtifact(encrypted, restored, key, {
      linkSyncImpl: (temporary, destination) => {
        linkSync(temporary, destination);
        writeFileSync(encrypted, mutated, { mode: 0o600 });
      },
    }),
    /encrypted provenance artifact changed while it was opened/,
  );
  assert.equal(existsSync(restored), false);
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("plaintext exists only for the callback and residue is fail-closed", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 41));
  writeFileSync(source, "callback body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  const seen = await withDecryptedRecoveryArtifact(encrypted, directory, key, (path) => {
    assert.match(path, new RegExp(RECOVERY_ARTIFACT_PLAINTEXT_PREFIX.replaceAll(".", "\\.")));
    return readFileSync(path, "utf8");
  });
  assert.equal(seen, "callback body");
  assert.deepEqual(recoveryPlaintextResidues(directory), []);

  const residue = join(directory, `${RECOVERY_ARTIFACT_PLAINTEXT_PREFIX}interrupted`);
  writeFileSync(residue, "review me", { mode: 0o600 });
  assert.throws(() => assertNoRecoveryPlaintextResidue(directory), /manual review/);
  unlinkSync(residue);
});

test("deterministic random bytes keep plaintext destination and staging names distinct", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 97));
  writeFileSync(source, "deterministic callback body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  const seen = await withDecryptedRecoveryArtifact(
    encrypted,
    directory,
    key,
    (path) => readFileSync(path, "utf8"),
    { randomBytesImpl: (length) => Buffer.alloc(length, 98) },
  );
  assert.equal(seen, "deterministic callback body");
  assert.deepEqual(recoveryPlaintextResidues(directory), []);
});

test("a callback error propagates only after plaintext cleanup is proven", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 90));
  const callbackError = new Error("synthetic callback failure");
  writeFileSync(source, "callback failure body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, () => {
      throw callbackError;
    }),
    (error) => error === callbackError,
  );
  assert.deepEqual(recoveryPlaintextResidues(directory), []);
});

test("a falsy callback error is never converted into success", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 99));
  writeFileSync(source, "falsy callback body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  let rejected = false;
  try {
    await withDecryptedRecoveryArtifact(encrypted, directory, key, () => {
      throw null;
    });
  } catch (error) {
    rejected = true;
    assert.equal(error, null);
  }
  assert.equal(rejected, true);
  assert.deepEqual(recoveryPlaintextResidues(directory), []);
});

test("source mutation overrides a reconcilable callback failure", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 100));
  writeFileSync(source, "source closing boundary", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);
  const mutated = Buffer.from(readFileSync(encrypted));
  mutated[Math.floor(mutated.length / 2)] ^= 0x01;

  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, () => {
      writeFileSync(encrypted, mutated, { mode: 0o600 });
      const error = new Error("synthetic reconcilable callback failure");
      error.code = "RECOVERY_WRANGLER_CALL_FAILED";
      throw error;
    }),
    (error) => error?.code === "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED" &&
      /changed while it was opened/.test(error.message),
  );
  assert.deepEqual(recoveryPlaintextResidues(directory), []);
});

test("plaintext cleanup failure cannot return callback success", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 87));
  let retainedPlaintext;
  writeFileSync(source, "callback cleanup body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(
      encrypted,
      directory,
      key,
      () => "must not be returned",
      {
        unlinkSyncImpl: (path) => {
          retainedPlaintext = path;
          const error = new Error("synthetic cleanup refusal");
          error.code = "EACCES";
          throw error;
        },
      },
    ),
    /temporary plaintext copy could not be removed|provenance-protection cleanup failed/,
  );
  assert.equal(existsSync(retainedPlaintext), true);
  assert.equal(recoveryPlaintextResidues(directory).length, 1);
  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, () => null),
    /prior provenance-protection residue requires manual review/,
  );
  unlinkSync(retainedPlaintext);
});

test("callback and plaintext unlink failures are reported together", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 101));
  const callbackError = new Error("synthetic callback failure before cleanup");
  const unlinkError = Object.assign(new Error("synthetic plaintext unlink refusal"), {
    code: "EACCES",
  });
  let retainedPlaintext;
  writeFileSync(source, "callback and cleanup failure body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(
      encrypted,
      directory,
      key,
      () => { throw callbackError; },
      {
        unlinkSyncImpl: (path) => {
          retainedPlaintext = path;
          throw unlinkError;
        },
      },
    ),
    (error) => error?.code === "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED" &&
      /cleanup|temporary plaintext copy/.test(error.message) &&
      errorTreeIncludes(error, callbackError) &&
      errorTreeIncludes(error, unlinkError),
  );
  assert.equal(existsSync(retainedPlaintext), true);
  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, () => null),
    /prior provenance-protection residue requires manual review/,
  );
  unlinkSync(retainedPlaintext);
});

test("plaintext directory-sync failure is explicit after the copy is removed", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 102));
  const syncError = Object.assign(new Error("synthetic directory sync refusal"), {
    code: "EIO",
  });
  writeFileSync(source, "directory sync failure body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(
      encrypted,
      directory,
      key,
      () => "must not be returned",
      { syncDirectoryImpl: () => { throw syncError; } },
    ),
    (error) => error?.code === "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED" &&
      /cleanup/.test(error.message) && errorTreeIncludes(error, syncError),
  );
  assert.deepEqual(recoveryPlaintextResidues(directory), []);
});

test("plaintext cleanup preserves a raced replacement and reports a renamed plaintext", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const stolen = join(directory, "renamed-plaintext.sql");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 88));
  let originalPath;
  writeFileSync(source, "callback custody body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, (path) => {
      originalPath = path;
      renameSync(path, stolen);
      writeFileSync(path, "UNRELATED", { mode: 0o600 });
      return "must not be returned";
    }),
    /temporary plaintext copy could not be removed|provenance-protection cleanup failed/,
  );
  assert.equal(readFileSync(originalPath, "utf8"), "UNRELATED");
  assert.equal(readFileSync(stolen, "utf8"), "callback custody body");
  unlinkSync(originalPath);
  unlinkSync(stolen);
});

test("plaintext cleanup reports an extra hard link", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const linked = join(directory, "linked-plaintext.sql");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 89));
  writeFileSync(source, "linked callback body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  await assert.rejects(
    withDecryptedRecoveryArtifact(encrypted, directory, key, (path) => {
      linkSync(path, linked);
      return "must not be returned";
    }),
    /temporary plaintext copy could not be removed|provenance-protection cleanup failed/,
  );
  assert.equal(readFileSync(linked, "utf8"), "linked callback body");
  unlinkSync(linked);
});
