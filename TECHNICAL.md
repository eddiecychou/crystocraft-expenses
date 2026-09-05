# Expense Operations Center — Technical Documentation

_Current release: **V1.0** (see [CHANGELOG.md](CHANGELOG.md)). Formerly named "Expense Organiser" — some historical docs, spec files, and Firebase project names still use the old name; the running app, its title bar, and this document use the new one._

## Overview

Expense Operations Center is a multi-user bookkeeping web application. It covers three workflows:

1. **Receipt capture** — upload a receipt photo/PDF, AI extracts date/vendor/amount/currency/category, save to the expense ledger.
2. **Payment source import** — upload bank or credit-card statements (CSV/PDF), parse them into individual transactions, detect duplicates against prior imports.
3. **Reconciliation** — match imported bank/card transactions against expense records (or create new expenses from unmatched transactions), link credit-card settlements to their originating card charges, and maintain an append-only audit log of every reconciliation action.

Data is organized into **projects** (e.g. one per company); each user can belong to multiple projects and switches between them via a persistent active-project selector.

For the specific bugs, dead ends, and design decisions that shaped the current implementation, see [LESSONS_LEARNED.md](LESSONS_LEARNED.md). For a function-by-function map of the codebase, see [FUNCTION_INDEX.md](FUNCTION_INDEX.md).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v6, Vite + SWC |
| Auth | Firebase Authentication (email/password + Google OAuth) |
| Database | Cloud Firestore |
| File Storage | Firebase Storage |
| Serverless Functions | Netlify Edge Functions (Deno runtime) + Netlify Functions (Node.js) |
| AI | Google Gemini API (`gemini-2.5-flash`, `gemini-2.5-pro` fallback) |
| PDF parsing | `pdfjs-dist` (client-side, for statement PDF table extraction) |
| Export | ExcelJS (`.xlsx`), JSZip (`.zip`) |
| Icons | `lucide-react` |
| Hosting | Netlify |

---

## Architecture

```
Browser (React SPA)
│
├── Firebase Auth          — sign-in / sign-out / session state
├── Firestore              — projects, expenses, payment accounts/imports/
│                             transactions, reconciliation action log
├── Firebase Storage       — receipt images/PDFs, original statement files
│
└── Netlify (edge/serverless)
    ├── /api/process-receipt   — Edge Function (Deno): calls Gemini AI to extract receipt data
    ├── /api/download-receipt  — Edge Function (Deno): CORS proxy for downloading storage files
    │                            (despite the name, used generically for any stored file —
    │                            receipts AND statement PDFs — see LESSONS_LEARNED.md)
    └── /.netlify/functions/export-excel  — Node Function: (legacy path, kept for routing)
```

The frontend is a pure SPA deployed to Netlify. All API calls stay within the same origin, avoiding CORS issues. Sensitive keys (Firebase config, Gemini API key) are stored as Netlify environment variables and never exposed to the browser.

---

## Project Structure

