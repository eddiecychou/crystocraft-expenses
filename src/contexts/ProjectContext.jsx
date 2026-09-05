import { createContext, useContext, useState, useEffect } from 'react'
import { collection, query, where, getDocs, onSnapshot, addDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '../firebase'

// Client/project IDENTITY color only — a dot, a left-border accent, a
// badge tint. It no longer drives the sidebar/button brand theme (see
// Layout.jsx and CLAUDE convention: --t-* in App.css is now a single fixed
// app-wide brand, not per-project) — identity color and action color must
// never be the same thing, or "Needs Review" amber next to a rose-colored
// client becomes ambiguous. The original 10 keys are kept byte-for-byte
// unchanged (existing projects already have one of these assigned; their
// dot/text/bg must not silently shift) — dark/mid/btn/btnHover on those
// entries are now unused dead fields, left in place rather than stripped
// out of data nobody asked to touch. New entries added below only carry
// the fields that are actually read (dot/text/bg/label).
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

  // Added: muted, low-saturation identity colors for bookkeepers managing
  // many clients — distinguishable without looking like a rainbow of
  // system-status colors.
  oxblood:     { label: 'Oxblood',     dot: '#7F2937', text: '#5A1D28', bg: '#F5E7E9' },
  burgundy:    { label: 'Burgundy',    dot: '#8E3B46', text: '#642832', bg: '#F7E9EB' },
  terracotta:  { label: 'Terracotta',  dot: '#B7654A', text: '#7A4030', bg: '#FAEEE9' },
  oliveStone:  { label: 'Olive Stone', dot: '#7E8050', text: '#545631', bg: '#F0F1E2' },
  pine:        { label: 'Pine',        dot: '#356B62', text: '#244D47', bg: '#E2F0ED' },
  eucalyptus:  { label: 'Eucalyptus',  dot: '#5D9184', text: '#3F655D', bg: '#E8F3F0' },
  petrol:      { label: 'Petrol',      dot: '#2F6268', text: '#254B50', bg: '#E3EFF0' },
  slateTeal:   { label: 'Slate Teal',  dot: '#526F78', text: '#3B5057', bg: '#E8EEF0' },
  stormBlue:   { label: 'Storm Blue',  dot: '#506A83', text: '#374A5D', bg: '#E8EEF5' },
  denimDust:   { label: 'Denim Dust',  dot: '#4C6D91', text: '#354D6A', bg: '#E8EEF7' },
  aubergine:   { label: 'Aubergine',   dot: '#654A68', text: '#49354B', bg: '#EFE8F0' },
  plumSmoke:   { label: 'Plum Smoke',  dot: '#79536F', text: '#573B51', bg: '#F2E9F0' },
  cocoa:       { label: 'Cocoa',       dot: '#755A50', text: '#503D36', bg: '#F1EBE7' },
  graphite:    { label: 'Graphite',    dot: '#59616A', text: '#3D444B', bg: '#EAEDF0' },
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
