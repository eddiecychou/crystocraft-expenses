# Changelog

Version numbers here are the human-readable release label shown in the app footer
(Settings page) — sourced from `package.json`'s `version` field via `__APP_RELEASE__`
in `vite.config.js`. The build hash next to it (`__APP_VERSION__`) is the git short
SHA of the deployed commit and changes on every deploy; the release number below only
changes when it's bumped deliberately in `package.json`.

## Unreleased (still V1.0)

**One-time Legacy JES History import for Invoices & POs.**
Operation Center's frozen "JES ERP archive" (historical Purchase
Orders and Sales Invoices predating the costing-tool app, which don't
change) was deliberately left out of MVP-5's recurring Sync — it
doesn't belong in a "what's new since last time" loop. A separate
"Import Legacy JES History" button on Invoices & POs pulls it in
instead, as its own one-time (but safe to re-run) action, behind a
confirm dialog. Reuses costing-tool's existing `/api/erp` endpoint
(entities `purchase`/`sales_invoice`) rather than building something
new there — which needed one small addition, an `offset` paging
param, since that endpoint previously had no way past its first
`limit`-sized page. Requires the service account to additionally hold
the `erp` module on costing-tool (broader than `supply`/`uc` — your
call whether to grant it standing or just around running the import).
Imported rows are tagged `sourceType: 'jes_archive'` ("JES Archive"),
with their own doc-id prefix so they can never collide with a
live-synced app record even if a number happened to match.


**Security: Operation Center Sync now gated by a server-side connector registry.**
The Crystocraft-only gate for MVP-5's Operation Center Sync was a
client-writable Firestore boolean (`operationCenterSyncEnabled`) — a UI
convenience, not a real security boundary, since another company's
project (this app is shared across companies) could flip it on and pull
Crystocraft's own PO/Invoice data, as costing-tool's endpoints have no
per-company concept at all. Hardened to a server-side connector
registry — one Netlify env var (`OPERATION_CENTER_CONNECTORS`, a JSON
array keyed by `projectId`, replacing the four separate
`OPERATION_CENTER_*` vars) that `sync-operation-center.js` checks
**before** anything else; the Firestore toggle is now only a secondary
check, never sufficient alone. Shaped to generalize — a future
connector for another company's own system is a registry entry, not a
rewrite of the gating logic.


