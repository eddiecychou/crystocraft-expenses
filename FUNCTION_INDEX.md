# Function Index

A quick-reference map of every significant function in the codebase, organized by
file, with a one-line description and its definition line. Use this to jump straight
to the right place instead of re-reading whole files. Line numbers drift as files
change — treat them as "was here as of V1.0," and re-grep if a jump misses.

For architecture and data model context, see [TECHNICAL.md](TECHNICAL.md). For why
some of these functions look the way they do, see [LESSONS_LEARNED.md](LESSONS_LEARNED.md).

---

## `src/lib/` — pure logic modules (no React, no Firestore access)

### [duplicateDetection.js](src/lib/duplicateDetection.js)

| Function | Line | Purpose |
|---|---|---|
| `annotateBalanceSequence(rows, tolerance)` | 31 | Walks statement rows in original order, checks each row's reported balance against the running total implied by the previous row + this row's debit/credit. Attaches `balanceSequenceValid`/`expectedBalance`. |
| `classifyFingerprintCollision(candidate, collisionRows, sourceType, candidateImportId)` | 54 | Core duplicate classifier. Returns `{ status, reason, evidence }`. Only an identical `rawRowText` match **across two different imports** auto-confirms; same-import identical text falls through to balance/merchant evidence. |
| `rowSignature(r)` | 149 | Internal — builds a comparison key for a row. |
| `diffTransactionSets(reparsedRows, storedRows)` | 165 | Compares a fresh re-parse of a statement against what's stored; returns counts plus sample `missingRows`/`extraRows` (up to 20 each) for the Verify/Fix-from-PDF flow. |
| `validateStatementTotals({ openingBalance, closingBalance, rows, tolerance })` | 192 | Checks that opening balance + sum of rows reconciles to closing balance. |

### [paymentMatching.js](src/lib/paymentMatching.js)

| Function | Line | Purpose |
|---|---|---|
| `parseCSV(text)` | 12 | Minimal CSV parser (handles quoted fields) — no external dependency. |
| `findColumn(headers, aliases)` | 53 | Internal — resolves a column by trying a list of header-name aliases. |
| `parseStatementDate(raw)` | 65 | Normalizes varied statement date text into `YYYY-MM-DD`. |
| `mapCsvRecords(records, headers)` | 86 | Maps raw CSV rows into the transaction shape using `findColumn` alias detection. |
| `normalizeMerchant(raw)` | 126 | Strips noise (card suffixes, extra whitespace, case) from a raw merchant string for matching. |
| `classifyTransactionType(merchantRaw, direction)` | 146 | Heuristic label (e.g. "Subscription", "ATM Withdrawal") from merchant text + direction. |
| `computeFingerprints({...})` | 172 | Builds the fingerprint string(s) used to detect fingerprint collisions during import. |
| `daysBetween(a, b)` | 179 | Internal — date-diff helper for match scoring. |
| `merchantSimilarity(a, b)` | 184 | Internal — fuzzy string similarity between two normalized merchant names. |
| `scoreExpenseMatch(txn, expense)` | 200 | Scores how well an imported transaction matches a candidate expense (merchant + date + amount). |
| `scoreSettlementMatch(cardTxn, bankTxn)` | 235 | Scores whether a bank debit is the settlement of a given credit-card charge. |
| `classifyReviewCategory(txn, { hasDuplicate })` | 265 | Buckets a transaction into a review category for the Reconciliation queue. |

### [pdfStatementParser.js](src/lib/pdfStatementParser.js)

