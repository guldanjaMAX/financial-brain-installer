// Contract only: no census, launch, freeze, signal, clock, file or native adapter.
// The launcher supplies independently observed gated facts through a private
// channel. The observer supplies complete tables and monotonic sequence numbers.
// Neither input may be reconstructed from a receipt. This module cannot attest
// the origin of caller objects; native custody and physical stopping are host gates.
const identityFields = ['pid', 'ppid', 'uid', 'born', 'executable'];
const invocationFields = ['entrypoint', 'runFolder', 'targetStep', 'argv'];
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (a, b, fields) => fields.every(field => equal(a?.[field], b?.[field]));
const identity = row => Object.fromEntries([...identityFields, ...invocationFields].map(k => [k, row[k]]));
const validRow = row => row && positive(row.pid) && Number.isSafeInteger(row.ppid) && row.ppid >= 0 &&
  Number.isSafeInteger(row.uid) && row.uid >= 0 && text(row.born) && text(row.executable);
const result = (reason, extra = {}) => ({ authorizationReached: 1, authorized: false,
  reason, signalRequests: [], ...extra });

function select(launch, observation) {
  if (!launch || !text(launch.launchId) || launch.gated !== true ||
      !validRow(launch.launcher) || !validRow(launch.invocation) ||
      !['entrypoint', 'runFolder', 'targetStep'].every(k => text(launch.invocation[k])) ||
      !Array.isArray(launch.invocation.argv) || !launch.invocation.argv.length ||
      !launch.invocation.argv.every(text)) return { reason: 'launch-unobserved' };
  if (!observation || !positive(observation.sequence) || !positive(observation.userId) ||
      !positive(observation.helperPid) || !Array.isArray(observation.processes) ||
      !observation.processes.every(validRow)) return { reason: 'observation-invalid' };
  const { processes, userId, helperPid } = observation;
  const map = new Map(processes.map(row => [row.pid, row]));
  if (map.size !== processes.length || !map.has(helperPid)) return { reason: 'observation-invalid' };
  const ancestors = pid => {
    const found = [];
    let parent = map.get(pid).ppid;
    while (parent) {
      if (parent === pid || found.includes(parent) || !map.has(parent)) throw new Error('ancestry');
      found.push(parent);
      parent = map.get(parent).ppid;
    }
    return found;
  };
  try {
    const lineage = new Map(processes.map(row => [row.pid, ancestors(row.pid)]));
    const expected = launch.invocation;
    const candidates = processes.filter(row => row.uid === userId &&
      same(row, expected, ['executable', ...invocationFields]));
    const roots = candidates.filter(row => !lineage.get(row.pid).some(pid => candidates.some(p => p.pid === pid)));
    if (roots.length !== 1) return { reason: 'root-ambiguous' };
    const root = roots[0];
    if (!same(root, expected, [...identityFields, ...invocationFields]) || root.uid !== userId ||
        root.ppid !== launch.launcher.pid || !same(map.get(root.ppid), launch.launcher, identityFields) ||
        launch.launcher.uid !== userId) return { reason: 'invocation-changed' };
    const tree = processes.filter(row => row.pid === root.pid || lineage.get(row.pid).includes(root.pid));
    const protectedIds = [helperPid, ...lineage.get(helperPid)];
    if (map.get(helperPid).uid !== userId || tree.some(row => row.uid !== userId || protectedIds.includes(row.pid))) {
      return { reason: 'tree-protected' };
    }
    tree.sort((a, b) => lineage.get(b.pid).length - lineage.get(a.pid).length || a.pid - b.pid);
    const guards = [...new Set([...lineage.get(root.pid), ...protectedIds])].sort((a, b) => a - b);
    return { reason: null, tree, signature: JSON.stringify({ userId, helperPid,
      tree: tree.map(identity), guards: guards.map(pid => identity(map.get(pid))) }) };
  } catch { return { reason: 'ancestry-invalid' }; }
}

export function previewStopAuthorization({ launchObservation, observation, receipt } = {}) {
  const launch = launchObservation; // RECEIPT_BOUNDARY: receipt is deliberately unused.
  // Retain private value snapshots so editing the preview or caller inputs cannot
  // turn a previously rejected plan into an authorized one.
  let heldLaunch, heldObservation;
  try { heldLaunch = structuredClone(launch); heldObservation = structuredClone(observation); }
  catch { return result('observation-invalid', { previewOnly: true, selectedTree: [],
    confirm: () => result('observation-invalid', { freshObservationReached: 1 }) }); }
  const selected = select(heldLaunch, heldObservation);
  return result(selected.reason, { previewOnly: true, selectedTree: selected.tree?.map(row => row.pid) || [],
    confirm(freshObservation) {
      const extra = { freshObservationReached: 1 };
      if (selected.reason) return result(selected.reason, extra);
      const current = select(heldLaunch, freshObservation);
      if (current.reason) return result(current.reason, extra);
      if (freshObservation.sequence <= heldObservation.sequence ||
          current.signature !== selected.signature) return result('observation-changed', extra);
      // These are requests for a future adapter, never physical signal effects.
      return result(null, { ...extra, authorized: true, previewOnly: false,
        signalRequests: current.tree.map(row => ({ pid: row.pid, signal: 'SIGKILL' })) });
    } });
}
