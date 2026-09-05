import { query, where } from 'firebase/firestore'

// A project's `userId` is its permanent owner — the only person who can
// manage membership or delete it. Everyone else in `memberUids` (including
// the owner) is a collaborator with editor access.
export function isProjectOwner(project, uid) {
  return project?.userId === uid
}

// paymentTransactions is the one collection where a non-owner member must
// NOT see everything — personal-account rows stay hidden until classified
// (see expenseClassification.js's computeVisibleToMembers). Firestore
// security rules can't filter a list query by a cross-document check, only
// by a field the query itself constrains — so a member's query adds an
// explicit `visibleToMembers == true` clause that mirrors the rule exactly,
// while the owner's query stays unfiltered. Always wrap a paymentTransactions
// query with this before subscribing/reading.
export function paymentTransactionsQuery(baseQuery, project, uid) {
  return isProjectOwner(project, uid) ? baseQuery : query(baseQuery, where('visibleToMembers', '==', true))
}
