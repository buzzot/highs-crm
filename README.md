# Lumi Trade — Order Tracking & CRM

Client portal + admin workspace for a China-sourcing trading company.
Node.js (Express, server-rendered EJS) on **Supabase** (Postgres, Auth, Storage). AI quote checks via the Claude API.

## What's inside

**Client portal** (`/portal`): clients are invited by email; one client company can have many users.
- Submit sourcing requests with photos/files
- See quotes and accept / reject them
- Track orders: progress steps, shipments (B/L, ETA, export declaration), packing list, photos & documents, timeline
- Clients never see costs, margins, suppliers or internal notes. This is enforced in the database (row policies + column grants), not only in the UI.

**Admin** (`/admin`), for staff and admins:

| Page | What it does |
|---|---|
| Dashboard | KPIs, open orders by status, 6-month revenue/profit, alerts (orders under 20% margin, shipments with no export declaration), latest requests, shipments, activity |
| Orders | All orders with status / client filters, cost, freight, margin, profit. Order page: status updates (optional client-visible note), items, landed price per unit, shipments, packing list (bulk-add cartons), product & packing photos, documents, activity |
| Clients | Companies, their users, pending invites, "Send invite", requests and orders per client. Staff list and staff invites (admins only) |
| Suppliers | Contacts (WeChat, phone, email), payment terms, lead time, rating, whether they can export officially, products, order history, purchases, licences and certificates |
| Products | **Import** from the supplier Excel template (`public/templates/lumi-trade-product-import-template.xlsx`, rebuilt by `scripts/make_template.py`), supplier price lists, PDFs or photos (AI), with duplicate-supplier detection and a review/confirm step. Add photos by drag & drop, file picker or paste. Catalogue with photos, supplier cost, MOQ, HS code, carton size and weight, specs, quote history |
| Sourcing | Request pipeline (new → reviewing → quoted → accepted), owner, internal notes, AI sourcing brief, quotes, accepted quote → order |
| Logistics | Shipments (third-party forwarders), status, ETD/ETA, B/L, container, **export declaration no.**, freight cost ledger by type (multi-currency, paid/unpaid), landed cost & price per unit, shipping documents, forwarder directory |
| Pricing | Live calculator + quotes register. Margin on **product cost only** (min 20%, configurable), logistics passed through to give the landed price. Target-price → margin solver, freight helper (LCL/FCL/air from carton data), **AI verification**, send-to-client gate (minimum margin enforced, admin override with a reason) |

### Business rules (from the *Sourcing* brief)
- Margin = (sell − product cost) / product cost. Logistics is excluded from the margin and added on top for the landed price.
- Minimum margin is 20%. Quotes below it can't be sent unless an admin overrides it, and the override is logged.
- Exports should be official: every shipment records the government export declaration number, and the dashboard and Logistics page flag shipments that left without one.
- Freight is recorded per shipment, per cost type, in any currency with an FX rate to the order currency. The order's freight total and landed price update automatically.

### AI
- **Quote verification** (`src/lib/ai.js → verifyQuote`): checks margin, arithmetic, FX plausibility, MOQ, freight versus weight/volume, HS code, lead time versus the needed-by date, and competitiveness versus the client's target. Hard rules always override the model.
- **Sourcing brief** (`summarizeRequest`): turns a client's free text into a spec checklist, a likely HS chapter, and questions to ask the client.
- Without `ANTHROPIC_API_KEY` the app still runs, and quote checks are rule-based only.

## Setup

1. **Supabase project**: create one at supabase.com.
2. **Database**: in the SQL editor, run in order:
   1. `supabase/migrations/0001_schema.sql`
   2. `supabase/migrations/0002_hardening.sql`
   3. `supabase/migrations/0003_grants.sql`
   4. `supabase/migrations/0004_invite_tracking.sql`
   5. `supabase/migrations/0005_product_import.sql`
   6. `supabase/migrations/0006_profile_and_email_codes.sql`
   7. `supabase/migrations/0007_app_email_codes.sql`
   8. `0008` … `0019` in number order (request items, request edits, supplier portal, supplier CRM, AI usage, packing lists & freight quotes, RFQ booking, partial shipments, product SKU, per-company AI switch, purchase orders & proforma invoices)
   9. optional demo data: `supabase/seed.sql`
