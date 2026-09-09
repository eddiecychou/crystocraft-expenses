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
  if (!FIREBASE_API_KEY) return new Response('Server misconfiguration', { status: 500 })

  const { url, idToken } = await request.json()

  // Signed-in Finance app users only — without this, anyone who finds the
  // URL can use this as a CORS-bypassing proxy for any Firebase Storage
  // object whose URL they already have (the `firebasestorage.googleapis.com`
  // prefix check alone doesn't require the caller to be one of this app's
  // own users). Same Identity Toolkit check as process-receipt.js/
  // process-invoice.js/export-excel.js/sync-operation-center.js.
  if (!idToken) return new Response('Not signed in', { status: 401 })
  const verRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  const verData = await verRes.json()
  if (!verRes.ok || !verData.users?.[0]) return new Response('Unauthorized', { status: 401 })

  // Only proxy Firebase Storage URLs
  if (!url?.startsWith('https://firebasestorage.googleapis.com/')) {
    return new Response('Invalid URL', { status: 400 })
  }

  const resp = await fetch(url)
  if (!resp.ok) return new Response('Upstream error', { status: resp.status })

  const bytes = await resp.arrayBuffer()
  return new Response(bytes, {
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export const config = { path: '/api/download-receipt' }
