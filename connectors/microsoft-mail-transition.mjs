/** A digest cutover is a time boundary, never an inferred message identity. */
export function normalizeMailStartAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("corpora.microsoft.mail_start_at must be null or an exact UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ) at the start of unexported mail; verify export coverage first");
  }
  return value;
}

export function mailReceivedAt(value) {
  const match = typeof value === "string" && value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  const civil = match && Date.parse(`${match[1]}Z`);
  if (!match || !Number.isFinite(civil) || new Date(civil).toISOString().slice(0, 19) !== match[1] ||
      Number(match[3] || 0) > 23 || Number(match[4] || 0) > 59 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Outlook mail has missing or invalid receivedDateTime; the mail cutover cannot be proved and no cursor may advance");
  }
  // The configured boundary has millisecond precision. Truncating finer Graph
  // fractions cannot move a message across an inclusive millisecond boundary.
  return Date.parse(value);
}

export function microsoftMailTransition(manifest) {
  const config = manifest?.corpora?.microsoft;
  if (config?.enabled !== true) return null;
  const start = normalizeMailStartAt(config.mail_start_at);
  return start === null ? null : {
    source: config.source || "microsoft",
    mail_start_at: start,
    boundary: "inclusive",
    mail_history: "retained",
  };
}

export function microsoftMailTransitionSummary(transition) {
  return `Outlook mail is set to start at ${transition.mail_start_at} (inclusive); earlier exported mail stays available with its existing citations.`;
}
