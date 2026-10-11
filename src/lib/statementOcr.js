import { auth } from '../firebase'
import { wordsToStatementLines } from './statementOcrGeometry'

export async function ocrStatementPage(page) {
  const unitViewport = page.getViewport({ scale: 1 })
  const scale = Math.min(2, 2200 / Math.max(unitViewport.width, unitViewport.height))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const imageWidth = canvas.width
  const imageHeight = canvas.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  const image = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  canvas.width = 0
  canvas.height = 0

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  let response
  try {
    response = await fetch('/api/ocr-statement-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, idToken: await auth.currentUser.getIdToken() }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('OCR timed out for this page')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'OCR failed for this page')
  return wordsToStatementLines(result.words || [], unitViewport.width, unitViewport.height, imageWidth, imageHeight)
}
