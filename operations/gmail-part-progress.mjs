import { createHash } from "node:crypto";

const digest = content => createHash("sha256").update(String(content || "")).digest("hex");
const samePart = (a, b) => a?.source_id === b.source_id && a?.part_index === b.part_index &&
  a?.content_hash === b.content_hash;

// These receipts are private source state, never document text or removal
// authority. Bind every receipt to the current revision, split geometry and
// policy. A family-level inventory hit alone cannot prove an accepted part.
export function planGmailParts(state, { stateKey, revision, envelopes, policyFingerprint, stored, currentProof }) {
  const parts = envelopes.map((envelope, index) => ({ source_id: envelope.source_id,
    part_index: index + 1, content_hash: digest(envelope.content) }));
  const prior = state.gmail_part_progress?.[stateKey];
  const compatible = stored && prior?.version === 1 && prior.revision === revision &&
    prior.policy_fingerprint === policyFingerprint && prior.expected_parts === parts.length;
  const accepted = {};
  const confirmed = new Set(currentProof?.parts?.map(part => part.source_id) || []);
  if (compatible) for (const part of parts) {
    if (confirmed.has(part.source_id) && samePart(prior.parts?.[part.part_index], part)) accepted[part.part_index] = part;
  }
  const progress = { version: 1, revision, policy_fingerprint: policyFingerprint,
    expected_parts: parts.length, parts: accepted, database:currentProof?.database || null };
  // Invalidate only this message. Another message's accepted prefix must not
  // be erased by a revision change, altered split, or absent stored family.
  if (prior) state.gmail_part_progress[stateKey] = progress;
  return { progress, parts, accepted: Object.keys(accepted).length,
    pending: envelopes.filter((_, i) => !accepted[i + 1]) };
}

export function acceptGmailPart(state, stateKey, plan, envelope) {
  const part = plan.parts.find(part => part.source_id === envelope.source_id);
  if (!part || part.content_hash !== digest(envelope.content)) {
    throw new Error("Gmail accepted part does not match its prepared revision");
  }
  if (samePart(plan.progress.parts[part.part_index], part)) return false;
  plan.progress.parts[part.part_index] = part;
  state.gmail_part_progress ||= {};
  state.gmail_part_progress[stateKey] = plan.progress;
  return true;
}

export function clearGmailParts(state, stateKey) {
  if (!state.gmail_part_progress) return;
  delete state.gmail_part_progress[stateKey];
  if (!Object.keys(state.gmail_part_progress).length) delete state.gmail_part_progress;
}
