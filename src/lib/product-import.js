// Product import: template parsing, value clean-up, row checks and duplicate detection.
// Pure functions only (no database / network), so everything here is unit-tested.

export const TEMPLATE_VERSION = 'HB-PI-1';

// ---------------- value clean-up ----------------
/** "1,234.5 kg" → 1234.5 ; "0,65" → 0.65 ; "" → null */
export function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[\s ]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?/.test(s)) s = s.replace(/,/g, '');      // 1,234.5
  else s = s.replace(',', '.');                                          // 0,65 (European decimal)
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** "52x38x23 cm", "52*38*23", "52 × 38 × 23mm" → [52, 38, 23] (cm). */
export function dims(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  const parts = s.split(/\s*[x×*✕\/]\s*/).map(p => num(p)).filter(n => n != null);
  if (parts.length < 3) return null;
  const f = /\bmm\b/.test(s) ? 0.1 : /\bm\b(?!m)/.test(s) && !/cm/.test(s) ? 100 : 1;
  return parts.slice(0, 3).map(n => Math.round(n * f * 100) / 100);
}

/** keep digits and dots, e.g. "9405.21.00 " → "9405.21.00", "940521" → "940521" */
export const hsCode = v => (v == null ? null : String(v).replace(/[^\d.]/g, '').replace(/^\.+|\.+$/g, '') || null);

const CURRENCY = { '¥': 'CNY', 'rmb': 'CNY', 'cny': 'CNY', '人民币': 'CNY', '元': 'CNY', '$': 'USD', 'usd': 'USD', 'us$': 'USD', '美元': 'USD', '€': 'EUR', 'eur': 'EUR', '欧元': 'EUR' };
export function currency(v, fallback = 'CNY') {
  if (!v) return fallback;
  const s = String(v).trim().toLowerCase();
  return CURRENCY[s] || (/^[a-z]{3}$/.test(s) ? s.toUpperCase() : fallback);
}

const str = v => (v == null || v === '' ? null : String(v).trim() || null);

// ---------------- template parsing ----------------
// Header aliases (English template headers, Chinese sub-headers and common supplier wording).
const COLS = {
  photo: ['photo', 'picture', 'image', 'pic', '照片', '图片'],
  name: ['product name', 'name', 'description', 'item', 'product', '产品名称', '品名', '名称'],
  supplier_sku: ['supplier sku', 'sku', 'item no', 'item no.', 'model', 'model no', 'article', 'art no', '货号', '型号', '款号'],
  category: ['category', 'product category', '类别', '产品类别', '分类'],
  hs_code: ['hs code', 'hs', 'hscode', 'customs code', '海关编码', 'hs编码'],
  unit_weight_kg: ['unit weight (kg)', 'unit weight', 'weight (kg)', 'net weight', 'n.w.', 'nw', '单品重量', '净重'],
  unit_length_cm: ['unit length (cm)', 'unit length', '单品长'],
  unit_width_cm: ['unit width (cm)', 'unit width', '单品宽'],
  unit_height_cm: ['unit height (cm)', 'unit height', '单品高'],
  unit_size: ['unit size', 'product size', 'size', 'dimensions', '产品尺寸', '尺寸'],
  carton_qty: ['pcs per carton', 'qty per carton', 'carton qty', 'pcs/ctn', 'qty/ctn', 'packing', '每箱数量', '装箱数'],
  carton_weight_kg: ['carton gross weight (kg)', 'carton gross weight', 'carton weight', 'g.w.', 'gw', 'gross weight', '外箱毛重', '毛重'],
  carton_length_cm: ['carton length (cm)', 'carton length', '外箱长'],
  carton_width_cm: ['carton width (cm)', 'carton width', '外箱宽'],
  carton_height_cm: ['carton height (cm)', 'carton height', '外箱高'],
  carton_size: ['carton size', 'carton dimensions', 'meas', 'measurement', '外箱尺寸', '箱规'],
  unit_price: ['unit price', 'price', 'fob price', 'exw price', '单价', '价格'],
  currency: ['currency', '币种'],
  moq: ['moq (pcs)', 'moq', 'min order', 'minimum order', '起订量'],
  notes: ['notes', 'remarks', 'remark', '备注'],
};
const norm = s => String(s ?? '').toLowerCase().replace(/[\s_]+/g, ' ').replace(/[：:]/g, '').trim();

