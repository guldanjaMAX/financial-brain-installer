// Minimal real PDF bytes with a deterministic xref. No source corpus or PDF
// template is copied. All content is invented and built in memory.
export function taxPdf({ value = '420.00', fieldValue = value, widgets = 1, flattened = false, rotation = 0, blank = false, redactIdentity = false } = {}) {
  const escape = text => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const text = blank ? '' : `BT /F1 12 Tf 50 705 Td (${escape(value)}) Tj ET\nBT /F1 12 Tf 50 640 Td (Identifier: ${redactIdentity ? '[redacted]' : ['999', '88', '7777'].join('-')}) Tj ET`;
  const widgetRefs = Array.from({ length: widgets }, (_, index) => `${7 + index} 0 R`).join(' ');
  const appearance = `BT /F1 12 Tf 10 15 Td (${escape(fieldValue)}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${flattened ? '' : '/AcroForm 6 0 R'} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R ${flattened ? '' : `/Annots [${widgetRefs}]`} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    `<< /Fields [${widgetRefs}] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >>`,
    ...Array.from({ length: widgets }, () => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (amount_field) /V (${escape(fieldValue)}) /Rect [40 690 180 725] /P 3 0 R /F 4 /AP << /N ${7 + widgets} 0 R >> >>`),
    `<< /Type /XObject /Subtype /Form /BBox [0 0 140 35] /Resources << /Font << /F1 4 0 R >> >> /Length ${Buffer.byteLength(appearance)} >>\nstream\n${appearance}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
export const PDF_MAP = {
  schema_version: 'tax-pdf-map-1', version: 'fixture_pdf_map_1', form: '1040', form_revision: 'fixture_2025', tax_year: 2025,
  jurisdiction: 'US_federal', currency: 'USD', page_count: 1,
  fields: [{ line: '2b', box: null, page: 1, field_name: 'amount_field', rect: [40, 690, 180, 725],
    signed: true, format: 'us_decimal', rounding: 'exact' }],
};
