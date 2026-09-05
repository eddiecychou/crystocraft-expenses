# Lessons Learned

Non-obvious bugs, dead ends, and decisions from building Expense Operations Center
(formerly Expense Organiser), kept here so the reasoning isn't lost to git history.
Each entry says what happened, why it matters, and how to apply it going forward.

---

## A recurring series needs chronological pairing, not per-item nearest-match

Fixing the tiebreaker for recurring same-amount charges (previous entry)
wasn't the whole story. A subscription's bill is often dated relative to a
*billing cycle*, not the charge itself — e.g. billed at cycle-end for a
charge that landed at cycle-start, a consistent ~2-4 week lag. With several
months of the same charge and several months of the same bill all sitting
within a plausible date range of each other, "closest absolute date" per
transaction can still grab the wrong cycle's expense, independently of any
other transaction's pick.

**Why:** Matching a whole recurring series is fundamentally a sequence
problem, not a series of independent point-lookups. If the offset between
charge and bill is systematic, the RELATIVE order of both series is what's
reliable, not the absolute date gap of any one pairing in isolation.

**How to apply:** `runMatching` in `Reconciliation.jsx` now groups
transactions by (merchant, amount, currency) and, only when a group's
count of transactions exactly equals the count of similarly-matching
expenses (the strongest available signal neither side has a gap — e.g. a
missing receipt for one cycle), sorts both by date and pairs them
positionally: 1st with 1st, 2nd with 2nd. Mismatched-count groups
deliberately fall through to the independent nearest-date scoring instead
of guessing which position in an incomplete series is missing. The
merchant grouping key must use the same fuzzy `merchantSimilarity` check
`scoreExpenseMatch` itself uses (exported for this reason) — a
transaction's merchant text is rarely byte-identical to how the expense's
vendor was entered ("CSL MOBILE LIMITED 168 HONG KONG HK" vs. "CSL
Mobile"), so an exact-string group key silently never fires on real data.

---

## A PDF text line's y is its baseline, not its visual top — pad asymmetrically

Building visual PDF redaction (`src/lib/pdfRedaction.js` + the `maskRect`
geometry in `src/lib/pdfStatementParser.js`), the first version padded a
row's mask box by a small, symmetric ±3pt around each line's `y` from
pdf.js. Visually verified against a rendered redacted page: the row's own
text was still clearly visible peeking out both above and below the black
box.

**Why:** `item.transform[5]` (what this codebase calls a line's `y`) is the
text's **baseline** — the line glyphs sit *on*, not their bounding box. A
glyph's ascender/cap-height commonly extends 7-9pt above the baseline for a
typical 9-11pt statement font, while descenders (g, j, p, q, y) only dip
2-4pt below it. A symmetric pad sized for "a little extra margin" badly
under-covers the top and only barely covers the bottom.

**How to apply:** Any mask/highlight/crop box derived from pdf.js line
positions needs asymmetric padding — generously more above the baseline
than below (this codebase uses +10pt above / -4pt below, safe for fonts up
to ~13pt, which covers effectively all statement body text). More broadly:
this is exactly why the visual verification step in the plan for this
feature existed — the math looked reasonable and the code had no bugs by
inspection; only rendering the actual output caught it.

---

## A classification filter on structured data doesn't protect the raw source file

Company Package Export (Phase 3) filters the expense-register/CSVs by
classification, excluding Personal by default — but it also bundled the
**entire original statement file** for any import with at least one included
transaction. A personal account's statement mixes personal and company
charges in one file; attaching it whole exposes every personal transaction
on it regardless of how carefully the structured export filters, defeating
the entire point of the classification system. This is exactly the manual
workaround Eddie's previous bookkeeper had to do by hand (hiding personal
lines before handing statements to an auditor).

**How to apply:** When an export bundles both structured, filterable data
AND a raw source document, check whether the raw document can *itself*
contain the excluded data. If so, either omit it (what this app does now —
personal-account statements are excluded from Company Package exports
entirely, with a `.txt` note explaining why) or regenerate a redacted
version — never assume filtering the derived/structured copy is sufficient
protection when the original file is bundled alongside it unfiltered.

---

## A cross-document get() rule needs its target pinned by the query's own filter

Refines the entry below: it's not just that a list query needs a `where`
clause *somewhere* — when the rule resolves a cross-document reference via
`get(/…/projects/$(resource.data.projectId))`, Firestore can only prove
that safe for an entire list query when `projectId` (the field the `get()`
path depends on) is itself constrained to one known value by the query's
own `where()` clause. A query filtered only by `importId`, `paymentAccountId`,
or `settlementGroupId` — even though `projectId` happens to be constant
across every real matching document — doesn't give Firestore's rule engine
that guarantee, and the whole request is denied with "Missing or
insufficient permissions," not silently filtered.

**How this actually surfaced:** several `paymentTransactions` queries in
`PaymentSources.jsx` (`verifyImportAgainstSource`'s re-check, the
`viewingImportId` transaction list, `backfillClassification`, `commitRows`'
reprocess/duplicate-check lookups, `unlinkTransaction`, `deleteImport`) and
one in `CompanyReview.jsx` filtered by everything except `projectId` — they
all worked under the old ownership-only rules (`resource.data.userId ==
uid`, no cross-document lookup needed) and broke silently the moment the
rule became membership-based via `get()`. The broader queries in
`Reconciliation.jsx` (already filtered by `where('projectId', ...)` from
the start) never showed the symptom, which is what made this easy to miss
across a large multi-file change.

**How to apply:** any query against a collection whose rule does
`get()`-based cross-document lookups keyed on a field must include
`where('projectId', '==', activeProject.id)` (or whatever field the `get()`
depends on) explicitly, even when another filter already narrows the
result set to the same effect in practice. Audit with
`grep -rn "collection(db, '<collection>')" src/pages` after any rule
change, not just the query sites you remember touching.

## Firestore security rules can't filter a list query — only allow or deny it

Building Project Sharing, the natural instinct was: write a rule that does a
`get()` on the transaction's payment account to check `ownershipType`, and let
that rule silently exclude personal-account rows from a collaborator's
`paymentTransactions` query. That doesn't work — Firestore rules for a
`list`/collection query aren't evaluated per-returned-document the way a
single `get()` read is; the rule has to be provable against the query's own
constraints, or the read fails. A cross-document `get()` check is fine for
securing a single-document read/write, but useless for making some documents
in a list invisible while others come through.

**Why:** This is a hard platform constraint, not a bug — Firestore documents it,
but it's easy to miss until you've actually tried to lean on `get()` for
list-query filtering and hit the wall.

**How to apply:** To hide a subset of documents in a collection from certain
readers, denormalize a boolean flag onto the document itself
(`visibleToMembers` on `paymentTransactions` — see `computeVisibleToMembers`
in `expenseClassification.js`, kept in sync at every write site) and write
the security rule to check that exact field. The reader's query must then
add a `where()` clause matching the rule's condition precisely (see
`paymentTransactionsQuery` in `src/lib/projectAccess.js`) — the rule can only
be proven safe when it mirrors a constraint the query itself already applies.

