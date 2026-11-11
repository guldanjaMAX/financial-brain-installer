import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { replay, sha, ROOT, waitForQuiet } from '../eval/fast-loop/money-replay.mjs';
import { replayRoute, loadRouteTapes } from '../eval/fast-loop/route-replay.mjs';
import { CONTROLS, evidence } from './fixtures/fastloop-money/input.mjs';
import { buildRouterTapes, tapeChanges } from '../eval/fast-loop/build-router-tapes.mjs';
import { CASES, loadTapes } from '../eval/fast-loop/day3-bench.mjs';
import { POST_LAUNCHER_TEST_COMMANDS, TEST_COMMANDS } from '../scripts/run-test-chain.mjs';

const reader = readFileSync(new URL('../worker/src/lib/ledger-reader.js', import.meta.url), 'utf8');
const field = 'e.display_label AS entity_label,';
assert.equal(reader.split(field).length - 1, 1, 'one reviewed inventory projection');
const priorReader = reader.replace(field, '');
// Restore the ownership projection after selecting the reviewed query version,
// so its negative control changes only that field and keeps disclosure intact.
const fixtures = loadRouteTapes();
// A restoring mutant for the entire inventory field, in standalone and batch
// requests and replies. Historical records stay frozen outside this copy.
function priorProjection(value) {
  if (typeof value === 'string') return value.replace(field, '');
  if (Array.isArray(value)) return value.map(priorProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'entity_label')
    .map(([key, child]) => [key, priorProjection(child)]));
}
const priorFixtures = priorProjection(fixtures);
const rows = ['M01/supported', 'M04/single', 'M06/typed', 'M09/posted', 'M10/on'];
const decision = (run, id) => {
  const o = run.observations[0];
  assert.equal(o.id, id);
  assert.ok(run.source_files['worker/src/lib/ledger-intent-scope.js'], 'the new module actually loads');
  assert.ok(o.trace.parsed_intents.length > 0, 'the real classifier reaches its decision');
  assert.ok(o.trace.sql.length > 0, 'the inventory adapter is reached');
  return o;
};
const complete = o => {
  assert.equal(o.execution_status, 'complete');
  assert.deepEqual(o.fatal, []);
  assert.ok(o.trace.dependencies.includes('inventory'), 'reviewed inventory was read');
  assert.ok(o.body.ledger, 'a real ledger answer was produced');
};
for (const [surface, execute] of [['direct', replay], ['http', replayRoute]]) {
  for (const id of rows) {
    const cases = [CONTROLS.find(c => c.id === id)];
    test(`C3 ${surface} ${id}: current projection preserves the nonempty historical control`, () => {
      const control = decision(execute({ cases, fixtures: priorFixtures,
        sourceOverrides: { 'ledger-reader.js': priorReader } }), id);
      complete(control);
      const run = execute({ cases, fixtures });
      const current = decision(run, id);
      complete(current);
      assert.equal(run.source_files['worker/src/lib/ledger-reader.js'], sha(reader), 'executed reader bytes are bound');
      assert.deepEqual(current.body.ledger, control.body.ledger, 'projection metadata cannot change figures');
      assert.deepEqual(current.body.citations, control.body.citations);
      assert.equal(run.provider_calls, 0);
      assert.equal(run.production_writes, 0);
    });
    test(`C3 ${surface} ${id}: unrelated SQL drift still fails closed`, () => {
      const control = decision(execute({ cases, fixtures: priorFixtures,
        sourceOverrides: { 'ledger-reader.js': priorReader } }), id);
      complete(control);
      // Differ only in the refused tenant predicate, preserving the question,
      // snapshot, binds, projection, principal and clock of the green control.
      const drift = priorReader.replace('WHERE a.tenant_id=? AND', 'WHERE a.tenant_id<>? AND');
      assert.notEqual(drift, priorReader);
      const bad = decision(execute({ cases, fixtures: priorFixtures,
        sourceOverrides: { 'ledger-reader.js': drift } }), id);
      assert.notEqual(bad.execution_status, 'complete');
      assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
      assert.equal(bad.body.ledger, undefined);
    });
  }
}
test('C3 restoring old HTTP inventory tapes fails at the reached exact decision', () => {
  const cases = [CONTROLS.find(c => c.id === 'M06/typed')];
  const control = decision(replayRoute({ cases, fixtures }), cases[0].id);
  complete(control);
  const bad = decision(replayRoute({ cases, fixtures: priorFixtures }), cases[0].id);
  assert.equal(bad.execution_status, 'snapshot_miss');
  assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
});
test('C3 scope module is included in the exact reviewed package inventory', () => {
  const path = 'worker/src/lib/ledger-intent-scope.js';
  assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').length > 0);
  const privacy = readFileSync(new URL('./package-privacy.test.mjs', import.meta.url), 'utf8');
  assert.equal(privacy.split(JSON.stringify(path)).length - 1, 1);
});
test('C3 authored router patch round-trips through the same ordered fixture pipeline', () => {
  const patch = buildRouterTapes();
  const stored = JSON.parse(readFileSync(new URL('./fixtures/fastloop-day3/candidate-router-v1.json', import.meta.url), 'utf8'));
  const fixtures = loadTapes().candidate;
  // The frozen C3 projection predates the loan reader's pending disclosure.
  // Require every historical edit exactly, then prove each additive read
  // against the separately authored disclosure overlay used by real replay.
  const projected = structuredClone(patch);
  let added = 0;
  for (const change of projected.changes) {
    const prior = stored.changes.find(row => row.id === change.id);
    assert.ok(prior, 'no unreviewed case enters the C3 projection');
    const extra = change.edits.splice(prior.edits.length);
    for (const edit of extra) {
      assert.equal(edit.missing, true);
      assert.deepEqual(edit.path, ['d1', fixtures[change.id].d1.length - 1]);
      assert.deepEqual(edit.value, fixtures[change.id].d1.at(-1), 'added read equals the reviewed pending overlay');
      added++;
    }
  }
  assert.equal(added, 3);
  for (const [name, digest] of Object.entries(patch.source_sha256))
    assert.equal(digest, sha(readFileSync(new URL(`../worker/src/lib/${name}`, import.meta.url), 'utf8')),
      'current authoring is bound to the executed source');
  projected.source_sha256 = stored.source_sha256;
  let linkedTemplates = 0;
  const historicalProjection = (current, prior) => {
    if (typeof current === 'string' && sha(current) === 'c27e481664b7f00c82d93f2ad6ebb1dee85da861fc18beef01845dba793cdad1') {
      assert.equal(typeof prior, 'string');
      assert.equal(sha(prior), '3db04990951913cfcc75273fa1c136f3dcf822a73300d448561bcd68667af97e');
      linkedTemplates++; return prior;
    }
    if (Array.isArray(current)) return current.map((value, index) => historicalProjection(value, prior?.[index]));
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, historicalProjection(value, prior?.[key])]));
    return current;
  };
  // The owning disclosure generator separately proves the three exact pending
  // replacements. C3 still compares every other historical byte unchanged.
  const historical = historicalProjection(projected, stored);
  assert.equal(linkedTemplates, 3);
  assert.deepEqual(historical, stored, 'the owning generator reproduces every historical C3 edit');
  const run = replayRoute({ cases: CASES, fixtures });
  assert.equal(run.observations.length, 49);
  for (const o of run.observations) {
    assert.equal(o.execution_status, 'complete', o.id);
    assert.deepEqual(o.fatal, []);
  }
  assert.equal(run.provider_calls, 0);
  assert.equal(run.production_writes, 0);
});

