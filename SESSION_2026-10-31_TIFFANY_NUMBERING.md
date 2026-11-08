# Tiffany transaction numbering — 2026-10-31

## Scope and outcome

At the owner's request, permanent transaction numbers were assigned to Tiffany's existing bank transactions in the live `crystocraft-expenses` Firestore database. The retained Google login is `tifftiffdreamtk@gmail.com` (project owner UID `zWCpfXbwv8blJDe5im9uvA6oR5A3`). This was a **live data update**, not an app code change or deployment. The app's numbering code was already deployed at build `db5598c`.

| Project | Firestore project ID | Bank transactions numbered |
| :-- | :-- | --: |
| Sagacity | `A0WxPPs0kvfd6IgCyeEe` | 290 |
| Default | `t26kfCU2RW7jnx3DqCmo` | 22 |
| Cankleen | `YX4xbtJaOWgiY0Wl53rv` | 0; no bank accounts or transactions were present |
| New starter (Oct 26) | `DnLIXLdDVewWVJlwqZia` | 0; no bank accounts or transactions were present |

The Default project's 22 rows were numbered **in Default**. No records were moved to Cankleen. Whether they belong to Cankleen remains a separate project-data question.

## Account sequences

Each account starts at `000001`. The prefix is now locked because numbers have been issued.

| Project | Account | Prefix | Rows | Last number |
| :-- | :-- | :-- | --: | :-- |
| Sagacity | HSBC Client Current, ending 6001 | `SAG-HSBC-CUR-6001` | 18 | `SAG-HSBC-CUR-6001-000018` |
| Sagacity | HSBC Operation Current, ending 2001 | `SAG-HSBC-CUR-2001` | 32 | `SAG-HSBC-CUR-2001-000032` |
| Sagacity | HSBC Client Savings, ending 6838 | `SAG-HSBC-SAV-6838` | 181 | `SAG-HSBC-SAV-6838-000181` |
| Sagacity | HSBC Operation Savings, ending 2838 | `SAG-HSBC-SAV-2838` | 59 | `SAG-HSBC-SAV-2838-000059` |
| Default | HSBC Business Direct Savings | `DEF-HSBC-SAV` | 1 | `DEF-HSBC-SAV-000001` |
| Default | HSBC Business Account (Current activity) | `DEF-HSBC-CUR` | 21 | `DEF-HSBC-CUR-000021` |

Rows were ordered by transaction date, import period start, printed source-row index, then Firestore document ID, matching `sortRowsForNumbering()` in `src/lib/transactionNumbering.js`. Prefixes are unique within each project and use only account suffixes, not full bank numbers.

The Current/Savings prefix labels describe the known account labels and statement activity. This operation did not set the separate `ledgerType` field; it remains unset on Sagacity's four accounts and Default's Business Account.

## Safeguards and verification

1. A read-only dry run checked exact project IDs, names, and owner UID; the six expected account IDs; 312 unnumbered rows; and the planned per-account counts. It stopped if any account, row, number, or expected count differed.
2. One atomic Firestore commit per account wrote `transactionNumber` and `transactionSequence` to its rows, plus `transactionPrefix` and `lastTransactionSequence` to that account. Every update carried its previously read `updateTime` as a precondition. Update masks limited writes to those four fields across the two document types.
3. After each commit, the account and all its rows were read again. Each account had a contiguous `1..N` sequence, matching number strings, and a counter equal to `N`.
4. An independent Firebase Console count of nonempty transaction numbers rose from **3 to 315**. The original three were the isolated numbering smoke-test rows; the new 312 were Tiffany's.

Dates, amounts, account assignments, receipt links, reconciliation fields, and review decisions were outside the update masks. This was a Firestore readback, **not** a signed-in Tiffany UI test or a new statement upload test.

The temporary audit script was removed from both the local machine and Cloud Shell. `gcloud auth revoke eddie.cy.chou@gmail.com --quiet` reported that the temporary Cloud SDK credentials were revoked; this does not establish that Google's connected-app permission grant was removed. Unrelated Graphify files were not touched.
