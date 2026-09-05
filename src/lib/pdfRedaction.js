// Produces a visually redacted copy of a statement PDF: every page is
// rasterized and non-included transaction rows are painted over with a
// solid black rectangle before reassembly. Rasterizing (rather than just
// drawing a rectangle on top of the live PDF content) is deliberate — real
// redaction tools do the same, because a shape drawn over vector PDF text
// without flattening leaves that text still selectable/copyable underneath
// it, which is a worse failure than no redaction at all. See
// LESSONS_LEARNED.md.
//
// Mask geometry (maskRect per row) comes from pdfStatementParser.js's
// parsePdfStatement — this module only knows how to paint rectangles and
// reassemble pages, not how to find rows on a statement.

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const RENDER_SCALE = 2 // rasterization scale — legible output without an excessive file size

// maskRects: [{ page, x0, x1, yTop, yBottom }, ...] in PDF point space
// (origin bottom-left, y increases upward — matches pdfStatementParser.js).
export async function maskPdfPages(fileBlob, maskRects) {
  const buf = await fileBlob.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise
  const outDoc = await PDFDocument.create()

  const rectsByPage = new Map()
  for (const r of maskRects) {
    if (!rectsByPage.has(r.page)) rectsByPage.set(r.page, [])
    rectsByPage.get(r.page).push(r)
  }

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: RENDER_SCALE })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise

    ctx.fillStyle = '#000000'
    for (const rect of rectsByPage.get(pageNum) || []) {
      // convertToViewportPoint handles pdf.js's bottom-left-origin/y-flip
      // and the render scale correctly — hand-rolling this math is exactly
      // the kind of thing that silently misaligns by a page's height.
      const [vx0, vy0] = viewport.convertToViewportPoint(rect.x0, rect.yTop)
      const [vx1, vy1] = viewport.convertToViewportPoint(rect.x1, rect.yBottom)
      const x = Math.min(vx0, vx1)
      const y = Math.min(vy0, vy1)
      const w = Math.abs(vx1 - vx0)
      const h = Math.abs(vy1 - vy0)
      ctx.fillRect(x, y, w, h)
    }

    const pngBytes = await new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('canvas.toBlob failed')); return }
        blob.arrayBuffer().then(resolve, reject)
      }, 'image/png')
    })

    const pageOriginal = page.getViewport({ scale: 1 })
    const image = await outDoc.embedPng(pngBytes)
    const outPage = outDoc.addPage([pageOriginal.width, pageOriginal.height])
    outPage.drawImage(image, { x: 0, y: 0, width: pageOriginal.width, height: pageOriginal.height })
  }

  const outBytes = await outDoc.save()
  return new Blob([outBytes], { type: 'application/pdf' })
}
