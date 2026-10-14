// Client edits of a sourcing request. The client's version is stored as a "revision" and only
// replaces the request when an admin approves it. Pure helpers here (snapshot, diff); DB work in the routes.
import { randomUUID } from 'node:crypto';

export const EDITABLE = ['new', 'reviewing', 'quoted'];
export const DELIVERY = { sea: 'Sea', air: 'Air', land: 'Land (rail / truck)', any: 'No preference' };
export const deliveryLabel = m => DELIVERY[m] || '—';

const HEADER = [
  ['title', 'Request name'],
  ['destination_country', 'Destination country'],
  ['destination_city', 'Destination city / port'],
  ['needed_by', 'Needed by'],
  ['delivery_mode', 'Delivery'],
  ['target_currency', 'Price currency'],
  ['description', 'General notes'],
];
const ITEM = [['name', 'Name'], ['description', 'Details'], ['quantity', 'Quantity'], ['unit', 'Unit'], ['target_unit_price', 'Target price']];
// header changes that make every open quote outdated
const AFFECTS_ALL = ['destination_country', 'destination_city', 'needed_by', 'delivery_mode', 'target_currency'];

const norm = v => (v === undefined || v === null || String(v).trim() === '' ? null : typeof v === 'number' ? v : String(v).trim());
const same = (a, b) => {
  a = norm(a); b = norm(b);
  if (a === null || b === null) return a === b;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).match(/^-?[\d.]+$/) && String(b).match(/^-?[\d.]+$/)) return na === nb;
  return String(a) === String(b);
};

/** The request as it is now, in the same shape as a revision's data. */
export function snapshot(request, items) {
  return {
    title: request.title, description: request.description ?? null,
    destination_country: request.destination_country ?? null, destination_city: request.destination_city ?? null,
    needed_by: request.needed_by ?? null, delivery_mode: request.delivery_mode ?? null, target_currency: request.target_currency || 'USD',
    items: (items || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(i => ({
      id: i.id, name: i.name, description: i.description ?? null, quantity: i.quantity ?? null, unit: i.unit || 'pcs', target_unit_price: i.target_unit_price ?? null,
    })),
    new_docs: [], remove_doc_ids: [],
  };
}

/**
 * Build revision data from the edit form.
 * @param header  cleaned header fields (title already resolved)
 * @param parsed  rows from parseItems(); each may carry id (existing product) or tmp (new product of an earlier pending edit)
 * @param currentIds ids of the request's existing products — anything else is treated as new
 */
export function buildRevision(header, parsed, currentIds) {
  const known = new Set(currentIds);
  const items = parsed.map(p => {
    const row = { name: p.name, description: p.description, quantity: p.quantity, unit: p.unit, target_unit_price: p.target_unit_price, key: p.key };
    if (p.id && known.has(p.id)) row.id = p.id;
    else row.tmp = /^[0-9a-f-]{36}$/.test(p.tmp || '') ? p.tmp : randomUUID();
    return row;
  });
  return { ...header, items, new_docs: [], remove_doc_ids: [] };
}

/** What would change. Used for the "nothing changed" check, the approval screen and to decide which quotes go stale. */
export function diff(current, next) {
  const header = HEADER.filter(([k]) => !same(current[k], next[k])).map(([k, label]) => ({ field: k, label, from: current[k] ?? null, to: next[k] ?? null }));
  const byId = new Map(current.items.map(i => [i.id, i]));
  const keep = new Set();
  const added = [], changed = [];
  for (const it of next.items || []) {
    const old = it.id && byId.get(it.id);
    if (!old) { added.push(it); continue; }
    keep.add(it.id);
    const fields = ITEM.filter(([k]) => !same(old[k], it[k])).map(([k, label]) => ({ field: k, label, from: old[k] ?? null, to: it[k] ?? null }));
    if (fields.length) changed.push({ id: it.id, name: it.name, fields });
  }
  const removed = current.items.filter(i => !keep.has(i.id));
  const files = { added: (next.new_docs || []).length, removed: (next.remove_doc_ids || []).length };
  const fileItems = new Set((next.new_docs || []).map(d => d.item).filter(Boolean));
  const empty = !header.length && !added.length && !changed.length && !removed.length && !files.added && !files.removed;
  return {
    header, added, changed, removed, files, empty,
    affectsAll: header.some(h => AFFECTS_ALL.includes(h.field)),
    // existing products whose quotes are now outdated
    staleItemIds: [...changed.map(c => c.id), ...removed.map(r => r.id), ...[...fileItems].filter(id => byId.has(id))],
  };
}

/** Human-readable value for the diff table. */
export function showValue(field, v, currency) {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'delivery_mode') return deliveryLabel(v);
  if (field === 'target_unit_price') return `${Number(v).toFixed(2)} ${currency || ''}`.trim();
  if (field === 'quantity') return Number(v).toLocaleString('en-US');
  return String(v);
}
