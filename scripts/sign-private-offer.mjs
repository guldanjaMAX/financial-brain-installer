#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { fstatSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { isatty } from "node:tty";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRIVATE_OFFER_MAX_BYTES, PRIVATE_OFFER_PUBLIC_KEY, assertPrivateOfferReleaseKey,
  canonicalPrivateJson, refusePrivateOffer, validateUnsignedPrivateOffer,
} from "../operations/private-update-offer.mjs";
import { readStableRegularFile } from "../operations/package-bundle-verifier.mjs";

const MAX_KEY_INPUT_BYTES = 4096;

export function readPrivateOfferPipedKey({ platform = process.platform, stat = () => fstatSync(0),
  stdin = () => process.stdin, isTerminal = () => isatty(0), read = readSync, onCheck = () => {},
} = {}) {
  // Reject redirected regular files and terminals; the owner pipes a credential
  // store's output directly, without a second persisted copy or terminal echo.
  const input = stat();
  onCheck("pipe");
  if (isTerminal() || input.isFile() || input.isDirectory()) refusePrivateOffer("PRIVATE_OFFER_SIGN");
  // Windows fd stat does not consistently identify anonymous pipes. Node's
  // stdio bootstrap classifies a PIPE as a readable net.Socket. POSIX retains
  // its stricter fd check; a regular file or terminal is never a pipe fallback.
  if (!input.isFIFO() && !input.isSocket()) {
    if (platform !== "win32") refusePrivateOffer("PRIVATE_OFFER_SIGN");
    const stream = stdin();
    if (!(stream instanceof Socket) || !stream.readable || stream.isTTY) refusePrivateOffer("PRIVATE_OFFER_SIGN");
  }
  const buffer = Buffer.alloc(MAX_KEY_INPUT_BYTES + 1);
  try {
    let size = 0;
    while (size < buffer.length) {
      const count = read(0, buffer, size, buffer.length - size, null);
      if (count === 0) return Buffer.from(buffer.subarray(0, size));
      size += count;
    }
    refusePrivateOffer("PRIVATE_OFFER_SIGN");
  } finally { buffer.fill(0); }
}

/** Two public paths only. Key transport and production trust have no CLI options.
 * Explicit dependencies let offline tests use disposable keys without altering
 * the approved default trust anchor or consulting ambient credentials.
 */
export function runPrivateOfferStdinSigner(argv, {
  readStdin = readPrivateOfferPipedKey, publicKey = PRIVATE_OFFER_PUBLIC_KEY, onCheck = () => {},
} = {}) {
  let encoded, der, exported;
  try {
    onCheck("arguments");
    if (!Array.isArray(argv) || argv.length !== 2 || argv.some(path =>
      typeof path !== "string" || !path || path.startsWith("-") || path.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(path))) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    onCheck("stdin");
    encoded = readStdin();
    if (!Buffer.isBuffer(encoded) || encoded.length > MAX_KEY_INPUT_BYTES) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    const base64 = encoded.toString("utf8").replace(/\r?\n$/u, "");
    if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
      refusePrivateOffer("PRIVATE_OFFER_SIGN");
    }
    der = Buffer.from(base64, "base64");
    if (der.toString("base64") !== base64) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    onCheck("private_key");
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    exported = key.export({ format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519" || !der.equals(exported)) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    onCheck("public_key");
    const approved = assertPrivateOfferReleaseKey(publicKey).export({ format: "der", type: "spki" });
    if (!createPublicKey(key).export({ format: "der", type: "spki" }).equals(approved)) {
      refusePrivateOffer("PRIVATE_OFFER_SIGN");
    }
    onCheck("offer");
    const unsigned = validateUnsignedPrivateOffer(JSON.parse(readStableRegularFile(argv[0], {
      maxBytes: PRIVATE_OFFER_MAX_BYTES,
    }).toString("utf8")));
    const signature = sign(null, Buffer.from(canonicalPrivateJson(unsigned)), key).toString("base64url");
    const offer = { ...unsigned, signature };
    const serialized = JSON.stringify(offer, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > PRIVATE_OFFER_MAX_BYTES) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    onCheck("write");
    // Exclusive creation preserves a previously reviewed offer, including a link.
    writeFileSync(argv[1], serialized, { mode: 0o600, flag: "wx" });
    return offer;
  } catch {
    // Parser and filesystem errors can contain input or private paths. Emit only
    // the fixed support message, never key bytes, raw errors or offer contents.
    refusePrivateOffer("PRIVATE_OFFER_SIGN");
  } finally {
    if (Buffer.isBuffer(encoded)) encoded.fill(0);
    if (Buffer.isBuffer(der)) der.fill(0);
    if (Buffer.isBuffer(exported)) exported.fill(0);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { runPrivateOfferStdinSigner(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
