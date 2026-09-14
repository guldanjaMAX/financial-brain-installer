/**
 * Provenance protection for the SQL artifact used by verified recovery.
 *
 * The artifact can contain the complete corpus. The durable file is therefore
 * AES-256-GCM ciphertext. A short-lived plaintext is allowed only inside the
 * reviewed owner-only directory while a callback owns it. Stale plaintext
 * residue is a hard stop on the next run rather than something deleted without
 * review.
 */
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  hasRecoveryArtifactResiduePathComponent,
  isRecoveryArtifactResiduePathComponent,
} from "./recovery-artifact-residue-policy.mjs";

const MAGIC = Buffer.from("FBRREC1\n", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const PLAINTEXT_PREFIX = ".brain-recovery-plaintext.tmp-";
const PLAINTEXT_STAGING_PREFIX = `${PLAINTEXT_PREFIX}staging-`;
const CIPHERTEXT_PREFIX = ".brain-recovery-encrypted.tmp-";
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR } = FS_CONSTANTS;

export const RECOVERY_ARTIFACT_KEY_PREFIX = "v1.";
export const RECOVERY_ARTIFACT_FORMAT_VERSION = 1;

function refuse(message) {
  const error = new Error(message);
  error.code = "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED";
  throw error;
}

function cleanupRefusal(message, primaryFailed, primaryError, cleanupErrors) {
  const errors = [
    ...(primaryFailed ? [primaryError] : []),
    ...cleanupErrors,
  ];
  const error = new AggregateError(errors, message, {
    cause: primaryFailed ? primaryError : cleanupErrors[0],
  });
  error.name = "RecoveryArtifactCleanupError";
  error.code = "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED";
  return error;
}

export function validateRecoveryArtifactKey(value) {
  if (typeof value !== "string" || !/^v1\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("the provenance-protection key must be a version-1 32-byte base64url key");
  }
  const decoded = Buffer.from(value.slice(RECOVERY_ARTIFACT_KEY_PREFIX.length), "base64url");
  try {
    if (decoded.length !== 32) throw new TypeError("the provenance-protection key must decode to 32 bytes");
    return value;
  } finally {
    decoded.fill(0);
  }
}

export function generateRecoveryArtifactKey(randomBytesImpl = randomBytes) {
  const value = randomBytesImpl(32);
  if (!Buffer.isBuffer(value)) {
    throw new TypeError("the provenance-protection key generator must return exactly 32 random bytes");
  }
  try {
    if (value.length !== 32) {
      throw new TypeError("the provenance-protection key generator must return exactly 32 random bytes");
    }
    return validateRecoveryArtifactKey(`${RECOVERY_ARTIFACT_KEY_PREFIX}${value.toString("base64url")}`);
  } finally {
    value.fill(0);
  }
}

function keyBytes(value, salt) {
  const checked = validateRecoveryArtifactKey(value);
  const input = Buffer.from(checked.slice(RECOVERY_ARTIFACT_KEY_PREFIX.length), "base64url");
  let derived = null;
  try {
    derived = Buffer.from(hkdfSync(
      "sha256",
      input,
      salt,
      Buffer.from("financial-brain-recovery-artifact-v1", "utf8"),
      32,
    ));
    return Buffer.from(derived);
  } finally {
    input.fill(0);
    if (derived) derived.fill(0);
  }
}

function assertPrivateDirectory(directory) {
  const absolute = resolve(directory);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse("the private artifact directory is unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    refuse("the private artifact directory is not owned by the current user");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    refuse("the private artifact directory must be owner-only");
  }
  return absolute;
}

