// Finance repositioning MVP-5 — pulls Purchase Orders and Sales Invoices
// live from Operation Center (costing-tool) instead of a manual CSV
// export/import. Crystocraft-only: gated by the caller's own project doc
// (`operationCenterSyncEnabled`), off by default for every project.
//
// This function does no Firestore WRITES anywhere — it verifies the
// caller, checks the gate, fetches rows from costing-tool, and returns
// them; the client performs the actual upsert into purchaseOrders/
// salesInvoices, same as every other write in this app.
//
// Auth to costing-tool: signs in as a dedicated service account there
// (role:'staff', modules including 'supply' and 'uc') using
// OPERATION_CENTER_SERVICE_EMAIL/PASSWORD — the same trust model
// costing-tool's own endpoints (uc.js, finance-po-sync.js) already use for
// every other caller, not a new one.
//
// Env (Netlify -> Site config -> Environment variables, this site):
//   VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID   (already set)
//   OPERATION_CENTER_BASE_URL                          e.g. https://costing-tool.example.netlify.app
//   OPERATION_CENTER_SERVICE_EMAIL
//   OPERATION_CENTER_SERVICE_PASSWORD
//   OPERATION_CENTER_FIREBASE_API_KEY                  costing-tool's own Identity Toolkit key
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
  const OC_BASE_URL = Deno.env.get('OPERATION_CENTER_BASE_URL')
  const OC_SERVICE_EMAIL = Deno.env.get('OPERATION_CENTER_SERVICE_EMAIL')
  const OC_SERVICE_PASSWORD = Deno.env.get('OPERATION_CENTER_SERVICE_PASSWORD')
  const OC_FIREBASE_API_KEY = Deno.env.get('OPERATION_CENTER_FIREBASE_API_KEY')
  if (!FIREBASE_API_KEY || !PROJECT_ID || !OC_BASE_URL || !OC_SERVICE_EMAIL || !OC_SERVICE_PASSWORD || !OC_FIREBASE_API_KEY) {
    return json({ error: 'Server not configured' }, 500)
  }

  let idToken, projectId, since
  try {
    ({ idToken, projectId, since } = await request.json())
  } catch { return json({ error: 'Bad JSON' }, 400) }
  if (!idToken || !projectId) return json({ error: 'Missing idToken or projectId' }, 400)

  // Verify the caller is a signed-in Finance app user (same pattern as
  // export-excel.js's own Identity Toolkit lookup).
  const verRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  const verData = await verRes.json()
  if (!verRes.ok || !verData.users?.[0]) return json({ error: 'Unauthorized' }, 401)

  // The Crystocraft-only gate: read the caller's own project doc with
  // their own token (respects this app's normal Firestore rules — no
  // elevated access here) and require the toggle to be on.
  const projRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/projects/${projectId}`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  )
  if (!projRes.ok) return json({ error: 'Could not read project' }, 403)
  const projDoc = await projRes.json()
  if (projDoc?.fields?.operationCenterSyncEnabled?.booleanValue !== true) {
    return json({ error: 'Operation Center sync is not enabled for this project' }, 403)
  }

  // Sign in as costing-tool's dedicated service account to get a token its
  // endpoints will accept.
  const ocSignIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${OC_FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OC_SERVICE_EMAIL, password: OC_SERVICE_PASSWORD, returnSecureToken: true }),
  })
  const ocAuth = await ocSignIn.json()
  if (!ocSignIn.ok || !ocAuth.idToken) return json({ error: 'Could not authenticate with Operation Center', detail: ocAuth.error?.message }, 502)
  const ocToken = ocAuth.idToken

  async function callOc(path, body) {
    const r = await fetch(`${OC_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ocToken}` },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `${path} failed (${r.status})`)
    return data
  }

  try {
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