test('C3 both chain lists directly register every new suite; omission mutants fail',()=>{
  const paths=['test/c3-fastloop-compat.test.mjs','worker/test/c3-calendar-scope.test.mjs','worker/test/c3-final-operands.test.mjs'];
  const check=commands=>{
    for(const path of paths) assert.equal(commands.filter(c=>c===`node --test ${path}`).length,1,path);
  };
  for(const commands of [POST_LAUNCHER_TEST_COMMANDS,TEST_COMMANDS]) {
    check(commands);
    for(const path of paths) {
      const bad=commands.filter(c=>c!==`node --test ${path}`);
      assert.equal(bad.length,commands.length-1,'mutation removes one registered command');
      assert.throws(()=>check(bad),/AssertionError/);
    }
  }
});

test('C3 authoring keeps frozen score bytes across one-bit SQLite rounding only',()=>{
  const path=['d1','2','output','results','1','score'];
  const before=-9.877551020408165e-7,after=-9.877551020408163e-7;
  assert.deepEqual(tapeChanges(before,after,path),[],'no score edit is authored');
  assert.throws(()=>tapeChanges(before,after*2,path),/unreviewed tape change/);
  assert.throws(()=>tapeChanges(before,after,[...path.slice(0,-1),'amount_minor']),/unreviewed tape change/);
  assert.throws(()=>tapeChanges(before,after,['model',...path.slice(1)]),/unreviewed tape change/);
});

