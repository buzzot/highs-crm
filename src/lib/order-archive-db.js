// Loads everything an order archive needs, builds it, and returns the zip. Uses the (scoped) admin client.
import { admin } from './supabase.js';
import { getCompany, piPdf, poPdf, ciPdf, ciNo, packingListPdf } from './purchase.js';
import { spoPdf } from './purchasing.js';
import { packingData } from './packing-store.js';
import { downloadDocument } from './storage.js';
import { planArchive, summaryText, safeName } from './order-archive.js';
import { createZip } from './zip.js';
import { reportPdf } from './order-report-pdf.js';
import { buildReport } from './order-report.js';
import { defaultCurrency } from './currency.js';
import { getSettings } from './util.js';

const rows = r => r?.data || [];

export async function loadOrderData(id) {
  const { data: order } = await admin.from('order_overview').select('*').eq('id', id).maybeSingle();
  if (!order) return null;
  const [pay, ships, pis, pos, spos, own] = await Promise.all([
    admin.from('order_payments').select('*').eq('order_id', id).order('created_at'),
    admin.from('shipments').select('*, forwarders(name)').eq('order_id', id).order('created_at'),
    admin.from('proforma_invoices').select('*').eq('order_id', id).order('created_at', { ascending: false }),
    admin.from('purchase_orders').select('*, organizations(id, name), requests(id, ref, title), quotes(id, status, quantity, unit_price, sell_currency, unit_cost, fx_rate, margin_pct, product_id, supplier_id, lead_time_days, incoterm, request_item_id)').eq('order_id', id),
    admin.from('supplier_pos').select('*, suppliers(*)').eq('order_id', id).order('created_at'),
    admin.from('orders').select('owner_id, created_by').eq('id', id).maybeSingle(),
  ]);
  const shipments = rows(ships), shipIds = shipments.map(s => s.id);
  const { data: costs } = shipIds.length ? await admin.from('freight_costs').select('*').in('shipment_id', shipIds) : { data: [] };
  const sposRows = rows(spos);
  const poIds = sposRows.map(x => x.id);
  const [{ data: spisRows }, { data: spayRows }] = poIds.length ? await Promise.all([
    admin.from('supplier_pis').select('*').in('po_id', poIds).order('created_at'),            // empty before migration 0037
    admin.from('supplier_payments').select('*').in('po_id', poIds).order('created_at'),
  ]) : [{ data: [] }, { data: [] }];
  const supOf = new Map(sposRows.map(x => [x.id, x.suppliers]));
  const supPays = (spayRows || []).map(x => ({ ...x, suppliers: supOf.get(x.po_id) || null }));
  const spis = spisRows || [];
  const fileIds = [...spis.flatMap(x => x.file_doc_ids || []), ...supPays.flatMap(x => x.proof_doc_ids || [])];
  const { data: responses } = sposRows.length ? await admin.from('supplier_po_responses').select('*').in('po_id', sposRows.map(x => x.id)) : { data: [] };
  const replyIds = [...new Set((responses || []).flatMap(x => (x.extracted?.files || []).map(f => f.id)))];
  const costIds = (costs || []).map(c => c.id);
  const ors = [`and(entity_type.eq.order,entity_id.eq.${id})`];
  if (shipIds.length) ors.push(`and(entity_type.eq.shipment,entity_id.in.(${shipIds.join(',')}))`);
  if (costIds.length) ors.push(`and(entity_type.eq.freight_cost,entity_id.in.(${costIds.join(',')}))`);
  if (replyIds.length) ors.push(`id.in.(${replyIds.join(',')})`);
  const { data: docs } = await admin.from('documents').select('*').or(ors.join(','));
  const ownerIds = [own.data?.owner_id, own.data?.created_by].filter(Boolean);
  const { data: staff } = ownerIds.length ? await admin.from('profiles').select('id, full_name, email').in('id', ownerIds) : { data: [] };
  return { order: { ...order, ...(own.data || {}) }, payments: rows(pay), supPays, spis, shipments, costs: costs || [], pis: rows(pis), pos: rows(pos), spos: sposRows, responses: responses || [], docs: docs || [], staff: staff || [] };
}

/** → { name, buffer, missing, count } */
export async function buildOrderArchive(id, { prefix = '', data: preloaded } = {}) {
  const d = preloaded || await loadOrderData(id);
  if (!d) return null;
  const [company, pack, cur, settings] = await Promise.all([getCompany(admin), packingData(id), defaultCurrency(admin), getSettings(admin)]);
  const o = d.order;
  d.packRows = pack.rows.length;
  const gen = {
    pi: p => piPdf(p, o, company), po: p => poPdf(p, company), spo: p => spoPdf(p, { supplier: p.suppliers, order: o, company }),
    pl: () => packingListPdf({ company, order: pack.order || o, info: pack.info, rows: pack.rows, t: pack.t, no: o.order_no }),
    ci: (pi, s) => ciPdf(pi, o, company, { shipment: s, info: pack.info, no: ciNo(pi) }),
  };
  const { entries, missing } = planArchive(d, gen);
  const files = [];
  for (let i = 0; i < entries.length; i += 6) {   // a few downloads at a time
    const batch = entries.slice(i, i + 6);
    const done = await Promise.all(batch.map(async e => {
      if (e.data) return { name: prefix + e.path, data: e.data };
      const doc = d.docs.find(x => x.id === e.docId);
      try { return { name: prefix + e.path, data: await downloadDocument(doc.storage_path) }; }
      catch (err) { missing.push(`Could not read ${doc.title}: ${err.message}`); return null; }
    }));
    files.push(...done.filter(Boolean));
  }
  const rep = buildReport({ orders: [{ ...o }], pays: d.payments, pos: d.spos.map(p => ({ order_id: o.id, total: p.total, currency: p.currency, status: p.status, suppliers: p.suppliers, sent_at: p.sent_at, confirmed_at: p.confirmed_at })), supPays: d.supPays.map(x => ({ ...x, order_id: o.id })), ships: d.shipments.map(s => ({ id: s.id, order_id: o.id, forwarders: s.forwarders })), costs: d.costs, staff: d.staff, settings, cur });
  files.unshift({ name: prefix + 'Report ' + safeName(o.order_no) + '.pdf', data: reportPdf({ row: rep.rows[0], company, cur, settings }) });
  files.push({ name: prefix + '_summary.txt', data: summaryText(o, entries, missing) });
  return { name: `${safeName(o.order_no)} - ${safeName(o.client_name || '', 50)}`.replace(/ - $/, ''), files, missing, count: files.length };
}

export const zipOrder = async (id) => { const a = await buildOrderArchive(id); return a && { name: a.name + '.zip', buffer: createZip(a.files), missing: a.missing }; };
