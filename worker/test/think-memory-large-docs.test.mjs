import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createProductFixture } from './product-contract-fixture.mjs';
import { search, searchKeyword, searchVector } from '../src/lib/store-d1.js';
import { discoverCorrectionSearchSeeds, discoverDocumentSuccessors } from '../src/lib/document-successors.js';
import { answerResponseContractDiagnostic } from '../../acceptance.mjs';
import { buildEnvelope } from '../../connectors/google-calendar.mjs';
import { normalizeGranolaRecord } from '../../connectors/granola-records.mjs';
import { restampFirstPartySourceProvenance } from '../src/lib/provenance-receipt.js';

test('think bounds materialized evidence and discloses each partially read citation', async t => {
  const f = await createProductFixture({ env: { AI: { async run(model) {
    if (String(model).includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    throw new Error('synthetic model unavailable');
  } } } });
  t.after(() => f.close());
  const docs = Array.from({ length: 22 }, (_, i) => ({
    source_type: 'records', source_id: String(i), title: 'Archive ' + i,
    content: i >= 20 ? 'The otter exhibit is open. Exhibit reference ' + i + '.' : 'The renewal schedule is set for December. Archive reference ' + i + '.',
    text_source: 'native', text_reliable: true
  }));
  const headers = { 'X-Admin-Key': f.env.ADMIN_KEY };
  assert.equal((await f.post('/api/admin/brain/ingest/batch', { docs }, headers)).status, 200);
  const template = f.first('SELECT * FROM chunks WHERE doc_uid=?', 'records:0');
  assert.ok(template);
  const columns = Object.keys(template).filter(key => key !== 'id');
  const insert = f.sqlite.prepare('INSERT INTO chunks (' + columns.join(',') +
    ') VALUES (' + columns.map(() => '?').join(',') + ')');
  f.raw('BEGIN');
  for (let n = 0; n < 20; n++) {
    for (let ix = 1; ix < 2000; ix++) {
      const row = { ...template, doc_uid: 'records:' + n, chunk_uid: 'records:' + n + '#' + ix,
        chunk_ix: ix, text: n === 0 ? 'note ' + ix : ('Archive item ' + n + '-' + ix).padEnd(750, '\u00e9'),
        vector_id: null };
      insert.run(...columns.map(key => row[key]));
    }
  }
  f.raw('COMMIT');

  const small = await f.post('/api/rag/think', { q: 'What does the otter exhibit say?', limit: 8 }, headers);
  assert.equal(small.status, 200);
  const smallAnswer = await small.json();
  assert.ok(smallAnswer.citations.some(c => c.read_coverage?.stored_text_complete));
  assert.match(smallAnswer.answer, /otter exhibit/);
  assert.equal(answerResponseContractDiagnostic(smallAnswer), null);

  const allReads = meterReads(f.env);
  const response = await f.post('/api/rag/think', { q: 'What does the renewal schedule say?', limit: 8 }, headers);
  assert.equal(response.status, 200);
  const body = await response.json();
  const screening = allReads.filter(read => read.sql.includes('sensitive-screen-window'));
  const evidence = allReads.filter(read => read.sql.includes('AS total_chunks') && !screening.includes(read));
  const peakDocumentBytes = Math.max(0, ...evidence.map(read => read.textBytes));
  const totalBytes = evidence.reduce((sum, read) => sum + read.textBytes, 0);
  const peakRows = Math.max(0, ...evidence.map(read => read.rows));
  const peakScreenBytes = Math.max(0, ...screening.map(read => read.textBytes));
  const screenBytes = screening.reduce((sum, read) => sum + read.bytes, 0);
  const totalBindingBytes = allReads.reduce((sum, read) => sum + read.bytes, 0);
  t.diagnostic(JSON.stringify({peakDocumentBytes,totalBytes,peakRows,peakScreenBytes,screenBytes,totalBindingBytes}));
  assert.ok(peakDocumentBytes > 100000 && totalBytes > 1000000, 'large evidence pages were reached');
  assert.ok(peakDocumentBytes <= 160000, 'per-document byte bound');
  assert.ok(totalBytes <= 2000000, 'request byte bound');
  assert.ok(peakRows <= 501, 'per-document row bound');
  assert.ok(peakScreenBytes > 600000 && peakScreenBytes <= 1_000_000, 'transient screening window is bounded');
  assert.ok(screenBytes < 25_000_000, 'transient screening transfer fits the request ceiling plus row metadata');
  assert.ok(totalBindingBytes < 28_000_000, 'the full request stays within the binding transfer ceiling');
  assert.ok(screening.every(read => read.rows <= 500));
  assert.ok(body.citations.length >= 8);
  const partial = body.citations.filter(c => c.read_coverage?.expected_stored_chunks === 501 && c.read_coverage.stored_chunk_count_is_lower_bound);
  assert.ok(partial.length >= 4);
  for (const citation of partial) {
    assert.equal(citation.read_coverage.stored_text_complete, false);
    assert.ok(citation.read_coverage.omitted_stored_chunks > 0);
  }
  const notice = /Cited records? ([0-9, and]+) (?:was|were) only partly read\./.exec(body.answer);
  assert.ok(notice, 'the answer names partly read citations');
  assert.deepEqual(notice[1].match(/\d+/g).map(Number), partial.map(c => c.n),
    'the answer discloses every partially read citation');
  assert.ok(body.confidence.percent < 90);
  assert.equal(answerResponseContractDiagnostic(body), null);
});

function meterReads(env) {
  const reads = [];
  const {prepare, batch} = env.DB;
  const record = (sql, rows) => {
    const bytes = rows.map(row => Object.values(row).reduce((sum, value) =>
      sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0));
    const textBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text || ''), 0);
    reads.push({sql, rows:rows.length, peakRow:Math.max(0,...bytes), bytes:bytes.reduce((a,b) => a + b,0),textBytes});
  };
  const wrap = (statement, sql) => {
    const bind = statement.bind;
    statement.bind = (...args) => wrap(bind(...args), sql);
    for (const mode of ['all', 'first', 'run']) {
      const execute = statement[mode];
      statement[mode] = async (...args) => {
        const reply = await execute(...args);
        record(sql, mode === 'first' ? reply ? [reply] : [] : reply.results || []);
        return reply;
      };
    }
    return statement;
  };
  env.DB.prepare = sql => wrap(prepare(sql), sql);
  env.DB.batch = async statements => {
    const replies = await batch(statements);
    replies.forEach((reply,index) => record(statements[index].sql,reply.results || []));
    return replies;
  };
  return reads;
}