function assertNewDestination(path, directory) {
  const absolute = resolve(path);
  if (dirname(absolute) !== directory) refuse("the encrypted provenance artifact destination must stay in its private directory");
  try {
    lstatSync(absolute);
    refuse("the encrypted provenance artifact destination already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return absolute;
}

function stableRegularFile(path) {
  const absolute = resolve(path);
  const fd = openSync(absolute, O_RDONLY | O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) {
      refuse("the provenance-protection source file is unsafe");
    }
    return { absolute, fd, info };
  } catch (error) {
    try { closeSync(fd); } catch { /* preserve the original validation failure */ }
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameStoredFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateRegularFile(info, expectedLinks) {
  return info.isFile() && info.nlink === expectedLinks &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
    (process.platform === "win32" || (info.mode & 0o777) === 0o600);
}

function assertStableSource(source, message) {
  let descriptorInfo;
  let pathInfo;
  try {
    descriptorInfo = fstatSync(source.fd);
    pathInfo = lstatSync(source.absolute);
  } catch {
    refuse(message);
  }
  if (!sameFile(source.info, descriptorInfo) || !sameFile(source.info, pathInfo)) {
    refuse(message);
  }
}

function readExactly(descriptor, buffer, position, message) {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const count = readSync(descriptor, buffer, offset, remaining, position + offset);
    if (!Number.isSafeInteger(count) || count < 1 || count > remaining) {
      refuse(message);
    }
    offset += count;
  }
}

function descriptorSha256(descriptor, expectedBytes, message) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) refuse(message);
  let before;
  try {
    before = fstatSync(descriptor);
  } catch {
    refuse(message);
  }
  if (!before.isFile() || before.size !== expectedBytes) refuse(message);

  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let position = 0;
  try {
    while (position < expectedBytes) {
      const count = Math.min(buffer.length, expectedBytes - position);
      readExactly(descriptor, buffer.subarray(0, count), position, message);
      digest.update(buffer.subarray(0, count));
      position += count;
    }
  } finally {
    buffer.fill(0);
  }

  let after;
  try {
    after = fstatSync(descriptor);
  } catch {
    refuse(message);
  }
  if (!sameFile(before, after)) refuse(message);
  return { digest: digest.digest("hex"), info: after };
}

