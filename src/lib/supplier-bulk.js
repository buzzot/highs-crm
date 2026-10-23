// Supplier bulk upload: read the "Factory quotation" workbook (header terms + one row per product, photos in the Photo column)
// and turn every row into the same shape the "Add product" wizard stores (see supplier-product.js).
import { readXlsx } from './xlsx-read.js';
import { clean, missing } from './supplier-product.js';

export const MAX_PRODUCTS = 200;
export const MAX_PHOTOS = 10;

// header (first line, lower-case) → wizard field
const COLUMNS = {
  'item no. / sku': 'sku', 'item no': 'sku', 'sku': 'sku',
  'product name *': 'name', 'product name': 'name',
  'category': 'category', 'subcategory': 'subcategory', 'description': 'description', 'materials': 'materials',
  'product size l×w×h (cm)': 'size', 'product size': 'size',
  'unit net weight (kg)': 'unit_weight_kg', 'packaging type': 'packaging_type', 'hs code': 'hs_code',
  'contains battery / magnet / liquid': 'battery',
  'unit price': 'unit_price', 'moq (units)': 'moq', 'production lead time (days)': 'lead_days',
  'units per master carton': 'carton_qty', 'carton length (cm)': 'carton_l', 'carton width (cm)': 'carton_w', 'carton height (cm)': 'carton_h',
  'carton net weight (kg)': 'net_kg', 'carton gross weight (kg)': 'gross_kg', 'qty per 40hq (units)': 'u40hq',
  'factory notes': 'factory_notes', 'certifications': 'certifications', 'photo link': 'photo_link', 'inner pack': 'inner_pack',
};
// labels printed above the table → field (value sits in the cell to the right)
const TERMS = {
  'currency': 'currency', 'incoterm': 'incoterm', 'fob port / delivery point': 'fob_port', 'payment terms': 'payment_terms',
  'quote valid until': 'valid_until', 'country of origin': 'origin', 'sample lead time (days)': 'sample_days',
};
const first = s => String(s ?? '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim().toLowerCase();
const text = v => (v == null ? '' : String(v).trim());

/** Excel serial date → yyyy-mm-dd; anything else is kept as typed. */
function dateText(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  return text(v);
}

/**
 * @param {Buffer} buffer the uploaded .xlsx
 * @returns {{ terms: object, rows: { row: number, data: object, images: {data:Buffer, ext:string}[], problems: string[] }[], skipped: number }}
 */
export function parseQuotation(buffer) {
  const wb = readXlsx(buffer);
  const sheet = wb.sheets.find(s => s.rows.slice(0, 30).some(r => (r || []).some(c => first(c) === 'product name *' || first(c) === 'product name'))) ;
  if (!sheet) throw new Error('We could not find the product table. Please use the Lumi Trade template (download it on this page) and keep its header rows.');
  const h = sheet.rows.findIndex(r => (r || []).some(c => ['product name *', 'product name'].includes(first(c))));
  const cols = {};
  (sheet.rows[h] || []).forEach((c, i) => { const f = COLUMNS[first(c)]; if (f && !(f in cols)) cols[f] = i; });
  const photoCol = (sheet.rows[h] || []).findIndex(c => first(c) === 'photo');

  const terms = {};
  for (const row of sheet.rows.slice(0, h)) (row || []).forEach((c, i) => {
    const f = TERMS[first(c)];
    if (f && !(f in terms) && row[i + 1] != null && text(row[i + 1]) !== '') terms[f] = f === 'valid_until' ? dateText(row[i + 1]) : text(row[i + 1]);
  });
  if (terms.currency) terms.currency = terms.currency.toUpperCase().replace('RMB', 'CNY');
  if (terms.incoterm) terms.incoterm = terms.incoterm.toUpperCase();

  const imagesByRow = {};
  for (const img of sheet.images || []) if (img.row > h) (imagesByRow[img.row] ||= []).push(img);

  const rows = [];
  let skipped = 0;
  for (let r = h + 1; r < sheet.rows.length || imagesByRow[r]; r++) {
    const cells = sheet.rows[r] || [];
    const raw = {};
    for (const [f, i] of Object.entries(cols)) raw[f] = cells[i];
    const name = text(raw.name);
    const filled = Object.entries(raw).some(([f, v]) => text(v) !== '' && f !== 'name');
    // sub-header (Chinese labels) and the grey example row are not products
    if (r === h + 1 && /[一-鿿]/.test(name)) continue;
    if (/^example/i.test(name) || /^example/i.test(text(raw.sku)) && !name) { skipped++; continue; }
    if (!name && !filled) continue;
    const body = { ...terms };
    for (const [f, v] of Object.entries(raw)) body[f] = f === 'valid_until' ? dateText(v) : text(v);
    const data = clean(body);
    const pics = (imagesByRow[r] || []).sort((a, b) => Math.abs(a.col - photoCol) - Math.abs(b.col - photoCol)).slice(0, MAX_PHOTOS);
    const problems = [];
    if (!name) problems.push('Product name is missing');
    if (text(raw.unit_price) !== '' && !(data.unit_price >= 0)) problems.push('Unit price is not a number');
    rows.push({ row: r + 1, data, images: pics.map(p => ({ data: p.data, ext: p.ext })), problems });
  }
  return { terms, rows, skipped };
}

/** What each good row still lacks (shown in the results; the supplier may still send it). */
export const gaps = (data, photoCount) => missing(data, photoCount).map(m => m.label);