test('think bounds URI binding transfer and reports omitted evidence', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const uri = 'https://archive.invalid/';
  for (const oversized of [false,true]) {
    const docs = [{source_type:'records',source_id:'azalea',title:'Azalea record',
      content:'Azaleahall opens on Friday.',uri:uri + (oversized ? 'x'.repeat(300000) : 'exhibit'),
      text_source:'native',text_reliable:true}];
    assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
    const reads = meterReads(f.env);
    const response = await f.post('/api/rag/think',{q:'When does azaleahall open?',limit:8},headers);
    assert.equal(response.status,200);
    const body = await response.json();
    const keyword = reads.filter(read => read.sql.includes('chunks_fts MATCH') && read.rows > 0);
    assert.ok(keyword.length, 'a matching keyword projection was returned');
    t.diagnostic(JSON.stringify({oversized,peakRow:Math.max(...keyword.map(read => read.peakRow)),
      requestBytes:reads.reduce((sum,read) => sum + read.bytes,0)}));
    assert.ok(keyword.every(read => read.peakRow < 160000));
    assert.ok(reads.reduce((sum,read) => sum + read.bytes,0) < 200000);
    assert.equal(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'),oversized);
    assert.equal(body.results.length,oversized ? 0 : 1);
    if (!oversized) assert.match(body.answer,/Friday/);
  }
});

test('think bounds URI transfer in the unchunked tax inventory', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const docs = [{source_type:'records',source_id:'inventory',title:'Archive inventory',
    content:'Archive notes.',text_source:'native',text_reliable:true}];
  assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
  f.raw('DELETE FROM chunks WHERE doc_uid=?','records:inventory');
  const reads = meterReads(f.env);
  for (const oversized of [false,true]) {
    f.raw('UPDATE documents SET uri=? WHERE doc_uid=?',
      'https://archive.invalid/' + (oversized ? 'x'.repeat(300000) : 'inventory'),'records:inventory');
    reads.length = 0;
    const response = await f.post('/api/rag/think',{
      q:"What ordinary business income did Example Orchard LLC's 2023 Form 1065 report?",
      source:'records',limit:8,
    },headers);
    assert.equal(response.status,200);
    const body = await response.json();
    const inventory = reads.find(read => read.sql.includes('unchunked-tax-document-candidates') && read.rows > 0);
    assert.ok(inventory, 'the authorized unchunked record reached the tax inventory');
    assert.ok(inventory.peakRow < 1000);
    assert.equal(body.gaps.some(gap => gap.type === 'tax_document_inventory_unverified'),oversized);
  }
});

