import { validTime, recoveryAttempts } from './time-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { context, STOP_ROWS, PHASES } from './mark.mjs';
import { localRoot, runRoot } from './local-evidence.mjs';
import { data, check } from './summary-shape.mjs';
import { readMeasurements, validateMeasurements } from './measure.mjs';
import { read, writeNew, fail } from './safe-files.mjs';
import { toolVersion } from './tool-identity.mjs';
export const STEP_IDS = Object.freeze([...Array.from({ length: 9 }, (_, i) => 'A' + i), ...Array.from({ length: 33 }, (_, i) => String(i + 1))]);
const schema = JSON.parse(fs.readFileSync(new URL('./SUMMARY.schema.json', import.meta.url), 'utf8'));
function invalid(code = 'SUMMARY_INVALID') { const error = new Error('The summary did not pass the local check.'); error.code = code; throw error; }
export function validateSummary(value) {
  data(value);
  check(value, schema);
  if (value.tool_version !== toolVersion()) invalid('SUMMARY_TOOL_VERSION');
  validateMeasurements(value.measurements);
  if (value.gap_count !== value.steps.filter(step => step.status === 'GAP').length) invalid(); // GAP_COUNT_GUARD
  if (value.round_timings[0].round !== 'A' || value.round_timings[1].round !== 'B') invalid();
  for (let index = 0; index < STEP_IDS.length; index++) {
    const step = value.steps[index];
    if (step.id !== STEP_IDS[index]) invalid();
    const time = text => {
      if (text === null) return null;
      const ms = Date.parse(text);
      if (!validTime(ms) || new Date(ms).toISOString() !== text) invalid();
      return ms;
    };
    const start = time(step.started_at), end = time(step.ended_at);
    if ((end !== null && (start === null || end < start)) || step.duration_ms !== (start === null || end === null ? 0 : end - start)) invalid();
    if ((step.status === 'GAP') !== (step.error_code === 'KNOWN_GAP')) invalid();
    if (step.status === 'GAP' && (start === null || end === null)) invalid();
    if ((step.status === 'PASS') !== (step.error_code === 'NONE')) invalid();
    if (step.status === 'PASS' && (start === null || end === null)) invalid();
    if (step.counts.owner_starts > 1 || step.counts.marks < (start === null ? 0 : end === null ? 1 : 2)) invalid();
  }
  return value;
}
// Replay once in append order. A PASS depends only on already-eligible proof.
// Equal clock ticks preserve append order; checks must start on a later tick.
function interruptionProof(marks) {
  const cycles = [];
  const proof_order = {stop:0,partial:0,recovery:0,checks_start:0,checks:0};
  let eligible = {}, recoveryAt = null, checksStartedAt = null;
  for (const mark of marks) {
    if (mark.event === 'stop') {
      eligible = {}; recoveryAt = null; checksStartedAt = null;
      cycles.push(Object.fromEntries(PHASES.map(phase => [phase, 'NOT RUN'])));
    }
    if (mark.event === 'again' && cycles.length) {
      eligible = {stop:eligible.stop}; recoveryAt = null; checksStartedAt = null;
      for (const phase of ['partial','recovery','checks']) if (cycles.at(-1)[phase] === 'PASS') cycles.at(-1)[phase] = 'NOT RUN';
    }
    if (mark.event === 'note' && mark.text === 'proof-checks-start') {
      const ordered = eligible.recovery === true && recoveryAt !== null && mark.ms > recoveryAt;
      if (!ordered) proof_order.checks_start++; // ORDER_START_GUARD
      checksStartedAt = ordered ? mark.ms : null;
      if (cycles.length && cycles.at(-1).checks === 'PASS') cycles.at(-1).checks = 'NOT RUN';
    }
    const proof = mark.event === 'note' && /^proof-(stop|partial|recovery|checks)-(pass|fail)$/.exec(mark.text);
    if (!proof || !cycles.length) continue;
    const phase = proof[1], result = proof[2].toUpperCase();
    const prior = {stop:true,partial:eligible.stop === true,recovery:eligible.partial === true,
      checks:eligible.recovery === true && checksStartedAt !== null && mark.ms >= checksStartedAt};
    if (result === 'PASS' && !prior[phase]) { proof_order[phase]++; continue; } // ORDER_PHASE_GUARD
    // A FAIL is observed even if the preceding phase was missing or failed.
    if (cycles.at(-1)[phase] !== 'FAIL') cycles.at(-1)[phase] = result;
    eligible[phase] = result === 'PASS' && cycles.at(-1)[phase] !== 'FAIL';
    if (phase === 'recovery') recoveryAt = eligible.recovery ? mark.ms : null;
  }
  const interruption = Object.fromEntries(PHASES.map(phase => {
    const results = cycles.map(cycle => cycle[phase]);
    return [phase, results.includes('FAIL') ? 'FAIL' : !results.length || results.includes('NOT RUN') ? 'NOT RUN' : 'PASS'];
  }));
  return {interruption,proof_order};
}
function maxGap(marks) {
  return marks.reduce((gap, mark, index) => index ? Math.max(gap, mark.ms - marks[index-1].ms) : gap, 0);
}
function roundTimings(dir) {
  const { rows } = context(localRoot(dir));
  return ['A','B'].map(round => {
    const marks = rows.filter(mark => mark.round === round), starts = marks.filter(mark => mark.event === 'start'), ends = marks.filter(mark => mark.event === 'done');
    return { round, duration_ms: starts.length && ends.length ? Math.max(0, Math.max(...ends.map(mark => mark.ms)) - Math.min(...starts.map(mark => mark.ms))) : 0, max_mark_gap_ms: maxGap(marks) };
  });
}
function facts(dir) {
  const { rows } = context(localRoot(dir));
  const measurements = readMeasurements(dir);
  return STEP_IDS.map(id => {
    const marks = rows.filter(entry => entry.row === id && entry.round === (id.startsWith('A') ? 'A' : 'B'));
    const start = marks.find(entry => entry.event === 'start'), end = marks.find(entry => entry.event === 'done');
    const recovery_attempts = recoveryAttempts(marks);
    const stopRule = marks.some(entry => entry.event === 'note' && ['owner-timeout','owner-failed'].includes(entry.text)) || recovery_attempts.some(attempt => attempt.kind === 'OWNER' && ['TIMEOUT','FAILED'].includes(attempt.result));
    const {interruption,proof_order} = STOP_ROWS.includes(id) ? interruptionProof(marks) : {interruption:null,proof_order:{stop:0,partial:0,recovery:0,checks_start:0,checks:0}};
    const phaseFailed = interruption && Object.values(interruption).includes('FAIL');
    const phaseMissing = interruption && (Object.values(interruption).includes('NOT RUN') || Object.values(proof_order).some(count => count > 0));
    let error_code = stopRule ? 'STOP_RULE' : phaseFailed ? 'PHASE_FAILED' : !start ? 'STEP_NOT_RUN' : !end ? 'STEP_INCOMPLETE' : phaseMissing ? 'PHASE_NOT_RUN' : 'CHECK_FAILED';
    let status = ['STEP_NOT_RUN','STEP_INCOMPLETE','PHASE_NOT_RUN'].includes(error_code) ? 'NOT RUN' : 'FAIL';
    const gap = measurements.rows.find(item => item.id === id);
    if (error_code === 'CHECK_FAILED' && gap.gap_result === 'GAP' && gap.gap_code !== null && gap.gap_code !== 'NONE') { status = 'GAP'; error_code = 'KNOWN_GAP'; } // GAP_ELIGIBILITY
    return { id, status, started_at: start?.iso ?? null, ended_at: end?.iso ?? null,
      duration_ms: start && end ? end.ms - start.ms : 0,
      error_code, interruption, proof_order, recovery_attempts, max_mark_gap_ms: maxGap(marks),
      counts: { marks: marks.length, owner_starts: marks.filter(entry => entry.event === 'start' && entry.owner === '1').length } };
  });
}
export function draftSummary(dir) {
  const steps = facts(dir);
  return validateSummary({ schema_version: 4, kit_version: '7.0.0', tool_version: toolVersion(), round_timings: roundTimings(dir), measurements: readMeasurements(dir), steps, gap_count: steps.filter(step => step.status === 'GAP').length });
}
export function writeSummary(dir, candidate) {
  validateSummary(candidate); // SUMMARY_SCHEMA_GUARD
  const observed = facts(dir);
  if (JSON.stringify(candidate.measurements) !== JSON.stringify(readMeasurements(dir))) invalid('SUMMARY_PROOF'); // MEASUREMENT_BINDING
  if (JSON.stringify(candidate.round_timings) !== JSON.stringify(roundTimings(dir))) invalid('SUMMARY_PROOF');
  for (let index = 0; index < STEP_IDS.length; index++) {
    const step = candidate.steps[index], fact = observed[index];
    if (step.started_at !== fact.started_at || step.ended_at !== fact.ended_at || step.duration_ms !== fact.duration_ms || step.counts.marks !== fact.counts.marks || step.counts.owner_starts !== fact.counts.owner_starts) invalid('SUMMARY_PROOF');
    if (JSON.stringify(step.interruption) !== JSON.stringify(fact.interruption)) invalid('SUMMARY_PROOF');
    if (JSON.stringify(step.proof_order) !== JSON.stringify(fact.proof_order)) invalid('SUMMARY_PROOF'); // ORDER_BINDING
    const gap = candidate.measurements.rows[index];
    if ((step.status === 'GAP') !== (fact.status === 'GAP') || (gap.gap_result === 'FAIL' && step.status === 'PASS')) invalid('SUMMARY_PROOF'); // GAP_BINDING
    if (JSON.stringify(step.recovery_attempts) !== JSON.stringify(fact.recovery_attempts) || step.max_mark_gap_ms !== fact.max_mark_gap_ms) invalid('SUMMARY_PROOF');
    if (step.status === 'PASS' && (!fact.started_at || !fact.ended_at)) invalid('SUMMARY_PROOF');
    if (fact.error_code === 'STOP_RULE' && (step.error_code !== 'STOP_RULE' || step.status !== 'FAIL')) invalid('SUMMARY_PROOF');
    if (step.error_code === 'STEP_NOT_RUN' && fact.started_at !== null) invalid('SUMMARY_PROOF');
    if (step.error_code === 'STEP_INCOMPLETE' && (fact.started_at === null || fact.ended_at !== null)) invalid('SUMMARY_PROOF');
    if (['STEP_NOT_RUN','STEP_INCOMPLETE','PHASE_NOT_RUN','PHASE_FAILED'].includes(fact.error_code) && (step.error_code !== fact.error_code || step.status !== fact.status)) invalid('SUMMARY_PROOF');
  }
  const bytes = JSON.stringify(candidate, null, 2) + '\n';
  validateSummary(JSON.parse(bytes)); // FINAL_BYTES_GUARD
  writeNew(path.join(runRoot(dir), 'SUMMARY.json'), bytes);
}
export function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length && args[0] !== '--draft')) invalid();
  const dir = process.cwd(), local = localRoot(dir);
  if (args[0] === '--draft') {
    writeNew(path.join(local,'SUMMARY-INPUT.json'), JSON.stringify(draftSummary(dir),null,2)+'\n');
    console.log('Local summary draft saved. Check each completed step before recording PASS.'); return;
  }
  console.log('Summary validation reached.');
  const text = read(path.join(local,'SUMMARY-INPUT.json'));
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) invalid();
  writeSummary(dir, JSON.parse(text));
  console.log('SUMMARY.json saved. Share only this file.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { fail('No summary was written. Check the fixed schema, local step marks and existing output.'); }
}
