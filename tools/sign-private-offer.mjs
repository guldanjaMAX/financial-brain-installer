#!/usr/bin/env node
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPrivateJson, createPrivateOffer, refusePrivateOffer } from "../operations/private-update-offer.mjs";
import { readStableRegularFile } from "../operations/package-bundle-verifier.mjs";

function readPrivateKeyFile(path, { platform = process.platform, currentUid = () => process.getuid?.(),
  onCheck = () => {}, note = line => process.stderr.write(line + "\n") } = {}) {
  let descriptor;
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  try {
    const before = lstatSync(path);
    onCheck("key-file");
    if (!before.isFile() || before.isSymbolicLink()) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) |
      (fsConstants.O_NONBLOCK || 0));
    const opened = fstatSync(descriptor);
    const uid = currentUid();
    if (!opened.isFile() || !sameFile(before, opened) ||
        (uid !== undefined && opened.uid !== uid) ||
        (platform !== "win32" && (opened.mode & 0o077) !== 0)) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    if (platform === "win32") note("Windows: POSIX key file mode check skipped; use an owner-only file.");
    const bytes = readFileSync(descriptor);
    // Validate the opened file again so a concurrent chmod or replacement refuses.
    if (!sameFile(opened, fstatSync(descriptor)) || !sameFile(opened, lstatSync(path))) {
      refusePrivateOffer("PRIVATE_OFFER_SIGN");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function runPrivateOfferSigner(argv, { now = Date.now(), write = (line) => process.stdout.write(line),
  readStdin = () => readFileSync(0, "utf8"), keyFileOptions } = {}) {
  try {
    if (argv.length === 2 && argv[0] === "--generate-key") {
      // Refuse an existing directory so key generation cannot replace a key in use.
      mkdirSync(argv[1], { mode: 0o700 });
      const keys = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      writeFileSync(join(argv[1], "private.pem"), keys.privateKey, { mode: 0o600, flag: "wx" });
      writeFileSync(join(argv[1], "public.pem"), keys.publicKey, { mode: 0o644, flag: "wx" });
      write(keys.publicKey);
      return;
    }
    const flags = {};
    const allowed = new Set(["manifest", "package", "package-url", "to-version", "reason", "out", "key-file", "key-stdin", "expires-in-days"]);
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i].startsWith("--") ? argv[i].slice(2) : "";
      if (!allowed.has(flag) || Object.hasOwn(flags, flag)) refusePrivateOffer("PRIVATE_OFFER_SIGN");
      if (flag === "key-stdin") { flags[flag] = true; continue; }
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) refusePrivateOffer("PRIVATE_OFFER_SIGN");
      flags[flag] = argv[++i];
    }
    if (["manifest", "package", "package-url", "to-version", "reason", "out"].some((key) => !flags[key]) ||
        Boolean(flags["key-file"]) === Boolean(flags["key-stdin"])) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    const key = createPrivateKey(flags["key-file"] ? readPrivateKeyFile(flags["key-file"], keyFileOptions) : readStdin());
    if (key.asymmetricKeyType !== "ed25519") refusePrivateOffer("PRIVATE_OFFER_SIGN");
    const unsigned = createPrivateOffer({
      manifest: JSON.parse(readFileSync(flags.manifest, "utf8")),
      toVersion: flags["to-version"], packageBytes: readStableRegularFile(flags.package),
      packageUrl: flags["package-url"], reason: flags.reason,
    }, { now, days: flags["expires-in-days"] === undefined ? 14 : Number(flags["expires-in-days"]) });
    const signature = sign(null, Buffer.from(canonicalPrivateJson(unsigned)), key).toString("base64url");
    writeFileSync(flags.out, JSON.stringify({ ...unsigned, signature }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    write(`Target: ${unsigned.target}\nExpiry: ${unsigned.expires_at}\n`);
    return unsigned.target;
  } catch {
    // Never echo key parser errors, input bytes, or a private file's path.
    refusePrivateOffer("PRIVATE_OFFER_SIGN");
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { runPrivateOfferSigner(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