---

## A memoized "candidates" list must re-check status, not just structural fields

Reconciliation's settlement-candidate detection (`settlementCandidates` in
[Reconciliation.jsx](src/pages/Reconciliation.jsx)) filtered card
payments/bank debits only by `transactionType`/`direction`/`settlementGroupId`
— not by `status`. Clicking "Not Related" (→ `ignoreTxn`, sets
`status:'ignored'`) left the transaction structurally unchanged, so it kept
reappearing as a settlement candidate forever: the "Card Settlements" summary
count never dropped, while the Exceptions list (whose `isException` check
*does* look at `status` first) correctly stopped showing it — producing a
visible mismatch ("I see 4 but there's none when I click in") that looked
like the button did nothing.

**How to apply:** Any live-computed "needs action" list must filter on the
same status field its own resolve actions write, not just the fields that
made it eligible in the first place — check both the count and the
underlying list use identical filter logic, or they'll drift after the first
resolve action.

## Amount+currency alone is not enough evidence for an expense match

`scoreExpenseMatch` in [paymentMatching.js](src/lib/paymentMatching.js) gave
45 points for a matching amount and 15 for matching currency with **no
penalty for date distance and no penalty for a merchant-name mismatch** —
enough to clear the ≥50 "suggested match" threshold on its own. A personal
bank transfer and an unrelated software subscription four years apart, sharing
only an amount and currency, scored 65 and got suggested as a match.

