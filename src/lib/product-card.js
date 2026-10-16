// Pure helper for the product AI scan (kept apart from ai.js so it can be unit tested without the SDK).
/** Normalise the tool output into the form fields (strings for text, finite positive numbers for numeric fields). */
export function cleanCard(input = {}) {
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const out = {
    name: str(input.name), supplier_sku: str(input.supplier_sku), category: str(input.category), description: str(input.description), hs_code: str(input.hs_code),
    unit_cost: num(input.unit_cost), cost_currency: ['CNY', 'USD', 'EUR'].includes(input.cost_currency) ? input.cost_currency : null, moq: num(input.moq) && Math.round(input.moq),
    carton_qty: num(input.carton_qty) && Math.round(input.carton_qty),
  };
  for (const k of ['unit_weight_kg', 'unit_length_cm', 'unit_width_cm', 'unit_height_cm', 'carton_weight_kg', 'carton_length_cm', 'carton_width_cm', 'carton_height_cm']) out[k] = num(input[k]);
  out.spec = (Array.isArray(input.spec) ? input.spec : []).filter(x => x && str(x.key) && str(x.value)).slice(0, 15).map(x => `${str(x.key)}: ${str(x.value)}`).join('\n') || null;
  out.warnings = (Array.isArray(input.warnings) ? input.warnings : []).map(str).filter(Boolean).slice(0, 6);
  return out;
}

