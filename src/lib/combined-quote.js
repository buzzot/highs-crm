// One quotation made of every line of a request: totals for the preview, the client's accept-all card, the PDF and the PO.
import { renderDocument } from './doc-pdf.js';
import { clientLines } from './purchase.js';

const r2 = x => Math.round(x * 100) / 100;
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = d => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** Quote statuses that belong to the current offer. */
export const LIVE = ['draft', 'sent', 'accepted'];

/**
 * @param quotes   rows from `quotes` (any mix; only same-currency lines are summed)
 * @param opts.nameOf / skuOf   (quote) => text for the line
 */
export function combineQuotes(quotes, { nameOf = () => 'Item', skuOf = () => '' } = {}) {
  const qs = (quotes || []).filter(Boolean);
  const currencies = [...new Set(qs.map(q => q.sell_currency || 'USD'))];
  const lines = qs.map(q => {
    const quantity = num(q.quantity), unit_price = num(q.unit_price);
    const freight = num(q.freight_estimate), duties = num(q.duties_estimate), other = num(q.other_costs);
    const goods = r2(quantity * unit_price), logistics = r2(freight + duties + other);
    const cost = q.unit_cost != null && q.fx_rate != null ? r2(num(q.unit_cost) * num(q.fx_rate) * quantity) : null;
    return { id: q.id, name: nameOf(q), sku: skuOf(q), quantity, unit_price, goods, freight, duties, other, logistics, total: r2(goods + logistics), cost, status: q.status, margin_pct: q.margin_pct };
  });
  const sum = k => r2(lines.reduce((t, l) => t + l[k], 0));
  const costKnown = lines.length > 0 && lines.every(l => l.cost != null);
  const incoterms = [...new Set(qs.map(q => q.incoterm).filter(Boolean))];
  const leads = qs.map(q => num(q.lead_time_days)).filter(x => x > 0);
  const valids = qs.map(q => q.valid_until).filter(Boolean).sort();
  const goodsTotal = sum('goods'), cost = costKnown ? sum('cost') : null;
  return {
    lines, count: lines.length, currency: currencies[0] || 'USD', mixed: currencies.length > 1,
    goodsTotal, freight: sum('freight'), duties: sum('duties'), other: sum('other'), logisticsTotal: sum('logistics'), grandTotal: sum('total'),
    cost, profit: cost != null ? r2(goodsTotal - cost) : null, marginPct: cost ? r2((goodsTotal - cost) / cost * 100) : null,
    incoterm: incoterms.length === 1 ? incoterms[0] : null, lead_time_days: leads.length ? Math.max(...leads) : null, valid_until: valids[0] || null,
  };
}

/** The lines a combined PO starts from: goods at ex-logistics prices, plus one estimated-logistics line so the PO total equals the quote total. */
export function poLinesFromCombined(c) {
  const lines = c.lines.map(l => ({ description: l.name, sku: l.sku || '', quantity: l.quantity, unit: 'pcs', unit_price: l.unit_price }));
  if (c.logisticsTotal > 0) lines.push({ description: 'Freight & logistics (estimate)', sku: '', quantity: 1, unit: 'lot', unit_price: c.logisticsTotal });
  return lines;
}

const companyBlock = c => ({ name: c.name, lines: [...String(c.address || '').split('\n').map(x => x.trim()).filter(Boolean), [c.email, c.phone].filter(Boolean).join(' · '), c.website].filter(Boolean) });

export function quotationDocument({ request, combined: c, org, company }) {
  const o = org || {};
  const address = [o.address, [o.postal_code, o.city].filter(Boolean).join(' '), o.country].filter(Boolean).join('\n');
  const dest = [request?.destination_city, request?.destination_country].filter(Boolean).join(', ');
  return {
    title: 'QUOTATION', no: request?.ref || 'Quotation', date: day(),
    seller: companyBlock(company), partyLabel: 'Quotation for', party: { name: o.name || '—', lines: clientLines({ phone: o.phone, address }, { delivery: false }) },
    meta: [['Request', request?.title], ['Incoterm', c.incoterm], ['Destination', dest], ['Lead time', c.lead_time_days ? `${c.lead_time_days} days` : null], ['Valid until', c.valid_until ? day(c.valid_until + 'T12:00:00') : null], ['Currency', c.currency]],
    currency: c.currency, lines: poLinesFromCombined(c),
    sections: [{ heading: 'Payment terms', text: company.payment_terms }, { heading: 'Notes', text: 'Prices are per unit for the quantities shown. Freight and logistics are an estimate until the shipment is booked.' }],
    footer: `${request?.ref || ''} · ${company.name}`,
  };
}

export const quotationPdf = args => renderDocument(quotationDocument(args));
