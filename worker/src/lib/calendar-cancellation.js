import { jsonResponse, privateNoStore } from './core.js';

// Cancellation is a metadata overlay. Keep original text, dates, identity,
// chunks and vectors byte-for-byte, including Google's ID-only tombstones.
export async function handleCalendarCancellation(env, request) {
  const reply = (body, status = 200) => privateNoStore(jsonResponse(body, status));
  const failure = (status = 503) => reply({ code: 'INGEST_FAILED',
    error: 'Calendar cancellation marking could not be confirmed. Retry the refresh.',
    help: 'https://github.com/guldanjaMAX/financial-brain-installer/blob/main/onboarding/06-runbook-top-ten-failures.md#calendar-cancellation-marking' }, status);
  let body;
  try {
    if (!request.body || Number(request.headers.get('content-length')) > 4096) return failure(400);
    const reader = request.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return failure(400); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return failure(400); }
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'source,source_id' ||
      typeof body.source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.source) ||
      typeof body.source_id !== 'string' || !/^gcal:.+:.+$/.test(body.source_id) ||
      body.source_id.length > 3000 || /[\u0000-\u001f\u007f]/.test(body.source_id)) return failure(400);
  try {
    // Batch readback and mutation share a transaction. A missing record is a
    // proved no-op; a stored non-calendar or malformed row is never certified.
    const [, readback] = await env.DB.batch([
      env.DB.prepare(`/* calendar-cancellation */ UPDATE documents
        SET meta=json_set(meta,'$.status','cancelled')
        WHERE doc_uid=?1 AND source=?2 AND source_id=?3 AND deleted_at IS NULL
          AND date_source IN ('calendar:event_start','calendar:all_day_start')
          AND json_valid(meta) AND json_type(meta)='object'`).bind(`${body.source}:${body.source_id}`, body.source, body.source_id),
      env.DB.prepare(`SELECT source,source_id,date_source,meta FROM documents
        WHERE doc_uid=?1 AND deleted_at IS NULL`).bind(`${body.source}:${body.source_id}`),
    ]);
    if (!Array.isArray(readback?.results) || readback.results.length > 1) return failure();
    const row = readback.results[0];
    if (row && (row.source !== body.source || row.source_id !== body.source_id ||
        !/^calendar:(?:event_start|all_day_start)$/.test(row.date_source) || JSON.parse(row.meta).status !== 'cancelled')) return failure();
    return reply({ ...body, action: row ? 'kept_cancelled' : 'not_stored', verified: true });
  } catch { return failure(); }
}

export function calendarCancellationPresentation(row, metadata = row.authority_meta ?? row._authority_meta ?? row.meta) {
  let meta = metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { return {}; } }
  if (!/^calendar:(?:event_start|all_day_start)$/.test(row.date_source || '') || !meta || typeof meta !== 'object') return {};
  if (meta.status === 'cancelled') {
    return { calendar_status: 'cancelled', title: /^\[Cancelled\] /.test(row.title || '')
      ? row.title : `[Cancelled] ${row.title || 'Calendar event'}` };
  }
  // A full read can follow a retrieval made before provider reactivation.
  // Clear only our presentation label, never an original source title.
  if (['confirmed', 'tentative'].includes(meta.status)) return { calendar_status: meta.status,
    ...(row.calendar_status === 'cancelled' ? { title: String(row.title || '').replace(/^\[Cancelled\] /, '') } : {}) };
  return {};
}
