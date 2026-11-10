// Internal review build. Downloads stay in the explicit scratch directory.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifact, inventory, NODE_ARCHIVE, NODE_SHA256, NODE_VERSION, sha256, stagePayload, verifyPayload } from './payload.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const id = path => 'P' + sha256(path).slice(0, 24);
const guid = path => {
  const hash = sha256(path).slice(0, 32);
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
};

// Every generated directory gets an HKCU key path and empty-directory cleanup
// for ICE38/ICE57/ICE64. Multi-file registry-keypath components need explicit
// GUIDs; bind those to version plus relative directory, never a build path.
// No recursive deletion, owner-state path or wildcard removal is authored.
export function wixPayload(root) {
  const receipt = verifyPayload(root);
  const rows = [...receipt.inventory, { path: 'payload-receipt.json', kind: 'file' }];
  const walk = (prefix, directory) => {
    const children = rows.filter(row => dirname(row.path).replaceAll('\\', '/') === (prefix || '.'));
    let body = `<Component Id="${id(prefix + ':component')}" Directory="${directory}" Guid="${guid(receipt.version + ':' + prefix)}"><RegistryValue Root="HKCU" Key="Software\\FinancialBrain\\Payload\\${receipt.version}" Name="${id(prefix)}" Type="integer" Value="1" KeyPath="yes"/><RemoveFolder Id="${id(prefix + ':remove')}" On="uninstall"/>`;
    for (const row of children.filter(row => row.kind === 'file')) body += `<File Id="${id(row.path)}" Source="${xml(join(root, row.path))}" Name="${xml(row.path.split('/').at(-1))}"/>`;
    // Directory rows alone do not create empty directories in MSI. Node's
    // upstream ZIP includes empty snapshot directories that exact readback
    // must preserve even though the runtime never uses them.
    body += '<CreateFolder /></Component>';
    for (const row of children.filter(row => row.kind === 'directory')) body += `<Directory Id="${id(row.path + ':dir')}" Name="${xml(row.path.split('/').at(-1))}">${walk(row.path, id(row.path + ':dir'))}</Directory>`;
    return body;
  };
  const body = walk('', 'INSTALLFOLDER');
  const components = [...body.matchAll(/<Component Id="([^"]+)"/g)].map(match => `<ComponentRef Id="${match[1]}"/>`).join('');
  return `<?xml version="1.0"?><Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><DirectoryRef Id="INSTALLFOLDER">${body}</DirectoryRef><ComponentGroup Id="VerifiedPayload">${components}</ComponentGroup></Fragment></Wix>\n`;
}
export async function buildPayload({ repository, scratch, npmCli, sourceSha }, { environment = process.env } = {}) {
  repository = resolve(repository); scratch = resolve(scratch);
  mkdirSync(scratch, { recursive: true });
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (environment[key]) env[key] = environment[key];
  env.PATH = dirname(process.execPath) + ';' + join(env.SystemRoot, 'System32');
  const run = (executable, args, cwd = scratch) => {
    const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0 || child.error) throw new Error('BUILD_CHILD_REFUSED');
    return child.stdout;
  };
  const download = async name => {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`, { redirect: 'error' });
    if (!response.ok) throw new Error('DOWNLOAD_REFUSED');
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(scratch, name), bytes); return bytes;
  };
  const sums = (await download('SHASUMS256.txt')).toString('utf8');
  if (!sums.split(/\r?\n/).includes(`${NODE_SHA256}  ${NODE_ARCHIVE}`)) throw new Error('OFFICIAL_CHECKSUM_MISMATCH');
  const archive = await download(NODE_ARCHIVE);
  if (sha256(archive) !== NODE_SHA256) throw new Error('RUNTIME_ARCHIVE_MISMATCH');
  run(join(env.SystemRoot, 'System32', 'tar.exe'), ['-xf', join(scratch, NODE_ARCHIVE)]);
  const runtime = join(scratch, 'runtime'); mkdirSync(runtime);
  // Keep npm/npx private as well: later CLI prerequisites use the pinned
  // package manager. Never ship the upstream machine-wide tools installer.
  for (const name of ['node.exe', 'LICENSE', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'node_modules']) cpSync(join(scratch, `node-v${NODE_VERSION}-win-x64`, name), join(runtime, name), { recursive: true });
  const npmUserConfig = join(scratch, 'npm-userconfig');
  writeFileSync(npmUserConfig, '');
  const packed = JSON.parse(run(process.execPath, [resolve(npmCli), 'pack', '--json', '--ignore-scripts', '--userconfig', npmUserConfig, '--cache', join(scratch, 'npm-cache'), '--pack-destination', scratch], repository));
  const cliArchive = join(scratch, packed[0].filename);
  run(join(env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', cliArchive]);
  const cli = join(scratch, 'package');
  const version = JSON.parse(readFileSync(join(cli, 'package.json'))).version;
  const receipt = { schema: 1, evidence: 'real', version, architecture: 'x64', source_sha: sourceSha,
    runtime: { root: runtime, version: NODE_VERSION, archive: artifact(join(scratch, NODE_ARCHIVE)), inventory: inventory(runtime) },
    cli: { root: cli, archive: artifact(cliArchive), inventory: inventory(cli) } };
  const destination = join(scratch, 'payload');
  const manifest = stagePayload({ receipt, destination });
  writeFileSync(join(scratch, 'input-receipt.json'), JSON.stringify(receipt) + '\n');
  writeFileSync(join(here, 'Payload.generated.wxs'), wixPayload(destination));
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, scratch, npmCli, sourceSha] = process.argv.slice(2);
  try { const receipt = await buildPayload({ repository, scratch, npmCli, sourceSha }); console.log(`PAYLOAD_READY=${receipt.version}`); }
  catch (error) {
    console.error(/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'PAYLOAD_BUILD_REFUSED');
    process.exitCode = 2;
  }
}
