---
name: expense-ops-center
description: Workflow and hard-won lessons for building/maintaining Expense Operations Center (React + Firebase bookkeeping app) — bank/card statement import, duplicate detection, reconciliation, personal-to-company classification, multi-user sharing, PDF redaction. Use for any work in this repo.
---

# Expense Operations Center — Development Playbook

This is a React 18 + Firebase (Firestore/Storage/Auth) + Netlify Edge
Functions bookkeeping app. Full architecture: [TECHNICAL.md](../../../TECHNICAL.md).
Function-by-function map: [FUNCTION_INDEX.md](../../../FUNCTION_INDEX.md).
Full incident/design history: [LESSONS_LEARNED.md](../../../LESSONS_LEARNED.md).
This file is the *actionable* distillation — read it before touching the
code, and read the specific LESSONS_LEARNED.md entry before touching
anything it covers.

## Before writing any code

1. **Read TECHNICAL.md's relevant section first.** This app has real
   architectural decisions (duplicate-detection philosophy, the
   personal/company classification model, project-sharing's membership
   rules) that aren't obvious from the code alone.
2. **For anything that changes the data model or security posture — new
   Firestore collection, new field driving access control, new sharing
   permission — use plan mode.** This repo has been burned by exactly
   this class of change going out half-thought-through (see "Firestore
   security rules can't filter a list query" and the project-sharing
   lockout incident below). Get the schema and rules text right on paper
   before writing a line of code.
3. **Check whether a pure function you're about to write can be verified
   with a throwaway Node script before it ever touches the UI.**
   `duplicateDetection.js`, `paymentMatching.js`, `expenseClassification.js`
   are all dependency-light and have been verified this way repeatedly —
   copy the file(s) to `/tmp`, patch the relative import extension for
   plain-Node ESM, run representative cases, then delete the scratch copy.

## The two things this app can never get wrong

1. **Never lose or silently hide a financial record.** Every parsed
   statement row is written unconditionally; duplicate detection only
   *annotates* a `duplicateStatus`, never withholds a row. If you're
   building anything that could result in "don't show this transaction
   anywhere," stop and re-read "Duplicates must surface, never silently
   skip" in LESSONS_LEARNED.md.
2. **Never leak personal data into a company-facing artifact.** This has
   bitten the app twice already at two different layers of the same
   feature (Company Package export bundling a personal account's raw
   statement file whole, then a redaction mask leaving text visibly
   peeking out from under-sized padding). Any export or shared-access
   feature touching a personal-owned account needs to be reasoned about
   from "what's the worst case if this filter has a bug" backwards, and
   verified visually, not just by code review.

## Verification checklist before calling anything done

- [ ] `npx vite build` — must be clean.
- [ ] A pure function with real logic (classification, scoring, matching,
      geometry) gets a standalone Node script exercising representative
      cases, not just "the build passed."
- [ ] Anything involving PDF parsing, rendering, or redaction gets a
      **visual** check — render the actual output and look at it. Math
      that looks correct on paper has been wrong twice in this codebase
      (column x-position calibration, mask box padding) and both times
      only visual inspection caught it.
- [ ] Anything involving Firestore security rules: state plainly that you
      cannot publish them yourself, hand over the *complete* rules file
      (not a diff) in the project's existing style, and if it's a
      membership/ownership model change, walk through what happens to
      **existing, not-yet-migrated documents** under the new rules before
      handing it over. See "the project-sharing lockout" below.
- [ ] If the change touches a review queue, a "run matching"-style bulk
      action, or anything that loops over hundreds+ of documents: does it
      `await` something on every iteration, or could a long run of
      non-matching iterations freeze the tab with zero visible progress?
- [ ] Don't claim something is tested against the user's real data if it
      wasn't — this app requires a live Firebase login this environment
      doesn't have. Say so explicitly.

## Standing conventions

- **No `firestore.rules`/`storage.rules` file lives in this repo.** Rules
  are Console-only. Every new collection or Storage path needs its rule
  handed to the user before the feature can possibly work — this has
  caused multiple "it worked in code review but silently fails" incidents.
- **`git commit` freely; never `git push` without being asked.** This
  project's rhythm is: implement, build, commit with a detailed message,
  report status, wait for an explicit "push it."
- **Comments explain WHY, never WHAT.** Every non-obvious constraint,
  workaround, or hard-won invariant in this codebase has a comment at the
  point it matters — that's why LESSONS_LEARNED.md and inline comments
  stay in sync; don't strip "obvious-looking" comments without checking
  whether they're actually load-bearing.
- **Surgical changes.** Don't refactor adjacent code while fixing one
  thing. Every changed line should trace to the actual request.