```
/
├── index.html
├── vite.config.js                — also injects __APP_VERSION__ (git SHA), __APP_RELEASE__ (from package.json), __BUILD_TIME__
├── netlify.toml
├── package.json
│
├── src/
│   ├── main.jsx                  — app entry point
│   ├── App.jsx                   — router, auth guard, ProjectProvider wrapper
│   ├── App.css                   — all styles + design tokens (single file, ~1300+ lines)
│   ├── firebase.js                — Firebase app init with IndexedDB persistence (auth, db, storage exports)
│   ├── constants.js               — CATEGORIES, CURRENCIES, PAYMENT_METHODS arrays
│   ├── icons.js                   — centralized lucide-react icon map + ICON_STROKE_WIDTH
│   ├── receiptStorage.js          — upload/delete receipt images (Storage, compressed)
│   ├── statementStorage.js        — upload/delete original statement files (Storage, uncompressed)
│   │
│   ├── hooks/
│   │   └── useAuthState.js        — wraps onAuthStateChanged as a React hook
│   │
│   ├── contexts/
│   │   └── ProjectContext.jsx     — project list, active project, color themes, expense migration
│   │
│   ├── lib/
│   │   ├── duplicateDetection.js  — fingerprint-collision classification for statement imports
│   │   ├── paymentMatching.js     — CSV parsing, merchant normalization, expense/settlement match scoring
│   │   ├── pdfStatementParser.js  — PDF table extraction for bank/credit-card statements (pdf.js-based)
│   │   └── expenseClassification.js — personal/company classification for personal-account transactions
│   │
│   ├── components/
│   │   ├── Layout.jsx              — sidebar nav (desktop), bottom nav + More sheet (mobile), logout
│   │   ├── ProjectBanner.jsx       — active project name/dot shown on each page
│   │   ├── ConfirmDialog.jsx       — in-app confirmation modal (replaces browser confirm())
│   │   └── LoadingBar.jsx          — animated progress bar shown during all loading states
│   │
│   └── pages/
│       ├── Login.jsx               — sign in / sign up / forgot password
│       ├── Dashboard.jsx           — date-filtered totals, category breakdown, recent expenses (route: /)
│       ├── Capture.jsx             — mobile dispatcher: routes to Upload or Payment Sources (route: /capture)
│       ├── Upload.jsx              — receipt upload, AI extraction, save flow (route: /upload)
│       ├── Expenses.jsx            — full records table/cards, edit, delete, export (route: /expenses)
│       ├── PaymentSources.jsx      — account management + statement import + duplicate review (route: /payment-sources)
│       ├── Reconciliation.jsx      — transaction matching workspace (route: /reconciliation)
│       ├── CompanyReview.jsx       — personal-account transaction classification queue (route: /company-review)
│       ├── Settings.jsx            — project management (route: /settings)
│       └── Export.jsx              — standalone Excel export utility; NOT routed in App.jsx, currently orphaned
│
└── netlify/
    ├── edge-functions/
    │   ├── process-receipt.js     — Gemini AI receipt parser (Deno)
    │   └── download-receipt.js    — CORS proxy for Firebase Storage URLs (Deno)
    └── functions/
        ├── export-excel.js        — (legacy) Node.js function
        └── package.json
```

---

## Firebase Setup

### Services Used

| Service | Purpose |
|---|---|
| Authentication | User sign-in (email + Google) |
| Firestore | `projects`, `expenses`, `paymentAccounts`, `paymentImports`, `paymentTransactions`, `reconciliationActions` collections |
| Storage | Receipt images at `receipts/{uid}/{expenseId}/image{n}.{ext}`; original statement files at `statements/{uid}/{importId}/{filename}` |

### Firestore Collections

**`projects`**
```
{
  userId: string,       // Firebase Auth UID
  name: string,
  color: string,        // one of 24 color keys (see ProjectContext PROJECT_COLORS)
  createdAt: Timestamp
}
```

**`expenses`**
```
{
  userId: string,
  userEmail: string,
  projectId: string,
  date: string,          // YYYY-MM-DD
  vendor: string,
  amount: number,
  currency: string,      // HKD | RMB | USD | EUR | JPY | AUD | GBP | SGD | CAD | KRW | Other
  category: string,      // see CATEGORIES table below
  notes: string,
  paymentMethod: string,
  images: [{ url: string, path: string, name: string }],
  reconciliationStatus: string,  // set when created from a matched statement transaction
  receiptStatus: string,         // e.g. 'missing' when created_from_statement with no receipt yet
  createdAt: Timestamp
}
```

**`paymentAccounts`**
```
{
  userId: string,
  projectId: string,
  name: string,
  sourceType: string,      // 'bank' | 'credit_card'
  ownershipType: string,   // 'company' | 'personal' — missing/undefined treated as 'company'.
                           // Only 'personal' accounts get per-transaction classification
                           // (see Company Review below) — company accounts are unaffected.
  createdAt: Timestamp
}
```