function temporaryPath(directory, prefix, randomBytesImpl = randomBytes) {
  const nonce = randomBytesImpl(12);
  if (!Buffer.isBuffer(nonce)) {
    throw new TypeError("the temporary-file name generator must return exactly 12 random bytes");
  }
  try {
    if (nonce.length !== 12) {
      throw new TypeError("the temporary-file name generator must return exactly 12 random bytes");
    }
    const temporary = join(directory, `${prefix}${nonce.toString("hex")}`);
    if (!isRecoveryArtifactResiduePathComponent(basename(temporary)) ||
        !hasRecoveryArtifactResiduePathComponent(temporary)) {
      refuse("the temporary provenance-protection path is outside the residue policy");
    }
    return temporary;
  } finally {
    nonce.fill(0);
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

async function writeAtomically(
  destination,
  directory,
  prefix,
  chunks,
  randomBytesImpl,
  writeSyncImpl = writeSync,
  revalidateSource = () => {},
  linkSyncImpl = linkSync,
  consumePublished = null,
  cleanupUnlinkSyncImpl = unlinkSync,
  syncDirectoryImpl = syncDirectory,
) {
  if (consumePublished !== null && typeof consumePublished !== "function") {
    throw new TypeError("the provenance-protection output consumer must be a function");
  }
  if (typeof cleanupUnlinkSyncImpl !== "function" || typeof syncDirectoryImpl !== "function") {
    throw new TypeError("the provenance-protection cleanup functions must be valid");
  }
  const temporary = temporaryPath(directory, prefix, randomBytesImpl);
  const fd = openSync(temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  let descriptorOpen = true;
  let openedInfo = null;
  let writtenInfo = null;
  let publicationHandedOff = false;
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    openedInfo = fstatSync(fd);
    const openedPath = lstatSync(temporary);
    if (!isPrivateRegularFile(openedInfo, 1) ||
        !sameFile(openedInfo, openedPath)) {
      refuse("the provenance-protection output staging file changed");
    }
    const expectedHash = createHash("sha256");
    let expectedBytes = 0;
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!Number.isSafeInteger(expectedBytes + bytes.length)) {
        refuse("the provenance-protection output is too large");
      }
      expectedHash.update(bytes);
      expectedBytes += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const remaining = bytes.length - offset;
        const written = writeSyncImpl(fd, bytes, offset, remaining);
        if (!Number.isSafeInteger(written) || written < 1 || written > remaining) {
          refuse("the provenance-protection output write made invalid progress");
        }
        offset += written;
      }
    }
    fsyncSync(fd);
    writtenInfo = fstatSync(fd);
    const writtenPath = lstatSync(temporary);
    if (!isPrivateRegularFile(writtenInfo, 1) ||
        !sameFile(writtenInfo, writtenPath)) {
      refuse("the provenance-protection output staging file changed");
    }
    revalidateSource();
    assertNewDestination(destination, directory);
    const beforeLinkDescriptor = fstatSync(fd);
    const beforeLinkPath = lstatSync(temporary);
    if (!isPrivateRegularFile(beforeLinkDescriptor, 1) ||
        !sameFile(writtenInfo, beforeLinkDescriptor) ||
        !sameFile(writtenInfo, beforeLinkPath)) {
      refuse("the provenance-protection output staging file changed");
    }
    // A hard-link publish is exclusive: unlike rename(), it cannot overwrite a
    // destination that appears after the final absence check.
    linkSyncImpl(temporary, destination);
    const linkedDescriptor = fstatSync(fd);
    const linkedTemporary = lstatSync(temporary);
    const linkedDestination = lstatSync(destination);
    if (!isPrivateRegularFile(linkedDescriptor, 2) ||
        !sameFile(linkedDescriptor, linkedTemporary) ||
        !sameFile(linkedDescriptor, linkedDestination) ||
        !sameStoredFile(writtenInfo, linkedDescriptor)) {
      refuse("the provenance-protection output publication changed");
    }
    cleanupUnlinkSyncImpl(temporary);
    const publishedDescriptor = fstatSync(fd);
    const publishedPath = lstatSync(destination);
    if (!isPrivateRegularFile(publishedDescriptor, 1) ||
        !sameFile(publishedDescriptor, publishedPath) ||
        !sameStoredFile(writtenInfo, publishedDescriptor)) {
      refuse("the provenance-protection output publication changed");
    }
    const expectedDigest = expectedHash.digest("hex");
    const verified = descriptorSha256(
      fd,
      expectedBytes,
      "the provenance-protection output content changed",
    );
    const verifiedPath = lstatSync(destination);
    if (verified.digest !== expectedDigest ||
        !isPrivateRegularFile(verified.info, 1) ||
        !sameFile(verified.info, verifiedPath) ||
        !sameStoredFile(writtenInfo, verified.info)) {
      refuse("the provenance-protection output content changed");
    }
    revalidateSource();
    if (consumePublished) {
      publicationHandedOff = true;
      let consumerResult;
      let consumerFailed = false;
      let consumerError = null;
      try {
        consumerResult = await consumePublished(Object.freeze({
          destination,
          descriptor: fd,
          publishedInfo: verified.info,
        }));
      } catch (error) {
        consumerFailed = true;
        consumerError = error;
      }
      let sourceFailed = false;
      let sourceError = null;
      try {
        revalidateSource();
      } catch (error) {
        sourceFailed = true;
        sourceError = error;
      }
      let consumptionError = null;
      try {
        const consumedInfo = fstatSync(fd);
        if (!sameInode(verified.info, consumedInfo) || consumedInfo.nlink !== 0) {
          refuse("the provenance-protection output was not consumed");
        }
      } catch (error) {
        consumptionError = error;
      }
      let closeError = null;
      try {
        closeSync(fd);
        descriptorOpen = false;
      } catch (error) {
        closeError = error;
      }
      let syncError = null;
      try {
        syncDirectoryImpl(directory);
      } catch (error) {
        syncError = error;
      }
      const cleanupErrors = [consumptionError, closeError, syncError].filter(Boolean);
      if (cleanupErrors.length) {
        const primaryFailed = sourceFailed || consumerFailed;
        const primaryError = sourceFailed ? sourceError : consumerError;
        throw cleanupRefusal(
          "provenance-protection cleanup failed after output publication",
          primaryFailed,
          primaryError,
          cleanupErrors,
        );
      }
      if (sourceFailed) throw sourceError;
      if (
        consumerFailed &&
        consumerError?.code === "RECOVERY_ENCRYPTED_PROVENANCE_ARTIFACT_REFUSED"
      ) {
        throw consumerError;
      }
      if (consumptionError) throw consumptionError;
      if (consumerFailed) throw consumerError;
      return { destination, publishedInfo: verified.info, consumerResult };
    }
    closeSync(fd);
    descriptorOpen = false;
    syncDirectoryImpl(directory);
    return { destination, publishedInfo: verified.info };
  } catch (error) {
    const cleanupErrors = [];
    const ownedInfo = writtenInfo ?? openedInfo;
    if (!publicationHandedOff) {
      for (const path of [destination, temporary]) {
        if (!ownedInfo) break;
        try {
          const current = lstatSync(path);
          if (sameInode(current, ownedInfo)) cleanupUnlinkSyncImpl(path);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") cleanupErrors.push(cleanupError);
        }
      }
    }
    if (descriptorOpen) {
      try { closeSync(fd); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    try { syncDirectoryImpl(directory); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length) {
      throw cleanupRefusal(
        "provenance-protection cleanup failed after the primary operation failed",
        true,
        error,
        cleanupErrors,
      );
    }
    throw error;
  }
}

export function recoveryPlaintextResidues(directory) {
  const privateDirectory = assertPrivateDirectory(directory);
  return readdirSync(privateDirectory)
    .filter((name) => name.startsWith(PLAINTEXT_PREFIX) &&
      isRecoveryArtifactResiduePathComponent(name))
    .sort();
}

export function assertNoRecoveryPlaintextResidue(directory) {
  const residues = recoveryPlaintextResidues(directory);
  if (residues.length) {
    refuse("a prior temporary plaintext file requires manual review before continuing");
  }
}

function activeResidueDirectoryComponent(privateDirectory, path) {
  if (path === undefined || path === null) return null;
  const absolute = resolve(path);
  const component = basename(absolute);
  let info;
  try { info = lstatSync(absolute); } catch {
    refuse("the active recovery residue directory is unsafe");
  }
  if (dirname(absolute) !== privateDirectory ||
      !isRecoveryArtifactResiduePathComponent(component) ||
      !hasRecoveryArtifactResiduePathComponent(absolute) ||
      !info.isDirectory() || info.isSymbolicLink() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    refuse("the active recovery residue directory is unsafe");
  }
  return component;
}

export function recoveryArtifactResidues(directory, {
  activeResidueDirectoryPath = null,
} = {}) {
  const privateDirectory = assertPrivateDirectory(directory);
  const activeComponent = activeResidueDirectoryComponent(
    privateDirectory,
    activeResidueDirectoryPath,
  );
  return readdirSync(privateDirectory)
    .filter(isRecoveryArtifactResiduePathComponent)
    .filter((name) => name !== activeComponent)
    .sort();
}

export function assertNoRecoveryArtifactResidue(directory, options = {}) {
  if (recoveryArtifactResidues(directory, options).length) {
    refuse("a prior provenance-protection residue requires manual review before continuing");
  }
}

export async function encryptRecoveryArtifact(sourcePath, destinationPath, key, {
  randomBytesImpl = randomBytes,
  writeSyncImpl = writeSync,
  linkSyncImpl = linkSync,
  cleanupUnlinkSyncImpl = unlinkSync,
  syncDirectoryImpl = syncDirectory,
} = {}) {
  const directory = assertPrivateDirectory(dirname(resolve(destinationPath)));
  const destination = assertNewDestination(destinationPath, directory);
  const source = stableRegularFile(sourcePath);
  let salt = null;
  let iv = null;
  try {
    salt = randomBytesImpl(SALT_BYTES);
    iv = randomBytesImpl(IV_BYTES);
    if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES ||
        !Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
      throw new TypeError("the encrypted provenance artifact could not obtain valid random bytes");
    }
    const derived = keyBytes(key, salt);
    let cipher;
    try {
      cipher = createCipheriv("aes-256-gcm", derived, iv);
    } finally {
      derived.fill(0);
    }

    async function* chunks() {
      yield Buffer.concat([MAGIC, salt, iv]);
      const input = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      let position = 0;
      try {
        while (position < source.info.size) {
          const count = readSync(
            source.fd,
            input,
            0,
            Math.min(input.length, source.info.size - position),
            position,
          );
          if (!count) refuse("the SQL source changed while creating the encrypted provenance artifact");
          position += count;
          yield cipher.update(input.subarray(0, count));
        }
        assertStableSource(
          source,
          "the SQL source changed while creating the encrypted provenance artifact",
        );
      } finally {
        input.fill(0);
      }
      yield cipher.final();
      yield cipher.getAuthTag();
    }

    await writeAtomically(
      destination,
      directory,
      CIPHERTEXT_PREFIX,
      chunks(),
      randomBytesImpl,
      writeSyncImpl,
      () => assertStableSource(
        source,
        "the SQL source changed while creating the encrypted provenance artifact",
      ),
      linkSyncImpl,
      null,
      cleanupUnlinkSyncImpl,
      syncDirectoryImpl,
    );
    return destination;
  } finally {
    if (Buffer.isBuffer(salt)) salt.fill(0);
    if (Buffer.isBuffer(iv)) iv.fill(0);
    closeSync(source.fd);
  }
}

