// Test-only interpreter of the normative table. It has no I/O, credentials,
// provider calls, persistence, or production import sites. A true fact means
// independently verified evidence; it never means a caller supplied a flag.
export function transition(specification, machineName, state, event, facts = {}) {
  const machine = Object.hasOwn(specification.machines, machineName)
    ? specification.machines[machineName] : undefined;
  const edges = machine?.transitions.filter(edge => edge.from === state && edge.event === event) ?? [];
  if (edges.length !== 1 || machine.terminal.includes(state) ||
      !edges[0].requires.every(key => Object.hasOwn(facts, key) && facts[key] === true)) {
    throw new Error('transition_refused');
  }
  return edges[0].to;
}