test('think discovers a name before suppressing oversized metadata', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const docs = [{source_type:'records',source_id:'booth',title:'Booth record',
    content:'The booth is at the east entrance.',text_source:'native',text_reliable:true}];
  assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
  const reads = meterReads(f.env);
  let seed = 675341;
  const id = 'records:booth';
  const original = f.first('SELECT title,client,meta FROM documents WHERE doc_uid=?',id);
  for (const field of ['title','client','sender','from','attendees','participants','unverifiable']) {
    await t.test(field, async () => {
      seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
      for (const oversized of [false,true]) {
        const value = (field === 'unverifiable' && oversized ? 'Azalunely' : 'Azalune') +
          ' ' + 'z'.repeat(oversized ? 25000 + seed % 100 : 5);
        const meta = JSON.parse(original.meta);
        if (!['title','client'].includes(field)) {
          meta[field === 'unverifiable' ? 'sender' : field] =
            ['attendees','participants'].includes(field) ? [value] : value;
        }
        f.raw('UPDATE documents SET title=?,client=?,meta=? WHERE doc_uid=?',
          field === 'title' ? value : original.title,
          field === 'client' ? value : original.client,
          JSON.stringify(meta),id);
        reads.length = 0;
        const response = await f.post('/api/rag/think',{q:'Where is Azalune?',limit:8,source:'records'},headers);
        assert.equal(response.status,200);
        const body = await response.json();
        const discovery = reads.find(read => read.sql.includes('name-variant-metadata') && read.rows > 0);
        assert.ok(discovery, 'the authorized metadata page reached discovery');
        assert.ok(discovery.peakRow < 24000);
        assert.equal(reads.some(read => read.sql.includes('name-variant-hydration') && read.rows > 0),
          field !== 'unverifiable' || !oversized, 'hydration requires an exact token match');
        assert.equal(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'),oversized);
        assert.equal(body.results.length,oversized ? 0 : 1);
        if (!oversized) assert.match(body.answer,/east entrance/);
        else assert.ok(!body.gaps.some(gap => gap.type === 'no_results'));
      }
    });
  }
  const outside = await f.post('/api/rag/think',{q:'Where is Azalune?',limit:8,source:'other'},headers);
  assert.equal(outside.status,200);
  assert.ok(!(await outside.json()).gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));

  await t.test('metadata changes before hydration', async () => {
    f.raw('UPDATE documents SET title=?,meta=? WHERE doc_uid=?',
      'Azalune ' + 'z'.repeat(25000),original.meta,id);
    const prepare = f.env.DB.prepare;
    let changed = false;
    f.env.DB.prepare = sql => {
      if (sql.includes('name-variant-hydration') && !changed) {
        changed = true;
        f.raw('UPDATE documents SET title=? WHERE doc_uid=?',original.title,id);
      }
      return prepare(sql);
    };
    try {
      reads.length = 0;
      const response = await f.post('/api/rag/think',{q:'Where is Azalune?',limit:8},headers);
      assert.equal(response.status,200);
      const body = await response.json();
      assert.ok(changed && reads.some(read => read.sql.includes('name-variant-hydration') && read.rows > 0));
      assert.equal(body.results.length,0);
      assert.equal(body.citations.length,0);
      assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
    } finally {
      f.env.DB.prepare = prepare;
    }
  });

  await t.test('a readable match keeps the incomplete search receipt', async () => {
    const matching = [{source_type:'records',source_id:'readable',title:'Readable booth',
      content:'The booth is by the south entrance.',text_source:'native',text_reliable:true}];
    assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs:matching},headers)).status,200);
    f.raw('DELETE FROM vector_outbox');
    f.raw("UPDATE install_state SET vector_projection_status='verified',vector_projection_bootstrap_base_count=2 WHERE id=1");
    f.env.VECTORIZE.describe = async () => ({vectorCount:2,processedUpToMutation:null});
    f.raw('UPDATE documents SET title=? WHERE doc_uid=?','Azalune','records:readable');
    f.raw('UPDATE documents SET meta=? WHERE doc_uid=?',
      JSON.stringify({...JSON.parse(original.meta),sender:'Azalunely ' + 'z'.repeat(25000)}),id);
    reads.length = 0;
    const response = await f.post('/api/rag/think',{q:'Where is Azalune?',limit:8},headers);
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.degraded,undefined);
    assert.ok(reads.some(read => read.sql.includes('name-variant-metadata') && read.rows === 2));
    assert.ok(reads.some(read => read.sql.includes('name-variant-hydration') && read.rows === 1));
    assert.equal(body.results.length,1);
    assert.match(body.answer,/south entrance/);
    assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
    assert.ok(body.confidence.basis.includes('The search did not complete.'));
  });
});

