import { ownerAppError, validateQuickBooksOwnerBinding } from '../connectors/quickbooks-owner-binding.mjs';

/**
 * Internal native-host contract, NOT an agent tool or a browser endpoint.
 * No installed browser capture adapter is shipped yet. A signed host must
 * supply these capabilities after proving its installation and tab binding.
 * In particular, a page-supplied boolean cannot suppress agent observation.
 */
export function createQuickBooksOwnerTransfer({
  verifyCompanion, suppressObservation, capturePair, closeCredentialView,
  resumeObservation, stage, now = Date.now,
}) {
  const consumed = new Set();
  const checkOperation = (operation) => {
    if (!operation || !/^[A-Za-z0-9_-]{16,128}$/.test(operation.operation_id) ||
        !Number.isSafeInteger(operation.expires_at) || operation.expires_at <= now() || operation.expires_at > now() + 600_000) {
      throw ownerAppError('quickbooks_setup_operation_expired');
    }
    if (consumed.has(operation.operation_id)) throw ownerAppError('quickbooks_setup_operation_replayed');
    return validateQuickBooksOwnerBinding(operation.binding);
  };
  return Object.freeze({
    async transfer(operation, selection) {
      const binding = checkOperation(operation);
      let verified = false;
      try { verified = await verifyCompanion(operation) === true; } catch { /* closed diagnostic boundary */ }
      if (!verified) throw ownerAppError('quickbooks_companion_required');
      if (!selection || Object.keys(selection).sort().join(',') !== 'app_id,environment,origin,redirect_uri' ||
          selection.origin !== 'https://developer.intuit.com' || selection.app_id !== binding.app_id ||
          selection.environment !== 'production' || selection.redirect_uri !== binding.redirect_uri) {
        throw ownerAppError('quickbooks_portal_binding_mismatch');
      }
      let suppressed = false;
      try { suppressed = await suppressObservation(operation) === true; } catch { /* never relay native errors */ }
      if (!suppressed) throw ownerAppError('quickbooks_observation_not_suppressed');
      let pair;
      try {
        checkOperation(operation);
        consumed.add(operation.operation_id);
        // Capture executes wholly inside the reviewed host with all agent
        // screenshots, DOM reads, traces and clipboard access excluded.
        pair = await capturePair(operation, selection);
        if (operation.expires_at <= now()) throw ownerAppError('quickbooks_setup_operation_expired');
        await stage(binding, pair);
        return { stage: 'keys_staged', connected: false };
      } catch {
        throw ownerAppError('quickbooks_transfer_unverified');
      } finally {
        pair = null;
        // If closing/masking cannot be proved, observation stays suspended.
        // Never return provider or native-host diagnostics to the agent.
        let closed = false;
        try { closed = await closeCredentialView(operation) === true; } catch { /* remain opaque */ }
        if (!closed) throw ownerAppError('quickbooks_credential_view_unverified');
        try { await resumeObservation(operation); } catch { throw ownerAppError('quickbooks_observation_resume_failed'); }
      }
    },
  });
}
