# Payment Reconciliation — Merged Spec v1

This supersedes both source documents for implementation purposes:
- `statement-reconciliation-hkd-audit-pack-brief.md` (multi-rail HKD/RMB payment reconciliation, settlement/ledger model)
- `Expense App：Credit Card Statement 擴展 Spec.md` (credit card statement classification, card↔bank settlement linking)

Those two describe the same feature at different resolutions. This doc keeps the audit-pack brief's data model (it's the one built to survive adding WeChat/Alipay later without a schema rewrite) and folds in the credit card doc's row-classification detail and two fields it had that audit-pack lacked (installments, pending/posted). It narrows scope to what Phase 1 actually needs.

## 1. Objective

Let Tiffany import bank and credit card statements, have the system propose matches to existing expenses, and prevent the classic double-count: a card purchase matched to an expense, then the bank debit that pays off the card matched to the *same* expense again.

## 2. Explicit non-goals for Phase 1

Both source docs agree these are later phases. Do not build them now:
- WeChat Pay / Alipay import or parsing
- Automatic payment-proof image generation (crop + highlight)
- Audit-pack ZIP export
- Duplicate auto-merge (soft-archive merge UI)
- Reimbursement tracking UI (the *field* is reserved in the data model so we don't need a migration later, but no workflow around it yet)
- OCR of PDF/image statements — **Phase 1 takes CSV import only**. Statement OCR (parsing a photographed or PDF statement into rows) is real complexity (table layout, multi-page, bank-specific formats) and deserves its own pass once the reconciliation logic is proven against clean CSV data.

## 3. Data model (Firestore)

Collection names and shape follow the audit-pack brief, since it's already generic across payment rails. `sourceType`/`platformType` values are restricted to `"bank" | "credit_card"` for Phase 1 — the enum stays open for `"wechat" | "alipay"` later, but nothing parses them yet.

### `paymentAccounts`

```js
{
  userId: string,
  projectId: string,              // added: everything in this app is project-scoped
  label: string,                  // e.g. "HSBC Visa ****1234"
  sourceType: "bank" | "credit_card",
  accountTail: string | null,     // last 4 digits, never full number
  institutionName: string | null,
  settlementCurrency: "HKD" | "RMB" | "USD" | "EUR" | "Other",
  active: boolean,
  createdAt: Timestamp
}
```

### `paymentImports`

```js
{
  userId: string,
  projectId: string,
  paymentAccountId: string,
  sourceType: "csv",              // Phase 1: csv only
  sourceFileName: string,
  sourceFileUrl: string | null,   // original CSV kept in Storage for audit trail
  periodStart: string | null,
  periodEnd: string | null,
  importStatus: "processing" | "ready" | "error",
  lineCount: number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  errorMessage: string | null
}
```

### `paymentTransactions`

Audit-pack's shape, plus the two fields the credit card doc had that audit-pack didn't:

```js
{
  userId: string,
  projectId: string,
  importId: string,
  paymentAccountId: string,

  transactionDate: string | null,
  postDate: string | null,        // "posting date" in credit-card-doc terms
  rawDateText: string,

  merchantRaw: string,
  merchantNormalized: string,

  settlementAmount: number,
  settlementCurrency: string,
  direction: "debit" | "credit",
  transactionType:
    "purchase" | "fee" | "interest" | "refund" |
    "payment" | "transfer" | "cash_withdrawal" | "unknown",

  // Credit-card-specific (nullable, unused for bank rows)
  installmentIndicator: boolean,
  installmentNumber: number | null,
  installmentTotal: number | null,
  pendingOrPosted: "posted" | "pending" | "unknown",

  fingerprintExact: string,
  fingerprintLoose: string,

  status: "unmatched" | "suggested" | "matched" | "duplicate_candidate" | "ignored",
  matchedExpenseIds: string[],
  settlementGroupId: string | null,   // set when linked as a card-payment↔bank-debit pair

  confidenceScore: number | null,
  matchReasons: string[],

  sourceRowIndex: number | null,
  rawRowText: string,              // verbatim CSV row — never store only the parsed value

  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### `expenses` — new fields only (existing fields untouched)

```js
{
  ...existingFields,
  documentAmount: number | null,       // = existing `amount`, aliased for clarity; do not duplicate data, just read `amount` as documentAmount conceptually
  settlementAmount: number | null,
  settlementCurrency: string | null,
  settlementStatus: "unsettled" | "confirmed",   // Phase 1 drops "estimated" — nothing computes it yet
  matchedPaymentTransactionId: string | null,
  matchedPaymentAccountId: string | null,
}
```

Deferred to Phase 2 (reserved names only, not implemented): `ledgerAmount`, `ledgerCurrency`, `reimbursement {...}`, `paymentEvidence {...}`.

### `reconciliationActions` (append-only audit log)

```js
{
  userId: string,
  projectId: string,
  paymentTransactionId: string,
  expenseId: string | null,
  actionType: "auto_suggested" | "matched" | "unmatched" | "ignored" | "settlement_linked",
  beforeState: object | null,
  afterState: object | null,
  createdAt: Timestamp,
  actor: { uid: string, email: string }
}
```

## 4. Transaction classification (credit-card doc §4, generalized)

After CSV parse, classify every row before it's eligible for matching:

| `transactionType` | Matches to expense? |
|---|---|
| `purchase` | Yes — primary case |
| `fee`, `interest` | Yes, but shown at lower confidence (may be a statement-level charge with no receipt) |
| `refund` | No auto-expense; offered as a link to the *original* expense (reduces its net amount in reporting, does not create a new expense) |
| `payment`, `transfer` | No — never becomes an expense. Card `payment` rows are offered for settlement-linking against bank `debit` rows instead (§6) |
| `cash_withdrawal` | No — flagged for manual review, not auto-matched |
| `unknown` | No — manual review |

Pending vs. posted: only `pendingOrPosted: "posted"` rows are eligible for matching. Pending rows are stored (so nothing is silently dropped) but excluded from the matching queue, preventing the same purchase being matched twice as it transitions pending → posted.

## 5. Matching engine (expense matching)

Rules-based, not LLM-based — transparent and explainable, per audit-pack's design principle.

**Candidate filter:** same `userId` + `projectId`, `transactionType` in `[purchase, fee, interest]`, `pendingOrPosted = posted`, date within 10 days of expense date, not already at `matchedExpenseIds.length >= 1` on the expense side.

**Scoring:**

| Rule | Points |
|---|---:|
| Exact amount match | +45 |
| Same currency | +15 |
| Date same day | +15 |
| Date within 1–3 days | +10 |
| High merchant-name similarity | +20 |
| Medium merchant-name similarity | +10 |
| `transactionType = purchase` | +5 |
| Expense already matched elsewhere | −50 |

**Thresholds:** ≥90 high-confidence (pre-positioned at top of review queue, never auto-confirmed), 70–89 review, 50–69 weak, <50 not shown.

## 6. Settlement linking (card payment ↔ bank debit) — the double-count guard

This is the credit card doc's core contribution and the reason this feature exists.

**Rule:** a `paymentTransactions` row with `transactionType: "payment"` on a credit card account may only link to a `paymentTransactions` row with `direction: "debit"` on a bank account — never to an `expenses` record.

**Scoring for this link:**

| Rule | Points |
|---|---:|
| Exact amount match | +60 |
| Same currency | +15 |
| Same day | +15 |
| Within 1–3 days | +10 |
| Bank description contains card issuer name | +10 |
| Already linked to another settlement | −50 |

On confirm: both rows get `settlementGroupId` set to each other's group; both are permanently excluded from `matchedExpenseIds` eligibility.

**Reporting rule:** any expense total/report query excludes `paymentTransactions` where `transactionType in [payment, transfer]` or `settlementGroupId != null`. This is the one rule that must never be bypassed — it's the entire point of the feature.

## 7. UI

Two new pages, following existing page/dialog conventions (`ConfirmDialog`, existing card styles):

- **`PaymentSources.jsx`** — manage `paymentAccounts`, upload CSV → `paymentImports`, see import status/row count.
- **`Reconciliation.jsx`** — tabbed queue: *Needs Review* / *Auto-suggested* / *Card Settlements* / *Ignored*. Each row shows the transaction, candidate expense (or candidate settlement partner), match score, match reasons, and actions: Confirm Match / Choose Another / Create Expense / Ignore / Link Settlement / Not Related.

No changes to `Upload.jsx` or the receipt OCR pipeline — this is entirely additive.

## 8. Backend endpoints (Netlify Functions, not edge — these are longer-running batch writes, not per-request OCR)

- `POST /api/import-payment-csv` — parse CSV, write `paymentImports` + `paymentTransactions`, classify + fingerprint each row
- `POST /api/reconcile-payments` — run matching rules for a project's unmatched transactions, write `status`/`confidenceScore`/`matchReasons`
- `POST /api/confirm-match` — link a transaction to an expense, write `reconciliationActions`
- `POST /api/link-settlement` — link a card-payment row to a bank-debit row

## 9. Firestore indexes (add only when Firestore's error message asks for them, per existing project convention — don't pre-create)

Expected candidates: `paymentTransactions` on `userId+projectId+status`, `userId+importId+sourceRowIndex`.

## 10. Acceptance checklist for Phase 1

- [ ] Create a payment account (bank or credit card), see it listed
- [ ] Import a CSV, see rows appear as classified `paymentTransactions` with raw row text preserved
- [ ] Purchase rows produce match candidates against real expenses with visible score + reasons
- [ ] Confirming a match sets `expenses.matchedPaymentTransactionId` and writes a `reconciliationActions` entry
- [ ] A credit-card `payment` row never appears as an expense-match candidate
- [ ] Linking a card payment to a bank debit sets `settlementGroupId` on both and removes both from future expense-matching candidate pools
- [ ] Pending transactions are stored but never shown in the matching queue until posted
- [ ] Re-importing the same CSV flags duplicate rows via `fingerprintExact` instead of creating duplicates silently
