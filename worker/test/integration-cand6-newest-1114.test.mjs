import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductFixture } from './product-contract-fixture.mjs';
import { readOwnerDocumentPage } from '../src/lib/mcp-endpoint.js';
import { readDocumentEvidence } from '../src/lib/document-answer.js';

// Whole-record receipts must describe the active revision, even when a shorter
// replacement deliberately keeps obsolete tail chunks for recoverability.
for (const retained of [false, true]) {
  test(`integrated fetch/read receipt excludes retained tails: retained=${retained}`, async () => {
    const f = await createProductFixture();
    try {
      f.raw("INSERT INTO sources(name,kind,created_at) VALUES('drive','drive','2026-01-01')");
      const put = async content => {
        const response = await f.post('/api/admin/brain/ingest/batch', { docs: [{
          source_type: 'drive', source_id: 'record', title: 'Owner record', content,
          occurred_at: '2026-11-14T12:00:00Z', text_source: 'native', text_reliable: true,
          metadata: retained ? { brain_retained_ingest: 1 } : {},
        }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.failed, 0, 'real ingest accepted the revision');
      };
      await put('Obsolete payable USD 9000. '.repeat(800));
      const oldCount = f.first("SELECT COUNT(*) AS n FROM chunks WHERE doc_uid='drive:record'").n;
      assert.ok(oldCount > 1, 'populated old revision has a tail');
      const current = 'Current payable USD 7 is a quoted obligation, not proof of a bank payment.';
      const storedCurrent = `[Owner record]\n\n${current}`;
      await put(current);
      const physical = f.first("SELECT COUNT(*) AS n FROM chunks WHERE doc_uid='drive:record'").n;
      assert.equal(physical, retained ? oldCount : 1, 'retained arm actually reaches stored obsolete tails');

      const before = f.seen.sql.length;
      const result = await readOwnerDocumentPage(f.env, { id: 'drive:record' }, 'https://fixture.invalid');
      assert.ok(f.seen.sql.slice(before).some(sql => /COUNT\(\*\) OVER\(\) AS total_chunks/.test(sql)),
        'real bounded joined reading decision reached');
      assert.equal(result.isError, undefined);
      const page = JSON.parse(result.content[0].text);
      assert.equal(page.text, storedCurrent, 'fetch never republishes obsolete monetary evidence');
      assert.equal(page.read_coverage.kind, 'whole_stored_record');
      assert.equal(page.read_coverage.expected_stored_chunks, 1);
      assert.deepEqual(page.read_coverage.chunk_indices, [0]);
      assert.equal(page.read_coverage.source_complete, false);
      assert.equal(page.page.complete, true);

      const readBefore = f.seen.sql.length;
      const [read] = await readDocumentEvidence(f.env, [{ doc_uid: 'drive:record', snippet: current }]);
      assert.ok(f.seen.sql.slice(readBefore).some(sql => /total_chunks/.test(sql)),
        'answer evidence reader reached its actual whole-record decision');
      assert.equal(read.snippet, storedCurrent);
      assert.equal(read.read_complete, true);
      assert.equal(read.read_coverage.expected_stored_chunks, 1);
    } finally { f.close(); }
  });
}
