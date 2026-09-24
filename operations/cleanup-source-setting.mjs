import {
  closeSync, constants as fsConstants, existsSync, fsyncSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cleanupRuleSourceSetting(manifest, rule) {
  if (rule?.kind !== "outside_drive_path" || typeof rule.path !== "string" || !rule.path.trim()) {
    throw new Error("a non-empty Drive exclusion path is required");
  }
  const next = structuredClone(manifest || {});
  next.corpora ||= {};
  next.corpora.google_drive ||= {};
  const paths = Array.isArray(next.corpora.google_drive.exclude_paths)
    ? next.corpora.google_drive.exclude_paths.map(String)
    : [];
  const value = rule.path.trim();
  next.corpora.google_drive.exclude_paths = paths.includes(value) ? paths : [...paths, value];
  return next;
}

export function prepareCleanupSourceSetting(manifest, rule) {
  const next = cleanupRuleSourceSetting(manifest, rule);
  const payload = {
    version: 1,
    rule: { kind: "outside_drive_path", path: rule.path.trim() },
    before_manifest_sha256: sha256(Buffer.from(JSON.stringify(manifest))),
    after_manifest_sha256: sha256(Buffer.from(JSON.stringify(next))),
    setting: "corpora.google_drive.exclude_paths",
    value: rule.path.trim(),
    changed: JSON.stringify(manifest) !== JSON.stringify(next),
  };
  return { ...payload, fingerprint: sha256(stable(payload)) };
}

export function applyCleanupSourceSetting(manifest, plan, approvalFingerprint) {
  const current = prepareCleanupSourceSetting(manifest, plan?.rule);
  if (!plan || current.fingerprint !== plan.fingerprint) {
    const error = new Error("the source-setting plan changed; review its new fingerprint");
    error.code = "cleanup_source_setting_changed";
    throw error;
  }
  if (!approvalFingerprint || approvalFingerprint !== current.fingerprint) {
    const error = new Error("approve the exact current source-setting fingerprint before applying it");
    error.code = "cleanup_source_setting_not_approved";
    throw error;
  }
  return { manifest: cleanupRuleSourceSetting(manifest, current.rule), receipt: current };
}

export function writeCleanupSourceSetting(manifestPath, plan, approvalFingerprint) {
  const target = resolve(manifestPath);
  const beforeBytes = readFileSync(target);
  const beforeStat = statSync(target);
  const current = JSON.parse(beforeBytes.toString("utf8"));
  const { manifest, receipt } = applyCleanupSourceSetting(current, plan, approvalFingerprint);
  const output = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const temporary = `${dirname(target)}/.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    const recheck = statSync(target);
    const recheckBytes = readFileSync(target);
    if (recheck.dev !== beforeStat.dev || recheck.ino !== beforeStat.ino ||
        !recheckBytes.equals(beforeBytes)) {
      const error = new Error("the manifest changed before the approved source setting could be written");
      error.code = "cleanup_source_setting_changed";
      throw error;
    }
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      beforeStat.mode & 0o777,
    );
    if (writeSync(fd, output, 0, output.length, 0) !== output.length) {
      throw new Error("the source-setting manifest write was incomplete");
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    const verified = JSON.parse(readFileSync(target, "utf8"));
    const verifyPlan = prepareCleanupSourceSetting(current, plan.rule);
    if (sha256(Buffer.from(JSON.stringify(verified))) !== verifyPlan.after_manifest_sha256) {
      throw new Error("the source setting did not pass exact manifest readback");
    }
    return { ...receipt, applied: true };
  } finally {
    beforeBytes.fill(0);
    output.fill(0);
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
