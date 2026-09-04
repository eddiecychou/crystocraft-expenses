# Payment Reconciliation, HKD/RMB Settlement, and Filing Evidence Automation

This document defines a product and technical brief for extending Expense Organiser with multi-source payment reconciliation, HKD and RMB settlement confirmation, and automatic filing support for accountant and auditor submission. The existing app is a React 18 single-page application using Firebase Authentication, Cloud Firestore, Firebase Storage, Netlify Edge Functions, and Netlify Functions, with AI-driven receipt extraction, project-based expense organization, Excel export, and receipt ZIP export.[file:1]

## Objective

The new capability should solve four linked problems:

- Match payment records from bank accounts, credit cards, and wallets to existing expenses.
- Confirm the final settled amount for each expense in the actual payment currency.
- Support HKD base-currency accounting where required while also handling RMB-paid expenses from China accounts and wallets.
- Automatically generate filing-ready proof bundles that include both the receipt and the relevant payment evidence for accountant and auditor review.

This direction fits the current architecture because the app already stores expense records in Firestore, stores receipt files in Firebase Storage, and supports export workflows and in-app confirmation dialogs for sensitive actions.[file:1]

## Why the feature matters

The current app stores one expense amount and currency, which is suitable for receipt capture and export, but it does not fully support a real-world cross-border workflow where some expenses are settled in HKD from Hong Kong bank or credit card accounts while others are paid in RMB from China personal bank accounts, WeChat Pay, or Alipay.[file:1]

In practice, the payment record is often the final confirmation of the actual amount settled. For Hong Kong accounting, many vouchers still need to be finalized in HKD, but for China-paid expenses the true settlement evidence may be a RMB bank transaction or a WeChat or Alipay payment record rather than a conventional bank statement. That means the new module should be framed as payment reconciliation and filing evidence, not only statement matching.

## Product principles

- Keep receipt evidence and payment evidence separate but linked.
- Keep imported payment transactions and expense records separate until a user confirms the relationship.
- Support multiple payment rails, including Hong Kong bank accounts, Hong Kong credit cards, China bank accounts, WeChat Pay, and Alipay.
- Treat the actual payment source as the settlement source of truth.
- Support HKD ledger reporting where required, but do not hard-code every settlement path as HKD-only.
- Never auto-delete or auto-merge records without confirmation.
- Generate filing-ready payment proof automatically after confirmation, but allow manual correction when layout detection is imperfect.
- Preserve auditability with explicit source references, timestamps, and action logs.

## Revised conceptual model

The feature should not be framed as “scan statements and tick matching expenses.” A better model is:

1. Import and parse payment evidence from multiple sources.
2. Create payment transaction records from those sources.
3. Reconcile payment transactions to expenses.
4. Confirm settlement values and ledger values.
5. Generate payment-proof excerpts or attach source evidence.
6. Export an audit pack per expense or per month.

This is safer and more useful than direct ticking because a payment transaction is not the same thing as an expense record, and some expenses will be settled through cards, banks, or wallets with different currencies and different evidence formats.

## Expanded data model

The current system stores `projects` and `expenses`, and each expense contains fields such as date, vendor, amount, currency, category, notes, receipt images, and timestamps.[file:1] The feature should extend the model with new collections and new fields.

### Add `paymentAccounts`

```js
{
  userId: string,
  label: string,
  sourceType: "bank" | "credit_card" | "wechat" | "alipay" | "cash" | "other_wallet",
  jurisdiction: "HK" | "CN" | "Other",
  settlementCurrency: "HKD" | "RMB" | "USD" | "EUR" | "Other",
  ownerType: "business" | "personal",
  accountTail: string | null,
  institutionName: string | null,
  active: boolean,
  createdAt: Timestamp
}
```

### Replace `statementImports` with `paymentImports`

