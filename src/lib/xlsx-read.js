// Minimal, dependency-free .xlsx reader (Node built-ins only).
// Reads cell values from every sheet plus the pictures placed on them:
//   • normal floating pictures (Insert → Pictures)               → xl/drawings/*
//   • WPS "embed in cell" pictures  (=DISPIMG("ID_…",1))          → xl/cellimages.xml
//   • Excel 365 "Place in cell" pictures (cell vm="n")            → xl/richData/*
import zlib from 'node:zlib';
import path from 'node:path';

// ---------------- zip ----------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (zip directory not found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    files.set(name.replace(/\\/g, '/'), { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  const cache = new Map();
  const get = name => {
    name = name.replace(/^\//, '');
    if (cache.has(name)) return cache.get(name);
    let e = files.get(name);
    if (!e) { const k = [...files.keys()].find(f => f.toLowerCase() === name.toLowerCase()); e = k && files.get(k); }
    if (!e) return null;
    const lp = e.local;
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.slice(start, start + e.csize);
    const out = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null;
    cache.set(name, out);
    return out;
  };
  return { get, text: n => get(n)?.toString('utf8') ?? null, names: [...files.keys()] };
}

// ---------------- xml helpers ----------------
const ent = s => String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const l = e.toLowerCase();
  if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
  if (l === 'quot') return '"'; if (l === 'apos') return "'";
  return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
});
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`));
  return m ? ent(m[1]) : null;
};
const texts = xml => [...xml.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
  .map(m => ent(m[1])).join('');

function rels(z, part) {
  const dir = path.posix.dirname(part);
  const xml = z.text(`${dir}/_rels/${path.posix.basename(part)}.rels`);
  const map = {};
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target'), type = attr(m[0], 'Type') || '';
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue;
    map[id] = { type, path: target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${dir}/${target}`) };
  }
  return map;
}

const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const media = (z, p) => { const data = z.get(p); return data ? { data, ext: (path.posix.extname(p).slice(1) || 'png').toLowerCase() } : null; };

/**
 * @returns {{ sheets: { name: string, rows: any[][], images: { row: number, col: number, data: Buffer, ext: string }[] }[] }}
 *   rows/cols are 0-based; rows[r][c] is a string, number or boolean (or undefined for empty).
 */
