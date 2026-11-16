import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryExportTables, RECOVERY_DURABLE_TABLES, V048_RECOVERY_DURABLE_TABLES } from '../../operations/cloudflare-recovery-adapter.mjs';

test('contract expectations survive current recovery without widening historical inventories', () => {
  assert.equal(RECOVERY_DURABLE_TABLES.includes('fin_expectations'), true);
  assert.equal(recoveryExportTables([{ version: 62 }]).includes('fin_expectations'), true);
  assert.equal(recoveryExportTables([{ version: 61 }]).includes('fin_expectations'), false);
  assert.equal(V048_RECOVERY_DURABLE_TABLES.includes('fin_expectations'), false);
});
