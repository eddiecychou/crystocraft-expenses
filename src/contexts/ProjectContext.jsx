import { createContext, useContext, useState, useEffect } from 'react'
import { collection, query, where, getDocs, addDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '../firebase'

export const PROJECT_COLORS = {
  green:  { dot: '#276840', text: '#276840', bg: '#e4f2e9' },
  blue:   { dot: '#2a6099', text: '#2a5280', bg: '#dce8f5' },
  amber:  { dot: '#c47a10', text: '#7a5410', bg: '#f5edd4' },
  purple: { dot: '#7a5aaa', text: '#5a3a8a', bg: '#ebe6f5' },
  slate:  { dot: '#718096', text: '#4a5568', bg: '#e8eaed' },
}

export const COLOR_KEYS = Object.keys(PROJECT_COLORS)

const ProjectContext = createContext(null)

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [activeProjectId, setActiveProjectId] = useState(() => localStorage.getItem('activeProjectId'))
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user) loadProjects(user.uid)
      else { setProjects([]); setLoading(false) }
    })
    return unsub
  }, [])

  async function loadProjects(uid) {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'projects'), where('userId', '==', uid)))
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }))

      if (list.length === 0) {
        // First time: create Default project
        const ref = await addDoc(collection(db, 'projects'), {
          name: 'Default', userId: uid, color: 'green', createdAt: serverTimestamp(),
        })
        list = [{ id: ref.id, name: 'Default', userId: uid, color: 'green' }]
        persistActiveId(ref.id)
      } else {
        // Ensure saved activeProjectId is still valid
        const saved = localStorage.getItem('activeProjectId')
        if (!saved || !list.find(p => p.id === saved)) persistActiveId(list[0].id)
      }

      // Always migrate any expenses that still have no projectId
      // (idempotent — skips expenses already migrated)
      const defaultProject = list.find(p => p.name === 'Default') || list[0]
      await migrateExpenses(uid, defaultProject.id)

      setProjects(list)
    } catch (err) {
      console.error('ProjectContext error:', err.message)
    }
    setLoading(false)
  }

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

  return (
    <ProjectContext.Provider value={{
      projects,
      activeProject,
      selectProject: persistActiveId,
      reloadProjects: () => auth.currentUser && loadProjects(auth.currentUser.uid),
      loading,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
