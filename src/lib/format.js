export const fmt = {
  money(v, cur = 'USD', d = 2) {
    if (v == null || v === '') return '—';
    const x = Number(v);
    // unit prices (asked for with 4 digits) are shown with 2; only tiny prices (< 0.10) keep up to 4 so they do not read as 0.01
    const digits = d >= 4 && !(x !== 0 && Math.abs(x) < 0.1) ? 2 : d;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: digits }).format(x);
  },
  num(v, d = 2) { return v == null || v === '' ? '—' : Number(v).toFixed(d); },
  // date-only values ("2026-11-02") are calendar days: format them in UTC so they never shift a day
  date(v) { return v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { timeZone: 'UTC' } : {}) }) : '—'; },
  datetime(v) { return v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; },
  status(s) { return String(s || '').replace(/_/g, ' ').replace(/\bqc\b/i, 'QC'); },
  pct(v) { return v == null ? '—' : `${Number(v).toFixed(1)}%`; },
};
