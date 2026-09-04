import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { storage } from './firebase'

/**
 * Upload the original statement file (CSV or PDF) exactly as received — no
 * compression or re-encoding, since this is the source-of-record document
 * for audit trail, not a display thumbnail. Returns { url, path } to store
 * on the paymentImports doc.
 */
export async function uploadStatementFile(file, userId, importId) {
  const ext = file.name.split('.').pop() || 'bin'
  const path = `statements/${userId}/${importId}/source.${ext}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' })
  const url = await getDownloadURL(storageRef)
  return { url, path }
}

export async function deleteStatementFile(storagePath) {
  await deleteObject(ref(storage, storagePath))
}
