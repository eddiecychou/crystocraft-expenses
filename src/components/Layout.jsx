import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'

export default function Layout() {
  const navigate = useNavigate()

  async function handleLogout() {
    await signOut(auth)
    navigate('/login')
  }

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="logo">Crystocraft<br />Expenses</div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/upload">Upload</NavLink>
        <NavLink to="/expenses">Expenses</NavLink>
        <NavLink to="/export">Export</NavLink>
        <button onClick={handleLogout} className="logout-btn">Logout</button>
      </nav>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
