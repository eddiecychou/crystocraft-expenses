# Parsing Pipeline Plan — Shared First, Profiles Only If Needed

> **Status: V1.2 bank-statement reading route implemented locally, not deployed
> or tested against a signed-in real scanned statement.** Receipt/invoice PDF
> changes, shared diagnostics across all modules, and parser profiles remain
> proposals.
> This plan covers bank/card statements, receipts, invoices, purchase orders,
> and other income documents. It builds on the current import and review flows
> described in [TECHNICAL.md](TECHNICAL.md). The account-specific profile design
> in [STATEMENT-PARSER-ARCHITECTURE.md](STATEMENT-PARSER-ARCHITECTURE.md) remains
> a later option, not the starting point.

## Recommendation

Build one shared **document reading and evidence layer**, followed by a parser
appropriate to the document type. Route by observed file properties and
validated results. Keep financial interpretation and review rules specific to
statements, receipts, invoices, purchase orders, and income documents.

“Global” means one versioned engine and common quality checks for every
customer. It does **not** mean training on customer files or applying one
customer's corrections to other accounts.

### Preserve the working receipt-image route

The receipt image route is the strongest existing pattern to extend. The
browser corrects camera orientation, limits image dimensions, and makes a
high-contrast copy for reading. When the Vision key is configured and OCR
returns text, Vision transcribes that copy and Gemini extracts fields from
the transcript alone. This separates reading from interpretation and makes
the extracted vendor and total checkable against the transcript. The user
still reviews the proposed fields.

Do not replace this route merely to unify code. Reuse its **sequence** for
new scanned-document paths, but add position-aware OCR for statements,
because transaction rows and debit/credit columns need geometry that a
receipt's vendor/date/total extraction does not. First measure the receipt
route as a baseline and confirm which reader actually handled each live file;
the current fallback does not record whether Vision or Gemini transcribed it.

## What the app does today, and the gaps

| Input | Current route | Main gap |
|---|---|---|
| Bank/card statement CSV | Local header mapping; X Transfer has a dedicated mapper | Header coverage varies; no OCR needed. |
| Digital statement PDF | Browser `pdfjs` text and positions, column parser, then line parser; Gemini text fallback only if **zero** rows | A partial or wrong nonzero result does not trigger fallback. Opening/closing balance checks may be unavailable; matching totals alone do not prove every row was found. |
| Scanned statement PDF | Browser finds no text and stops | No OCR route. The current position-based parser cannot consume a plain OCR transcript unchanged. |
| Receipt image | Optional Cloud Vision OCR, otherwise Gemini transcription; Gemini extracts fields | OCR geometry is discarded. Vision availability in a deployed environment has not been verified here. |
| Receipt PDF | Full PDF goes directly to Gemini | A digital text layer is unused; no independent transcript for field grounding. |
| Invoice/PO/income image | Same Vision/Gemini pattern as receipts | OCR geometry is discarded; validation can only check some fields. |
| Invoice/PO/income PDF | Full PDF goes directly to Gemini | Digital text layer and independent grounding are unused. |

Other weaknesses across routes:

- The statement Gemini request sends only the first 30,000 text characters and
  asks for up to 4,096 output tokens. Long statements can lose later pages or
  rows. A single call is not a safe unit of work for a long document.
- A local statement parser can return a plausible subset of rows. The current
  fallback condition is row count zero, not evidence of completeness. A
  matching balance may still hide equal missing debits and credits.
- Receipt/invoice validation is advisory. When no subtotal or OCR transcript
  exists, the current checks may be unavailable. A model returning an empty
  answer can produce a manual-entry card without a clear failure category.
- The three AI endpoints verify sign-in, but do not currently receive and
  authorize a project/account context. They also have no shared per-customer
  usage budget or consistent parsing diagnostics.
- File progress is most detailed in statement import. Receipt and document
  batches report a file counter, not the active reading/OCR/extraction/review
  stage. A browser tab closing mid-run loses in-memory work.

These are code-path findings, not a confirmed diagnosis of Tiffany's PDF.
Her document type and failure stage still need a consented test or safe
diagnostics.

## Target pipeline

```text
User chooses a module and file
  -> inspect type, page count, size, text-layer quality, and image quality
  -> build per-page evidence: text tokens, reading order, positions,
     source method, and available OCR confidence
  -> choose module-specific parser
  -> validate completeness and financial invariants
  -> if evidence is insufficient, try a bounded fallback on the affected
     pages/sections and compare candidate results
  -> show a focused review; save only after user confirmation
```

The module determines the **meaning** of the document; the shared reader
determines **how to obtain trustworthy text**. A receipt must never silently
become a statement because its layout resembles a table. A wrong-document
message should let the user choose the correct module.

### Shared evidence contract

Normalize `pdfjs` text items and Cloud Vision's word/paragraph boxes into
one in-memory per-page structure: page dimensions, token text, normalized
bounding boxes, reading order, reading method, and OCR confidence where
available. Keep the original page number and source spans for every field or
transaction row. Geometry from OCR needs to be retained and tested: the
existing statement parser expects PDF-specific lines and x/y coordinates, so
it needs an adapter and calibration for OCR, not merely an OCR string.

Do not store transcripts, images, amounts, or merchant names in operational
diagnostics. Source files continue to follow the existing reviewed-import
storage path. A new cloud route needs clear user disclosure because its page
image or extracted text leaves the browser.

