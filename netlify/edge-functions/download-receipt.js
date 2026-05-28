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

  const { url } = await request.json()

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
