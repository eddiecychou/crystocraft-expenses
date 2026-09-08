# Changelog

Version numbers here are the human-readable release label shown in the app footer
(Settings page) — sourced from `package.json`'s `version` field via `__APP_RELEASE__`
in `vite.config.js`. The build hash next to it (`__APP_VERSION__`) is the git short
SHA of the deployed commit and changes on every deploy; the release number below only
changes when it's bumped deliberately in `package.json`.

## Unreleased (still V1.0)

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
