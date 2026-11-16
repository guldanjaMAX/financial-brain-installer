#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { assertPrivateOfferReleaseKey, verifyPrivateOffer } from "../operations/private-update-offer.mjs";

try {
  assertPrivateOfferReleaseKey();
} catch {
  process.stderr.write("Release held: the approved private offer public key is missing or invalid. Support code: PRIVATE_OFFER_KEY\n");
  process.exitCode = 1;
}

if (!process.exitCode) {
  try {
    const offer = JSON.parse(readFileSync(new URL("../test/fixtures/private-offer/approved-signed.json", import.meta.url), "utf8"));
    const verified = verifyPrivateOffer(offer, {
      manifest: { brain: { version: "77.0.1" }, infrastructure: { cloudflare: {
        account_id: "a".repeat(32), storage: "d1", d1_database_id: "11111111-2222-4333-8444-555555555555",
      } } }, now: Date.parse("2026-11-12T12:00:00.000Z"),
    });
    if (verified.to_version !== "77.0.2") throw new Error("unexpected fixture version");
    process.stdout.write("Private offer public key: verified Ed25519 trust anchor and approved signature fixture.\n");
  } catch {
    process.stderr.write("Release held: the approved private offer signature fixture is missing or does not verify. Support code: PRIVATE_OFFER_KEY\n");
    process.exitCode = 1;
  }
}