| Function | Line | Purpose |
|---|---|---|
| `canonicalColumnName(text)` | 83 | Internal — maps a header cell's text to a canonical column name. |
| `detectHeader(line)` | 93 | Internal — decides whether a text line is the table header row. |
| `clusterXs(xs, tolerance)` | 146 | Internal — clusters x-coordinates into column positions (calibrated from data, not header labels — see LESSONS_LEARNED). |
| `resolveColumns(headerCols, sectionLines, tolerance)` | 157 | Internal — resolves final column boundaries for a statement section. |
| `bucketLine(line, columns)` | 248 | Internal — assigns each text item on a line to its column bucket. |
| `findAnchorDate(allText)` | 268 | Internal — locates the statement's reference date, used to infer missing years in row dates. |
| `parseShortDate(text, anchorDate)` | 285 | Internal — parses a short/partial date string using the anchor date for year inference. |
| `parseMoneyText(str)` | 302 | Internal — parses a money string (handles currency symbols, thousands separators, parens-as-negative). |
| `parseSection(lines, columns, anchorDate, pageNumber, balanceMarkers)` | 330 | Internal — parses one page/section's lines into transaction row objects. |
| `parseFallback(lines)` | 458 | Internal — best-effort parse when column detection fails entirely. |
| `extractBalanceMarkersFromRawLines(lines)` | 493 | Internal — pulls opening/closing balance text from statement boilerplate lines. |
| `parsePdfStatement(file)` | 515 | **Entry point.** Loads a PDF via `pdfjs-dist`, extracts text-position data, and returns parsed transaction rows + statement totals. |

---

## `src/` — top-level modules

### [firebase.js](src/firebase.js)
App initialization only — exports `auth`, `db` (with `persistentLocalCache`), `storage`. No named functions.

### [constants.js](src/constants.js)
Exports `CATEGORIES`, `CURRENCIES`, `PAYMENT_METHODS` arrays. No functions.

### [icons.js](src/icons.js)
Re-exports `lucide-react` icons under semantic names (`NavOverviewIcon`, `ReceiptIcon`, `WarningIcon`, etc.) plus `ICON_STROKE_WIDTH`. No functions.

### [receiptStorage.js](src/receiptStorage.js)

| Function | Line | Purpose |
|---|---|---|
| `uploadReceiptImage(file, userId, expenseId, index)` | 45 | Uploads a (already-compressed) receipt image to `receipts/{uid}/{expenseId}/image{n}.{ext}`. |
| `deleteReceiptImage(storagePath)` | 58 | Deletes a receipt image from Storage. |

### [statementStorage.js](src/statementStorage.js)

| Function | Line | Purpose |
|---|---|---|
| `uploadStatementFile(file, userId, importId)` | 10 | Uploads the **original, uncompressed** statement file to `statements/{uid}/{importId}/...` for audit-trail purposes. |
| `deleteStatementFile(storagePath)` | 19 | Deletes a stored statement file. |

### [hooks/useAuthState.js](src/hooks/useAuthState.js)

| Function | Line | Purpose |
|---|---|---|
| `useAuthState()` | 5 | Wraps `onAuthStateChanged` as a `{ user, loading }` hook; drives `ProtectedRoute`. |

### [contexts/ProjectContext.jsx](src/contexts/ProjectContext.jsx)

| Function | Line | Purpose |
|---|---|---|
| `ProjectProvider({ children })` | 52 | Context provider — owns project list, active project (persisted to `localStorage`), and runs the migration guard on mount. |
| `migrateExpenses(uid, projectId)` | 113 | Idempotent one-time backfill of `projectId` onto legacy expenses, guarded by an `expenses_migrated_{uid}` localStorage flag. |
| `persistActiveId(id)` | 123 | Internal — writes the active project id to `localStorage`. |
| `updateProject(id, changes)` | 130 | Optimistic local update + background Firestore write for project edits. |
| `useProject()` | 148 | Hook to consume `ProjectContext` (active project, project list, `selectProject`, `updateProject`, `reloadProjects`). |

Also exports `PROJECT_COLORS` (24 color identities) and `COLOR_KEYS`.

### [App.jsx](src/App.jsx)

| Function | Line | Purpose |
|---|---|---|
| `ProtectedRoute({ children })` | 15 | Route guard — shows `LoadingBar` while auth resolves, redirects to `/login` if signed out. |
| `App()` | 22 | Root component — `BrowserRouter` + `ProjectProvider` + all route definitions. |

---

## `src/components/`

