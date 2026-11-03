import { replayRoute } from './route-replay.mjs';
import { CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { DOCUMENT_CASES } from '../../test/fixtures/fastloop-route/input.mjs';

const fault = process.argv[2] || null;
if (![null, 'sql', 'bind', 'model', 'model-check', 'model-prompt', 'model-name', 'model-messages'].includes(fault)) throw Error('UNKNOWN_PROBE');
const input = fault?.startsWith('model') ? DOCUMENT_CASES[0] : CONTROLS.find(c => c.id === 'M06/typed');
const o = replayRoute({ cases: [input], fault }).observations[0];
console.log(JSON.stringify({ outcome: o.execution_status, sql_attempts: o.trace.sql.length,
  model_attempts: o.trace.models.length, fatal: o.fatal }));
process.exitCode = o.execution_status === 'complete' ? 0 : 1;
