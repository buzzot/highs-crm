// Token accounting for every AI call: shown under each AI result and collected for the AI usage report.
import { AsyncLocalStorage } from 'node:async_hooks';

// who triggered the call (set per request in server.js)
export const aiContext = new AsyncLocalStorage();

export const FEATURES = {
  quote_check: 'Quote check', sourcing_brief: 'Sourcing brief', product_extract: 'Product import — reading the file',
  product_review: 'Product import — row check', request_product_fill: 'Client request — product fill', request_staff_summary: 'Staff request — email summary', request_staff_item: 'Staff request — product read', product_compare: 'Product compare', packing_extract: 'Packing list reading', freight_quote_read: 'Freight quote reading', supplier_reply_read: 'Supplier reply reading', product_scan: 'Product card — AI scan',
};

/** Normalise the Anthropic response usage. */
export function usageFrom(msg, model) {
  const u = msg?.usage || {};
  const input = Number(u.input_tokens || 0), output = Number(u.output_tokens || 0);
  const cacheRead = Number(u.cache_read_input_tokens || 0), cacheWrite = Number(u.cache_creation_input_tokens || 0);
  return { model: msg?.model || model || null, input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function addUsage(...list) {
  const xs = list.filter(Boolean);
  if (!xs.length) return null;
  return xs.reduce((a, b) => ({ model: a.model || b.model, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total }));
}

/** Optional cost estimate from admin-entered prices (USD per million tokens). */
export function costOf(u, prices) {
  if (!u || !prices || !(Number(prices.input_per_m) > 0 || Number(prices.output_per_m) > 0)) return null;
  const inP = Number(prices.input_per_m) || 0, outP = Number(prices.output_per_m) || 0;
  return ((u.input + (u.cacheRead || 0) + (u.cacheWrite || 0)) * inP + u.output * outP) / 1e6;
}

const n = x => Number(x || 0).toLocaleString('en-US');
/** "claude-sonnet-5-5 · 4,184 tokens (3,900 in · 284 out)" */
export function usageLine(u, prices) {
  if (!u) return '';
  const cost = costOf(u, prices);
  return `${u.model || 'AI'} · ${n(u.total)} tokens (${n(u.input + (u.cacheRead || 0) + (u.cacheWrite || 0))} in · ${n(u.output)} out)${cost != null ? ` · ≈ $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ''}`;
}

/** Store one call (best effort — never breaks the feature). */
export async function recordUsage({ feature, usage, entityType = null, entityId = null, ok = true, error = null }) {
  try {
    const { admin } = await import('./supabase.js');
    const ctx = aiContext.getStore() || {};
    const { error: e } = await admin.from('ai_usage').insert({
      user_id: ctx.userId || null, org_id: ctx.orgId || null, supplier_id: ctx.supplierId || null, feature, model: usage?.model || null,
      input_tokens: usage?.input || 0, output_tokens: usage?.output || 0, cache_read_tokens: usage?.cacheRead || 0, cache_write_tokens: usage?.cacheWrite || 0,
      entity_type: entityType, entity_id: entityId ? String(entityId) : null, ok, error: error ? String(error).slice(0, 500) : null,
    });
    if (e && !/ai_usage/.test(e.message)) console.error(`[ai-usage] ${e.message}`);
  } catch (e) { console.error(`[ai-usage] ${e.message}`); }
}

// admin-entered prices (USD per million tokens), cached for a minute
let priceCache = { at: 0, value: null };
export async function getPrices() {
  if (Date.now() - priceCache.at < 60e3) return priceCache.value;
  try {
    const { admin } = await import('./supabase.js');
    const { data } = await admin.from('settings').select('value').eq('key', 'ai_prices').maybeSingle();
    priceCache = { at: Date.now(), value: data?.value || null };
  } catch { priceCache = { at: Date.now(), value: null }; }
  return priceCache.value;
}
export const clearPriceCache = () => { priceCache = { at: 0, value: null }; };
