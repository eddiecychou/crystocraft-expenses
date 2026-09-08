// Finance repositioning MVP-5 — pulls Purchase Orders and Sales Invoices
// live from Operation Center (costing-tool) instead of a manual CSV
// export/import.
//
// Two request shapes:
//   { idToken, projectId, since? }                  -> recurring Sync
//     (app-authored source: finance-po-sync.js + uc.js's list_invoices)
//   { idToken, projectId, action: 'import_legacy', legacyFrom?, legacyTo? }
//     -> one-time pull of costing-tool's frozen JES ERP archive
//     (entities 'purchase'/'sales_invoice' via its existing /api/erp,
//     paged with `offset` since that endpoint has no cursor of its own
//     beyond `limit`). Doesn't change, so it's not part of the
//     recurring Sync above — see Invoices.jsx's separate "Import
//     Legacy JES History" button. legacyFrom/legacyTo (YYYY-MM-DD,
//     both optional) filter by each row's own `date` — /api/erp has no
//     date-range filter itself, so this is applied here after
//     fetching, not passed through as a query param.
//
// This function does no Firestore WRITES anywhere — it verifies the
// caller, checks the gate, fetches rows from costing-tool, and returns
// them; the client performs the actual upsert into purchaseOrders/
// salesInvoices, same as every other write in this app.
//
// Auth model (hardened after the first version's toggle-only gate turned
// out to be a UI convenience, not a real boundary — a client-writable
// Firestore boolean can't stop a project owner from granting themselves
// access to another company's connector). The real gate is now a
// server-side CONNECTOR REGISTRY (below) keyed by projectId: only a
// projectId with a matching registry entry can sync at all, regardless
// of what its own operationCenterSyncEnabled field says (that field is
// now only a secondary check + the thing that shows/hides the button —
// it can never grant access on its own). Deliberately shaped to
// generalize to future connectors for other companies' own systems:
// adding one is a registry entry (env var edit), not new gating code —
// though the actual fetch/mapping logic for a genuinely different
// external system is still real, connector-specific code (see the
// `type` switch below).
//
// Env (Netlify -> Site config -> Environment variables, this site):
//   VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID   (already set)
//   OPERATION_CENTER_CONNECTORS   JSON array, one entry per authorized
//     project: [{ projectId, type: 'operation_center', baseUrl,
//     serviceEmail, servicePassword, firebaseApiKey }]. Mark as a secret
//     value in Netlify (it carries a real login password).
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const FIREBASE_API_KEY = Deno.env.get('VITE_FIREBASE_API_KEY')
  const PROJECT_ID = Deno.env.get('VITE_FIREBASE_PROJECT_ID')
  let connectors
  try {
    connectors = JSON.parse(Deno.env.get('OPERATION_CENTER_CONNECTORS') || '[]')
  } catch {
    return json({ error: 'Server not configured (OPERATION_CENTER_CONNECTORS is not valid JSON)' }, 500)
  }
  if (!FIREBASE_API_KEY || !PROJECT_ID || !Array.isArray(connectors)) {
    return json({ error: 'Server not configured' }, 500)
  }

  let idToken, projectId, since, action, legacyFrom, legacyTo
  try {
    ({ idToken, projectId, since, action, legacyFrom, legacyTo } = await request.json())
  } catch { return json({ error: 'Bad JSON' }, 400) }
  if (!idToken || !projectId) return json({ error: 'Missing idToken or projectId' }, 400)

  // The real gate: this projectId must have its own registry entry.
  // Checked BEFORE touching Firestore or verifying the caller's token —
  // an unauthorized project gets the same flat refusal no matter what
  // else is true about the request.
  const connector = connectors.find(c => c.projectId === projectId)
  if (!connector) return json({ error: 'Operation Center sync is not configured for this project' }, 403)
  if (connector.type !== 'operation_center') {
    return json({ error: `Connector type "${connector.type}" is not implemented` }, 501)
  }
  if (!connector.baseUrl || !connector.serviceEmail || !connector.servicePassword || !connector.firebaseApiKey) {
    return json({ error: 'Server not configured (incomplete connector entry)' }, 500)
  }

  // Verify the caller is a signed-in Finance app user (same pattern as
  // export-excel.js's own Identity Toolkit lookup).
  const verRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  const verData = await verRes.json()
  if (!verRes.ok || !verData.users?.[0]) return json({ error: 'Unauthorized' }, 401)

  // Secondary check: the project's own toggle must also be on. Never
  // sufficient by itself (the registry lookup above already is the real
  // gate) — this just keeps Settings.jsx's checkbox meaningful as a way
  // to pause sync for an authorized project without editing env vars.
  const projRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/projects/${projectId}`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  )
  if (!projRes.ok) return json({ error: 'Could not read project' }, 403)
  const projDoc = await projRes.json()
  if (projDoc?.fields?.operationCenterSyncEnabled?.booleanValue !== true) {
    return json({ error: 'Operation Center sync is not enabled for this project' }, 403)
  }

  // Sign in as this connector's dedicated service account to get a token
  // its endpoints will accept.
  const ocSignIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${connector.firebaseApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: connector.serviceEmail, password: connector.servicePassword, returnSecureToken: true }),
  })
  const ocAuth = await ocSignIn.json()
  if (!ocSignIn.ok || !ocAuth.idToken) return json({ error: 'Could not authenticate with Operation Center', detail: ocAuth.error?.message }, 502)
  const ocToken = ocAuth.idToken

  async function callOc(path, body) {
    const r = await fetch(`${connector.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ocToken}` },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `${path} failed (${r.status})`)
    return data
  }

  // One-time legacy history import (see TECHNICAL.md's "Operation Center
  // Sync" section) — pages through costing-tool's existing /api/erp for
  // the frozen JES archive (entities 'purchase'/'sales_invoice'), which
  // the recurring Sync above never touches. Requires the service
  // account to hold the 'erp' module there (broader than 'supply'/'uc'
  // — the user's own call whether to grant it standing or temporarily).
  async function pageAllErp(entity, pageLimit) {
    const rows = []
    let offset = 0
    for (;;) {
      const data = await callOc('/api/erp', { entity, limit: pageLimit, offset })
      const page = data.rows || []
      rows.push(...page)
      if (page.length < pageLimit) break
      offset += pageLimit
    }
    return rows
  }

  try {
    if (action === 'import_legacy') {
      const inRange = row => (!legacyFrom || row.date >= legacyFrom) && (!legacyTo || row.date <= legacyTo)
      const [poRows, invoiceRows] = await Promise.all([
        pageAllErp('purchase', 1000),
        pageAllErp('sales_invoice', 500),
      ])
      return json({ poRows: poRows.filter(inRange), invoiceRows: invoiceRows.filter(inRange) })
    }
    const [poData, invoiceData] = await Promise.all([
      callOc('/api/finance-po-sync', { since: since || undefined }),
      callOc('/api/uc', { op: 'list_invoices', since: since || undefined, limit: 1000 }),
    ])
    return json({ poRows: poData.rows || [], invoiceRows: invoiceData.rows || [] })
  } catch (err) {
    return json({ error: err.message || 'Operation Center sync failed' }, 502)
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

export const config = { path: '/api/sync-operation-center' }
