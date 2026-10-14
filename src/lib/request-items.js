// Multi-product sourcing requests: parsing the submitted form and building the request title.
export const UNITS = ['pcs', 'sets', 'pairs', 'boxes', 'cartons', 'kg', 'm', 'm²', 'litres'];
export const MAX_ITEMS = 30;

const num = v => { const n = Number(String(v ?? '').replace(',', '.').trim()); return String(v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null; };

/**
 * The form posts fields like items[3][name]; multer/append-field turns them into an array
 * (or an object with numeric keys when blocks were removed in between). Returns clean rows
 * that keep the block key, so per-product file fields (item_files_<key>) can be matched.
 */
export function parseItems(body) {
  const raw = body?.items;
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  const rows = [];
  for (const [key, v] of entries) {
    if (!v || typeof v !== 'object') continue;
    const name = String(v.name || '').trim();
    const description = String(v.description || '').trim();
    const quantity = num(v.quantity);
    const target = num(v.target_unit_price);
    if (!name && !description && quantity == null && target == null) continue; // empty block
    const uuid = x => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || '')) ? String(x) : null);
    rows.push({
      key: String(key).replace(/[^\w-]/g, ''),
      ...(uuid(v.id) ? { id: uuid(v.id) } : {}), ...(uuid(v.tmp) ? { tmp: uuid(v.tmp) } : {}),
      name, description: description || null,
      quantity: quantity != null ? Math.round(quantity) : null,
      unit: UNITS.includes(v.unit) ? v.unit : 'pcs',
      target_unit_price: target,
    });
  }
  return rows.slice(0, MAX_ITEMS);
}

export function validateItems(items) {
  if (!items.length) return 'Add at least one product.';
  const missing = items.findIndex(i => !i.name);
  if (missing >= 0) return `Product ${missing + 1}: enter a product name.`;
  return null;
}

/** Title shown in lists: the client's own request name, otherwise the first product (+ N more). */
export function requestTitle(name, items) {
  const own = String(name || '').trim();
  if (own) return own.slice(0, 200);
  const first = items[0]?.name || 'Sourcing request';
  return items.length > 1 ? `${first} + ${items.length - 1} more` : first;
}

/** Group files uploaded with multer .any(): general files and files per product block key. */
export function splitFiles(files) {
  const general = [], byKey = {};
  for (const f of files || []) {
    const m = /^item_files_([\w-]+)$/.exec(f.fieldname);
    if (m) (byKey[m[1]] ||= []).push(f);
    else if (f.fieldname === 'files') general.push(f);
  }
  return { general, byKey };
}
