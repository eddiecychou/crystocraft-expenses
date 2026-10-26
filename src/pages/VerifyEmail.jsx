import { useState } from 'react'
import { reload, sendEmailVerification, signOut } from 'firebase/auth'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { auth } from '../firebase'
import { useAuthState } from '../hooks/useAuthState'
import { requiresEmailVerification } from '../lib/emailVerification'

export default function VerifyEmail() {
  const { user, loading } = useAuthState()
  const location = useLocation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [sendFailed, setSendFailed] = useState(Boolean(location.state?.sendFailed))

  if (loading) return <div className="login-page" />
  if (!user) return <Navigate to="/login" replace />
  if (!requiresEmailVerification(user)) return <Navigate to="/" replace />

  async function checkVerification() {
    setError(''); setInfo(''); setBusy(true)
    try {
      await reload(user)
      if (user.emailVerified) {
        // A fresh auth listener must start the project/profile setup that was
        // deliberately skipped while this account was unverified.
        window.location.replace('/')
      } else {
        setInfo('Not verified yet. Open the link in your email, then try again.')
      }
    } catch {
      setError('Could not check your email right now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function resendVerification() {
    setError(''); setInfo(''); setBusy(true)
    try {
      await sendEmailVerification(user)
      setSendFailed(false)
      setInfo('Verification email sent. Check your inbox and spam folder.')
    } catch {
      setError('Could not send the email right now. Please wait a moment and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function useAnotherEmail() {
    setError(''); setBusy(true)
    try {
      await signOut(auth)
      navigate('/login', { replace: true })
    } catch {
      setError('Could not sign out right now. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Check your email</h1>
        <p className="login-verify-copy">{sendFailed ? 'Your account was created, but we could not send a verification link to ' : 'We sent a verification link to '}<strong>{user.email}</strong>. {sendFailed ? 'Try “Resend email” below.' : 'Open it to finish setting up your account.'}</p>
        <p className="login-verify-copy">Check the address carefully. If it is wrong, choose “Use another email” below.</p>
        {error && <div className="error-msg">{error}</div>}
        {info && <div className="info-msg">{info}</div>}
        <button type="button" className="login-submit" disabled={busy} onClick={checkVerification}>I’ve verified my email</button>
        <div className="login-verify-actions">
          <button type="button" disabled={busy} onClick={resendVerification}>Resend email</button>
          <button type="button" disabled={busy} onClick={useAnotherEmail}>Use another email</button>
        </div>
      </div>
    </div>
  )
}
