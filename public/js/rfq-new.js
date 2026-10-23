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
  // suppliers: pick one from the searchable list → it moves into "Send to" with its email for confirmation
  var pick = document.getElementById('supPick'), sendList = document.getElementById('sendList'), empty = document.getElementById('sendEmpty'), count = document.getElementById('supCount');
  if (!pick || !sendList) return;
  var removed = {}; // id -> option element, put back in the picker when the row is removed
  function tick() {
    var n = sendList.querySelectorAll('.sendrow').length;
    count.textContent = n; empty.hidden = n > 0;
  }
  pick.addEventListener('change', function () {
    var opt = pick.selectedOptions[0];
    if (!opt || !opt.value) return;
    var row = document.createElement('div'); row.className = 'sendrow';
    var id = opt.value, name = opt.getAttribute('data-name'), email = opt.getAttribute('data-email');
    var nm = document.createElement('strong'); nm.textContent = name;
    var inp = document.createElement('input'); inp.type = 'text'; inp.name = 'email_' + id; inp.value = email; inp.placeholder = 'email address — required to send'; inp.setAttribute('aria-label', 'Email for ' + name);
    var hid = document.createElement('input'); hid.type = 'hidden'; hid.name = 'supplier_ids'; hid.value = id;
    var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'link small danger'; rm.textContent = 'Remove';
    rm.addEventListener('click', function () {
      row.remove(); pick.appendChild(removed[id]); delete removed[id]; tick();
    });
    row.appendChild(nm); row.appendChild(inp); row.appendChild(hid); row.appendChild(rm);
    sendList.appendChild(row);
    removed[id] = opt; opt.remove(); pick.value = '';
    tick();
    if (!email) inp.focus();
  });
  tick();
})();
