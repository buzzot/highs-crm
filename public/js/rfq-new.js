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
  var boxes = document.querySelectorAll('input[name=supplier_ids]'), count = document.getElementById('supCount');
  var filter = document.getElementById('supFilter');
  if (!count || !filter) return;
  function tick() { count.textContent = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length; }
  Array.prototype.forEach.call(boxes, function (b) { b.addEventListener('change', tick); });
  filter.addEventListener('input', function (e) {
    var q = e.target.value.toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll('.checklist .check'), function (l) { l.style.display = l.getAttribute('data-name').indexOf(q) >= 0 ? '' : 'none'; });
  });
})();