/** Map header cells → field keys. Exact alias first, then "starts with" (e.g. "Unit price (USD)"). */
export function mapHeaders(headerRow = []) {
  const map = {};
  const used = new Set();
  const cells = headerRow.map((h, i) => [i, norm(h)]).filter(([, h]) => h);
  for (const pass of ['exact', 'prefix']) {
    for (const [field, aliases] of Object.entries(COLS)) {
      if (field in map) continue;
      for (const [i, h] of cells) {
        if (used.has(i)) continue;
        const hit = pass === 'exact' ? aliases.includes(h) : aliases.some(a => a.length > 2 && h.startsWith(a));
        if (hit) { map[field] = i; used.add(i); break; }
      }
    }
  }
  return map;
}

const SUPPLIER_FIELDS = {
  name: ['company name', '公司名称', 'company', 'supplier', 'supplier name'],
  address: ['company address', '公司地址', 'address', '地址'],
  contact_name: ['contact person', '联系人', 'contact'],
  email: ['email', 'e-mail', '邮箱'],
  phone: ['phone', 'tel', 'mobile', '电话', '手机'],
  wechat: ['wechat', 'weixin', '微信'],
  website: ['website', 'website / alibaba store', 'alibaba', '网站'],
};

/** Read a "label | value" sheet (labels like "Company name  /  公司名称"). */
export function parseSupplierSheet(rows = []) {
  const out = {};
  for (const row of rows) {
    if (!row) continue;
    const labelParts = String(row[0] ?? '').split('/').map(norm).filter(Boolean);
    const value = str(row[1]);
    if (!labelParts.length || !value) continue;
    for (const [field, aliases] of Object.entries(SUPPLIER_FIELDS)) {
      if (out[field]) continue;
      if (labelParts.some(l => aliases.includes(l))) { out[field] = value; break; }
    }
  }
  return out;
}

/** Turn one spreadsheet row into a product draft using a header map. */
export function rowToProduct(row, map) {
  const g = k => (k in map ? row[map[k]] : undefined);
  const unit = [num(g('unit_length_cm')), num(g('unit_width_cm')), num(g('unit_height_cm'))];
  const ctn = [num(g('carton_length_cm')), num(g('carton_width_cm')), num(g('carton_height_cm'))];
  const ud = unit.every(n => n != null) ? unit : dims(g('unit_size'));
  const cd = ctn.every(n => n != null) ? ctn : dims(g('carton_size'));
  return {
    name: str(g('name')),
    supplier_sku: str(g('supplier_sku')),
    category: str(g('category')),
    hs_code: hsCode(g('hs_code')),
    unit_weight_kg: num(g('unit_weight_kg')),
    unit_length_cm: ud?.[0] ?? null, unit_width_cm: ud?.[1] ?? null, unit_height_cm: ud?.[2] ?? null,
    carton_qty: num(g('carton_qty')),
    carton_weight_kg: num(g('carton_weight_kg')),
    carton_length_cm: cd?.[0] ?? null, carton_width_cm: cd?.[1] ?? null, carton_height_cm: cd?.[2] ?? null,
    unit_price: num(g('unit_price')),
    currency: currency(g('currency')),
    moq: num(g('moq')),
    notes: str(g('notes')),
  };
}

const isExample = p => /^example/i.test(p.supplier_sku || '') || /^示例/.test(p.name || '');
const isBlank = p => !p.name && !p.supplier_sku && p.unit_price == null;

/**
 * Parse a workbook (from readXlsx). Works for our template and for simple supplier price lists
 * with a recognisable header row. Returns null when no product table is found (→ use AI).
 */