| File | Function | Purpose |
|---|---|---|
| [Layout.jsx](src/components/Layout.jsx) | `Layout()` | Desktop sidebar + mobile bottom nav/More sheet + logout. Injects the active project's identity color as a border accent only (not the app theme). |
| [ConfirmDialog.jsx](src/components/ConfirmDialog.jsx) | `ConfirmDialog({ message, onConfirm, onCancel, confirmLabel, confirmClassName })` | In-app confirmation modal replacing native `confirm()`. |
| [LoadingBar.jsx](src/components/LoadingBar.jsx) | `LoadingBar({ label })` | Shared animated indeterminate progress bar used for every loading state app-wide. |
| [ProjectBanner.jsx](src/components/ProjectBanner.jsx) | `ProjectBanner()` | Shows the active project's name/dot at the top of every page. |

---

## `src/pages/`

### [Login.jsx](src/pages/Login.jsx)

| Function | Line | Purpose |
|---|---|---|
| `handleSubmit(e)` | 20 | Email/password sign-in or sign-up, branching on `mode`. |
| `handleGoogle()` | 41 | Google OAuth via `signInWithPopup`. |
| `handleForgotPassword()` | 58 | Sends a password-reset email. |
| `switchMode(m)` | 69 | Toggles between sign-in/sign-up/forgot-password views. |

### [Dashboard.jsx](src/pages/Dashboard.jsx)

| Function | Line | Purpose |
|---|---|---|
| `isoDate(d)` | 10 | Formats a `Date` as `YYYY-MM-DD`. |
| `firstOfMonth()` | 12 | Returns the first day of the current month as `YYYY-MM-DD`. |
| `setPreset(preset)` | 56 | Applies a date-range preset (This Month / Last Month / This Year / All). |

Renders the `.dashboard-grid` (By Category `span-4` / Expenses `span-8`) and the KPI `.stat-row`.

### [Capture.jsx](src/pages/Capture.jsx)
No functions — a pure dispatcher component (three link cards routing to Upload / Payment Sources). See its header comment for why it exists (mobile bottom-nav slot capacity).

### [Upload.jsx](src/pages/Upload.jsx)

