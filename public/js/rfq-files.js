// New RFQ: count the chosen files and run the AI check on them (client documents ticked + files dropped on the form).
(function () {
  var box = document.getElementById('rfqFiles');
  if (!box) return;
  var form = box.closest('form'), input = box.querySelector('input[type=file]'), count = document.getElementById('fileCount'), res = document.getElementById('checkRes'), hidden = document.getElementById('reviewJson'), btn = document.getElementById('fileCheck');
  var picks = function () { return box.querySelectorAll('input[name=doc_ids]'); };
  var checked = false;
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function total() { var n = 0; picks().forEach(function (c) { if (c.checked) n++; }); return n + (input && input.files ? input.files.length : 0); }
  function refresh() {
    var n = total(); count.textContent = n;
    if (btn) btn.disabled = n === 0;
    if (checked) { var s = res.querySelector('.stale'); if (!s) { s = el('p', 'stale small', 'The files changed since the check — check them again before you create the RFQ.'); res.insertBefore(s, res.firstChild); } }
  }
  box.addEventListener('change', refresh);
  new MutationObserver(refresh).observe(box.querySelector('[data-drop-list]') || box, { childList: true });
  var all = document.getElementById('selAll');
  if (all) all.addEventListener('click', function () { var on = Array.prototype.some.call(picks(), function (c) { return !c.checked; }); picks().forEach(function (c) { c.checked = on; }); all.textContent = on ? 'Clear' : 'Select all'; refresh(); });

  function show(data) {
    res.innerHTML = ''; checked = true;
    var keys = Object.keys(data.results || {}), warn = 0;
    keys.forEach(function (k) {
      var r = data.results[k]; if (r.status === 'warn') warn++;
      var row = el('div', 'chk-row ' + r.status);
      row.appendChild(el('span', 'chk-badge ' + r.status, r.status === 'ok' ? 'No issues' : r.status === 'warn' ? 'Check this' : 'Not checked'));
      var body = el('div', 'chk-body'); body.appendChild(el('strong', null, data.names[k] || k));
      if (r.language && r.status !== 'unchecked') body.appendChild(el('span', 'muted small', ' · ' + r.language));
      if (r.issues && r.issues.length) { var ul = el('ul'); r.issues.forEach(function (t) { ul.appendChild(el('li', null, t)); }); body.appendChild(ul); }
      if (r.note) body.appendChild(el('div', 'muted small', r.note));
      row.appendChild(body); res.appendChild(row);
    });
    if (!keys.length) res.appendChild(el('p', 'muted small', 'Nothing to check yet — tick or add a file first.'));
    var head = el('div', 'chk-head ' + (warn ? 'warn' : 'ok'), warn ? warn + ' file' + (warn > 1 ? 's need' : ' needs') + ' attention. Remove it, or replace it with a cleaned copy, before you send it to suppliers.' : keys.length ? 'No client details or non-English text found in the files that could be read.' : '');
    if (head.textContent) res.insertBefore(head, res.firstChild);
    if (data.usage) res.appendChild(el('p', 'muted small', data.usage));
    hidden.value = JSON.stringify(data.results || {});
  }
  if (btn) btn.addEventListener('click', function () {
    var fd = new FormData();
    picks().forEach(function (c) { if (c.checked) fd.append('doc_ids', c.value); });
    Array.prototype.forEach.call(input.files || [], function (f) { fd.append('files', f); });
    var old = btn.innerHTML; btn.disabled = true; btn.textContent = 'Checking…'; res.innerHTML = '';
    fetch('/admin/rfqs/review', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'The check failed'); return j; }); })
      .then(show)
      .catch(function (e) { res.innerHTML = ''; res.appendChild(el('div', 'chk-head warn', 'The AI check could not run: ' + e.message)); })
      .then(function () { btn.innerHTML = old; btn.disabled = total() === 0; });
  });
  refresh();
})();
