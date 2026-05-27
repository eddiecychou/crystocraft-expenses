import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyAOa7SDLRau9bzL7SIL-bqOZLxRrF5RtFA",
  authDomain: "crystocraft-expenses.firebaseapp.com",
  projectId: "crystocraft-expenses",
  storageBucket: "crystocraft-expenses.firebasestorage.app",
  messagingSenderId: "375896159386",
  appId: "1:375896159386:web:9886aeeb7a8d0bd7895b23",
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
