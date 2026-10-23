// Supplier "Add product" wizard: step navigation, photo drop/paste/preview, container-fit and review summary.
(function () {
  const form = document.getElementById('spwiz'); if (!form) return;
  const panels = [...form.querySelectorAll('.sppanel')], stepBtns = [...form.querySelectorAll('.spstep')];
  const back = document.getElementById('sp_back'), next = document.getElementById('sp_next'), submit = document.getElementById('sp_submit'), intent = document.getElementById('sp_intent');
  const q = n => form.elements[n];
  let cur = 0, seen = 0;

  function show(i, scroll) {
    cur = Math.max(0, Math.min(panels.length - 1, i)); seen = Math.max(seen, cur);
    panels.forEach((p, k) => { p.hidden = k !== cur; });
    stepBtns.forEach((b, k) => { b.classList.toggle('on', k === cur); b.classList.toggle('done', k < seen && k !== cur); });
    back.hidden = cur === 0; next.hidden = cur === panels.length - 1; submit.hidden = cur !== panels.length - 1;
    if (cur === panels.length - 1) refresh();
    if (scroll !== false) form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function needName() { if (!q('name').value.trim()) { show(1); q('name').focus(); q('name').closest('label').classList.add('has-error'); return false; } return true; }
  next.addEventListener('click', () => { if (cur >= 1 && !needName()) return; show(cur + 1); });
  back.addEventListener('click', () => show(cur - 1));
  stepBtns.forEach((b, i) => b.addEventListener('click', () => { if (i > 1 && !needName()) return; show(i); }));
  form.addEventListener('click', e => {
    const go = e.target.closest('[data-go]'); if (go && !go.classList.contains('spstep')) { e.preventDefault(); show(Number(go.dataset.go)); }
    const del = e.target.closest('[data-del]');
    if (del && confirm('Remove this photo?')) { const f = document.createElement('form'); f.method = 'post'; f.action = del.dataset.del; document.body.appendChild(f); f.submit(); }
  });
  document.getElementById('sp_draft').addEventListener('click', () => { intent.value = 'draft'; });
  submit.addEventListener('click', () => { intent.value = 'submit'; });
  form.addEventListener('submit', e => { if (!q('name').value.trim()) { e.preventDefault(); needName(); } });
  // Enter inside a field must not submit the whole wizard
  form.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });

  // ---- photos: choose, drop or paste; previews of what is about to be uploaded ----
  const input = document.getElementById('sp_files'), drop = document.getElementById('sp_drop'), box = document.getElementById('sp_new');
  const OK = /^image\/(jpeg|png|webp)$/; let files = [];
  const room = () => 12 - Number((document.querySelector('[data-sum=photos]') || {}).dataset?.existing || 0);
  function sync() {
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); input.files = dt.files;
    box.innerHTML = '';
    files.forEach((f, i) => {
      const fig = document.createElement('figure'), img = document.createElement('img'), x = document.createElement('button');
      img.src = URL.createObjectURL(f); img.alt = ''; x.type = 'button'; x.className = 'spx'; x.textContent = '×'; x.title = 'Remove';
      x.addEventListener('click', () => { files.splice(i, 1); sync(); }); fig.append(img, x); box.appendChild(fig);
    });
    refresh();
  }
  function add(list) { [...list].filter(f => OK.test(f.type) && f.size <= 20 * 1024 * 1024).forEach(f => { if (files.length < Math.min(10, room())) files.push(f); }); sync(); }
  input.addEventListener('change', () => add(input.files));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => add(e.dataTransfer.files));
  document.addEventListener('paste', e => { if (cur === 0 && e.clipboardData && e.clipboardData.files.length) add(e.clipboardData.files); });

  // ---- container fit ----
  const n = name => Number((q(name) || {}).value) || 0;
  function fit() {
    const t = document.getElementById('sp_fit_t'), l = n('carton_l'), w = n('carton_w'), h = n('carton_h'), qty = n('carton_qty');
    if (!(l > 0 && w > 0 && h > 0 && qty > 0)) { t.textContent = 'Enter the carton size and units per carton to see how many fit.'; return; }
    const cbm = l * w * h / 1e6, f = c => Math.floor(c * 0.85 / cbm) * qty;
    t.textContent = '1 carton = ' + (Math.round(cbm * 10000) / 10000) + ' m³ · about ' + f(28) + ' pcs in a 20GP · ' + f(58) + ' in a 40GP · ' + f(68) + ' in a 40HQ';
  }
  form.querySelectorAll('[data-fit]').forEach(i => i.addEventListener('input', fit));

  // ---- review: what is missing + summary ----
  function refresh() {
    const photos = Number((document.querySelector('[data-sum=photos]') || {}).dataset?.existing || 0) + files.length;
    const miss = [];
    if (!(n('unit_price') > 0)) miss.push(['Unit price', 2]);
    if (!photos && !q('photo_link').value.trim()) miss.push(['Photos or a photo link', 0]);
    if (!(n('carton_qty') > 0 && n('carton_l') > 0 && n('carton_w') > 0 && n('carton_h') > 0)) miss.push(['Carton size and units per carton', 3]);
    if (!(n('gross_kg') > 0)) miss.push(['Carton gross weight', 3]);
    const m = document.getElementById('sp_missing');
    m.innerHTML = miss.length ? '<p class="muted">Missing (you can still submit, but complete quotes are reviewed first):</p><ul class="spmiss">' + miss.map(x => '<li><a href="#" data-go="' + x[1] + '">' + x[0] + '</a></li>').join('') + '</ul>' : '<p class="ok">Everything we need is filled in.</p>';
    const set = (k, t) => { const el = document.querySelector('[data-sum=' + k + ']'); if (el) el.textContent = t || '—'; };
    set('name', q('name').value.trim()); set('category', q('category').value.trim());
    set('price', n('unit_price') > 0 ? q('currency').value + ' ' + n('unit_price') : ''); set('moq', q('moq').value);
    set('carton', n('carton_qty') > 0 ? n('carton_qty') + ' pcs' : ''); set('photos', String(photos));
  }
  form.addEventListener('input', () => { if (cur === panels.length - 1) refresh(); });
  show(Number(form.dataset.step) || 0, false); fit();
})();
