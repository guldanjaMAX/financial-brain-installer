// The schema's inclusive calendar domain also bounds every accepted mark.
export const MIN_TIME_MS = Date.parse('2020-01-01T00:00:00.000Z');
export const MAX_TIME_MS = Date.parse('2099-12-31T23:59:59.999Z');
export function validTime(ms) {
  return Number.isSafeInteger(ms) && ms >= MIN_TIME_MS && ms <= MAX_TIME_MS;
}
export function recoveryAttempts(marks) {
  const attempts = [];
  let owner, terminal;
  for (const mark of marks) {
    if (mark.event === 'again') {
      owner = { kind: 'OWNER', result: 'INCOMPLETE', progress_ms: null, duration_ms: null };
      attempts.push(owner); owner = { value: owner, start: mark.ms };
    }
    if (mark.event === 'back' && owner) {
      const elapsed = mark.ms - owner.start;
      Object.assign(owner.value, { result: elapsed > 60000 ? 'TIMEOUT' : 'PROGRESS', progress_ms: elapsed, duration_ms: elapsed });
    }
    if (mark.event === 'note' && ['owner-timeout','owner-failed'].includes(mark.text) && owner) {
      Object.assign(owner.value, { result: mark.text === 'owner-timeout' ? 'TIMEOUT' : 'FAILED', duration_ms: mark.ms - owner.start });
      owner = undefined;
    }
    // Infer S1 even when no failure note was written and progress never arrived.
    if (owner && owner.value.progress_ms === null && mark.ms - owner.start > 60000) {
      Object.assign(owner.value, { result: 'TIMEOUT', duration_ms: mark.ms - owner.start });
    }
    if (mark.event === 'note' && mark.text === 'terminal-again') {
      terminal = { value: { kind: 'TERMINAL', result: 'INCOMPLETE', progress_ms: null, duration_ms: null }, start: mark.ms };
      attempts.push(terminal.value);
    }
    if (mark.event === 'note' && mark.text === 'terminal-back' && terminal) {
      const elapsed = mark.ms - terminal.start;
      Object.assign(terminal.value, { result: 'PROGRESS', progress_ms: elapsed, duration_ms: elapsed }); terminal = undefined;
    }
  }
  return attempts;
}