test('think screens the old admission window and bounds its count', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  let seed = 731189;
  for (const [index, marker] of ['Date of birth:', '\uff24\uff2f\uff22\uff1d', 'Date_of_birth:', 'Date of birth across chunks'].entries()) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const markerIndex = 310 + seed % 130;
    for (const sensitive of [true, false]) {
      const id = 'orchid-' + index + '-' + Number(sensitive);
      const label = 'orchidexhibit' + index + (sensitive ? 'negative' : 'control');
      const docs = [{source_type:'records' + index + Number(sensitive),source_id:id,title:label,
        content:label + ' opens on Wednesday.',text_source:'native',text_reliable:true}];
      assert.equal((await f.post('/api/admin/brain/ingest/batch', {docs}, headers)).status, 200);
      const template = f.first('SELECT * FROM chunks WHERE doc_uid=?', 'records' + index + Number(sensitive) + ':' + id);
      assert.ok(template, 'the searchable opening was stored');
      const columns = Object.keys(template).filter(key => key !== 'id');
      const insert = f.sqlite.prepare('INSERT INTO chunks (' + columns.join(',') +
        ') VALUES (' + columns.map(() => '?').join(',') + ')');
      for (let ix = 1; ix < 763; ix++) {
        const row = {...template,chunk_uid:id + '#' + ix,chunk_ix:ix,text:'\u00e9'.repeat(615),vector_id:null};
        if (ix === markerIndex) row.text = marker.endsWith('across chunks') ? 'Date of birth:' : marker + ' 1900-01-01';
        if (ix === markerIndex + 1 && marker.endsWith('across chunks')) row.text = '1900-01-01';
        if (!sensitive && (ix === markerIndex || ix === markerIndex + 1)) row.text = 'Ordinary exhibit notes.';
        insert.run(...columns.map(key => row[key]));
      }
    }
  }
  const reads = meterReads(f.env);
  for (const index of [0, 1, 2, 3]) {
    for (const sensitive of [false, true]) {
      reads.length = 0;
      const label = 'orchidexhibit' + index + (sensitive ? 'negative' : 'control');
      const response = await f.post('/api/rag/think', {q:'When does ' + label + ' open?',limit:8,source:'records' + index + Number(sensitive)}, headers);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(reads.some(read => read.sql.includes('AS total_chunks') && read.rows > 0), 'authorized evidence read reached');
      const screen = reads.find(read => read.sql.includes('sensitive-screen-window') && read.rows === 500);
      assert.ok(screen, 'the complete prior screening window was fetched');
      if (sensitive) {
        assert.equal(body.withheld_documents?.count, 1, 'the tail reached sensitive screening');
        assert.ok(!JSON.stringify(body.results).includes(label));
        assert.equal(body.citations.length,0);
        assert.doesNotMatch(body.answer,/Wednesday/);
      } else {
        assert.ok(body.citations.some(c => c.read_coverage?.expected_stored_chunks === 501 && c.read_coverage.stored_chunk_count_is_lower_bound === true));
        assert.match(body.answer, /Wednesday/);
      }
    }
  }
  const controlUid = 'records00:orchid-0-0';
  f.raw('UPDATE chunks SET text=? WHERE doc_uid=? AND chunk_ix=350',
    'At trailmarker the guide says bring your passport for identification.',controlUid);
  reads.length = 0;
  const mention = await f.post('/api/rag/think', {q:'What does trailmarker recommend?',source:'records00',limit:8}, headers);
  assert.equal(mention.status,200);
  const mentionBody = await mention.json();
  assert.ok(reads.some(read => read.sql.includes('sensitive-screen-window') && read.rows === 500));
  assert.equal(mentionBody.withheld_documents,undefined,'a passing mention in body prose remains permitted');
  assert.ok(mentionBody.citations.some(citation => citation.read_coverage?.document_id === controlUid));
  assert.match(mentionBody.answer,/bring your passport/);

  f.control.failOn = /sensitive-screen-window/;
  f.seen.sql.length = 0;
  const response = await f.post('/api/rag/think', {q:'When does orchidexhibit0control open?',source:'records00',limit:8}, headers);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(f.seen.sql.some(sql => sql.includes('sensitive-screen-window')), 'the failed screen was attempted');
  assert.equal(body.citations.length, 0);
  assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
  assert.ok(!body.gaps.some(gap => gap.type === 'no_results'));

  f.control.failOn = null;
  const prepare = f.env.DB.prepare;
  let changedRevision = false;
  f.env.DB.prepare = sql => {
    if (sql.includes('sensitive-screen-window') && !changedRevision) {
      changedRevision = true;
      f.raw('UPDATE documents SET content_hash=? WHERE doc_uid=?','b'.repeat(64),'records00:orchid-0-0');
    }
    return prepare(sql);
  };
  const drift = await f.post('/api/rag/think', {q:'When does orchidexhibit0control open?',source:'records00',limit:8}, headers);
  assert.equal(drift.status, 200);
  const driftBody = await drift.json();
  assert.ok(changedRevision, 'the revision changed between evidence and screening reads');
  assert.equal(driftBody.results.length,0);
  assert.ok(driftBody.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));

  f.raw('UPDATE documents SET content_hash=? WHERE doc_uid=?','legacy','records00:orchid-0-0');
  f.control.failOn = /AS total_chunks/;
  f.seen.sql.length = 0;
  const unavailable = await f.post('/api/rag/think', {q:'When does orchidexhibit0control open?',source:'records00',limit:8}, headers);
  assert.equal(unavailable.status,200);
  const unavailableBody = await unavailable.json();
  assert.ok(f.seen.sql.some(sql => sql.includes('AS total_chunks')), 'the initial read failed for the legacy hash');
  assert.equal(unavailableBody.results.length,0);
  assert.ok(unavailableBody.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
});

test('think limits oversized keyword text and authority projections before the binding', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const docs = [
    {source_type:'records',source_id:'oversized',title:'azaleaexhibit ' + '\u754c\u754c '.repeat(40000),
      content:'Azaleaexhibit opens on Wednesday.',text_source:'native',text_reliable:true},
    {source_type:'records',source_id:'control',title:'Azalea control',
      content:'Azaleaexhibit opens on Thursday.',text_source:'native',text_reliable:true},
  ];
  assert.equal((await f.post('/api/admin/brain/ingest/batch', {docs}, headers)).status, 200);
  const stored = f.first('SELECT length(CAST(text AS BLOB)) AS bytes FROM chunks WHERE doc_uid=?', 'records:oversized');
  assert.ok(stored.bytes > 240000, 'stored oversized bytes: ' + stored.bytes);
  const reads = meterReads(f.env);
  const response = await f.post('/api/rag/think', {q:'When does azaleaexhibit open?',limit:8}, headers);
  assert.equal(response.status, 200);
  const body = await response.json();
  const retrieval = reads.filter(read => read.sql.includes('AS authority_document_head') && read.rows > 0);
  assert.ok(retrieval.length > 0, 'retrieval projection ran');
  const peak = Math.max(...retrieval.map(read => read.peakRow));
  t.diagnostic(JSON.stringify({peakRetrievalRow:peak,totalBindingBytes:reads.reduce((n, read) => n + read.bytes, 0)}));
  assert.ok(peak <= 100000, 'bounded retrieval row before JS');
  assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
  assert.ok(body.results.every(row => row.doc_uid !== 'records:oversized'));
  assert.match(body.answer, /Thursday/);
});

