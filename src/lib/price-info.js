// What staff need to know when pricing a product for a client: earlier prices to THIS client and the supplier price now.
// build* functions are pure (tested); the load* functions read the database.
import { admin } from './supabase.js';
import { getSettings, fxRate } from './util.js';

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = x => Math.round(x * 10000) / 10000;

/** rows: order_items joined with their order (orders: { order_no, currency, status, created_at }), newest first, cancelled / unpriced skipped. */
export function buildHistory(rows, cur, rate, limit = 5) {
  return (rows || [])
    .filter(r => r.orders && r.orders.status !== 'cancelled' && Number(r.unit_price) > 0)
    .sort((a, b) => String(b.orders.created_at).localeCompare(String(a.orders.created_at)))
    .slice(0, limit)
    .map(r => {
      const from = r.orders.currency || cur, f = rate(from, cur);
      return {
        date: String(r.orders.created_at).slice(0, 10), order_no: r.orders.order_no, order_id: r.orders.id, qty: Number(r.quantity) || 0,
        price: r4(Number(r.unit_price) * f), price_orig: Number(r.unit_price), cur_orig: from,
        cost_then: num(r.unit_cost) != null && Number(r.unit_cost) > 0 ? r4(Number(r.unit_cost) * f) : null,   // order cost is kept in the order currency
      };
    });
}
export function buildInfo({ product, rows, cur, rate }) {
  const cost = product && num(product.unit_cost) != null && Number(product.unit_cost) > 0 ? r4(Number(product.unit_cost) * rate(product.cost_currency || 'CNY', cur)) : null;
  return { product: product ? { id: product.id, name: product.name, sku: product.sku || '', hs_code: product.hs_code || '' } : null, cur, cost, cost_orig: cost != null ? { v: Number(product.unit_cost), cur: product.cost_currency || 'CNY' } : null, hist: buildHistory(rows, cur, rate) };
}

const ITEM_COLS = 'product_id, quantity, unit_price, unit_cost, orders!inner(id, order_no, org_id, currency, status, created_at)';
async function rater() { const s = await getSettings(admin); return (a, b) => fxRate(s, a, b); }

export async function loadInfo(productId, orgId, cur) {
  const [{ data: product }, { data: rows }, rate] = await Promise.all([
    admin.from('products').select('id, name, sku, hs_code, unit_cost, cost_currency').eq('id', productId).maybeSingle(),
    admin.from('order_items').select(ITEM_COLS).eq('product_id', productId).eq('orders.org_id', orgId).gt('unit_price', 0).limit(60),
    rater(),
  ]);
  return product ? buildInfo({ product, rows, cur, rate }) : null;
}

/** Product search for the picker: matches name / SKU; without a search, the products this client ordered before come first. Each with the last price to this client. */
export async function searchProducts({ q, orgId, cur, limit = 12 }) {
  const rate = await rater();
  const term = String(q || '').replace(/[,()%*]/g, ' ').trim();
  let products = [];
  if (term) {
    const { data } = await admin.from('products').select('id, name, sku, hs_code, unit_cost, cost_currency').or(`name.ilike.%${term}%,sku.ilike.%${term}%`).order('name').limit(limit);
    products = data || [];
  } else {
    const { data: rows } = await admin.from('order_items').select('product_id, orders!inner(org_id, created_at, status)').eq('orders.org_id', orgId).not('product_id', 'is', null).limit(80);
    const ids = [...new Set((rows || []).sort((a, b) => String(b.orders.created_at).localeCompare(String(a.orders.created_at))).map(r => r.product_id))].slice(0, limit);
    if (ids.length) products = (await admin.from('products').select('id, name, sku, hs_code, unit_cost, cost_currency').in('id', ids)).data || [];
    const order = new Map(ids.map((id, i) => [id, i])); products.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  if (!products.length) return [];
  const { data: rows } = await admin.from('order_items').select(ITEM_COLS).in('product_id', products.map(p => p.id)).eq('orders.org_id', orgId).gt('unit_price', 0).limit(300);
  return products.map(p => {
    const info = buildInfo({ product: p, rows: (rows || []).filter(r => r.product_id === p.id), cur, rate });
    return { id: p.id, name: p.name, sku: p.sku || '', hs_code: p.hs_code || '', last: info.hist[0] || null, cost: info.cost };
  });
}

/** Another product with the same name or SKU (case-insensitive), so a new product is not created twice. */
export async function findDuplicate(name, sku) {
  const n = String(name || '').trim(), s = String(sku || '').trim();
  const { data } = await admin.from('products').select('id, name, sku').or([n && `name.ilike.${n.replace(/[,()%*]/g, ' ')}`, s && `sku.ilike.${s.replace(/[,()%*]/g, ' ')}`].filter(Boolean).join(',')).limit(5);
  return (data || []).find(p => p.name.trim().toLowerCase() === n.toLowerCase() || (s && (p.sku || '').trim().toLowerCase() === s.toLowerCase())) || null;
}
