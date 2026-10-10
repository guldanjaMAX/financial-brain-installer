import { getDocumentProxy } from 'unpdf';
import { financialHash, canonicalFinancialJson } from '../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromDecimal } from '../worker/src/lib/financial-money.js';

const SOURCES = new Set(['native', 'ocr', 'ocr_partial', 'unknown']);
const FORMS = new Set(['1040', 'Schedule-1', 'Schedule-2', 'Schedule-3', 'Schedule-A', 'Schedule-B', 'Schedule-C', 'Schedule-D',
  'Schedule-E', 'Schedule-SE', '8995', '8995-A', '4562', '8829', '8889', '8606', '1120-S', '1065', '1120', 'W-2',
  '1099-NEC', '1099-MISC', '1099-INT', '1099-DIV', '1099-B', '1099-K', '1099-R', '1098', '5498', '5498-SA', '1065-K1', '1120-S-K1']);
const rectValid = rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) &&
  rect.every(n => n >= 0) && rect[2] > rect[0] && rect[3] > rect[1];
const inside = (small, big) => small[0] >= big[0] && small[1] >= big[1] && small[2] <= big[2] && small[3] <= big[3];
const eq = (a, b) => canonicalFinancialJson(a) === canonicalFinancialJson(b);
function parseAmount(raw, field) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  let text = raw.trim();
  if (/^\(.*\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  if (!field.signed && text.startsWith('-')) return null;
  try {
    const value = moneyFromDecimal(text.replaceAll(',', ''), 'USD');
    if (field.rounding === 'whole_dollar_half_away_from_zero' && BigInt(value.amount_minor) % 100n !== 0n) return null;
    return value;
  } catch { return null; }
}
function validMap(map) {
  return map?.schema_version === 'tax-pdf-map-1' && typeof map.version === 'string' && /^[a-z0-9_-]{1,80}$/.test(map.version) && FORMS.has(map.form) &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(map.form_revision) && Number.isSafeInteger(map.tax_year) && map.tax_year >= 1900 && map.tax_year <= 9999 &&
    map.jurisdiction === 'US_federal' && map.currency === 'USD' && Number.isSafeInteger(map.page_count) && map.page_count > 0 && map.page_count <= 100 &&
    Array.isArray(map.fields) && map.fields.length > 0 && map.fields.length <= 200 &&
    map.fields.every(f => f && typeof f === 'object') &&
    new Set(map.fields.map(f => `${f.page}:${f.line}`)).size === map.fields.length && map.fields.every(f =>
      Number.isSafeInteger(f.page) && f.page > 0 && f.page <= map.page_count && rectValid(f.rect) &&
      /^(?:box)?[0-9]{1,3}[a-z]?$|^reviewed_schedule$|^carryforward_workpaper$/.test(f.line) &&
      (f.box === null || /^(?:box)?[0-9]{1,3}[a-zA-Z]?$/.test(f.box)) &&
      typeof f.field_name === 'string' && f.field_name.length > 0 && f.field_name.length <= 256 &&
      typeof f.signed === 'boolean' && f.format === 'us_decimal' && ['exact', 'whole_dollar_half_away_from_zero'].includes(f.rounding));
}

// Local byte parser only. A reviewed exact template map identifies candidate
// rectangles, not the filer or operative return. The server establishes those.
// Even matching AcroForm/text values cannot prove the appearance is current,
// so this first release requires visual owner confirmation for every value.
// No OCR, rendering, external resource fetch or source text leaves this module.
export async function extractTaxPdf({ bytes, formMap, textSource = 'unknown' } = {}, { openPdf = getDocumentProxy } = {}) {
  const result = { schema_version: 'tax-pdf-candidates-1', status: 'not_checked', reason: 'invalid_input',
    trace: ['input'], document_hash: null, mapping_hash: null, text_source: SOURCES.has(textSource) ? textSource : 'unknown',
    text_reliable: false, fields: [] };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024 || !validMap(formMap)) return result;
  const raw = new Uint8Array(bytes), map = structuredClone(formMap);
  result.document_hash = await financialHash(raw);
  result.mapping_hash = await financialHash(canonicalFinancialJson(map));
  result.trace.push('parse');
  let pdf;
  try {
    pdf = await openPdf(raw, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
      useWorkerFetch: false, disableAutoFetch: true, disableStream: true, verbosity: 0,
      standardFontDataUrl: undefined, cMapUrl: undefined, wasmUrl: undefined });
    if (pdf.numPages !== map.page_count || pdf.isPureXfa) { result.reason = 'page_inventory_or_xfa_unsupported'; return result; }
    result.trace.push('fields');
    const pages = new Map();
    for (const field of map.fields) {
      const candidate = { form: map.form, form_revision: map.form_revision, tax_year: map.tax_year, jurisdiction: map.jurisdiction,
        page: field.page, line: field.line, box: field.box, rect: [...field.rect], rounding: field.rounding,
        state: 'unreadable', confidence: 'unreadable_or_conflicting', authoritative: false, value: null, candidate_hash: null };
      if (!pages.has(field.page)) {
        const page = await pdf.getPage(field.page);
        pages.set(field.page, { page, annotations: await page.getAnnotations({ intent: 'display' }),
          content: await page.getTextContent({ disableNormalization: true }) });
      }
      const { page, annotations, content } = pages.get(field.page);
      const widgets = annotations.filter(a => a.subtype === 'Widget' && a.fieldName === field.field_name);
      const tokens = content.items.filter(item => typeof item.str === 'string' && item.str.trim() &&
        item.transform?.[1] === 0 && item.transform?.[2] === 0 &&
        inside([item.transform[4], item.transform[5], item.transform[4] + item.width, item.transform[5] + item.height], field.rect));
      if (page.rotate !== 0 || !inside(field.rect, page.view)) candidate.state = 'unreadable';
      else if (widgets.length > 1 || tokens.length > 1) candidate.state = 'conflicting';
      else if (widgets.length === 1) {
        const widget = widgets[0];
        if (widget.fieldType !== 'Tx' || !eq(widget.rect, field.rect) || widget.hidden || widget.invisible || widget.noView) candidate.state = 'conflicting';
        else if (widget.fieldValue === '' && tokens.length === 0) candidate.state = 'blank';
        else {
          const value = parseAmount(widget.fieldValue, field), textValue = tokens.length ? parseAmount(tokens[0].str, field) : null;
          if (!value) candidate.state = 'unreadable';
          else if (tokens.length && (!textValue || textValue.amount_minor !== value.amount_minor)) candidate.state = 'conflicting';
          else { candidate.state = 'candidate'; candidate.value = value; candidate.confidence = 'native_field_candidate'; }
        }
      } else if (tokens.length === 0) candidate.state = 'blank';
      else {
        candidate.value = parseAmount(tokens[0].str, field);
        if (candidate.value) { candidate.state = 'candidate'; candidate.confidence = 'native_text_candidate'; }
      }
      if (candidate.state === 'candidate' && result.text_source !== 'native') candidate.confidence = 'candidate_only';
      // No field names, arbitrary labels, raw PDF text or identifier boxes are
      // projected. Hashes bind the source/map/locator and exact proposed money.
      candidate.candidate_hash = await financialHash(canonicalFinancialJson({ document_hash: result.document_hash,
        mapping_hash: result.mapping_hash, text_source: result.text_source, candidate }));
      result.fields.push(candidate);
    }
    result.status = 'needs_review'; result.reason = 'owner_confirmation_required';
    return result;
  } catch {
    result.fields = []; result.reason = 'pdf_unreadable'; return result;
  } finally {
    if (pdf) { try { await pdf.destroy(); } catch { /* Parser cleanup has no authority. */ } }
  }
}
