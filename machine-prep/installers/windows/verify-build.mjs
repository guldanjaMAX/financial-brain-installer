import { readFileSync } from 'node:fs';
import { verifyPayload } from './payload.mjs';
import { wixPayload } from './build-payload.mjs';
const [root, generated, version] = process.argv.slice(2);
try {
  const receipt = verifyPayload(root);
  // Fixture acceptance belongs to staging/self-check, never MSI compilation.
  if (receipt.evidence !== 'real' || receipt.version !== version || readFileSync(generated, 'utf8') !== wixPayload(root)) throw new Error();
  console.log('PAYLOAD_BUILD_READBACK=1');
} catch { console.error('PAYLOAD_BUILD_REFUSED=1'); process.exitCode = 2; }
