// Minimal dependency-free PDF writer: A4 pages, embedded TrueType (regular + bold, see scripts/make-pdf-font.py), text, lines, rectangles.
// Coordinates are in points from the TOP-LEFT of the page (converted internally).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { GLYPHS, FONT_META } from './pdf-metrics.js';

const FONT_FILES = { regular: new URL('./fonts/pdf-regular.ttf', import.meta.url), bold: new URL('./fonts/pdf-bold.ttf', import.meta.url) };
let fontCache = null;
const fontData = () => fontCache ||= { regular: readFileSync(FONT_FILES.regular), bold: readFileSync(FONT_FILES.bold) };

export const A4 = { w: 595.28, h: 841.89 };

const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
/** Unicode string → WinAnsi bytes (anything else becomes "?"). */
export function toBytes(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (ch === '\t') out.push(32);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (CP1252[ch]) out.push(CP1252[ch]);
    else out.push(63);
  }
  return out;
}

const FALLBACK = { '\u00a0': 32, '\u2009': 32, '\u200b': null, '\u2011': 45, '\u2010': 45, '\u2012': 0x2013, '\u2212': 45 };
/** Unicode string → glyph ids of the embedded font (unknown characters become "?"). */
export function toGids(str, bold = false) {
  const g = GLYPHS[bold ? 'bold' : 'regular'], out = [];
  for (const ch of String(str ?? '')) {
    let c = ch.codePointAt(0);
    if (ch === '\t') c = 32;
    if (c in FALLBACK) { if (FALLBACK[c] === null) continue; c = FALLBACK[c]; }
    if (c < 32 || (c >= 127 && c < 160)) continue;
    out.push(g.cmap[c] ?? g.cmap[63]);
  }
  return out;
}

/** Text width in points. */
export function textWidth(str, size, bold = false) {
  const w = GLYPHS[bold ? 'bold' : 'regular'].w;
  return toGids(str, bold).reduce((a, id) => a + (w[id] ?? 556), 0) * size / 1000;
}

/** Wrap text to a width (honours \n, breaks over-long words). */
export function wrap(str, width, size, bold = false) {
  const lines = [];
  for (const para of String(str ?? '').replace(/\r/g, '').split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (textWidth(w, size, bold) > width) { // very long word: split by characters
        let i = w.length;
        while (i > 1 && textWidth(w.slice(0, i), size, bold) > width) i--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, i)); w = w.slice(i);
      }
      const trial = cur ? `${cur} ${w}` : w;
      if (textWidth(trial, size, bold) <= width) cur = trial; else { if (cur) lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}

const num = n => (Math.round(n * 100) / 100).toString();
const rgb = c => (c || [0, 0, 0]).map(v => num(v / 255)).join(' ');
const hexGids = (str, bold) => toGids(str, bold).map(g => g.toString(16).padStart(4, '0')).join('');
const esc = bytes => Buffer.from(bytes).toString('latin1').replace(/([\\()])/g, '\\$1');

export class Pdf {
  constructor({ landscape = false } = {}) { this.w = landscape ? A4.h : A4.w; this.h = landscape ? A4.w : A4.h; this.pages = []; this.addPage(); }
  addPage() { this.pages.push([]); return this.pages.length; }
  get cur() { return this.pages[this.pages.length - 1]; }
  /** One line of text; x is left (or right edge with align:'right', centre with 'center'). */
  text(str, x, y, { size = 10, bold = false, color = [30, 36, 45], align = 'left' } = {}) {
    const w = textWidth(str, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(this.h - y - size * 0.8)} Td <${hexGids(str, bold)}> Tj ET`);
    return w;
  }
  line(x1, y1, x2, y2, { width = 0.6, color = [200, 205, 212] } = {}) {
    this.cur.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.6 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.cur.push(`${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}${num(width)} w ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re ${op}`);
  }
  toBuffer(info = {}) {
    const objs = []; // index = object number - 1
    const add = body => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const fontObjs = {};
    for (const [key, name] of [['regular', 'LumiSans'], ['bold', 'LumiSans-Bold']]) {
      const data = fontData()[key], m = FONT_META[key];
      const file = add({ stream: deflateSync(data), dict: `/Filter /FlateDecode /Length1 ${data.length}` });
      const desc = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${m.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${m.ascent} /Descent ${m.descent} /CapHeight ${m.cap} /StemV ${key === 'bold' ? 140 : 80} /FontFile2 ${file} 0 R >>`);
      const g = GLYPHS[key];
      const ids = Object.keys(g.w).map(Number).sort((a, b) => a - b);
      const wArr = ids.map(id => `${id} [${g.w[id]}]`).join(' ');
      const pairs = Object.entries(g.cmap).map(([u, id]) => [id, +u]).filter(([, u]) => u >= 32).sort((a, b) => a[0] - b[0]);
      const seen = new Set(), uniq = pairs.filter(([id]) => !seen.has(id) && seen.add(id));
      const hex4 = n => n.toString(16).padStart(4, '0');
      let tu = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
      for (let i = 0; i < uniq.length; i += 100) { const ch = uniq.slice(i, i + 100); tu += `${ch.length} beginbfchar\n${ch.map(([id, u]) => `<${hex4(id)}> <${hex4(u)}>`).join('\n')}\nendbfchar\n`; }
      tu += 'endcmap CMapName currentdict /CMap defineresource pop end end';
      const toUni = add({ stream: Buffer.from(tu, 'latin1') });
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 556 /W [${wArr}] /CIDToGIDMap /Identity >>`);
      fontObjs[key] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`);
    }
    const f1 = fontObjs.regular, f2 = fontObjs.bold;
    const kids = [];
    for (const ops of this.pages) {
      const stream = Buffer.from(ops.join('\n'), 'latin1');
      const content = add({ stream });
      const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(this.w)} ${num(this.h)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
      kids.push(`${page} 0 R`);
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
    const infoObj = add(`<< /Title (${esc(toBytes(info.title || ''))}) /Producer (Lumi Trade) /Creator (Lumi Trade) >>`);
    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let pos = parts[0].length;
    objs.forEach((o, i) => {
      offsets.push(pos);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const body = typeof o === 'string' ? Buffer.from(o + '\n', 'latin1')
        : Buffer.concat([Buffer.from(`<< /Length ${o.stream.length} ${o.dict || ''} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\n', 'latin1')]);
      const tail = Buffer.from('endobj\n', 'latin1');
      const b = Buffer.concat([head, body, tail]);
      parts.push(b); pos += b.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}
