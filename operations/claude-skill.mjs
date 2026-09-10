/**
 * Install the reviewed Financial Brain technician skill into Claude Code's
 * personal skill directory without turning the installer into a general
 * configuration writer. The skill contains workflow and permission boundaries
 * only. It has no credential, instance locator, or customer-specific value.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "./cli-guidance.mjs";

export const CLAUDE_TECHNICIAN_SKILL_NAME = "financial-brain-technician";
export const CLAUDE_TECHNICIAN_SKILL_MARKER =
  "<!-- financial-brain-installer:claude-skill:v1 -->";

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

function reviewedSkillContent(sourcePath = PACKAGED_SKILL_PATH, options = {}) {
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
