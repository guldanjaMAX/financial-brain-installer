import "./update-faults-boundaries.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cmdUpgrade, runRestartSafeMigrationStatements } from "../brain.mjs";
import { createMigrationStatementIntentStore } from "../operations/migration-statement-intent.mjs";

const ALTER = "ALTER TABLE fixture_records ADD COLUMN extra TEXT";
export function createFaultFixture(root) {
  const manifestPath = join(root, "brain.manifest.json");
  const databasePath = join(root, "database.sqlite");
  const targetVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { version: "0.4.1", domain: "brain.example.invalid", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { storage: "d1", account_id: "fixture-account", d1_database_id: "fixture-db" } },
    }));
    writeFileSync(join(root, ".brain-admin-key"), "synthetic-fixture-key", { mode: 0o600 });
    const db = new DatabaseSync(databasePath);
    db.exec(readFileSync(new URL("../migrations/d1/0001_install_state.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO install_state (id, client_slug, product_version, schema_version, installed_at) VALUES (1, 'fixture', '0.4.1', 10, '2026-10-01T00:00:00.000Z')");
    db.exec("CREATE TABLE fixture_records (id INTEGER PRIMARY KEY); INSERT INTO fixture_records VALUES (1)");
    db.close();
  }
  return { root, manifestPath, databasePath, targetVersion };
}

export async function runFaultUpgrade(f, { fault, afterPause, bookmarkOptions = {} } = {}) {
  const db = new DatabaseSync(f.databasePath);
  const events = [];
  const lines = [];
  let error = null;
  let clock = 0;
  const intent = createMigrationStatementIntentStore({
    accountId: "fixture-account", databaseId: "fixture-db", migrationChecksum: "fixture-checksum",
    directory: join(f.root, "intents"),
  });
  const query = async (sql, params = []) => ({ results: db.prepare(sql).all(...params) });
  try {
    await cmdUpgrade(f.manifestPath, {
      // Lifecycle fault arms inject native ACL work just like provider work.
      // Real DACL behavior has its own Windows-native receipt regression.
      bookmarkOptions: { directory: join(f.root, "bookmarks"), now: () => new Date("2026-10-10T12:00:00.000Z"), windowsAcl: () => {}, ...bookmarkOptions },
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (account, database, sql, params = []) => {
        if (account !== "fixture-account" || database !== "fixture-db") throw new Error("identity drift");
        return query(sql, params);
      },
      cf: async () => { events.push("bookmark:captured"); return { bookmark: "fixture-before-update" }; },
      readUpdateBacklog: async () => ({ pending: 0 }),
      cmdDeploy: async (_path, options) => {
        if (options.pauseVectorDrainForUpgrade) {
          events.push("deploy:paused:applied");
          if (afterPause) await afterPause();
          if (fault === "paused-reply") throw new Error("fixture lost upload reply");
        } else events.push("deploy:active:applied");
      },
      cmdHealth: async (_path, options) => { events.push(`health:${options.expectDrainMode}`); },
      waitForVectorDrainQuiescence: async () => {},
      cmdMigrate: async () => {
        events.push("migration");
        await runRestartSafeMigrationStatements([ALTER], async (sql) => {
          events.push("alter:dispatched");
          return query(sql);
        }, {
          inspectStatement: async (sql) => {
            const result = await query(sql);
            if (/^PRAGMA/.test(sql)) events.push(result.results.some((row) => row.name === "extra") ? "column:present" : "column:absent");
            return result;
          },
          statementIntent: {
            has(statement) { const present = intent.has(statement); if (present) events.push("intent:reopened"); return present; },
            claim(statement) {
              const claimed = intent.claim(statement);
              events.push("intent:persisted");
              if (fault === "orphan-intent") throw new Error("fixture crash after durable intent");
              return claimed;
            },
            clear: intent.clear,
          },
          pollIntervalMs: 1, pollDeadlineMs: 2, now: () => clock,
          sleep: async (ms) => { clock += ms; }, log: (line) => lines.push(line),
        });
      },
      cmdBootstrap: async () => ({ epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true }),
      reconcileWorkerProviderSecrets: async () => {}, cmdDrain: async () => {}, cmdTest: async () => {},
    });
  } catch (caught) { error = caught; }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const version = tables.has("install_state") ? db.prepare("SELECT product_version FROM install_state").get().product_version : null;
  const history = tables.has("upgrade_runs") ? db.prepare("SELECT status, d1_bookmark FROM upgrade_runs ORDER BY id").all() : [];
  db.close();
  return { error, events, lines, version, history };
}
