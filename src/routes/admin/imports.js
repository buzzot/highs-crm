// Product import: upload → automatic extraction → admin review & confirmation → save.
// Nothing is written to suppliers/products until the admin presses "Import".
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { back, notFound, CURRENCIES } from '../../lib/util.js';
import { readXlsx, workbookToText } from '../../lib/xlsx-read.js';
import { addUsage } from '../../lib/ai-usage.js';
import { parseWorkbook, cleanProduct, checkRow, matchSupplier, matchProduct, toProductRecord, cartonCbm, PRODUCT_FIELDS } from '../../lib/product-import.js';
import { aiEnabled, extractProducts, reviewProducts } from '../../lib/ai.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const BUCKET = 'documents';
const SUPPLIER_FIELDS = ['name', 'address', 'contact_name', 'email', 'phone', 'wechat', 'website'];
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', emf: 'image/emf', wmf: 'image/wmf' };
const s = v => (v == null ? '' : String(v).trim());

// tiny CSV reader (quoted fields, comma / semicolon / tab)
function readCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return { sheets: [{ name: 'CSV', rows: rows.map(rw => rw.map(c => (c === '' ? undefined : c))), images: [] }] };
}

async function allSuppliers() {
  const { data } = await admin.from('suppliers').select('id, name, city, email, phone, wechat, contact_name, address, website').order('name');
  return data || [];
}

// ---------------- upload page ----------------
r.get('/', async (req, res) => {
  const { data: imports } = await admin.from('product_imports')
    .select('id, file_name, method, status, supplier, rows, result, created_at, committed_at, profiles!product_imports_created_by_fkey(full_name, email)')
    .order('created_at', { ascending: false }).limit(25);
  res.render('admin/products/import', { title: 'Import products', imports: imports || [], ai: aiEnabled() });
});

