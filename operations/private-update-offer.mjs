import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

export const PRIVATE_OFFER_SCHEMA = "fb-private-offer/1";
// The release owner replaces this placeholder with the one founder public key.
export const PRIVATE_OFFER_PUBLIC_KEY = null;
export const PRIVATE_OFFER_ORIGIN = "https://financialbrain.ai/update/offers/";
export const PRIVATE_OFFER_MAX_BYTES = 16 * 1024;
export const PRIVATE_PACKAGE_MAX_BYTES = 128 * 1024 * 1024;
export const PRIVATE_UPDATE_BINDING_ENV = "BRAIN_PRIVATE_UPDATE_BINDING";
const DAY = 86_400_000;
const HEX = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
const FIELDS = ["schema", "target", "from_version", "to_version", "package_url", "package_sha256",
  "package_bytes", "reason", "issued_at", "expires_at", "nonce"];
const MESSAGES = Object.freeze({
  PRIVATE_OFFER_MISSING: "There is no private update offer for this Brain.",
  PRIVATE_OFFER_UNSIGNED: "This private update offer has no signature.",
  PRIVATE_OFFER_SIGNATURE: "This private update offer could not be verified with the founder public key.",
  PRIVATE_OFFER_KEY: "This CLI does not have the founder public key yet.",
  PRIVATE_OFFER_IDENTITY: "The installed manifest needs its Cloudflare account and D1 database identifiers.",
  PRIVATE_OFFER_TARGET: "This private update offer is for a different Brain.",
  PRIVATE_OFFER_VERSION: "This private update offer does not match the installed version or a newer destination.",
  PRIVATE_OFFER_EXPIRED: "This private update offer is expired or outside its allowed dates.",
  PRIVATE_OFFER_INVALID: "This private update offer is incomplete or has an invalid field.",
  PRIVATE_OFFER_UNAVAILABLE: "The official private update offer could not be read.",
  PRIVATE_OFFER_CHANGED: "The saved private update offer differs from the current official offer.",
  PRIVATE_OFFER_BINDING: "The installed manifest changed after this private update was verified.",
  PRIVATE_OFFER_FILE: "The private update offer file could not be read or saved safely.",
  PRIVATE_OFFER_PACKAGE: "The package does not match the private update offer bytes, checksum, or version.",
  PRIVATE_OFFER_USAGE: "Use the private offer check or supply both a private package and an offer file.",
  PRIVATE_OFFER_INSTALL: "The verified private package could not be installed into this CLI location.",
  PRIVATE_OFFER_UPDATE: "The normal update did not complete and its saved checkpoint must be preserved.",
  PRIVATE_OFFER_SIGN: "The private offer could not be signed or saved with the supplied inputs.",
});

export class PrivateOfferError extends Error {
  constructor(code) {
    super(`${MESSAGES[code]} Support code: ${code}`);
    this.name = "PrivateOfferError";
    this.code = code;
  }
}
export function refusePrivateOffer(code) { throw new PrivateOfferError(code); }

/** Sorted object keys and JSON primitive encoding define the signed bytes. */
export function canonicalPrivateJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPrivateJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalPrivateJson(value[key])}`,
  ).join(",")}}`;
  return JSON.stringify(value);
}

export function privateOfferTarget(manifest) {
  const cf = manifest?.infrastructure?.cloudflare;
  if (!cf || (cf.storage !== undefined && cf.storage !== "d1") ||
      typeof cf.account_id !== "string" || !/^[a-f0-9]{32}$/iu.test(cf.account_id) ||
      typeof cf.d1_database_id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(cf.d1_database_id)) {
    refusePrivateOffer("PRIVATE_OFFER_IDENTITY");
  }
  // Preserve both identifiers exactly; the signer and installed CLI use this same input.
  return createHash("sha256").update(PRIVATE_OFFER_SCHEMA).update(canonicalPrivateJson({
    account_id: cf.account_id, d1_database_id: cf.d1_database_id,
  })).digest("hex");
}

/** The normal updater must keep the identity verified before npm replaced the CLI. */
export function assertPrivateUpdateBinding(pin, binding) {
  try {
    if (!binding || typeof binding.target !== "string" || !HEX.test(binding.target) ||
        typeof binding.fingerprint !== "string" || !HEX.test(binding.fingerprint) ||
        pin.fingerprint !== binding.fingerprint || privateOfferTarget(pin.manifest) !== binding.target) {
      refusePrivateOffer("PRIVATE_OFFER_BINDING");
    }
  } catch { refusePrivateOffer("PRIVATE_OFFER_BINDING"); }
}

