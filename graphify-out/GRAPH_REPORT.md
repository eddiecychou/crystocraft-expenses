# Graph Report - Expense Tool V1  (2026-09-10)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 498 nodes · 1205 edges · 19 communities (17 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.79)
- Token cost: 1,023 input · 1,848 output

## Graph Freshness
- Built from commit: `bc12a4a7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Routing and Core UI
- Development Documentation
- Invoice Import Mapping
- Duplicate Detection
- Package Dependencies
- Expense Classification Review
- Payment Matching Logic
- Reconciliation Actions
- Expense Management UI
- Upload OCR Preprocessing
- PDF Statement Parsing
- Project Membership Settings
- Income Record Management
- Bank Transaction Records
- Invoice Processing Function
- Reporting and CSV Export
- Receipt Processing Function
- Login Authentication

## God Nodes (most connected - your core abstractions)
1. `useProject()` - 31 edges
2. `Reconciliation()` - 29 edges
3. `PaymentSources()` - 28 edges
4. `CompanyReview()` - 24 edges
5. `Technical Documentation` - 23 edges
6. `react` - 22 edges
7. `Expenses()` - 21 edges
8. `Function Index` - 20 edges
9. `Invoices()` - 19 edges
10. `Upload()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `Matching Engine (rule-based scoring)` --semantically_similar_to--> `Extraction Validation`  [INFERRED] [semantically similar]
  payment-reconciliation-spec-v1.md → TECHNICAL.md
- `Duplicates Must Surface, Never Silently Skip` --conceptually_related_to--> `Bank Transactions View`  [AMBIGUOUS]
  LESSONS_LEARNED.md → TECHNICAL.md
- `Payment-Proof Automation` --conceptually_related_to--> `Company Package Export`  [INFERRED]
  statement-reconciliation-hkd-audit-pack-brief.md → TECHNICAL.md
- `Document / Settlement / Ledger Amount Layers` --conceptually_related_to--> `FinanceRecord Model`  [INFERRED]
  statement-reconciliation-hkd-audit-pack-brief.md → TECHNICAL.md
- `Settings()` --indirect_call--> `projectCategories()`  [INFERRED]
  src/pages/Settings.jsx → src/constants.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **AI Extraction Validation Flow** — netlify_edge_functions_process_receipt, netlify_edge_functions_process_invoice, src_components_extractionwarning, src_lib_duplicatedetection, technical_extraction_validation, lessons_learned_deterministic_invariant [EXTRACTED 0.85]
- **Three-Tier Statement Parsing Fallback** — src_lib_pdfstatementparser, src_lib_geministatementparser, netlify_edge_functions_process_statement_text, technical_pdf_statement_parsing [EXTRACTED 0.85]
- **Finance / Bookkeeping Center Repositioning MVP Sequence** — technical, changelog, technical_financerecord_model, technical_income, technical_account_codes, technical_bank_transactions, technical_operation_center_sync, technical_month_end_report [EXTRACTED 0.90]

## Communities (19 total, 1 thin omitted)

### Community 0 - "Routing and Core UI"
Cohesion: 0.07
Nodes (71): jszip, react, react-router-dom, App(), ProtectedRoute(), AccountCodePicker(), ConfirmDialog(), ExtractionWarning() (+63 more)

### Community 1 - "Development Documentation"
Cohesion: 0.08
Nodes (37): Changelog, Expense Operations Center — Development Playbook, Function Index, Lessons Learned, A Deterministic Invariant Validates an AI Extraction, Firestore Rules Cannot Filter a List Query, PDF Text Baseline Redaction Geometry, Sequential Multi-Document Writes Need a Batch (+29 more)

### Community 2 - "Invoice Import Mapping"
Cohesion: 0.07
Nodes (31): AMOUNT_ALIASES, CODE_ALIASES, COUNTERPARTY_ALIASES, CURRENCY_ALIASES, DATE_ALIASES, findColumn(), jesLegacyDocId(), mapDocumentCsvRecords() (+23 more)

### Community 3 - "Duplicate Detection"
Cohesion: 0.09
Nodes (34): Duplicates Must Surface, Never Silently Skip, storage, annotateBalanceSequence(), classifyFingerprintCollision(), diffTransactionSets(), DUPLICATE_STATUS_LABELS, rowSignature(), validateStatementTotals() (+26 more)

### Community 4 - "Package Dependencies"
Cohesion: 0.06
Nodes (33): dependencies, exceljs, dependencies, browserslist, exceljs, firebase, jszip, lucide-react (+25 more)

### Community 5 - "Expense Classification Review"
Cohesion: 0.09
Nodes (21): BUSINESS_PURPOSE_OPTIONS, CLASSIFICATION_EXCLUDED_TYPES, CLASSIFICATION_LABELS, computeVisibleToMembers(), merchantRuleDocId(), maskPdfPages(), chunk(), CLASSIFICATION_BADGE_CLASS (+13 more)