r.post('/', upload.single('file'), async (req, res) => {
  const f = req.file;
  // started from a supplier's page: errors go back there, and the supplier is already known
  const fixedSupplier = /^[0-9a-f-]{36}$/i.test(req.body.supplier_id || '') ? req.body.supplier_id : null;
  const home = fixedSupplier ? `/admin/suppliers/${fixedSupplier}` : '/admin/products/import';
  if (!f) return back(res, home, { err: 'Choose a file to import.' });
  const ext = (f.originalname.split('.').pop() || '').toLowerCase();
  const id = randomUUID();
  let method = 'template', supplier = {}, rows = [], notes = [], model = null;
  const usages = []; // [label, usage] per AI call, reported on the review page
  const rowImages = {}; // row index → { data, ext }

  try {
    if (ext === 'xls') throw new Error('Old .xls format — open the file in Excel/WPS and "Save as" .xlsx, then upload again.');
    if (['xlsx', 'xlsm', 'csv', 'txt'].includes(ext)) {
      const wb = ext === 'csv' || ext === 'txt' ? readCsv(f.buffer.toString('utf8').replace(/^﻿/, '')) : readXlsx(f.buffer);
      const parsed = parseWorkbook(wb);
      if (parsed?.template) {
        method = 'template'; supplier = parsed.supplier; rows = parsed.products;
      } else if (aiEnabled()) {
        method = 'ai';
        const ai = await extractProducts({ text: workbookToText(wb), filename: f.originalname }, { type: 'product_import', id });
        model = ai.model; supplier = ai.supplier; rows = ai.products; if (ai.notes) notes.push(ai.notes); usages.push(['reading the file', ai.usage]);
        // pictures: take them from the sheet that has the products' rows
        const pics = {};
        for (const sh of wb.sheets) for (const img of sh.images) pics[img.row + 1] ||= img;
        rows.forEach(p => { if (p.source_row && pics[p.source_row]) p.image = { data: pics[p.source_row].data, ext: pics[p.source_row].ext }; });
        if (!rows.length && parsed?.products.length) { method = 'spreadsheet'; supplier = parsed.supplier; rows = parsed.products; }
      } else if (parsed) {
        method = 'spreadsheet'; supplier = parsed.supplier; rows = parsed.products;
        notes.push('Read with column matching (AI not configured). Check that every column landed in the right field.');
      } else {
        throw new Error('No product table found. Use the Lumi Trade template, or set ANTHROPIC_API_KEY so AI can read free-form files.');
      }
    } else if (ext === 'pdf' || IMG_TYPES[ext]) {
      if (!aiEnabled()) throw new Error('Reading PDFs and photos needs AI — set ANTHROPIC_API_KEY in Railway, or use the Excel template.');
      method = 'ai';
      const ai = await extractProducts(ext === 'pdf'
        ? { pdf: f.buffer, filename: f.originalname }
        : { image: { data: f.buffer, mediaType: IMG_TYPES[ext] === 'image/jpeg' ? 'image/jpeg' : IMG_TYPES[ext] }, filename: f.originalname }, { type: 'product_import', id });
      model = ai.model; supplier = ai.supplier; rows = ai.products; if (ai.notes) notes.push(ai.notes); usages.push(['reading the file', ai.usage]);
      if (ext === 'pdf') notes.push('Photos are not taken from PDFs — add them on the product pages after import, or ask the supplier for the Excel template.');
    } else {
      throw new Error(`Unsupported file type .${ext}. Use .xlsx, .csv, .pdf or a photo (.jpg/.png).`);
    }
  } catch (e) {
    console.error('[import]', e);
    return back(res, home, { err: e.message });
  }
  if (!rows.length) return back(res, home, { err: 'No products found in this file.' });

  // keep the original file and row photos in storage (under imports/<id>/)
  const filePath = `imports/${id}/original.${ext}`;
  await admin.storage.from(BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: true });
  const clean = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const p = { ...cleanProduct(raw), source_row: raw.source_row || null, page: raw.page || null, include: true, image_path: null };
    const img = raw.image;
    if (img && IMG_TYPES[img.ext] && !['emf', 'wmf'].includes(img.ext)) {
      const path = `imports/${id}/row-${i}.${img.ext}`;
      const { error } = await admin.storage.from(BUCKET).upload(path, img.data, { contentType: IMG_TYPES[img.ext], upsert: true });
      if (!error) p.image_path = path;
    }
    clean.push(p);
  }

  // supplier duplicate check
  supplier = Object.fromEntries(SUPPLIER_FIELDS.map(k => [k, s(supplier?.[k]) || null]));
  let match = matchSupplier(supplier, await allSuppliers());
  if (fixedSupplier) {
    const { data: fs } = await admin.from('suppliers').select('id, name, city').eq('id', fixedSupplier).maybeSingle();
    if (fs) match = { status: 'match', candidates: [{ id: fs.id, name: fs.name, city: fs.city || null, score: 1, strong: true, reasons: ['imported from this supplier’s page'] }] };
  }

  // AI second opinion on the rows (never blocks the import)
  if (aiEnabled()) {
    try {
      const rv = await reviewProducts({ supplier, products: clean }, { type: 'product_import', id });
      usages.push(['checking the rows', rv.usage]);
      for (const is of rv.issues) if (clean[is.row]) (clean[is.row].ai_issues ||= []).push(is);
      if (rv.summary) notes.push(`AI check: ${rv.summary}`);
    } catch (e) { notes.push(`AI check skipped: ${e.message}`); }
  }

  if (usages.length) {
    const total = addUsage(...usages.map(x => x[1]));
    notes.push(`AI usage: ${usages.map(([l, u]) => `${l} ${Number(u?.total || 0).toLocaleString('en-US')} tokens`).join(' · ')} — total ${res.locals.aiLine(total)}`);
  }
  const { error } = await admin.from('product_imports').insert({
    id, file_name: f.originalname, file_path: filePath, method, supplier, supplier_match: match, rows: clean,
    ai_notes: notes.join('\n') || null, ai_model: model, created_by: req.user.id,
  });
  if (error) return back(res, '/admin/products/import', { err: error.message });
  res.redirect(`/admin/products/import/${id}`);
});

// ---------------- review ----------------
async function loadImport(id) {
  const { data } = await admin.from('product_imports').select('*').eq('id', id).single();
  return data;
}

