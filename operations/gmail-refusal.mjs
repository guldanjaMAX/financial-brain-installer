// Gmail bodies are immutable. Keep only identity and the scanner/policy binding,
// so later label history does not download the same refused content again.
export const GMAIL_REFUSAL_CODE = "GMAIL_MESSAGES_REFUSED";
export function recordGmailRefusal(state, key, policyFingerprint) {
  state.gmail_refusals ||= {};
  state.gmail_refusals[key] = { version: 1, reason_code: "credential_detected", policy_fingerprint: policyFingerprint };
  state.skipped[key] = "Gmail credential safety check refused this message";
}
export function hasGmailRefusal(state, key, policyFingerprint) {
  const receipt = state.gmail_refusals?.[key];
  return receipt?.version === 1 && receipt.reason_code === "credential_detected" &&
    receipt.policy_fingerprint === policyFingerprint;
}
export function gmailRefusalOwnerLine(count, current) {
  return `${count} ${count === 1 ? "email was skipped because it looked like it held" : "emails were skipped because they looked like they held"} a password or sign-in link; ` +
    (current ? "everything else is up to date. " : "other work is still pending. ") +
    `${GMAIL_REFUSAL_CODE} https://financialbrain.ai/help/${GMAIL_REFUSAL_CODE}`;
}
