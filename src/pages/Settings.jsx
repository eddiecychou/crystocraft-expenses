import { useState } from 'react'
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject, PROJECT_COLORS, COLOR_KEYS } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'

export default function Settings() {
  const { projects, activeProject, selectProject, updateProject, reloadProjects } = useProject()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('green')
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('green')
  const [saving, setSaving] = useState(false)

  async function createProject() {
    if (!newName.trim()) return
    setSaving(true)
    await addDoc(collection(db, 'projects'), {
      name: newName.trim(),
      userId: auth.currentUser.uid,
      color: newColor,
      createdAt: serverTimestamp(),
    })
    await reloadProjects()
    setNewName(''); setNewColor('green'); setCreating(false); setSaving(false)
  }

  async function saveEdit() {
    if (!editName.trim()) return
    setSaving(true)
    await updateDoc(doc(db, 'projects', editId), { name: editName.trim(), color: editColor })
    updateProject(editId, { name: editName.trim(), color: editColor })
    setEditId(null); setSaving(false)
  }

  async function deleteProject(p) {
    if (!confirm(`Delete "${p.name}"? Its expenses will remain but won't appear until reassigned.`)) return
    await deleteDoc(doc(db, 'projects', p.id))
    if (activeProject?.id === p.id) {
      const remaining = projects.filter(x => x.id !== p.id)
      if (remaining.length) selectProject(remaining[0].id)
    }
    await reloadProjects()
  }

  function startEdit(p) { setEditId(p.id); setEditName(p.name); setEditColor(p.color) }

  return (
    <div className="page">
      <ProjectBanner />
      <h2>Settings</h2>

      <div className="settings-section">
        <h3 className="settings-section-title">Projects</h3>
        <p className="hint">Create a project for each company to keep expenses separate.</p>

        <div className="project-list">
          {projects.map(p => {
            const c = PROJECT_COLORS[p.color] || PROJECT_COLORS.green
            const isActive = activeProject?.id === p.id
            return (
              <div key={p.id} className={`project-card${isActive ? ' project-card-active' : ''}`}>
                {editId === p.id ? (
                  <>
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="project-name-input"
                      placeholder="Project name"
                      autoFocus
                    />
                    <ColorPicker value={editColor} onChange={setEditColor} />
                    <div className="project-card-actions">
                      <button onClick={saveEdit} disabled={saving || !editName.trim()} className="btn-small btn-primary">Save</button>
                      <button onClick={() => setEditId(null)} className="btn-small btn-ghost">Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="project-card-main">
                      <span className="project-dot" style={{ background: c.dot }} />
                      <span className="project-card-name">{p.name}</span>
                      {isActive && <span className="project-active-badge">Active</span>}
                    </div>
                    <div className="project-card-actions">
                      {!isActive && (
                        <button onClick={() => selectProject(p.id)} className="btn-small btn-primary">Set Active</button>
                      )}
                      <button onClick={() => startEdit(p)} className="btn-small">Edit</button>
                      {projects.length > 1 && !isActive && (
                        <button onClick={() => deleteProject(p)} className="btn-small btn-danger">Delete</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>

        {creating ? (
          <div className="project-create-form">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Project name"
              className="project-name-input"
              autoFocus
            />
            <ColorPicker value={newColor} onChange={setNewColor} />
            <div className="project-card-actions">
              <button onClick={createProject} disabled={saving || !newName.trim()} className="btn-primary">Create</button>
              <button onClick={() => { setCreating(false); setNewName(''); setNewColor('green') }} className="btn-ghost">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} className="btn-ghost" style={{ marginTop: 12 }}>+ New Project</button>
        )}
      </div>
    </div>
  )
}

function ColorPicker({ value, onChange }) {
  return (
    <div className="color-swatches">
      {COLOR_KEYS.map(key => (
        <button
          key={key}
          className={`color-swatch${value === key ? ' color-swatch-active' : ''}`}
          style={{ background: PROJECT_COLORS[key].dot }}
          onClick={() => onChange(key)}
          title={key}
          type="button"
        />
      ))}
    </div>
  )
}