**Why:** For a statement-transaction-to-Expense match, date proximity is not
optional context — a real match is essentially always the same day or a few
days apart (statement posting lag). A pairing months or years apart is never
a genuine match no matter what else lines up.

**How to apply:** `scoreExpenseMatch` now disqualifies (`return null`) any
pairing more than `MAX_MATCH_DAYS` (90) apart before scoring anything else,
rather than merely failing to award a date-proximity bonus. Apply the same
"disqualify, don't just under-score" principle to any future match/scoring
function in this app where one strong-but-generic signal (amount, currency)
could otherwise paper over the absence of every specific one (date, merchant).

---

## Duplicates must surface, never silently skip

`commitRows()` in [PaymentSources.jsx](src/pages/PaymentSources.jsx) went through three
designs: (1) silently skip fingerprint-matching rows, (2) hold them in a separate
staging panel pending manual promotion, (3) the current model — **write every parsed
row unconditionally**, and only annotate it with a `duplicateStatus` for review.

**Why:** For a bookkeeping tool, both silent data loss and silently withholding a real
transaction from the ledger (even temporarily) are unacceptable. The user pushed back
hard on this after seeing genuine same-day repeat transactions wrongly flagged:
*"it is possible to have 2 same amount of transaction in the same day... you need to
check for the balance as well... this is accounting software, so it has to be very
precise."*

