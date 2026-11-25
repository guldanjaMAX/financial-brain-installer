import { validTime, recoveryAttempts } from './time-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeDir, plain, read, replace, writeNew, rowId, fail } from './safe-files.mjs';
import { localRoot } from './local-evidence.mjs';
export const HEADER = 'iso_time\tepoch_ms\tmachine\tround\trow\tevent\towner\ttext';
const events = new Set(['start', 'stop', 'again', 'back', 'done', 'note']);
export const STOP_ROWS = Object.freeze([...Array.from({ length: 15 }, (_, i) => String(i + 1)), '17', '18', '19', '20', '21']);
export const PHASES = Object.freeze(['stop', 'partial', 'recovery', 'checks']);
export function now() {
  const text = process.env.MARK_NOW_MS;
  if (text !== undefined && !/^-?\d+$/.test(text)) throw new Error('MARK_NOW_MS must be an integer.');
  const ms = text === undefined ? Date.now() : Number(text);
  if (!validTime(ms)) throw new Error('The clock value is outside the supported range.');
  return ms;
}
export function context(dir) {
  dir = localRoot(dir);
  if (!plain(path.join(dir, 'run.json'), { absent: true })) throw new Error('Missing run.json. Please use --init first.');
  let config;
  try { config = JSON.parse(read(path.join(dir, 'run.json'))); } catch { throw new Error('Please check run.json before marking.'); }
  if (!['mac', 'windows'].includes(config.machine) || !['A', 'B'].includes(config.round) || Object.keys(config).sort().join(',') !== 'machine,round') throw new Error('Please check the machine and round in run.json.');
  const file = path.join(dir, 'TIMES.tsv');
  const raw = read(file);
  if (!raw.endsWith('\n') || raw.includes('\r') || raw.split('\n')[0] !== HEADER) throw new Error('TIMES.tsv has an unexpected format.');
  const rows = raw.slice(0, -1).split('\n').slice(1).map(line => {
    const cells = line.split('\t');
    if (cells.length !== 8) throw new Error('TIMES.tsv must have eight columns.');
    const [iso, epoch, machine, round, row, event, owner, text] = cells;
    if (!/^-?\d+$/.test(epoch) || !validTime(Number(epoch)) || new Date(Number(epoch)).toISOString() !== iso || machine !== config.machine || !['A', 'B'].includes(round) || !rowId(row) || !events.has(event) || !['0', '1'].includes(owner)) throw new Error('TIMES.tsv contains an invalid mark.');
    return { iso, ms: Number(epoch), machine, round, row, event, owner, text };
  });
  // Validate old marks too, so a hand edit cannot make a later stop appear valid.
  const seen = [];
  for (const entry of rows) { if (seen.length && entry.ms < seen.at(-1).ms) throw new Error('The clock moved backwards.'); checkEvent(seen, entry.round, entry.row, entry.event, entry.text, entry.ms); seen.push(entry); }
  return { config, file, rows };
}
export function checkEvent(rows, round, row, event, text = '', ms = now()) {
  if (!rowId(row)) throw new Error('Row must be A0 to A8 or 1 to 33.');
  if (!events.has(event)) throw new Error('Choose start, stop, again, back, done or note.');
  if (event === 'note') {
    checkPhaseNote(rows.filter(e => e.round === round && e.row === row), round, row, text, ms);
    checkAttemptNote(rows.filter(e => e.round === round && e.row === row), text, ms); return;
  }
  const previous = rows.filter(e => e.round === round && e.row === row && e.event !== 'note');
  const last = previous.at(-1)?.event;
  const hasStart = previous.some(e => e.event === 'start');
  if (event === 'start') {
    if (hasStart) throw new Error('The start mark is allowed once per round and row.');
    return;
  }
  if (!hasStart) throw new Error('Missing start mark.');
  if (last === 'done') throw new Error('The done mark has already closed this row.');
  if (event === 'done') return;
  if (event === 'stop' && !['start', 'back'].includes(last)) throw new Error('Missing back mark before another stop.');
  if (event === 'again' && !['stop', 'back'].includes(last)) throw new Error(last === 'again' ? 'Missing back mark.' : 'Missing stop mark.');
  if (event === 'back' && last !== 'again') throw new Error('Missing again mark.');
}
// Fixed proof notes attest observed phases. They add no events or columns.
function checkPhaseNote(own, round, row, text, ms) {
  const proof = /^proof-(stop|partial|recovery|checks)-(pass|fail|start)$/.exec(text);
  if (!proof) return;
  if (proof[2] === 'start' && proof[1] !== 'checks') throw new Error('Only checks have a start proof note.');
  const cycle = own.slice(own.findLastIndex(entry => entry.event === 'stop'));
  const phase = proof[1], last = own.filter(entry => entry.event !== 'note').at(-1)?.event;
  const stage = phase === 'stop' ? cycle : cycle.slice(cycle.findLastIndex(entry => entry.event === 'again'));
  if (round !== 'B' || !STOP_ROWS.includes(row) || !cycle.some(entry => entry.event === 'stop') || last === 'done') throw new Error('Missing active interruption for proof note.');
  const previousProof = stage.filter(entry => entry.event === 'note' && entry.text.startsWith('proof-' + phase + '-')).at(-1);
  if (previousProof && (phase !== 'checks' || previousProof.text === text || (proof[2] !== 'start' && previousProof.text !== 'proof-checks-start'))) throw new Error('A phase proof is already recorded for this attempt.');
  if (phase === 'stop' && last !== 'stop') throw new Error('Record the stop proof at the planned stop before rerunning.');
  if (phase !== 'stop' && !cycle.some(entry => entry.event === 'again')) throw new Error('Missing owner again mark before phase proof.');
  if (['recovery','checks'].includes(phase) && proof[2] === 'pass' && !stage.some(entry => entry.event === 'back')) throw new Error('Missing observed owner progress before phase proof.');
}
// Reserved note text adds attempt timing without changing the shared events or columns.
const attemptNotes = new Set(['owner-timeout', 'owner-failed', 'owner-stop', 'terminal-again', 'terminal-back', 'terminal-stop']);
function checkAttemptNote(own, text, ms) {
  if (!attemptNotes.has(text)) return;
  const last = own.filter(e => e.event !== 'note').at(-1);
  const failure = own.find(e => e.event === 'note' && ['owner-timeout', 'owner-failed'].includes(e.text));
  const terminal = own.find(e => e.event === 'note' && e.text === 'terminal-again');
  const back = own.find(e => e.event === 'note' && e.text === 'terminal-back');
  if (last?.event === 'done') throw new Error('The done mark has already closed this row.');
  if (text === 'owner-timeout' || text === 'owner-failed') {
    if (failure || !['again', ...(text === 'owner-failed' ? ['back'] : [])].includes(last?.event)) throw new Error('Missing active owner again mark, or failure already recorded.');
    if (text === 'owner-timeout' && ms - last.ms < 60000) throw new Error('Missing 60 seconds without progress before owner-timeout.');
  }
  if (text === 'owner-stop' && (!failure || terminal || own.some(e => e.event === 'note' && e.text === 'owner-stop'))) throw new Error('Missing owner failure note, owner-stop already recorded, or Terminal attempt already started.');
  if (text === 'terminal-again' && (!failure || terminal)) throw new Error('Missing owner failure note, or terminal-again already recorded.');
  if (text === 'terminal-stop' && !terminal) throw new Error('Missing terminal-again note before a Terminal stop.');
  if (text === 'terminal-back' && (!terminal || back)) throw new Error('Missing terminal-again note, or terminal-back already recorded.');
}
export function prepareMark(dir, row, event, text = '') {
  const state = context(dir);
  checkEvent(state.rows, state.config.round, row, event, text);
  const ms = now();
  if (state.rows.length && ms < state.rows.at(-1).ms) throw new Error('The clock moved backwards. Please check the clock before marking.');
  return state;
}
export function appendMark(dir, row, event, owner = false, words = []) {
  const text = words.join(' ').replace(/[\t\r\n]/g, ' ');
  const { config, file } = prepareMark(dir, row, event, text);
  const ms = now();
  // FORMAT_COLUMNS
  const cells = [new Date(ms).toISOString(), String(ms), config.machine, config.round, row, event, owner ? '1' : '0', text];
  fs.appendFileSync(file, cells.join('\t') + '\n', { encoding: 'utf8', flag: 'a' });
}
export function summary(dir) {
  const { rows } = context(dir);
  for (const round of ['A', 'B']) {
    const marks = rows.filter(e => e.round === round);
    for (const row of [...new Set(marks.map(e => e.row))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      const own = marks.filter(e => e.row === row);
      const attempts = recoveryAttempts(own);
      const recoveries = attempts.filter(a => a.kind === 'OWNER' && a.progress_ms !== null).map(a => a.progress_ms / 1000);
      const failures = attempts.filter(a => a.kind === 'OWNER' && ['FAILED', 'TIMEOUT'].includes(a.result) && a.duration_ms !== null).map(a => a.duration_ms / 1000);
      const terminalRecoveries = attempts.filter(a => a.kind === 'TERMINAL' && a.progress_ms !== null).map(a => a.progress_ms / 1000);
      const start = own.find(e => e.event === 'start');
      const done = own.find(e => e.event === 'done');
      console.log(`round ${round} row ${row} recovery seconds: ${recoveries.length ? recoveries.join(', ') : 'pending'}; step seconds: ${start && done ? (done.ms - start.ms) / 1000 : 'pending'}; failed owner attempt seconds: ${failures.length ? failures.join(', ') : 'none'}; Terminal recovery seconds: ${terminalRecoveries.length ? terminalRecoveries.join(', ') : 'pending'}`);
    }
    if (round === 'A' && marks.length) {
      const starts = marks.filter(e => e.event === 'start');
      const dones = marks.filter(e => e.event === 'done');
      const total = starts.length && dones.length ? (Math.max(...dones.map(e => e.ms)) - Math.min(...starts.map(e => e.ms))) / 1000 : 'pending';
      const ordered = marks.map(e => e.ms).sort((a, b) => a - b);
      const gap = Math.max(0, ...ordered.slice(1).map((ms, i) => (ms - ordered[i]) / 1000));
      console.log(`round A total seconds: ${total}; longest gap seconds: ${gap}; owner start rows: ${starts.filter(e => e.owner === '1').length}`);
      console.log('The gap is between marks, not a measurement of screen silence. Total includes every marked row; report bank time apart.');
    }
  }
}
export function main(args = process.argv.slice(2)) {
  let dir = process.cwd();
  const index = args.indexOf('--dir');
  if (index !== -1) { if (!args[index + 1]) throw new Error('Missing --dir path.'); dir = path.resolve(args[index + 1]); args.splice(index, 2); }
  dir = localRoot(dir);
  if (args[0] === '--init') {
    if (args.length !== 5 || args[1] !== '--machine' || args[3] !== '--round' || !['mac', 'windows'].includes(args[2]) || !['A', 'B'].includes(args[4])) throw new Error('Use --init --machine mac|windows --round A|B.');
    const configPath = path.join(dir, 'run.json');
    if (plain(configPath, { absent: true })) {
      const state = context(dir);
      if (state.config.machine !== args[2]) throw new Error('The machine cannot change after initialization.');
    }
    const times = path.join(dir, 'TIMES.tsv');
    if (!plain(times, { absent: true })) writeNew(times, HEADER + '\n');
    else if (!plain(configPath, { absent: true })) throw new Error('Existing TIMES.tsv needs its original run.json.');
    replace(configPath, JSON.stringify({ machine: args[2], round: args[4] }) + '\n');
    return;
  }
  if (args.length === 1 && args[0] === '--summary') return summary(dir);
  const [row, event, ...rest] = args;
  const owner = rest.includes('--owner');
  appendMark(dir, row, event, owner, rest.filter(word => word !== '--owner'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { fail(error.code ? 'The stopwatch files could not be opened safely.' : error.message); }
}