r.get('/:iid', async (req, res) => {
  const imp = await loadImport(req.params.iid);
  if (!imp) return notFound(res, 'Import');
  const suppliers = await allSuppliers();
  const candIds = (imp.supplier_match?.candidates || []).map(c => c.id);
  const { data: existing } = candIds.length
    ? await admin.from('products').select('id, name, supplier_sku, unit_cost, cost_currency, supplier_id').in('supplier_id', candIds)
    : { data: [] };
  const bySupplier = {};
  for (const p of existing || []) (bySupplier[p.supplier_id] ||= []).push(p);
  const decision = imp.supplier?._decision || (imp.supplier_match?.status === 'match' ? imp.supplier_match.candidates[0].id : imp.supplier_match?.status === 'new' ? 'new' : '');
  const rows = imp.rows.map((p, i) => {
    let match = { status: 'none' };
    for (const sid of decision && decision !== 'new' ? [decision] : candIds) {
      const m = matchProduct(p, bySupplier[sid] || []);
      if (m.status !== 'none') { match = { ...m, supplier_id: sid, supplier_name: suppliers.find(x => x.id === sid)?.name }; break; }
    }
    return { ...p, i, match, checks: checkRow(p), cbm: cartonCbm(p) };
  });
  res.render('admin/products/import_review', {
    title: `Import · ${imp.file_name}`, imp, rows, suppliers, decision, currencies: CURRENCIES,
    candidates: imp.supplier_match?.candidates || [], ai: aiEnabled(),
  });
});

r.get('/:iid/image/:n', async (req, res) => {
  const imp = await loadImport(req.params.iid);
  const p = imp?.rows?.[Number(req.params.n)];
  if (!p?.image_path) return res.status(404).send('No image');
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(p.image_path, 600);
  if (!data) return res.status(404).send('No image');
  res.redirect(data.signedUrl);
});

/** Apply the review form to the stored import (keeps edits even if the admin leaves and comes back). */
function applyForm(imp, body) {
  const sup = { ...imp.supplier };
  for (const k of SUPPLIER_FIELDS) if (body.supplier && k in body.supplier) sup[k] = s(body.supplier[k]) || null;
  sup._decision = s(body.supplier_decision) || sup._decision || '';
  sup._update_contacts = body.update_contacts === 'on';
  sup._confirm_new = body.confirm_new === 'on';
  const posted = body.rows || {};
  const rows = imp.rows.map((p, i) => {
    const f = posted[i];
    if (!f) return p;
    const edited = cleanProduct(Object.fromEntries(PRODUCT_FIELDS.map(k => [k, f[k] ?? p[k]])));
    return { ...p, ...edited, include: f.include === 'on', action: s(f.action) || p.action || 'auto', match_id: s(f.match_id) || null, match_supplier_id: s(f.match_supplier_id) || null };
  });
  return { sup, rows };
}

