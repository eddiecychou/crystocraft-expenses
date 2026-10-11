// Vision uses image pixels from the top-left; the statement parser expects
// PDF points from the bottom-left. Keep this conversion independent of APIs.
export function wordsToStatementLines(words, pageWidth, pageHeight, imageWidth, imageHeight) {
  const items = words.map(word => ({
    x: word.x * pageWidth / imageWidth,
    y: pageHeight - word.y * pageHeight / imageHeight,
    text: word.text.trim(),
  })).filter(item => item.text && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of items) {
    const line = lines.find(candidate => Math.abs(candidate.y - item.y) <= 7)
    if (line) line.items.push({ x: item.x, text: item.text })
    else lines.push({ y: item.y, items: [{ x: item.x, text: item.text }] })
  }
  return lines.sort((a, b) => b.y - a.y).map(line => {
    line.items.sort((a, b) => a.x - b.x)
    return { ...line, text: line.items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim() }
  })
}
