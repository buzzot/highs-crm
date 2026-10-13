# Highs Business — Order Tracking & CRM

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
| Products | **Import** from the supplier Excel template (`public/templates/highs-product-import-template.xlsx`, rebuilt by `scripts/make_template.py`), supplier price lists, PDFs or photos (AI), with duplicate-supplier detection and a review/confirm step. Catalogue with photos, supplier cost, MOQ, HS code, carton size and weight, specs, quote history |
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
   6. optional demo data: `supabase/seed.sql`
3. **Auth settings** (Authentication):
   - Providers → Email: turn **off** "Allow new users to sign up" (invite-only).
   - URL Configuration: Site URL = your `APP_URL`; add `APP_URL/auth/accept` to Redirect URLs.
   - Email Templates → "Invite user" / "Reset password": brand them as you like. The link must keep `{{ .ConfirmationURL }}`.
   - For production, set up custom SMTP (Project Settings → Auth → SMTP). The built-in sender is rate-limited.
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
