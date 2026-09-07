/** Human-readable commands, using the executable actually running on Windows. */
import { existsSync as defaultExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCopyableCommand } from './command-display.mjs';
const COMMAND = /\bbrain(?=\s+(?:init|setup|ask|doctor|whatsnew|verify|provision|deploy|secrets|health|test|mcp-config|migrate|ingest|import|load|connect|disconnect|status|sources|forget|drain|reindex|diagnose|check|eval|grant|grants|zone|invite|devices|token|update|upgrade|rollback|schedule|support|tools|technician|--version)\b)/g;
/**
 * The shim npm writes for this package on Windows.
 *
 * `brain.cmd drain` runs the same code as the absolute node invocation, in a
 * form a worried reader can retype, and without printing the owner's profile
 * directory on a screen the runbook says may be shared.
 */
const WINDOWS_SHIM = 'brain.cmd';
/** Directories a `brain.cmd` for THIS install could sit in. */
function shimDirectories(scriptPath, pathVariable) {
  const script = String(scriptPath ?? '');
  const separator = script.includes('\\') ? '\\' : '/';
  const segments = script.split(/[\\/]/);
  const directories = [];
  // npm writes the shim into the install prefix, one level above node_modules,
  // so the running script's own path names the place to look first.
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i].toLowerCase() === 'node_modules') directories.push(segments.slice(0, i).join(separator));
  }
  for (const entry of String(pathVariable ?? '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (directory) directories.push(directory);
  }
  return directories;
}
function windowsShimResolvable(scriptPath, env, existsSync) {
  const pathVariable = env ? (env.PATH ?? env.Path ?? env.path) : undefined;
  for (const directory of shimDirectories(scriptPath, pathVariable)) {
    const candidate = `${directory}${directory.includes('\\') ? '\\' : '/'}${WINDOWS_SHIM}`;
    // A directory we cannot stat is simply not a shim; never fail a render on it.
    try { if (existsSync(candidate)) return true; } catch { /* not resolvable */ }
  }
  return false;
}
export function brainCliPrefix({ platform = process.platform, nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL('../brain.mjs', import.meta.url)),
  env = process.env, existsSync = defaultExistsSync } = {}) {
  if (platform !== 'win32') return 'brain';
  if (windowsShimResolvable(scriptPath, env, existsSync)) return WINDOWS_SHIM;
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
