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

    const prompt = `Extract expense details from this receipt and return ONLY a valid JSON object with no markdown or extra text:
{
  "date": "YYYY-MM-DD or null",
  "vendor": "merchant name or null",
  "amount": number or null,
  "currency": "HKD or RMB or USD or null",
  "category": "one of: Travel, Meals, Office, Software, Utilities, Other",
  "notes": "brief description of purchase or null"
}
Currency detection: HK$ or HKD = HKD, ¥ or RMB or CNY or 人民币 = RMB, $ = USD. Default to HKD if unclear.`

    const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
    let text = ''

    let lastError = ''
    for (const model of MODELS) {
      const res = await fetch(
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
      const data = await res.json()
      if (!res.ok) {
        lastError = `${model}: ${data.error?.message || res.status}`
        continue
      }
      const parts = data.candidates?.[0]?.content?.parts || []
      const part = parts.find(p => p.text && !p.thought) || parts[parts.length - 1]
      text = part?.text || ''
      if (text) break
    }

    if (!text) return json({ error: `AI extraction failed. ${lastError}` }, 502)

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return json({ error: 'Could not parse AI response' }, 502)

    return json(JSON.parse(match[0]))
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
