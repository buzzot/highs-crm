import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

/**
 * AI verification of a quote. Returns a structured review:
 * { ok: boolean, score: 0-100, issues: [{severity, field, message}], summary }
 * Falls back to rule-only output if ANTHROPIC_API_KEY is not set.
 */
export async function verifyQuote({ quote, calc, product, supplier, request, settings }) {
  const ruleIssues = calc.warnings.map(w => ({ severity: 'high', field: 'pricing', message: w }));

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: ruleIssues.length === 0,
      score: ruleIssues.length === 0 ? 80 : 40,
      issues: ruleIssues,
      summary: 'Rule-based check only (ANTHROPIC_API_KEY not configured).',
      model: null,
      checked_at: new Date().toISOString(),
    };
  }

  const client = new Anthropic();
  const payload = {
    rules: {
      min_margin_pct: settings?.pricing?.min_margin_pct ?? 20,
      margin_basis: 'product cost only; logistics excluded',
      export: 'should be official with government-issued export declaration',
    },
    request: request && {
      title: request.title, description: request.description, quantity: request.quantity,
      target_unit_price: request.target_unit_price, destination: request.destination_country,
      needed_by: request.needed_by,
    },
    product: product && {
      name: product.name, category: product.category, hs_code: product.hs_code,
      moq: product.moq, unit_weight_kg: product.unit_weight_kg, carton_cbm: product.carton_cbm, carton_qty: product.carton_qty,
    },
    supplier: supplier && {
      name: supplier.name, lead_time_days: supplier.lead_time_days, rating: supplier.rating,
      can_export_official: supplier.can_export_official,
    },
    quote: {
      quantity: quote.quantity, unit_cost: quote.unit_cost, cost_currency: quote.cost_currency,
      fx_rate: quote.fx_rate, margin_pct: quote.margin_pct, unit_price: quote.unit_price,
      sell_currency: quote.sell_currency, freight_estimate: quote.freight_estimate,
      duties_estimate: quote.duties_estimate, other_costs: quote.other_costs,
      incoterm: quote.incoterm, lead_time_days: quote.lead_time_days,
    },
    computed: calc,
  };

  const system = `You are a pricing QA reviewer for a China-sourcing trading company.
Review the quote for: margin below minimum, arithmetic errors, FX rate plausibility (CNY->USD is roughly 0.13-0.15),
quantity below supplier MOQ, freight estimate plausibility versus weight/volume and mode, HS code plausibility for the product,
lead time versus the client's needed-by date, missing fields, and whether the price is likely to be competitive against the client's target.
Respond ONLY with JSON: {"ok":bool,"score":0-100,"issues":[{"severity":"high|medium|low","field":string,"message":string}],"summary":string}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = msg.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    parsed = { ok: false, score: 0, issues: [{ severity: 'low', field: 'ai', message: 'Could not parse AI response.' }], summary: text.slice(0, 500) };
  }
  // Rules always win over the model.
  const issues = [...ruleIssues, ...(parsed.issues || [])];
  return {
    ok: ruleIssues.length === 0 && !!parsed.ok,
    score: Math.min(Number(parsed.score) || 0, ruleIssues.length ? 49 : 100),
    issues,
    summary: parsed.summary || '',
    model: MODEL,
    checked_at: new Date().toISOString(),
  };
}

/** Draft a client-facing request summary / sourcing brief from a free-text request. */
export async function summarizeRequest(request) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Turn this client request into a concise sourcing brief for a China sourcing team: product spec bullets, likely category, suggested HS chapter, questions to clarify with the client.\n\n${JSON.stringify(request)}`,
    }],
  });
  return msg.content.map(c => (c.type === 'text' ? c.text : '')).join('');
}
