// Realistic sample data shaped like the Supabase query results each route passes to its view.
import { fmt } from '../src/lib/format.js';
import { icon } from '../src/lib/icons.js';
import { calcQuote } from '../src/lib/pricing.js';
import { landed } from '../src/lib/landed.js';

const d = n => new Date(Date.now() + n * 864e5).toISOString();
const day = n => d(n).slice(0, 10);
export const settings = { fx: { CNY_USD: 0.138, USD_CNY: 7.25, EUR_USD: 1.08 }, pricing: { min_margin_pct: 20, default_margin_pct: 25 } };

const staffUser = { id: 'u1', email: 'anna@lumitrade.example', full_name: 'Anna Lee', role: 'admin', org_id: null };
const clientUser = { id: 'u9', email: 'tom@acme.example', full_name: 'Tom Baker', role: 'client', org_id: 'o1', organizations: { id: 'o1', name: 'Acme Retail LLC' } };

const org = { id: 'o1', name: 'Acme Retail LLC', country: 'USA', tax_id: 'US-88-1234567', default_currency: 'USD', address: '120 Market St\nSan Francisco, CA', notes: 'Prefers sea LCL, monthly reorders.', active: true, created_at: d(-200) };
const sup = { id: 's1', name: 'Shenzhen Brightway Electronics', country: 'China', city: 'Shenzhen', contact_name: 'Li Wei', phone: '+86 138 0000 0000', email: 'liwei@brightway.example', wechat: 'liwei_bw', website: 'brightway.en.alibaba.com', payment_terms: '30% deposit, 70% before shipment', lead_time_days: 30, rating: 4, can_export_official: true, notes: 'BSCI audited 2025.', created_at: d(-300) };
const prod = { id: 'p1', sku: 'BW-LED-001', name: 'LED Desk Lamp 10W', category: 'Lighting', description: 'Foldable aluminium desk lamp, USB-C.', spec: { Power: '10 W', Material: 'Aluminium', Colour: 'Matte black' }, supplier_id: 's1', unit_cost: 38.5, cost_currency: 'CNY', moq: 500, hs_code: '9405.21', unit_weight_kg: 0.65, carton_qty: 20, carton_cbm: 0.045, carton_weight_kg: 14, created_at: d(-120) };
const prod2 = { ...prod, id: 'p2', sku: 'SH-STB-210', name: 'Stainless Steel Tumbler 500ml', category: 'Houseware', unit_cost: 12.2, moq: 1000, hs_code: '9617.00', supplier_id: 's2' };

const request = { id: 'r1', ref: 'REQ-2610-0042', org_id: 'o1', title: 'LED desk lamp, custom logo', description: '10W, foldable, USB-C, black.\nLaser logo on base. Retail box with our artwork.', quantity: 2000, target_unit_price: 6.9, target_currency: 'USD', destination_country: 'USA', destination_city: 'Los Angeles', needed_by: day(45), status: 'reviewing', assigned_to: 'u1', internal_notes: 'Brightway + one backup supplier.', ai_brief: '• Spec: 10W LED, foldable arm, USB-C\n• HS chapter 94 (9405)\n• Ask: colour temperature? certifications (FCC/UL)?', created_at: d(-6), updated_at: d(-1) };
const requests = [
  { ...request, organizations: { id: 'o1', name: 'Acme Retail LLC' }, assignee: { full_name: 'Anna Lee' }, quotes: [{ id: 'q1', status: 'sent' }] },
  { ...request, id: 'r2', ref: 'REQ-2610-0043', title: 'Stainless tumbler 500ml', status: 'new', needed_by: day(10), quantity: 5000, organizations: { id: 'o2', name: 'Nordic Home AB' }, assignee: null, quotes: [] },
];