**`paymentImports`** — one doc per import attempt (including failed/empty re-attempts; see LESSONS_LEARNED.md on why these are never deleted automatically)
```
{
  userId: string,
  projectId: string,
  paymentAccountId: string,
  sourceFileName: string,
  sourceFileUrl: string | null,   // Firebase Storage download URL for the original file
  sourceStoragePath: string | null,
  lineCount: number,
  importStatus: string,           // 'processing' | 'complete' | 'error' | 'verified' | 'needs_review'
  errorMessage: string | null,
  statementTotals: { openingBalance, closingBalance } | null,
  createdAt: Timestamp
}
```

**`paymentTransactions`** — one doc per parsed statement row; every row is written unconditionally, never held back pending duplicate review (see LESSONS_LEARNED.md)
```
{
  userId: string,
  projectId: string,
  paymentAccountId: string,
  importId: string,
  transactionDate: string,
  rawDateText: string,
  postDate: string | null,
  merchantRaw: string,
  merchantNormalized: string,
  settlementAmount: number,
  settlementCurrency: string,
  direction: string,       // 'debit' | 'credit'
  balanceAfter: number | null,
  transactionType: string,
  rawRowText: string,
  fingerprint: string,
  duplicateStatus: string,        // 'verified_separate' | 'possible_duplicate' | 'confirmed_duplicate' | 'needs_review'
  duplicateReason: string | null,
  duplicateEvidence: object | null,
  duplicateOfTransactionId: string | null,
  duplicateReviewedAt: Timestamp | null,
  status: string,                 // 'unmatched' | 'matched' | 'ignored'
  matchedExpenseIds: string[],
  // Only present when the row's account has ownershipType 'personal' — see
  // "Personal-to-Company Classification" below. Absent entirely on rows
  // imported under a company account (no schema change for existing data).
  classification: string | null,           // 'personal' | 'company_candidate' | 'company_confirmed' | 'shared' | 'needs_accountant_review' | 'rejected_company_claim'
  classificationConfidence: number | null,
  classificationSource: string | null,     // 'match' | 'user' | null
  businessPurpose: string | null,
  reviewNote: string | null,
  accountantStatus: string | null,         // 'not_required' | 'pending' | 'approved' | 'rejected'
  createdAt: Timestamp
}
```

**`reconciliationActions`** — append-only log, never mutated or deleted
```
{
  userId: string,
  transactionId: string,
  expenseId: string | null,
  actionType: string,   // 'confirm_match' | 'ignore' | 'undo_ignore' | 'unmatch' | 'link_settlement' | ...
  beforeState: object,
  afterState: object,
  createdAt: Timestamp
}
```

### Security Rules

