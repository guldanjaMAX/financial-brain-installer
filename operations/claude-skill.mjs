/**
 * Install the reviewed Financial Brain technician skill into Claude Code's
 * personal skill directory without turning the installer into a general
 * configuration writer. The skill contains workflow and permission boundaries
 * only. It has no credential, instance locator, or customer-specific value.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "./cli-guidance.mjs";

export const CLAUDE_TECHNICIAN_SKILL_NAME = "financial-brain-technician";
export const CLAUDE_TECHNICIAN_SKILL_MARKER =
  "<!-- financial-brain-installer:claude-skill:v1 -->";
const LOCAL_ASSISTANT_REPAIR_SKILL_ROOTS = Object.freeze([".claude", ".codex"]);

const PACKAGED_SKILL_PATH = fileURLToPath(new URL(
  `../skills/${CLAUDE_TECHNICIAN_SKILL_NAME}/SKILL.md`,
  import.meta.url,
));

function ownerHome(options = {}) {
  const candidate = options.home || options.environment?.HOME ||
    options.environment?.USERPROFILE || homedir();
  const absolute = resolve(String(candidate || ""));
  if (!absolute || /[\u0000-\u001f\u007f]/.test(absolute)) {
    throw new Error("the owner home path is not safe for Claude skill installation");
  }
  return absolute;
}

function ensureOwnedDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Claude skill installation paused because ${path} is not a regular directory`);
    }
    return;
  }
  const parent = dirname(path);
  if (parent !== path) ensureOwnedDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

export function reviewedSkillContent(sourcePath = PACKAGED_SKILL_PATH, options = {}) {
  const content = readFileSync(sourcePath, "utf8");
  if (!content.includes(CLAUDE_TECHNICIAN_SKILL_MARKER) || content.length > 64 * 1024) {
    throw new Error("the packaged Financial Brain Claude skill did not pass its identity check");
  }
  // The owner's own assistant reads this file and then runs what it names, in
  // the owner's shell. Rendering at install time is the only point that knows
  // which machine it landed on. It runs after the identity check so the marker
  // is checked against the packaged bytes, and it is idempotent, so the
  // unchanged-content comparison below stays stable across runs.
  return renderCliCommands(content, options);
}

function sameFile(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode &&
    left.size === right.size && left.nlink === 1 && right.nlink === 1;
}

function inspectedSkill(root, options = {}) {
  const path = technicianSkillPathFor(root, options);
  const desired = reviewedSkillContent(options.sourcePath);
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        root,
        path,
        status: "missing",
        will_change: true,
        state_fingerprint: "absent",
      });
    }
    return Object.freeze({
      root,
      path,
      status: "unsafe",
      will_change: false,
      state_fingerprint: "unreadable",
    });
  }

  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > 64 * 1024 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    return Object.freeze({
      root,
      path,
      status: "unsafe",
      will_change: false,
      state_fingerprint: `unsafe:${before.dev}:${before.ino}:${before.mode}:${before.size}:${before.nlink}`,
    });
  }

  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error("the skill changed while it was inspected");
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) throw new Error("the skill changed while it was read");
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("the skill is not valid UTF-8");
    const stateFingerprint = createHash("sha256")
      .update(bytes)
      .update(`\0${opened.mode & 0o7777}`)
      .digest("hex");
    const status = content === desired
      ? "current"
      : content.includes(CLAUDE_TECHNICIAN_SKILL_MARKER)
        ? "installer_owned_outdated"
        : "custom";
    return Object.freeze({
      root,
      path,
      status,
      will_change: status === "installer_owned_outdated",
      state_fingerprint: stateFingerprint,
    });
  } catch {
    return Object.freeze({
      root,
      path,
      status: "unsafe",
      will_change: false,
      state_fingerprint: `unsafe:${before.dev}:${before.ino}:${before.mode}:${before.size}:${before.nlink}`,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read-only, byte-bound inspection used by the Optimize handoff repair preview. */
export function inspectTechnicianSkillEverywhere(options = {}) {
  // An explicitly approved repair covers both supported skill destinations as
  // one transaction. Ordinary `brain tools` remains presence-aware below and
  // does not create Codex's private tree merely because Claude is installed.
  const roots = options.agentRoots ?? LOCAL_ASSISTANT_REPAIR_SKILL_ROOTS;
  return roots.map((root) => inspectedSkill(root, options));
}