**Account Codes CSV import, per-project Income Categories, small fixes.**
`AccountCodes.jsx` can now import a chart of accounts in bulk from a CSV
(Code/Name required, Type optional) instead of adding codes one at a
time — a code already present is skipped, never duplicated. Income
Categories are now per-project and editable in Settings (same chip-list
pattern as Expense Categories, which Settings' "Categories" section is
now labeled to make clear), via a new `projectIncomeCategories()`
fallback in `constants.js`, same as the existing Expense/Payment-Method
pattern. Also fixed: Invoices & POs' Delete button silently did nothing
from the saved-records table (its confirm dialog only ever rendered
inside the file-review section); and a long Notes value (e.g. an
Operation Center sync's remarks) was stretching that table off-screen —
Notes now truncates with an ellipsis, full text on hover.


**Finance / Bookkeeping Center repositioning — MVP-5 (Operation Center API, Crystocraft-only).**
Replaces the manual CSV import of Invoices & POs with a live pull from
Operation Center (`costing-tool`), scoped after actually checking what
exists there: no Expense/Income data model at all (so that spec
direction stays deferred), and both entities are themselves a merge with
a frozen legacy JES ERP archive that predates the app — the live sync
covers only the app-authored source, not that archive, to avoid
re-implementing its dedup logic in a second codebase. Gated per-project
by a new Crystocraft-only toggle in Settings (`operationCenterSyncEnabled`,
off by default everywhere). A new "Sync from Operation Center" button on
Invoices.jsx calls a new edge function (`sync-operation-center.js`) that
signs in as a dedicated costing-tool service account and pulls Purchase
Orders (`finance-po-sync.js`, new in costing-tool) and Sales Invoices
(`uc.js`'s existing `list_invoices` op, gained an optional `since`
filter) — upserted into the same `purchaseOrders`/`salesInvoices` shape
the CSV importer already produces, keyed by a deterministic doc id
derived from Operation Center's own PU#/SI# so a re-sync never creates a
duplicate. No data deleted on failure; sync status shown inline. See
TECHNICAL.md's "Operation Center Sync" section.


**Finance / Bookkeeping Center repositioning — MVP-4 (Bank Transactions + unified reconciliation status).**
A new `BankTransactions.jsx` page (`/bank-transactions`) — the single
browsing view of every imported statement row, independent of any specific
matching workflow (per the spec, Cindy's most important single entry
point). Read-only: every column the spec lists (dates, direction, amount,
running balance, description, counterparty, classification, Account Code,
reconciliation status, matched record, supporting document, source file),
filterable by date range/preset, account, direction, status, source. No
new actions — a row links out to Reconciliation ("Open in Reconciliation
→") for anything needing a decision, rather than re-implementing
Confirm/Ignore/Link a second time. New `resolveMatchedRecord()` helper
(`financeRecords.js`) resolves a transaction's matched expense/invoice/
PO/income record; new `reconciliationStatusLabel()` helper
(`paymentMatching.js`) maps onto 6 of the spec's 9-word status vocabulary
as a pure display mapping — no stored field changed (the remaining 3,
Imported/Partially Matched/Reconciled, wait for MVP-6's month-end
closing). Reconciliation also gains a third manual classification button,
"Mark as Loan/Capital", for the spec's Loan/Capital/Director Current
Account bucket — same treatment as the existing Refund/Transfer buttons.


**Finance / Bookkeeping Center repositioning — MVP-3 (Account Codes).**
A real per-project chart of accounts — new `AccountCodes.jsx` page
(`/account-codes`), `accountCodes` collection (Active/Deactivate only, no
hard delete, so a record that already used a since-deactivated code keeps
displaying correctly), added ALONGSIDE the existing Category field on
Expenses/Income (optional, never a replacement). New reusable
`AccountCodePicker` (type-to-search + recently-used, restricted to the
record's own side — expense → expense/asset/liability/other, income →
income/other) wired into Upload.jsx, Income.jsx, and Expenses.jsx's edit
views. A vendor/payer's confirmed code can be remembered via "Remember
this code for…" (`accountCodeRules`) — a suggestion only, shown editable
next time, never auto-applied; unlike the existing Merchant Rules for
personal/company classification, there's no Auto-Approve toggle at all for
account codes, per the spec's explicit call-out that account coding needs
human confirmation for salary/tax/related-party/capital items. A new
project seeds a starter chart (`DEFAULT_ACCOUNT_CODES`); an existing
project (this one) loads it via a deliberate button, not a silent
migration.


**Finance / Bookkeeping Center repositioning — MVP-2 (Income + Income Upload).**
Income is now a same-level `FinanceRecord` to Expense, never a negative
expense category — new `Income.jsx` page + `income` collection, covering
rent income, bank interest, refunds, and other income the Operation Center
never generates a Sales Invoice for (a customer sale WITH an OC invoice
stays in `salesInvoices`). PDF/image upload only, reusing the OCR+Gemini
pipeline (`process-invoice.js`, now `docKind: 'invoice'|'po'|'income'`) —
every field reviewed before saving, same as Invoices & POs. In
Reconciliation, a credit transaction can be manually linked to an income
record ("Link to Income") — deliberately not auto-suggested, since
`salesInvoices` already auto-matches the credit pool and a second automatic
scorer would recreate the two-scorer race documented for PO-linking.
`paymentTransactions` gains `matchedIncomeId`; `unmatchTxn` reverts it
alongside expense/invoice/PO. New nav entry "Income" next to Expenses.


**Finance / Bookkeeping Center repositioning — MVP-1 (rename + data foundation).**
Per the spec (`Claude 执行规格：将 Expense Center 修订为 Finance／Bookkeeping Center.md`),
began repositioning the app from a narrow Expense Center into a Finance /
Bookkeeping Center where Income and Expense are same-level objects. MVP-1
only: display name → "Finance / Bookkeeping Workspace" (sidebar, browser
title, Settings), nav labels Dashboard→Overview and Records→Expenses, and a
`recordType: 'expense'` field now stamped on every expense write (with a
read-time fallback for existing docs — no migration, no data change). New
`src/lib/financeRecords.js` defines the shared `FinanceRecord` shape the
income object (MVP-2) will plug into. No new pages, no income features, no
route changes yet.


Added the full Personal-to-Company Expense workflow (`Expense App:
Personal-to-Company Expense MVP Specification.md`), all three phases:

- **Company Review** page (`/company-review`) — mark a Payment Sources account
  as `personal`, and its imported transactions get classified (Personal /
  Company Candidate / Shared / Needs Accountant Review / etc.), grouped by
  merchant for bulk review with count+total confirmation before any change.
- **Merchant suggestion rules** — "Apply + Suggest Rule" on a bulk confirmation
  saves a per-merchant rule; rules only suggest (never auto-classify) until
  Auto-Approve is explicitly turned on for that merchant.
- **Company Package export** — a ZIP (expense register, summary/review/
  missing-receipt CSVs, original source statements, receipts, manifest) for a
  chosen period and set of classifications, excluding Personal/Rejected by
  default.

New Firestore collection: `merchantRules` (needs its own security rule
published in the Firebase Console — see LESSONS_LEARNED.md).

## V1.0 — 2026-09-05

Renamed from "Expense Organiser" to **Expense Operations Center**, reflecting the
app's growth from a single-purpose receipt tracker into a broader bookkeeping
platform covering receipt capture, bank/credit-card statement import, and
transaction reconciliation.

This release is the first versioned snapshot and documents everything built to
date, retroactively covering all prior undated work. See [TECHNICAL.md](TECHNICAL.md)
for full architecture, [FUNCTION_INDEX.md](FUNCTION_INDEX.md) for a function-level
map of the codebase, and [LESSONS_LEARNED.md](LESSONS_LEARNED.md) for the
non-obvious bugs and decisions behind it.

**Core modules at this release:**

- **Capture** — mobile dispatcher page routing to Upload or Payment Sources.
- **Upload** — receipt photo/PDF capture, client-side image preprocessing, AI
  field extraction (Gemini), manual entry, save-to-ledger.
- **Expenses** — full records table/cards, inline edit, receipt lightbox, Excel
  export, receipt ZIP export.
- **Payment Sources** — bank/credit-card account management, CSV/PDF statement
  import, fingerprint-based duplicate detection, PDF-vs-ledger verification and
  reprocessing, original source-file audit trail.
- **Reconciliation** — rule-based matching of imported bank/card transactions
  against expense records, credit-card settlement linking, duplicate resolution,
  append-only action log.
- **Dashboard** — date-filtered totals, category breakdown, recent expenses, in
  a 12-column responsive grid.
- **Settings** — multi-project management with per-project color identity.
- **Invoices & POs** — import customer invoices (income) and supplier
  purchase orders via CSV or PDF/image, AI field extraction (Gemini,
  shared pipeline with Upload), manual review before save, per-project
  list with edit/delete (Phase 1). Reconciled against bank transactions in
  Reconciliation — credit transactions auto-suggested against invoices,
  debit transactions manually linkable to a PO, mutually exclusive with
  expense-matching (Phase 2).

**Design system at this release:**

- Full typography token scale (`--type-*`) applied to page titles, section
  headings, card titles, labels, captions, and amounts across every page.
- Four opt-in container widths (`page-narrow`/`page-reading`/`page-standard`/
  `page-wide`) applied to every routed page per its content shape.
- 12-column `.dashboard-grid` system, applied to Dashboard's secondary panels.
- `lucide-react` icons throughout, replacing all emoji.
- Mobile card-list fallbacks for the two data tables (transaction detail,
  PDF review) that cannot fit six-plus columns at phone width.
