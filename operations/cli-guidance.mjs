/** Human-readable commands, using the executable actually running on Windows. */
import { fileURLToPath } from 'node:url';
import { renderCopyableCommand } from './command-display.mjs';
const COMMAND = /\bbrain(?=\s+(?:init|setup|ask|doctor|whatsnew|verify|provision|deploy|secrets|health|test|mcp-config|migrate|ingest|import|load|connect|disconnect|status|sources|forget|drain|reindex|diagnose|check|eval|grant|grants|zone|invite|devices|token|update|upgrade|rollback|schedule|support|tools|technician)\b)/g;
export function brainCliPrefix({ platform = process.platform, nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL('../brain.mjs', import.meta.url)) } = {}) {
  if (platform !== 'win32') return 'brain';
  return renderCopyableCommand(nodePath, [scriptPath], { platformName: platform });
}
export function renderCliCommands(text, options = {}) {
  const value = String(text);
  const prefix = brainCliPrefix(options);
  // The callback prevents dollar sequences in a real executable path being
  // interpreted as String.replace substitutions. A second render is inert.
  return prefix === 'brain' ? value : value.replace(COMMAND, () => prefix);
}
