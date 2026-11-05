import { writeFileSync } from "node:fs";
import {
  PRIVATE_OFFER_ORIGIN, PRIVATE_OFFER_MAX_BYTES, PRIVATE_PACKAGE_MAX_BYTES,
  PrivateOfferError, canonicalPrivateJson, privateOfferTarget, refusePrivateOffer,
  verifyPrivateOffer, verifyPrivatePackage,
} from "./private-update-offer.mjs";
import { readStableRegularFile, inspectNpmArchiveBytes } from "./package-bundle-verifier.mjs";
import { installPrivateUpdatePackage } from "./private-update-package.mjs";

export function hasPrivateUpdateFlags(argv) {
  return Array.isArray(argv) && argv.some((arg) => typeof arg === "string" &&
    /^--private-(?:offer|offer-file|package)(?:=|$)/u.test(arg));
}

export function parsePrivateUpdateArgv(argv) {
  const parsed = { check: false, manifestPath: undefined, offerFile: undefined, packageFile: undefined };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== "string" || !token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) {
      refusePrivateOffer("PRIVATE_OFFER_USAGE");
    }
    if (!token.startsWith("-")) {
      if (parsed.manifestPath !== undefined || seen.size) refusePrivateOffer("PRIVATE_OFFER_USAGE");
      parsed.manifestPath = token;
      continue;
    }
    if (seen.has(token)) refusePrivateOffer("PRIVATE_OFFER_USAGE");
    seen.add(token);
    if (token === "--private-offer") { parsed.check = true; continue; }
    if (!["--private-offer-file", "--private-package"].includes(token)) refusePrivateOffer("PRIVATE_OFFER_USAGE");
    const value = argv[++i];
    if (typeof value !== "string" || !value || value.startsWith("-") ||
        value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) refusePrivateOffer("PRIVATE_OFFER_USAGE");
    parsed[token === "--private-offer-file" ? "offerFile" : "packageFile"] = value;
  }
  if (parsed.check ? Boolean(parsed.packageFile) : !(parsed.offerFile && parsed.packageFile)) {
    refusePrivateOffer("PRIVATE_OFFER_USAGE");
  }
  return parsed;
}

async function fetchOfficialOffer(target, fetchOffer) {
  try {
    const response = await fetchOffer(`${PRIVATE_OFFER_ORIGIN}${target}.json`, {
      method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) refusePrivateOffer("PRIVATE_OFFER_MISSING");
    if (response.status !== 200) refusePrivateOffer("PRIVATE_OFFER_UNAVAILABLE");
    const parts = [];
    let size = 0;
    // Bound streamed bytes even when Content-Length is absent or incorrect.
    for await (const part of response.body) {
      const bytes = Buffer.from(part);
      size += bytes.length;
      if (size > PRIVATE_OFFER_MAX_BYTES) refusePrivateOffer("PRIVATE_OFFER_INVALID");
      parts.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch { refusePrivateOffer("PRIVATE_OFFER_INVALID"); }
  } catch (error) {
    if (error instanceof PrivateOfferError) throw error;
    refusePrivateOffer("PRIVATE_OFFER_UNAVAILABLE");
  }
}

export async function runPrivateUpdate(parsed, dependencies) {
  const { discoverInstalledManifest, pinManifest, revalidateManifest,
    fetch: fetchOffer = globalThis.fetch, installPackage = installPrivateUpdatePackage,
    write = console.log, publicKey } = dependencies;
  const clock = typeof dependencies.now === "function" ? dependencies.now : () => dependencies.now ?? Date.now();
  let pin;
  try {
    const installed = discoverInstalledManifest(parsed.manifestPath);
    pin = pinManifest(installed.path);
  } catch { refusePrivateOffer("PRIVATE_OFFER_IDENTITY"); }
  const manifest = pin.manifest;
  const target = privateOfferTarget(manifest);
  const fetched = await fetchOfficialOffer(target, fetchOffer);
  const options = { manifest, now: clock(), ...(publicKey !== undefined ? { publicKey } : {}) };
  const offer = verifyPrivateOffer(fetched, options);
  revalidateManifest(pin, "private update offer");
  if (parsed.check) {
    if (parsed.offerFile) {
      try { writeFileSync(parsed.offerFile, JSON.stringify(offer, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
      catch { refusePrivateOffer("PRIVATE_OFFER_FILE"); }
    }
    write(`Private update: ${offer.from_version} -> ${offer.to_version}\n${offer.reason}\nExpires: ${offer.expires_at}\nNo update has been installed.`);
    return offer;
  }
  let saved;
  try { saved = JSON.parse(readStableRegularFile(parsed.offerFile, { maxBytes: PRIVATE_OFFER_MAX_BYTES }).toString("utf8")); }
  catch { refusePrivateOffer("PRIVATE_OFFER_FILE"); }
  verifyPrivateOffer(saved, options);
  // Re-fetching above makes withdrawal effective and avoids trusting a carried file.
  if (canonicalPrivateJson(saved) !== canonicalPrivateJson(offer)) refusePrivateOffer("PRIVATE_OFFER_CHANGED");
  let bytes;
  try { bytes = readStableRegularFile(parsed.packageFile, { maxBytes: PRIVATE_PACKAGE_MAX_BYTES }); }
  catch { refusePrivateOffer("PRIVATE_OFFER_PACKAGE"); }
  verifyPrivatePackage(bytes, offer);
  let inspected;
  try { inspected = inspectNpmArchiveBytes(bytes); }
  catch { refusePrivateOffer("PRIVATE_OFFER_PACKAGE"); }
  if (inspected.packageJson?.name !== "brain-installer" || inspected.packageJson.version !== offer.to_version ||
      !inspected.rows.some((row) => row.path === "brain.mjs")) refusePrivateOffer("PRIVATE_OFFER_PACKAGE");
  revalidateManifest(pin, "private update package");
  verifyPrivateOffer(offer, { ...options, now: clock() });
  return installPackage({ bytes, offer, manifestPath: pin.target,
    binding: { target: offer.target, fingerprint: pin.fingerprint } });
}
