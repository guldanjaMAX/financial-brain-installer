import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPayload } from './payload.mjs';
export function setupEnvironment({ root, environment }) {
  // Select private Node directly; inherited loaders and credentials must not
  // change the CLI child. No global npm, PATH mutation or shell is needed.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
    if (environment[key]) env[key] = environment[key];
  }
  // Derive only the official native Claude directory, never inherit desktop
  // PATH. Delimiters in a profile would introduce additional search entries.
  const profile = env.USERPROFILE;
  if (typeof profile !== 'string' || !win32.isAbsolute(profile) || /[;"\x00-\x1f\x7f]/.test(profile)) throw new Error('LAUNCH_REFUSED');
  env.PATH = [join(root, 'runtime'), join(env.SystemRoot, 'System32'), win32.join(profile, '.local', 'bin')].join(';');
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return env;
}
export function launch({ root, args, home, environment }, { spawn = spawnSync } = {}) {
  const receipt = verifyPayload(root);
  if (args.length === 1 && args[0] === '--self-check') return 0;
  if (args.length || receipt.evidence !== 'real') throw new Error('LAUNCH_REFUSED');
  const env = setupEnvironment({ root, environment });
  const result = spawn(join(root, 'runtime', 'node.exe'), [join(root, 'cli', 'brain.mjs'), 'setup', join(home, 'Financial Brain', 'brain.manifest.json')], { env, stdio: 'inherit', windowsHide: true, shell: false });
  return result.status ?? 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = launch({ root: dirname(fileURLToPath(import.meta.url)), args: process.argv.slice(2), home: process.env.USERPROFILE, environment: process.env }); }
  catch { process.stderr.write('PAYLOAD_LAUNCH_REFUSED=1\n'); process.exitCode = 2; }
}
