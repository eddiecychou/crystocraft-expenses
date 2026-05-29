import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import { useProject, PROJECT_COLORS } from '../contexts/ProjectContext'

export default function Layout() {
  const navigate = useNavigate()
  const { activeProject } = useProject()
  const c = PROJECT_COLORS[activeProject?.color] || PROJECT_COLORS.green

  async function handleLogout() {
    await signOut(auth)
    navigate('/login')
  }

  return (
    <div className="app-layout" style={{
      '--t-dark': c.dark,
      '--t-mid': c.mid,
      '--t-btn': c.btn,
      '--t-btn-hover': c.btnHover,
    }}>
      <nav className="sidebar">
        <div className="logo">Expense<br />Organiser</div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/upload">Upload</NavLink>
        <NavLink to="/expenses">Records</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <button onClick={handleLogout} className="logout-btn">Logout</button>
      </nav>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
