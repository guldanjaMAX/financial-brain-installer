import { renderCliCommands } from "../operations/cli-guidance.mjs";

/** Inject a complete, fresh inventory of { name, kind, family_count } rows.
 * Counts represent stored families, not a cached document or freshness count.
 * The caller owns inventory I/O and connect serialization; this never removes.
 */
export async function assertSingleQuickBooksSource({ targetSource, listQuickBooksSources }) {
  if (typeof targetSource !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(targetSource)) {
    throw new TypeError("QuickBooks target source is required");
  }
  if (typeof listQuickBooksSources !== "function") throw new TypeError("QuickBooks source inventory is required");
  const sources = await listQuickBooksSources();
  if (!Array.isArray(sources)) throw new TypeError("QuickBooks source inventory is incomplete");
  for (const source of sources) {
    if (!source || typeof source.kind !== "string" || typeof source.name !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.name)) {
      throw new TypeError("QuickBooks source inventory is invalid");
    }
    if (source.kind !== "quickbooks") continue;
    if (!Number.isSafeInteger(source.family_count) || source.family_count < 0) {
      throw new TypeError("QuickBooks stored-family inventory is incomplete");
    }
    if (source.name !== targetSource && source.family_count > 0) {
      const error = new Error(renderCliCommands(
        "Another QuickBooks source still holds stored families. Preview the reviewed removal with " +
        "brain forget <manifest> --source <old-source>, review and confirm that exact scope, then retry the connection.",
      ));
      error.code = "quickbooks_other_edition_present";
      throw error;
    }
  }
}
