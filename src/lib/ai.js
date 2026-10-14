import Anthropic from '@anthropic-ai/sdk';
import { usageFrom, recordUsage } from './ai-usage.js';

/** Run one API call, record its tokens (or the failure), return { msg, usage }. */
async function tracked(feature, entity, fn) {
  try {
    const msg = await fn();
    const usage = usageFrom(msg, MODEL);
    await recordUsage({ feature, usage, entityType: entity?.type, entityId: entity?.id });
    return { msg, usage };
  } catch (e) {
    await recordUsage({ feature, usage: { model: MODEL, input: 0, output: 0 }, entityType: entity?.type, entityId: entity?.id, ok: false, error: e.message });
    throw e;
  }
}

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

  const { msg, usage } = await tracked('quote_check', { type: 'quote', id: quote?.id }, () => client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  }));

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
    model: usage.model || MODEL,
    usage,
    checked_at: new Date().toISOString(),
  };
}

/** Draft a client-facing request summary / sourcing brief from a free-text request. */
/**
 * Compare 2–6 products for a buyer. Returns
 * { summary, recommended_id, ranking: [{ id, score, verdict, pros: [], cons: [] }], risks: [], questions: [] }.
 * Uses a plain JSON answer (no tool forcing) so it works with every model.
 */
export async function compareProducts({ products, purpose }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI is not configured (set ANTHROPIC_API_KEY).');
  const client = new Anthropic();
  const system = `You are a senior sourcing manager at a trading company that buys from Chinese factories and sells wholesale.
Compare the products for a buyer. Weigh: landed cost per unit (factory price + sea freight per unit), price per unit of function/size,
MOQ and the money tied up at MOQ, units per 40HQ container (shipping efficiency), packaging data quality (missing carton size/weight/HS code is a risk),
supplier factors (rating, export rights, lead time, company type), and anything in the specs or description.
Be concrete and short; use the numbers you are given; never invent data — say what is missing.
Respond ONLY with JSON:
{"summary": string (2–4 sentences), "recommended_id": string|null,
 "ranking": [{"id": string, "score": 0-100, "verdict": string (one line), "pros": [string], "cons": [string]}],
 "risks": [string], "questions": [string] (what to ask the suppliers before ordering)}`;
  const { msg, usage } = await tracked('product_compare', null, () => client.messages.create({
    model: MODEL, max_tokens: 4000, system,
    messages: [{ role: 'user', content: `${purpose ? `What the buyer needs: ${purpose}\n\n` : ''}Products (prices in USD unless noted):\n${JSON.stringify(products, null, 1)}` }],
  }));
  const text = msg.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let out;
  try { out = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('AI answer could not be read — try again.'); }
  const ids = new Set(products.map(p => p.id));
  out.ranking = (out.ranking || []).filter(x => ids.has(x.id)).sort((x, y) => (y.score || 0) - (x.score || 0));
  if (!ids.has(out.recommended_id)) out.recommended_id = out.ranking[0]?.id || null;
  out.risks ||= []; out.questions ||= [];
  return { ...out, model: usage.model || MODEL, usage, at: new Date().toISOString() };
}