3. **Auth settings** (Authentication):
   - Providers → Email: turn **off** "Allow new users to sign up" (invite-only).
   - URL Configuration: Site URL = your `APP_URL`; add `APP_URL/auth/accept` to Redirect URLs.
   - Email Templates → "Invite user" / "Reset password": brand them as you like. The link must keep `{{ .ConfirmationURL }}`.
   - For production, set up custom SMTP (Project Settings → Auth → SMTP). The built-in sender is rate-limited.
   - **Email** is sent by the app itself through **Resend**, from your own domain (Supabase sends no emails):
     1. resend.com → Domains → add your domain (e.g. `lumitrade.com`), add the DNS records it shows, wait for "Verified".
     2. resend.com → API Keys → create a key with "Sending access".
     3. Railway → Variables: `RESEND_API_KEY=re_...`, `EMAIL_FROM=Lumi Trade <no-reply@yourdomain.com>`,
        optional `EMAIL_REPLY_TO=sales@yourdomain.com`.
   - Invitation codes, sign-in codes (15 min) and password-reset links (30 min) are created and checked by the app
     (table `auth_codes`, migration 0007). Emergency switch: `LOGIN_2FA=off` signs in with password only.
4. **First admin**: edit the email in `supabase/bootstrap_admin.sql` and run it, then invite that email from Authentication → Users → Invite user. Open the email link and set a password.
5. **App**:
   ```bash
   cp .env.example .env     # fill in Supabase keys, APP_URL, optional ANTHROPIC_API_KEY
   npm install
   npm start                # http://localhost:3000
   npm test                 # pricing, util and render tests for every page
   ```
6. **Deploy**: any Node 22+ host (Render, Railway, Fly.io, a VPS). Set the same env vars and `NODE_ENV=production` (secure cookies).

### Day-to-day flow
1. Admin → Clients → New client → **Send invite** to each person at that company.
2. The client signs in → **New request** (with photos).
3. Sourcing → open the request → *Generate brief* → *+ new quote* (Pricing calculator) → *Save & AI verify* → *Send to client*.
4. The client accepts in the portal, then Sourcing → **Create order**.
5. Order page: update status as production moves (tick "show client"), upload product/QC/packing photos, add the packing list.
6. Logistics → **+ Shipment**: forwarder, B/L, export declaration no., ETD/ETA, freight costs as invoices arrive. The client sees shipment progress and documents marked visible.

### Packing lists & freight quotes
- Order page → **Packing list**: drop the supplier's packing list (Excel, CSV, PDF or a screenshot). Spreadsheets with normal
  headers (EN/CN) are read directly; anything else is read by AI. You check and correct the lines, then save.
- **Packing list & freight quotes** page: standard printable packing list, Excel download, WeChat text, and
  *Send packing list* — one email per forwarder with the Excel attached. Each request gets a number (`FQ-YYMM-####`).
- Logistics → **Freight quote requests**: every request, who it went to and when, answers with time, best quote.
  Click the number to see the timeline and the AI-read offers (price, transit days, validity, breakdown, questions).
- WeChat or phone replies: paste them on the request page — AI reads them the same way.

#### Inbound email (automatic capture of forwarders' replies) — optional, via Mailgun
Without this, replies arrive in the sender's own inbox (Reply-To) and you paste them in.
Sending stays on Resend; Mailgun only receives, on its own subdomain, so the two never clash.
1. mailgun.com → Sending → Domains → **Add domain** `in.lumitrade.cc` (US region). Add only its **MX** records
   (`mxa.mailgun.org`, `mxb.mailgun.org`, priority 10) and the TXT/SPF records at your DNS host; wait for "Verified".
2. Receiving → **Create route**: expression type *Match recipient*, `quotes.*@in.lumitrade.cc`
   (regex: `match_recipient("^quotes.*@in\.lumitrade\.cc$")`), action **Forward** to
   `https://lumitrade.cc/hooks/inbound-email`, tick **Stop**, priority 0.
3. Settings → **Webhook signing key** → copy it.
4. Railway → Variables:
   - `QUOTE_REPLY_ADDRESS=quotes@in.lumitrade.cc` — each forwarder replies to `quotes+<token>@in.lumitrade.cc`
   - `MAILGUN_WEBHOOK_SIGNING_KEY=` the key from step 3 (proves the post comes from Mailgun)
5. Test: send a quote request to your own address, reply to it, and the reply appears on the request page within a minute.
   Railway logs show `[inbound] …` lines.

Other providers (Postmark, SendGrid, Cloudflare Email Worker) work too: set `INBOUND_EMAIL_SECRET` and post to
`https://lumitrade.cc/hooks/inbound-email?key=<INBOUND_EMAIL_SECRET>`.

## Project layout
```
src/
  server.js                 Express app
  middleware/auth.js        cookie session (Supabase JWT), role guards
  lib/                      supabase clients, pricing math, AI, storage, invites, helpers
  routes/auth.js            login, invite acceptance, password reset, account
  routes/portal.js          client portal (queries run AS the user → database row/column rules apply)
  routes/admin/*.js         admin modules (service-role client)
  views/                    EJS templates (portal/, admin/, partials/)
public/                     CSS + small vanilla JS (live calculator reuses src/lib/pricing.js)
supabase/                   schema, hardening migration, seed, admin bootstrap
test/                       node:test suites (no DB needed)
```

