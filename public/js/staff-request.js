// Staff "New request": product blocks, AI summary of the client's message, AI reading of a product's photos / PDF.
(function () {
  var list = document.getElementById('rqItems'), tpl = document.getElementById('rqTemplate');
  if (!list || !tpl) return;
  var next = list.children.length;

  function renumber() {
    var blocks = [].slice.call(list.querySelectorAll('.rqitem'));
    blocks.forEach(function (b, k) { b.querySelector('.rqnum').textContent = k + 1; b.querySelector('.rqdel').hidden = blocks.length < 2; });
    document.getElementById('rqCount').textContent = blocks.length;
  }
  function addBlock() {
    var wrap = document.createElement('div'); wrap.innerHTML = tpl.innerHTML.replace(/__I__/g, String(next++)).trim();
    var block = wrap.firstElementChild; list.appendChild(block);
    if (window.initDropzones) window.initDropzones(block);
    renumber(); return block;
  }
  var field = function (block, n) { return block.querySelector('[name$="[' + n + ']"]'); };
  var isEmpty = function (block) { return ['name', 'sku', 'description', 'quantity'].every(function (n) { return !field(block, n).value.trim(); }) && !block.querySelector('.fitem'); };

  document.getElementById('rqAdd').addEventListener('click', function () {
    var b = addBlock(); field(b, 'name').focus(); b.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  list.addEventListener('click', function (e) {
    var del = e.target.closest('.rqdel'); if (!del) return;
    var block = del.closest('.rqitem');
    if (!isEmpty(block) && !block.classList.contains('confirm')) {
      block.classList.add('confirm'); del.textContent = 'Click again to remove';
      setTimeout(function () { block.classList.remove('confirm'); del.innerHTML = '&times;'; }, 3000); return;
    }
    block.remove(); renumber();
  });
  document.getElementById('rqCur').addEventListener('change', function (e) {
    document.querySelectorAll('.rqcur').forEach(function (s) { s.textContent = e.target.value; });
  });

  // put a suggestion into a block; keep what staff already typed unless `force`
  function fill(block, it, force) {
    var n = 0;
    ['name', 'sku', 'description', 'quantity', 'target_unit_price'].forEach(function (k) {
      var el = field(block, k);
      if (it[k] != null && it[k] !== '' && el && (force || !el.value.trim())) { el.value = it[k]; n++; }
    });
    if (it.unit) { var u = field(block, 'unit'); if (u && [].some.call(u.options, function (o) { return o.value === it.unit || o.text === it.unit; })) u.value = it.unit; }
    var sp = it.spec || {}, any = false;
    Object.keys(sp).forEach(function (k) {
      var el = block.querySelector('[name$="[spec][' + k + ']"]');
      if (el && sp[k] && (force || !el.value.trim())) { el.value = sp[k]; any = true; n++; }
    });
    if (any) block.querySelector('.rqmore').open = true;
    return n;
  }

  // AI: read one product's photos / PDF
  var syncAi = function (block) {
    var bar = block.querySelector('.aifill'); if (!bar) return;
    var inp = block.querySelector('input[type=file]');
    bar.hidden = ![].some.call(inp.files || [], function (f) { return /^image\//i.test(f.type) || /\.pdf$/i.test(f.name); });
  };
  list.addEventListener('change', function (e) { if (e.target.type === 'file') syncAi(e.target.closest('.rqitem')); });
  new MutationObserver(function () { list.querySelectorAll('.rqitem').forEach(syncAi); }).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  list.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-aifill]'); if (!btn) return;
    var block = btn.closest('.rqitem'), stat = block.querySelector('.aistat');
    var files = [].filter.call(block.querySelector('input[type=file]').files, function (f) { return /^image\//.test(f.type) || /\.pdf$/i.test(f.name); }).slice(0, 4);
    var fd = new FormData(); files.forEach(function (x) { fd.append('files', x); });
    fd.append('name', field(block, 'name').value); fd.append('description', field(block, 'description').value);
    btn.disabled = true; stat.textContent = 'Reading the files…';
    fetch('/admin/sourcing/ai-item', { method: 'POST', body: fd, headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'AI could not read the files.'); return j; }); })
      .then(function (j) { stat.textContent = fill(block, j, false) ? 'Filled from the files — please check it.' : 'Nothing new found in the files.'; })
      .catch(function (err) { stat.textContent = err.message; })
      .then(function () { btn.disabled = false; });
  });

  // AI: summarize the client's message and propose the products
  var sum = document.getElementById('aiSummarize');
  if (sum) sum.addEventListener('click', function () {
    var text = document.getElementById('rqText').value.trim(), stat = document.getElementById('aiStat');
    if (text.length < 20) { stat.textContent = 'Paste the client’s email or message first.'; return; }
    sum.disabled = true; stat.textContent = 'Reading the message…';
    fetch('/admin/sourcing/ai-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: text }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'AI could not read the message.'); return j; }); })
      .then(function (j) {
        var set = function (id, v) { var el = document.getElementById(id); if (el && v && !el.value.trim()) el.value = v; };
        set('rqTitle', j.title);
        var s = document.getElementById('rqSummary'); if (j.summary) s.value = j.summary;
        [['destination_country', j.destination_country], ['destination_city', j.destination_city], ['needed_by', j.needed_by]].forEach(function (p) {
          var el = document.querySelector('[name="' + p[0] + '"]'); if (el && p[1] && !el.value) el.value = p[1];
        });
        if (j.target_currency) { var c = document.getElementById('rqCur'); c.value = j.target_currency; c.dispatchEvent(new Event('change')); }
        var items = j.items || [];
        items.forEach(function (it) {
          var b = [].slice.call(list.querySelectorAll('.rqitem')).filter(isEmpty)[0] || addBlock();
          fill(b, it, true);
        });
        renumber();
        stat.textContent = items.length ? 'Summary and ' + items.length + ' product' + (items.length === 1 ? '' : 's') + ' filled — please check them.' : 'Summary filled. No products found in the message.';
      })
      .catch(function (err) { stat.textContent = err.message; })
      .then(function () { sum.disabled = false; });
  });
  renumber();
})();