export async function summarizeRequest(request, requestId = null) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const { msg, usage } = await tracked('sourcing_brief', { type: 'request', id: requestId }, () => client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Turn this client request into a concise sourcing brief for a China sourcing team: product spec bullets, likely category, suggested HS chapter, questions to clarify with the client.\n\n${JSON.stringify(request)}`,
    }],
  }));
  return { text: msg.content.map(c => (c.type === 'text' ? c.text : '')).join(''), usage };
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

// Some models reject a forced tool choice ("tool"/"any"), e.g. when extended thinking is always on.
// Then we offer the tool with tool_choice "auto", tell the model it must use it, and as a last resort
// read JSON from the text answer. Remembered per process so later calls skip the failing attempt.
let forcedUnsupported = false;
const isToolChoiceError = e => e?.status === 400 && /tool_choice/i.test(e?.message || '');

function jsonFromText(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function forcedTool({ tool, content, system, maxTokens = 16000, feature, entity }) {
  const client = new Anthropic();
  const run = forced => tracked(feature, entity, () => client.messages.stream({
    model: MODEL, max_tokens: maxTokens,
    system: forced ? system : `${system}\n\nYou MUST answer by calling the \`${tool.name}\` tool exactly once with the complete result. Do not answer in plain text.`,
    tools: [tool], tool_choice: forced ? { type: 'tool', name: tool.name } : { type: 'auto' },
    messages: [{ role: 'user', content }],
  }).finalMessage());

  let msg, usage;
  if (!forcedUnsupported) {
    try { ({ msg, usage } = await run(true)); } catch (e) {
      if (!isToolChoiceError(e)) throw e;
      forcedUnsupported = true;
      console.warn(`[ai] ${MODEL} does not support a forced tool choice — using tool_choice "auto"`);
    }
  }
  if (!msg) ({ msg, usage } = await run(false));

  const use = msg.content.find(c => c.type === 'tool_use' && c.name === tool.name);
  const input = use?.input || jsonFromText(msg.content.map(c => (c.type === 'text' ? c.text : '')).join(''));
  if (!input) throw new Error('AI returned no structured result. Try again, or use the Excel template.');
  return { input, truncated: msg.stop_reason === 'max_tokens', model: usage.model || MODEL, usage };
}

/**
 * Extract supplier + products from a PDF / image (buffer) or spreadsheet text.
 * @param {{ pdf?: Buffer, image?: { data: Buffer, mediaType: string }, text?: string, filename: string }} src
 */
export async function extractProducts(src, entity = null) {
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
  const { input, truncated, model, usage } = await forcedTool({ tool: EXTRACT_TOOL, content, system, feature: 'product_extract', entity });
  return { supplier: input.supplier || {}, products: input.products || [], notes: [input.notes, truncated ? 'The document was long — the AI may have stopped before the last products. Check the end of the list.' : null].filter(Boolean).join(' '), model, usage };
}

const PRODUCT_INFO_TOOL = {
  name: 'record_product_info',
  description: 'Record what the attached files say about ONE product the client wants to buy.',
  input_schema: {
    type: 'object',
    properties: {
      name: { ...strOrNull, description: 'Short product name in English (type + key attribute, e.g. "Stainless steel tumbler 500 ml")' },
      sku: { ...strOrNull, description: 'Model / SKU / part / article number exactly as printed, or null' },
      description: { ...strOrNull, description: 'Only the main specs printed or clearly visible (e.g. material, size, colour, capacity), as one short line or a few short lines. No comments, analysis, marketing text or guesses. null if nothing useful.' },
    },
    required: ['name', 'sku', 'description'],
  },
};

/** Read photos / a PDF the client attached to one product line and suggest name, SKU and details. */
export async function extractProductInfo({ files = [], name = '', description = '' }, entity = null) {
  const system = `You help a sourcing company understand what a client wants to buy. Look at the attached photo(s) / PDF of ONE product
(catalogue page, competitor listing, screenshot, product photo, label) and fill in name, SKU/model number and details.
Never invent facts that are not visible; use null when unknown. Translate Chinese to English.
Be brief: the details field holds only the main data (key specs), at most about 5 short items. No comments, no analysis, no advice, no sentences like "this appears to be", no repeating the name or SKU.
If the client already typed a name or details, keep their meaning and only improve or complete it with what the files show.`;
  const content = [];
  for (const f of files.slice(0, 4)) {
    if (f.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.pdf.toString('base64') } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data.toString('base64') } });
  }
  content.push({ type: 'text', text: `Client typed so far — name: ${name || '(empty)'}; details: ${description || '(empty)'}.\nCall record_product_info.` });
  const { input, usage } = await forcedTool({ tool: PRODUCT_INFO_TOOL, content, system, maxTokens: 2000, feature: 'request_product_fill', entity });
  const s = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { name: s(input.name), sku: s(input.sku), description: s(input.description), usage };
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
export async function reviewProducts({ supplier, products }, entity = null) {
  const rows = products.slice(0, 200).map((p, i) => ({ i, ...p, image: undefined, match: undefined, issues: undefined }));
  const { input, usage } = await forcedTool({ feature: 'product_review', entity,
    tool: REVIEW_TOOL, maxTokens: 8000,
    system: `You check product data before it is imported into a trading company's catalogue.
Flag only real problems: HS code that doesn't fit the product (give the likely 6-digit heading as suggestion), weights/sizes
that are implausible for the product or inconsistent with the carton (units in g/mm instead of kg/cm), carton quantity that
doesn't fit the carton volume, prices that look like a different currency or unit (per dozen / per set), duplicate rows,
and missing data that matters for shipping (carton size/weight). Be concise. Don't repeat the same issue for every row — mention it once per row only when it applies.`,
    content: [{ type: 'text', text: JSON.stringify({ supplier: { name: supplier?.name }, products: rows }) }],
  });
  return { issues: input.issues || [], summary: input.summary || '', usage };
}

