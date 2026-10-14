import { admin } from './supabase.js';
import { paymentStatus, nextInstalment } from './payments.js';

const r2 = x => Math.round(Number(x || 0) * 100) / 100;

/** Re-derive amount_paid / payment_status / next due date from the payments (rejected ones don't count). */
export async function recalcOrder(orderId) {
  const [{ data: order }, { data: pays }] = await Promise.all([
    admin.from('orders').select('id, status, amount_due, payment_schedule').eq('id', orderId).single(),
    admin.from('order_payments').select('amount, status').eq('order_id', orderId),
  ]);
  if (!order) return null;
  const paid = r2((pays || []).filter(p => p.status !== 'rejected').reduce((t, p) => t + Number(p.amount), 0));
  const status = paymentStatus(order.amount_due, paid);
  const next = status === 'paid' ? null : nextInstalment(order.payment_schedule, paid);
  const patch = { amount_paid: paid, payment_status: status, payment_due_date: next?.due || null };
  await admin.from('orders').update(patch).eq('id', orderId);
  return { ...order, ...patch, next };
}
