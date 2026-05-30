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

  try {
    const { fileData, mimeType } = await req.json()
    if (!fileData || !mimeType) return json({ error: 'Missing file data' }, 400)

    const prompt = `You are an expert receipt parser. Extract expense details from this receipt image and return ONLY a valid JSON object with no markdown, code fences, or extra text.

{
  "date": "YYYY-MM-DD or null",
  "vendor": "merchant or business name, or null",
  "amount": <final total amount actually paid, including tax and service charge — NOT subtotal or any individual line item, as a number or null>,
  "currency": "HKD or RMB or USD or EUR or JPY or AUD or GBP or SGD or CAD or KRW or Other or null",
  "category": "one of: Travel, Meals, Office, Software, Utilities, Development, Marketing, Professional Services, Equipment, Bank Charges, Other",
  "notes": "brief description of what was purchased (items or service), or null"
}

Currency rules: HK$ or HKD = HKD | ¥ or RMB or CNY or 人民币 = RMB | $ or USD = USD | € = EUR | JP¥ or JPY = JPY | A$ = AUD | £ = GBP | S$ = SGD | C$ = CAD | ₩ = KRW. Default to HKD if unclear.
Category rules: flights/trains/taxis/hotels = Travel | restaurants/cafes/food = Meals | stationery/supplies = Office | apps/subscriptions/SaaS = Software | electricity/internet/phone = Utilities | coding/tech tools/hosting/domains = Development | ads/promotions/print materials = Marketing | accounting/legal/consulting fees = Professional Services | hardware/machinery/tools = Equipment | bank fees/wire transfer/FX fees = Bank Charges | anything else = Other.
Amount rules: use the line labelled "Total", "Grand Total", "Amount Due", or "Total Paid". Ignore subtotals, tax lines shown separately, and individual item prices.`

    const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro']
    let text = ''
    const errors = []

    for (const model of MODELS) {
      let res, data
      for (let attempt = 0; attempt <= 1; attempt++) {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: [
                  { inlineData: { mimeType, data: fileData } },
                  { text: prompt },
                ],
              }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
            }),
          }
        )
        data = await res.json()
        const isHighDemand = !res.ok && (data.error?.message || '').includes('high demand')
        if (isHighDemand && attempt === 0) {
          await new Promise(r => setTimeout(r, 3000))
          continue
        }
        break
      }
      if (!res.ok) {
        errors.push(`${model}: ${data.error?.message || res.status}`)
        continue
      }
      const parts = data.candidates?.[0]?.content?.parts || []
      const part = parts.find(p => p.text && !p.thought) || parts[parts.length - 1]
      text = part?.text || ''
      if (text) break
      errors.push(`${model}: empty response`)
    }

    if (!text) return json({ error: `AI extraction failed. ${errors.join(' | ')}` }, 502)

    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return json(JSON.parse(match[0])) } catch {}
    }

    // Parsing failed — return blank form so user can fill in manually
    return json({ date: null, vendor: null, amount: null, currency: 'HKD', category: 'Other', notes: 'AI could not parse — please fill in manually' })
  } catch (err) {
    return json({ error: err.message || 'Processing failed' }, 500)
  }
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
