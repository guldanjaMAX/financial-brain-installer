/** Human-readable commands, using the executable actually running on Windows. */
import { existsSync as defaultExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCopyableCommand } from './command-display.mjs';
const COMMAND = /\bbrain(?=\s+(?:init|setup|ask|doctor|whatsnew|verify|provision|deploy|secrets|health|test|mcp-config|assistant-repair|migrate|ingest|import|load|connect|disconnect|status|sources|forget|drain|reindex|diagnose|check|eval|grant|grants|zone|invite|devices|token|update|upgrade|rollback|schedule|support|tools|technician|--version)\b)/g;
/**
 * The shim npm writes for this package on Windows.
 *
 * `brain.cmd drain` runs the same code as the absolute node invocation, in a
 * form a worried reader can retype, and without printing the owner's profile
 * directory on a screen the runbook says may be shared.
 *
 * It is only printed when the shell would resolve it to THIS install. A
 * --prefix install is routinely not on PATH while an older copy of the package
 * is, and the bare word there runs the other install against the client's
 * brain: a verbose correct instruction beats a short wrong one every time.
 */
const WINDOWS_SHIM = 'brain.cmd';

/** Compare two Windows directories the way the filesystem does. */
function sameDirectory(a, b) {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * The prefixes a `brain.cmd` for THIS install could sit in.
 *
 * npm writes the shim into the install prefix, one level above node_modules,
 * so the running script's own path names every place that could hold ours.
 */
function installPrefixes(scriptPath) {
  const script = String(scriptPath ?? '');
  const separator = script.includes('\\') ? '\\' : '/';
  const segments = script.split(/[\\/]/);
  const prefixes = [];
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i].toLowerCase() === 'node_modules') prefixes.push(segments.slice(0, i).join(separator));
  }
  return prefixes;
}

/** PATH entries in the order the shell searches them. */
function pathDirectories(pathVariable) {
  const directories = [];
  for (const entry of String(pathVariable ?? '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (directory) directories.push(directory);
  }
  return directories;
}

function readPath(env) {
  return env ? (env.PATH ?? env.Path ?? env.path) : undefined;
}

/**
 * Would typing `brain.cmd` run THIS install?
 *
 * The shell's own rule: walk PATH in order and stop at the FIRST shim. It
 * answers true only when that shim belongs to this install, so a prefix that
 * is not on PATH, and a stale shim that shadows ours, both answer false.
 */
function resolveWindowsShim(scriptPath, pathVariable, existsSync) {
  const prefixes = installPrefixes(scriptPath);
  if (!prefixes.length) return false;
  for (const directory of pathDirectories(pathVariable)) {
    const candidate = `${directory}${directory.includes('\\') ? '\\' : '/'}${WINDOWS_SHIM}`;
    // A directory we cannot stat is simply not a shim; never fail a render on it.
    let found = false;
    try { found = existsSync(candidate); } catch { found = false; }
    if (found) return prefixes.some((prefix) => sameDirectory(prefix, directory));
  }
  return false;
}

/*
 * One answer per (platform, script, PATH), because this sits behind every
 * ok/info/warn/say line the product prints. Unmemoised, a shim-less box pays
 * one existsSync per PATH entry per printed line - about thirty, forever, for
 * an answer that cannot change inside a process.
 */
let shimCache = null;

/** Drop the memoised answer. Tests that swap the injected existsSync use it. */
export function resetCliPrefixCache() {
  shimCache = null;
}

function windowsShimResolvable(platform, scriptPath, env, existsSync) {
  const pathVariable = readPath(env);
  const key = `${platform} ${String(scriptPath ?? '')} ${String(pathVariable ?? '')}`;
  // The injected existsSync is part of the identity: a test that swaps the
  // filesystem without swapping PATH must not read the previous answer.
  if (shimCache && shimCache.key === key && shimCache.existsSync === existsSync) return shimCache.value;
  const value = resolveWindowsShim(scriptPath, pathVariable, existsSync);
  shimCache = { key, existsSync, value };
  return value;
}

export function brainCliPrefix({ platform = process.platform, nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL('../brain.mjs', import.meta.url)),
  env = process.env, existsSync = defaultExistsSync } = {}) {
  if (platform !== 'win32') return 'brain';
  if (windowsShimResolvable(platform, scriptPath, env, existsSync)) return WINDOWS_SHIM;
  return renderCopyableCommand(nodePath, [scriptPath], { platformName: platform });
}

export function renderCliCommands(text, options = {}) {
  const value = String(text);
  const prefix = brainCliPrefix(options);
  // The callback prevents dollar sequences in a real executable path being
  // interpreted as String.replace substitutions. A second render is inert.
  return prefix === 'brain' ? value : value.replace(COMMAND, () => prefix);
}

/**
 * One stderr emitter for the scheduler daemons.
 *
 * Each scheduler grew its own private copy of the support-receipt printer, and
 * every copy dropped the renderer that the installer's own copy has. They are
 * the same sentences, so the bare form is invisible to a text search. Route
 * them through here instead of adding a seventh copy.
 */
export function printGuidance(line, { write = console.error, ...options } = {}) {
  write(renderCliCommands(line, options));
}