r.post('/:iid', async (req, res) => {
  const imp = await loadImport(req.params.iid);
  if (!imp) return notFound(res, 'Import');
  const url = `/admin/products/import/${imp.id}`;
  if (imp.status !== 'review') return back(res, url, { err: `This import is already ${imp.status}.` });

  if (req.body.action === 'cancel') {
    await admin.from('product_imports').update({ status: 'cancelled' }).eq('id', imp.id);
    return back(res, '/admin/products/import', { msg: `Import of ${imp.file_name} cancelled — nothing was saved.` });
  }
  const { sup, rows } = applyForm(imp, req.body);
  await admin.from('product_imports').update({ supplier: sup, rows }).eq('id', imp.id);
  if (req.body.action !== 'commit') return back(res, url, { msg: 'Changes saved.' });

  // ---------- validate ----------
  const included = rows.map((p, i) => ({ p, i })).filter(x => x.p.include);
  if (!included.length) return back(res, url, { err: 'No products selected.' });
  const bad = included.filter(x => checkRow(x.p).some(c => c.level === 'error'));
  if (bad.length) return back(res, url, { err: `Fix or untick rows ${bad.map(x => x.i + 1).join(', ')} first (missing name or invalid price).` });

  const suppliers = await allSuppliers();
  let supplierId = sup._decision;
  if (!supplierId) return back(res, url, { err: 'Choose whether this is an existing supplier or a new one.' });
  if (supplierId === 'new') {
    if (!sup.name) return back(res, url, { err: 'Enter the supplier company name.' });
    const again = matchSupplier(sup, suppliers);          // re-check with the edited name/contacts
    if (again.status !== 'new' && !sup._confirm_new) {
      const c = again.candidates[0];
      return back(res, url, { err: `"${sup.name}" looks like existing supplier "${c.name}" (${c.reasons.join(', ')}). Pick it, or tick "This is a different company" to create a new one.` });
    }
  } else if (!suppliers.some(x => x.id === supplierId)) {
    return back(res, url, { err: 'The selected supplier no longer exists.' });
  }

  // ---------- supplier ----------
  const supData = Object.fromEntries(SUPPLIER_FIELDS.filter(k => k !== 'name' || supplierId === 'new').map(k => [k, sup[k]]));
  if (supplierId === 'new') {
    const { data, error } = await admin.from('suppliers').insert({ ...supData, name: sup.name, country: 'China' }).select('id').single();
    if (error) return back(res, url, { err: error.message });
    supplierId = data.id;
  } else {
    const cur = suppliers.find(x => x.id === supplierId);
    const patch = {};
    for (const [k, v] of Object.entries(supData)) if (v && (sup._update_contacts || !cur[k])) patch[k] = v;
    if (Object.keys(patch).length) await admin.from('suppliers').update(patch).eq('id', supplierId);
  }

  // ---------- products ----------
  const { data: existing } = await admin.from('products').select('id, name, supplier_sku').eq('supplier_id', supplierId);
  const result = { supplier_id: supplierId, created: 0, updated: 0, skipped: 0, photos: 0, product_ids: [] };
  for (const { p } of included) {
    let action = p.action || 'auto';
    let targetId = p.match_supplier_id === supplierId ? p.match_id : null;
    if (action === 'auto') {                                          // decide like the review page did
      const m = matchProduct(p, existing || []);
      targetId = m.status !== 'none' ? m.product.id : null;
      action = targetId ? 'update' : 'new';
    }
    if (action === 'skip') { result.skipped++; continue; }
    const rec = toProductRecord(p, supplierId);
    let pid;
    if (action === 'update' && targetId) {
      const patch = Object.fromEntries(Object.entries(rec).filter(([, v]) => v != null));
      const { error } = await admin.from('products').update(patch).eq('id', targetId);
      if (error) return back(res, url, { err: `Row "${p.name}": ${error.message}` });
      pid = targetId; result.updated++;
    } else {
      const { data, error } = await admin.from('products').insert(rec).select('id').single();
      if (error) return back(res, url, { err: `Row "${p.name}": ${error.message}` });
      pid = data.id; result.created++;
      (existing || []).push({ id: pid, name: rec.name, supplier_sku: rec.supplier_sku });   // later duplicate rows in the same file update it
    }
    result.product_ids.push(pid);
    if (p.image_path) {
      const ext = p.image_path.split('.').pop();
      const dest = `product/${pid}/${randomUUID()}.${ext}`;
      const { error } = await admin.storage.from(BUCKET).copy(p.image_path, dest);
      if (!error) {
        await admin.from('documents').insert({ entity_type: 'product', entity_id: pid, kind: 'product_photo', title: `${p.supplier_sku || p.name}.${ext}`,
          storage_path: dest, mime_type: IMG_TYPES[ext] || 'image/png', client_visible: true, uploaded_by: req.user.id });
        result.photos++;
      }
    }
  }
  await admin.from('product_imports').update({ status: 'committed', result, committed_at: new Date().toISOString(), committed_by: req.user.id }).eq('id', imp.id);
  await log({ entityType: 'supplier', entityId: supplierId, action: 'products_imported', actorId: req.user.id,
    detail: { note: `${result.created} new, ${result.updated} updated from ${imp.file_name}` } });
  back(res, `/admin/suppliers/${supplierId}`, { msg: `Imported from ${imp.file_name}: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped, ${result.photos} photos.` });
});

export default r;
