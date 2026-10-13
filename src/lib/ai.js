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

// ---------------------------------------------------------------------------------------------
// Product import: extraction from PDFs, photos and free-form spreadsheets, and a review pass.
// Both use forced tool calls so the model always returns structured JSON.
// ---------------------------------------------------------------------------------------------
export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

const numOrNull = { type: ['number', 'null'] };
const strOrNull = { type: ['string', 'null'] };
const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Product name / description in English (translate Chinese, keep model numbers)' },
    supplier_sku: { ...strOrNull, description: "Supplier's item / model / article number" },
    category: strOrNull,
    hs_code: { ...strOrNull, description: 'Only if stated in the document; never invent one' },
    unit_weight_kg: { ...numOrNull, description: 'Weight of ONE piece in kg (convert g → kg)' },
    unit_length_cm: numOrNull, unit_width_cm: numOrNull, unit_height_cm: numOrNull,
    carton_qty: { ...numOrNull, description: 'Pieces per export carton' },
    carton_weight_kg: { ...numOrNull, description: 'Gross weight of one carton, kg' },
    carton_length_cm: numOrNull, carton_width_cm: numOrNull, carton_height_cm: numOrNull,
    unit_price: { ...numOrNull, description: 'Unit price as a number, without currency symbol' },
    currency: { ...strOrNull, description: 'ISO code: CNY (¥/RMB/元), USD ($), EUR (€)' },
    moq: numOrNull,
    notes: { ...strOrNull, description: 'Material, certification, packaging, price terms (FOB/EXW), tiers, colours' },
    source_row: { ...numOrNull, description: 'Spreadsheet row number the product came from (spreadsheets only)' },
    page: { ...numOrNull, description: 'PDF page the product appears on' },
  },
  required: ['name'],
};
const EXTRACT_TOOL = {
  name: 'record_products',
  description: 'Record the supplier details and every product found in the document.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: {
        type: 'object',
        properties: { name: strOrNull, address: strOrNull, contact_name: strOrNull, email: strOrNull, phone: strOrNull, wechat: strOrNull, website: strOrNull },
      },
      products: { type: 'array', items: PRODUCT_SCHEMA },
      notes: { type: 'string', description: 'Anything the reviewer should know: unclear units, price tiers, missing data, pages skipped' },
    },
    required: ['supplier', 'products'],
  },
};

async function forcedTool({ tool, content, system, maxTokens = 16000 }) {
  const client = new Anthropic();
  const msg = await client.messages.stream({
    model: MODEL, max_tokens: maxTokens, system,
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  const use = msg.content.find(c => c.type === 'tool_use');
  if (!use) throw new Error('AI returned no structured result.');
  return { input: use.input, truncated: msg.stop_reason === 'max_tokens', model: MODEL };
}

/**
 * Extract supplier + products from a PDF / image (buffer) or spreadsheet text.
 * @param {{ pdf?: Buffer, image?: { data: Buffer, mediaType: string }, text?: string, filename: string }} src
 */
export async function extractProducts(src) {
  const system = `You extract product data for a China-sourcing trading company from supplier documents
(price lists, quotations, catalogues, product forms). Be exact: copy numbers as written, convert units to kg and cm,
never guess values that are not in the document (use null), translate Chinese product names to English (keep the original in notes if useful).
One entry per distinct product/variant with its own price or SKU. Ignore example/sample rows marked "EXAMPLE".
The supplier is the company that ISSUED the document (letterhead, stamp, signature, "From"), not the buyer.`;
  const content = [];
  if (src.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: src.pdf.toString('base64') } });
  if (src.image) content.push({ type: 'image', source: { type: 'base64', media_type: src.image.mediaType, data: src.image.data.toString('base64') } });
  content.push({
    type: 'text',
    text: `File: ${src.filename}\n${src.text ? `Spreadsheet contents (row number first, tab-separated cells):\n\n${src.text.slice(0, 180000)}\n\n` : ''}Extract the supplier and all products with record_products. For spreadsheets set source_row to the row number.`,
  });
  const { input, truncated, model } = await forcedTool({ tool: EXTRACT_TOOL, content, system });
  return { supplier: input.supplier || {}, products: input.products || [], notes: [input.notes, truncated ? 'The document was long — the AI may have stopped before the last products. Check the end of the list.' : null].filter(Boolean).join(' '), model };
}

const REVIEW_TOOL = {
  name: 'report_issues',
  description: 'Report problems found in the imported product rows.',
  input_schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            row: { type: 'integer', description: 'Index from the list (0-based)' },
            field: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            message: { type: 'string' },
            suggestion: { type: ['string', 'null'], description: 'Suggested corrected value, if confident' },
          },
          required: ['row', 'field', 'severity', 'message'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['issues'],
  },
};

/** Second opinion on imported rows: HS code vs product, implausible weights/sizes/prices, duplicates. */
export async function reviewProducts({ supplier, products }) {
  const rows = products.slice(0, 200).map((p, i) => ({ i, ...p, image: undefined, match: undefined, issues: undefined }));
  const { input } = await forcedTool({
    tool: REVIEW_TOOL, maxTokens: 8000,
    system: `You check product data before it is imported into a trading company's catalogue.
Flag only real problems: HS code that doesn't fit the product (give the likely 6-digit heading as suggestion), weights/sizes
that are implausible for the product or inconsistent with the carton (units in g/mm instead of kg/cm), carton quantity that
doesn't fit the carton volume, prices that look like a different currency or unit (per dozen / per set), duplicate rows,
and missing data that matters for shipping (carton size/weight). Be concise. Don't repeat the same issue for every row — mention it once per row only when it applies.`,
    content: [{ type: 'text', text: JSON.stringify({ supplier: { name: supplier?.name }, products: rows }) }],
  });
  return { issues: input.issues || [], summary: input.summary || '' };
}
