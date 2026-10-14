// Minimal .xlsx writer (Node built-ins only): several sheets, strings/numbers/formulas, a few styles, merges, dropdown lists.
import zlib from 'node:zlib';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8'), comp = zlib.deflateRawSync(data), nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// ---- styles (cellXfs index by name) ----
const STYLES = ['default', 'bold', 'title', 'header', 'label', 'input', 'inputNum', 'total', 'red', 'section', 'value', 'num', 'inputDate', 'note', 'inputWrap'];
export const S = Object.fromEntries(STYLES.map((n, i) => [n, i]));
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="8"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF0F3A5C"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF4B5563"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFC62828"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FF0F3A5C"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F3A5C"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF7D6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFBFC5CD"/></left><right style="thin"><color rgb="FFBFC5CD"/></right><top style="thin"><color rgb="FFBFC5CD"/></top><bottom style="thin"><color rgb="FFBFC5CD"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="${STYLES.length}">
<xf fontId="0"/>
<xf fontId="1" applyFont="1"/>
<xf fontId="2" applyFont="1"/>
<xf fontId="3" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf fontId="4" borderId="1" applyFont="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="left" vertical="center"/><protection locked="0"/></xf>
<xf fontId="0" fillId="3" borderId="1" numFmtId="164" applyFill="1" applyBorder="1" applyNumberFormat="1" applyProtection="1"><protection locked="0"/></xf>
<xf fontId="1" fillId="4" borderId="1" numFmtId="164" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
<xf fontId="5" applyFont="1"><alignment wrapText="1" vertical="top"/></xf>
<xf fontId="6" applyFont="1"/>
<xf fontId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf fontId="0" borderId="1" numFmtId="164" applyBorder="1" applyNumberFormat="1"/>
<xf fontId="0" fillId="3" borderId="1" numFmtId="165" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1" applyProtection="1"><alignment horizontal="left" vertical="center"/><protection locked="0"/></xf>
<xf fontId="7" applyFont="1"><alignment wrapText="1" vertical="top"/></xf>
<xf fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyProtection="1"><alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>
</cellXfs></styleSheet>`;

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** cell: primitive, or { v, f (formula without "="), s (style name), } */
function cellXml(c, ref) {
  if (c === null || c === undefined || c === '') return '';
  const o = typeof c === 'object' && !(c instanceof Date) ? c : { v: c };
  const st = o.s ? ` s="${S[o.s] ?? 0}"` : '';
  if (o.f) return `<c r="${ref}"${st}><f>${esc(o.f)}</f></c>`;
  const v = o.v;
  if (v === null || v === undefined || v === '') return st ? `<c r="${ref}"${st}/>` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml({ rows, widths = [], merges = [], validations = [], heights = {}, freeze = null, landscape = false }) {
  const body = rows.map((row, ri) => `<row r="${ri + 1}"${heights[ri] ? ` ht="${heights[ri]}" customHeight="1"` : ''}>${(row || []).map((c, ci) => cellXml(c, `${col(ci)}${ri + 1}`)).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const view = freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
  const mc = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const dv = validations.length ? `<dataValidations count="${validations.length}">${validations.map(v => `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${v.ref}"><formula1>"${esc(v.list.join(',').replace(/"/g, ''))}"</formula1></dataValidation>`).join('')}</dataValidations>` : '';
  // print: fit all columns on one page width
  const pr = '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
  const ps = `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>${pr}${view}${cols}<sheetData>${body}</sheetData>${mc}${dv}${ps}</worksheet>`;
}

/**
 * @param {{ name: string, rows: any[][], widths?: number[], merges?: string[], validations?: {ref: string, list: string[]}[], heights?: object, freeze?: number }[]} sheets
 * @returns {Buffer}
 */
export function writeWorkbook(sheets) {
  const n = sheets.length;
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES_XML],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ]);
}

/**
 * One plain sheet (kept for existing callers).
 * @param {any[][]} rows  cells: string | number | '' | null
 * @param {{ sheet?: string, boldRows?: number[], widths?: number[] }} opt  (row indexes 0-based)
 */
export function writeXlsx(rows, { sheet = 'Sheet1', boldRows = [], widths = [] } = {}) {
  const bold = new Set(boldRows);
  return writeWorkbook([{ name: sheet, widths, rows: rows.map((row, ri) => (row || []).map(v => (bold.has(ri) && v !== '' && v != null ? { v, s: 'bold' } : v))) }]);
}
