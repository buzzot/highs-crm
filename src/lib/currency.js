// The company's default currency (Settings → Company details): default for new documents, and the currency totals and KPIs are shown in.
import { getCompany } from './purchase.js';
import { fxRate } from './util.js';

export const CURRENCY_CHOICES = ['CNY', 'USD', 'EUR', 'GBP'];
export const okCurrency = c => (CURRENCY_CHOICES.includes(c) ? c : 'CNY');

// read on every admin page, changes only when the company settings are saved → kept for 30 s (and dropped on save)
let curCache = { at: 0, value: 'CNY' };
export const clearDefaultCurrency = () => { curCache = { at: 0, value: 'CNY' }; };
export async function defaultCurrency(db) {
  if (Date.now() - curCache.at < 30e3) return curCache.value;
  try { curCache = { at: Date.now(), value: okCurrency((await getCompany(db)).default_currency) }; } catch { return curCache.value; }
  return curCache.value;
}

/** Sum amounts that are in different currencies in one currency: sumIn(settings, 'CNY', [[100, 'USD'], [50, 'CNY']]). */
export function sumIn(settings, target, pairs) {
  return pairs.reduce((t, [v, cur]) => t + Number(v || 0) * fxRate(settings, cur || target, target), 0);
}