function captureRepairableSkill(observation) {
  if (observation.status === "missing") {
    if (existsSync(observation.path)) throw new Error("the skill destination changed after preview");
    return Object.freeze({ ...observation, exists: false, bytes: null, mode: null });
  }
  let fd;
  try {
    const before = lstatSync(observation.path);
    fd = openSync(observation.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error("the skill changed before repair");
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) throw new Error("the skill changed before repair");
    const fingerprint = createHash("sha256")
      .update(bytes)
      .update(`\0${opened.mode & 0o7777}`)
      .digest("hex");
    if (fingerprint !== observation.state_fingerprint) {
      throw new Error("the skill changed after preview");
    }
    return Object.freeze({
      ...observation,
      exists: true,
      bytes,
      mode: opened.mode & 0o7777,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function restoreSkillSnapshot(snapshot, desired) {
  let current;
  try {
    current = lstatSync(snapshot.path);
  } catch (error) {
    return error?.code === "ENOENT" && !snapshot.exists;
  }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      current.size > 64 * 1024 ||
      (typeof process.getuid === "function" && current.uid !== process.getuid())) {
    return false;
  }
  let currentBytes;
  try {
    currentBytes = readFileSync(snapshot.path);
  } catch {
    return false;
  }
  if (currentBytes.toString("utf8") !== desired) return false;

  if (!snapshot.exists) {
    try {
      unlinkSync(snapshot.path);
      return !existsSync(snapshot.path);
    } catch {
      return false;
    }
  }

  const temporary = `${snapshot.path}.${process.pid}.${randomBytes(12).toString("hex")}.rollback`;
  let fd;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      snapshot.mode,
    );
    if (writeSync(fd, snapshot.bytes, 0, snapshot.bytes.length, 0) !== snapshot.bytes.length) {
      throw new Error("short skill rollback write");
    }
    fchmodSync(fd, snapshot.mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!readFileSync(snapshot.path).equals(currentBytes)) {
      throw new Error("the skill changed before rollback");
    }
    renameSync(temporary, snapshot.path);
    const restored = readFileSync(snapshot.path);
    return restored.equals(snapshot.bytes) && (lstatSync(snapshot.path).mode & 0o7777) === snapshot.mode;
  } catch {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no rollback temporary remains */ }
    return false;
  }
}

/** Capture every repairable skill destination before the first bundle write. */
export function captureTechnicianSkillRepairSnapshot(observations) {
  if (!Array.isArray(observations) || observations.some((item) => item.status === "unsafe")) {
    throw new Error("the technician skill repair stopped because one destination is not safe to snapshot");
  }
  return Object.freeze(
    observations.filter((item) => item.will_change).map(captureRepairableSkill),
  );
}

function skillSnapshotIsCurrent(snapshot) {
  if (!snapshot.exists) return !existsSync(snapshot.path);
  try {
    const current = captureRepairableSkill(snapshot);
    return current.exists && current.mode === snapshot.mode && current.bytes.equals(snapshot.bytes);
  } catch {
    return false;
  }
}

export function technicianSkillRepairSnapshotIsCurrent(snapshots) {
  return Array.isArray(snapshots) && snapshots.every(skillSnapshotIsCurrent);
}

/** Restore all skill destinations, attempting every one even if another fails. */
export function rollbackTechnicianSkillRepairSnapshot(snapshots, options = {}) {
  const desired = reviewedSkillContent(options.sourcePath);
  let restored = true;
  for (const snapshot of [...(snapshots || [])].reverse()) {
    if (skillSnapshotIsCurrent(snapshot)) continue;
    if (!restoreSkillSnapshot(snapshot, desired)) restored = false;
  }
  return restored;
}

/**
 * Repair only missing or installer-owned copies of the reviewed skill.
 * Customized copies are preserved, and a multi-client write rolls back every
 * completed destination if any selected destination cannot be read back.
 */
