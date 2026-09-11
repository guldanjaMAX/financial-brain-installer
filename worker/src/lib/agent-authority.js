/**
 * Named automation profiles. A profile is one exact bundle, never an additive
 * bag of OAuth scopes. That keeps a client asking for several roles from
 * accidentally combining them into a fifth, more powerful role.
 *
 * `owner-assistant` is local-only. The installer gives it to Claude Code,
 * Claude Desktop, and Codex on the owner's computer, where the MCP runtime
 * already resolves the owner's durable admin credential. It is deliberately
 * absent from the connector profile list: a 30-day remote bearer token is not
 * the owner, even when the owner approved the connection.
 *
 * Deletion execution is intentionally absent. Break-glass may prepare a
 * bounded receipt, but only a fresh owner passkey ceremony may consume it.
 */

export const AGENT_PROFILES = Object.freeze({
  librarian: Object.freeze({
    label: "Librarian",
    capabilities: Object.freeze(["corpus:read"]),
  }),
  "structured-contributor": Object.freeze({
    label: "Structured contributor",
    capabilities: Object.freeze(["corpus:read", "curated:write"]),
  }),
  technician: Object.freeze({
    label: "Technician",
    capabilities: Object.freeze(["corpus:read", "diagnostics:read"]),
  }),
  "break-glass": Object.freeze({
    label: "Break-glass",
    capabilities: Object.freeze(["corpus:read", "diagnostics:read", "corpus:delete:preview"]),
  }),
  "owner-assistant": Object.freeze({
    label: "Owner assistant",
    capabilities: Object.freeze(["corpus:read", "curated:write", "diagnostics:read"]),
  }),
});

export const AGENT_PROFILE_NAMES = Object.freeze(Object.keys(AGENT_PROFILES));
// Keep this as an explicit remote allowlist. A future local profile must never
// become an OAuth scope merely because it was added to AGENT_PROFILES.
export const CONNECTOR_AGENT_PROFILE_NAMES = Object.freeze([
  "librarian",
  "structured-contributor",
  "technician",
  "break-glass",
]);
export const LOCAL_OWNER_AGENT_PROFILE = "owner-assistant";
export const DEFAULT_AGENT_PROFILE = "librarian";

export function normalizeAgentProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.hasOwn(AGENT_PROFILES, normalized) ? normalized : DEFAULT_AGENT_PROFILE;
}

/**
 * OAuth stores one profile token in its existing scope column. Unknown,
 * legacy, empty, or combined values all collapse to the read-only librarian.
 */
export function profileFromScope(scope) {
  const asked = String(scope || "").split(/[\s+]+/).filter(Boolean);
  const profiles = [...new Set(asked.filter((name) => CONNECTOR_AGENT_PROFILE_NAMES.includes(name)))];
  return profiles.length === 1 && asked.length === 1 ? profiles[0] : DEFAULT_AGENT_PROFILE;
}

export function profileHas(profile, capability) {
  return AGENT_PROFILES[normalizeAgentProfile(profile)].capabilities.includes(String(capability));
}

export function profileDescription(profile) {
  const normalized = normalizeAgentProfile(profile);
  return {
    name: normalized,
    label: AGENT_PROFILES[normalized].label,
    capabilities: [...AGENT_PROFILES[normalized].capabilities],
  };
}
