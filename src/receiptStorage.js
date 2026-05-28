import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { storage } from './firebase'

const MAX_IMAGES = 5
const MAX_DIMENSION = 1400  // px — produces roughly 500KB–1MB JPEG for typical receipts
const JPEG_QUALITY = 0.80

/**
 * Compress an image File to ~1MB JPEG using OffscreenCanvas.
 * Falls back to the original file if compression fails (e.g. for PDFs).
 */
async function compressForStorage(file) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (isPdf) return { blob: file, mimeType: 'application/pdf', ext: 'pdf' }

  try {
    const bitmap = await createImageBitmap(file)
    let { width, height } = bitmap
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      if (width > height) { height = Math.round(height * MAX_DIMENSION / width); width = MAX_DIMENSION }
      else { width = Math.round(width * MAX_DIMENSION / height); height = MAX_DIMENSION }
    }
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    return { blob, mimeType: 'image/jpeg', ext: 'jpg' }
  } catch {
    // createImageBitmap failed (e.g. HEIC) — store original bytes
    const buf = await file.arrayBuffer()
    const blob = new Blob([buf], { type: file.type || 'application/octet-stream' })
    const ext = file.name.split('.').pop() || 'bin'
    return { blob, mimeType: file.type, ext }
  }
}

/**
 * Upload a receipt image to Firebase Storage.
 * Returns { url, path, name } to store in Firestore.
 *
 * @param {File} file        - The file to upload
 * @param {string} userId    - Current user's UID
 * @param {string} expenseId - Firestore document ID of the expense
 * @param {number} index     - Position in the images array (0–4)
 */
export async function uploadReceiptImage(file, userId, expenseId, index) {
  const { blob, mimeType, ext } = await compressForStorage(file)
  const path = `receipts/${userId}/${expenseId}/image${index}.${ext}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, blob, { contentType: mimeType })
  const url = await getDownloadURL(storageRef)
  return { url, path, name: file.name }
}

/**
 * Delete a receipt image from Firebase Storage.
 * @param {string} storagePath - The `path` value stored in Firestore
 */
export async function deleteReceiptImage(storagePath) {
  await deleteObject(ref(storage, storagePath))
}

export { MAX_IMAGES }
