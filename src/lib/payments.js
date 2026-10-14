// Payment schedule and status of an order, based on its proforma invoice.

const r2 = x => Math.round(Number(x || 0) * 100) / 100;
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

export const DEFAULT_SCHEDULE = [{ label: 'Deposit', percent: 30, due: '' }, { label: 'Balance', percent: 70, due: '' }];

/** Schedule rows from a posted form: sched[0][label|percent|due] */
export function parseSchedule(body) {
  const raw = body?.sched;
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return arr.map(x => ({ label: String(x?.label || '').trim().slice(0, 40), percent: Math.min(100, Math.max(0, Number(String(x?.percent ?? '').replace(',', '.')) || 0)), due: day(x?.due) || '' }))
    .filter(x => x.label && x.percent > 0);
}

/** Instalments with amounts; the last one absorbs rounding so they add up to the total. */
export function withAmounts(schedule, total) {
  const rows = (schedule || []).map(x => ({ ...x, amount: r2(Number(total) * Number(x.percent) / 100) }));
  if (rows.length) {
    const diff = r2(Number(total) - rows.reduce((t, x) => t + x.amount, 0));
    if (Math.abs(Number(rows.reduce((t, x) => t + x.percent, 0)) - 100) < 0.001) rows[rows.length - 1].amount = r2(rows[rows.length - 1].amount + diff);
  }
  return rows;
}

export function paymentStatus(due, paid) {
  if (!(Number(due) > 0) || !(Number(paid) > 0)) return 'unpaid';
  return Number(paid) >= Number(due) - 0.005 ? 'paid' : 'partial';
}

/** First instalment not yet covered by what has been paid: { label, amount (still open), due } or null. */
export function nextInstalment(schedule, paid) {
  let left = Number(paid || 0);
  for (const x of schedule || []) {
    if (left >= Number(x.amount) - 0.005) { left -= Number(x.amount); continue; }
    return { label: x.label, amount: r2(Number(x.amount) - left), due: x.due || null };
  }
  return null;
}
