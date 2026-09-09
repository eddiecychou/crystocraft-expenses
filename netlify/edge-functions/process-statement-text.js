// Tier-3 fallback for bank/credit-card statement PDFs: pdfStatementParser.js's
// column-position parser (tier 1) and its single-line regex fallback (tier 2)
// both work off the statement's own printed table layout, which varies
// bank-to-bank — a customer's statement from a bank this app has never seen
// can legitimately produce zero rows from either. Rather than dead-end there,
// this takes the same page text pdf.js already extracted (no image, no
// second OCR pass — the PDF is digital-text by definition if tier 1/2 even
// got this far) and asks Gemini to read it as a transaction table, the same
// docKind-driven structured-extraction pattern process-invoice.js already
// uses for invoices/POs (chosen there specifically because customer document
// layouts vary; the same reasoning applies here once a statement's layout is
// unrecognized).
//
// Deliberately NOT a blind-trust path: parsePdfStatement() marks every row
// this produces with extractionMethod: 'ai_assisted', and the caller (same as
// tier 1/2) still runs it through validateStatementTotals() and the existing
// mandatory review-before-import panel in PaymentSources.jsx — the
// opening+net=closing arithmetic check is what actually catches a wrong
// answer, not which method produced the rows. See LESSONS_LEARNED.md.
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
  const FIREBASE_API_KEY = Deno.env.get('VITE_FIREBASE_API_KEY')
  if (!GEMINI_API_KEY || !FIREBASE_API_KEY) return json({ error: 'Server misconfiguration' }, 500)

  try {
    const { text, idToken } = await req.json()
    if (!text || !text.trim()) return json({ error: 'Missing statement text' }, 400)

    // Signed-in Finance app users only — same Identity Toolkit check as
    // process-receipt.js/process-invoice.js.
    if (!idToken) return json({ error: 'Not signed in' }, 401)
    const verRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    })
    const verData = await verRes.json()
    if (!verRes.ok || !verData.users?.[0]) return json({ error: 'Unauthorized' }, 401)

    // Text-only extraction, no image round-trip — cheaper, and the input is
    // already a clean text layer pdf.js pulled from a digital PDF.
    const raw = await callGemini(
      [{ text: `Statement text:\n\n${text.slice(0, 30000)}\n\n${EXTRACTION_PROMPT}` }],
      { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      GEMINI_API_KEY
    )

    if (!raw) return json({ rows: [] })

    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        return json({ rows: Array.isArray(parsed.rows) ? parsed.rows : [] })
      } catch {}
    }

    return json({ rows: [] })
  } catch (err) {
    return json({ error: err.message || 'Processing failed' }, 500)
  }
}

// The framework this app already applies to every statement, regardless of
// which tier produced the rows: date, one merchant/description line, exactly
// one settlement amount with a clear direction, and (when printed) a running
// balance — see pdfStatementParser.js's own header comment for why these are
// the fields that matter for a statement specifically. Full YYYY-MM-DD dates
// requested directly (Gemini has the whole document's text, including any
// year-bearing statement date, so it can resolve a year-less "23 Jul" itself
// — no anchor-date post-processing needed here).
const EXTRACTION_PROMPT = `You are an expert bank/credit-card statement parser. Extract every individual transaction line from this statement and return ONLY a valid JSON object with no markdown, code fences, or extra text.

{
  "rows": [
    {
      "date": "YYYY-MM-DD (resolve the year from the statement's own printed date/period if the transaction line only shows day+month)",
      "description": "the transaction's merchant/description text, as printed",
      "amount": <the transaction's settlement amount as a positive number>,
      "direction": "credit if money came IN (payment received, refund, deposit) or debit if money went OUT (purchase, withdrawal, fee) — from the account holder's point of view",
      "balanceAfter": <the running balance printed immediately after this transaction, as a number, or null if no balance column is printed>
    }
  ]
}

Rules:
- One entry per real transaction line. Skip headers, page totals, "minimum payment due" boxes, marketing text, and opening/closing balance restatement lines (those are not transactions).
- If a description spans multiple printed lines before its amount, merge it into one "description" string.
- Never invent a transaction that isn't printed. If you can't confidently parse a line, omit it rather than guessing.`

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Same model-fallback + retry shape as process-receipt.js/process-invoice.js.
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
          25000
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
    const responseText = part?.text?.trim() || ''
    if (responseText) return responseText
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

export const config = { path: '/api/process-statement-text' }
