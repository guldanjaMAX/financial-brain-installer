import { appendFileSync } from 'node:fs';
import { QBD_CONTRACT, decodeQbdFrames, encodeQbdFrame, qbdRequests } from '../../operations/quickbooks-desktop-bridge.mjs';

export function fakeQbdFrames(operation, plan) {
  const requests = qbdRequests(operation, plan);
  const frames = requests.filter((entry) => entry.mode !== 'postdated').map((entry) => {
    let rows = [];
    if (entry.key === 'Host') rows = [{ ProductName: 'QuickBooks Pro', Country: 'US', SupportedQBXMLVersion: ['13.0', '16.0'] }];
    if (entry.key === 'Company') rows = [{ CompanyName: 'Synthetic Store', IsSampleCompanyFile: 'false' }];
    if (entry.key === 'Preferences') rows = [{
      'CurrentAppAccessRights.IsReadOnly': 'true',
      'CurrentAppAccessRights.IsAutomaticLoginAllowed': 'false',
      'CurrentAppAccessRights.IsPersonalDataAccessAllowed': 'false',
    }];
    if (entry.key === 'Account') rows = [{ ListID: 'AA-12', TimeCreated: '2020-01-01T00:00:00-07:00', Name: 'Synthetic Bank', Balance: '12.34' }];
    return { protocol: 1, type: 'batch', request: entry.id, entity: entry.ret, rows };
  });
  frames.push({ protocol: 1, type: 'terminal', requests: requests.map((entry) => ({
    id: entry.id, iteratorRemainingCount: 0, statusCode: 0, statusSeverity: 'Info', requestCount: 1,
    rowCount: frames.find((frame) => frame.request === entry.id)?.rows.length ?? 0,
    ...(entry.mode === 'postdated' ? { matchedCount: 2 } : {}),
  })) });
  return frames;
}

if (process.argv[2] === '--fake') {
  const [mode, operation, marker] = process.argv.slice(3);
  const input = [];
  for await (const chunk of process.stdin) input.push(chunk);
  const [plan] = decodeQbdFrames(Buffer.concat(input));
  const frames = fakeQbdFrames(operation, plan);
  if (mode === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
  if (mode.startsWith('exit:')) process.exit(Number(mode.slice(5)));
  if (mode === 'missing') frames.pop();
  if (mode === 'remaining') frames.at(-1).requests[0].iteratorRemainingCount = 1;
  if (mode === 'warn') frames.at(-1).requests[0].statusSeverity = 'Warn';
  if (mode === 'private') {
    for (const frame of frames.filter((entry) => entry.type === 'batch')) {
      for (const row of frame.rows) Object.assign(row, {
        SSN: 'SENTINEL_SSN', EIN: 'SENTINEL_EIN', BankNumber: 'SENTINEL_BANK',
        AccountNumber: 'SENTINEL_ACCOUNT', CreditCardInfo: 'SENTINEL_CARD', Notes: 'SENTINEL_NOTES',
        statusMessage: 'SENTINEL_RECORD C:\\SENTINEL_COMPANY\\data.qbw',
      });
      frame.statusMessage = 'SENTINEL_RECORD C:\\SENTINEL_COMPANY\\data.qbw';
    }
    frames.at(-1).requests[0].statusMessage = 'SENTINEL_RECORD';
  }
  if (mode === 'broken-pipe') {
    let ended = false;
    const close = () => { if (!ended) { ended = true; appendFileSync(marker, 'EndSession\nCloseConnection\n'); } };
    process.stdout.on('error', () => { close(); process.exit(0); });
    try {
      for (let i = 0; i < 5000; i++) {
        const frame = encodeQbdFrame({ type: 'batch', rows: ['x'.repeat(16384)] });
        await new Promise((done, reject) => process.stdout.write(frame, (error) => error ? reject(error) : done()));
      }
    } catch { /* the stream error handler records the close */ }
    finally { close(); }
  } else {
    for (const frame of frames) process.stdout.write(encodeQbdFrame(frame));
  }
}