| Function | Line | Purpose |
|---|---|---|
| `readFiles(rawFiles)` | 32 | Reads selected/dropped files into memory, compressing images client-side. |
| `handleDrop(e)` | 67 | Dropzone drop handler. |
| `handleChange(e)` | 73 | File-input change handler. |
| `processFiles(itemsOverride)` | 78 | Sequentially POSTs each file to `/api/process-receipt` for AI extraction. **Must be called as `() => processFiles()`, not passed bare** — see LESSONS_LEARNED. |
| `reparseOne(id)` | 104 | Re-runs extraction for a single result card ("+ Scan More" / re-scan). |
| `removeFile(id)` | 132 | Removes a file from the pre-extraction list. |
| `addManual()` | 136 | Adds a blank manual-entry result card. |
| `update(id, field, value)` | 141 | Updates one field on one result card, clearing its validation error. |
| `remove(id)` | 153 | Removes a result card (with confirmation). |
| `openAttach(id)` | 163 | Opens the hidden file input to attach an image to an existing result card. |
| `handleAttach(e)` | 168 | Handles the attached file for a result card. |
| `handleScanMore(e)` | 189 | Adds and processes additional files after initial extraction. |
| `saveAll()` | 231 | Validates and writes all result cards to Firestore + Storage. |
| `validFile(f)` | 522 | Module-level — file-type/extension allowlist check. |
| `toBase64(file)` | 528 | Module-level — reads a file as a base64 data URL. |
| `bufToBase64(buffer)` | 533 | Module-level — converts an `ArrayBuffer` to base64. |
| `compressImage(file)` | 543 | Module-level — resizes to max 2400px and re-encodes as JPEG 93% via `OffscreenCanvas`. |
| `preprocessForGemini(item)` | 575 | Module-level — builds the greyscale, auto-leveled PNG sent to Gemini (see TECHNICAL.md's two-image pipeline). |
| `applyOCRPreprocess(data)` | 615 | Module-level — pixel-level greyscale + histogram auto-levels. |

### [Expenses.jsx](src/pages/Expenses.jsx)

| Function | Line | Purpose |
|---|---|---|
| `Lightbox({ expenseId, images, onClose, onAdd, onDelete, uploading })` | 15 | Full-size receipt image/PDF viewer overlay component. |
| `askConfirm(message, onConfirm)` | 75 | Opens the shared `ConfirmDialog`. |
| `focusFirstError(errs)` | 109 | Scrolls to and focuses the first invalid field, checking both the desktop and mobile-card copies of the edit form (only one is visible via CSS at a time). |
| `saveEdit()` | 116 | Validates and persists an in-place expense edit. |
| `deleteExpense(id)` | 136 | Deletes an expense (with confirmation). |
| `openLightbox(e)` | 142 | Opens the `Lightbox` for an expense's images. |
| `handleAddImage(e)` | 146 | Uploads and attaches a new receipt image to an existing expense. |
| `handleDeleteImage(img)` | 165 | Removes a receipt image from an expense (with confirmation). |
| `startEdit(e)` | 175 | Enters edit mode for a row. |
| `upd(field, value)` | 176 | Updates one field of the in-progress edit. |
| `exportExcel(rows)` | 181 | Builds and downloads the `.xlsx` export via ExcelJS. |
| `exportZip(rows)` | 234 | Downloads all receipt images (via the download-receipt proxy) and packs them into a ZIP via JSZip, batched 6 at a time. |
| `sanitizeVendor(v)` | 301 | Module-level — strips filesystem-unsafe characters from a vendor name for ZIP filenames. |
| `today()` | 305 | Module-level — today's date as `YYYY-MM-DD`. |
| `triggerDownload(blob, filename)` | 307 | Module-level — programmatically triggers a browser file download. |

### [PaymentSources.jsx](src/pages/PaymentSources.jsx) — largest page, account + import + duplicate-review workspace

| Function | Line | Purpose |
|---|---|---|
| `fetchWithTimeout(url, options, timeoutMs)` | 25 | Module-level — `AbortController`-based fetch timeout (30s default), wraps every `/api/download-receipt` call so one stalled request can't hang a batch operation. |
| `createAccount()` | 132 | Creates a new bank/credit-card account. |
| `commitRows(mapped, account, file, sourceType, statementTotals, reprocessImportId)` | 162 | **Core import writer.** Runs duplicate classification per row, writes every row unconditionally to `paymentTransactions`, uploads the original file via `statementStorage.js`, and marks the import `error` (not stuck `processing`) on any failure. |
| `resolveDuplicate(txn, newStatus)` | 375 | Applies Keep as Separate / Confirm Duplicate to a flagged transaction; restores `status: 'unmatched'` if it was previously `ignored`. |
| `dismissDuplicateWarning(txn)` | 391 | Marks a duplicate warning as reviewed without changing its verdict. |
| `renderDuplicateStatus(txn, imp)` | 411 | Shared render function for the duplicate-review UI (badge + reason + actions when expanded, collapsed "Resolved · Change" when already resolved) — used by both the desktop table cell and the mobile card. |
| `verifyImportAgainstSource(imp)` | 461 | Re-downloads and re-parses the stored original file, diffs against what's stored (`diffTransactionSets`). |
| `verifyAllImports()` | 511 | Runs `verifyImportAgainstSource` across every import for the active account. |
| `unlinkTransaction(txn)` | 538 | Detaches a transaction from its matched expense. |
| `startEditTxn(txn)` | 561 | Enters inline edit mode for a transaction row. |
| `saveEditTxn(txn)` | 566 | Persists an inline transaction edit. |
| `deleteTxn(txn)` | 604 | Deletes a transaction (with confirmation). |
| `deleteImport(imp)` | 615 | Deletes an entire import and its transactions (with confirmation). |
| `openAttachOriginal(imp)` | 642 | Opens the file picker to attach an original file to an import that's missing one. |
| `handleAttachOriginal(e)` | 648 | Uploads the attached original file for a pre-existing import. |
| `loadPdfPreview(file, accountId, remainingQueue)` | 664 | Parses a PDF client-side and opens the review panel before committing. |
| `advancePdfQueue(queue, accountId)` | 693 | Moves to the next file when multiple PDFs were selected at once. |
| `handleFileSelected(e)` | 699 | Entry point for statement file selection — routes CSV straight to `commitRows`, PDF to `loadPdfPreview`. |
| `togglePreviewRow(i)` | 735 | Toggles skip/include on one row in the PDF review table before import. |
| `confirmPdfImport()` | 739 | Commits the reviewed PDF rows via `commitRows`; clears `pdfPreview` afterward so Verify/Fix buttons re-enable (see LESSONS_LEARNED — this was previously missing, breaking every button after one reprocess). |
| `reprocessFromStoredPdf(imp)` | 801 | "Fix from Stored PDF" — re-downloads and re-parses an import's original file for correction. |
| `skipPdfPreview()` | 836 | Skips the current PDF in a multi-file queue without importing it. |

### [Reconciliation.jsx](src/pages/Reconciliation.jsx) — transaction matching workspace

| Function | Line | Purpose |
|---|---|---|
| `logAction(txn, expenseId, actionType, beforeState, afterState)` | 77 | Writes one entry to the append-only `reconciliationActions` log. |
| `runMatching()` | 91 | Scores all unmatched transactions against candidate expenses/settlements using `paymentMatching.js` scorers; populates the review queue. |
| `categoryFor(txn)` | 149 | Buckets a transaction for queue grouping/display. |
| `unresolvedDuplicateFlag(txn)` | 154 | Whether a transaction has a duplicate flag still awaiting resolution. |
| `shortReasonFor(txn)` | 161 | One-line match/no-match reason shown in the queue row. |
| `needsAction(txn)` | 169 | Whether a transaction requires the user to do something. |
| `isException(txn)` | 176 | Whether a transaction is in an exception/error state. |
| `confirmMatch(txn, expenseIdOverride)` | 242 | Confirms a transaction-to-expense match; logs the action. |
| `ignoreTxn(txn)` | 271 | Marks a transaction as ignored (not a business expense); logs the action. |
| `undoIgnore(txn)` | 278 | Reverts an ignore; logs the action. |
| `unmatchTxn(txn)` | 289 | Removes a confirmed match; logs the action. |
| `markAs(txn, transactionType)` | 318 | Manually sets a transaction's type classification. |
| `createExpenseFromTxn(txn, { force })` | 329 | Creates a new expense record directly from an unmatched transaction. |
| `linkSettlement(card, bankTxn)` | 367 | Links a credit-card charge to its settling bank debit; logs the action. |
| `resolveDuplicate(txn, newStatus)` | 390 | Same duplicate-resolution logic as in PaymentSources, surfaced in the Reconciliation detail panel. |
| `dismissDuplicateWarning(txn)` | 402 | Same as in PaymentSources — dismiss without changing verdict. |

### [Settings.jsx](src/pages/Settings.jsx)

| Function | Line | Purpose |
|---|---|---|
| `createProject()` | 19 | Creates a new project. |
| `saveEdit()` | 32 | Persists a project rename/recolor. |
| `deleteProject(p)` | 40 | Deletes a project (with confirmation); reassigns active project if needed. |
| `startEdit(p)` | 54 | Enters edit mode for a project card. |
| `ColorPicker({ value, onChange })` | 144 | Swatch grid for picking one of the 24 project color identities. |

### [Export.jsx](src/pages/Export.jsx) — **not routed in `App.jsx`, currently orphaned**

| Function | Line | Purpose |
|---|---|---|
| `downloadExcel()` | 8 | Standalone Excel export utility, superseded by `Expenses.jsx`'s `exportExcel`. Kept but unreachable from the UI. |

---

## `netlify/edge-functions/`

| File | Purpose |
|---|---|
| [process-receipt.js](netlify/edge-functions/process-receipt.js) | Deno edge function. Receives a receipt image/PDF, optionally runs Cloud Vision OCR first (`callVisionOCR`, when `GOOGLE_VISION_API_KEY` is set), then calls Gemini (`gemini-2.5-flash` → `gemini-2.5-pro` fallback) to extract structured JSON fields. |
| [download-receipt.js](netlify/edge-functions/download-receipt.js) | Deno edge function. CORS proxy — accepts `{ url }`, fetches a Firebase Storage file server-side, returns the raw bytes with permissive CORS headers. Used generically for both receipt images and statement files despite the name. |

## `netlify/functions/`

| File | Purpose |
|---|---|
| [export-excel.js](netlify/functions/export-excel.js) | Legacy Node.js function, kept for routing compatibility. Excel export now happens client-side in `Expenses.jsx`. |