const calc = calcQuote({ unitCost: 38.5, fxRate: 0.138, marginPct: 25, quantity: 2000, freightTotal: 820, dutiesTotal: 300, otherTotal: 80 });
const quote = { id: 'q1', request_id: 'r1', product_id: 'p1', supplier_id: 's1', quantity: 2000, unit_cost: 38.5, cost_currency: 'CNY', fx_rate: 0.138, margin_pct: 25, sell_currency: 'USD', unit_price: calc.unitPrice, freight_estimate: 820, duties_estimate: 300, other_costs: 80, landed_unit_price: calc.landedUnitPrice, incoterm: 'FOB', lead_time_days: 30, valid_until: day(30), status: 'draft', notes: 'Price includes laser logo.', created_at: d(-2),
  ai_check: { ok: false, score: 72, issues: [{ severity: 'medium', field: 'lead_time', message: '30 days production + ~25 days sea leaves little buffer before the needed-by date.' }, { severity: 'low', field: 'hs_code', message: '9405.21 fits electric table lamps.' }], summary: 'Pricing is consistent; schedule is tight.', model: 'claude-sonnet-5-5', checked_at: d(-1) } };

const overview = { id: 'ord1', order_no: 'HB-2610-1187', org_id: 'o1', request_id: 'r1', quote_id: 'q1', supplier_id: 's1', status: 'in_production', currency: 'USD', subtotal: 13282.5, cost_total: 10626, freight_total: 1240, client_notes: 'Production started 8 Oct.', internal_notes: 'Deposit paid 7 Oct.', expected_ship_date: day(20), created_at: d(-9), updated_at: d(-1), client_name: 'Acme Retail LLC', supplier_name: sup.name, shipment_count: 1, latest_eta: day(48), margin_pct: 25, gross_profit: 1416.5 };
const items = [{ id: 'i1', order_id: 'ord1', product_id: 'p1', description: 'LED Desk Lamp 10W', quantity: 2000, unit_cost: 5.313, unit_price: 6.6413, hs_code: '9405.21', products: { id: 'p1', name: prod.name, sku: prod.sku } }];
const shipment = { id: 'sh1', order_id: 'ord1', forwarder_id: 'f1', mode: 'sea_lcl', incoterm: 'FOB', origin_port: 'Shenzhen (Yantian)', destination_port: 'Los Angeles', container_no: null, tracking_no: null, bl_no: 'OOLU2610458', export_declaration_no: null, export_official: true, etd: day(22), eta: day(48), atd: null, ata: null, status: 'booked', gross_weight_kg: 1400, volume_cbm: 4.5, cartons: 100, notes: '', created_at: d(-2) };
const costs = [
  { id: 'c1', shipment_id: 'sh1', type: 'main_freight', description: 'LCL Yantian → LA', amount: 765, currency: 'USD', fx_to_order: 1, invoice_ref: 'OL-5521', paid: false, created_at: d(-1) },
  { id: 'c2', shipment_id: 'sh1', type: 'export_declaration', description: 'Customs declaration', amount: 350, currency: 'CNY', fx_to_order: 0.138, invoice_ref: '', paid: true, paid_at: day(-1), created_at: d(-1) },
  { id: 'c3', shipment_id: 'sh1', type: 'origin_handling', description: 'THC + docs', amount: 1050, currency: 'CNY', fx_to_order: 0.138, invoice_ref: '', paid: false, created_at: d(-1) },
];
const docs = [
  { id: 'doc1', entity_type: 'order', entity_id: 'ord1', kind: 'product_photo', title: 'sample-front.jpg', mime_type: 'image/jpeg', client_visible: true, created_at: d(-3) },
  { id: 'doc2', entity_type: 'order', entity_id: 'ord1', kind: 'packing_photo', title: 'cartons.jpg', mime_type: 'image/jpeg', client_visible: false, created_at: d(-1) },
  { id: 'doc3', entity_type: 'order', entity_id: 'ord1', kind: 'proforma_invoice', title: 'PI-HB-2610-1187.pdf', mime_type: 'application/pdf', client_visible: true, created_at: d(-8) },
];
const events = [
  { id: 1, action: 'status_in_production', detail: { note: 'Production started, 40% done' }, client_visible: true, created_at: d(-1), profiles: { full_name: 'Anna Lee' } },
  { id: 2, action: 'documents_uploaded', detail: { note: '1 × proforma invoice' }, client_visible: true, created_at: d(-8), profiles: { full_name: 'Anna Lee' } },
  { id: 3, action: 'note', detail: { note: 'Supplier asked to confirm logo artwork' }, client_visible: false, created_at: d(-5), profiles: { email: 'ops@highs.example' } },
];
const packing = Array.from({ length: 4 }, (_, i) => ({ id: 'pk' + i, carton_no: String(i + 1), description: 'LED Desk Lamp 10W', quantity: 20, length_cm: 52, width_cm: 38, height_cm: 23, gross_weight_kg: 14, net_weight_kg: 13, cbm: 0.0454 }));
const forwarders = [{ id: 'f1', name: 'Oceanlink Logistics', contact_name: 'Amy Zhou', email: 'amy@oceanlink.example', modes: ['sea_fcl', 'sea_lcl'], notes: 'Good LCL rates to US West Coast' }, { id: 'f2', name: 'SkyFast Freight', contact_name: 'Ken Huang', modes: ['air', 'express'] }];
const lists = {
  products: [prod, prod2], suppliers: [{ id: 's1', name: sup.name, lead_time_days: 30 }, { id: 's2', name: 'Yiwu Sunhome Houseware', lead_time_days: 25 }],
  requests: requests.map(r => ({ id: r.id, ref: r.ref, title: r.title, quantity: r.quantity, target_unit_price: r.target_unit_price, target_currency: r.target_currency, organizations: r.organizations })),
};
const INCOTERMS = ['EXW', 'FOB', 'FCA', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DDP'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY'];
const ORDER_STATUSES = ['confirmed', 'deposit_paid', 'in_production', 'qc', 'packed', 'shipped', 'in_transit', 'customs', 'delivered', 'closed', 'cancelled'];

