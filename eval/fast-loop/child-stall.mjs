import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HANDLE_TYPES = new Set(['async', 'check', 'fs_event', 'fs_poll', 'idle', 'pipe',
  'poll', 'prepare', 'process', 'signal', 'tcp', 'timer', 'tty', 'udp']);

function javascriptStack(stack, root) {
  return (stack || []).slice(0, 12).map(frame => {
    const match = /(?:\(|\s)(file:\/\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/[^\s)]+|node:[^\s)]+):(\d+):(\d+)\)?$/.exec(frame);
    if (!match) return '[external]';
    let location = match[1];
    if (!location.startsWith('node:')) {
      try { if (location.startsWith('file:')) location = fileURLToPath(location); }
      catch { return '[external]'; }
      location = relative(root, location);
      if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) return '[external]';
      location = location.split(sep).join('/');
    }
    return `${location}:${match[2]}:${match[3]}`.slice(-100);
  });
}

// The report object contains environment, paths and other private host state.
// Copy only stack locations inside this repo, builtin locations, handle types
// and native function names. Never serialize the report or an error message.
export function armReplayStall({ root = ROOT, getReport = () => process.report?.getReport(),
  setTimer = setTimeout, writeStderr = line => process.stderr.write(line) } = {}) {
  const timer = setTimer(() => {
    let report;
    try { report = getReport(); } catch { /* Permission mode can deny reports. */ }
    const summary = { javascript_stack: javascriptStack(report?.javascriptStack?.stack || new Error().stack.split('\n').slice(1), root) };
    if (report) {
      summary.active_handles = [...new Set((report.libuv || []).filter(handle => handle.is_active && HANDLE_TYPES.has(handle.type)).map(handle => handle.type))].sort();
      summary.native_stack = (report.nativeStack || []).slice(0, 12).map(frame =>
        /^([A-Za-z_~][A-Za-z0-9_:~<>]*)(?:\(|$)/.exec(frame.symbol || '')?.[1]?.slice(0, 64) || '[external]');
    } else summary.report = 'unavailable';
    // Keep the whole diagnosis within the launcher's 400-character stderr tail.
    // Keep every handle type and at least one frame per nonempty stack.
    const lists = [summary.javascript_stack, summary.native_stack].filter(Array.isArray);
    while (JSON.stringify(summary).length > 370) {
      const longest = lists.filter(list => list.length > 1).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (!longest) break;
      longest.pop();
    }
    writeStderr(`REPLAY_CHILD_STALL ${JSON.stringify(summary)}\n`);
  }, 30000);
  timer.unref();
  return timer;
}
