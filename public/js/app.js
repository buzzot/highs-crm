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
