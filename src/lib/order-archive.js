// Plans the contents of an order archive (zip): Client / Supplier / Logistics folders, readable file names, and a list of what is missing.
// Pure: the caller loads the data and supplies generators for PDFs that were never stored.

const BAD = /[\\/:*?"<>|\u0000-\u001f]/g;
export const safeName = (s, max = 140) => String(s ?? '').replace(BAD, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, max).trim();
export const extOf = (name, mime) => {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return '.' + m[1].toLowerCase();
  return ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'text/plain': '.txt' })[mime] || '';
};
const stripExt = n => String(n || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
export const isoDay = v => (v ? new Date(v).toISOString().slice(0, 10) : '');
const words = (...x) => x.filter(v => v != null && String(v).trim() !== '').join(' ');

const KIND_LABEL = { commercial_invoice: 'Commercial invoice', packing_list: 'Packing list', bill_of_lading: 'Bill of lading', airway_bill: 'Airway bill', export_declaration: 'Export declaration',
  certificate: 'Certificate', qc_report: 'QC report', cargo_photo: 'Cargo photo', cargo_draft: 'Cargo draft', proforma_invoice: 'Proforma invoice', packing_photo: 'Packing photo' };

/**
 * d: { order, company, payments, supPays, docs, shipments, costs, pis, pos, spos, responses, packRows }
 * gen: { pi(row), po(row), spo(row), pl(), ci(pi, shipment) } → Buffer
 * Returns { entries: [{ path, docId? , data? }], missing: string[], used: Set }
 */
export function planArchive(d, gen = {}) {
  const no = d.order.order_no;
  const docs = d.docs || [], byId = new Map(docs.map(x => [x.id, x]));
  const entries = [], missing = [], taken = new Set(), used = new Set();
  const put = (folder, base, doc, buf) => {
    const ext = doc ? extOf(doc.title, doc.mime_type) || extOf(doc.storage_path) : '.pdf';
    const stem = safeName(base) || 'file';
    let path = `${folder}/${stem}${ext}`, n = 1;
    while (taken.has(path.toLowerCase())) path = `${folder}/${stem} (${++n})${ext}`;
    taken.add(path.toLowerCase());
    entries.push(doc ? { path, docId: doc.id } : { path, data: buf });
    if (doc) used.add(doc.id);
  };
  const docsOf = (type, id, f = () => true) => docs.filter(x => x.entity_type === type && x.entity_id === id && f(x));

  // ---------- Client ----------
  const orderDocs = docs.filter(x => x.entity_type === 'order' && x.entity_id === d.order.id);
  const storedPi = orderDocs.filter(x => x.kind === 'proforma_invoice');
  if (storedPi.length) storedPi.forEach(x => put('Client', x.title && /^proforma/i.test(x.title) ? x.title : words('Proforma invoice', no), x));
  else if ((d.pis || []).length && gen.pi) (d.pis || []).slice(0, 1).forEach(p => put('Client', words('Proforma invoice', p.pi_no), null, gen.pi(p)));
  else missing.push('Client: no proforma invoice');
  (d.pos || []).forEach(p => { if (gen.po) put('Client', words('Client PO', p.po_no), null, gen.po(p)); });
  if (!(d.pos || []).length) missing.push('Client: no purchase order from the client');
  // packing list for the client: the stored one (latest) else built from the packing lines
  const shipPl = (d.shipments || []).flatMap(s => docsOf('shipment', s.id, x => x.kind === 'packing_list')).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (shipPl.length) put('Client', words('Packing list', no), shipPl[0]);
  else if (d.packRows > 0 && gen.pl) put('Client', words('Packing list', no), null, gen.pl());
  else missing.push('Client: no packing list');
  const clientPays = (d.payments || []).filter(p => p.status !== 'rejected');
  clientPays.forEach(p => {
    const files = (p.proof_doc_ids || []).map(i => byId.get(i)).filter(Boolean);
    if (!files.length) missing.push(`Client: no proof for payment ${words(p.label, isoDay(p.paid_on || p.created_at))}`);
    files.forEach(f => put('Client', words('Payment for', no, p.label, p.reference, isoDay(p.paid_on || p.created_at)), f));
  });
  if (!clientPays.length) missing.push('Client: no payments recorded');

  // ---------- Supplier ----------
  (d.spos || []).filter(p => p.status !== 'cancelled').forEach(p => { if (gen.spo) put('Supplier', words('Purchase order', p.ref), null, gen.spo(p)); });
  const replyFiles = [...new Set((d.responses || []).flatMap(x => (x.extracted?.files || []).map(f => f.id)))].map(i => byId.get(i)).filter(Boolean);
  replyFiles.forEach(f => put('Supplier', words(stripExt(f.title), no), f));
  let anyInvoice = replyFiles.length > 0;
  (d.spis || []).forEach(pi => (pi.file_doc_ids || []).map(i => byId.get(i)).filter(Boolean).forEach(f => { anyInvoice = true; put('Supplier', words(stripExt(f.title), no), f); }));
  if (!(d.spis || []).length) missing.push("Supplier: no supplier PI entered");
  (d.supPays || []).forEach(sp => {
    const sup = sp.suppliers?.name || d.order.supplier_name || 'supplier';
    const inv = (sp.invoice_doc_ids || []).map(i => byId.get(i)).filter(Boolean), prf = (sp.proof_doc_ids || []).map(i => byId.get(i)).filter(Boolean);
    inv.forEach(f => { anyInvoice = true; put('Supplier', words(stripExt(f.title), no), f); });
    if (!prf.length) missing.push(`Supplier: no proof for payment ${words(sp.label, isoDay(sp.paid_on || sp.created_at))}`);
    prf.forEach(f => put('Supplier', words('Payment for', no, sup, sp.label, isoDay(sp.paid_on || sp.created_at)), f));
  });
  if (!anyInvoice) missing.push("Supplier: no supplier invoice uploaded");
  if (!(d.supPays || []).length) missing.push('Supplier: no payments to the supplier recorded');

  // ---------- Logistics ----------
  const ships = d.shipments || [], multi = ships.length > 1;
  ships.forEach((s, i) => {
    const folder = multi ? `Logistics/Shipment ${i + 1}${s.forwarders?.name ? ' - ' + safeName(s.forwarders.name, 40) : ''}` : 'Logistics';
    const fwd = s.forwarders?.name || 'forwarder';
    const sdocs = docsOf('shipment', s.id);
    const count = {};
    sdocs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).forEach(x => {
      const label = KIND_LABEL[x.kind];
      if (!label) { put(folder, words(stripExt(x.title), no), x); return; }
      count[x.kind] = (count[x.kind] || 0) + 1;
      const photo = x.kind === 'cargo_photo' ? ' ' + String(count[x.kind]).padStart(2, '0') : '';
      const titled = x.title && x.title.toLowerCase().startsWith(label.toLowerCase()) && !/\.[a-z0-9]{2,4}$/i.test(x.title);
      put(folder, titled ? x.title : words(label + photo, no, !photo && count[x.kind] > 1 ? `(${count[x.kind]})` : ''), x);
    });
    if (!sdocs.some(x => x.kind === 'commercial_invoice') && (d.pis || []).length && gen.ci) put(folder, words('Commercial invoice', no), null, gen.ci(d.pis[0], s));
    if (!sdocs.some(x => x.kind === 'packing_list') && d.packRows > 0 && gen.pl) put(folder, words('Packing list', no), null, gen.pl());
    if (!sdocs.some(x => ['bill_of_lading', 'airway_bill'].includes(x.kind))) missing.push(`Logistics${multi ? ' ' + (i + 1) : ''}: no bill of lading / airway bill`);
    if (s.export_official !== false && !sdocs.some(x => x.kind === 'export_declaration')) missing.push(`Logistics${multi ? ' ' + (i + 1) : ''}: no export declaration`);
    if (!sdocs.some(x => x.kind === 'cargo_photo')) missing.push(`Logistics${multi ? ' ' + (i + 1) : ''}: no photos of the goods`);
    (d.costs || []).filter(c => c.shipment_id === s.id).forEach(c => {
      const cd = docsOf('freight_cost', c.id);
      const invs = cd.filter(x => x.kind !== 'payment_proof'), prfs = cd.filter(x => x.kind === 'payment_proof');
      invs.forEach(f => put(folder, words('Invoice', fwd, c.invoice_ref || c.type, no), f));
      if (!invs.length) missing.push(`Logistics${multi ? ' ' + (i + 1) : ''}: no invoice from ${fwd} for ${words(c.type, c.description)}`);
      prfs.forEach(f => put(folder, words('Payment for', no, fwd, c.type, isoDay(c.paid_at || c.created_at)), f));
      if (c.paid && !prfs.length) missing.push(`Logistics${multi ? ' ' + (i + 1) : ''}: no proof of payment to ${fwd} for ${words(c.type, c.description)}`);
    });
  });
  if (!ships.length) missing.push('Logistics: no shipment on this order');

  // ---------- anything else attached to the order ----------
  orderDocs.filter(x => !used.has(x.id) && !['product_photo', 'proforma_invoice'].includes(x.kind)).forEach(x => put('Other', words(stripExt(x.title), no), x));
  return { entries, missing, used };
}

/** Plain-text summary placed at the top of the archive. */
export function summaryText(order, entries, missing) {
  const L = [`Order ${order.order_no} — ${order.client_name || ''}`, `Archive created ${isoDay(new Date())}`, '', `${entries.length} files:`];
  for (const f of entries.map(e => e.path).sort()) L.push('  ' + f);
  L.push('', missing.length ? 'Missing / not found:' : 'Nothing missing.');
  missing.forEach(m => L.push('  - ' + m));
  return L.join('\n') + '\n';
}
