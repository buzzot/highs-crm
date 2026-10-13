export const fmt = {
  money(v, cur = 'USD', d = 2) {
    if (v == null || v === '') return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: d }).format(Number(v));
  },
  num(v, d = 2) { return v == null || v === '' ? '—' : Number(v).toFixed(d); },
  date(v) { return v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; },
  datetime(v) { return v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; },
  status(s) { return String(s || '').replace(/_/g, ' ').replace(/\bqc\b/i, 'QC'); },
  pct(v) { return v == null ? '—' : `${Number(v).toFixed(1)}%`; },
};
