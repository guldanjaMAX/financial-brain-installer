import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { QUICKBOOKS_OWNER_STARTER, quickBooksSetupPresentation } from './quickbooks-setup-state.mjs';

type Receipt = { stage: string; connected: boolean; last_import_at: number | null; next_check_at: number | null };

export function QuickBooksSetup() {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.hash.slice(1));
  const offered = params.getAll('quickbooks-setup');
  const operation = offered.length === 1 && /^[A-Za-z0-9_-]{16,128}$/.test(offered[0]) ? offered[0] : null;
  const view = quickBooksSetupPresentation(receipt);

  useEffect(() => {
    if (!paired || !operation) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Receipt>('/api/app/quickbooks/setup/status', { operation_id: operation });
        if (!stopped) { setReceipt(next); timer = setTimeout(poll, 5000); }
      } catch {
        if (!stopped) { setPaired(false); setNotice('The companion could not confirm this setup. Reopen setup from your connected computer.'); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [paired, operation]);

  const pair = async () => {
    setBusy(true);
    try {
      setReceipt(await api<Receipt>('/api/app/quickbooks/setup/start', { operation_id: operation }));
      setPaired(true); setNotice('');
    } catch { setNotice('The paired companion is unavailable or this setup has expired. Reopen setup from your connected computer.'); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(QUICKBOOKS_OWNER_STARTER); setNotice('Setup sentence copied.'); }
    catch { setNotice('Select and copy the setup sentence below.'); }
  };

  return <section className="max-w-2xl space-y-5" aria-labelledby="quickbooks-setup-title">
    <p className="eyebrow">Your private Intuit app</p>
    <h1 id="quickbooks-setup-title" className="page-title">Connect QuickBooks Online</h1>
    <p className="page-intro">Use your own Intuit app for one company. Your keys stay in the protected provider store on your computer.</p>
    <p>Preview for 0.4.12. Guided portal transfer is held until the signed companion and browser privacy checks are verified. Setup pauses if that helper is unavailable.</p>
    <div className="rounded-xl border border-line p-4 space-y-3">
      <p>Start with your installed Brain, its paired desktop companion, a supported browser agent, and access to the intended QuickBooks company.</p>
      <p className="text-sm">{QUICKBOOKS_OWNER_STARTER}</p>
      <button type="button" className="px-4 py-2 rounded-lg border border-line" onClick={copy}>Copy setup sentence</button>
    </div>
    {operation && !paired && <button type="button" disabled={busy} onClick={pair}
      className="px-4 py-2 rounded-lg border border-line">{busy ? 'Checking companion…' : 'Allow this paired setup'}</button>}
    <div role="status" aria-live="polite" className="rounded-xl border border-line p-4 space-y-2">
      <p>{paired ? view.message : 'Open this setup with the paired companion on your computer.'}</p>
      <p>Last completed import: {view.lastImport || 'Not confirmed'}</p>
      <p>Next expected check: {view.nextCheck || 'Not confirmed'}</p>
      {notice && <p>{notice}</p>}
    </div>
    <p>Keep the connected computer available for scheduled updates. On mobile, continue setup on that computer.</p>
    <p>Intuit’s Accounting consent may allow reading and changing accounting data. Financial Brain uses this connection only to read your books.</p>
    <p>Check the intended company in Intuit before approving. Never paste a key into chat. Unknown legal or business answers need your review.</p>
    <p>Disconnect requires your approval in the local companion. Imported records remain. If Intuit does not confirm revocation, the setup reports that uncertainty.</p>
    <p>QuickBooks Desktop uses its own separate connection.</p>
  </section>;
}
