/** Read-only local routing. Never activates COM or contacts a provider. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { qbdEnvironment } from '../operations/quickbooks-desktop-signed.mjs';
import { qbdFailure } from './quickbooks-desktop-binding.mjs';

export function desktopRegistry({ run = spawnSync, environment = process.env } = {}) {
  const env = qbdEnvironment(environment);
  return (key, view = 64, recursive = false) => {
    if (!/^[A-Za-z]:\\Windows$/i.test(env.SystemRoot || '')) throw qbdFailure('QB_NOT_INSTALLED');
    const result = run(win32.join(env.SystemRoot, 'System32', 'reg.exe'), ['query', key, `/reg:${view}`, ...(recursive ? ['/s'] : [])], {
      env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result?.error || result?.signal || ![0, 1].includes(result?.status)) throw qbdFailure('QB_LOCAL_PROBE_FAILED');
    return result.status === 0 ? String(result.stdout || '') : '';
  };
}
export function hasDesktopElevation({ registry = desktopRegistry() } = {}) {
  return ['HKCU', 'HKLM'].some(hive => [32, 64].some(view => {
    const layers = registry(`${hive}\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers`, view);
    return layers.split(/\r?\n/).some(line => /\\QBW[^\\]*\.exe\s+REG_SZ\s+/i.test(line) && /\bRUNASADMIN\b/i.test(line));
  }));
}
export function probeQuickBooksEdition({ platform = process.platform, registry, environment = process.env,
  listApps = () => readdirSync('/Applications'), readShortcuts } = {}) {
  if (platform === 'darwin') {
    const apps = listApps();
    return apps.some(name => /^QuickBooks(?:\s.*)?\.app$/i.test(name)) ? 'mac-desktop' : 'none';
  }
  if (platform !== 'win32') return 'none';
  const query = registry || desktopRegistry({ environment });
  const registered = [32, 64].some(view => /REG_SZ/.test(query('HKLM\\SOFTWARE\\Classes\\QBXMLRP2.RequestProcessor\\CLSID', view)));
  const installed = [32, 64].some(view => /QuickBooks/i.test(query('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', view, true)));
  if (registered && installed) return 'windows-desktop';
  // FIELD-VERIFY: bounded .rdp RemoteApp text is evidence only. Binary .lnk
  // resolution and host-specific launchers are not treated as local installs.
  const shortcuts = readShortcuts || (() => {
    const roots = [environment.USERPROFILE && join(environment.USERPROFILE, 'Desktop'),
      environment.APPDATA && join(environment.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')].filter(Boolean);
    return roots.flatMap(root => !existsSync(root) ? [] : readdirSync(root).filter(name => /quickbooks.*\.rdp$/i.test(name)).slice(0, 100)
      .map(name => readFileSync(join(root, name), 'utf8').slice(0, 65536)));
  });
  return shortcuts().some(text => /(?:remoteapplicationname:s:.*QuickBooks|remoteapplicationprogram:s:.*QBW|full address:s:)/i.test(text)) ? 'hosted' : 'none';
}
export const DESKTOP_BOUNDARY = Object.freeze({
  'mac-desktop': 'QuickBooks Desktop for Mac has no live connection in this version. Export reports and use the upload door for searchable records; money answers are unavailable.',
  hosted: 'Hosted QuickBooks Desktop has no live connection in this version. Export reports and use the upload door for searchable records; money answers are unavailable.',
});