// ---------------------------------------------------------------------------------------------
// Packing list extraction (Excel text, PDF or screenshot) → standard lines.
// ---------------------------------------------------------------------------------------------
const PACKING_TOOL = {
  name: 'record_packing_list',
  description: 'Record every line of the packing list. Values per carton unless the field says total.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            carton_no: { ...strOrNull, description: 'Carton number or range as printed, e.g. "1-20"' },
            cartons: { ...numOrNull, description: 'Number of cartons on this line' },
            description: { ...strOrNull, description: 'Goods description in English (translate Chinese, keep model numbers)' },
            sku: { ...strOrNull, description: 'Item / model / article number' },
            hs_code: strOrNull,
            quantity: { ...numOrNull, description: 'Pieces in EACH carton' },
            total_quantity: { ...numOrNull, description: 'Total pieces on this line, if only the total is given' },
            length_cm: numOrNull, width_cm: numOrNull, height_cm: numOrNull,
            gross_weight_kg: { ...numOrNull, description: 'Gross weight of ONE carton, kg' },
            net_weight_kg: { ...numOrNull, description: 'Net weight of ONE carton, kg' },
            total_gross_weight_kg: { ...numOrNull, description: 'Total gross weight of the line, if only the total is given' },
            total_net_weight_kg: numOrNull,
          },
          required: ['description'],
        },
      },
      shipping_marks: strOrNull,
      notes: { type: 'string', description: 'Anything unclear: units in mm/g/lbs converted, totals that do not add up, unreadable values' },
    },
    required: ['lines'],
  },
};

