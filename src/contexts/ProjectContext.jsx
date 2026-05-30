import { createContext, useContext, useState, useEffect } from 'react'
import { collection, query, where, getDocs, onSnapshot, addDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '../firebase'

export const PROJECT_COLORS = {
  green:  { dot: '#276840', text: '#276840', bg: '#e4f2e9', dark: '#1a3a28', mid: '#2a5c3f', btn: '#38845a', btnHover: '#2d6e4a' },
  blue:   { dot: '#2a6099', text: '#2a5280', bg: '#dce8f5', dark: '#0d2a4a', mid: '#1a4a7a', btn: '#2a6099', btnHover: '#1a4070' },
  amber:  { dot: '#c47a10', text: '#7a5410', bg: '#f5edd4', dark: '#4a2a05', mid: '#9a6010', btn: '#c47a10', btnHover: '#9a6010' },
  purple: { dot: '#7a5aaa', text: '#5a3a8a', bg: '#ebe6f5', dark: '#2a1050', mid: '#5a3a8a', btn: '#7a5aaa', btnHover: '#5a3a8a' },
  slate:  { dot: '#718096', text: '#4a5568', bg: '#e8eaed', dark: '#2a3040', mid: '#576070', btn: '#718096', btnHover: '#4a5568' },
  teal:   { dot: '#0d9488', text: '#0f766e', bg: '#ccfbf1', dark: '#0a2e2c', mid: '#0f766e', btn: '#0d9488', btnHover: '#0f766e' },
  rose:   { dot: '#e11d48', text: '#be123c', bg: '#ffe4e6', dark: '#4c0519', mid: '#9f1239', btn: '#e11d48', btnHover: '#be123c' },
  orange: { dot: '#ea580c', text: '#c2410c', bg: '#ffedd5', dark: '#3a1a05', mid: '#c2410c', btn: '#ea580c', btnHover: '#c2410c' },
  indigo: { dot: '#4f46e5', text: '#4338ca', bg: '#e0e7ff', dark: '#1e1b4b', mid: '#3730a3', btn: '#4f46e5', btnHover: '#4338ca' },
  brown:  { dot: '#7c5c3a', text: '#5c4020', bg: '#f5e8d8', dark: '#3a2010', mid: '#5c4020', btn: '#7c5c3a', btnHover: '#5c4020' },
}

export const COLOR_KEYS = Object.keys(PROJECT_COLORS)

const ProjectContext = createContext(null)

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [activeProjectId, setActiveProjectId] = useState(() => localStorage.getItem('activeProjectId'))
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let projectUnsub = null

    const authUnsub = onAuthStateChanged(auth, user => {
      // Clean up previous project listener when user changes
      if (projectUnsub) { projectUnsub(); projectUnsub = null }

      if (!user) { setProjects([]); setLoading(false); return }

      setLoading(true)
      projectUnsub = onSnapshot(
        query(collection(db, 'projects'), where('userId', '==', user.uid)),
        async snap => {
          try {
            let list = snap.docs.map(d => ({ id: d.id, ...d.data() }))

            if (list.length === 0) {
              // First time: create Default project — onSnapshot will re-fire with it
              const ref = await addDoc(collection(db, 'projects'), {
                name: 'Default', userId: user.uid, color: 'green', createdAt: serverTimestamp(),
              })
              persistActiveId(ref.id)
              return
            }

            // Ensure saved activeProjectId is still valid
            const saved = localStorage.getItem('activeProjectId')
            if (!saved || !list.find(p => p.id === saved)) persistActiveId(list[0].id)

            // Migrate expenses that have no projectId — only run once per user per browser
            const migKey = `expenses_migrated_${user.uid}`
            if (!localStorage.getItem(migKey)) {
              const defaultProject = list.find(p => p.name === 'Default') || list[0]
              await migrateExpenses(user.uid, defaultProject.id)
              localStorage.setItem(migKey, '1')
            }

            setProjects(list)
          } catch (err) {
            console.error('ProjectContext error:', err.message)
          }
          setLoading(false)
        },
        err => {
          console.error('ProjectContext error:', err.message)
          setLoading(false)
        }
      )
    })

    return () => {
      authUnsub()
      if (projectUnsub) projectUnsub()
    }
  }, [])

  async function migrateExpenses(uid, projectId) {
    const snap = await getDocs(query(collection(db, 'expenses'), where('userId', '==', uid)))
    const toMigrate = snap.docs.filter(d => !d.data().projectId)
    for (let i = 0; i < toMigrate.length; i += 500) {
      const batch = writeBatch(db)
      toMigrate.slice(i, i + 500).forEach(d => batch.update(d.ref, { projectId }))
      await batch.commit()
    }
  }

  function persistActiveId(id) {
    setActiveProjectId(id)
    localStorage.setItem('activeProjectId', id)
  }

  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0] || null

  function updateProject(id, changes) {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p))
  }

  return (
    <ProjectContext.Provider value={{
      projects,
      activeProject,
      selectProject: persistActiveId,
      updateProject,
      reloadProjects: () => {}, // onSnapshot keeps projects in sync automatically
      loading,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