export function readXlsx(buffer) {
  const z = unzip(buffer);
  const wbXml = z.text('xl/workbook.xml');
  if (!wbXml) throw new Error('Not an .xlsx workbook. (Old .xls files: open and "Save as" .xlsx first.)');
  const wbRels = rels(z, 'xl/workbook.xml');

  const sst = [];
  const sstXml = z.text('xl/sharedStrings.xml');
  if (sstXml) for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) sst.push(texts(m[1]));

  // WPS cell images: name → media
  const wpsImages = {};
  const ciXml = z.text('xl/cellimages.xml');
  if (ciXml) {
    const ciRels = rels(z, 'xl/cellimages.xml');
    for (const m of ciXml.matchAll(/<(?:\w+:)?cellImage\b[\s\S]*?<\/(?:\w+:)?cellImage>/g)) {
      const name = (m[0].match(/<(?:\w+:)?cNvPr\b[^>]*\bname="([^"]+)"/) || [])[1];
      const rid = (m[0].match(/<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/) || [])[1];
      if (name && rid && ciRels[rid]) wpsImages[name] = ciRels[rid].path;
    }
  }

  // Excel 365 in-cell pictures: value-metadata index (vm, 1-based) → media
  const richImages = [];
  const rvXml = z.text('xl/richData/rdrichvalue.xml');
  const relXml = z.text('xl/richData/richValueRel.xml');
  if (rvXml && relXml) {
    const relRels = rels(z, 'xl/richData/richValueRel.xml');
    const relIds = [...relXml.matchAll(/<rel\b[^>]*\br:id="([^"]+)"/g)].map(m => m[1]);
    for (const m of rvXml.matchAll(/<rv\b[^>]*>([\s\S]*?)<\/rv>/g)) {
      const first = (m[1].match(/<v(?:\s[^>]*)?>([^<]*)<\/v>/) || [])[1];
      const rid = relIds[Number(first)];
      richImages.push(rid && relRels[rid] ? relRels[rid].path : null);
    }
  }

  const sheets = [];
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'id');
    const target = wbRels[rid]?.path;
    const xml = target && z.text(target);
    if (!xml) continue;
    const rows = [];
    const images = [];
    const defHt = Number((xml.match(/<sheetFormatPr\b[^>]*\bdefaultRowHeight="([\d.]+)"/) || [])[1] || 15);
    const rowHt = {};
    for (const rm of xml.matchAll(/<row\b[^>]*>/g)) { const rn = attr(rm[0], 'r'), ht = attr(rm[0], 'ht'); if (rn && ht) rowHt[Number(rn) - 1] = Number(ht); }
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = c[1], inner = c[2] || '';
      const ref = attr(a, 'r');
      if (!ref) continue;
      const r = parseInt(ref.replace(/[A-Z]+/i, ''), 10) - 1, col = colIndex(ref);
      const t = attr(a, 't');
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const f = (inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/) || [])[1];
      let val;
      if (t === 's') val = v != null ? sst[Number(v)] : undefined;
      else if (t === 'inlineStr') val = texts(inner);
      else if (t === 'b') val = v === '1';
      else if (t === 'str' || t === 'e') val = v != null ? ent(v) : undefined;
      else if (v != null && v !== '') val = Number(v);
      const disp = f && ent(f).match(/DISPIMG\(\s*"([^"]+)"/i);
      if (disp && wpsImages[disp[1]]) { const md = media(z, wpsImages[disp[1]]); if (md) images.push({ row: r, col, ...md }); val = undefined; }
      const vm = attr(a, 'vm');
      if (vm && richImages[Number(vm) - 1]) { const md = media(z, richImages[Number(vm) - 1]); if (md) images.push({ row: r, col, ...md }); if (t === 'e') val = undefined; }
      if (val === undefined || val === '') continue;
      (rows[r] ||= [])[col] = typeof val === 'string' ? val.trim() : val;
    }
    // floating pictures on the sheet's drawing
    const sRels = rels(z, target);
    for (const rel of Object.values(sRels)) {
      if (!/\/drawing$/.test(rel.type)) continue;
      const dXml = z.text(rel.path);
      if (!dXml) continue;
      const dRels = rels(z, rel.path);
      for (const an of dXml.matchAll(/<(?:\w+:)?(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g)) {
        const from = (an[0].match(/<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/) || [])[1] || '';
        const col = Number((from.match(/<(?:\w+:)?col>(\d+)</) || [])[1]);
        const row = Number((from.match(/<(?:\w+:)?row>(\d+)</) || [])[1]);
        const rid = (an[0].match(/<(?:\w+:)?blip\b[^>]*\br:embed="([^"]+)"/) || [])[1];
        if (!rid || !dRels[rid] || !Number.isFinite(row)) continue;
        // a picture whose top edge sits in the bottom part of a row really belongs to the next row
        const rowOff = Number((from.match(/<(?:\w+:)?rowOff>(\d+)</) || [])[1] || 0);
        const htEmu = (rowHt[row] || defHt) * 12700;
        const md = media(z, dRels[rid].path);
        if (md) images.push({ row: rowOff > htEmu * 0.6 ? row + 1 : row, col: Number.isFinite(col) ? col : 0, ...md });
      }
    }
    sheets.push({ name, rows, images });
  }
  return { sheets };
}

/** Plain-text dump of a workbook for the AI (first N rows/cols of each sheet, tab-separated). */
export function workbookToText(wb, { maxRows = 400, maxCols = 30 } = {}) {
  return wb.sheets.map(s => {
    const lines = [];
    for (let r = 0; r < Math.min(s.rows.length, maxRows); r++) {
      const row = s.rows[r];
      if (!row || !row.some(v => v !== undefined && v !== '')) continue;
      lines.push(`${r + 1}\t` + Array.from({ length: Math.min(row.length, maxCols) }, (_, c) => (row[c] ?? '')).join('\t'));
    }
    const pics = s.images.length ? `\n(${s.images.length} pictures on this sheet, at rows: ${[...new Set(s.images.map(i => i.row + 1))].join(', ')})` : '';
    return `### Sheet "${s.name}" (row number, then cells)\n${lines.join('\n')}${pics}`;
  }).join('\n\n');
}