test('bounded text projection covers retrieval siblings without changing the normal row', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const text = 'azaleascope opens on Thursday.';
  const docs = [
    {source_id:'seed',title:'Seed record',content:'historicalscope began in spring.',occurred_at:'2025-01-01'},
    {source_id:'target',title:'Azalea record',content:text,occurred_at:'2025-02-01'},
  ].map(row => ({...row,source_type:'records',text_source:'native',text_reliable:true,metadata:{thread_id:'exhibits'}}));
  assert.equal((await f.post('/api/admin/brain/ingest/batch', {docs}, headers)).status, 200);
  const ids = ['records:seed','records:target'];
  f.raw("UPDATE documents SET date_reliable=1,meta=json_set(meta,'$.thread_id','exhibits') WHERE doc_uid IN (?,?)",...ids);
  f.raw('UPDATE documents SET document_date=? WHERE doc_uid=?',Date.UTC(2025,1,1),ids[1]);
  f.raw('UPDATE documents SET document_date=? WHERE doc_uid=?',Date.UTC(2025,0,1),ids[0]);
  const hashes = ids.map(id => f.first('SELECT content_hash FROM documents WHERE doc_uid=?',id).content_hash);
  const target = f.first('SELECT chunk_uid FROM chunks WHERE doc_uid=?',ids[1]);
  f.env.VECTORIZE.query = async () => ({matches:[{id:target.chunk_uid,score:1}]});
  const reads = meterReads(f.env);
  const bounded = {boundThinkText:true,limit:8};
  const arms = [
    ['keyword', /chunks_fts MATCH/, () => searchKeyword(f.env,'azaleascope',bounded)],
    ['bounded keyword', /keyword_recovery_candidates/, () => searchKeyword(f.env,'azaleascope',{...bounded,readPlan:'bounded_keyword'})],
    ['vector', /c\.chunk_uid IN/, () => searchVector(f.env,[0.1,0.2,0.3],bounded)],
    ['successor', /successor-discovery/, () => discoverDocumentSuccessors(f.env,[{doc_uid:ids[0]}],bounded)],
    ['verified correction', /verified-correction-search/, () => discoverCorrectionSearchSeeds(f.env,'historicalscope',bounded)],
  ];
  let seed = 124529;
  for (const [name, sql, retrieve] of arms) {
    await t.test(name, async () => {
      if (name === 'verified correction') {
        f.raw("INSERT INTO memory_supersessions VALUES (?,?,?,?,'local_mcp',0)",...ids,...hashes);
      }
      seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
      const ordinary = f.first('SELECT text FROM chunks WHERE chunk_uid=?',target.chunk_uid).text;
      const uri = 'https://archive.invalid/exhibit';
      for (const oversized of [false,true]) {
        const candidate = oversized ? ordinary + ' \u754c'.repeat(6500 + seed % 300) : ordinary;
        f.raw('UPDATE chunks SET text=? WHERE chunk_uid=?',candidate,target.chunk_uid);
        f.raw('UPDATE documents SET uri=? WHERE doc_uid=?',oversized ? uri + '\u754c'.repeat(7000 + seed % 300) : uri,ids[1]);
        reads.length = 0;
        const rows = await retrieve();
        const read = reads.find(read => sql.test(read.sql) && read.rows > 0);
        assert.ok(read, 'nonempty projection reached');
        assert.ok(read.peakRow < 1000);
        const row = rows.find(item => item.doc_uid === ids[1]);
        assert.ok(row, 'the exact target was projected');
        assert.equal(Boolean(row.retrieval_projection_incomplete),oversized);
        assert.equal(row.text,oversized ? null : ordinary);
        assert.equal(row.authority_document_head,oversized ? null : ordinary);
        assert.equal(row.uri,oversized ? null : uri);
        assert.equal(row.content_hash,hashes[1], 'revision authority is preserved');
      }
      f.raw('UPDATE chunks SET text=? WHERE chunk_uid=?',ordinary,target.chunk_uid);
      f.raw('UPDATE documents SET uri=? WHERE doc_uid=?',uri,ids[1]);
    });
  }
  let projectionSeed = 829047;
  const variableFields = [
    ['uri','documents','uri'], ['source_id','documents','source_id'],
    ['entity_slug','documents','entity_slug'], ['date_source','documents','date_source'],
    ['text_source','documents','text_source'], ['client','chunks','client'],
    ['category','chunks','category'], ['top_folder','chunks','top_folder'], ['platform','chunks','platform'],
    ['chunk_uid','chunks','chunk_uid'],
  ];
  for (const [field, table, column] of variableFields) {
    await t.test('keyword bounds ' + field, async () => {
      projectionSeed = (Math.imul(projectionSeed,1664525) + 1013904223) >>> 0;
      const original = f.first(`SELECT ${column} FROM ${table} WHERE doc_uid=?`, ids[1])[column];
      const update = `UPDATE ${table} SET ${column}=? WHERE doc_uid=?`;
      try {
        for (const oversized of [false,true]) {
          const value = 'https://archive.invalid/' + (oversized ? '\u754c'.repeat(24000 + projectionSeed % 100) : 'exhibit');
          f.raw(update,value,ids[1]);
          reads.length = 0;
          const rows = await searchKeyword(f.env,'azaleascope',bounded);
          const read = reads.find(item => item.sql.includes('chunks_fts MATCH') && item.rows > 0);
          assert.ok(read, 'the authorized keyword row reached the binding');
          assert.ok(read.peakRow < 160000 && read.bytes < 200000);
          const row = rows.find(item => item.doc_uid === ids[1]);
          assert.ok(row, 'the target reached the projection decision');
          assert.equal(row[field],oversized ? null : value);
          assert.equal(Boolean(row.retrieval_projection_incomplete),oversized);
        }
      } finally {
        f.raw(update,original,ids[1]);
      }
    });
  }
  await t.test('hashed vector identity stays inside D1', async () => {
    const vectorId = 'h:' + 'a'.repeat(60);
    const original = f.first('SELECT vector_id FROM chunks WHERE doc_uid=?',ids[1]).vector_id;
    f.env.VECTORIZE.query = async () => ({matches:[{id:vectorId,score:1}]});
    try {
      for (const oversized of [false,true]) {
        const uid = oversized ? target.chunk_uid + '\u754c'.repeat(25000) : target.chunk_uid;
        f.raw('UPDATE chunks SET vector_id=?,chunk_uid=? WHERE doc_uid=?',vectorId,uid,ids[1]);
        reads.length = 0;
        let incomplete = false;
        const rows = await searchVector(f.env,[0.1,0.2,0.3],{...bounded,
          onIncompleteProjection: () => { incomplete = true; }});
        const decisions = reads.filter(read => read.sql.includes('vector_id IN') && read.rows > 0);
        assert.ok(decisions.length, 'the hashed vector reference resolved to an authorized row');
        assert.ok(decisions.every(read => read.peakRow < 1000), 'the raw chunk key stays inside SQLite');
        assert.equal(incomplete,oversized);
        assert.equal(rows[0]?.doc_uid,ids[1]);
        assert.equal(rows[0]?.chunk_uid,oversized ? null : uid);
      }
    } finally {
      f.raw('UPDATE chunks SET vector_id=?,chunk_uid=? WHERE doc_uid=?',original,target.chunk_uid,ids[1]);
    }
  });
  await t.test('name metadata hydration', async () => {
    f.raw('UPDATE documents SET title=? WHERE doc_uid=?','Azalune',ids[1]);
    for (const oversized of [false,true]) {
      const candidate = oversized ? text + ' \u754c'.repeat(9000) : text;
      f.raw('UPDATE chunks SET text=? WHERE chunk_uid=?',candidate,target.chunk_uid);
      reads.length = 0;
      const result = await search(f.env,{...bounded,query:'Where is Azalune?',embedding:null});
      const hydrated = reads.find(read => read.sql.includes('name-variant-hydration') && read.rows > 0);
      assert.ok(hydrated, 'a metadata match reached hydration');
      assert.ok(hydrated.peakRow < 1000, 'oversized text stays inside D1');
      const row = result.results.find(row => row.doc_uid === ids[1]);
      assert.ok(row?.evidence_revision);
      assert.equal(Boolean(row.retrieval_projection_incomplete),oversized);
      assert.equal(row.text,oversized ? null : text);
    }
  });
});

