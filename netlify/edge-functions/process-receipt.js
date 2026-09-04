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
    const { fileData, mimeType } = await req.json()
    if (!fileData || !mimeType) return json({ error: 'Missing file data' }, 400)

    // Step 1 — transcribe every line of text from the receipt image.
    // Working from explicit text in step 2 is far more reliable than asking
    // the model to read and reason at the same time.
    // Preferred reader: Google Cloud Vision DOCUMENT_TEXT_DETECTION — a dedicated
    // OCR that reads text faithfully and never invents content. It falls back to
    // Gemini transcription if the Vision key is unset or Vision fails on an image.
    // PDFs skip transcription entirely — Gemini extracts from them directly
    // (Vision's sync images:annotate endpoint does not accept PDFs).
    let transcript = null
    if (mimeType !== 'application/pdf') {
      if (VISION_API_KEY) transcript = await callVisionOCR(fileData, VISION_API_KEY)
      if (!transcript) transcript = await callGemini(
        [
          { inlineData: { mimeType, data: fileData } },
          { text: 'Transcribe every line of text visible on this receipt exactly as printed, top to bottom. Preserve all numbers, currency symbols, and punctuation. Output plain text only, no commentary.' },
        ],
        // thinkingBudget:0 disables gemini-2.5-flash's internal "thinking", which
        // otherwise consumes the whole maxOutputTokens budget and returns an empty
        // response (MAX_TOKENS) for some receipts — the cause of silent failures.
        { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        GEMINI_API_KEY
      )
    }

    // Step 2 — extract structured fields.
    // If transcription succeeded: send text only (no image) — faster and cheaper.
    // If transcription failed: fall back to sending the image directly.
    const extractionParts = transcript
      ? [{ text: `Receipt text:\n\n${transcript}\n\n${EXTRACTION_PROMPT}` }]
      : [{ inlineData: { mimeType, data: fileData } }, { text: EXTRACTION_PROMPT }]

    const raw = await callGemini(
      extractionParts,
      { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      GEMINI_API_KEY
    )

    if (!raw) return json({ date: null, vendor: null, amount: null, currency: 'HKD', category: 'Other', notes: 'AI could not parse — please fill in manually' })

    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { return json(JSON.parse(match[0])) } catch {}
    }

    return json({ date: null, vendor: null, amount: null, currency: 'HKD', category: 'Other', notes: 'AI could not parse — please fill in manually' })
  } catch (err) {
    return json({ error: err.message || 'Processing failed' }, 500)
  }
}

// Shared extraction prompt — used whether input is a transcript or a raw image.
const EXTRACTION_PROMPT = `You are an expert receipt parser. Extract expense details from this receipt and return ONLY a valid JSON object with no markdown, code fences, or extra text.

{
  "date": "YYYY-MM-DD or null",
  "vendor": "merchant or business name, or null",
  "amount": <final total amount actually paid, including tax and service charge — NOT subtotal or any individual line item, as a number or null>,
  "currency": "HKD or RMB or USD or EUR or JPY or AUD or GBP or SGD or CAD or KRW or Other or null",
  "category": "one of: Travel, Meals, Office, Software, Utilities, Development, Marketing, Professional Services, Equipment, Bank Charges, Production, Other",
  "notes": "brief description of what was purchased (items or service), or null",
  "paymentMethod": "one of: Credit Card HK, Bank Account HK, Alipay, WeChat Pay, Bank Account CN, Cash, or null if not shown"
}

Currency rules: HK$ or HKD = HKD | ¥ or RMB or CNY or 人民币 = RMB | $ or USD = USD | € = EUR | JP¥ or JPY = JPY | A$ = AUD | £ = GBP | S$ = SGD | C$ = CAD | ₩ = KRW. Default to HKD if unclear.
Category rules: flights/trains/taxis/hotels = Travel | restaurants/cafes/food = Meals | stationery/supplies = Office | apps/subscriptions/SaaS = Software | electricity/internet/phone = Utilities | coding/tech tools/hosting/domains = Development | ads/promotions/print materials = Marketing | accounting/legal/consulting fees = Professional Services | hardware/machinery/tools = Equipment | bank fees/wire transfer/FX fees = Bank Charges | production materials/props/sets/costumes/crew/studio hire = Production | anything else = Other.
Payment method rules: Visa/Mastercard/AMEX/credit card with HKD or HK address = Credit Card HK | 支付宝 or Alipay = Alipay | 微信支付 or WeChat Pay = WeChat Pay | bank transfer/wire in HKD = Bank Account HK | bank transfer/wire in RMB/CNY = Bank Account CN | 现金 or cash = Cash | default to null if unclear.
Amount rules: use the line labelled "Total", "Grand Total", "Amount Due", or "Total Paid". Ignore subtotals, tax lines shown separately, and individual item prices.`

// Reads text from an image with Google Cloud Vision DOCUMENT_TEXT_DETECTION.
// Returns the full transcript, or null on any failure so the caller can fall
// back to Gemini transcription. Uses the REST + API-key path (no service
// account), which is the simplest option for an edge function.
async function callVisionOCR(base64Image, VISION_API_KEY) {
  try {
    const res = await fetch(
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
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const text = data.responses?.[0]?.fullTextAnnotation?.text?.trim()
    return text || null
  } catch {
    return null
  }
}

// Calls Gemini with model fallback (flash → pro) and retries on high-demand
// or rate-limit/quota errors (with backoff). Returns the response text, or
// throws if every model/attempt is exhausted due to rate-limiting, so the
// caller can surface a real error instead of silently returning blank fields.
async function callGemini(parts, generationConfig, GEMINI_API_KEY) {
  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro']
  let rateLimited = false

  for (const model of MODELS) {
    let res, data
    for (let attempt = 0; attempt <= 2; attempt++) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig,
          }),
        }
      )
      data = await res.json()
      const isRetryable = !res.ok && (
        res.status === 429 ||
        /high demand|quota|resource_exhausted|rate limit/i.test(data.error?.message || '')
      )
      if (isRetryable) rateLimited = true
      if (isRetryable && attempt < 2) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
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

export const config = { path: '/api/process-receipt' }
