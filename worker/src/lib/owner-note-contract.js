/** Fixed identity and public provenance for conversational owner notes. */

export const OWNER_NOTES_SOURCE = "owner-notes";
export const OWNER_NOTES_KIND = "owner-notes";
export const OWNER_NOTES_ROUTE = "/api/admin/brain/owner-notes";

const CHANNELS = Object.freeze({
  local_mcp: Object.freeze({
    written_by: "owner_assistant",
    agent_profile: "owner-assistant",
    label: "Owner assistant on this computer",
  }),
  remote_mcp: Object.freeze({
    written_by: "connector",
    agent_profile: "structured-contributor",
    label: "Approved remote Brain connector",
  }),
});

export function ownerNoteWriteProvenance(channel) {
  const fixed = CHANNELS[String(channel || "")];
  if (!fixed) return null;
  return {
    written_by: fixed.written_by,
    agent_profile: fixed.agent_profile,
    recorded_via: String(channel),
  };
}
function parsedMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Return only the closed, non-content provenance contract. */
export function publicOwnerNoteProvenance(source, metadata) {
  if (String(source || "") !== OWNER_NOTES_SOURCE) return null;
  const value = parsedMetadata(metadata);
  const channel = String(value?.recorded_via || "");
  const fixed = CHANNELS[channel];
  if (!fixed || value?.written_by !== fixed.written_by ||
      value?.agent_profile !== fixed.agent_profile) return null;
  return {
    type: "conversational_owner_note",
    channel,
    actor: fixed.written_by,
    agent_profile: fixed.agent_profile,
    label: fixed.label,
  };
}