```js
{
  userId: string,
  projectId: string | null,
  paymentAccountId: string,
  sourceType: "csv" | "pdf" | "image" | "screenshot" | "manual",
  platformType: "bank" | "credit_card" | "wechat" | "alipay" | "wallet",
  sourceFileName: string,
  sourceFileUrl: string | null,
  periodStart: string | null,
  periodEnd: string | null,
  importStatus: "processing" | "ready" | "error",
  lineCount: number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  errorMessage: string | null
}
```

### Add `paymentTransactions`

```js
{
  userId: string,
  projectId: string | null,
  importId: string,
  paymentAccountId: string,

  transactionDate: string | null,
  postDate: string | null,
  rawDateText: string,

  merchantRaw: string,
  merchantNormalized: string,

  settlementAmount: number,
  settlementCurrency: string,
  direction: "debit" | "credit",
  transactionType: "purchase" | "fee" | "refund" | "payment" | "transfer" | "cash_withdrawal" | "wallet_payment" | "unknown",

  sourceForeignAmount: number | null,
  sourceForeignCurrency: string | null,
  exchangeRateShown: number | null,
  feeAmount: number | null,

  fingerprintExact: string,
  fingerprintLoose: string,

  status: "unmatched" | "suggested" | "matched" | "duplicate_candidate" | "ignored" | "split",
  matchedExpenseIds: string[],
  duplicateGroupId: string | null,

  confidenceScore: number | null,
  matchReasons: string[],

  sourceRowIndex: number | null,
  sourcePage: number | null,
  sourceSnippet: string | null,
  bbox: { x: number, y: number, w: number, h: number } | null,

  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### Extend `expenses`

```js
{
  userId: string,
  userEmail: string,
  projectId: string,

  date: string,
  vendor: string,
  category: string,
  notes: string,
  images: [{ url: string, path: string, name: string }],

  documentAmount: number,
  documentCurrency: string,

  settlementAmount: number | null,
  settlementCurrency: string | null,
  ledgerAmount: number | null,
  ledgerCurrency: string | null,
  fxRateEffective: number | null,
  fxFeeAmount: number | null,

  settlementStatus: "unsettled" | "estimated" | "confirmed",
  settlementSourceType: "bank" | "credit_card" | "wechat" | "alipay" | "cash" | "manual" | null,
  matchedPaymentTransactionId: string | null,
  matchedPaymentImportId: string | null,
  matchedPaymentAccountId: string | null,

  reimbursement: {
    payerType: "company" | "personal",
    payerAccountId: string | null,
    reimbursementStatus: "not_needed" | "pending" | "reimbursed",
    reimbursementReference: string | null
  },

  reconciliation: {
    status: "unmatched" | "suggested" | "matched" | "duplicate_candidate" | "merged",
    matchedPaymentTransactionIds: string[],
    duplicateGroupId: string | null,
    canonicalExpenseId: string | null,
    sourceType: "receipt_upload" | "payment_import" | "manual"
  },

  paymentEvidence: {
    status: "missing" | "linked" | "generated" | "verified",
    evidenceType: "bank_statement" | "card_statement" | "wechat_record" | "alipay_record" | "bank_transfer" | "manual_upload",
    contextFileUrl: string | null,
    contextFileName: string | null,
    sourcePage: number | null,
    sourceRowRef: string | null,
    evidenceImageUrl: string | null,
    evidencePdfUrl: string | null,
    highlightBox: { x: number, y: number, w: number, h: number } | null,
    generatedAt: Timestamp | null,
    verifiedAt: Timestamp | null
  },

  createdAt: Timestamp
}
```

### Add `reconciliationActions`

```js
{
  userId: string,
  projectId: string | null,
  paymentTransactionId: string,
  expenseId: string | null,
  actionType: "auto_suggested" | "matched" | "unmatched" | "ignored" | "duplicate_marked" | "duplicate_merged" | "expense_created" | "settlement_confirmed" | "proof_generated" | "reimbursement_updated",
  beforeState: object | null,
  afterState: object | null,
  notes: string,
  createdAt: Timestamp,
  actor: {
    uid: string,
    email: string
  }
}
```

## Core workflows

### 1. Receipt-first workflow

1. User uploads receipt or invoice image/PDF.
2. Existing AI extraction fills document fields such as date, vendor, amount, currency, and category.[file:1]
3. Expense is saved with `documentAmount` and `documentCurrency`.
4. Expense waits for payment reconciliation.
5. If payment is personal, reimbursement status can be set to pending.

### 2. Payment import workflow

1. User opens a new Payment Sources or Statements page.
2. User selects payment account and platform type.
3. User imports CSV, PDF, screenshot, or image.
4. System creates `paymentImports` and `paymentTransactions` records.
5. Matching engine runs and assigns statuses such as suggested, matched, unmatched, or duplicate candidate.

### 3. Reconciliation workflow

1. User opens a Reconciliation page.
2. User reviews suggested matches.
3. User confirms the relationship between a payment transaction and an expense.
4. System writes settlement values and ledger values into the expense.
5. If needed, user marks whether reimbursement is required.
6. System creates payment evidence assets automatically where possible.

### 4. Filing workflow

1. Expense reaches `settlementStatus = confirmed` and `paymentEvidence.status = generated` or `linked`.
2. Expense is marked filing-ready.
3. User exports an accountant or auditor pack.
4. Export includes receipt document(s), payment proof, and structured summary.

## Matching engine design

The matching engine should be rules-based rather than LLM-based. AI is useful for extraction, but matching and reconciliation should remain transparent and explainable.

### Merchant normalization

Normalize merchant names before matching:

- lowercase text
- remove terminal IDs, card tails, punctuation, repeated spaces, and noise tokens
- map known aliases to a canonical merchant name
- maintain source-specific alias dictionaries for bank, WeChat, and Alipay merchants

Examples:

- `STARBUCKS HONG KONG 04521` → `starbucks`
- `UBER *TRIP HELP.UBER.COM` → `uber`
- `微信支付-滴滴出行` → `didi`
- `支付宝-美团外卖` → `meituan`

### Matching by payment source

| Source | Strongest matching signals | Notes |
|---|---|---|
| HK credit card | merchant, date, settled HKD amount | best for foreign card spending finalized in HKD |
| HK bank account | merchant/reference, date, HKD amount | useful for direct debit, transfer, fees |
| China bank account | merchant/beneficiary, date, RMB amount | suitable for RMB-local transactions |
| WeChat Pay | wallet text, date, RMB amount | screenshots and exports may need extra normalization |
| Alipay | wallet text, date, RMB amount | often similar to WeChat but with different text patterns |

### Candidate filters

Start with:

- same `userId`
- same or compatible project
- date within a tolerance window, typically 0 to 10 days
- plausible direction alignment, such as debit with expense
- same settlement currency or plausible cross-currency relationship
- payment source compatibility where known

### Scoring

Suggested scoring for same-currency records:

- exact amount match: 45 points
- date within 0–2 days: 25 points
- date within 3–7 days: 15 points
- high merchant similarity: 20 points
- medium merchant similarity: 10 points
- same project: 5 points
- category hint match: 5 points

### Cross-currency matching

Cross-currency matching must not depend on exact amount equality. A USD or RMB receipt and a HKD payment line can still be a valid match if vendor, date, and payment context fit. Suggested logic:

- use merchant similarity as the strongest text signal
- use transaction timing window of 0 to 7 days
- use payment account context when available
- compare against a plausible converted ledger band when needed
- require confirmation when amount evidence is indirect

### Thresholds

- 90–100: high-confidence suggestion
- 70–89: review required
- 50–69: weak suggestion
- below 50: unmatched

High-confidence suggestions can be pre-positioned in the queue, but the system should still avoid silent destructive actions.

## Duplicate handling

Duplicate detection should be separate from expense matching.

### Duplicate types

- duplicate expenses
- duplicate imported payment transactions
- pending-versus-posted duplicates
- wallet screenshot plus bank debit duplicate evidence for the same purchase
- cross-source duplicates between receipt-created expense and payment-created draft expense

### Detection method

Use exact and loose fingerprints:

- exact fingerprint: user, project, normalized vendor, amount, currency, and date
- loose fingerprint: user, absolute amount, normalized merchant root, currency, and date bucket

### User actions

Show candidate duplicates with:

- canonical record suggestion
- duplicate candidate record
- reason codes
- attached receipt count
- attached payment proof status

Allowed actions:

- keep both
- mark duplicate candidate
- link as same purchase
- merge into canonical, with confirmation only

Merging should soft-archive the duplicate and move attachments safely rather than hard-delete the record.

## Settlement and ledger logic

The system should distinguish three monetary layers:

- document amount: what the receipt or invoice says
- settlement amount: what the payment source actually charged or paid
- ledger amount: what should be posted to the accounting voucher

### Monetary rules

| Scenario | Document amount | Settlement amount | Ledger amount |
|---|---|---|---|
| HK receipt paid by HK card | HKD | HKD | HKD |
| USD receipt paid by HK card | USD | HKD | HKD |
| RMB receipt paid by China bank | RMB | RMB | RMB or HKD depending on entity/accounting treatment |
| RMB receipt paid by WeChat/Alipay | RMB | RMB | RMB or HKD depending on entity/accounting treatment |
| Personal payment for business expense | document currency | personal settlement currency | ledger currency plus reimbursement tracking |

### Recommended statuses

- `unsettled`: expense captured, no matching payment evidence
- `estimated`: provisional ledger amount exists but payment confirmation is incomplete
- `confirmed`: matched payment source confirms final settlement

### Reimbursement rules

If a business expense is paid with a personal China bank account, WeChat, or Alipay, the expense should support reimbursement tracking rather than pretending the company paid it directly.

Recommended reimbursement statuses:

- `not_needed`
- `pending`
- `reimbursed`

## Payment-proof automation

The app should automatically create a proof-of-payment asset for each confirmed matched expense. This should remove the manual work of locating a statement page, wallet screenshot, or payment line for filing.

### Key design idea

When payment evidence is imported, the system should preserve not just parsed rows but also the source representation used to create filing evidence.

### Storage pattern

Recommended storage structure:

```txt
payments/{uid}/{importId}/source.pdf
payments/{uid}/{importId}/source.png
payments/{uid}/{importId}/pages/page-01.png
payments/{uid}/{importId}/pages/page-02.png
payments/{uid}/{importId}/proofs/{expenseId}-payment-proof.png
payments/{uid}/{importId}/proofs/{expenseId}-payment-proof.pdf
```

### Required extraction metadata

For each parsed payment transaction, store:

- source page number if available
- row reference or line index
- optional bounding box coordinates
- raw text snippet
- source type and account type

These fields make it possible to generate a visual excerpt automatically rather than forcing a manual search later.

### Proof generation flow

After the user confirms a match:

1. Load the source page or source image.
2. Locate the row using stored coordinates or row offsets.
3. Crop a context band around the matched line.
4. Draw a highlight box or overlay.
5. Save the excerpt as PNG.
6. Optionally create a single-page PDF version with caption metadata.
7. Attach the proof URLs back to the expense.
8. Log the action in `reconciliationActions`.

### Proof design requirements

Each proof should include:

- enough surrounding context to show it came from a real payment source
- visible highlight around the matched row or payment line
- payment source identity, such as bank, card, WeChat, or Alipay account label and period when relevant
- expense metadata, such as vendor and settled amount, if rendered into PDF form

A crop that is too tight should be avoided because auditors may want surrounding context for credibility.

## UI design

The current app already uses pages such as Login, Dashboard, Upload, Expenses, and Settings, and it uses custom confirmation dialogs and shared loading patterns.[file:1] The new feature should follow that structure.

### New pages

- `PaymentSources.jsx`
- `Reconciliation.jsx`
- optional `AuditPack.jsx` or export modal within Expenses

### Payment Sources page

Purpose:

- manage payment accounts
- upload and review imports
- view parse status
- open reconciliation queue

Suggested sections:

- add payment account
- account selector with source type badges
- import button
- import history table
- processing status chips
- period filters
- open reconciliation action

### Reconciliation page

Tabs:

- auto-matched
- needs review
- unmatched
- duplicate candidates
- ignored

Each row or card should show:

- payment transaction details
- candidate expense
- receipt thumbnail if present
- settlement amount and currency
- ledger amount and currency if known
- confidence score
- match reasons
- payer type and reimbursement state where relevant

Actions:

- confirm match
- confirm settlement
- create expense from payment transaction
- ignore transaction
- mark duplicate candidate
- merge duplicate with confirmation
- view payment proof preview
- mark reimbursement pending or reimbursed

### Expense detail enhancements

Each expense should show a status strip:

- receipt only
- payment matched
- settlement confirmed
- reimbursement pending or reimbursed
- proof generated
- filing ready

Actions:

- view receipt
- view payment proof
- regenerate proof
- update reimbursement state
- export audit pack

## Export design

The current app already supports Excel export and receipt ZIP export.[file:1] Extend export into three clear modes.

### 1. Expense archive export

Purpose: operational archive.

Columns:

- Date
- Vendor
- Document Amount
- Document Currency
- Category
- Notes
- Receipt URLs

### 2. Accounting voucher export

Purpose: accounting entry support.

Columns:

- Date
- Vendor
- Category
- Document Amount
- Document Currency
- Settlement Amount
- Settlement Currency
- Ledger Amount
- Ledger Currency
- Settlement Status
- Settlement Source Type
- Payment Account Label
- Reimbursement Status
- Payment Reference
- Notes

### 3. Audit pack ZIP export

Purpose: filing for accountant or auditor.

Suggested folder structure:

```txt
2026-05/
  Equipment/
    2026-05-12_amazon_947.36_HKD/
      expense-summary.json
      receipt-1.pdf
      receipt-2.jpg
      payment-proof.png
      payment-proof.pdf
      source-payment-reference.txt
