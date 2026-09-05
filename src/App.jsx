import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthState } from './hooks/useAuthState'
import { ProjectProvider } from './contexts/ProjectContext'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Capture from './pages/Capture'
import Expenses from './pages/Expenses'
import PaymentSources from './pages/PaymentSources'
import Reconciliation from './pages/Reconciliation'
import CompanyReview from './pages/CompanyReview'
import Settings from './pages/Settings'
import Layout from './components/Layout'
import LoadingBar from './components/LoadingBar'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthState()
  if (loading) return <div className="page"><LoadingBar label="Loading…" /></div>
  if (!user) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
    <ProjectProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="upload" element={<Upload />} />
          <Route path="capture" element={<Capture />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="payment-sources" element={<PaymentSources />} />
          <Route path="reconciliation" element={<Reconciliation />} />
          <Route path="company-review" element={<CompanyReview />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </ProjectProvider>
    </BrowserRouter>
  )
}
