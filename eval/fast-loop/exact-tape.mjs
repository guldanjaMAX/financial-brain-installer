import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));
// Preserve types, object key order and exact bytes. No SQL or identifier cleanup.
export function typed(value) {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(typed)];
  if (typeof value === 'object') return ['object', Object.entries(value).map(([k, v]) => [k, typed(v)])];
  return [typeof value, String(value)];
}

export function exactTape({ entries, code, principal, fatal, calls }) {
  let cursor = 0;
  const miss = () => { fatal.push(code); throw Error(code); };
  return {
    call(request) {
      const bound = { schema: 1, principal, occurrence: cursor + 1, request: typed(request) };
      calls.push(clone(bound));
      const entry = entries[cursor++];
      if (!entry || JSON.stringify(entry.input) !== JSON.stringify(bound)) return miss();
      if (entry.error) throw Object.assign(Error(entry.error), { code: entry.error });
      return clone(entry.output);
    },
    finish() { if (cursor !== entries.length) miss(); },
  };
}

export function d1Tape(tape) {
  const statement = (sql, binds = []) => ({ sql, binds,
    bind: (...args) => statement(sql, args),
    all: async () => tape.call({ sql, binds, method: 'all' }),
    first: async () => tape.call({ sql, binds, method: 'first' }),
    run: async () => tape.call({ sql, binds, method: 'run' }),
  });
  return { prepare: statement, batch: async statements => tape.call({ method: 'batch',
    statements: statements.map(s => ({ sql: s.sql, binds: s.binds })) }) };
}

export function modelRequest(options) {
  // Timing objects contain local callbacks, not model inputs. Everything else,
  // including the stage, timeout, model, prompt and output ceilings, is exact.
  const { timing, ...input } = options;
  return input;
}
