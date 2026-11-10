import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifact, inventory, NODE_VERSION } from '../../machine-prep/installers/windows/payload.mjs';
export function fixture() {
  // macOS TMPDIR commonly traverses /var -> /private/var. Feed the physical
  // fixture path to the same strict staging checks used on Windows.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'payload space ')));
  const runtime = join(root, 'runtime'), cli = join(root, 'cli');
  mkdirSync(runtime); mkdirSync(cli);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  writeFileSync(join(runtime, 'node.exe'), pe);
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'brain-installer', version: '0.0.1', bin: { brain: './brain.mjs' } }));
  writeFileSync(join(cli, 'brain.mjs'), '// synthetic');
  writeFileSync(join(root, 'cli.tgz'), 'synthetic archive');
  return { root, destination: join(root, 'stage'), receipt: { schema: 1, evidence: 'synthetic', version: '0.0.1', architecture: 'x64', source_sha: '0'.repeat(40), runtime: { root: runtime, version: NODE_VERSION, inventory: inventory(runtime) }, cli: { root: cli, archive: artifact(join(root, 'cli.tgz')), inventory: inventory(cli) } } };
}