### Community 6 - "Payment Matching Logic"
Cohesion: 0.11
Nodes (28): RFC-4180, Amount+Currency Alone Is Not Enough Evidence, classifyReviewCategory(), COLUMN_ALIASES, computeFingerprints(), CREATE_EXPENSE_BLOCKED_TYPES, daysBetween(), findColumn() (+20 more)

### Community 7 - "Reconciliation Actions"
Cohesion: 0.17
Nodes (20): Reconciliation(), categoryFor(), confirmInvoiceMatch(), confirmMatch(), createExpenseFromTxn(), dismissDuplicateWarning(), ignoreTxn(), isException() (+12 more)

### Community 8 - "Expense Management UI"
Cohesion: 0.16
Nodes (16): Expenses(), askConfirm(), deleteExpense(), exportExcel(), exportZip(), focusFirstError(), handleAddImage(), handleDeleteImage() (+8 more)

### Community 9 - "Upload OCR Preprocessing"
Cohesion: 0.17
Nodes (16): applyOCRPreprocess(), bufToBase64(), compressImage(), preprocessForGemini(), toBase64(), Upload(), handleAttach(), handleChange() (+8 more)

### Community 10 - "PDF Statement Parsing"
Cohesion: 0.19
Nodes (18): parseStatementRowsWithGemini(), bucketLine(), canonicalColumnName(), clusterXs(), COLUMN_LABELS, DATE_HEADER_NAMES, detectHeader(), extractBalanceMarkersFromRawLines() (+10 more)

### Community 11 - "Project Membership Settings"
Cohesion: 0.15
Nodes (7): ProjectProvider(), updateProject(), Settings(), addListItem(), removeListItem(), saveEdit(), toggleOperationCenterSync()

### Community 12 - "Income Record Management"
Cohesion: 0.16
Nodes (9): uploadDocumentFile(), Income(), handleChange(), handleDrop(), processFiles(), readFiles(), saveAll(), toBase64() (+1 more)

### Community 13 - "Bank Transaction Records"
Cohesion: 0.22
Nodes (12): RECORD_TYPES, resolveMatchedRecord(), reconciliationStatusLabel(), isProjectOwner(), paymentTransactionsQuery(), BankTransactions(), setPreset(), firstOfMonth() (+4 more)

### Community 14 - "Invoice Processing Function"
Cohesion: 0.38
Nodes (10): callGemini(), callVisionOCR(), checkArithmetic(), config, emptyResult(), extractionPrompt(), fetchWithTimeout(), handler() (+2 more)

### Community 15 - "Reporting and CSV Export"
Cohesion: 0.24
Nodes (11): recordReconciliationStatus(), counterpartyOf(), Export(), filteredByKind(), generateReport(), csvRows(), setPreset(), firstOfMonth() (+3 more)

### Community 16 - "Receipt Processing Function"
Cohesion: 0.47
Nodes (8): callGemini(), callVisionOCR(), checkArithmetic(), config, fetchWithTimeout(), handler(), isGrounded(), json()

## Ambiguous Edges - Review These
- `Duplicates Must Surface, Never Silently Skip` → `Bank Transactions View`  [AMBIGUOUS]
  LESSONS_LEARNED.md · relation: conceptually_related_to

## Knowledge Gaps
- **70 isolated node(s):** `FIELD_LABELS`, `INCOME_CATEGORIES`, `PAYMENT_METHODS`, `ProjectContext`, `app` (+65 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 135 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Duplicates Must Surface, Never Silently Skip` and `Bank Transactions View`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `useProject()` connect `Routing and Core UI` to `Invoice Import Mapping`, `Duplicate Detection`, `Expense Classification Review`, `Payment Matching Logic`, `Reconciliation Actions`, `Expense Management UI`, `Upload OCR Preprocessing`, `Project Membership Settings`, `Income Record Management`, `Bank Transaction Records`, `Reporting and CSV Export`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **Why does `Function Index` connect `Development Documentation` to `Routing and Core UI`, `Invoice Import Mapping`, `Duplicate Detection`, `Expense Classification Review`, `Payment Matching Logic`, `PDF Statement Parsing`, `Bank Transaction Records`, `Invoice Processing Function`, `Receipt Processing Function`?**
  _High betweenness centrality (0.120) - this node is a cross-community bridge._
- **Why does `Reconciliation()` connect `Reconciliation Actions` to `Routing and Core UI`, `Bank Transaction Records`, `Payment Matching Logic`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Reconciliation()` (e.g. with `isException()` and `needsAction()`) actually correct?**
  _`Reconciliation()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `CompanyReview()` (e.g. with `groupNeedsAttention()` and `groupSentToAccountant()`) actually correct?**
  _`CompanyReview()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `FIELD_LABELS`, `INCOME_CATEGORIES`, `PAYMENT_METHODS` to the rest of the system?**
  _70 weakly-connected nodes found - possible documentation gaps or missing edges._