export function parseWorkbook(wb) {
  const supplierSheet = wb.sheets.find(s => /^supplier/i.test(s.name));
  const productSheets = [...wb.sheets].sort((a, b) => (/^products?$/i.test(b.name) ? 1 : 0) - (/^products?$/i.test(a.name) ? 1 : 0));
  for (const sheet of productSheets) {
    // header = first of the first 15 rows that maps at least a name and a price/sku column
    for (let h = 0; h < Math.min(15, sheet.rows.length); h++) {
      const map = mapHeaders(sheet.rows[h] || []);
      if (!('name' in map) || !(('unit_price' in map) || ('supplier_sku' in map))) continue;
      const photoCol = map.photo ?? 0;
      const imagesByRow = {};
      for (const img of sheet.images) if (img.row > h) (imagesByRow[img.row] ||= []).push(img);
      const products = [];
      for (let r = h + 1; r < sheet.rows.length || imagesByRow[r]; r++) {
        const row = sheet.rows[r] || [];
        const p = rowToProduct(row, map);
        if (isBlank(p) || isExample(p)) continue;
        // sub-header row of our template (Chinese labels) has no numbers
        if (r === h + 1 && p.unit_price == null && p.name && /[一-鿿]/.test(p.name) && !p.supplier_sku?.match(/\d/)) continue;
        const pics = (imagesByRow[r] || []).sort((a, b) => Math.abs(a.col - photoCol) - Math.abs(b.col - photoCol));
        products.push({ ...p, source_row: r + 1, image: pics[0] ? { data: pics[0].data, ext: pics[0].ext } : null });
      }
      return {
        template: !!supplierSheet && /^products$/i.test(sheet.name),
        supplier: supplierSheet ? parseSupplierSheet(supplierSheet.rows) : {},
        products,
      };
    }
  }
  return null;
}

// ---------------- row checks ----------------
const vol = (l, w, h) => (l && w && h ? (l * w * h) / 1e6 : null); // m³

export function cartonCbm(p) { return vol(p.carton_length_cm, p.carton_width_cm, p.carton_height_cm); }

/** Deterministic sanity checks → [{ level: 'error'|'warn', field, message }] */
export function checkRow(p) {
  const out = [];
  const add = (level, field, message) => out.push({ level, field, message });
  if (!p.name) add('error', 'name', 'Product name is missing.');
  if (p.unit_price == null) add('warn', 'unit_price', 'No price.');
  else if (p.unit_price <= 0) add('error', 'unit_price', 'Price must be above zero.');
  if (p.hs_code && !/^\d{4}(\.?\d{2}){1,3}$/.test(p.hs_code) && !/^\d{6,10}$/.test(p.hs_code)) add('warn', 'hs_code', `HS code "${p.hs_code}" doesn't look like 6–10 digits.`);
  if (!p.hs_code) add('warn', 'hs_code', 'No HS code.');
  if (!p.carton_qty) add('warn', 'carton_qty', 'Pieces per carton missing.');
  if (p.carton_qty && p.unit_weight_kg && p.carton_weight_kg) {
    const net = p.carton_qty * p.unit_weight_kg;
    if (p.carton_weight_kg < net * 0.95) add('warn', 'carton_weight_kg', `Carton ${p.carton_weight_kg} kg is lighter than ${p.carton_qty} × ${p.unit_weight_kg} kg = ${Math.round(net * 100) / 100} kg.`);
    if (p.carton_weight_kg > net * 3 + 5) add('warn', 'carton_weight_kg', `Carton ${p.carton_weight_kg} kg is much heavier than its contents (${Math.round(net * 100) / 100} kg) — check unit weight.`);
  }
  const uv = vol(p.unit_length_cm, p.unit_width_cm, p.unit_height_cm), cv = cartonCbm(p);
  if (uv && cv && p.carton_qty && cv < uv * p.carton_qty * 0.9) add('warn', 'carton_length_cm', `${p.carton_qty} units (${(uv * p.carton_qty).toFixed(3)} m³) don't fit a ${cv.toFixed(3)} m³ carton — check sizes or quantity.`);
  if (cv && cv > 0.5) add('warn', 'carton_length_cm', `Carton volume ${cv.toFixed(2)} m³ is unusually large — sizes in mm instead of cm?`);
  if (p.unit_weight_kg && p.unit_weight_kg > 200) add('warn', 'unit_weight_kg', `${p.unit_weight_kg} kg per unit — grams instead of kg?`);
  return out;
}