test('C3 exact SQL admission rejects a reached permissive-matcher scratch mutant',t=>{
  const c=CONTROLS.find(c=>c.id==='M06/typed'),cases=[c];
  complete(decision(replay({cases}),c.id));
  const drift=reader.replace('WHERE a.tenant_id=? AND','WHERE a.tenant_id = ? AND');
  assert.notEqual(drift,reader);
  const fixed=decision(replay({cases,sourceOverrides:{'ledger-reader.js':drift}}),c.id);
  assert.notEqual(fixed.execution_status,'complete'); assert.ok(fixed.fatal.includes('SNAPSHOT_MISS'));
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'brain-c3-sql-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const original=new URL('../eval/fast-loop/money-worker.mjs',import.meta.url);
  let source=readFileSync(original,'utf8');
  const site='const kind = SQL_CONTRACTS.get(digest(sql));';
  assert.equal(source.split(site).length-1,1,'exact decision site exists');
  const permissive="const kind = SQL_CONTRACTS.get(digest(sql)) || (/FROM fin_accounts a/.test(sql) ? 'inventory' : null);";
  source=source.replace(site,permissive).replace(/from '([^']+)'/g,(_,path)=>`from '${path.startsWith('.')?new URL(path,original).href:path}'`);
  assert.ok(source.includes(permissive),'mutation bytes changed');
  const worker=join(dir,'money-worker.mjs');writeFileSync(worker,source);
  const env={PATH:process.env.PATH,HOME:join(ROOT,'lane-evidence/home-fastloop'),BRAIN_NO_WRANGLER_LOGIN:'1',TZ:'UTC'};
  for(const name of ['SystemRoot','WINDIR','ComSpec','PATHEXT']) if(process.env[name])env[name]=process.env[name];
  waitForQuiet(env);
  const child=spawnSync(process.execPath,['--experimental-vm-modules','--permission',`--allow-fs-read=${ROOT}`,`--allow-fs-read=${dir}`,
    '--import',new URL('./fixtures/cli-side-effect-tripwire.mjs',import.meta.url).href,worker],{
    cwd:ROOT,env,encoding:'utf8',timeout:60000,input:JSON.stringify({root:ROOT,inputs:[{...c,snapshot:evidence(c.profile)}],sourceOverrides:{'ledger-reader.js':drift}}),
  });
  assert.equal(child.status,0,child.stderr);
  const run=JSON.parse(child.stdout),bad=decision(run,c.id);complete(bad);
  assert.ok(bad.trace.sql.some(call=>call.sql.includes('WHERE a.tenant_id = ? AND')),'mutated admission executed the drifted nonempty inventory');
  assert.ok(bad.trace.rows_read.length>0,'real monetary decision reached');
  assert.throws(()=>assert.equal(bad.execution_status,'snapshot_miss'),'exact admission oracle kills permissive matcher');
});

for(const fault of ['bind','sql']) test(`C3 ${fault} identity guards retain nonempty control`,()=>{
  const cases=[CONTROLS.find(c=>c.id==='M01/supported')];
  complete(decision(replay({cases}),cases[0].id));
  const bad=decision(replay({cases,fault}),cases[0].id);
  assert.notEqual(bad.execution_status,'complete'); assert.ok(bad.fatal.includes('SNAPSHOT_MISS'));
});
