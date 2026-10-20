// Packing lines + totals + shipping info of an order (shared by the packing list page and the shipment documents).
import { admin } from './supabase.js';
import { totals as packTotals } from './packing.js';

export async function packingData(id) {
  // packing_info lives on orders (the order_overview view predates that column)
  const [{ data: order }, { data: rows }, { data: o }] = await Promise.all([
    admin.from('order_overview').select('*').eq('id', id).single(),
    admin.from('packing_lists').select('*').eq('order_id', id).order('position').order('carton_no'),
    admin.from('orders').select('packing_info').eq('id', id).maybeSingle(),
  ]);
  return { order, rows: rows || [], t: packTotals(rows || []), info: o?.packing_info || order?.packing_info || {} };
}
