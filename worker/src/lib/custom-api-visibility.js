/** SQL shared by every document reader that can expose custom API content. */
export function currentCustomApiDocumentSql(alias = "d") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError("invalid SQL alias");
  const meta = `${alias}.meta`;
  const connector = `CASE WHEN json_valid(${meta}) THEN json_extract(${meta},'$.connector') END`;
  const logicalSourceId = `CASE WHEN json_valid(${meta}) THEN json_extract(${meta},'$.custom_api_source_id') END`;
  return ` AND (COALESCE(${connector},'')<>'custom_api' OR EXISTS (
    SELECT 1 FROM custom_api_current_jobs custom_api_current
    JOIN custom_api_document_versions custom_api_version
      ON custom_api_version.source=custom_api_current.source
     AND custom_api_version.job_id=custom_api_current.job_id
     WHERE custom_api_current.source=${alias}.source
       AND custom_api_version.logical_source_id=${logicalSourceId}
       AND custom_api_version.document_source_id=${alias}.source_id
  ))`;
}

/** Render a closed custom-source issue code only at an owner-facing boundary. */
export function customApiOwnerMessage(code, displayName = "custom business API") {
  const name = String(displayName || "custom business API").replace(/\s+/g, " ").trim().slice(0, 80) || "custom business API";
  if (code === "AUTH_REQUIRED") return `The ${name} refused the key. Ask its developer to check it.`;
  if (code === "RATE_LIMITED") return `The ${name} asked the Brain to wait. It will try again on the next scheduled pull.`;
  if (code === "REMOTE_UNAVAILABLE" || code === "NETWORK_UNREACHABLE") return `The ${name} could not be reached. The saved data was left unchanged.`;
  if (code === "RESPONSE_TOO_LARGE") return `The ${name} returned more data than this source allows. That endpoint was left unchanged. Ask its developer to add paging or narrow the endpoint.`;
  if (code === "REDIRECT_REFUSED") return `The ${name} tried to send the Brain to another address. The pull was refused before following it.`;
  if (code === "PERSISTENCE_VERIFY_FAILED") return `The Brain could not verify the saved ${name} update. The source remains marked for installer review.`;
  if (code === "CONFIG_INVALID") return `The ${name} setup is not valid. Ask the installer to review its manifest mapping.`;
  return `The ${name} returned data the Brain could not safely understand. The saved data was left unchanged.`;
}

export function customApiVersionedSourceId(sourceId, jobId) {
  return `${sourceId}:job:${jobId}`;
}

export function customApiLogicalSourceId(metadata, fallback) {
  let parsed = metadata;
  if (typeof metadata === "string") {
    try { parsed = JSON.parse(metadata); } catch { parsed = null; }
  }
  return parsed?.connector === "custom_api" && typeof parsed.custom_api_source_id === "string" && parsed.custom_api_source_id
    ? parsed.custom_api_source_id
    : fallback;
}

export function customApiPointerTableMissing(error) {
  return /no such table:\s*custom_api_(?:current_jobs|document_versions)\b/i.test(String(error?.message || error));
}
