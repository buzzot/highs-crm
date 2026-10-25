// The red number on a supplier's RFQs menu: RFQs sent to them that are still open and not answered. Cached for a few seconds per supplier.
import { admin } from './supabase.js';

const cache = new Map();
export async function supplierRfqCount(supplierId) {
  if (!supplierId) return 0;
  const hit = cache.get(supplierId);
  if (hit && Date.now() - hit.at < 15e3) return hit.n;
  let n = 0;
  try {
    const { count } = await admin.from('rfq_suppliers').select('id, rfqs!inner(status)', { count: 'exact', head: true }).eq('supplier_id', supplierId).eq('status', 'sent').eq('rfqs.status', 'open');
    n = count || 0;
  } catch { n = 0; }   // before migration 0029 the table does not exist
  if (cache.size > 500) cache.clear();
  cache.set(supplierId, { at: Date.now(), n });
  return n;
}
export const forgetSupplierRfq = supplierId => cache.delete(supplierId);
