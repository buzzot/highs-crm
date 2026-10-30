// "New order" from the client portal: the order details that go with the product lines.
export const INCOTERMS = ['EXW', 'FOB', 'CIF', 'DAP'];
export const TRANSPORT = { sea: 'Sea', air: 'Air', land: 'Rail / truck', any: 'None' };
const s = (v, n) => String(v ?? '').trim().slice(0, n);

/** Clean the posted form into the order details stored with the request. */
export function parseOrderInfo(b = {}) {
  return {
    incoterm: INCOTERMS.includes(b.incoterm) ? b.incoterm : null,
    delivery_address: s(b.delivery_address, 500) || null,
    po_number: s(b.po_number, 80) || null,
    contact: s(b.contact, 120) || null,
    email: s(b.email, 200) || null,
    phone: s(b.phone, 60) || null,
    notes: s(b.notes, 3000) || null,
  };
}

/** What is missing before the order can be sent (null = fine). */
export function validateOrder(info, form) {
  if (!String(form.destination_country || '').trim()) return 'Enter the destination country.';
  if (!info.contact) return 'Enter a contact person.';
  if (!info.email || !/^\S+@\S+\.\S+$/.test(info.email)) return 'Enter a valid email address.';
  return null;
}

/** Rows shown to staff and the client: [label, value]. Orders stored as real orders carry destination / dates inside `info`. */
export function orderInfoRows(info, mode) {
  const i = info || {};
  mode = mode || i.delivery_mode;
  return [
    ['Destination', [i.destination_city, i.destination_country].filter(Boolean).join(', ')], ['Needed by', i.needed_by],
    ['Incoterm', i.incoterm], ['Transport', TRANSPORT[mode]], ['Delivery address', i.delivery_address], ['Client PO number', i.po_number],
    ['Contact', [i.contact, i.email, i.phone].filter(Boolean).join(' · ')], ['Notes', i.notes],
  ].filter(([, v]) => v);
}

/** Without migration 0042 the details go into the description so nothing is lost. */
export function orderInfoText(info, mode) {
  return ['ORDER FROM THE CLIENT PORTAL', ...orderInfoRows(info, mode).map(([k, v]) => `${k}: ${v}`)].join('\n');
}

/**
 * A portal order as database rows: one `orders` row (status 'new', source 'portal', prices still 0 — the team fills them in)
 * and its `order_items` (the client's target price is kept apart in target_unit_price, it is not a price).
 */
export function buildPortalOrder({ orgId, userId, form = {}, info, items, currencyOk }) {
  const cur = currencyOk.includes(form.target_currency) ? form.target_currency : 'USD';
  const order = {
    org_id: orgId, status: 'new', source: 'portal', currency: cur, subtotal: 0, submitted_by: userId, client_notes: info.notes || null,
    order_info: {
      ...info, destination_country: s(form.destination_country, 120), destination_city: s(form.destination_city, 120) || null,
      needed_by: /^\d{4}-\d{2}-\d{2}$/.test(String(form.needed_by || '')) ? form.needed_by : null,
      delivery_mode: TRANSPORT[form.delivery_mode] ? form.delivery_mode : null,
    },
  };
  const rows = items.map(it => ({
    description: it.description && it.description !== it.name ? `${it.name} — ${it.description}` : it.name, quantity: Math.max(0, Math.round(Number(it.quantity) || 0)),
    unit_price: 0, sku: it.sku || null, unit: it.unit || null, target_unit_price: it.target_unit_price ?? null,
  }));
  return { order, items: rows };
}

/** An order needs a quantity on every line (a request may leave it open). */
export function validateOrderItems(items) {
  const i = items.findIndex(x => !(Number(x.quantity) > 0));
  return i >= 0 ? `Product ${i + 1}: enter the quantity.` : null;
}

/** The client has not been given prices yet: the team fills them in after checking the order. */
export const awaitingPrices = o => Number(o?.subtotal) === 0 || o?.subtotal == null;
