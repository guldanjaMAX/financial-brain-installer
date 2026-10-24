import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite with the narrow D1 surface. Faults affect only injected local tests.
export function createSqliteD1({ migrationSql } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrationSql ?? readFileSync(new URL('../../migrations/0001_security_ledger.sql', import.meta.url), 'utf8'));
  let failure = null;
  let corrupt = false;
  function check(operation) {
    if (failure === operation) {
      failure = null;
      throw new Error('synthetic_store_unavailable');
    }
  }
  function statement(sql, bindings = []) {
    return {
      bind(...values) { return statement(sql, values); },
      async first() {
        check('first');
        return sqlite.prepare(sql).get(...bindings) ?? null;
      },
      async all() { check('all'); return { success: true, results: sqlite.prepare(sql).all(...bindings) }; },
      async run() { check('run'); return execute(); },
      execute,
    };
    function execute() {
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) {
        const results = sqlite.prepare(sql).all(...bindings);
        if (corrupt) {
          corrupt = false;
          if (results[0]) results[0].protocol = 'invalid';
        }
        return { success: true, results };
      }
      const result = sqlite.prepare(sql).run(...bindings);
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    }
  }
  const db = {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      check('batch');
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(item => item.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    failNext(operation) { failure = operation; },
    corruptNextReadback() { corrupt = true; },
  };
  return { db, sqlite };
}
