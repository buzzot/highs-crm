// Live quote calculator. Uses the same pricing module as the server (served at /js/pricing.js).
import { calcQuote, marginFromPrice } from '/js/pricing.js';

const form = document.getElementById('calcForm');
if (form) {
  const $ = id => document.getElementById(id);
  const data = JSON.parse($('pricingData').textContent);
  const minMargin = Number(form.dataset.minMargin || 20);
  const money = (v, cur, d = 2) => (Number.isFinite(v) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(v) : '—');
  const fxFor = (from, to) => {
    if (from === to) return 1;
    if (data.fx[`${from}_${to}`]) return Number(data.fx[`${from}_${to}`]);
    if (data.fx[`${to}_${from}`]) return 1 / Number(data.fx[`${to}_${from}`]);
    return null;
  };
  const product = () => data.products.find(p => p.id === $('f_product').value);
  const request = () => data.requests.find(r => r.id === $('f_request').value);
  const item = () => { const r = request(); const sel = $('f_item'); return r && sel ? (r.items || []).find(i => i.id === sel.value) : null; };
  const target = () => { const r = request(); const it = item(); return it?.target_unit_price != null ? { price: it.target_unit_price, cur: r.target_currency } : r?.target_unit_price ? { price: r.target_unit_price, cur: r.target_currency } : null; };

  function render() {
    const scur = $('f_scur').value;
    const c = calcQuote({
      unitCost: $('f_cost').value, fxRate: $('f_fx').value, marginPct: $('f_margin').value, quantity: $('f_qty').value,
      freightTotal: $('f_freight').value, dutiesTotal: $('f_duties').value, otherTotal: $('f_other').value, minMarginPct: minMargin,
    });
    $('r_unit').textContent = money(c.unitPrice, scur, 4);
    $('r_landed').textContent = money(c.landedUnitPrice, scur, 4);
    $('r_ucs').textContent = money(c.unitCostSell, scur, 4);
    $('r_lpu').textContent = money(c.logisticsPerUnit, scur, 4);
    $('r_goods').textContent = money(c.goodsTotal, scur);
    $('r_costtot').textContent = money(c.costTotal, scur);
    $('r_profit').textContent = money(c.grossProfit, scur);
    $('r_landedtot').textContent = money(c.landedTotal, scur);
    const m = $('r_margin');
    m.textContent = `Margin ${c.marginPct}% ${c.meetsMinimum ? '✓' : `— below ${minMargin}% minimum`}`;
    m.className = 'marginbadge ' + (c.meetsMinimum ? 'ok' : 'bad');
    const t = target();
    if (t) {
      const diff = c.landedUnitPrice - Number(t.price);
      $('r_target').textContent = `${money(Number(t.price), t.cur, 4)} (${diff > 0 ? '+' : ''}${money(diff, scur, 4)} landed)`;
      $('r_target').className = diff > 0 ? 'bad' : 'ok';
    } else { $('r_target').textContent = '—'; $('r_target').className = ''; }
    const p = product();
    const qty = Number($('f_qty').value || 0);
    $('moqHint').textContent = p?.moq ? (qty && qty < p.moq ? `below MOQ ${p.moq}` : `MOQ ${p.moq}`) : '';
    $('moqHint').className = 'hint ' + (p?.moq && qty && qty < p.moq ? 'bad' : '');
    const warn = [...c.warnings];
    if (p?.moq && qty && qty < p.moq) warn.push(`Quantity is below the supplier MOQ (${p.moq}).`);
    $('r_warn').innerHTML = '';
    warn.forEach(w => { const li = document.createElement('li'); li.textContent = w; $('r_warn').appendChild(li); });
  }

  function syncFx() {
    const fx = fxFor($('f_ccur').value, $('f_scur').value);
    if (fx) $('f_fx').value = Math.round(fx * 1e6) / 1e6;
  }

  // the supplier belongs to the product: take it from there and lock it
  function lockSupplier(p) {
    const sel = $('f_supplier'), note = $('f_supplier_note'), lock = !!(p && p.supplier_id);
    if (lock) sel.value = p.supplier_id;
    sel.classList.toggle('locked', lock); sel.tabIndex = lock ? -1 : 0;
    if (note) note.hidden = !lock;
  }
  let lastProduct = $('f_product').value;
  $('f_product').addEventListener('change', () => {
    if ($('f_product').value === '__new__') { $('f_product').value = lastProduct; openNew(); return; }
    lastProduct = $('f_product').value;
    const p = product();
    lockSupplier(p);
    if (p) {
      if (p.unit_cost != null) $('f_cost').value = p.unit_cost;
      $('f_ccur').value = p.cost_currency || 'CNY';
      if (!$('f_qty').value && p.moq) $('f_qty').value = p.moq;
      syncFx(); syncLead();
    }
    render();
  });
  function fillItems() {
    const sel = $('f_item'), wrap = $('f_item_wrap'); if (!sel) return;
    const r = request(), items = r?.items || [];
    sel.innerHTML = '<option value="">— whole request —</option>';
    items.forEach(i => { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name + (i.quantity ? ` · ${i.quantity} ${i.unit || 'pcs'}` : ''); sel.appendChild(o); });
    if (items.length === 1) sel.value = items[0].id;
    wrap.hidden = !items.length;
  }
  const irqSync = () => { const box = $('irq_box'); if (box) box.hidden = $('f_request').value !== '__irq__'; };
  $('f_request').addEventListener('change', () => {
    irqSync();
    fillItems();
    const r = request(), it = item();
    if (r) { const qty = it?.quantity || r.quantity; if (qty) $('f_qty').value = qty; if (r.target_currency) { $('f_scur').value = r.target_currency; syncFx(); } }
    render();
  });
  if ($('f_item')) $('f_item').addEventListener('change', () => { const it = item(); if (it?.quantity) $('f_qty').value = it.quantity; render(); });
  function syncLead() {
    const opt = $('f_supplier').selectedOptions[0];
    if (opt?.dataset.lead && !$('f_lead').value) $('f_lead').value = opt.dataset.lead;
  }
  $('f_supplier').addEventListener('change', syncLead);
  $('f_ccur').addEventListener('change', () => { syncFx(); render(); });
  $('f_scur').addEventListener('change', () => { syncFx(); render(); });
  $('f_target').addEventListener('input', () => {
    const m = marginFromPrice({ unitCost: $('f_cost').value, fxRate: $('f_fx').value, targetUnitPrice: $('f_target').value });
    if (m != null && $('f_target').value) $('f_margin').value = m;
    render();
  });
  form.addEventListener('input', e => { if (e.target.id !== 'f_target') render(); });

  // freight helper: carton data × quantity → freight estimate
  $('h_apply')?.addEventListener('click', () => {
    const p = product();
    const qty = Number($('f_qty').value || 0);
    const rate = Number($('h_rate').value || 0);
    const mode = $('h_mode').value;
    let note = '';
    if (rate && p?.carton_qty && qty) {
      const cartons = Math.ceil(qty / p.carton_qty);
      const cbm = cartons * Number(p.carton_cbm || 0);
      const kg = p.unit_weight_kg ? qty * Number(p.unit_weight_kg) : 0;
      let freight;
      if (mode === 'cbm') freight = Math.max(1, cbm) * rate;
      else if (mode === 'fcl') freight = Math.ceil(cbm / 28) * rate;
      else freight = Math.max(kg, cbm * 167) * rate;
      $('f_freight').value = Math.round(freight * 100) / 100;
      note = `${cartons} cartons · ${cbm.toFixed(2)} cbm · ${kg.toFixed(0)} kg`;
    } else if (rate) note = 'Pick a product with carton size and enter quantity to estimate.';
    const duty = Number($('h_duty').value || 0);
    if (duty) {
      const c = calcQuote({ unitCost: $('f_cost').value, fxRate: $('f_fx').value, marginPct: $('f_margin').value, quantity: qty });
      $('f_duties').value = Math.round((c.goodsTotal + Number($('f_freight').value || 0)) * duty) / 100;
      note += (note ? ' · ' : '') + `duty ${duty}% on CIF value`;
    }
    $('h_note').textContent = note || $('h_note').textContent;
    render();
  });

  // AI check without saving
  $('aiCheck')?.addEventListener('click', async () => {
    const box = $('aiBox');
    box.className = 'ai'; box.textContent = 'Checking…';
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch('/admin/pricing/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const r = await res.json();
      box.innerHTML = '';
      const h = document.createElement('div'); h.className = 'aiscore ' + (r.ok ? 'ok' : 'warn');
      h.innerHTML = `<span class="n"></span><span></span>`; h.children[0].textContent = r.score; h.children[1].textContent = r.ok ? 'Looks good' : 'Needs attention';
      box.appendChild(h);
      if (r.summary) { const p = document.createElement('p'); p.textContent = r.summary; box.appendChild(p); }
      const ul = document.createElement('ul'); ul.className = 'issues';
      (r.issues || []).forEach(i => { const li = document.createElement('li'); li.className = i.severity; li.textContent = `${i.severity.toUpperCase()} · ${i.field} — ${i.message}`; ul.appendChild(li); });
      box.appendChild(ul);
      if (r.usage_line) { const u = document.createElement('p'); u.className = 'muted small ailine'; u.textContent = r.usage_line; box.appendChild(u); }
    } catch (e) { box.textContent = 'AI check failed: ' + e.message; }
  });

  render();

  // quick-add a product without leaving the quote
  const dlg = $('newProdDlg');
  function openNew() {
    if (!dlg) return;
    const r = request(), it = item() || (r?.items || [])[0];
    $('np_name').value = it?.name || ''; $('np_sku').value = ''; $('np_cost').value = ''; $('np_moq').value = '';
    $('np_supplier').value = $('f_supplier').value || ''; $('np_err').hidden = true;
    dlg.showModal(); $('np_name').focus();
  }
  if (dlg) {
    $('np_cancel').addEventListener('click', () => dlg.close());
    $('np_save').addEventListener('click', async () => {
      const btn = $('np_save'), err = $('np_err');
      const name = $('np_name').value.trim();
      if (!name) { err.textContent = 'Enter a product name.'; err.hidden = false; return; }
      btn.disabled = true; err.hidden = true;
      try {
        const res = await fetch('/admin/products/quick', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ name, sku: $('np_sku').value, supplier_id: $('np_supplier').value, unit_cost: $('np_cost').value, cost_currency: $('np_ccur').value, moq: $('np_moq').value }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Could not add the product.');
        data.products.push(j);
        const o = document.createElement('option'); o.value = j.id; o.textContent = j.name + (j.sku ? ' · ' + j.sku : '');
        const sel = $('f_product'); sel.insertBefore(o, sel.options[2] || null);
        sel.value = j.id; dlg.close();
        sel.dispatchEvent(new Event('change'));
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      btn.disabled = false;
    });
  }
  { const p0 = product(), s0 = $('f_supplier').value; if (p0 && p0.supplier_id && (!s0 || s0 === p0.supplier_id)) lockSupplier(p0); }
}

