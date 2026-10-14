// Per-company AI switch (clients and suppliers) and their token usage by month.
import { admin } from './supabase.js';
import { aiEnabled } from './ai.js';

const TABLE = { organization: 'organizations', supplier: 'suppliers' };
const COL = { organization: 'org_id', supplier: 'supplier_id' };

/** True when the server has an API key AND the admin switched AI on for this company. */
export async function companyAiOn(kind, id) {
  if (!aiEnabled() || !id) return false;
  const { data } = await admin.from(TABLE[kind]).select('ai_enabled').eq('id', id).maybeSingle();
  return data?.ai_enabled === true;
}

export async function setCompanyAi(kind, id, on) {
  return admin.from(TABLE[kind]).update({ ai_enabled: !!on }).eq('id', id);
}

const monthKey = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const blank = () => ({ calls: 0, input: 0, output: 0, total: 0 });

/** Tokens used by this company's people: last 6 months + all time. { months:[{key,label,...}], all, current, ready } */
export async function usageSummary(kind, id) {
  const { data, error } = await admin.from('ai_usage').select('created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ok')
    .eq(COL[kind], id).order('created_at', { ascending: false }).limit(20000);
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, k) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    return { key: monthKey(d), label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), ...blank() };
  });
  const all = blank();
  for (const r of data || []) {
    const input = (r.input_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0), output = r.output_tokens || 0;
    const add = o => { o.calls++; o.input += input; o.output += output; o.total += input + output; };
    add(all);
    const m = months.find(x => x.key === monthKey(new Date(r.created_at)));
    if (m) add(m);
  }
  return { ready: !error, months, current: months[0], all };
}
