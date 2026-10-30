// Styled dropdown popup for native <select>. The select stays the real form control (value, change events, forms
// keep working); only the OS popup is replaced. Touch devices, multi-selects and [data-native] keep the native UI.
(function () {
  'use strict';
  var pop = null, cur = null, active = -1, typed = '', typedAt = 0;
  var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  function eligible(s) {
    return s && s.tagName === 'SELECT' && !s.multiple && !(s.size > 1) && !s.disabled &&
      !s.hasAttribute('data-native') && !s.classList.contains('picker-native') && !coarse;
  }
  function items() { return pop ? Array.prototype.slice.call(pop.querySelectorAll('.sx-opt:not(.is-disabled)')) : []; }
  function close(focusBack) {
    if (!pop) return;
    pop.remove(); pop = null;
    if (cur) { cur.classList.remove('sx-open'); if (focusBack) cur.focus(); }
    cur = null; active = -1;
  }
  function choose(el) {
    if (!cur || !el) return;
    var s = cur, idx = +el.dataset.i;
    close(true);
    if (s.selectedIndex !== idx) {
      s.selectedIndex = idx;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function mark(i, scroll) {
    var list = items();
    list.forEach(function (o) { o.classList.remove('is-active'); });
    if (i < 0 || i >= list.length) return;
    active = i; list[i].classList.add('is-active');
    if (scroll !== false) list[i].scrollIntoView({ block: 'nearest' });
  }
  function build(s) {
    var p = document.createElement('div');
    p.className = 'sx-pop'; p.setAttribute('role', 'listbox');
    var group = null;
    Array.prototype.forEach.call(s.children, function (ch) {
      if (ch.tagName === 'OPTGROUP') {
        var g = document.createElement('div'); g.className = 'sx-group'; g.textContent = ch.label; p.appendChild(g);
        Array.prototype.forEach.call(ch.children, function (o) { add(o, true); });
      } else if (ch.tagName === 'OPTION') add(ch, false);
    });
    function add(o, grouped) {
      var d = document.createElement('div');
      d.className = 'sx-opt' + (o.disabled ? ' is-disabled' : '') + (grouped ? ' in-group' : '') + (o.selected ? ' is-selected' : '');
      d.setAttribute('role', 'option'); d.setAttribute('aria-selected', o.selected ? 'true' : 'false');
      d.dataset.i = o.index;
      var t = document.createElement('span'); t.className = 'sx-t'; t.textContent = o.text || ' '; d.appendChild(t);
      if (o.selected) { var c = document.createElement('span'); c.className = 'sx-check'; c.textContent = '✓'; d.appendChild(c); }
      p.appendChild(d);
    }
    return p;
  }
  function place() {
    var r = cur.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
    pop.style.minWidth = r.width + 'px';
    pop.style.maxHeight = '280px';
    var h = Math.min(pop.scrollHeight, 280), below = vh - r.bottom - 8, above = r.top - 8;
    var up = below < h && above > below;
    var mh = Math.max(120, Math.min(280, up ? above : below));
    pop.style.maxHeight = mh + 'px';
    var hh = Math.min(pop.scrollHeight, mh);
    pop.style.top = (up ? Math.max(8, r.top - hh - 4) : r.bottom + 4) + 'px';
    var w = pop.offsetWidth, left = Math.min(r.left, vw - w - 8);
    pop.style.left = Math.max(8, left) + 'px';
  }
  function open(s) {
    close(false);
    cur = s; pop = build(s);
    (s.closest('dialog') || document.body).appendChild(pop);
    s.classList.add('sx-open');
    place();
    var sel = pop.querySelector('.is-selected');
    var list = items();
    mark(sel ? list.indexOf(sel) : 0);
  }

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (pop && pop.contains(t)) { e.preventDefault(); return; }
    var s = t.closest && t.closest('select');
    if (eligible(s)) {
      e.preventDefault(); s.focus();
      if (cur === s) close(false); else open(s);
      return;
    }
    close(false);
  }, true);
  document.addEventListener('click', function (e) {
    if (!pop) return;
    var o = e.target.closest && e.target.closest('.sx-opt');
    if (o && pop.contains(o)) { if (!o.classList.contains('is-disabled')) choose(o); }
  }, true);
  document.addEventListener('mousemove', function (e) {
    var o = pop && e.target.closest && e.target.closest('.sx-opt:not(.is-disabled)');
    if (o) mark(items().indexOf(o), false);
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!pop) {
      if (eligible(t) && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'Enter' && t.form && !t.closest('dialog')) { /* let Enter submit as native does */ return; }
        e.preventDefault(); open(t);
      }
      return;
    }
    var list = items(), k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (k === 'ArrowDown') { e.preventDefault(); mark(Math.min(list.length - 1, active + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, active - 1)); }
    else if (k === 'Home') { e.preventDefault(); mark(0); }
    else if (k === 'End') { e.preventDefault(); mark(list.length - 1); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(list[active]); }
    else if (k === 'Tab') { close(false); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      var now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + k.toLowerCase(); typedAt = now;
      var from = typed.length === 1 ? active + 1 : active;
      for (var n = 0; n < list.length; n++) {
        var i = (from + n) % list.length;
        if (list[i].textContent.trim().toLowerCase().indexOf(typed) === 0) { mark(i); break; }
      }
    }
  }, true);
  window.addEventListener('resize', function () { close(false); });
  window.addEventListener('scroll', function (e) { if (pop && !pop.contains(e.target)) close(false); }, true);
  window.addEventListener('blur', function () { close(false); });
})();
