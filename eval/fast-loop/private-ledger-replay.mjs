import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, waitForQuiet } from './money-replay.mjs';
import { TABLES, sha256, fail, d1Rows, validateEnvelope, exportQueries } from './private-ledger-contract.mjs';
export { TABLES } from './private-ledger-contract.mjs';

const worker = fileURLToPath(new URL('./private-ledger-worker.mjs', import.meta.url));
const tripwire = fileURLToPath(new URL('../../test/fixtures/cli-side-effect-tripwire.mjs', import.meta.url));
const inside = (parent, path) => { const r = relative(parent, path); return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)); };
function canonicalFuture(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) fail('OUTPUT_INVALID');
  return resolve(canonicalFuture(parent), relative(parent, absolute));
}
export function checkOutput(path, roots) {
  const output = canonicalFuture(path);
  // Check both lexical and canonical paths. A symlink must not turn an
  // apparently private output directory into a committable directory.
  if (roots.some(root => inside(root, output) || inside(root, resolve(path)))) fail('OUTPUT_IN_WORKTREE');
  for (let dir = output; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) fail('OUTPUT_IN_WORKTREE');
    if (dirname(dir) === dir) break;
  }
  if (existsSync(resolve(path)) || (() => { try { lstatSync(resolve(path)); return true; } catch { return false; } })()) fail('OUTPUT_EXISTS');
  return output;
}
function readJson(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 64 * 1024 * 1024) fail('EXPORT_INVALID');
  const bytes = readFileSync(path);
  try { return { value: JSON.parse(bytes.toString('utf8')), digest: sha256(bytes) }; }
  catch { fail('EXPORT_INVALID'); }
}
export function readPrivateInputs(exportDir, questionsFile) {
  const files = {}, digests = {};
  for (const name of ['export', 'counts-before', 'counts-after', ...TABLES.map(t => t.name)]) {
    const data = readJson(resolve(exportDir, `${name}.json`));
    files[name] = data.value; digests[name] = data.digest;
  }
  const questions = readJson(resolve(questionsFile));
  const tables = Object.fromEntries(TABLES.map(t => [t.name, d1Rows(files[t.name])]));
  const meta = validateEnvelope(files.export, tables, d1Rows(files['counts-before']), d1Rows(files['counts-after']), questions.value);
  return { meta, tables, questions: questions.value, input_digest: sha256({ ...digests, questions: questions.digest }) };
}
function sourceRoot(path) {
  const root = realpathSync(resolve(path));
  for (const part of ['worker/src/lib/ledger-answer.js', 'migrations/d1']) if (!existsSync(resolve(root, part))) fail('SOURCE_INVALID');
  return root;
}
export function runPrivateArm(root, request) {
  // The launcher is trusted and gets no desktop environment or credentials.
  // The child has read permission only; VM imports are further restricted to
  // relative product modules. IPC is a private pipe separate from stdout.
  const env = { PATH: '/usr/bin:/bin', HOME: resolve(ROOT, 'lane-evidence/home-private-replay'), BRAIN_NO_WRANGLER_LOGIN: '1', TZ: 'UTC' };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.platform === 'win32' && process.env[key]) env[key] = process.env[key];
  waitForQuiet(env);
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', '--no-warnings',
    `--allow-fs-read=${ROOT}`, `--allow-fs-read=${root}`, '--import', tripwire, worker], {
    cwd: ROOT, env, input: JSON.stringify({ ...request, root, trusted_root: ROOT }),
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024,
  });
  if (child.status !== 0) fail(child.status === 86 ? 'TRANSPORT_BLOCKED' : 'WORKER_FAILED');
  let result;
  try { result = JSON.parse(child.output[3]); }
  catch { fail('WORKER_FAILED'); }
  if (result.input_digest !== request.input_digest || result.observations?.length !== request.questions.length) fail('WORKER_FAILED');
  result.harness_digest = sha256(['private-ledger-replay.mjs', 'private-ledger-worker.mjs', 'private-ledger-contract.mjs', 'money-replay.mjs']
    .map(name => readFileSync(new URL(name, import.meta.url))));
  result.transport_digest = sha256(readFileSync(tripwire));
  result.worktree_path = root;
  return result;
}
export function comparePrivateRuns(baseline, candidate) {
  for (const key of ['input_digest', 'harness_digest', 'transport_digest', 'node_version', 'migration_digest']) if (baseline[key] !== candidate[key]) fail('COMPARISON_IDENTITY_MISMATCH');
  if (baseline.observations.length !== candidate.observations.length) fail('COMPARISON_IDENTITY_MISMATCH');
  const questions = baseline.observations.map((a, index) => {
    const b = candidate.observations[index];
    if (a.id !== b.id || a.question_digest !== b.question_digest) fail('COMPARISON_IDENTITY_MISMATCH');
    const first = new Map((a.trace.cents || []).map(f => [f.path, f.cents]));
    const last = new Map((b.trace.cents || []).map(f => [f.path, f.cents]));
    const figures = [...new Set([...first.keys(), ...last.keys()])].sort().flatMap(path => {
      const before = first.get(path) ?? null, after = last.get(path) ?? null;
      return before === after ? [] : [{ path, baseline: before, candidate: after, delta: before !== null && after !== null ? String(BigInt(after) - BigInt(before)) : null }];
    });
    const bodyChanged = JSON.stringify(a.body) !== JSON.stringify(b.body);
    return { id: a.id, changed: bodyChanged || a.execution_status !== b.execution_status || a.trace.route !== b.trace.route || JSON.stringify(a.fatal) !== JSON.stringify(b.fatal),
      baseline_status: a.execution_status, candidate_status: b.execution_status,
      baseline_route: a.trace.route, candidate_route: b.trace.route,
      answer_changed: a.body?.answer !== b.body?.answer, figures };
  });
  return { schema: 1, input_digest: baseline.input_digest, questions,
    changed_questions: questions.filter(q => q.changed).length,
    invalid: baseline.invalid + candidate.invalid,
    grading: 'figure and answer differences only; private independent adjudication required' };
}
export function writeArtifacts(output, artifacts) {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  // checkOutput already refused existing destinations. Exclusive files preserve
  // prior outputs even if another process races this run.
  for (const [name, value] of Object.entries(artifacts)) writeFileSync(resolve(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function parseArgs(argv) {
  if (argv[0] === '--export-plan') {
    if (argv.length !== 4 || argv[2] !== '--tenant' || !argv[1] || !argv[3]) fail('INVALID_ARGUMENTS');
    return { plan: argv[1], tenant: argv[3] };
  }
  if (argv.length < 3 || argv.slice(0, 3).some(v => !v || v.startsWith('--'))) fail('INVALID_ARGUMENTS');
  const [exportDir, questionsFile, outDir, ...flags] = argv;
  const options = {};
  while (flags.length) {
    const flag = flags.shift(), value = flags.shift();
    if (!['--candidate', '--baseline'].includes(flag) || !value || value.startsWith('--') || options[flag]) fail('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  if (options['--baseline'] && !options['--candidate']) fail('INVALID_ARGUMENTS');
  return { exportDir, questionsFile, outDir, candidate: options['--candidate'] || ROOT, baseline: options['--baseline'] || null };
}
export function runPrivateReplay(options) {
  if (options.plan) {
    const output = checkOutput(options.plan, [ROOT]);
    const artifacts = exportQueries(options.tenant);
    writeArtifacts(output, artifacts);
    return { output, files: Object.keys(artifacts), count: 0, complete: 0, invalid: 0 };
  }
  const root = sourceRoot(options.candidate), baselineRoot = options.baseline ? sourceRoot(options.baseline) : null;
  const output = checkOutput(options.outDir, [ROOT, root, ...(baselineRoot ? [baselineRoot] : [])]);
  const request = readPrivateInputs(options.exportDir, options.questionsFile);
  const candidate = runPrivateArm(root, request);
  const artifacts = { 'answers.json': candidate };
  let invalid = candidate.invalid;
  if (baselineRoot) {
    const baseline = runPrivateArm(baselineRoot, request);
    artifacts['baseline.json'] = baseline; artifacts['candidate.json'] = candidate;
    artifacts['comparison.json'] = comparePrivateRuns(baseline, candidate);
    invalid += baseline.invalid;
  }
  writeArtifacts(output, artifacts);
  return { output, files: Object.keys(artifacts), count: request.questions.length, complete: candidate.complete, invalid };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runPrivateReplay(parseArgs(process.argv.slice(2)));
    process.stdout.write(`questions=${result.count} complete=${result.complete} invalid=${result.invalid} files=${result.files.length}\n`);
    for (const name of result.files) process.stdout.write(resolve(result.output, name) + '\n');
    process.exitCode = result.invalid ? 1 : 0;
  } catch (error) {
    const code = /^PRIVATE_REPLAY_[A-Z_]+$/.test(error.message) ? error.message : 'PRIVATE_REPLAY_INPUT_OR_IO_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 2;
  }
}
