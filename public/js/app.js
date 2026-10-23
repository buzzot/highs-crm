// Small progressive enhancements, no framework.
(function () {
  // table quick filter: <input data-filter="#tableId">
  document.querySelectorAll('input[data-filter]').forEach(inp => {
    const tbl = document.querySelector(inp.dataset.filter);
    if (!tbl) return;
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      tbl.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
  });
  // forms that submit on change (status dropdowns in lists)
  document.querySelectorAll('form.autosubmit select').forEach(s => s.addEventListener('change', () => s.form.submit()));
  // currency select that fills an FX input from data-fx on the option
  document.querySelectorAll('select[data-fx-target]').forEach(s => {
    const t = document.getElementById(s.dataset.fxTarget);
    const sync = () => { const fx = s.selectedOptions[0]?.dataset.fx; if (t && fx) t.value = Math.round(Number(fx) * 1e6) / 1e6; };
    s.addEventListener('change', sync); sync();
  });
  // show / hide password
  document.querySelectorAll('.pwtoggle').forEach(b => b.addEventListener('click', () => {
    const i = b.parentNode.querySelector('input'); const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));
  // drag-and-drop file zone: <div class="filedrop" data-dropzone data-max="10" data-max-mb="20"><input type="file" multiple>…</div><div class="fgrid" data-drop-list></div>
  let activeZone = null;
  const zones = new Set();
  function initZone(zone) {
    if (zone.dataset.ready) return; zone.dataset.ready = '1';
    const input = zone.querySelector('input[type=file]');
    const list = zone.parentElement.querySelector('[data-drop-list]');
    if (!input || !list || typeof DataTransfer === 'undefined') return;
    zones.add(zone);
    const max = Number(zone.dataset.max || 10), maxMb = Number(zone.dataset.maxMb || 20);
    const accept = (input.accept || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    const ok = f => !accept.length || accept.some(a => a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : f.type === a);
    let files = [];
    const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    const ext = n => (n.split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const render = () => {
      const dt = new DataTransfer();
      files.filter(f => f.size <= maxMb * 1048576).forEach(f => dt.items.add(f));
      input.files = dt.files;
      list.innerHTML = '';
      files.forEach((f, i) => {
        const big = f.size > maxMb * 1048576;
        const item = document.createElement('div');
        item.className = 'fitem' + (big ? ' toobig' : '');
        if (f.type.startsWith('image/')) {
          const img = document.createElement('img'); img.alt = ''; img.src = URL.createObjectURL(f); img.onload = () => URL.revokeObjectURL(img.src);
          item.appendChild(img);
        } else {
          const b = document.createElement('span'); b.className = 'fext'; b.textContent = ext(f.name); item.appendChild(b);
        }
        const meta = document.createElement('span'); meta.className = 'fmeta';
        const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = f.name;
        const sz = document.createElement('span'); sz.className = 'fsize'; sz.textContent = big ? `Too large (max ${maxMb} MB) — will not upload` : kb(f.size);
        meta.append(nm, sz); item.appendChild(meta);
        const del = document.createElement('button'); del.type = 'button'; del.className = 'fdel'; del.setAttribute('aria-label', 'Remove ' + f.name); del.textContent = '×';
        del.onclick = () => { files.splice(i, 1); render(); };
        item.appendChild(del);
        list.appendChild(item);
      });
      zone.classList.toggle('has', files.length > 0);
      const c = zone.querySelector('[data-drop-count]');
      if (c) { if (files.length) c.textContent = `${files.length} file${files.length > 1 ? 's' : ''} added · drop more or click to add`; else c.innerHTML = c.dataset.empty; }
    };
    const add = incoming => {
      for (const f of incoming) {
        if (!ok(f) || files.length >= max) continue;
        if (files.some(x => x.name === f.name && x.size === f.size)) continue;
        files.push(f);
      }
      render();
    };
    const c = zone.querySelector('[data-drop-count]'); if (c) c.dataset.empty = c.innerHTML;
    input.addEventListener('change', () => { const picked = [...input.files]; add(picked); });
    ['dragenter', 'dragover'].forEach(e => zone.addEventListener(e, ev => { ev.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(e => zone.addEventListener(e, () => zone.classList.remove('over')));
    zone.addEventListener('drop', ev => { ev.preventDefault(); add(ev.dataTransfer.files); });
    zone.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
    zone.add = add;
    ['pointerenter', 'focus', 'drop', 'click'].forEach(e => zone.addEventListener(e, () => { activeZone = zone; }));
  }
  window.initDropzones = (root = document) => root.querySelectorAll('[data-dropzone]').forEach(initZone);
  window.initDropzones();
  // paste screenshots: they go to the zone used last (or the first one), not while typing in a text field
  document.addEventListener('paste', ev => {
    if (!zones.size || (ev.target.closest && ev.target.closest('input:not([type=file]), textarea'))) return;
    const pasted = [...(ev.clipboardData?.files || [])];
    if (!pasted.length) return;
    const z = activeZone && document.contains(activeZone) ? activeZone : [...zones].find(x => document.contains(x));
    if (z) { ev.preventDefault(); z.add(pasted); z.scrollIntoView({ block: 'nearest' }); }
  });
  // fade flash messages
  setTimeout(() => document.querySelectorAll('.flash.ok').forEach(f => f.classList.add('gone')), 4000);
})();

// times recorded by the server (<time class="localtime" datetime=…>) are shown in the viewer's own time zone
document.querySelectorAll('time.localtime').forEach(function (t) { var d = new Date(t.getAttribute('datetime')); if (!Number.isNaN(d.getTime())) t.textContent = d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); });

// Searchable picker window for long lists: <select data-picker> keeps working as a normal form field (and fires "change"),
// but is chosen from a roomy dialog with search, initials, keyboard support and a clear "+ Add new…" row.
(function () {
  const sels = [...document.querySelectorAll('select[data-picker]:not([multiple])')];
  if (!sels.length) return;
  const initials = t => (String(t).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '·').toUpperCase();
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  let dlg, list, search, titleEl, current, items = [], active = -1;

  function build() {
    dlg = document.createElement('dialog'); dlg.className = 'pickdlg';
    dlg.innerHTML = '<div class="pk-head"><strong class="pk-title"></strong><button type="button" class="pk-x" aria-label="Close">×</button></div>'
      + '<input class="pk-search" type="search" placeholder="Search…" autocomplete="off"><ul class="pk-list" role="listbox"></ul>';
    document.body.appendChild(dlg);
    list = dlg.querySelector('.pk-list'); search = dlg.querySelector('.pk-search'); titleEl = dlg.querySelector('.pk-title');
    dlg.querySelector('.pk-x').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    search.addEventListener('input', () => render(search.value));
    dlg.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active].dataset.v); }
    });
    list.addEventListener('click', e => { const li = e.target.closest('li[data-v]'); if (li) choose(li.dataset.v); });
  }
  const move = d => { if (!items.length) return; active = active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length; items.forEach((li, i) => li.classList.toggle('on', i === active)); items[active].scrollIntoView({ block: 'nearest' }); };
  function choose(v) {
    const { sel, btn } = current;
    sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
    dlg.close(); btn.focus();
  }
  function render(q = '') {
    const { sel } = current, needle = q.trim().toLowerCase();
    list.innerHTML = ''; items = [];
    const add = (o, kind) => {
      const li = document.createElement('li'); li.dataset.v = o.value; li.setAttribute('role', 'option');
      li.className = kind + (o.value === sel.value ? ' sel' : '');
      const name = o.text.replace(/^\+\s*/, '');
      li.innerHTML = kind === 'new' ? '<span class="pk-plus">+</span><span class="pk-name"></span>' : '<span class="pk-av"></span><span class="pk-name"></span><span class="pk-check">✓</span>';
      li.querySelector('.pk-name').textContent = kind === 'new' ? name : (o.value === '' ? 'No selection' : name);
      if (kind !== 'new') li.querySelector('.pk-av').textContent = o.value === '' ? '–' : initials(name);
      list.appendChild(li); items.push(li);
    };
    const opts = [...sel.options];
    opts.filter(o => o.value === '' && !sel.required && !needle).forEach(o => add(o, 'none'));
    opts.filter(o => o.value !== '' && !o.value.startsWith('__') && (!needle || o.text.toLowerCase().includes(needle))).forEach(o => add(o, 'opt'));
    opts.filter(o => o.value.startsWith('__') && !o.disabled).forEach(o => add(o, 'new'));
    if (!items.some(li => li.classList.contains('opt'))) { const e = document.createElement('li'); e.className = 'empty'; e.textContent = 'Nothing found'; list.insertBefore(e, list.firstChild); }
    active = items.findIndex(li => li.classList.contains('sel')); if (needle) active = Math.max(0, items.findIndex(li => li.classList.contains('opt')));
    items.forEach((li, i) => li.classList.toggle('on', i === active));
    search.hidden = opts.length < 8;
  }
  function open(sel, btn, title) {
    if (!dlg) build();
    current = { sel, btn }; titleEl.textContent = title; search.value = '';
    render(); dlg.showModal();
    (search.hidden ? list : search).focus();
    if (active >= 0) items[active]?.scrollIntoView({ block: 'center' });
  }

  sels.forEach(sel => {
    const label = sel.closest('label');
    const title = sel.dataset.picker || (label ? [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim() || 'Select' : 'Select');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'picker-btn';
    btn.innerHTML = '<span class="pb-text"></span><span class="pb-chev" aria-hidden="true">⌄</span>';
    sel.parentNode.insertBefore(btn, sel); sel.classList.add('picker-native'); sel.tabIndex = -1;
    const sync = () => {
      const o = sel.selectedOptions[0], text = o && o.value !== '' ? o.text : '', ph = [...sel.options].find(x => x.value === '');
      const t = btn.querySelector('.pb-text'); t.textContent = text || (ph ? ph.text.replace(/^—\s*$/, 'Select…') : 'Select…'); t.classList.toggle('ph', !text);
      btn.disabled = sel.disabled;
    };
    Object.defineProperty(sel, 'value', { get() { return valueDesc.get.call(sel); }, set(v) { valueDesc.set.call(sel, v); sync(); }, configurable: true });
    sel.addEventListener('change', sync);
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
    btn.addEventListener('click', () => open(sel, btn, title));
    sync();
  });
})();

// copy buttons: <button data-copy="text">
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const t = b.dataset.copy, done = () => { const o = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = o; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, () => {}); else { const i = document.createElement('input'); i.value = t; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); done(); }
});
