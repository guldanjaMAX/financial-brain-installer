import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chunkText } from '../../worker/src/lib/store.js';

// Reviewed Drive/Gmail restore repair requires confirmed physical parts, not
// family presence. Test senders call accept only after their accepted callback.
export function currentPartsFixture() {
  const accepted = new Map();
  const geometry = { size: 1200, overlap: 150 };
  const database = { instance: '1'.repeat(32), nonce: '2'.repeat(32), generation: 1 };
  const receipt = envelope => ({
    source_id: envelope.source_id,
    content_hash: createHash('sha256').update(`chunk-v1:${geometry.size}:${geometry.overlap}\0${envelope.content}`).digest('hex'),
    chunk_count: chunkText(envelope.content, geometry).length,
  });
  const accept = envelope => accepted.set(`${envelope.source_type}:${envelope.source_id}`, receipt(envelope));
  const read = async ({ source, envelopes, proof }) => ({ database, geometry,
    parts: (envelopes || proof?.parts || []).flatMap(candidate => {
      const part = accepted.get(`${source}:${candidate.source_id}`);
      const expected = envelopes ? receipt(candidate) : candidate;
      return part && part.content_hash === expected.content_hash && part.chunk_count === expected.chunk_count ? [part] : [];
    }),
  });
  return { accept, read };
}

// Keep the real incremental orchestrator and its entry/settlement boundaries.
// Only the provider transport is simulated; a second page cannot invent work.
export function driveChangesFixture(drive, files, { token = 'prior-cursor', next = 'next-cursor' } = {}) {
  const calls = { pages: 0, metadata: 0 };
  return { calls, drive: { ...drive,
    listChangePage: async (_get, saved) => {
      calls.pages++;
      assert.ok([token, next].includes(saved), 'the saved feed token reached the provider');
      return { changes: saved === token ? files.map(file => ({ fileId: file.id, file })) : [], nextToken: next, terminal: true };
    },
    getFileMetadata: async (_get, id) => {
      calls.metadata++;
      const file = files.find(file => file.id === id);
      assert.ok(file, 'the exact change identity reached metadata readback');
      return file;
    },
    changeScope: async () => ({ inScope: true, folders: {}, rootIds: ['fixture-root'] }),
    isPermanentFileFailure: () => false,
  } };
}