async function decryptRecoveryArtifactWithIdentity(
  sourcePath,
  destinationPath,
  key,
  {
    randomBytesImpl = randomBytes,
    writeSyncImpl = writeSync,
    linkSyncImpl = linkSync,
    cleanupUnlinkSyncImpl = unlinkSync,
    syncDirectoryImpl = syncDirectory,
  } = {},
  consumePublished = null,
) {
  const directory = assertPrivateDirectory(dirname(resolve(destinationPath)));
  const destination = assertNewDestination(destinationPath, directory);
  const source = stableRegularFile(sourcePath);
  let header = null;
  let tag = null;
  try {
    if (source.info.size < HEADER_BYTES + TAG_BYTES) {
      refuse("the encrypted provenance artifact is truncated");
    }
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    readExactly(
      source.fd,
      header,
      0,
      "the encrypted provenance artifact changed while it was opened",
    );
    readExactly(
      source.fd,
      tag,
      source.info.size - TAG_BYTES,
      "the encrypted provenance artifact changed while it was opened",
    );
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      refuse("the encrypted provenance artifact format is unsupported");
    }
    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
    const iv = header.subarray(MAGIC.length + SALT_BYTES);
    const derived = keyBytes(key, salt);
    let decipher;
    try {
      decipher = createDecipheriv("aes-256-gcm", derived, iv);
    } finally {
      derived.fill(0);
    }
    decipher.setAuthTag(tag);

    async function* chunks() {
      const first = HEADER_BYTES;
      const end = source.info.size - TAG_BYTES;
      const input = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      let position = first;
      try {
        while (position < end) {
          const count = readSync(
            source.fd,
            input,
            0,
            Math.min(input.length, end - position),
            position,
          );
          if (!count) refuse("the encrypted provenance artifact changed while it was opened");
          position += count;
          const plaintext = decipher.update(input.subarray(0, count));
          try {
            yield plaintext;
          } finally {
            plaintext.fill(0);
          }
        }
        assertStableSource(
          source,
          "the encrypted provenance artifact changed while it was opened",
        );
      } finally {
        input.fill(0);
      }
      let plaintext;
      try {
        plaintext = decipher.final();
      } catch {
        refuse("the encrypted provenance artifact failed its integrity check");
      }
      try {
        yield plaintext;
      } finally {
        plaintext.fill(0);
      }
    }

    return await writeAtomically(
      destination,
      directory,
      PLAINTEXT_STAGING_PREFIX,
      chunks(),
      randomBytesImpl,
      writeSyncImpl,
      () => assertStableSource(
        source,
        "the encrypted provenance artifact changed while it was opened",
      ),
      linkSyncImpl,
      consumePublished,
      cleanupUnlinkSyncImpl,
      syncDirectoryImpl,
    );
  } finally {
    if (Buffer.isBuffer(header)) header.fill(0);
    if (Buffer.isBuffer(tag)) tag.fill(0);
    closeSync(source.fd);
  }
}

