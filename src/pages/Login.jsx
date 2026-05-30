import { useState } from 'react'
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail
} from 'firebase/auth'
import { auth } from '../firebase'
import { useNavigate } from 'react-router-dom'

const googleProvider = new GoogleAuthProvider()

export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setInfo('')
    setLoading(true)
    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email, password)
      } else {
        await signInWithEmailAndPassword(auth, email, password)
      }
      navigate('/')
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') setError('An account with this email already exists.')
      else if (err.code === 'auth/weak-password') setError('Password must be at least 6 characters.')
      else if (['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential'].includes(err.code)) setError('Invalid email or password.')
      else setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError(''); setInfo('')
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
      navigate('/')
    } catch (err) {
      if (err.code === 'auth/unauthorized-domain') {
        setError('This domain is not authorised. Add it in Firebase → Authentication → Authorized domains.')
      } else if (err.code !== 'auth/popup-closed-by-user') {
        setError(`Sign-in failed: ${err.code}`)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleForgotPassword() {
    setError(''); setInfo('')
    if (!email.trim()) { setError('Enter your email address above first.'); return }
    try {
      await sendPasswordResetEmail(auth, email)
      setInfo('Password reset email sent — check your inbox.')
    } catch {
      setError('Could not send reset email. Check the address and try again.')
    }
  }

  function switchMode(m) { setMode(m); setError(''); setInfo('') }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{mode === 'signup' ? 'Sign up for an Account' : 'Sign in to Your Account'}</h1>

        <button onClick={handleGoogle} disabled={loading} className="btn-google">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
            <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          {mode === 'signup' ? 'Sign up with Google' : 'Sign in with Google'}
        </button>

        <div className="login-divider"><span>or</span></div>

        <form onSubmit={handleSubmit}>
          <label className="login-label">
            Email Address
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="login-label">
            Password
            <input
              type="password"
              placeholder={mode === 'signup' ? 'Min 6 characters' : '••••••••'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </label>
          {mode === 'signin' && (
            <button type="button" className="login-forgot" onClick={handleForgotPassword}>
              Forgotten password?
            </button>
          )}
          {error && <div className="error-msg">{error}</div>}
          {info  && <div className="info-msg">{info}</div>}
          <button type="submit" disabled={loading} className="login-submit">
            {loading ? '…' : mode === 'signup' ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <div className="login-switch">
          {mode === 'signin'
            ? <>Need an Account? <button type="button" onClick={() => switchMode('signup')}>Sign up</button></>
            : <>Already have an account? <button type="button" onClick={() => switchMode('signin')}>Sign in</button></>
          }
        </div>
      </div>
    </div>
  )
}
