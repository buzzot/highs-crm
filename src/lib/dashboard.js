// Dashboard: pure helpers (no database) — what needs attention, order groups, month buckets, readable activity.
// Rule used throughout: a record is "overdue" only when it carries a real due date (RFQ deadline, quote validity, shipment ETA).
// Waiting for a supplier has no deadline in the data, so it shows elapsed time, never "overdue".

const DAY = 864e5;
export const day = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
const t0 = d => new Date(d + 'T00:00:00Z').getTime();
/** whole days from a date-only string `d` to `today` (positive = d is in the past) */
export const daysSince = (d, today) => (day(d) ? Math.round((t0(today) - t0(day(d))) / DAY) : null);
const ago = (ts, now) => { const m = Math.max(0, Math.round((now - new Date(ts).getTime()) / 6e4)); return m < 60 ? 'just now' : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
export const elapsed = ago;

/** Open orders grouped for the summary. delivered / closed / cancelled are not "open". */
export const OPEN_GROUPS = [
  { key: 'production', label: 'In production', statuses: ['confirmed', 'deposit_paid', 'in_production', 'qc', 'packed'] },
  { key: 'shipping', label: 'Shipping', statuses: ['shipped', 'in_transit', 'customs'] },
];
export const isOpenOrder = o => !['delivered', 'closed', 'cancelled'].includes(o.status);
/** [{status, n}] for the statuses that really have orders, in pipeline order */
export function statusSummary(open) {
  const order = ['confirmed', 'deposit_paid', 'in_production', 'qc', 'packed', 'shipped', 'in_transit', 'customs'];
  const by = {}; open.forEach(o => { by[o.status] = (by[o.status] || 0) + 1; });
  return order.filter(s => by[s]).map(s => ({ status: s, n: by[s] }));
}
export const groupCounts = (open, all) => ({
  production: open.filter(o => OPEN_GROUPS[0].statuses.includes(o.status)).length,
  shipping: open.filter(o => OPEN_GROUPS[1].statuses.includes(o.status)).length,
  delivered: all.filter(o => o.status === 'delivered').length,
  closed: all.filter(o => o.status === 'closed').length,
});

/** A shipment is late only if it has a past ETA, has not arrived (no ATA) and is not already arrived / in customs / delivered. */
export function shipmentFlag(s, today) {
  if (!s) return null;
  const done = ['delivered', 'arrived', 'customs'].includes(s.status) || !!day(s.ata);
  const d = daysSince(s.eta, today);
  if (!done && d != null && d > 0) return { kind: 'late', days: d };
  if (!done && ['departed', 'picked_up'].includes(s.status) && d != null && d <= 0 && d >= -7) return { kind: 'soon', days: -d };
  if (!done && ['departed', 'picked_up'].includes(s.status) && !s.tracking_no) return { kind: 'notrack' };
  return null;
}

/**
 * Everything that wants a decision, most urgent first.
 * input: { now (ms), today (YYYY-MM-DD), pos, pis, pays, requests, quotes, rfqs, rfqReplies, shipments }
 * item: { kind, tone: bad|warn|info, ref, href, party, action, when, overdue }
 */
export function needsAttention({ now = Date.now(), today, pos = [], pis = [], pays = [], requests = [], quotes = [], rfqs = [], rfqReplies = [], shipments = [], lowMargin = [], exportGaps = [], minMargin = 20 }) {
  // level: critical (a rule is broken) > overdue (a real due date has passed) > review (needs a decision) > pending (waiting / to start)
  const LEVEL = { shipment: 'overdue', rfq: 'overdue', quote: 'overdue', po_reply: 'review', rfq_reply: 'review', pi: 'review' };
  const poOwner = p => p?.orders?.owner_id || p?.created_by || p?.owner || null;   // a supplier PO belongs to the owner of its order, else to whoever created it
  const items = [], add = (i) => items.push({ overdue: false, level: LEVEL[i.kind] || 'pending', ...i });
  for (const g of exportGaps) add({ kind: 'export', owner: g.owner_id || g.orders?.owner_id, level: 'critical', tone: 'bad', sort: 200, ref: g.orders?.order_no || 'Shipment', href: `/admin/logistics/shipments/${g.id}`, party: g.orders?.organizations?.name || '', action: 'Left China without an export declaration number', when: 'Missing document' });
  for (const o of lowMargin) add({ kind: 'margin', owner: o.owner_id, level: 'critical', tone: 'bad', sort: 190, ref: o.order_no, href: `/admin/orders/${o.id}`, party: o.client_name || '', action: `Margin ${Number(o.margin_pct).toFixed(1)}% is below the ${minMargin}% minimum`, when: 'Check pricing' });
  for (const s of shipments) {
    const f = shipmentFlag(s, today);
    if (f?.kind === 'late') add({ kind: 'shipment', owner: s.owner_id || s.orders?.owner_id, level: f.days > 14 ? 'critical' : 'overdue', tone: 'bad', overdue: true, sort: 100 + f.days, ref: s.orders?.order_no || 'Shipment', href: `/admin/logistics/shipments/${s.id}`, party: s.orders?.organizations?.name || '', action: 'Shipment is late — check with the forwarder', when: `ETA passed ${f.days} d ago` });
  }
  for (const r of rfqs) {
    const d = daysSince(r.deadline, today);
    if (d != null && d > 0) add({ kind: 'rfq', owner: r.owner_id, tone: 'bad', overdue: true, sort: 90 + d, ref: r.ref, href: `/admin/rfqs/${r.id}`, party: r.title || '', action: 'RFQ deadline passed — compare replies or close it', when: `Deadline passed ${d} d ago` });
  }
  for (const q of quotes) {
    const d = daysSince(q.valid_until, today);
    if (d != null && d > 0) add({ kind: 'quote', owner: q.owner_id || q.requests?.owner_id, tone: 'bad', overdue: true, sort: 80 + d, ref: q.requests?.ref || 'Quote', href: `/admin/pricing/quotes/${q.id}`, party: q.requests?.organizations?.name || '', action: 'Quote validity ended — follow up with the client', when: `Valid until ${q.valid_until}` });
  }
  for (const p of pos.filter(x => x.status === 'replied'))
    add({ kind: 'po_reply', owner: poOwner(p), tone: 'warn', sort: 60, ref: p.ref, href: `/admin/purchasing/${p.id}#communication`, party: p.suppliers?.name || '', action: 'Supplier replied — confirm or decline', when: p.last_reply_at ? ago(p.last_reply_at, now) : '' });
  for (const r of rfqReplies)
    add({ kind: 'rfq_reply', owner: r.owner_id, tone: 'warn', sort: 58, ref: r.ref, href: `/admin/rfqs/${r.id}`, party: r.title || '', action: `${r.n} supplier ${r.n > 1 ? 'quotes' : 'quote'} read by AI — review`, when: '' });
  const poById = new Map(pos.map(p => [p.id, p]));
  for (const pi of pis.filter(x => x.status === 'draft')) {
    const p = poById.get(pi.po_id); if (!p) continue;
    add({ kind: 'pi', owner: poOwner(p), tone: 'warn', sort: 55, ref: p.ref, href: `/admin/purchasing/${p.id}#supplier-pi`, party: p.suppliers?.name || '', action: 'Supplier PI needs checking and approval', when: pi.created_at ? ago(pi.created_at, now) : '' });
  }
  const hasPi = new Set(pis.map(x => x.po_id));
  for (const p of pos.filter(x => x.status === 'confirmed' && !hasPi.has(x.id)))
    add({ kind: 'pi_missing', owner: poOwner(p), tone: 'info', sort: 40, ref: p.ref, href: `/admin/purchasing/${p.id}#supplier-pi`, party: p.suppliers?.name || '', action: 'Confirmed — add the supplier’s PI', when: p.confirmed_at ? ago(p.confirmed_at, now) : '' });
  for (const r of requests.filter(x => ['new', 'reviewing'].includes(x.status)))
    add({ kind: 'request', owner: r.owner_id, tone: 'info', sort: 45, ref: r.ref, href: `/admin/sourcing/${r.id}`, party: r.organizations?.name || '', action: r.status === 'new' ? 'New request — start pricing' : 'Request in review — finish the quote', when: ago(r.created_at, now) });
  for (const p of pos.filter(x => x.status === 'sent'))
    add({ kind: 'po_wait', owner: poOwner(p), tone: 'info', sort: 30, ref: p.ref, href: `/admin/purchasing/${p.id}`, party: p.suppliers?.name || '', action: 'Waiting for the supplier to confirm', when: p.sent_at ? `sent ${ago(p.sent_at, now)}` : '' });
  for (const x of paymentsOpen({ pis, pays, pos })) if (x.open > 0.004)
    add({ kind: 'pay', owner: poOwner(x), tone: 'info', sort: 35, ref: x.ref, href: `/admin/purchasing/${x.po_id}#supplier-pi`, party: x.supplier, action: `Pay the supplier — ${x.fmtOpen} open`, when: '' });
  const LR = { critical: 0, overdue: 1, review: 2, pending: 3 };
  const CTA = { export: 'Open shipment', margin: 'Open order', shipment: 'View shipment', rfq: 'Open RFQ', quote: 'Open quote', po_reply: 'Open reply', rfq_reply: 'Review quotes', pi: 'Review PI', pi_missing: 'Add PI', request: 'Open request', po_wait: 'Open PO', pay: 'Open PO' };
  items.forEach(i => { i.cta = CTA[i.kind]; });
  const sorted = items.sort((a, b) => LR[a.level] - LR[b.level] || b.sort - a.sort || String(a.ref).localeCompare(String(b.ref)));
  // one row per supplier PO: a reply and a PI on the same PO are one job, so the lower-priority task is added to the first row's text
  const out = [], byPo = new Map();
  for (const i of sorted) {
    const po = ['po_reply', 'pi', 'pi_missing', 'po_wait', 'pay'].includes(i.kind) ? i.ref : null;
    if (po && byPo.has(po)) { const f = byPo.get(po); f.action += ' · ' + i.action.replace(/^Supplier PI needs checking and approval$/, 'PI needs approval'); continue; }
    if (po) byPo.set(po, i);
    out.push(i);
  }
  return out;
}

/** Open balance per approved supplier PI: PI total − payments already recorded, in the PI's currency. */
export function paymentsOpen({ pis = [], pays = [], pos = [] }) {
  const poById = new Map(pos.map(p => [p.id, p]));
  return pis.filter(x => x.status === 'confirmed').map(pi => {
    const paid = pays.filter(y => y.po_id === pi.po_id).reduce((t, y) => t + Number(y.amount || 0), 0);
    const open = Math.round((Number(pi.total || 0) - paid) * 100) / 100, p = poById.get(pi.po_id);
    return { po_id: pi.po_id, ref: p?.ref || 'PO', owner: p?.orders?.owner_id || p?.created_by || null, supplier: p?.suppliers?.name || '', currency: pi.currency, total: Number(pi.total || 0), paid, open,
      fmtOpen: `${pi.currency} ${open.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
  });
}

/** Last `n` calendar months (oldest first) with zero-filled revenue / profit. `rows` = [{ date, revenue, profit }] already in one currency. */
export function monthBuckets(rows, n = 6, nowDate = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - i, 1));
    out.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), long: d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), revenue: 0, profit: 0, orders: 0 });
  }
  rows.forEach(r => { const m = out.find(x => x.key === String(r.date).slice(0, 7)); if (m) { m.revenue += r.revenue; m.profit += r.profit; m.orders++; } });
  return out;
}
/** nice axis max + 4 ticks for a chart */
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p, nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10, top = nf * p;
  return { top, ticks: [0, top / 4, top / 2, top * 3 / 4, top] };
}
export const compact = v => { const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : a >= 1e3 ? (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(v)); };

// ---- readable activity ----
const LABEL = {
  created: 'Record created', crm_status: 'Status updated', order_created: 'Order created', order_confirmed: 'Order confirmed', po_created: 'Client PO created', po_edited: 'Client PO edited', po_submitted: 'Client PO submitted', po_approved: 'Client PO approved', po_rejected: 'Client PO rejected',
  pi_created: 'Proforma invoice created', proforma_sent: 'Proforma invoice sent to the client', quote_sent: 'Quote sent', request_entered_by_staff: 'Request entered', request_initiated_by_staff: 'Request started for a client',
  payment_submitted: 'Client payment submitted', payment_confirmed: 'Client payment confirmed', payment_edited: 'Client payment edited', status_deposit_paid: 'Order status changed to Deposit paid',
  shipment_created: 'Shipment created', shipment_deleted: 'Shipment deleted', shipment_linked: 'Shipment linked', export_declared: 'Export declaration recorded', freight_cost_edited: 'Freight cost updated',
  freight_quote_requested: 'Freight quote requested', freight_quote_received: 'Freight quote received', freight_quote_booked: 'Freight booked',
  documents_uploaded: 'Documents uploaded', documents_sent: 'Documents sent', margin_override: 'Margin override approved',
  product_created_from_pi: 'Product created from a supplier PI', product_deleted: 'Product deleted', product_approved: 'Supplier product approved', product_returned: 'Supplier product sent back', product_submitted: 'Supplier product submitted', product_update_applied: 'Product update applied', product_bulk_upload: 'Products uploaded', products_imported: 'Products imported',
  product_edit_requested: 'Product edit requested', product_edit_released: 'Product opened for editing', product_edit_declined: 'Product edit declined',
  rfq_created: 'RFQ created', rfq_sent: 'RFQ sent to suppliers', rfq_quantity_changed: 'RFQ quantity changed',
  supplier_invited: 'Supplier invited', invite_accepted: 'Invitation accepted', changes_approved: 'Client changes approved', changes_declined: 'Client changes declined', changes_withdrawn: 'Client changes withdrawn',
  supplier_pos_created: 'Supplier PO created', supplier_po_sent: 'Supplier PO sent', supplier_po_reply: 'Supplier reply received', supplier_po_linked: 'Supplier PO linked to an order',
  supplier_pi_saved: 'Supplier PI saved', supplier_pi_approved: 'Supplier PI approved', supplier_payment_recorded: 'Payment to the supplier recorded',
};
const PO_STATUS = { sent: 'sent', confirmed: 'confirmed', declined: 'declined', cancelled: 'cancelled', replied: 'marked as replied' };
const ROUTE = { request: 'sourcing', order: 'orders', shipment: 'logistics/shipments', quote: 'pricing/quotes', product: 'products', supplier: 'suppliers' };
export const activityHref = e => (ROUTE[e.entity_type] && e.entity_id ? `/admin/${ROUTE[e.entity_type]}/${e.entity_id}` : null);
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
/** { text, record, href } — a sentence a person can read; the audit row itself is untouched */
export function describeActivity(e) {
  const note = clean(e.detail?.note);
  let text = LABEL[e.action];
  if (e.action === 'supplier_po_status') { const m = note.match(/:\s*(\w+)$/); text = `Supplier PO ${PO_STATUS[m?.[1]] || 'updated'}`; }
  if (!text) text = clean(e.action).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  let record = note;
  if (e.action === 'supplier_po_status') record = note.replace(/:\s*\w+$/, '');
  if (e.action === 'supplier_po_sent') record = note.split('→')[0].trim();
  if (e.action === 'supplier_pi_saved' || e.action === 'supplier_payment_recorded') record = note.split(':')[0].trim();
  if (record.length > 48) record = record.slice(0, 46) + '…';
  return { text, record, href: activityHref(e) };
}
/** merge consecutive identical entries ("Product created ×3") and cap the list */
export function groupActivity(rows, limit = 8) {
  const out = [];
  for (const e of rows) {
    const d = describeActivity(e), last = out[out.length - 1], who = e.who || e.profiles?.full_name || e.profiles?.email || '';
    if (last && last.text === d.text && last.who === who) { last.n++; if (last.record !== d.record) last.record = ''; continue; }
    out.push({ ...d, n: 1, who, at: e.created_at });
  }
  return out.slice(0, limit);
}
