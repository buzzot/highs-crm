// Orders without goods items (logistics only): gross profit is what was actually received minus costs.
import { admin } from './supabase.js';
import { cashProfit } from './payments.js';

/** Fills gross_profit (and profit_on_received) on the logistics-only orders in `list`, in place. Cancelled orders are skipped. */
export async function applyCashProfit(list) {
  const noGoods = list.filter(o => o.status !== 'cancelled' && !(Number(o.subtotal) > 0));
  if (!noGoods.length) return list;
  const { data: pays } = await admin.from('order_payments').select('order_id, amount, currency').eq('status', 'confirmed').in('order_id', noGoods.map(o => o.id));
  noGoods.forEach(o => {
    const got = (pays || []).filter(p => p.order_id === o.id && p.currency === o.currency).reduce((t, p) => t + Number(p.amount || 0), 0);
    if (got > 0) { o.gross_profit = cashProfit({ received: got, cost: o.cost_total, freight: o.freight_total }).profit; o.profit_on_received = true; }
  });
  return list;
}
