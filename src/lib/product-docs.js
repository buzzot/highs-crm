// Product documents (spec sheets, datasheets, catalogue pages, drawings, certificates) — pure helpers, no database.
// They are stored like every other attachment (table `documents`, bucket "documents"), linked to the product, and are INTERNAL:
// client_visible is false, so a supplier datasheet never reaches a client portal by itself.
export const DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'dwg', 'dxf'];
export const DOC_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_MAX_FILES = 10;
export const extOf = name => (String(name || '').split('.').pop() || '').toLowerCase();
export const isDocFile = name => DOC_EXT.includes(extOf(name));
export const DOC_KINDS = [['other', 'Document'], ['certificate', 'Certificate']];
/** The stored document kind for the "save as" choice (anything unknown is a plain document). */
export const docKindFor = v => (v === 'certificate' ? 'certificate' : 'other');
const LABELS = { pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', csv: 'CSV', txt: 'Text', dwg: 'Drawing', dxf: 'Drawing', png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image' };
/** "PDF", "Excel", "Certificate"… for a stored document row. */
export function docTypeLabel(d) {
  if (d.kind === 'certificate') return 'Certificate';
  const e = extOf(d.title) || extOf(d.storage_path);
  return LABELS[e] || (String(d.mime_type || '').startsWith('image/') ? 'Image' : 'File');
}
/** Files the AI can read: PDFs and images. */
export const aiReadable = d => /\.pdf$/i.test(d.title || '') || /pdf$/i.test(d.mime_type || '') || /^image\/(png|jpe?g|gif|webp)$/i.test(d.mime_type || '');
export function fmtSize(n) { n = Number(n); if (!(n > 0)) return ''; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