// ---------------- duplicate detection ----------------
const STOP = new Set(['co', 'company', 'ltd', 'limited', 'llc', 'inc', 'corp', 'corporation', 'group', 'trading', 'trade', 'import', 'export', 'imp', 'exp',
  'industrial', 'industry', 'industries', 'manufacturing', 'manufacturer', 'mfg', 'factory', 'technology', 'technologies', 'tech', 'science', 'sci',
  'development', 'international', 'intl', 'the', 'and', 'of', 'products', 'product', 'commodity', 'enterprise', 'enterprises', 'industrial', 'electronic', 'electronics',
  'shenzhen', 'guangzhou', 'dongguan', 'foshan', 'yiwu', 'ningbo', 'shanghai', 'beijing', 'xiamen', 'hangzhou', 'suzhou', 'zhongshan', 'jinhua', 'wenzhou', 'qingdao', 'tianjin', 'shantou', 'hong', 'kong', 'hk', 'china', 'cn', 'zhejiang', 'guangdong', 'jiangsu', 'fujian']);
const CN_STOP = /(有限责任公司|股份有限公司|有限公司|公司|集团|贸易|进出口|实业|科技|电子|工厂|厂|商行|深圳市?|广州市?|东莞市?|佛山市?|义乌市?|宁波市?|上海市?|浙江省?|广东省?|中国)/g;
const PUBLIC_MAIL = new Set(['gmail.com', 'qq.com', '163.com', '126.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'foxmail.com', 'sina.com', 'sina.cn', 'aliyun.com', 'icloud.com', '139.com', 'yeah.net', 'live.com', 'msn.com']);

/** Core of a company name: lower-case, no punctuation, no legal suffixes / city words. */
export function coreName(name) {
  const s = String(name || '').toLowerCase().replace(CN_STOP, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = s.split(' ').filter(w => w && !STOP.has(w));
  return words.join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const ratio = (a, b) => (!a || !b ? 0 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/** 0..1 similarity between two company names, tolerant of typos, word order and legal suffixes. */
export function nameSimilarity(a, b) {
  const ca = coreName(a), cb = coreName(b);
  if (!ca || !cb) return ratio(String(a || '').toLowerCase(), String(b || '').toLowerCase());
  if (ca === cb) return 1;
  const sa = ca.split(' ').sort().join(' '), sb = cb.split(' ').sort().join(' ');
  const ta = new Set(ca.split(' ')), tb = new Set(cb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const jacc = inter / new Set([...ta, ...tb]).size;
  const glued = ratio(ca.replace(/ /g, ''), cb.replace(/ /g, ''));   // "brightway" vs "bright way"
  return Math.max(ratio(ca, cb), ratio(sa, sb), glued, jacc);
}

const digits = v => String(v || '').replace(/\D/g, '');
const domain = e => (String(e || '').toLowerCase().split('@')[1] || '').trim();

/**
 * Compare an extracted supplier with existing suppliers.
 * @returns {{ status: 'match'|'suspect'|'new', candidates: { id, name, score, reasons: string[] }[] }}
 *   match   = same email / phone / WeChat / company domain, or practically identical name
 *   suspect = similar name (likely typo / different spelling) — admin must decide
 */
export function matchSupplier(extracted, suppliers = []) {
  const cands = [];
  for (const s of suppliers) {
    const reasons = [];
    let strong = false;
    const sim = nameSimilarity(extracted.name, s.name);
    if (sim >= 0.97) { reasons.push('same company name'); strong = true; }
    else if (sim >= 0.72) reasons.push(`similar name (${Math.round(sim * 100)}% alike)`);
    if (extracted.email && s.email && extracted.email.toLowerCase() === s.email.toLowerCase()) { reasons.push('same email'); strong = true; }
    const d1 = domain(extracted.email), d2 = domain(s.email);
    if (d1 && d1 === d2 && !PUBLIC_MAIL.has(d1) && !reasons.includes('same email')) { reasons.push(`same email domain @${d1}`); strong = true; }
    const p1 = digits(extracted.phone), p2 = digits(s.phone);
    if (p1.length >= 7 && p2.length >= 7 && (p1.endsWith(p2.slice(-8)) || p2.endsWith(p1.slice(-8)))) { reasons.push('same phone'); strong = true; }
    if (extracted.wechat && s.wechat && extracted.wechat.toLowerCase().trim() === s.wechat.toLowerCase().trim()) { reasons.push('same WeChat'); strong = true; }
    if (extracted.contact_name && s.contact_name && ratio(extracted.contact_name.toLowerCase(), s.contact_name.toLowerCase()) > 0.85 && sim >= 0.5) reasons.push('same contact person');
    if (reasons.length) cands.push({ id: s.id, name: s.name, city: s.city || null, score: strong ? Math.max(sim, 0.99) : sim, strong, reasons });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  const status = !top ? 'new' : top.strong ? 'match' : 'suspect';
  return { status, candidates: cands.slice(0, 5) };
}

/**
 * Find existing products of the chosen supplier that a row would duplicate.
 * Same supplier SKU → 'update' suggestion; very similar name (no SKU) → 'suspect'.
 */
export function matchProduct(p, existing = []) {
  if (p.supplier_sku) {
    const hit = existing.find(e => e.supplier_sku && e.supplier_sku.trim().toLowerCase() === p.supplier_sku.trim().toLowerCase());
    if (hit) return { status: 'sku', product: { id: hit.id, name: hit.name, supplier_sku: hit.supplier_sku, unit_cost: hit.unit_cost, cost_currency: hit.cost_currency } };
  }
  let best = null;
  for (const e of existing) {
    const s = ratio(String(p.name || '').toLowerCase(), String(e.name || '').toLowerCase());
    if (s >= 0.9 && (!best || s > best.s)) best = { s, e };
  }
  return best ? { status: 'name', product: { id: best.e.id, name: best.e.name, supplier_sku: best.e.supplier_sku, unit_cost: best.e.unit_cost, cost_currency: best.e.cost_currency } } : { status: 'none' };
}

/** Product row → columns of the products table. */
export function toProductRecord(p, supplierId) {
  return {
    name: p.name,
    supplier_sku: p.supplier_sku || null,
    category: p.category || null,
    hs_code: p.hs_code || null,
    supplier_id: supplierId,
    unit_cost: p.unit_price ?? null,
    cost_currency: p.currency || 'CNY',
    moq: p.moq != null ? Math.round(p.moq) : null,
    unit_weight_kg: p.unit_weight_kg ?? null,
    unit_length_cm: p.unit_length_cm ?? null,
    unit_width_cm: p.unit_width_cm ?? null,
    unit_height_cm: p.unit_height_cm ?? null,
    carton_qty: p.carton_qty != null ? Math.round(p.carton_qty) : null,
    carton_weight_kg: p.carton_weight_kg ?? null,
    carton_length_cm: p.carton_length_cm ?? null,
    carton_width_cm: p.carton_width_cm ?? null,
    carton_height_cm: p.carton_height_cm ?? null,
    carton_cbm: cartonCbm(p) != null ? Math.round(cartonCbm(p) * 10000) / 10000 : null,
    description: p.notes || null,
  };
}

export const PRODUCT_FIELDS = ['name', 'supplier_sku', 'category', 'hs_code', 'unit_weight_kg', 'unit_length_cm', 'unit_width_cm', 'unit_height_cm',
  'carton_qty', 'carton_weight_kg', 'carton_length_cm', 'carton_width_cm', 'carton_height_cm', 'unit_price', 'currency', 'moq', 'notes'];
const NUMERIC = new Set(['unit_weight_kg', 'unit_length_cm', 'unit_width_cm', 'unit_height_cm', 'carton_qty', 'carton_weight_kg', 'carton_length_cm', 'carton_width_cm', 'carton_height_cm', 'unit_price', 'moq']);

/** Clean a product coming from a form post or from the AI into the canonical shape. */
export function cleanProduct(p = {}) {
  const out = {};
  for (const f of PRODUCT_FIELDS) {
    const v = p[f];
    out[f] = NUMERIC.has(f) ? num(v) : f === 'hs_code' ? hsCode(v) : f === 'currency' ? currency(v) : str(v);
  }
  return out;
}
