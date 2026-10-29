// Orders report: per order the money in (client payments), the money out (supplier + logistics) and the balance.
import { sumIn } from './currency.js';

const LIVE_PO = new Set(['sent', 'replied', 'confirmed']);   // drafts / declined / cancelled supplier orders are not costs

/**
 * orders: order_overview rows (+ owner_id / created_by), pays: order_payments, pos: supplier_pos (+ suppliers.name),
 * ships: shipments (+ forwarders.name), costs: freight_costs, staff: profiles. Returns { rows, totals }.
 */
export function buildReport({ orders = [], pays = [], pos = [], supPays = [], ships = [], costs = [], staff = [], settings = {}, cur = 'CNY' }) {
  const who = new Map(staff.map(p => [p.id, p.full_name || p.email || '']));
  const shipOf = new Map(ships.map(s => [s.id, s]));
  const rows = orders.map(o => {
    const incomes = pays.filter(p => p.order_id === o.id && ['confirmed', 'submitted'].includes(p.status))
      .map(p => ({ amount: Number(p.amount || 0), currency: p.currency || o.currency, date: p.paid_on || p.created_at, pending: p.status !== 'confirmed', label: p.label || '' }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const mySup = supPays.filter(p => p.order_id === o.id);
    const myPos = pos.filter(p => p.order_id === o.id && LIVE_PO.has(p.status) && Number(p.total) > 0);
    // money actually paid to the supplier wins; without it the supplier order (or the order cost) is shown as an estimate
    const expenses = mySup.length
      ? mySup.map(p => ({ kind: 'supplier', amount: Number(p.amount), currency: p.currency || o.currency, name: p.suppliers?.name || o.supplier_name || 'Supplier', date: p.paid_on || p.created_at, paid: true }))
      : myPos.map(p => ({ kind: 'supplier', amount: Number(p.total), currency: p.currency || o.currency, name: p.suppliers?.name || o.supplier_name || 'Supplier', date: p.confirmed_at || p.sent_at }));
    if (!expenses.length && Number(o.cost_total) > 0) expenses.push({ kind: 'supplier', est: true, amount: Number(o.cost_total), currency: o.currency, name: o.supplier_name || 'Supplier', date: null });
    costs.forEach(c => {
      const s = shipOf.get(c.shipment_id);
      if (!s || s.order_id !== o.id) return;
      expenses.push({ kind: 'freight', amount: Number(c.amount || 0), currency: c.currency || o.currency, name: s.forwarders?.name || c.description || 'Logistics', date: c.paid_at || c.created_at, paid: !!c.paid });
    });
    const inSum = sumIn(settings, cur, incomes.filter(i => !i.pending).map(i => [i.amount, i.currency]));
    const outSum = sumIn(settings, cur, expenses.map(e => [e.amount, e.currency]));
    const cancelled = o.status === 'cancelled';
    return { order: o, staff: who.get(o.owner_id) || who.get(o.created_by) || '', incomes, expenses, income: inSum, expense: outSum, balance: inSum - outSum, cancelled };
  });
  const live = rows.filter(r => !r.cancelled);
  const totals = { income: live.reduce((t, r) => t + r.income, 0), expense: live.reduce((t, r) => t + r.expense, 0) };
  totals.balance = totals.income - totals.expense;
  return { rows, totals, cur };
}