test('think reports exhausted screening budgets and answers from records that passed', async t => {
  const f = await createProductFixture();
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const docs = Array.from({length:29}, (_, index) => ({
    source_type:'records',source_id:String(index),title:'Gallery record ' + index,
    content:'The violetgallery opens on Thursday. Entry ' + index + '.',
    text_source:'native',text_reliable:true,
  }));
  assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
  const template = f.first('SELECT * FROM chunks WHERE doc_uid=?','records:1');
  const columns = Object.keys(template).filter(key => key !== 'id');
  const insert = f.sqlite.prepare('INSERT INTO chunks (' + columns.join(',') +
    ') VALUES (' + columns.map(() => '?').join(',') + ')');
  f.raw('BEGIN');
  for (let index = 1; index < docs.length; index++) {
    for (let ix = 1; ix < 500; ix++) {
      const row = {...template,doc_uid:'records:' + index,chunk_uid:'records:' + index + '#' + ix,
        chunk_ix:ix,text:'\u00e9'.repeat(index === 1 ? 1250 : 980),vector_id:null};
      insert.run(...columns.map(key => row[key]));
    }
  }
  f.raw('COMMIT');
  const reads = meterReads(f.env);
  const response = await f.post('/api/rag/think',{q:'When does the violetgallery open?',limit:8},headers);
  assert.equal(response.status,200);
  const body = await response.json();
  const screens = reads.filter(read => read.sql.includes('sensitive-screen-window'));
  assert.ok(screens.some(read => read.rows > 0 && read.rows < 500),'an incomplete screen was reached');
  assert.ok(screens.some(read => read.rows === 500),'a full screening control was reached');
  assert.ok(screens.every(read => read.textBytes <= 1_000_000),'per-document screening byte bound');
  const bytes = screens.reduce((sum, read) => sum + read.textBytes,0);
  assert.ok(bytes > 23_000_000 && bytes <= 24_000_000,'request screening byte bound');
  assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
  assert.ok(!body.results.some(row => row.doc_uid === 'records:1'),'an over-budget document cannot reach result export');
  assert.match(body.answer,/Thursday/);
  assert.equal(answerResponseContractDiagnostic(body),null);
});

// A Google or Outlook calendar meeting keeps every invitee's address in its
// stored metadata. Six hundred invitees put that metadata over the 24 KB
// projection bound, and the lane then dropped the meeting from think.
async function largeMeetingFixture(t, { invitees = 600, declined = 0, label = index => 'Person Number ' + index } = {}) {
  t.mock.method(Date, 'now', () => Date.parse('2031-04-07T12:00:00Z'));
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: 'UTC', INGEST_VERSION: { id: 'fixture-runtime' } } });
  t.after(() => f.close());
  const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
  const attendees = Array.from({ length: invitees }, (_, index) => ({ email: 'person.number' + index + '@example-company.test',
    displayName: label(index), responseStatus: index < declined ? 'declined' : 'accepted' }));
  const event = { id: 'allhands', status: 'confirmed', summary: 'Company all-hands planning session',
    start: { dateTime: '2031-04-08T15:00:00Z' }, end: { dateTime: '2031-04-08T16:00:00Z' },
    updated: '2031-04-01T12:00:00Z', description: 'Quarterly all-hands planning session for the whole company.', attendees };
  const envelope = restampFirstPartySourceProvenance(buildEnvelope(event).envelope,
    { sourceType: 'calendar', textSource: 'native', textReliable: true });
  assert.equal((await f.post('/api/admin/brain/ingest', envelope, headers)).status, 200);
  const docs = [{source_type:'records',source_id:'lease',title:'Office lease',
    content:'The office lease renews on May 1, 2031 for Acme Holdings.',text_source:'native',text_reliable:true}];
  assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
  const meeting = f.first("SELECT doc_uid, length(CAST(meta AS BLOB)) AS bytes FROM documents WHERE source='calendar'");
  return { f, headers, meeting };
}