**This repo has no `firestore.rules` or `storage.rules` file — rules exist only in the Firebase Console.** Every collection and Storage path above needs its own rule published there before the feature works; a missing rule fails silently with `permission-denied` even though the code looks complete. See [LESSONS_LEARNED.md](LESSONS_LEARNED.md#firebase-rules-live-outside-the-repo) before adding anything new.

General pattern: `allow read, write: if request.auth != null && request.auth.uid == resource.data.userId` for Firestore per-user collections; `allow read, write: if request.auth != null && request.auth.uid == userId` for Storage per-user paths.

### Required Firestore Indexes

No composite indexes are required. All queries use `where('userId', '==', uid)` which is automatically indexed. Project and status filtering is done client-side.

### Authorized Domains

Add all deployment domains to Firebase → Authentication → Settings → Authorized domains:
- `localhost`
- Production Netlify domain
- Any Netlify branch preview domains

---

## Environment Variables

### Frontend (`.env.local` / Netlify site variables)

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

These are bundled into the client at build time (Vite `import.meta.env`). They are safe to expose — Firebase security is enforced by Auth rules, not key secrecy.

### Backend (Netlify environment variables — server only)

```
GEMINI_API_KEY=        — Google AI Studio API key
```

This key is only accessed inside the Deno edge function and is never sent to the browser.

---

## Key Features

### Authentication

- Email/password sign-up and sign-in via Firebase Auth
- Google OAuth via `signInWithPopup`
- Forgot password via `sendPasswordResetEmail`
- Session persisted automatically by Firebase SDK
- `useAuthState` hook wraps `onAuthStateChanged` and drives the `ProtectedRoute` guard in `App.jsx`

### Multi-Project Support

`ProjectContext` manages the project list and tracks the active project in `localStorage`. On first sign-in a `Default` project is auto-created. Any expenses without a `projectId` (migrated data) are treated as belonging to the Default project.

Project selection is instant — `selectProject` updates `localStorage` and React state without a network round-trip. Project edits use `updateProject` for immediate UI updates while persisting to Firestore in the background.

### Color Theming

24 color identities are defined in `PROJECT_COLORS` (10 original + 14 muted additions). A project's color is purely an **identity accent** — a 4px top border on the sidebar/mobile-nav and the `ProjectBanner` dot/badge — not the app's brand/action color. The app's brand color (`--t-dark`/`--t-mid`/`--t-btn`/`--t-btn-hover`) is a single fixed neutral theme set once in `App.css` `:root`, deliberately not overridden per project, so status colors (amber "Needs Review", red "Error") stay legible regardless of which client's data is on screen.

### Expense Categories

Eleven categories are defined in `constants.js` and used across dropdowns, badges, and the AI prompt:

| Category | Typical use |
|---|---|
| Travel | Flights, trains, taxis, hotels |
| Meals | Restaurants, cafes, food |
| Office | Stationery, supplies |
| Software | Apps, subscriptions, SaaS |
| Utilities | Electricity, internet, phone |
| Development | Coding tools, hosting, domains |
| Marketing | Ads, promotions, print materials |
| Professional Services | Accounting, legal, consulting fees |
| Equipment | Hardware, machinery, tools |
| Bank Charges | Transaction fees, wire transfers, FX fees |
| Other | Anything that doesn't fit above |

Badge CSS class names are generated by converting the category to lowercase with spaces replaced by hyphens (e.g. `badge-professional-services`).

### Receipt Upload & AI Extraction

1. User drops or selects image/PDF files (JPEG, PNG, WebP, HEIC, GIF, BMP, TIFF, PDF)
2. Images are resized client-side to max 2400px and compressed to JPEG 93% using `OffscreenCanvas`
3. Before sending to Gemini, `preprocessForGemini` creates a separate high-contrast version in memory:
   - Converts to greyscale (removes colour noise, improves thermal receipt contrast)
   - Applies auto-levels (stretches histogram to 0–255, clipping 1% outliers)
   - Encodes as lossless PNG
4. The preprocessed PNG is POSTed to `/api/process-receipt`; the original colour JPEG is kept for Firebase Storage
5. The Deno edge function forwards to Gemini with a structured JSON prompt
6. Extracted fields are returned and rendered in an editable form
7. User reviews/corrects fields, then saves — expense is written to Firestore and original colour JPEG uploaded to Firebase Storage

**Upload flow UX:**

1. User selects or drops files — the dropzone is hidden immediately so it cannot be accidentally re-tapped
2. **Single file:** AI extraction starts automatically. **Multiple files:** a file list appears with individual Remove buttons for review before pressing "Extract Data with AI"
3. Each file item carries a stable numeric `_id` so Remove works correctly even when multiple mobile photos share the same generic filename
4. During extraction a sliding indeterminate progress bar appears, with a counter for multi-file batches (`Extracting 2 of 5…`)
5. Results cards appear for review with a thumbnail; tapping opens a lightbox. Required fields (Date, Vendor, Amount) highlight red if empty on save

**Two-image pipeline summary:**

| Version | Format | Used for |
|---|---|---|
| Colour JPEG (93%) | `image/jpeg` | Firebase Storage, receipt lightbox |
| Greyscale PNG (lossless) | `image/png` | Gemini API only, discarded after extraction |

**PDF extraction shortcut:** PDFs skip the transcription step entirely and go straight to the extraction call — a digital PDF already has machine-readable text embedded.

**Multi-file processing:** files are processed sequentially. **Important:** the Extract button must use `onClick={() => processFiles()}`, not `onClick={processFiles}` directly — the bare reference passes the click event as the first argument, which shadows the `fileItems` fallback and silently breaks multi-file extraction.

**Gemini model fallback:** tries `gemini-2.5-flash` first, falls back to `gemini-2.5-pro`. On high-demand errors, retries once after 3 seconds. `thinkingConfig.thinkingBudget` must be set to `0` — see [LESSONS_LEARNED.md](LESSONS_LEARNED.md#gemini-thinking-budget).

### Payment Source Import & Duplicate Detection

Accounts (bank or credit-card) are created in **Payment Sources**, then CSV or PDF statements are uploaded and parsed:

- **CSV**: `parseCSV` + `mapCsvRecords` in `paymentMatching.js` handle header-alias detection and column mapping.
- **PDF**: `parsePdfStatement` in `pdfStatementParser.js` extracts a transaction table from PDF text-position data (via `pdfjs-dist`), calibrating column boundaries from the *data's* x-clustering rather than trusting header label positions — see [LESSONS_LEARNED.md](LESSONS_LEARNED.md#pdf-statement-parsing-is-fragile) for why this matters.

Every parsed row is written to `paymentTransactions` **unconditionally** — duplicate detection only annotates rows with a `duplicateStatus`, it never withholds or silently drops them (this is a hard accounting-correctness requirement; see [LESSONS_LEARNED.md](LESSONS_LEARNED.md#duplicates-must-surface-never-silently-skip)). `classifyFingerprintCollision` in `duplicateDetection.js` is the classifier:

- Bank statements: `annotateBalanceSequence` (previous row's balance + this row's debit/credit vs. its reported balance, in original statement order) is the strongest evidence.
- Credit-card statements (no per-row balance): falls back to merchant-description comparison, defaulting to keeping both rows.
- An **identical `rawRowText` match across two different imports** (`candidateImportId` differs from the collision row's `importId`) is the only case classified `confirmed_duplicate` automatically — a genuine re-upload of the same statement. Identical text *within the same import* (two real transactions the statement happened to print identically) is never auto-confirmed; it falls through to the normal evidence hierarchy.

Users resolve flagged rows via **Keep as Separate / Confirm Duplicate / Ignore Warning** — never a silent auto-merge or delete. Once resolved, the row collapses to a compact "Resolved" badge with a "Change" link to reopen it, rather than staying expanded forever or hiding the resolve action entirely.

The **original uploaded file** (CSV or PDF) is stored via `statementStorage.js` uncompressed, alongside the parsed transactions, so any imported row can be traced back to its source document — a hard requirement for bookkeeping, not a "phase 2" nice-to-have.

**Verify / Fix from Stored PDF**: `verifyImportAgainstSource` re-downloads the stored original (via the `/api/download-receipt` proxy — a direct browser `fetch()` of a Firebase Storage URL fails, see [LESSONS_LEARNED.md](LESSONS_LEARNED.md#storage-fetch-needs-a-proxy)), re-parses it, and diffs the result against what's stored (`diffTransactionSets`). `reprocessFromStoredPdf` re-imports from the stored file when a mismatch is found, replacing the previously-parsed rows.

### Reconciliation

`runMatching` scores every unmatched `paymentTransactions` row against candidate expenses (`scoreExpenseMatch`) and against other transactions for credit-card settlement pairs (`scoreSettlementMatch`), using normalized merchant name (`normalizeMerchant`), date proximity, and amount. Matches above a confidence threshold are presented for one-click **Confirm Match**; everything else needs manual action (**Ignore**, **Unmatch**, **Link Settlement**, or **Create Expense from Transaction**).

Every state-changing action (`confirmMatch`, `ignoreTxn`, `undoIgnore`, `unmatchTxn`, `linkSettlement`, `resolveDuplicate`) writes an entry to `reconciliationActions` via `logAction` — an append-only audit trail, never mutated after the fact.

### Personal-to-Company Classification (Company Review)

Handles the case where a user pays some company-related expenses from a personal
bank/credit-card account that also carries unrelated personal spending. This is
**Phase 1** of a three-phase spec (`~/Desktop/Expense App：Personal-to-Company
Expense MVP Specification.md`) — merchant-learned rules and Company Package export
are deferred to later phases.

An account is opted into this workflow by marking it `ownershipType: 'personal'`
when created in Payment Sources (a checkbox on the create-account form). Only rows
imported under a personal account get classified; company accounts are completely
unaffected — same import pipeline (`commitRows`), no schema change to their rows.

`classifyTransaction` in `src/lib/expenseClassification.js` runs at import time and
is deliberately conservative — this app never auto-decides a final claim, tax
category, or allocation, only defaulting the classification field so review can
happen efficiently:
1. Already linked to a matched Expense → `company_candidate`.
2. Excluded transaction types (card repayments, transfers — the same
   `CREATE_EXPENSE_BLOCKED_TYPES` list `Reconciliation.jsx` already uses) → skipped
   entirely, no classification field set.
3. Otherwise → `needs_accountant_review`. There's no merchant-rule/history table
   yet (Phase 2), so nothing is auto-classified `personal` on a guess — every
   ambiguous row surfaces for a human decision, which is itself what will
   eventually build the Phase 2 rule history.

The **Company Review** page (`/company-review`) groups classified transactions by
merchant with bulk actions — Confirm All as Company, Mark All Personal, Send to
Accountant Review — each showing the transaction count and total before applying
(reusing the existing `ConfirmDialog` pattern, never a silent bulk update).
Expanding a group reveals per-transaction controls: change classification, pick a
quick business-purpose option (+ optional note), and **Create Expense from
Transaction** for unmatched company candidates — adapted directly from
`Reconciliation.jsx`'s `createExpenseFromTxn`.

### Export

- **Excel (`.xlsx`)**: Built client-side with ExcelJS. Columns: Date, Vendor, Amount, Currency, Category, Notes, Receipts (image URLs). Includes per-currency totals row.
- **Receipt ZIP**: Images are downloaded via the `/api/download-receipt` CORS proxy, then packed with JSZip. Files are organised as `YYYY-MM/Category/date_vendor_amount_currency.ext`. Downloads in batches of 6 with progress counter.

### Confirmation Dialogs

All destructive actions use a custom `ConfirmDialog` React component instead of the browser's native `confirm()` (which shows a confusing "Block this pop-up" option on mobile Chrome).

---

## Design System

Established across this app's typography/container/spacing pass (see [CHANGELOG.md](CHANGELOG.md)).

### Typography tokens

CSS custom properties (`--type-display/-page-title/-section-title/-card-title/-body/-body-small/-label/-caption/-amount`, each with `-size`/`-line`/`-weight`) in `App.css` `:root`, with a mobile override block shrinking display/page-title/section-title/amount sizes below 768px. Two fonts: `Questrial` (`--font-brand`, logo wordmark only) and `Work Sans` (`--font-ui`, everything else), loaded via Google Fonts `<link>` in `index.html` with a system-font fallback chain.

Applied via semantic utility classes (`.type-display`, `.type-page-title`, etc.) and baked directly into existing component classes (`.page h2`/`.page h3`, `.hint`, `.lightbox-title`, `.settings-section-title`, `.stat-label`, `.meta-field-label`/`.meta-field-value`) so most of the app inherits correct sizing without per-element classes in JSX.

### Container system

Four opt-in max-width modifiers, combined with the base `.page` class (900px default): `.page-narrow` (720px, single-record/OCR-review flows — Upload, Capture), `.page-reading` (880px, detail/settings pages — Settings), `.page-standard` (1120px, list-shaped pages — Dashboard, Expenses, PaymentSources), `.page-wide` (1280px, the Reconciliation desktop workspace). **Must stay defined after `.page` in the cascade** for the override to win (equal specificity, later wins).

### 12-column dashboard grid

`.dashboard-grid` + `.dashboard-span-4/-6/-8/-12`, for multi-column card layouts. Collapses spans to 6-col behavior below 1024px, single column below 768px. Currently used on Dashboard for the "By Category" (span-4) / "Expenses" (span-8) split.

### Metadata field grid

`.meta-grid` (2 columns desktop, 1 column mobile via `.meta-field`/`.meta-field-label`/`.meta-field-value`), used for label/value detail sections (e.g. Reconciliation's Transaction detail panel).

### Icons

All emoji replaced with `lucide-react` components via the centralized `src/icons.js` map (`ReceiptIcon`, `BankStatementIcon`, `CreditCardIcon`, `WarningIcon`, `MatchedIcon`, nav icons, etc.), each rendered with a shared `ICON_STROKE_WIDTH`.

### Mobile patterns

`.desktop-only`/`.mobile-only` toggle classes at `max-width: 640px`; card-based lists (`.expense-mob-card`, `.capture-cards`) as an alternative to compressed tables at phone widths; 44–48px touch targets; `input, select, textarea { font-size: 16px }` on mobile to prevent iOS Safari auto-zoom.

**`table-layout: fixed` pitfall** (hit twice in this codebase — PDF review table, then transaction detail table): an unspecified column's width can silently collapse to near-zero while a neighbor absorbs the space. Every column needs an explicit percentage width summing to 100%; only genuinely variable-length columns (Description) get `white-space: normal; overflow-wrap: break-word` — everything else uses `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.

---

## Performance

### Firestore IndexedDB Persistence

Firestore is initialised with `persistentLocalCache` and `persistentMultipleTabManager` (Firebase v10 API):

```js
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
```

This writes every Firestore snapshot to the browser's IndexedDB. On subsequent page loads the data is served from the local cache immediately, with any server-side changes applied silently in the background.

### Real-time Listeners (`onSnapshot`)

Every Firestore query in the app (projects, expenses, payment accounts/imports/transactions) uses `onSnapshot` instead of `getDocs`. Combined with `persistentLocalCache`, the first callback fires instantly from IndexedDB on repeat loads, and mutations propagate back to component state automatically — no manual reload calls needed. Each listener is cleaned up via `return unsubscribe` inside `useEffect`.

**Dashboard date filters** are applied entirely in memory — changing the date range does not trigger a new query.

### Loading State Sequence

Every loading phase shows the same `LoadingBar` animated progress component:

1. **Auth initialisation** (`ProtectedRoute` in `App.jsx`)
2. **Project loading** (`ProjectContext`)
3. **Expense/transaction loading** (per-page `onSnapshot`)

On a warm cache, steps 2–3 resolve in milliseconds from IndexedDB.

### Migration Guard

On first load `ProjectContext` runs `migrateExpenses` to backfill `projectId` on legacy expenses, guarded by a `localStorage` flag (`expenses_migrated_{uid}`) so it only runs once per user per browser.

---

## Netlify Configuration (`netlify.toml`)

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[edge_functions]]
  function = "process-receipt"
  path = "/api/process-receipt"

[[edge_functions]]
  function = "download-receipt"
  path = "/api/download-receipt"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

The wildcard redirect enables client-side routing (React Router) on direct URL loads and refreshes.

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env.local with the six VITE_FIREBASE_* variables above
# The GEMINI_API_KEY is only needed for the edge function; set it in Netlify for production.

# Start dev server
npm run dev
```

The local dev server does not run Netlify edge functions. To test AI extraction locally, use the Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

Set `GEMINI_API_KEY` in a `.env` file or via `netlify env:import`.

To bump the release version shown in the app footer, update `"version"` in `package.json` (e.g. `"1.1.0"` → shown as `V1.1`).

---

## Deployment

The app deploys automatically via Netlify's Git integration.

1. Push to `main` → triggers a production build → deploys to production
2. Push to a feature branch → triggers a branch preview build (if enabled) → deploys to a preview URL

When testing a new feature branch that uses Firebase Auth, add the branch preview URL to Firebase → Authentication → Authorized domains before testing Google sign-in.

---

## Data Migration

On first sign-in, `ProjectContext` runs `migrateExpenses` — an idempotent batch operation that sets `projectId` on any expenses saved before multi-project support was added. After running, a `localStorage` flag (`expenses_migrated_{uid}`) prevents it from running again.
