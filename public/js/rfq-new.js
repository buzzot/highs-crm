// New RFQ form: add / remove product rows, filter and count the chosen suppliers.
(function () {
  var body = document.querySelector('#rfqItems tbody');
  if (!body) return;
  function renumber() {
    Array.prototype.forEach.call(body.rows, function (tr, i) {
      Array.prototype.forEach.call(tr.querySelectorAll('input'), function (el) { el.name = el.name.replace(/item\[\d+\]/, 'item[' + i + ']'); });
    });
  }
  var add = document.getElementById('addItem');
  if (add) add.addEventListener('click', function () {
    var tr = body.rows[body.rows.length - 1].cloneNode(true);
    Array.prototype.forEach.call(tr.querySelectorAll('input'), function (el) { if (!/\[unit\]$/.test(el.name)) el.value = ''; });
    body.appendChild(tr); renumber();
    tr.querySelector('[name$="[description]"]').focus();
  });
  body.addEventListener('click', function (e) {
    if (!e.target.hasAttribute('data-rm')) return;
    if (body.rows.length > 1) { e.target.closest('tr').remove(); renumber(); }
  });
  // suppliers: choose several in one window → each moves into "Send to" with its email and contact person
  var addBtn = document.getElementById('supAdd'), dataEl = document.getElementById('supData'), sendList = document.getElementById('sendList'), empty = document.getElementById('sendEmpty'), count = document.getElementById('supCount');
  if (!addBtn || !dataEl || !sendList) return;
  var all = JSON.parse(dataEl.textContent), chosen = {}, dlg = null, ticked = {};
  var initials = function (t) { return (String(t).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('') || '·').toUpperCase(); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function tick() {
    var n = sendList.querySelectorAll('.sendrow').length;
    count.textContent = n; empty.hidden = n > 0;
  }
  function addRow(s) {
    chosen[s.id] = true;
    var row = el('div', 'sendrow');
    row.appendChild(el('span', 'sr-av', initials(s.name)));
    var who = el('div', 'sr-who');
    who.appendChild(el('strong', null, s.name));
    var sub = [s.contact ? 'Contact: ' + s.contact : '', s.city].filter(Boolean).join(' · ');
    who.appendChild(el('span', 'muted small', sub || 'No contact person on file'));
    var inp = el('input'); inp.type = 'text'; inp.name = 'email_' + s.id; inp.value = s.email; inp.className = 'sr-email'; inp.placeholder = 'email address — required to send'; inp.setAttribute('aria-label', 'Email for ' + s.name);
    var hid = el('input'); hid.type = 'hidden'; hid.name = 'supplier_ids'; hid.value = s.id;
    var rm = el('button', 'link small danger', 'Remove'); rm.type = 'button';
    rm.addEventListener('click', function () { row.remove(); delete chosen[s.id]; tick(); });
    [who, inp, hid, rm].forEach(function (x) { row.appendChild(x); });
    sendList.appendChild(row);
  }
  function build() {
    dlg = document.createElement('dialog'); dlg.className = 'pickdlg supdlg';
    dlg.innerHTML = '<div class="pk-head"><strong class="pk-title">Add suppliers</strong><button type="button" class="pk-x" aria-label="Close">×</button></div>'
      + '<input class="pk-search" type="search" placeholder="Search by name, contact or email…" autocomplete="off"><ul class="pk-list" role="listbox"></ul>'
      + '<div class="pk-foot"><button type="button" class="btn primary" id="supDone">Add</button><button type="button" class="btn" id="supCancel">Cancel</button></div>';
    document.body.appendChild(dlg);
    dlg.querySelector('.pk-x').addEventListener('click', function () { dlg.close(); });
    dlg.querySelector('#supCancel').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.querySelector('.pk-search').addEventListener('input', render);
    dlg.querySelector('#supDone').addEventListener('click', function () {
      all.filter(function (s) { return ticked[s.id] && !chosen[s.id]; }).forEach(addRow);
      dlg.close(); tick();
    });
  }
  function render() {
    var q = dlg.querySelector('.pk-search').value.trim().toLowerCase(), list = dlg.querySelector('.pk-list');
    list.innerHTML = '';
    var left = all.filter(function (s) { return !chosen[s.id]; });
    var shown = left.filter(function (s) { return !q || (s.name + ' ' + s.contact + ' ' + s.email + ' ' + s.city).toLowerCase().indexOf(q) >= 0; });
    shown.forEach(function (s) {
      var li = el('li', 'opt supopt' + (ticked[s.id] ? ' sel' : '')); li.dataset.v = s.id;
      var box = el('input'); box.type = 'checkbox'; box.checked = !!ticked[s.id]; box.tabIndex = -1;
      var txt = el('span', 'pk-name');
      txt.appendChild(el('strong', null, s.name));
      var line = el('span', 'sp-line');
      if (s.email) line.appendChild(el('span', 'sp-email', s.email)); else line.appendChild(el('span', 'muted', 'no email'));
      if (s.contact) line.appendChild(el('span', 'muted', ' · ' + s.contact));
      txt.appendChild(line);
      li.appendChild(box); li.appendChild(el('span', 'pk-av', initials(s.name))); li.appendChild(txt);
      li.addEventListener('click', function () { ticked[s.id] = !ticked[s.id]; box.checked = ticked[s.id]; li.classList.toggle('sel', ticked[s.id]); sync(); });
      list.appendChild(li);
    });
    if (!shown.length) list.appendChild(el('li', 'empty', left.length ? 'Nothing found' : 'All suppliers are already added'));
    sync();
  }
  function sync() {
    var n = all.filter(function (s) { return ticked[s.id] && !chosen[s.id]; }).length, b = dlg.querySelector('#supDone');
    b.textContent = n ? 'Add ' + n + ' supplier' + (n === 1 ? '' : 's') : 'Add'; b.disabled = !n;
  }
  addBtn.addEventListener('click', function () {
    if (!dlg) build();
    ticked = {}; dlg.querySelector('.pk-search').value = ''; render(); dlg.showModal(); dlg.querySelector('.pk-search').focus();
  });
  tick();
})();