### Routing by document

| Document | First choice | Escalation when quality checks fail |
|---|---|---|
| Statement CSV | Local mapper | Clear column-mapping error; keep all source rows visible. |
| Digital statement PDF | Local position-based parser | Re-read low-quality pages/sections; Gemini on bounded text sections if cloud assistance is enabled. Compare candidates; never silently merge or replace rows. |
| Scanned statement PDF | Render pages locally, then OCR each page through a bounded call if cloud OCR is enabled | Reconstruct table from OCR boxes; use Gemini on affected sections only when the table remains ambiguous. Otherwise offer CSV/manual recovery. |
| Receipt image | Cloud Vision OCR; Gemini converts evidence into fields | Gemini image transcription if Vision is unavailable or unusable. |
| Receipt PDF | Browser text extraction if usable; Gemini extracts fields from text | Render/OCR only unreadable pages; Gemini sees the page only when necessary. |
| Invoice/PO/income image or PDF | Same reading route as receipt | Gemini extracts document-specific fields; retain source spans for validation. |

Cloud OCR for scanned statements requires rendering PDF pages to supported
images (or a separate asynchronous PDF OCR service). The existing Vision
`images:annotate` call accepts images, not the whole PDF. Set explicit page,
pixel, file-size, and per-call limits before building this route. Process a
small number of pages per request so one 12-file batch cannot become one
long-running edge call.

### Validation and review

- **Statements:** check parsed-row count against detected transaction-like
  rows, page coverage, missing fields, duplicate-looking rows, running-balance
  sequence, and opening + signed movements = closing where those printed
  balances exist. Treat unavailable checks as *unverified*, not *passed*.
  Preserve every candidate source row for review; duplicate detection
  annotates rather than drops imported transactions.
- **Receipts:** ground vendor/date/total in source text or boxes, and check
  subtotal + tax + service charge when printed. Identify conflicting total
  labels such as subtotal versus amount paid.
- **Invoices/POs/income:** ground number, counterparty, date, amount, and
  currency; apply arithmetic only when the source actually has a compatible
  breakdown. Keep document-kind-specific prompts and validation.
- **All:** mark each result as `ready for review`, `needs attention`, or
  `could not verify`, with concrete reasons. No numerical confidence score
  should be shown unless calibrated against a representative test set.
  A clean result still requires a human confirmation before a ledger write.

The review screen should start with “N rows found” for statements or the
key extracted fields for other documents. Show counts and highlight only
missing, conflicting, or unverified items. Keep the full source preview and
editable rows available on demand. Do not force customers through every
unflagged statement row individually.

## Delivery sequence and verification gates

1. **Baseline and diagnostics.** Define a consented, anonymized test set
   covering digital/scanned PDFs, short/long statements, multiple banks,
   receipt photos/PDFs, invoices, POs, and income notices. Record route,
   page count, text-layer presence, row/field coverage, validation outcome,
   elapsed stage, and safe failure code. Reproduce a Tiffany-like failure
   without exposing her document to the app owner. Verify that diagnostics
   contain no source content.
2. **Shared reader.** Add the evidence contract and digital-PDF text path
   first. Migrate receipt and invoice PDFs to text-first extraction while
   retaining the current direct-PDF route as a reversible fallback. Verify
   same or better field accuracy and page references on the test set.
3. **Statement completeness and bounded AI.** Keep the current local parser,
   add checks for suspicious partial results, and split long text into
   page/section requests with stable row ordering and a final reconciliation
   pass. A fallback must report an error if it times out or returns malformed
   data. Verify no pages/rows are silently truncated.
4. **Scanned-statement OCR.** Render selected pages locally and send images
   to Vision in small authenticated calls. Preserve OCR geometry, adapt the
   statement parser, and route unresolved sections to Gemini only when
   enabled. Verify row recovery, dates, debit/credit direction, balances,
   image quality failures, cost/latency, and page limits with real scans.
5. **Unified review and operations.** Reuse one status vocabulary across
   modules: reading, OCR, interpreting, checking, review, saved, failed.
   Show current file/page and actionable errors. Keep per-file attempts and
   retry only failed files/pages. Enforce project authorization, cloud-use
   choice, and request budgets at the edge. Verify interruption and retry
   behavior with a 12-file test batch.
6. **Controlled rollout.** Enable the new route for a small group, compare
   candidate outputs against the existing route without changing saved
   records, then gradually activate it. Version the global parser and retain
   an immediate route rollback. Do not promote any one customer's fixes
   globally without regression tests.

Success means more documents reach a reviewable result, missing rows/fields
are detected before saving, the user can tell what is happening, and review
time stays low. Measure those outcomes separately by document type and by
digital versus scanned source. A build or login-page smoke test does not
establish parsing accuracy; this plan needs representative signed-in tests.

## When account-specific parsing becomes justified

Do **not** build company-specific profiles in the first delivery. After the
shared pipeline has been measured, introduce a profile only when the same
account's layout repeatedly defeats the global route, a small layout rule
fixes it, and the rule passes that account's samples without lowering quality
elsewhere. Scope it to `projectId + paymentAccountId`, version it, and keep
rollback. Never learn a shared rule automatically from private customer data.

This is a decision gate, not a commitment to maintain per-company parsers.