- **Update TECHNICAL.md / FUNCTION_INDEX.md / LESSONS_LEARNED.md /
  CHANGELOG.md alongside the code**, not as an afterthought — they're
  load-bearing for the *next* session picking this repo up cold, this one
  included.

## Hard-won lessons, condensed (full detail in LESSONS_LEARNED.md)

- **Firestore list queries can't be rule-filtered.** A `get()`-based
  cross-document check works for a single `get`/`update`, but a `list`
  query needs the rule's condition to be one of the query's own `where`
  clauses, or Firestore denies the whole query. To hide a subset of a
  collection from some readers, denormalize a boolean field onto the
  document and filter the query on it — see `visibleToMembers` /
  `paymentTransactionsQuery` in `src/lib/projectAccess.js`. More precisely:
  when the rule does `get()` on a path built from a field like
  `resource.data.projectId`, that field must be pinned to one known value
  by the query's OWN `where()` clause, or the whole query is denied —
  filtering by `importId`/`paymentAccountId`/etc. alone isn't enough even
  though `projectId` is constant in practice. **After any Firestore rule
  change, `grep -rn "collection(db, '<name>')" src/pages` for every
  affected collection** — this exact gap silently broke half a dozen query
  sites in one page while the page's own broader (already `projectId`-
  filtered) queries kept working, which is what let it hide.
- **A rule requiring a field that a migration hasn't backfilled yet is a
  lockout, not a graceful degradation.** When switching a collection's
  access model to depend on a new field (e.g. `projects.memberUids`),
  every rule that reads it needs a fallback to the old ownership check
  (`proj.userId == uid || (proj.memberUids != null && ...)`) until
  migration has actually run for every affected document — and the
  migration's *own* read query must not depend on the new field either.
  This exact mistake caused a real "all my projects are gone" incident.
- **A PDF text line's `y` from pdf.js is the baseline, not the glyph's
  visual top.** A symmetric small padding around it leaves text visibly
  uncovered. Pad asymmetrically — generously above the baseline (~10pt,
  covers ascenders/cap-height up to ~13pt fonts), modestly below
  (~4pt, covers descenders).
- **Rasterize before "redacting" a PDF — never draw over live text.** A
  shape painted on top of vector PDF content without flattening to an
  image leaves the original text still selectable/copyable underneath it.
- **A Storage download URL's token already bypasses rules for reads.**
  Before assuming a sharing feature needs a Storage rule change, check
  whether the URL already stored on the Firestore doc carries an
  access-granting token — if so, viewing already works for anyone who can
  read that document; only upload/replace/delete (via the authenticated
  SDK, no token) actually need the rule fix.
- **A recurring transaction series needs chronological/positional
  pairing, not independent nearest-match per item.** Same-amount,
  same-merchant charges (subscriptions) score identically against every
  cycle's expense; only relative order — sorted, paired 1st-with-1st,
  2nd-with-2nd — reliably survives a systematic billing-cycle-vs-charge
  date offset. Only apply this when both series have the *same count* —
  a mismatched count means a gap, and guessing which position is missing
  is worse than falling back to nearest-date.
- **A memoized "needs action" count and its underlying list must share
  identical filter logic** (including `status`), or a resolved item can
  keep incrementing a stale count while vanishing correctly from the list
  — looks exactly like "the resolve button doesn't work."
- **`table-layout: fixed` can silently collapse an unspecified column to
  near-zero width.** Every column needs an explicit percentage width;
  only genuinely variable columns get `white-space: normal`.
- **A classification filter on structured export data doesn't protect a
  bundled raw source file.** If personal and company data are mixed in
  one original document, filtering the derived CSV/spreadsheet is not
  enough — the original file itself must be excluded, redacted, or
  regenerated.
- **`Amount + Currency` alone is never enough evidence for a financial
  match.** Disqualify pairings that are absurd on an orthogonal axis
  (date distance, in this app's case) rather than merely under-scoring
  them — a strong generic signal can otherwise paper over the total
  absence of every specific one.

## Where things live (quick pointers, not a substitute for FUNCTION_INDEX.md)

- Pure logic, no Firestore: `src/lib/*.js`
  (`duplicateDetection.js`, `paymentMatching.js`, `pdfStatementParser.js`,
  `pdfRedaction.js`, `expenseClassification.js`, `projectAccess.js`).
- Firestore reads/writes live directly in page components
  (`src/pages/*.jsx`), not in a service layer — this is the established
  pattern, don't introduce a new one for a single feature.
- Design tokens, typography, container widths, the 12-col dashboard grid:
  all in `src/App.css`'s `:root` and documented in TECHNICAL.md's "Design
  System" section — reuse tokens, don't hardcode new values.