// Record every metadata value that crosses the binding, in any projection.
function meterMetadata(env) {
  const values = [];
  const {prepare} = env.DB;
  const wrap = statement => {
    const bind = statement.bind;
    statement.bind = (...args) => wrap(bind(...args));
    const all = statement.all;
    statement.all = async (...args) => {
      const reply = await all(...args);
      for (const row of reply.results || []) if (typeof row.authority_meta === 'string') values.push(row.authority_meta);
      return reply;
    };
    return statement;
  };
  env.DB.prepare = sql => wrap(prepare(sql));
  return { values, restore: () => { env.DB.prepare = prepare; } };
}

test('think answers a meeting with hundreds of invitees without giving back the metadata bound', async t => {
  const { f, headers, meeting } = await largeMeetingFixture(t);
  assert.ok(meeting.bytes > 24000, 'the stored metadata is over the projection bound: ' + meeting.bytes);
  for (const vector of [false, true]) {
    await t.test(vector ? 'vector and keyword search' : 'keyword-only search', async () => {
      let vectorQueries = 0;
      if (vector) f.env.VECTORIZE.query = async () => {
        vectorQueries++;
        return { matches: f.rows('SELECT chunk_uid AS id FROM chunks').map(row => ({...row, score:1})) };
      };
      const metered = meterMetadata(f.env);
      try {
        const response = await f.post('/api/rag/think', {q:'When is the company all-hands planning session?',limit:8}, headers);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.ok(!body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'), JSON.stringify(body.gaps));
        assert.equal(body.results[0]?.doc_uid, meeting.doc_uid, 'the meeting is the first answer record');
        assert.ok(body.citations.some(citation => /all-hands planning session/.test(citation.title)));
        assert.match(body.answer, /all-hands planning session/);
        assert.equal(answerResponseContractDiagnostic(body), null);
        if (vector) assert.ok(vectorQueries > 0, 'the vector modality was queried');
        assert.ok(metered.values.length > 0, 'metadata projections were metered');
        assert.ok(metered.values.every(value => Buffer.byteLength(value) <= 24000), 'no projected metadata exceeds the bound');
        assert.ok(metered.values.some(value => value.includes('"attendees"') && !value.includes('attendee_emails')),
          'the meeting crossed without its unread address lists');
      } finally {
        metered.restore();
      }
    });
  }
  await t.test('a cancelled meeting keeps its cancellation label', async () => {
    const marked = await f.post('/api/admin/brain/calendar-cancellation',
      {source:'calendar',source_id:'gcal:primary:allhands'}, headers);
    assert.equal(marked.status, 200);
    const response = await f.post('/api/rag/think', {q:'When is the company all-hands planning session?',limit:8}, headers);
    const body = await response.json();
    const row = body.results.find(result => result.doc_uid === meeting.doc_uid);
    assert.equal(row?.calendar_status, 'cancelled');
    assert.match(row.title, /^\[Cancelled\] /);
  });
});

test('think still leaves out a meeting whose remaining metadata exceeds the bound', async t => {
  // Declined invitees are named in the attendee list itself, which name
  // matching reads, so that list is never dropped from the projection.
  const { f, headers, meeting } = await largeMeetingFixture(t, { invitees: 700, declined: 700 });
  assert.ok(meeting.bytes > 48000, 'stored metadata bytes: ' + meeting.bytes);
  const metered = meterMetadata(f.env);
  try {
    const response = await f.post('/api/rag/think', {q:'When is the company all-hands planning session?',limit:8}, headers);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(metered.values.every(value => Buffer.byteLength(value) <= 24000));
    assert.ok(body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'));
    assert.ok(!body.results.some(row => row.doc_uid === meeting.doc_uid));
    assert.ok(!body.citations.some(citation => /all-hands/.test(citation.title)));
  } finally {
    metered.restore();
  }
});

test('think still screens an oversized-metadata meeting with a sensitive marker in an attendee name', async t => {
  const marker = 'SSN 123-45-6789';
  const { f, headers, meeting } = await largeMeetingFixture(t, { label: index => index === 3 ? marker : 'Person Number ' + index });
  assert.ok(meeting.bytes > 24000);
  const stored = f.first('SELECT meta FROM documents WHERE doc_uid=?', meeting.doc_uid).meta;
  assert.ok(JSON.parse(stored).attendees.includes(marker), 'the marker is in the stored attendee list');
  const response = await f.post('/api/rag/think', {q:'When is the company all-hands planning session?',limit:8}, headers);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.withheld_documents?.count, 1, 'the sensitive-record screen read the meeting and withheld it');
  assert.ok(body.gaps.some(gap => gap.type === 'sensitive_documents_withheld'));
  assert.ok(!body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'), 'the screen finished');
  assert.ok(!body.results.some(row => row.doc_uid === meeting.doc_uid));
  assert.ok(!JSON.stringify(body).includes('123-45-6789'), 'the marker is never shown');
});

// A Granola export keeps one speaker/source/start entry per transcript segment
// in its stored metadata, beside a copy of the attendee list
// (connectors/granola-records.mjs). A meeting of about half an hour (some 400
// segments) puts that metadata over the 24 KB projection bound, and think then
// left the meeting out.
test('think answers a long Granola transcript without giving back the metadata bound', async t => {
  for (const segments of [450, 2000]) {
    await t.test(segments + ' transcript segments', async st => {
      st.mock.method(Date, 'now', () => Date.parse('2031-04-07T12:00:00Z'));
      const f = await createProductFixture({ env: { BRAIN_TIMEZONE: 'UTC', INGEST_VERSION: { id: 'fixture-runtime' } } });
      st.after(() => f.close());
      const headers = {'X-Admin-Key': f.env.ADMIN_KEY};
      const record = {
        id: 'meeting-roadmap', title: 'Quarterly roadmap review', meeting_at: '2031-04-02T15:00:00Z',
        owner_email: 'owner@example.invalid', attendees: ['Person One', 'Person Two'],
        transcript: Array.from({ length: segments }, (_, index) => ({ speaker: index % 2 ? 'Person Two' : 'Person One',
          source: index % 2 ? 'system' : 'microphone', start: index * 4, text: 'Roadmap item ' + index + ' stays on schedule.' })),
        exported_at: '2031-04-03T12:00:00Z',
      };
      const envelope = normalizeGranolaRecord(record, { source: 'granola', ownerEmail: record.owner_email });
      assert.equal((await f.post('/api/admin/brain/ingest', envelope, headers)).status, 200);
      const docs = [{source_type:'records',source_id:'lease',title:'Office lease',
        content:'The office lease renews on May 1, 2031 for Acme Holdings.',text_source:'native',text_reliable:true}];
      assert.equal((await f.post('/api/admin/brain/ingest/batch',{docs},headers)).status,200);
      const meeting = f.first("SELECT doc_uid, meta, length(CAST(meta AS BLOB)) AS bytes FROM documents WHERE source='granola'");
      assert.ok(meeting.bytes > 24000, 'the stored metadata is over the projection bound: ' + meeting.bytes);
      assert.equal(JSON.parse(meeting.meta).granola.segments.length, segments, 'every segment is stored');
      const metered = meterMetadata(f.env);
      try {
        const response = await f.post('/api/rag/think', {q:'What did the quarterly roadmap review decide?',limit:8}, headers);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.ok(!body.gaps.some(gap => gap.type === 'sensitive_screening_incomplete'), JSON.stringify(body.gaps));
        assert.equal(body.results[0]?.doc_uid, meeting.doc_uid, 'the meeting is the first answer record');
        assert.ok(body.citations.some(citation => /Quarterly roadmap review/.test(citation.title)));
        assert.equal(answerResponseContractDiagnostic(body), null);
        assert.ok(metered.values.length > 0, 'metadata projections were metered');
        assert.ok(metered.values.every(value => Buffer.byteLength(value) <= 24000), 'no projected metadata exceeds the bound');
        assert.ok(metered.values.some(value => value.includes('"granola"') && value.includes('"attendees"') &&
          !value.includes('"segments"')), 'the meeting crossed with its attendee names and without its unread segment list');
      } finally {
        metered.restore();
      }
    });
  }
});

test('think carries the calendar status across the binding only as a closed value', async t => {
  const { f, headers, meeting } = await largeMeetingFixture(t, { invitees: 3 });
  for (const [status, expected] of [['x'.repeat(20000), null], ['needsReview', null], ['cancelled', 'cancelled']]) {
    f.raw("UPDATE documents SET meta=json_set(meta,'$.status',?) WHERE doc_uid=?", status, meeting.doc_uid);
    const reads = [];
    const {prepare} = f.env.DB;
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('AS total_chunks')) return statement;
      const bind = statement.bind;
      statement.bind = (...args) => {
        const bound = bind(...args);
        const all = bound.all;
        bound.all = async (...rest) => { const reply = await all(...rest); reads.push(...(reply.results || [])); return reply; };
        return bound;
      };
      return statement;
    };
    try {
      const response = await f.post('/api/rag/think', {q:'When is the company all-hands planning session?',limit:8}, headers);
      assert.equal(response.status, 200);
      const body = await response.json();
      const rows = reads.filter(row => row.doc_uid === meeting.doc_uid);
      assert.ok(rows.length > 0, 'the meeting reached the evidence reader');
      assert.ok(rows[0].calendar_status === expected,
        'only a closed status value crosses the binding; got ' + String(rows[0].calendar_status).length + ' characters');
      assert.ok(rows.slice(1).every(row => row.calendar_status === null), 'later rows carry no status');
      assert.equal(body.results[0]?.doc_uid, meeting.doc_uid);
      assert.equal(body.results[0].calendar_status, expected ?? undefined);
    } finally {
      f.env.DB.prepare = prepare;
    }
  }
});

test('the 0.4.31 owner notes describe partly read records and an unfinished sensitive-record check', () => {
  // brain whatsnew prints this section to the owner.
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const section = changelog.split(/^## 0\.4\.31\b.*$/m)[1]?.split(/^## /m)[0] ?? '';
  assert.ok(section.trim(), 'the 0.4.31 section exists');
  const bullet = section.split(/\n(?=- )/).map(item => item.replace(/\s+/g, ' '))
    .find(item => /only partly read/.test(item));
  assert.ok(bullet, 'an owner bullet names the partly read notice');
  assert.match(bullet, /sensitive-record check could not finish/);
});