**How to apply:** [duplicateDetection.js](src/lib/duplicateDetection.js)'s
`classifyFingerprintCollision` uses `annotateBalanceSequence` (previous balance + this
row's debit/credit vs. reported balance, in original statement order — never resorted)
as the strongest evidence for bank statements; credit-card statements (no per-row
balance) fall back to merchant comparison and default to keeping both rows. Only an
**identical `rawRowText` match across two different imports** counts as
`confirmed_duplicate` automatically — identical text within the *same* import (two
real transactions the statement happened to print identically) must not be
auto-confirmed. Resolution is always Keep as Separate / Confirm Duplicate / Ignore
Warning — never a delete. Any future ambiguous-classification step in this app should
default to "write + flag for review," not "hold back until confirmed."

---

## Financial imports need audit-trail storage from day one

Phase 1 of payment reconciliation originally only saved *parsed* transaction rows to
Firestore — the uploaded CSV/PDF was read in-browser and discarded, with
`sourceFileUrl: null` left as a "later phase" placeholder.

**Why:** The user caught this directly: *"we are doing accounting here"* — for real
bookkeeping, the original source document must be retrievable to trace any recorded
transaction back to its evidence, the same way receipts are already stored for
expenses ([receiptStorage.js](src/receiptStorage.js)). Deferring audit-trail storage
is a reasonable simplification for a demo, but wrong for an accounting tool from the
start.

**How to apply:** Any feature that imports or derives records from a financial source
document must store the original file in Firebase Storage and link it on the record
from the first version — see [statementStorage.js](src/statementStorage.js) (upload
raw bytes, no compression — fidelity matters for source-of-record documents, unlike
`receiptStorage.js`'s JPEG compression which is fine for receipt thumbnails).

---

## Firebase rules live outside the repo

This repo has no `firestore.rules` or `storage.rules` file — security rules exist only
in the Firebase Console, edited from rule text provided in chat.

**Why:** This has bitten the payment reconciliation feature twice: new Firestore
collections (`paymentAccounts`, `paymentImports`, `paymentTransactions`,
`reconciliationActions`) needed rules added before the feature worked at all, and
later a new Storage path (`statements/{userId}/...`) needed its own rule before
uploads would succeed. In both cases the code shipped and *looked* done, but silently
failed with `permission-denied` until rules were manually published.

**How to apply:** Whenever adding a new Firestore collection or Storage path: ask for
the current rules file, return the full file with the new `match` block merged in
(existing pattern: `allow read, write: if request.auth != null && request.auth.uid ==
resource.data.userId` for Firestore; `... == userId` for Storage per-user paths), and
say explicitly to publish it before testing — don't let the user discover the silent
failure themselves.

---

## Storage fetch needs a proxy

A Firebase Storage download URL cannot be `fetch()`'d directly from the browser in
this app.

**Why:** `<a href>`/`<img src>` to a Storage URL works fine (native browser
navigation isn't subject to the restriction), but a JS-initiated `fetch()`/XHR to
re-read the bytes fails — this app has no Storage bucket CORS configured for that.
This surfaced building "re-verify a stored PDF statement against its original file":
`fetch(imp.sourceFileUrl)` failed with an opaque error.

**How to apply:** [download-receipt.js](netlify/edge-functions/download-receipt.js)
is a CORS proxy built for exactly this (despite its receipt-specific name, it proxies
any `firebasestorage.googleapis.com` URL). Any feature that needs to programmatically
re-read an already-stored file (statements, receipts) must go through
`POST /api/download-receipt` with `{ url }`, not a direct `fetch(url)`.

---

## PDF statement parsing is fragile — verify against real files

[pdfStatementParser.js](src/lib/pdfStatementParser.js) went through many rounds of
real bugs that hand-written synthetic test lines never would have caught:

- **Header label x-position ≠ data x-position** for wide columns (e.g. a
  "Description of transaction" header centered well right of where every real value
  actually starts). Column boundaries must be calibrated from the *data's*
  x-clustering — the header is only for column names/order, never for boundaries.
- **The same bank uses different date formats across statements**: "23 Jul" vs
  "18JUL", full vs. abbreviated month names for the statement-date anchor used to
  infer missing years.
- **Page furniture pollutes detection** — a sidebar summary box or footer address
  block can share the transaction table's y-range, or even start at the exact same
  left margin as the Date column. Filtering by "does this line contain a date/money
  token" isn't enough; a populated date-shaped bucket must actually *parse* as a real
  date, and a date-less line's leftmost item must sit near the description column's
  calibrated start.
- **Multi-word descriptions merge or split differently depending on the PDF
  text-extraction library** (see next entry) — column clustering must only pool items
  that are themselves date-shaped or money-shaped, never plain text.
- **A foreign-currency sub-amount embedded in the description** (e.g. "USD 10.00"
  before the real HKD amount) can get misidentified as the real amount if the
  description/amount boundary is a naive midpoint-of-means instead of the amount
  column's own observed left edge.

**How to apply:** Before considering a parser fix "done," get the user's real
statement file(s), extract exact text coordinates via the actual runtime library, and
verify row-by-row — including that non-transaction lines (summary boxes, footers) are
correctly *excluded*, not just that real transactions are correctly included. Getting
the happy path right while leaking 2-3 phantom rows from page furniture is not done.

---

## pdf.js vs. PyMuPDF tokenize differently — don't cross-verify against the wrong one

PyMuPDF (handy for local dev-time inspection) often merges a multi-word text run into
one span, while `pdfjs-dist` (the actual library this app uses in-browser) splits the
same content into one item per word. Column-detection logic built assuming one item
per column value broke badly against real pdf.js output despite passing against
PyMuPDF coordinates for the same file.

**How to apply:** Test PDF-table-extraction logic with a Node script that runs
`pdfjs-dist/legacy/build/pdf.mjs` directly, not a PyMuPDF stand-in. Also note:
`item.transform` in pdf.js uses a bottom-left origin (y increases upward), while
PyMuPDF uses top-left (y increases downward) — flip sort order when switching
between them.

---

## Import lists must group by identity, not creation time

[PaymentSources.jsx](src/pages/PaymentSources.jsx) creates a new `paymentImports` doc
on every import attempt, including failed/duplicate re-imports that produce a 0-row
entry with the same filename as an earlier successful import. Sorting purely by
`createdAt` scattered an empty duplicate far from the real one — which directly
caused the user to click "Attach Original" on the empty stub instead of the real
47-row import sitting elsewhere in the list. Concrete, observed mistake, not
hypothetical.

**How to apply:** Sort/group such lists by content identity first (filename), then by
a tiebreaker (row count descending), and visually dim/label empty or failed entries
inline rather than relying on the user to compare row-count columns across a
scattered list. Generalizes to any future list where retries/duplicates can
accumulate.

---

## Expandable row detail must render inline, not after the whole list

The first version of "View/Edit" on the import table rendered the expanded
transaction editor once, after the entire `imports.map(...)` body — not next to the
clicked row. With more than a couple of imports, clicking an early row put the
content far below the visible screen; the user reported "the view and edit is not
working" when it was actually working, just invisible.

**How to apply:** For a table where any row can expand, render the expansion as an
actual sibling `<tr>` immediately after that row inside the same `.map()`, using a
`Fragment` with an explicit `key` (the `<>` shorthand can't carry a `key`, needed
since each iteration now returns two elements). Never place the expansion output
elsewhere in the tree "for convenience."

---

## `table-layout: fixed` can silently collapse a column to near-zero

Hit twice: first in the PDF import review table, then in the transaction detail
table. An unspecified column's width can collapse to near-zero while a neighbor
absorbs the space, producing catastrophic character-per-line wrapping — invisible
until checked at the pane's *actual* CSS width (device pixel ratio can make a
screenshot's apparent width very different from the real viewport).

**How to apply:** Every column needs an explicit percentage width summing to 100%.
Only genuinely variable-length columns (Description) get `white-space: normal;
overflow-wrap: break-word`; everything else gets `white-space: nowrap; overflow:
hidden; text-overflow: ellipsis`. When even a reduced column count won't fit phone
width, switch to a mobile card list instead of continuing to fight the table layout
(done for the transaction detail table via `.expense-mob-card`).

---

## Gemini thinking-budget gotcha

`gemini-2.5-flash` is a thinking model: with a modest `maxOutputTokens` and no
thinking cap, it can spend the entire output budget on internal reasoning and return
an empty response (`finishReason: MAX_TOKENS`) — looks like a silent OCR/parse
failure. This caused intermittent "no data extracted" in the receipt upload flow.

**How to apply:** For any Gemini call in this app, set
`generationConfig.thinkingConfig = { thinkingBudget: 0 }`, add
`responseMimeType: 'application/json'` when JSON is needed, and give a generous
`maxOutputTokens`.

---

## Debug "why isn't my data showing" mysteries with direct DB access, not endless UI guessing

A "47 rows flagged as duplicate but nothing shows 47 rows anywhere" mystery went
through several rounds of asking the user to click through the UI and report row
counts, without resolving it — the actual cause (two separate `paymentImports` docs
for the same filename, one real, one an empty re-attempt) was invisible from the
app's own UI. Resolved in one query with a temporary Firebase service-account key.

**How to apply:** When a data-state question can't be answered from what the UI
already shows, proactively suggest a temporary Firebase service-account key rather
than more rounds of "click here and tell me what you see." Protocol: isolate the
query script in the OS scratchpad (never inside the git repo), use
`firebase-admin/app` + `firebase-admin/firestore` named imports (the default
`firebase-admin` export fails under ESM), run read-only queries, then delete the
script and remind the user to revoke the key and delete the downloaded JSON. This is
a deliberate escalation for genuine mysteries, not a substitute for reading the code
first when the bug is likely client-side logic.

---

## OCR architecture direction (in progress, not yet built)

Agreed direction for receipt OCR accuracy: **Cloud Vision `DOCUMENT_TEXT_DETECTION`
reads text faithfully; Gemini only extracts/normalizes fields from that text; never
let Gemini read raw pixels and reason at once** — Gemini-as-OCR intermittently fails
or hallucinates values, unacceptable for accounting.

**Status:** `callVisionOCR` exists in
[process-receipt.js](netlify/edge-functions/process-receipt.js) — images use Vision
when `GOOGLE_VISION_API_KEY` is set, else fall back to Gemini transcription; PDFs stay
direct-Gemini. Still needed: a Vision API key (separate GCP project from the AI
Studio `GEMINI_API_KEY`, billing-enabled) as a Netlify env var. Deferred: deterministic
amount/date/currency parsers, per-field source+confidence data model, `needs_review`
states, Document AI, fixture tests.
