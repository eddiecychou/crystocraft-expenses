// OCR one rendered statement page at a time. The browser keeps the PDF and
// renders only a bounded JPEG for Vision; returning word boxes lets the
// statement parser reconstruct columns instead of guessing from plain text.
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' } })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const visionKey = Deno.env.get('GOOGLE_VISION_API_KEY')
  const firebaseKey = Deno.env.get('VITE_FIREBASE_API_KEY')
  if (!visionKey || !firebaseKey) return json({ error: 'Statement OCR is not configured' }, 503)

  try {
    const { image, idToken } = await req.json()
    if (!idToken) return json({ error: 'Not signed in' }, 401)
    if (typeof image !== 'string' || !image.length || image.length > 6000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
      return json({ error: 'Page image is missing or too large' }, 400)
    }
    const verify = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
    })
    const identity = await verify.json()
    if (!verify.ok || !identity.users?.[0]) return json({ error: 'Unauthorized' }, 401)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let response
    try {
      response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: image }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const result = await response.json()
    if (!response.ok || result.responses?.[0]?.error) return json({ error: 'OCR could not read this page' }, 502)
    const pages = result.responses?.[0]?.fullTextAnnotation?.pages || []
    const words = pages.flatMap(page => (page.blocks || []).flatMap(block =>
      (block.paragraphs || []).flatMap(paragraph => (paragraph.words || []).map(word => ({
        text: (word.symbols || []).map(symbol => symbol.text).join(''),
        x: Math.min(...(word.boundingBox?.vertices || []).map(vertex => vertex.x || 0)),
        y: ((word.boundingBox?.vertices || []).reduce((sum, vertex) => sum + (vertex.y || 0), 0)) / 4,
      })).filter(word => word.text && Number.isFinite(word.x) && Number.isFinite(word.y))
    )))
    return json({ words })
  } catch (err) {
    return json({ error: err.name === 'AbortError' ? 'OCR timed out for this page' : 'OCR failed for this page' }, 502)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
}

export const config = { path: '/api/ocr-statement-page' }