## Security model
- **Staff pages** use the Supabase service-role key on the server, guarded by `requireStaff` / `requireAdmin`.
- **Portal pages** query with the client's own token. Row policies limit them to their company, and column grants hide costs, margins, suppliers and internal notes.
- Files are in a private bucket. Downloads go through short-lived signed URLs after a permission check, and each file has a "visible to client" switch.
- Roles and company membership come only from staff-created invitations.


## Purchase orders & proforma invoices
After a client accepts a quote they press **Send PO** on the request: a PO is generated from the quote (client company, contact, email/phone, lines), can be printed / saved as PDF and is sent to the admins by email (PDF attached) and appears under Sourcing (red ball on the menu). An admin checks and edits every detail, adds comments, then **Approve** creates the order (or sends the PO back with a note). On the order, **Generate proforma invoice** builds a PI from the order/PO; edit it, then **Send to client** emails the PDF and stores it in the order's documents. Fill in *Company details on PO / proforma invoice* (name, address, bank details, payment terms) under Pricing → Settings. PDFs are written by a built-in generator (`src/lib/pdf-write.js`, Latin text only).

## Payments (migration 0020)

After the proforma invoice is sent, the order carries the amount due and a payment schedule (instalments with % and due dates, edited on the PI). Orders start as status `new`. In the client portal the order page shows what to pay and when; the client enters the amount, date and reference and uploads the proof of payment. The order's payment status becomes `partially paid` or `paid` straight away (counting reported payments), and admins get an email and a red ball on the Orders menu. On the admin order page each reported payment is confirmed (client emailed; a `new` order moves to `deposit paid`) or rejected with a note (not counted again). Admins can also record a payment received directly.

## Quoting several products at once

Tick products on the Products list → **Create quote**. One request (new internal `IRQ-…` for a chosen client, or an existing request) gets one quote line per product, suppliers can differ. Lines are drafts; **Send all to client** on the request page sends them together with a single email (margin minimum and AI check rules apply to every line). Freight is entered per line.

The multi-product quote page shows a live **cargo estimate** (cartons, gross weight, volume, air chargeable weight, share of a 40HQ) from each product's packing data and the quantities entered (`src/lib/cargo.js`).
A **Total freight** box (sea or air, optional rate per m³ / per chargeable kg) spreads one freight amount over the lines — by volume for sea, by chargeable weight for air, by goods value if packing data is missing (`allocateFreight`). A line edited by hand keeps its amount and the others share the rest; the saved quote still stores freight per line.
**One quotation for the whole request.** After creating several lines, the staff land on a *Quotation* page (`/admin/pricing/requests/:id/quote`): all lines, goods total, freight & logistics, grand total, internal margin, a quotation PDF and one *Send quotation* button (one email with the PDF attached). The client sees the sent lines as one card with the grand total and accepts or rejects them all in one click, then sends **one PO** for all lines (goods at unit prices plus one "Freight & logistics (estimate)" line, so the PO total equals the quotation total). Quotes stay one row per product in the database (`src/lib/combined-quote.js` does the grouping); a PO made this way has no `quote_id`. Lines in different selling currencies are not combined.

## Purchasing (purchase orders to suppliers)

Run `supabase/migrations/0021_purchasing.sql`. The **Purchasing** menu (staff) lists every supplier PO (`SPO-YYMM-####`). From an order, **Create supplier POs** shows the order's products with their supplier (from the product card) and factory price; products of the same supplier and currency go into one PO. Each PO is emailed with a PDF and, if ticked, an Excel template for an **estimated packing list**; the email asks the supplier to reply with confirmation + ready date, the proforma invoice (PI) and the packing list.

Replies come back through the same inbound-email webhook as freight quotes (`/hooks/inbound-email`, reply address `QUOTE_REPLY_ADDRESS` with `+token`, or the `SPO-…` reference in the subject). The reply is read (AI when `ANTHROPIC_API_KEY` is set, simple keyword rules otherwise) into: confirmed / declined / question, ready date, PI number and amount, packing estimate. Attached files are stored on the order (PI → *proforma invoice*, packing list → *packing list*, internal only) and the PO shows date, result and documents. WeChat answers or phone calls are logged by hand on the PO page. Statuses: draft → sent → replied (needs a look) → confirmed / declined; a red ball on the menu counts replies to check.
Combined client POs now keep each line's `product_id`, so the order's products link to their suppliers.
