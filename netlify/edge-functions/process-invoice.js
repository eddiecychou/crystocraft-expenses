// Structured-field extraction for customer invoices and supplier purchase
// orders. Same two-step OCR (Vision, falling back to Gemini transcription)
// + Gemini JSON-extraction pipeline as process-receipt.js — reused rather
// than a positional/rule-based parser because these documents come from
// many different customers/suppliers, each with their own arbitrary
// layout (unlike a bank statement, where one issuer means one fixed
// template pdfStatementParser.js can rely on). Every field this returns
// is reviewed and editable in the UI before anything is saved — the
// extraction is a starting point, never trusted blindly.
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
  if (!GEMINI_API_KEY) return json({ error: 'Server misconfiguration' }, 500)
  const VISION_API_KEY = Deno.env.get('GOOGLE_VISION_API_KEY')

  try {
    const { fileData, mimeType, docKind } = await req.json()
    if (!fileData || !mimeType) return json({ error: 'Missing file data' }, 400)
    const kind = docKind === 'po' ? 'po' : 'invoice' // default to invoice on an unrecognized value

    let transcript = null
    if (mimeType !== 'application/pdf') {
      if (VISION_API_KEY) transcript = await callVisionOCR(fileData, VISION_API_KEY)
      if (!transcript) transcript = await callGemini(
        [
          { inlineData: { mimeType, data: fileData } },
          { text: 'Transcribe every line of text visible on this document exactly as printed, top to bottom. Preserve all numbers, currency symbols, and punctuation. Output plain text only, no commentary.' },
        ],
        // thinkingBudget:0 disables gemini-2.5-flash's internal "thinking", which
        // otherwise consumes the whole maxOutputTokens budget and returns an empty
        // response (MAX_TOKENS) for some documents — see process-receipt.js.
        { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        GEMINI_API_KEY
      )
    }

    const prompt = extractionPrompt(kind)
    const extractionParts = transcript
      ? [{ text: `Document text:\n\n${transcript}\n\n${prompt}` }]
      : [{ inlineData: { mimeType, data: fileData } }, { text: prompt }]

    const raw = await callGemini(
      extractionParts,
      { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      GEMINI_API_KEY
    )

    if (!raw) return json(emptyResult(kind))

    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { return json(JSON.parse(match[0])) } catch {}
    }

    return json(emptyResult(kind))
  } catch (err) {
    return json({ error: err.message || 'Processing failed' }, 500)
  }
}

function emptyResult(kind) {
  return {
    number: null, counterpartyName: null, date: null, amount: null, currency: 'HKD', notes: null,
    notesFallback: 'AI could not parse — please fill in manually',
    docKind: kind,
  }
}

function extractionPrompt(kind) {
  const isPo = kind === 'po'
  return `You are an expert ${isPo ? 'purchase order' : 'invoice'} parser. Extract details from this ${isPo ? 'purchase order' : 'invoice'} and return ONLY a valid JSON object with no markdown, code fences, or extra text.

{
  "number": "${isPo ? 'PO/purchase order number' : 'invoice number'}, or null",
  "counterpartyName": "${isPo ? 'supplier/vendor name' : 'customer/client name'}, or null",
  "date": "YYYY-MM-DD or null",
  "amount": <final total amount${isPo ? ' of the order' : ' due'}, as a number or null>,
  "currency": "HKD or RMB or USD or EUR or JPY or AUD or GBP or SGD or CAD or KRW or Other or null",
  "notes": "brief description of what the ${isPo ? 'order' : 'invoice'} is for, or null"
}

Currency rules: HK$ or HKD = HKD | ¥ or RMB or CNY or 人民币 = RMB | $ or USD = USD | € = EUR | JP¥ or JPY = JPY | A$ = AUD | £ = GBP | S$ = SGD | C$ = CAD | ₩ = KRW. Default to HKD if unclear.
Amount rules: use the line labelled "Total", "Grand Total", "${isPo ? 'Order Total' : 'Amount Due'}", or "Total Paid". Ignore subtotals and tax lines shown separately.`
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function callVisionOCR(base64Image, VISION_API_KEY) {
  try {
    const res = await fetchWithTimeout(
      `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: base64Image },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          }],
        }),
      },
      15000
    )
    if (!res.ok) return null
    const data = await res.json()
    const text = data.responses?.[0]?.fullTextAnnotation?.text?.trim()
    return text || null
  } catch {
    return null
  }
}

async function callGemini(parts, generationConfig, GEMINI_API_KEY) {
  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro']
  let rateLimited = false

  for (const model of MODELS) {
    let res, data
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig,
            }),
          },
          15000
        )
      } catch {
        break
      }
      data = await res.json()
      const isRetryable = !res.ok && (
        res.status === 429 ||
        /high demand|quota|resource_exhausted|rate limit/i.test(data.error?.message || '')
      )
      if (isRetryable) rateLimited = true
      if (isRetryable && attempt < 1) {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      break
    }
    if (!res.ok) continue
    const responseParts = data.candidates?.[0]?.content?.parts || []
    const part = responseParts.find(p => p.text && !p.thought) || responseParts[responseParts.length - 1]
    const text = part?.text?.trim() || ''
    if (text) return text
  }

  if (rateLimited) throw new Error('AI service is busy right now — please try again in a moment')
  return ''
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export const config = { path: '/api/process-invoice' }
