import { useState, useEffect } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../firebase'

export function useAuthState() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setLoading(false)
      // Firebase Auth has no client-safe way to look up a uid by email — a
      // small profile doc is what lets project sharing resolve "invite this
      // email" to a uid. Merge so this is always current without clobbering
      // anything else ever added to the doc; cheap and idempotent on every
      // sign-in.
      if (u) {
        setDoc(doc(db, 'users', u.uid), {
          email: u.email,
          displayName: u.displayName || null,
          updatedAt: serverTimestamp(),
        }, { merge: true }).catch(err => console.warn('Could not update user profile:', err.message))
      }
    })
    return unsubscribe
  }, [])

  return { user, loading }
}
