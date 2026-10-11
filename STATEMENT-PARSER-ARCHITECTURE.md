# Statement Parser Architecture — Client Isolation and Privacy

> **Status: proposed design, not implemented.**
>
> This document describes how the Finance / Bookkeeping Workspace should
> support many clients whose banks produce different statement layouts. It is
> deliberately separate from the current import workflow so future work does
> not accidentally present a proposal as live behaviour.
> **Planning order updated:** [PARSING-PIPELINE-PLAN.md](PARSING-PIPELINE-PLAN.md)
> now recommends improving the shared reading, routing, and validation pipeline
> first. The account-specific profiles and Private Setup below are a later
> option only if measured failures remain after that work.

## Purpose

The app must support different bank and credit-card statement layouts without
letting one customer's setup change another customer's results.

The goal is not to "train" a shared model on customer statements. The goal is
to safely save a small, reusable **layout profile** that tells the local parser
where to find a statement's date, description, amount, balance, and other
fields.

## Scope: project and payment account, not login

A profile belongs to a **payment account inside a project**:

```text
Organisation / client project
  └── Payment account
        └── Statement parser profile(s)
```

This is the right scope because two bookkeepers in the same client project
should get the same successful setup. A login-specific setting would make the
same bank account behave differently for colleagues.

Profiles must never be shared automatically across projects, even where two
clients use the same bank. That prevents a client-specific adjustment from
affecting another customer.

## Current workflow

In the V1.2 local build, a PDF is read through these stages:

1. Browser PDF text and positions, with an offered cloud OCR route for pages
   that lack a usable text layer.
2. Column-position parser and single-line fallback.
3. Page-level Gemini interpretation when rows are absent, appear incomplete,
   fail balance checks, or come from OCR.

Every successful result still requires human review. The app checks statement
totals where opening and closing balances are available before import.

The AI fallback currently sends extracted statement text to the app's edge
endpoint and then Gemini. It is therefore **not** a strict local-only privacy
mode.

## Target workflow

```text
Select PDF in browser
        |
        v
Read text and positions locally
        |
        v
Try matching account profile
        |
        +-- valid --> Parse locally --> Validate --> Review --> Import
        |
        +-- no match / invalid --> Try certified global profile
                                      |
                                      +-- valid --> Validate --> Review --> Import
                                      |
                                      +-- no match --> Private Setup
                                                        |
                                                        +-- save account profile
                                                        +-- parse locally
                                                        +-- validate and review
```

AI is an explicit optional path after the local alternatives. A project can
disable it entirely.

## Private Setup

Private Setup appears only when a statement layout is not recognised. It is a
short, client-facing rescue flow:

1. The PDF remains in browser memory.
2. The app identifies likely columns and displays a masked preview.
3. The user confirms the detected columns, or corrects a label such as Date,
   Description, Debit, Credit, Amount, or Balance.
4. The app saves a profile for that payment account.
5. The app re-parses the same PDF locally and still requires normal review
   before import.

The saved profile contains only structural information:

```text
profileVersion
page-size ratio
normalised column boundaries (for example, 0.00–0.17 = date)
field labels and column order
date-format and debit/credit conventions
row-anchor rules
layout fingerprint
```

It must not contain statement text, amounts, merchant names, account numbers,
filenames, page images, or the PDF itself.

For scanned/image-only PDFs, this flow needs local OCR before it can identify
columns. Until local OCR is available, the correct alternatives are a CSV
export or explicit AI-assisted parsing with client consent.

## Parser-profile data model

Use a top-level Firestore collection consistent with the existing financial
collections:

```text
statementParserProfiles/{profileId}
  projectId: string
  paymentAccountId: string
  scope: 'account'
  profileVersion: number
  status: 'draft' | 'active' | 'superseded' | 'disabled'
  layoutFingerprint: string
  layout: {
    pageAspectRatio,
    columns: [{ field, startRatio, endRatio }],
    dateFormat,
    amountConvention,
    rowAnchor
  }
  createdBy: uid
  createdAt: timestamp
  lastValidatedAt: timestamp | null
  validationSummary: { successfulImports, totalsChecksPassed }
```

`paymentAccounts` stores only the selected `activeParserProfileId` and profile
version. Older profiles remain available for rollback; a new profile never
overwrites a working one in place.

Any query for this collection must include `where('projectId', '==',
activeProject.id)`. Firestore rules must use the same project-member pattern as
`paymentAccounts` and `paymentImports`; profile documents are readable and
writable only by members of their own project.

## Global profiles

The global layer must contain only **certified, versioned profiles**. It is not
a shared bucket for customer-created rules.

Global profiles should live in reviewed application code or a server-managed,
client-read-only registry. A customer cannot write to it.

A client profile may be promoted only through an administrator process:

1. Obtain explicit permission for any evidence used.
2. Reduce it to non-identifying layout information or use synthetic fixtures.
3. Test the profile against regression fixtures and balance validation.
4. Publish a new immutable global version.
5. Shadow-test the version before activation.
6. Keep existing accounts pinned to their current working version until they
   explicitly adopt the new version or it has proved safe.

There is no automatic promotion and no automatic replacement of a client's
active profile.

## Validation and safety gates

No profile, global or account-specific, can bypass the bookkeeping safeguards:

- The parser must produce reviewable rows.
- Statement totals must be checked where the statement provides balances.
- Running-balance checks remain visible when available.
- The user must review and confirm before transactions are written.
- A failed validation falls back to Private Setup or a clear error; it never
  silently imports guessed rows.

Each import record should retain only operational evidence needed for support:
parser mode, profile ID/version, validation outcome, row count, and a safe
failure code. In Private Setup before the user confirms import, avoid storing a
filename or source document metadata if strict privacy is selected.

## Privacy modes

| Mode | What leaves the browser before import? | Appropriate use |
|---|---|---|
| Private local parsing | Nothing except the account layout profile after confirmation | Default for digital PDFs with supported or mapped layouts |
| Anonymous diagnostics | User-approved layout geometry and token types only | Optional support and future global-profile research |
| AI assistance | Extracted statement text sent to the configured AI service | Only with explicit project-level consent |

After a user confirms a normal financial import, the original statement is
stored under the existing audit-trail workflow. That is distinct from Private
Setup: Private Setup is for learning the layout before importing a statement.

## Failure handling

A changed bank layout is expected. The parser should compare the PDF's layout
fingerprint with the selected profile before applying it. If the profile no
longer matches, the app must not force the old rules onto the document. It
returns the user to Private Setup, preserving the prior profile for older
statements and rollback.

## Delivery sequence

1. Add account-scoped profiles, security rules, and Private Setup for digital
   PDFs.
2. Add profile selection, fingerprint matching, version pinning, and rollback.
3. Add explicit project-level consent for AI assistance and safe diagnostics.
4. Add an administrator-only certification workflow for global profiles.
5. Add local OCR only after the digital-PDF path is proven with representative
   statements.

## Decision summary

Use a global parser engine and carefully certified global profiles for common,
well-tested layouts. Use project-and-account-scoped profiles for every
client-specific adjustment. Do not make custom profiles login-specific, do not
auto-promote them globally, and do not remove the review and validation gates.
