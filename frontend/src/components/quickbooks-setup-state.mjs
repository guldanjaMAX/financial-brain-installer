/** Closed owner copy. Raw provider errors and identity never enter this view. */
export const QUICKBOOKS_OWNER_STARTER = 'Connect QuickBooks Online to my Financial Brain using a private Intuit app owned by me for my company, do the setup in my browser, keep all keys out of chat, and pause only when I need to sign in or approve.';
export const QUICKBOOKS_SETUP_STATES = Object.freeze({
  preparing: 'Preparing your private connection',
  owner_action: 'Your sign-in or approval is needed',
  awaiting_intuit: 'Waiting for Intuit',
  keys_staged: 'Keys saved. QuickBooks is not connected yet.',
  connecting: 'Connecting QuickBooks',
  connected: 'QuickBooks connection verified',
  import_pending: 'Connected. Your first import is still pending.',
  reconnect: 'Reconnect QuickBooks to resume updates',
  revocation_uncertain: 'Access removal is not confirmed. Updates remain paused.',
  disconnected: 'QuickBooks disconnected. Imported records remain.',
});
export function quickBooksSetupPresentation(receipt) {
  const stage = receipt && Object.hasOwn(QUICKBOOKS_SETUP_STATES, receipt.stage) ? receipt.stage : 'preparing';
  const timestamp = (value) => Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : null;
  return {
    stage, message: QUICKBOOKS_SETUP_STATES[stage],
    connected: ['connected', 'import_pending'].includes(stage) && receipt?.connected === true,
    lastImport: timestamp(receipt?.last_import_at), nextCheck: timestamp(receipt?.next_check_at),
  };
}
