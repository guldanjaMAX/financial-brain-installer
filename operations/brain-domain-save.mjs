import { closeSync, constants, existsSync, fchmodSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { replaceFileWithRetrySync } from "./rename-retry.mjs";

export const DOMAIN_NOT_SAVED_CODE = "BRAIN_DOMAIN_NOT_SAVED";
export const DOMAIN_NOT_SAVED_LINE = "The web address could not be saved yet; this step will continue. " +
  `${DOMAIN_NOT_SAVED_CODE}: https://financialbrain.ai/help/${DOMAIN_NOT_SAVED_CODE}`;

/** Insert one property, retaining every pre-existing byte (including large integers). */
export function commitMissingDomain(pin, domain, { parseStructure, pinManifest, revalidateManifest, platform } = {}) {
  const root = parseStructure(pin.raw);
  const brain = root.members?.find(member => member.key === "brain")?.value;
  if (brain?.type !== "object") throw new Error("the manifest needs one brain object");
  if (brain.members.some(member => member.key === "domain")) return pin.manifest.brain.domain;
  const last = brain.members.at(-1);
  const offset = last ? last.valueEnd : brain.open + 1;
  const insertion = `${last ? "," : ""}"domain":${JSON.stringify(domain)}`;
  const output = Buffer.from(pin.raw.slice(0, offset) + insertion + pin.raw.slice(offset), "utf8");
  const temporary = join(dirname(pin.target), `.${basename(pin.target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    if (writeSync(descriptor, output, 0, output.length, 0) !== output.length) throw new Error("the address write was incomplete");
    fchmodSync(descriptor, pin.stat.mode & 0o777);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    replaceFileWithRetrySync(temporary, pin.target, { platform,
      revalidate: () => revalidateManifest(pin, "verified address commit") });
    const verified = pinManifest(pin.target);
    if (verified.raw !== output.toString("utf8") || verified.manifest.brain?.domain !== domain) {
      throw new Error("the saved address did not read back exactly");
    }
    return domain;
  } finally {
    output.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * An optional address save borrows access already held by the deploy. It never
 * acquires/renews credentials or lets a denied read escape to token recovery.
 */
export async function saveMissingDomain(manifestPath, options, { pinManifest, persist, readSubdomain, subdomainReceipt, report }) {
  if (options.dryRun === true) return null;
  try {
    const pin = pinManifest(manifestPath);
    const m = pin.manifest;
    if (Object.hasOwn(m.brain || {}, "domain")) return m.brain.domain;
    const account = { id: m.infrastructure?.cloudflare?.account_id };
    if (!account.id) throw new Error("the manifest has no bound account");
    const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
    return await persist(manifestPath, m, account, scriptName, {
      ...options,
      domainPin: pin,
      workersDevSubdomain: subdomainReceipt(account.id),
      readSubdomain: options.readSubdomain ?? (() => readSubdomain(account.id)),
    });
  } catch {
    // Raw provider errors can carry private identifiers. This one line also
    // distinguishes the optional save from a failed deploy or failed update.
    (options.report ?? report)(DOMAIN_NOT_SAVED_LINE);
    return null;
  }
}