const base = (user, path, extra = {}) => ({ fmt, icon, user, path, query: {}, msg: null, err: null, ...extra });
const months = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'].map((label, i) => ({ key: label, label, revenue: [8200, 12100, 9400, 15800, 18300, 13300][i], profit: [1500, 2300, 1700, 3000, 3500, 2500][i] }));
const ordersList = [overview, { ...overview, id: 'ord2', order_no: 'HB-2610-1190', client_name: 'Nordic Home AB', status: 'qc', subtotal: 9150, cost_total: 7810, margin_pct: 17.2, gross_profit: 980, freight_total: 360 }, { ...overview, id: 'ord3', order_no: 'HB-2609-1102', status: 'in_transit', subtotal: 22400, margin_pct: 28, gross_profit: 3900 }];


// ---- product import ----
const impRows = [
  { i: 0, name: 'Desk lamp 12W touch dimmer', supplier_sku: 'BW-DL12', category: 'Lighting', hs_code: '9405.21.00', unit_weight_kg: 0.8, unit_length_cm: 35, unit_width_cm: 14, unit_height_cm: 9,
    carton_qty: 16, carton_weight_kg: 14.5, carton_length_cm: 56, carton_width_cm: 30, carton_height_cm: 40, unit_price: 45, currency: 'CNY', moq: 300, notes: 'CE', include: true,
    image_path: 'imports/x/row-0.png', source_row: 4, checks: [], cbm: 0.0672, match: { status: 'sku', supplier_id: 's1', supplier_name: sup.name, product: { id: 'p1', name: 'LED Desk Lamp 10W', unit_cost: 38.5, cost_currency: 'CNY' } } },
  { i: 1, name: 'Clip lamp 5W', supplier_sku: 'BW-CL05', category: 'Lighting', hs_code: null, unit_weight_kg: 0.3, carton_qty: 50, carton_weight_kg: 9, carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30,
    unit_price: 22.5, currency: 'CNY', moq: 1000, include: true, source_row: 5, cbm: 0.06, match: { status: 'none' },
    checks: [{ level: 'warn', field: 'hs_code', message: 'No HS code.' }, { level: 'warn', field: 'carton_weight_kg', message: 'Carton 9 kg is lighter than 50 × 0.3 kg = 15 kg.' }],
    ai_issues: [{ row: 1, field: 'hs_code', severity: 'medium', message: 'Clip-on desk lamps are usually classified under 9405.21.', suggestion: '9405.21' }] },
  { i: 2, name: null, supplier_sku: 'BW-X', currency: 'CNY', include: false, cbm: null, match: { status: 'none' }, checks: [{ level: 'error', field: 'name', message: 'Product name is missing.' }] },
];