```

Each folder should represent one expense and contain both the commercial document and the proof-of-payment record.

## Backend and processing architecture

The current app uses Netlify Edge Functions for receipt extraction and a download proxy for Storage assets, while deployment is on Netlify with same-origin API routing.[file:1] The new feature should keep that model.

### Recommended endpoints

- `POST /api/process-payment-source` — parse bank, card, wallet, or screenshot sources into structured payment transactions
- `POST /api/reconcile-payments` — run matching rules and write suggestions
- `POST /api/confirm-settlement` — link payment transaction to expense and write settlement and ledger values
- `POST /api/generate-payment-proof` — create highlighted excerpt assets
- `POST /api/merge-expenses` — controlled duplicate merge with audit log
- `POST /api/export-audit-pack` — assemble ZIP bundle for filing

### Client versus server responsibilities

Client-side:

- payment account management UI
- import UI
- preview parsing results
- review suggestions
- display proof previews

Server-side:

- payment source parsing
- reconciliation writes
- settlement confirmation writes
- proof generation
- merge logic
- export bundle assembly

This split is safer because settlement confirmation and merging are accounting-sensitive writes.

## Firestore indexes

The current app does not require composite indexes for its main flows because it primarily queries by `userId`.[file:1] This feature will likely need more indexing.

Recommended indexes:

- `paymentTransactions`: `userId + status + createdAt`
- `paymentTransactions`: `userId + importId + sourceRowIndex`
- `paymentTransactions`: `userId + projectId + status + transactionDate`
- `paymentImports`: `userId + createdAt`
- `paymentAccounts`: `userId + active + sourceType`
- `expenses`: `userId + settlementStatus + date`
- `expenses`: `userId + reimbursement.reimbursementStatus + date`
- `expenses`: `userId + paymentEvidence.status + date`

## Rollout plan

### Phase 1

- payment account setup
- CSV import for bank and card sources
- `paymentImports` and `paymentTransactions`
- reconciliation queue
- rule-based matching
- manual confirm match
- no automatic merge

### Phase 2

- HKD and RMB settlement confirmation fields
- accounting voucher export
- reimbursement tracking for personal payments
- payment evidence status on each expense

### Phase 3

- PDF and image parsing for bank and wallet sources
- WeChat Pay and Alipay screenshot or export support
- page rendering and coordinate capture
- automatic payment-proof generation
- audit pack ZIP export

### Phase 4

- duplicate merge flow with soft archive
- manual proof highlight adjustment
- account-specific parsing templates
- merchant alias learning for bank, WeChat, and Alipay sources

## Risks and controls

| Risk | Why it matters | Control |
|---|---|---|
| False matches | Can produce wrong accounting evidence | Require confidence scoring and user confirmation |
| Over-merging | Can destroy audit trail | No automatic merge; soft archive only |
| FX ambiguity | Settlement and ledger values may differ | Use document, settlement, and ledger amount layers |
| Personal versus company payer confusion | Reimbursement can be lost | Explicit payer and reimbursement fields |
| Weak source crops | Auditor may reject unclear excerpt | Keep context band and allow manual adjustment |
| Layout drift across sources | Auto-cropping may fail | Store full source, page image, and editable proof generation |
| Wallet source variability | WeChat and Alipay exports may be inconsistent | Use source-specific parsing and manual confirmation fallback |

## Recommended MVP definition

The best MVP is not “scan statements and tick expenses.” The best MVP is:

**Payment reconciliation with settlement confirmation, reimbursement tracking, and filing-ready proof preparation**

That MVP should include:

- payment account setup
- CSV import first for bank and card sources
- payment transaction records
- reconciliation queue
- document, settlement, and ledger amount model
- reimbursement tracking
- payment evidence status tracking
- export columns for accounting voucher support

Automatic visual payment-proof generation and wallet-source automation should be treated as the next high-value release once imports and matching are stable.

## Claude build brief

Use the following brief as the implementation instruction:

> Extend the existing Expense Organiser React/Firebase app with a new module for Payment Reconciliation, Settlement Confirmation, Reimbursement Tracking, and Audit Pack Automation. The current app already uses React 18, React Router, Firebase Auth, Firestore, Firebase Storage, Netlify Edge Functions, Netlify Functions, AI receipt extraction, receipt image storage, Excel export, ZIP export, custom confirmation dialogs, and project-based expense management.[file:1] Add new Firestore collections `paymentAccounts`, `paymentImports`, `paymentTransactions`, and `reconciliationActions`, and extend `expenses` to support `documentAmount`, `documentCurrency`, `settlementAmount`, `settlementCurrency`, `ledgerAmount`, `ledgerCurrency`, reimbursement fields, reconciliation metadata, and `paymentEvidence`. Build new pages `PaymentSources.jsx` and `Reconciliation.jsx`. Keep imported payment transactions separate from expenses until user confirmation. Support Hong Kong bank accounts and credit cards first, but design the model to also support China bank accounts, WeChat Pay, and Alipay. Implement transparent rule-based matching using normalized merchant name, date window, amount logic, project context, and special handling for cross-currency expenses where document, settlement, and ledger amounts differ. Treat the actual payment source as the settlement source of truth, and support reimbursement tracking when business expenses are paid from personal accounts. Add an action to confirm settlement from a matched payment transaction. Add payment evidence generation support by storing source file references, page references, and proof asset URLs on the expense. Prepare the system so it can later auto-generate highlighted payment excerpts for filing from bank statements, card statements, wallet screenshots, and other payment records. Extend export so that accounting voucher export includes settlement and ledger fields and audit-pack export can bundle receipt files and payment proof files together. Reuse the existing `ConfirmDialog` pattern for merge and other sensitive actions. Do not auto-merge duplicates or auto-delete records. Preserve full auditability through append-only reconciliation action logs.

## Final recommendation

This feature should be built as a payment reconciliation and evidence system, not as a simple statement-scanning shortcut. The receipt proves what was purchased, the payment record proves what was actually paid, reimbursement fields capture who paid, and the generated payment proof should become the filing artifact that removes repetitive accountant and auditor preparation work.