function newer(to, from) {
  const left = to.split(".").map(Number);
  const right = from.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

export function validateUnsignedPrivateOffer(value) {
  let url;
  try { url = new URL(value?.package_url); } catch { /* Shape refusal below. */ }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonicalPrivateJson(Object.keys(value).sort()) !== canonicalPrivateJson([...FIELDS].sort()) ||
      value.schema !== PRIVATE_OFFER_SCHEMA || !HEX.test(value.target) ||
      typeof value.from_version !== "string" || !VERSION.test(value.from_version) ||
      typeof value.to_version !== "string" || !VERSION.test(value.to_version) ||
      typeof value.package_url !== "string" || value.package_url.length > 2048 ||
      !url || url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      !HEX.test(value.package_sha256) || !Number.isSafeInteger(value.package_bytes) ||
      value.package_bytes < 1 || value.package_bytes > PRIVATE_PACKAGE_MAX_BYTES ||
      typeof value.reason !== "string" || value.reason.trim().length < 1 || [...value.reason].length > 300 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/u.test(value.reason) ||
      !HEX.test(value.nonce) || !Number.isFinite(timestamp(value.issued_at)) ||
      !Number.isFinite(timestamp(value.expires_at))) refusePrivateOffer("PRIVATE_OFFER_INVALID");
  return value;
}

function validateDatesAndVersions(offer, installedVersion, now, onCheck) {
  onCheck("from_version");
  if (offer.from_version !== installedVersion) refusePrivateOffer("PRIVATE_OFFER_VERSION");
  onCheck("to_version");
  if (!newer(offer.to_version, offer.from_version)) refusePrivateOffer("PRIVATE_OFFER_VERSION");
  onCheck("time");
  const issued = timestamp(offer.issued_at);
  const expires = timestamp(offer.expires_at);
  if (!Number.isFinite(now) || issued > now || expires <= now || expires <= issued ||
      expires - issued > 30 * DAY) refusePrivateOffer("PRIVATE_OFFER_EXPIRED");
}

export function createPrivateOffer({ manifest, toVersion, packageBytes, packageUrl, reason }, {
  now = Date.now(), days = 14, nonce = randomBytes(32).toString("hex"),
} = {}) {
  if (!Number.isFinite(now) || !Number.isInteger(days) || days < 1 || days > 30 ||
      !Buffer.isBuffer(packageBytes)) refusePrivateOffer("PRIVATE_OFFER_INVALID");
  const offer = validateUnsignedPrivateOffer({
    schema: PRIVATE_OFFER_SCHEMA, target: privateOfferTarget(manifest),
    from_version: manifest.brain?.version, to_version: toVersion,
    package_url: packageUrl, package_sha256: createHash("sha256").update(packageBytes).digest("hex"),
    package_bytes: packageBytes.length, reason,
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + days * DAY).toISOString(), nonce,
  });
  validateDatesAndVersions(offer, manifest.brain?.version, now, () => {});
  return offer;
}

export function verifyPrivateOffer(offer, {
  manifest, publicKey = PRIVATE_OFFER_PUBLIC_KEY, now = Date.now(), onCheck = () => {},
} = {}) {
  onCheck("offer");
  if (offer == null) refusePrivateOffer("PRIVATE_OFFER_MISSING");
  onCheck("signature");
  if (typeof offer.signature !== "string" || !offer.signature) refusePrivateOffer("PRIVATE_OFFER_UNSIGNED");
  const { signature: encoded, ...unsigned } = offer;
  onCheck("shape");
  validateUnsignedPrivateOffer(unsigned);
  if (!publicKey) refusePrivateOffer("PRIVATE_OFFER_KEY");
  const signature = Buffer.from(encoded, "base64url");
  const payload = Buffer.from(canonicalPrivateJson(unsigned));
  let valid = false;
  try {
    publicKey = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    valid = publicKey.asymmetricKeyType === "ed25519" &&
      signature.length === 64 && signature.toString("base64url") === encoded &&
      verifySignature(null, payload, publicKey, signature);
  } catch { /* The same plain refusal covers malformed signatures and wrong keys. */ }
  if (!valid) refusePrivateOffer("PRIVATE_OFFER_SIGNATURE");
  onCheck("target");
  if (offer.target !== privateOfferTarget(manifest)) refusePrivateOffer("PRIVATE_OFFER_TARGET");
  validateDatesAndVersions(offer, manifest.brain?.version, now, onCheck);
  return Object.freeze({ ...offer });
}

export function verifyPrivatePackage(bytes, offer, { onCheck = () => {} } = {}) {
  onCheck("package_bytes");
  if (!Buffer.isBuffer(bytes) || bytes.length !== offer.package_bytes) refusePrivateOffer("PRIVATE_OFFER_PACKAGE");
  onCheck("package_sha256");
  if (createHash("sha256").update(bytes).digest("hex") !== offer.package_sha256) refusePrivateOffer("PRIVATE_OFFER_PACKAGE");
  return bytes;
}