export function repairTechnicianSkillEverywhere(options = {}) {
  const observations = options.observations ?? inspectTechnicianSkillEverywhere(options);
  if (observations.some((item) => item.status === "unsafe")) {
    throw new Error("the technician skill repair stopped because one destination is not a safe regular owner file");
  }
  const snapshots = options.snapshots ?? captureTechnicianSkillRepairSnapshot(observations);
  if (!technicianSkillRepairSnapshotIsCurrent(snapshots)) {
    throw new Error("a technician skill destination changed after it was snapshotted");
  }
  const installSkill = options.installSkill ?? installClaudeTechnicianSkill;
  const completed = [];
  let attempted = null;
  try {
    for (const snapshot of snapshots) {
      attempted = snapshot;
      const result = installSkill({ ...options, agentRoot: snapshot.root });
      const after = inspectedSkill(snapshot.root, options);
      if (!after || after.status !== "current") {
        throw new Error(`${snapshot.root} technician skill did not pass exact readback`);
      }
      completed.push(snapshot);
      if (!result || result.changed !== true) {
        throw new Error(`${snapshot.root} technician skill did not report the previewed write`);
      }
      attempted = null;
    }
  } catch (error) {
    const candidates = [...completed, ...(attempted ? [attempted] : [])]
      .filter((snapshot, index, all) =>
        all.findIndex((candidate) => candidate.path === snapshot.path) === index
      );
    const restored = rollbackTechnicianSkillRepairSnapshot(candidates, options);
    const suffix = restored
      ? "Every completed skill write was rolled back."
      : "A concurrent local change prevented complete rollback; inspect the named skill destinations before retrying.";
    throw new Error(`${String(error?.message || error)} ${suffix}`);
  }

  return Object.freeze({
    changed: completed.map((item) => item.root),
    preserved: observations.filter((item) => item.status === "custom").map((item) => item.root),
    verified: observations.filter((item) => item.status === "current").map((item) => item.root),
  });
}

/**
 * Claude Code is the current install surface. Codex can read the same skill
 * format, but an install should not create a second assistant's private config
 * tree when that assistant is not already present.
 */
export const AGENT_SKILL_ROOTS = Object.freeze([".claude"]);

export function detectedAgentSkillRoots(options = {}) {
  if (Array.isArray(options.agentRoots)) return [...options.agentRoots];
  const home = ownerHome(options);
  const roots = [...AGENT_SKILL_ROOTS];
  if ((options.existsImpl ?? existsSync)(join(home, ".codex"))) roots.push(".codex");
  return roots;
}

export function claudeTechnicianSkillPath(options = {}) {
  return technicianSkillPathFor(options.agentRoot ?? ".claude", options);
}

export function technicianSkillPathFor(root, options = {}) {
  return join(ownerHome(options), root, "skills", CLAUDE_TECHNICIAN_SKILL_NAME, "SKILL.md");
}

/** Where the skill goes for every assistant, in install order. */
export function technicianSkillPaths(options = {}) {
  return detectedAgentSkillRoots(options).map((root) => technicianSkillPathFor(root, options));
}

/**
 * Install for every assistant. One failing must not silently cost the others,
 * so each is attempted and the results are reported together.
 */
export function installTechnicianSkillEverywhere(options = {}) {
  const roots = detectedAgentSkillRoots(options);
  const results = [];
  for (const root of roots) {
    try {
      results.push({ root, ...installClaudeTechnicianSkill({ ...options, agentRoot: root }) });
    } catch (error) {
      results.push({ root, status: "failed", changed: false, error: String(error?.message || error) });
    }
  }
  return results;
}

export function installClaudeTechnicianSkill(options = {}) {
  const target = claudeTechnicianSkillPath(options);
  const content = reviewedSkillContent(options.sourcePath);
  ensureOwnedDirectory(dirname(target));

  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("the existing Claude technician skill is not a safe regular file; it was left unchanged");
    }
    const existing = readFileSync(target, "utf8");
    if (!existing.includes(CLAUDE_TECHNICIAN_SKILL_MARKER)) {
      throw new Error("a different personal skill already uses financial-brain-technician; it was left unchanged");
    }
    if (existing === content) {
      chmodSync(target, 0o600);
      return { path: target, status: "verified", changed: false };
    }
  }

  const temporary = `${target}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }

  if (readFileSync(target, "utf8") !== content) {
    throw new Error("the Claude technician skill could not be read back exactly after installation");
  }
  return { path: target, status: "installed", changed: true };
}
