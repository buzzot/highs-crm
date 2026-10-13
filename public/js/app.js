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
  // fade flash messages
  setTimeout(() => document.querySelectorAll('.flash.ok').forEach(f => f.classList.add('gone')), 4000);
})();