export async function extractPacking(src, entity = null) {
  const system = `You read packing lists from Chinese factories (Excel exports, PDFs, phone screenshots, WeChat images).
Return one entry per line of the packing list. Copy numbers exactly; convert mm→cm, g→kg, lbs→kg, inches→cm.
Dimensions and weights are PER CARTON. If the document only gives totals for a line, fill the total_* fields instead.
Never invent values — use null when something is not in the document. Skip TOTAL rows.`;
  const content = [];
  if (src.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: src.pdf.toString('base64') } });
  if (src.image) content.push({ type: 'image', source: { type: 'base64', media_type: src.image.mediaType, data: src.image.data.toString('base64') } });
  content.push({ type: 'text', text: `File: ${src.filename}\n${src.text ? `Spreadsheet contents (row number first, tab-separated):\n\n${src.text.slice(0, 120000)}\n\n` : ''}Record the packing list with record_packing_list.` });
  const { input, truncated, usage } = await forcedTool({ tool: PACKING_TOOL, content, system, maxTokens: 12000, feature: 'packing_extract', entity });
  return {
    lines: input.lines || [], marks: input.shipping_marks || null,
    notes: [input.notes, truncated ? 'The document was long — the AI may have stopped early. Check the last lines.' : null].filter(Boolean).join(' '),
    usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Freight quote reply (email or WeChat text) → price, transit, validity.
// ---------------------------------------------------------------------------------------------
const QUOTE_TOOL = {
  name: 'record_freight_quote',
  description: "Record the forwarder's offer from their reply (email text, attached quotation PDF/Excel, or screenshot).",
  input_schema: {
    type: 'object',
    properties: {
      is_quote: { type: 'boolean', description: 'false if there is no price (a question, "will check", out-of-office)' },
      company: { ...strOrNull, description: "Forwarder's company name" },
      contact_person: { ...strOrNull, description: 'Person who quoted' },
      email: strOrNull, phone: { ...strOrNull, description: 'Phone and/or WeChat' },
      quote_date: { ...strOrNull, description: 'YYYY-MM-DD the quote was issued' },
      valid_until: { ...strOrNull, description: 'YYYY-MM-DD validity' },
      amount: { ...numOrNull, description: 'All-in total for the shipment; if only unit prices are given, compute it from the shipment totals in context' },
      currency: { ...strOrNull, description: 'ISO code: USD, CNY, EUR…' },
      unit_price: { ...numOrNull, description: 'Main freight unit price' },
      unit_basis: { ...strOrNull, description: 'per kg / per cbm / per container / per shipment' },
      mode: { ...strOrNull, description: 'Sea FCL / Sea LCL / Air / Express / Rail / Truck' },
      scope: { ...strOrNull, description: 'Port to port / door to door DDP / DDU…' },
      transit_days: { ...numOrNull, description: 'Transit time in days (upper value of a range)' },
      etd: { ...strOrNull, description: 'Shipping date / ETD, YYYY-MM-DD' },
      handover: { type: ['string', 'null'], enum: ['pickup', 'warehouse', null], description: "pickup = they collect from our supplier; warehouse = supplier must deliver to the forwarder's warehouse" },
      pickup_date: { ...strOrNull, description: 'Pickup date or last day to deliver to their warehouse, YYYY-MM-DD' },
      warehouse_address: strOrNull, warehouse_contact: strOrNull,
      cutoff_date: { ...strOrNull, description: 'Warehouse / port cut-off, YYYY-MM-DD' },
      loading_port: { ...strOrNull, description: 'Loading port / terminal if stated' },
      routing: { type: ['string', 'null'], enum: ['direct', 'transshipment', null], description: 'Direct sailing/flight or transshipment' },
      via: { ...strOrNull, description: 'Transshipment port/airport if any' },
      latest_receiving_date: { ...strOrNull, description: 'Latest date to receive the goods (warehouse / cut-off), YYYY-MM-DD' },
      vessel_flight: { ...strOrNull, description: 'Vessel / voyage or flight number' },
      breakdown: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, per: strOrNull, unit_price: numOrNull, qty: numOrNull, amount: numOrNull, currency: strOrNull, notes: strOrNull } }, description: 'Every cost line as written: freight, pickup, warehouse, customs/documents, origin and destination charges, surcharges, insurance, duties, delivery…' },
      includes: strOrNull, excludes: { ...strOrNull, description: 'Not included / possible extra charges' },
      questions: { ...strOrNull, description: 'Anything the forwarder asks us' },
      summary: { type: 'string', description: 'One line in English, e.g. "USD 1,850 Sea LCL door to door · 32 days · ETD 2 Nov · valid to 31 Oct · pickup from supplier"' },
    },
    required: ['is_quote', 'summary'],
  },
};

/** @param {{ text?: string, context?: object, pdf?: Buffer, image?: { data: Buffer, mediaType: string }, sheetText?: string }} src */
export async function extractQuote({ text, context, pdf, image, sheetText }, entity = null) {
  const system = `You read replies from freight forwarders (often Chinese/English mixed, from email or WeChat, sometimes with a quotation PDF, Excel or screenshot) to a freight quote request.
Extract the offer exactly as written. Do not convert currencies. If several options are given, use the cheapest complete option for amount
and list the others in breakdown. If prices are per cbm/kg, compute the total using the shipment totals given in context and say so in summary.
Dates as YYYY-MM-DD (assume the current or next year when the year is missing). Never invent numbers or contact details.`;
  const content = [];
  if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data.toString('base64') } });
  content.push({ type: 'text', text: `Shipment we asked about: ${JSON.stringify(context || {})}\n\nReply:\n${String(text || '(no text)').slice(0, 15000)}${sheetText ? `\n\nAttached spreadsheet:\n${sheetText.slice(0, 30000)}` : ''}` });
  const { input, usage } = await forcedTool({ tool: QUOTE_TOOL, content, system, maxTokens: 4000, feature: 'freight_quote_read', entity });
  return { ...input, usage };
}
