// Access levels for staff: Admin = everything; Director = sees everything, deletes only what they created;
// Manager = sees and changes only records they own (created, or assigned to them by an Admin / Director).
// Enforced in one place: every database call made while a staff request is running goes through scopeTable().
import { AsyncLocalStorage } from 'node:async_hooks';

export const store = new AsyncLocalStorage();
/** Tables whose rows carry owner_id / created_by. */
export const SCOPED = new Set(['organizations', 'requests', 'quotes', 'orders', 'shipments', 'rfqs', 'order_overview']);   // order_overview is the orders list view (read only)
/** Documents the staff member created themselves (a Manager sees only those; no owner column needed). */
export const CREATOR = new Set(['purchase_orders', 'proforma_invoices', 'supplier_pos', 'freight_requests']);
export const LEVELS = ['admin', 'director', 'manager'];
export const LEVEL_LABEL = { admin: 'Admin', director: 'Director', manager: 'Manager' };

export function levelOf(u) {
  if (!u) return null;
  if (u.role === 'admin') return 'admin';
  if (u.role === 'staff') return u.staff_level === 'manager' ? 'manager' : 'director';
  return null;
}
export const isManager = u => levelOf(u) === 'manager';

/** May this user delete this record? (Admin: any; others: only what they created.) */
export const canDelete = (u, rec) => { const l = levelOf(u); return l === 'admin' || (!!l && !!rec && !!u.id && rec.created_by === u.id); };
/** May this user open this record? (Manager: only their own.) */
export const canSee = (u, rec) => levelOf(u) !== 'manager' || (!!rec && !!u.id && rec.owner_id === u.id);
export const canAssign = u => ['admin', 'director'].includes(levelOf(u));

// the columns only exist after migration 0036 — until it has been run, nothing is restricted and nothing is stamped
let ready = null, checkedAt = 0, probe = null;
export const setProbe = fn => { probe = fn; };
async function refreshReady() {
  if (!probe || Date.now() - checkedAt < 60000) return;
  checkedAt = Date.now();
  try { const v = await probe(); if (v !== null) ready = v; } catch { /* network blip: keep what we knew */ }
}
export const scopeReady = () => { if (ready !== true) refreshReady(); return ready === true; };
export const _forceReady = v => { ready = v; checkedAt = Date.now(); };

/**
 * Wraps the query builder returned by from(table): stamps new rows, limits a Manager's reads/updates to their own records,
 * and lets a non-Admin delete only records they created.
 */
export function scopeTable(builder, table) {
  const u = store.getStore()?.user;
  const lvl = levelOf(u);
  if (!lvl || !(SCOPED.has(table) || CREATOR.has(table))) return builder;
  const col = SCOPED.has(table) ? 'owner_id' : 'created_by';
  const mgr = lvl === 'manager';
  if (!mgr && !scopeReady()) return builder;   // before migration 0036 nobody is restricted; a Manager can only exist after it, so Managers are always restricted
  return new Proxy(builder, {
    get(t, prop) {
      const orig = Reflect.get(t, prop);
      if (typeof orig !== 'function') return orig;
      if (prop === 'insert') return (rows, ...rest) => {
        // everyone's new records remember their creator; a Manager's are also theirs to see (others inherit the owner of what they belong to, see migration 0036)
        const stamp = r => ({ created_by: u.id, ...(mgr && col === 'owner_id' ? { owner_id: u.id } : {}), ...r });
        return orig.call(t, Array.isArray(rows) ? rows.map(stamp) : stamp(rows), ...rest);
      };
      if (mgr && prop === 'update') return (vals, ...a) => {   // a Manager cannot hand a record to someone else
        const { owner_id, created_by, ...rest } = vals || {};
        return orig.call(t, rest, ...a).eq(col, u.id);
      };
      if (mgr && prop === 'select') return (...a) => orig.apply(t, a).eq(col, u.id);
      if (prop === 'delete' && lvl !== 'admin') return (...a) => {
        const q = orig.apply(t, a).eq('created_by', u.id);
        return mgr ? q.eq(col, u.id) : q;
      };
      return orig.bind(t);
    },
  });
}

// URL → the record a Manager is asking for. Anything that is not their own gets "not found".
const IDRE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
export const GUARDS = [
  { re: new RegExp(`^/clients/${IDRE}`), table: 'organizations' },
  { re: new RegExp(`^/sourcing/${IDRE}`), table: 'requests' },
  { re: new RegExp(`^/pricing/requests/${IDRE}`), table: 'requests' },
  { re: new RegExp(`^/pricing/quotes/${IDRE}`), table: 'quotes' },
  { re: new RegExp(`^/rfqs/${IDRE}`), table: 'rfqs' },
  { re: new RegExp(`^/logistics/shipments/${IDRE}`), table: 'shipments' },
  { re: new RegExp(`^/orders/${IDRE}`), table: 'orders' },
  { re: new RegExp(`^/pi/order/${IDRE}`), table: 'orders' },
  { re: new RegExp(`^/po/order/${IDRE}`), table: 'orders' },
];
export const guardFor = path => { for (const g of GUARDS) { const m = path.match(g.re); if (m) return { table: g.table, id: m[1] }; } return null; };
