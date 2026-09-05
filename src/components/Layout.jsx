import { useState } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import { useProject, PROJECT_COLORS } from '../contexts/ProjectContext'

export default function Layout() {
  const navigate = useNavigate()
  const { activeProject } = useProject()
  const c = PROJECT_COLORS[activeProject?.color] || PROJECT_COLORS.green
  const [moreOpen, setMoreOpen] = useState(false)

  async function handleLogout() {
    await signOut(auth)
    navigate('/login')
  }

  const navItemClass = ({ isActive }) => `mobile-nav-item${isActive ? ' active' : ''}`

  return (
    <div className="app-layout" style={{
      '--t-dark': c.dark,
      '--t-mid': c.mid,
      '--t-btn': c.btn,
      '--t-btn-hover': c.btnHover,
    }}>
      {/* Desktop sidebar — every destination visible at once; desktop has
          the room, so this is left as-is. */}
      <nav className="sidebar desktop-only">
        <div className="logo">Expense<br />Organiser</div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/upload">Upload</NavLink>
        <NavLink to="/expenses">Records</NavLink>
        <NavLink to="/payment-sources">Payments</NavLink>
        <NavLink to="/reconciliation">Reconcile</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <button onClick={handleLogout} className="logout-btn">Logout</button>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>

      {/* Mobile bottom nav — capped at 4 top-level destinations. A tab bar
          is for top-level navigation, not a dumping ground for every route
          (and never for in-page actions like Confirm Match, which live in
          each page's own action bar). Everything else lives in More. */}
      <nav className="mobile-bottom-nav">
        <NavLink to="/" end className={navItemClass} onClick={() => setMoreOpen(false)}>
          <span className="mobile-nav-icon" aria-hidden="true">🏠</span>
          <span>Overview</span>
        </NavLink>
        <NavLink to="/capture" className={navItemClass} onClick={() => setMoreOpen(false)}>
          <span className="mobile-nav-icon" aria-hidden="true">📸</span>
          <span>Capture</span>
        </NavLink>
        <NavLink to="/reconciliation" className={navItemClass} onClick={() => setMoreOpen(false)}>
          <span className="mobile-nav-icon" aria-hidden="true">✅</span>
          <span>Reconcile</span>
        </NavLink>
        <button
          type="button"
          className={`mobile-nav-item${moreOpen ? ' is-active' : ''}`}
          onClick={() => setMoreOpen(o => !o)}
          aria-expanded={moreOpen}
          aria-label="More"
        >
          <span className="mobile-nav-icon" aria-hidden="true">⋯</span>
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <>
          <div className="mobile-sheet-backdrop" onClick={() => setMoreOpen(false)} />
          <div className="mobile-sheet" role="menu">
            <NavLink to="/expenses" className="mobile-sheet-item" onClick={() => setMoreOpen(false)}>Records</NavLink>
            <NavLink to="/payment-sources" className="mobile-sheet-item" onClick={() => setMoreOpen(false)}>Payments</NavLink>
            <NavLink to="/settings" className="mobile-sheet-item" onClick={() => setMoreOpen(false)}>Settings</NavLink>
            <button type="button" className="mobile-sheet-item mobile-sheet-danger" onClick={handleLogout}>Logout</button>
          </div>
        </>
      )}
    </div>
  )
}
