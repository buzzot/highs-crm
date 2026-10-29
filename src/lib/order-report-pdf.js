// One-page order report (income, expenses, balance) for the archive.
import { renderDocument } from './doc-pdf.js';
import { fxRate } from './util.js';

const day = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? { timeZone: 'UTC' } : {}) }) : '');
const m = (v, c) => `${c} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function reportPdf({ row, company, cur, settings }) {
  const o = row.order, to = (v, c) => Number(v) * fxRate(settings, c || cur, cur);
  const lines = [];
  row.incomes.forEach(i => lines.push({ description: `Income — ${i.label || 'payment'} · ${day(i.date)}${i.pending ? ' (not confirmed yet)' : ''}${i.currency !== cur ? ` (${m(i.amount, i.currency)})` : ''}`, quantity: 1, unit_price: i.pending ? 0 : to(i.amount, i.currency) }));
  row.expenses.forEach(e => lines.push({ description: `${e.kind === 'freight' ? 'Logistics' : 'Supplier'} — ${e.name}${e.date ? ' · ' + day(e.date) : ''}${e.est ? ' (estimate)' : ''}${e.currency !== cur ? ` (${m(e.amount, e.currency)})` : ''}`, quantity: 1, unit_price: -to(e.amount, e.currency) }));
  return renderDocument({
    title: 'ORDER REPORT', no: o.order_no, date: day(new Date()),
    seller: { name: company.name, lines: [] }, partyLabel: 'Client', party: { name: o.client_name || '—', lines: [] },
    meta: [['Order date', day(o.created_at)], ['Staff', row.staff], ['Supplier', o.supplier_name], ['Income', m(row.income, cur)], ['Expenses', m(row.expense, cur)], ['Balance', m(row.balance, cur)]],
    currency: cur, lines,
    sections: [{ heading: 'How to read this', text: `Amounts are shown in ${cur}. TOTAL = balance = income − expenses. Client payments waiting for confirmation are listed but not counted.` }],
    footer: `${o.order_no} · ${company.name}`,
  });
}
