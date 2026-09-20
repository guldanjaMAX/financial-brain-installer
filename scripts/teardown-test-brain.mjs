#!/usr/bin/env node

/**
 * Retired compatibility shim for the historical disposable teardown script.
 *
 * The script used to contain a second Cloudflare deletion implementation next
 * to the fixed A13-A16 broker. Keeping two operator paths made it possible for
 * documentation or a direct import to select the stale ceremony. All legacy
 * preview, source, target, and commit forms now stop locally. The installed
 * `brain-v048-disposable-teardown` entry point is the only supported operator
 * path for this held campaign.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  V048_DISPOSABLE_CAMPAIGN,
} from "../operations/v048-disposable-campaign-contract.mjs";

const LEGACY_DISPOSABLE_NAME_RE =
  /^brain-test(?:-[a-z0-9](?:[a-z0-9-]{0,125}[a-z0-9])?)?$/u;
const BROKER_COMMAND = "brain-v048-disposable-teardown help";
const RETIRED_CODE = "V048_TEARDOWN_LEGACY_PATH_RETIRED";
const PROTECTED_RAW = process.env.BRAIN_TEARDOWN_PROTECTED || "";

export const V048_DISPOSABLE_TEARDOWN_NAMES = Object.freeze({
  source: V048_DISPOSABLE_CAMPAIGN.source.name,
  target: V048_DISPOSABLE_CAMPAIGN.target.name,
});

export const LEGACY_GENERIC_TEARDOWN_QUARANTINED = true;

export class DisposableTeardownError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DisposableTeardownError";
    this.code = code;
    this.detail = detail;
  }
}

function refuseRetired() {
  throw new DisposableTeardownError(
    RETIRED_CODE,
    `Run the installed ${BROKER_COMMAND}. No Cloudflare read or mutation was attempted.`,
  );
}

/** Retained only as a non-authorizing compatibility guard for old imports. */
export function looksDisposable(name) {
  return typeof name === "string" && LEGACY_DISPOSABLE_NAME_RE.test(name) &&
    !Object.values(V048_DISPOSABLE_TEARDOWN_NAMES).includes(name);
}

/** Retained only to explain why every historical name-only mutation is refused. */
export function protectedList(raw) {
  if (typeof raw !== "string") return Object.freeze([]);
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value))) {
    throw new DisposableTeardownError("TEARDOWN_PROTECTED_LOCK_INVALID");
  }
  return Object.freeze([...new Set(values)].sort());
}

export function protectedListMissing(raw = PROTECTED_RAW) {
  try {
    return protectedList(String(raw ?? "")).length === 0;
  } catch {
    return true;
  }
}

export function teardownDecision(
  name,
  { protectedPrefixes = [], protectedRaw = PROTECTED_RAW } = {},
) {
  if (typeof name !== "string" || name.length === 0) {
    return Object.freeze({ allowed: false, reason: "name_missing" });
  }
  if (!looksDisposable(name)) {
    return Object.freeze({ allowed: false, reason: "name_not_brain_test" });
  }
  let prefixes;
  try {
    prefixes = protectedRaw === null
      ? Object.freeze([...protectedPrefixes])
      : protectedList(protectedRaw);
  } catch {
    return Object.freeze({ allowed: false, reason: "protected_lock_invalid" });
  }
  if (prefixes.length === 0) {
    return Object.freeze({ allowed: false, reason: "protected_lock_missing" });
  }
  const hit = prefixes.some((prefix) =>
    prefix instanceof RegExp ? prefix.test(name) : name.startsWith(prefix));
  return Object.freeze(hit
    ? { allowed: false, reason: "protected_match" }
    : { allowed: false, reason: "legacy_path_retired" });
}

/** Every imported legacy runner call stops before reading its arguments. */
export async function runV048DisposableCampaignTeardown() {
  refuseRetired();
}

/** Every historical source, target, preview, or commit CLI form is retired. */
export function parseV048DisposableTeardownCliArguments() {
  refuseRetired();
}

/** The old lifecycle derivation belonged to the retired operator ceremony. */
export function parseV048TeardownLifecycleQuiescenceCliArguments() {
  refuseRetired();
}

let RUN_DIRECTLY = false;
try {
  RUN_DIRECTLY = Boolean(process.argv[1]) &&
    realpathSync.native(resolve(process.argv[1])) ===
      realpathSync.native(fileURLToPath(import.meta.url));
} catch {
  // A missing or replaced invocation path is not trusted as a direct run.
}

if (RUN_DIRECTLY) {
  console.error(
    `${RETIRED_CODE}: Run the installed ${BROKER_COMMAND}. ` +
      "No Cloudflare read or mutation was attempted.",
  );
  process.exitCode = 1;
}