export const pages = {
  // ---- admin ----
  'admin/dashboard': base(staffUser, '/admin', { title: 'Dashboard', kpi: { clients: 14, openRequests: 5, draftQuotes: 3, openOrders: 11, revenue30: 44850, profit30: 6296, lowMargin: 1 }, byStatus: { confirmed: 2, deposit_paid: 1, in_production: 4, qc: 1, packed: 1, in_transit: 2 }, requests, shipments: [{ ...shipment, orders: { order_no: overview.order_no, organizations: { name: 'Acme Retail LLC' } } }], activity: events.map(e => ({ ...e, entity_type: 'order', entity_id: 'ord1' })), orders: ordersList, months, exportGaps: [{ id: 'sh9', orders: { order_no: 'HB-2609-1102' } }] }),
  'admin/clients/index': base(staffUser, '/admin/clients', { title: 'Clients', clients: [{ ...org, profiles: [{ count: 3 }], orders: [{ count: 7 }], requests: [{ count: 12 }] }, { ...org, id: 'o2', name: 'Nordic Home AB', country: 'Sweden', default_currency: 'EUR', active: false, profiles: [{ count: 1 }], orders: [{ count: 0 }], requests: [{ count: 1 }] }] }),
  'admin/clients/form': base(staffUser, '/admin/clients/new', { title: 'New client', org: {}, error: null }),
  'admin/clients/detail': base(staffUser, '/admin/clients/o1', { title: org.name, org, members: [
    { id: 'u9', email: 'tom@acme.example', full_name: 'Tom Baker', active: true, state: 'accepted', accepted_at: d(-30) },
    { id: 'u11', email: 'mars4wo@gmail.com', full_name: null, active: true, state: 'pending', sent_at: d(-1), expires_at: d(13), days_left: 13 },
    { id: null, email: 'ops@acme.example', full_name: null, active: true, state: 'expired', sent_at: d(-20), expires_at: d(-6), days_left: -6 },
    { id: 'u10', email: 'jane@acme.example', full_name: 'Jane Doe', active: false, state: 'accepted', accepted_at: d(-90) },
  ], requests, orders: ordersList }),
  'admin/clients/staff': base(staffUser, '/admin/clients/staff/list', { title: 'Staff', staff: [{ ...staffUser, active: true, state: 'accepted', accepted_at: d(-400) }, { id: null, email: 'new@highs.example', role: 'staff', state: 'pending', sent_at: d(0), days_left: 14 }] }),
  'admin/suppliers/index': base(staffUser, '/admin/suppliers', { title: 'Suppliers', suppliers: [{ ...sup, products: [{ count: 6 }], orders: [{ count: 4 }] }, { ...sup, id: 's2', name: 'Yiwu Sunhome Houseware', city: 'Yiwu', rating: 3, can_export_official: false, products: [{ count: 2 }], orders: [{ count: 1 }] }] }),
  'admin/suppliers/form': base(staffUser, '/admin/suppliers/new', { title: 'New supplier', s: { country: 'China' }, error: null }),
  'admin/suppliers/detail': base(staffUser, '/admin/suppliers/s1', { title: sup.name, s: sup, products: [prod], orders: ordersList, docs: [{ id: 'd9', kind: 'certificate', title: 'BSCI-2025.pdf', mime_type: 'application/pdf', client_visible: false, created_at: d(-60) }], spend: 18436 }),
  'admin/products/index': base(staffUser, '/admin/products', { title: 'Products', products: [{ ...prod, suppliers: { id: 's1', name: sup.name } }, { ...prod2, suppliers: null }], categories: ['Houseware', 'Lighting'], suppliers: lists.suppliers, thumb: { p1: 'doc1' } }),
  'admin/products/form': base(staffUser, '/admin/products/new', { title: 'New product', p: { cost_currency: 'CNY' }, specText: '', suppliers: lists.suppliers, photos: [{ id: 'doc1', title: 'front.jpg' }, { id: 'doc2', title: 'box.jpg' }], error: null }),
  'admin/products/detail': base(staffUser, '/admin/products/p1', { title: prod.name, p: { ...prod, suppliers: sup }, docs, quotes: [{ ...quote, requests: { id: 'r1', ref: request.ref, organizations: { name: 'Acme Retail LLC' } } }], specText: 'Power: 10 W\nMaterial: Aluminium' }),
  'admin/sourcing/index': base(staffUser, '/admin/sourcing', { title: 'Sourcing', requests, byStatus: { new: 2, reviewing: 3, quoted: 1, accepted: 9 }, statuses: ['new', 'reviewing', 'quoted', 'accepted', 'declined', 'cancelled'], status: 'open' }),
  'admin/sourcing/detail': base(staffUser, '/admin/sourcing/r1', { title: request.ref, request: { ...request, organizations: org, creator: { full_name: 'Tom Baker' } }, quotes: [{ ...quote, products: { id: 'p1', name: prod.name }, suppliers: { id: 's1', name: sup.name } }, { ...quote, id: 'q2', status: 'accepted', margin_pct: 18, ai_check: null, products: null, suppliers: null }], docs: docs.slice(0, 1), events, staff: [staffUser], orders: [], statuses: ['new', 'reviewing', 'quoted', 'accepted', 'declined', 'cancelled'] }),
  'admin/orders/index': base(staffUser, '/admin/orders', { title: 'Orders', orders: ordersList, byStatus: { in_production: 4, qc: 1, in_transit: 2, delivered: 12 }, statuses: ORDER_STATUSES, status: 'open', clients: [org] }),
  'admin/orders/new': base(staffUser, '/admin/orders/new', { title: 'New order', clients: [org], suppliers: lists.suppliers, currencies: CURRENCIES, org: '' }),
  'admin/orders/detail': base(staffUser, '/admin/orders/ord1', { title: overview.order_no, order: overview, items, shipments: [{ ...shipment, forwarders: { name: 'Oceanlink Logistics' }, freight_costs: costs }], packing, events, docs, suppliers: lists.suppliers, products: lists.products, statuses: ORDER_STATUSES, land: landed(overview, items) }),
  'admin/logistics/index': base(staffUser, '/admin/logistics', { title: 'Logistics', shipments: [{ ...shipment, forwarders: { name: 'Oceanlink Logistics' }, orders: { id: 'ord1', order_no: overview.order_no, currency: 'USD', organizations: { name: 'Acme Retail LLC' } }, freight: 1004.2, unpaid: 909.9, exportMissing: false }, { ...shipment, id: 'sh9', status: 'departed', mode: 'air', eta: day(-2), exportMissing: true, export_declaration_no: null, forwarders: null, orders: { id: 'ord3', order_no: 'HB-2609-1102', currency: 'USD', organizations: { name: 'Nordic Home AB' } }, freight: 2100, unpaid: 0 }], forwarders, kpi: { active: 6, late: 1, unpaid: 909.9, exportMissing: 1 }, showAll: false, today: day(0) }),
  'admin/logistics/shipment_form': base(staffUser, '/admin/logistics/shipments/new', { title: 'New shipment', s: { order_id: 'ord1', mode: 'sea_lcl', incoterm: 'FOB', status: 'planned', export_official: true, cartons: 4 }, error: null, orders: [{ id: 'ord1', order_no: overview.order_no, organizations: { name: 'Acme Retail LLC' } }], forwarders, modes: ['sea_fcl', 'sea_lcl', 'air', 'rail', 'express'], statuses: ['planned', 'booked', 'picked_up', 'departed', 'arrived', 'customs', 'delivered'], incoterms: INCOTERMS }),
  'admin/logistics/shipment': base(staffUser, '/admin/logistics/shipments/sh1', { title: 'Shipment', s: { ...shipment, forwarders: forwarders[0], orders: { ...overview, organizations: { name: 'Acme Retail LLC' } } }, costs, docs: [{ id: 'd5', kind: 'bill_of_lading', title: 'BL-OOLU2610458.pdf', mime_type: 'application/pdf', client_visible: true, created_at: d(-1) }], totalCost: 1004.2, byType: { main_freight: 765, origin_handling: 144.9, export_declaration: 48.3 }, land: landed(overview, items), order: overview, freightTypes: ['origin_handling', 'export_declaration', 'main_freight', 'insurance', 'other'], statuses: ['planned', 'booked', 'picked_up', 'departed', 'arrived', 'customs', 'delivered'], currencies: CURRENCIES, defaultFx: c => (c === 'CNY' ? 0.138 : 1), fxTable: settings.fx }),
  'admin/pricing/index': base(staffUser, '/admin/pricing', { title: 'Pricing', quotes: [{ ...quote, requests: { id: 'r1', ref: request.ref, title: request.title, organizations: { name: 'Acme Retail LLC' } }, products: { name: prod.name }, suppliers: { name: sup.name } }], settings, ...lists, currencies: CURRENCIES }),
  'admin/pricing/quote_form': base(staffUser, '/admin/pricing/quotes/new', { title: 'New quote', q: { ...quote, id: undefined, ai_check: null }, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error: null }),
  'admin/pricing/quote': base(staffUser, '/admin/pricing/quotes/q1', { title: 'Quote', q: { ...quote, requests: { ...request, organizations: { name: 'Acme Retail LLC' } }, products: prod, suppliers: sup }, calc, settings, order: null, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES }),
  'admin/pricing/settings': base(staffUser, '/admin/pricing/settings', { title: 'Pricing settings', settings }),
  'admin/products/import': base(staffUser, '/admin/products/import', { title: 'Import products', ai: true, imports: [
    { id: 'imp1', file_name: 'Brightway_pricelist_Oct.xlsx', method: 'template', status: 'review', supplier: { name: 'Shenzhen Brightway Electronic Co., Ltd.' }, rows: impRows, created_at: d(0), profiles: { full_name: 'Anna Lee' } },
    { id: 'imp2', file_name: 'Sunhome catalogue 2026.pdf', method: 'ai', status: 'committed', supplier: { name: 'Yiwu Sunhome Houseware' }, rows: impRows, result: { created: 12, updated: 3 }, created_at: d(-3), profiles: { full_name: 'Anna Lee' } },
  ] }),
  'admin/products/import_review': base(staffUser, '/admin/products/import/imp1', { title: 'Import', ai: true, currencies: ['USD', 'EUR', 'GBP', 'CNY'],
    imp: { id: 'imp1', file_name: 'Brightway_pricelist_Oct.xlsx', method: 'template', status: 'review', created_at: d(0), ai_notes: 'AI check: 2 rows need attention — missing HS code and a carton weight lighter than its contents.',
      supplier: { name: 'Shenzhen Brigthway Electronic Co., Ltd.', address: "Bao'an District, Shenzhen", contact_name: 'Li Wei', email: 'sales@brightway-led.com', phone: '+86 138 0013 8000', wechat: 'liwei_bw' },
      supplier_match: { status: 'suspect', candidates: [{ id: 's1', name: sup.name, city: 'Shenzhen', score: 0.9, strong: false, reasons: ['similar name (90% alike)', 'same contact person'] }] } },
    rows: impRows, suppliers: lists.suppliers, decision: '', candidates: [{ id: 's1', name: sup.name, city: 'Shenzhen', score: 0.9, strong: false, reasons: ['similar name (90% alike)', 'same contact person'] }] }),
  'admin/email_check': base(staffUser, '/admin/email-check', { title: 'Email check', appUrl: 'https://highs-crm-production.up.railway.app', twoFa: true,
    diag: { key: 'set (re_…a1b2)', keyOk: true, from: 'Lumi Trade <no-reply@lumitrade.example>', fromOk: true, fromDomain: 'lumitrade.example', replyTo: null, domains: [{ name: 'lumitrade.example', status: 'pending', region: 'us-east-1' }], domainsError: null },
    tables: { 'auth_codes table (migration 0007)': 'ok', 'profile columns (migrations 0004/0006)': 'column profiles.job_title does not exist', 'invitation columns (migrations 0004/0006)': 'ok' },
    recent: [{ email: 'mars4wo@gmail.com', purpose: 'reset', created_at: d(0), used_at: null, attempts: 0 }],
    test: { ok: false, to: 'anna@lumitrade.example', error: 'Email could not be sent: the domain in EMAIL_FROM is not verified in Resend (The lumitrade.example domain is not verified).' } }),
  // ---- client portal ----
  'portal/dashboard': base(clientUser, '/portal', { title: 'Overview', requests, orders: [{ ...overview, shipments: [{ eta: day(48), status: 'booked' }] }, { ...overview, id: 'o2', order_no: 'HB-2609-1102', status: 'in_transit', subtotal: 22400 }], openCount: 1, kpi: { openRequests: 1, quotesWaiting: 1, inProgress: 1, onTheWay: 1 } }),
  'portal/company': base(clientUser, '/portal/company', { title: 'Company details', first: true, saved: false,
    org: { ...org, details_completed_at: null }, form: { ...org, city: 'San Francisco', email: 'bad' }, errors: { phone: 'Company phone is required.', email: 'Enter a valid email address.' } }),
  'portal/requests': base(clientUser, '/portal/requests', { title: 'My requests', requests, counts: { all: 2, open: 2, quoted: 0, accepted: 0, closed: 0 }, tab: 'all', q: '' }),
  'portal/request_form': base(clientUser, '/portal/requests/new', { title: 'New request', error: null, form: {} }),
  'portal/request_detail': base(clientUser, '/portal/requests/r1', { title: request.ref, request, quotes: [{ ...quote, status: 'sent' }], docs: docs.slice(0, 1), events }),
  'portal/orders': base(clientUser, '/portal/orders', { title: 'My orders', orders: [{ ...overview, shipments: [shipment] }, { ...overview, id: 'o2', order_no: 'HB-2609-1102', status: 'in_transit', subtotal: 22400, shipments: [] }], counts: { all: 2, production: 1, shipping: 1, delivered: 0 }, tab: 'all', q: '' }),
  'portal/order_detail': base(clientUser, '/portal/orders/ord1', { title: overview.order_no, order: { ...overview, order_items: items }, shipments: [shipment], documents: docs, events, packing }),
  // ---- auth ----
  'auth/login': base(null, '/login', { title: 'Sign in', error: null, next: '' }),
  'auth/accept': base(null, '/auth/accept', { title: 'Choose a new password', error: null }),
  'auth/invite': base(null, '/invite/x', { title: 'Accept invitation', state: 'valid', step: 'profile', msg: null, inv: { email: 'mars4wo@gmail.com', token: 'tok', expires_at: d(13), organizations: { name: 'Acme Retail LLC' } }, error: null, form: {} }),
  'auth/verify': base(null, '/login/verify', { title: 'Enter your code', email: 'ma•••@gmail.com', error: null, msg: null }),
  'auth/reset': base(null, '/reset/x/y', { title: 'Choose a new password', error: null, valid: true }),
  'auth/forgot': base(null, '/forgot', { title: 'Check your inbox', sent: true, email: 'mars4wo@gmail.com', error: null, minutes: 30 }),
  'auth/account': base({ ...clientUser, job_title: 'Buyer', phone: '+1 555 0100' }, '/account', { title: 'My account', saved: false }),
  error: base(staffUser, '/x', { title: 'Not found', message: 'Page not found.' }),
};
