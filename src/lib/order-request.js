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

/** Rows shown to staff and the client: [label, value]. */
export function orderInfoRows(info, mode) {
  const i = info || {};
  return [
    ['Incoterm', i.incoterm], ['Transport', TRANSPORT[mode]], ['Delivery address', i.delivery_address], ['Client PO number', i.po_number],
    ['Contact', [i.contact, i.email, i.phone].filter(Boolean).join(' · ')], ['Notes', i.notes],
  ].filter(([, v]) => v);
}

/** Without migration 0042 the details go into the description so nothing is lost. */
export function orderInfoText(info, mode) {
  return ['ORDER FROM THE CLIENT PORTAL', ...orderInfoRows(info, mode).map(([k, v]) => `${k}: ${v}`)].join('\n');
}
