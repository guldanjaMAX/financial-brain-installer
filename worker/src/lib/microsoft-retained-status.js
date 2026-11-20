/** Attach current provider state without replacing retained source evidence. */
import { scopeIsUnrestricted } from "./grants.js";

const STATES = new Set(["active", "cancelled", "removed_from_view", "unavailable"]);
export function microsoftStatusNotice(status) {
  if (!STATES.has(status) || status === "active") return "";
  const detail = status === "cancelled" ? "Cancelled in Outlook. The retained time is historical; this meeting is not upcoming."
    : status === "removed_from_view" ? "Deleted or moved out of the provider view; deletion is not confirmed. Retained calendar times are historical. Current location or schedule is unknown."
    : "Current provider status was not verified for this read. Retained times are historical evidence, not proof of an upcoming meeting.";
  return `[Microsoft provider status: ${status}] ${detail}`;
}
// Idempotent: retrieval already overlays the stored text, and a reading that
// falls back to that retrieved excerpt must not repeat the notice.
export function withMicrosoftStatusText(text, status) {
  const notice = microsoftStatusNotice(status);
  const value = String(text || "");
  return notice && !value.startsWith(notice) ? `${notice}\n${value}` : value;
}
export function microsoftEvidenceStatus(row) {
  if (STATES.has(row?.microsoft_provider_status)) return row.microsoft_provider_status;
  return /\[Microsoft provider status: (cancelled|removed_from_view|unavailable)\]/.exec(String(row?.snippet || row?.text || ""))?.[1] || null;
}

// Read only closed status values for exact already-authorized source records.
// Scoped principals get a non-disclosing caution, never a sibling-document read.
// Missing/changed originals or failed status reads keep the text and mark the
// status unverified; an optional annotation can never turn into an answer error.
export async function attachMicrosoftRetainedStatus(env, rows, { access = null, scope = null } = {}) {
  const targets = rows.filter(row => row.source_kind === "microsoft" && /^outlook:(?:event|message):/.test(row.source_id || ""));
  if (!targets.length) return rows;
  const statusById = new Map(targets.map(row => [row.doc_uid, "unavailable"]));
  if (access?.kind !== "grant" && scopeIsUnrestricted(scope)) {
    const byId = new Map(targets.map(row => [row.doc_uid, row]));
    const ids = [...byId.keys()];
    for (let offset = 0; offset < ids.length; offset += 80) {
      const batch = ids.slice(offset, offset + 80);
      try {
        const response = await env.DB.prepare(`/* microsoft-retained-status */
          SELECT original.doc_uid, original.content_hash,
            CASE WHEN status.doc_uid IS NOT NULL THEN
              CASE WHEN json_valid(status.meta) AND json_extract(status.meta, '$.retained_source_id')=original.source_id
                AND json_extract(status.meta, '$.workload')='retained_status'
                THEN json_extract(status.meta, '$.microsoft_status') END
              ELSE CASE WHEN json_valid(original.meta) AND json_extract(original.meta, '$.status')='cancelled'
                THEN 'cancelled' ELSE 'active' END END AS provider_status
          FROM documents original LEFT JOIN documents status
            ON status.doc_uid=original.source || ':status:' || original.source_id
            AND status.source=original.source AND status.deleted_at IS NULL
          WHERE original.doc_uid IN (${batch.map((_, index) => `?${index + 1}`).join(",")})
            AND original.deleted_at IS NULL`).bind(...batch).all();
        for (const row of response.results || []) {
          if (byId.get(row.doc_uid)?.content_hash === row.content_hash && STATES.has(row.provider_status)) {
            statusById.set(row.doc_uid, row.provider_status);
          }
        }
      } catch { /* source text remains answerable with explicit status uncertainty */ }
    }
  }
  return rows.map(row => statusById.has(row.doc_uid) ? {
    ...row, microsoft_provider_status: statusById.get(row.doc_uid),
    text: withMicrosoftStatusText(row.text, statusById.get(row.doc_uid)),
  } : row);
}