export async function decryptRecoveryArtifact(sourcePath, destinationPath, key, options = {}) {
  const publication = await decryptRecoveryArtifactWithIdentity(
    sourcePath,
    destinationPath,
    key,
    options,
  );
  return publication.destination;
}

export async function withDecryptedRecoveryArtifact(sourcePath, directory, key, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("an encrypted provenance artifact consumer is required");
  const unlinkPlaintext = options.unlinkSyncImpl ?? unlinkSync;
  if (typeof unlinkPlaintext !== "function") {
    throw new TypeError("a valid temporary-plaintext cleanup function is required");
  }
  const privateDirectory = assertPrivateDirectory(directory);
  assertNoRecoveryArtifactResidue(privateDirectory, {
    activeResidueDirectoryPath: options.activeResidueDirectoryPath,
  });
  const plaintext = temporaryPath(privateDirectory, PLAINTEXT_PREFIX, options.randomBytesImpl);
  const publication = await decryptRecoveryArtifactWithIdentity(
    sourcePath,
    plaintext,
    key,
    options,
    async ({ destination, descriptor, publishedInfo }) => {
      let callbackFailed = false;
      let callbackError = null;
      let callbackResult;
      try {
        let openingDescriptor;
        let openingPath;
        try {
          openingDescriptor = fstatSync(descriptor);
          openingPath = lstatSync(destination);
        } catch {
          refuse("the temporary plaintext copy changed before use");
        }
        if (!sameFile(publishedInfo, openingDescriptor) ||
            !sameFile(publishedInfo, openingPath) ||
            !isPrivateRegularFile(openingDescriptor, 1)) {
          refuse("the temporary plaintext copy changed before use");
        }
        callbackResult = await callback(destination);
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      }

      const cleanupErrors = [];
      let current = null;
      try {
        current = lstatSync(destination);
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupErrors.push(error);
      }
      if (current) {
        if (!sameInode(publishedInfo, current)) {
          cleanupErrors.push(new Error("the temporary plaintext pathname changed before cleanup"));
        } else {
          try {
            unlinkPlaintext(destination);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      try {
        lstatSync(destination);
        cleanupErrors.push(new Error("the temporary plaintext pathname still exists"));
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupErrors.push(error);
      }
      try {
        const after = fstatSync(descriptor);
        if (!sameInode(publishedInfo, after) || after.nlink !== 0) {
          cleanupErrors.push(new Error("the temporary plaintext inode remains linked"));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        throw cleanupRefusal(
          "the temporary plaintext copy could not be removed",
          callbackFailed,
          callbackError,
          cleanupErrors,
        );
      }
      if (callbackFailed) throw callbackError;
      return callbackResult;
    },
  );
  return publication.consumerResult;
}

export const RECOVERY_ARTIFACT_PLAINTEXT_PREFIX = PLAINTEXT_PREFIX;
