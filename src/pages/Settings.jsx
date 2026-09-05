import { useState } from 'react'
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, where, getDocs, arrayUnion, arrayRemove, deleteField } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject, PROJECT_COLORS, COLOR_KEYS } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'

export default function Settings() {
  const { projects, activeProject, selectProject, updateProject, reloadProjects } = useProject()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('green')
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('green')
  const [saving, setSaving] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [sharingId, setSharingId] = useState(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [inviting, setInviting] = useState(false)

  async function createProject() {
    if (!newName.trim()) return
    setSaving(true)
    await addDoc(collection(db, 'projects'), {
      name: newName.trim(),
      userId: auth.currentUser.uid,
      color: newColor,
      createdAt: serverTimestamp(),
      memberUids: [auth.currentUser.uid],
      members: { [auth.currentUser.uid]: { role: 'owner', email: auth.currentUser.email, addedAt: serverTimestamp() } },
    })
    await reloadProjects()
    setNewName(''); setNewColor('green'); setCreating(false); setSaving(false)
  }

  function startShare(p) { setSharingId(p.id); setInviteEmail(''); setInviteError('') }

  // Firebase Auth has no client-safe way to resolve an email to a uid — the
  // `users/{uid}` profile doc (written on every sign-in, see
  // useAuthState.js) is what makes "invite by email" possible at all: Cindy
  // has to have signed in at least once before she can be found here.
  async function inviteCollaborator(p) {
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    setInviting(true)
    setInviteError('')
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('email', '==', email)))
      if (snap.empty) {
        setInviteError('No account found with that email — they need to sign up first.')
        setInviting(false)
        return
      }
      const uid = snap.docs[0].id
      if ((p.memberUids || []).includes(uid)) {
        setInviteError('That person already has access to this project.')
        setInviting(false)
        return
      }
      await updateDoc(doc(db, 'projects', p.id), {
        memberUids: arrayUnion(uid),
        [`members.${uid}`]: { role: 'editor', email, addedAt: serverTimestamp() },
      })
      setInviteEmail('')
    } catch (err) {
      setInviteError('Could not send invite: ' + err.message)
    }
    setInviting(false)
  }

  function removeCollaborator(p, uid) {
    setConfirmDialog({
      message: `Remove ${p.members?.[uid]?.email || 'this person'} from "${p.name}"? They'll lose access immediately.`,
      onConfirm: async () => {
        await updateDoc(doc(db, 'projects', p.id), {
          memberUids: arrayRemove(uid),
          [`members.${uid}`]: deleteField(),
        })
      },
    })
  }

  async function saveEdit() {
    if (!editName.trim()) return
    setSaving(true)
    try {
      await updateDoc(doc(db, 'projects', editId), { name: editName.trim(), color: editColor })
      updateProject(editId, { name: editName.trim(), color: editColor })
      setEditId(null)
    } catch (err) {
      alert('Could not save: ' + err.message)
    }
    setSaving(false)
  }

  function deleteProject(p) {
    setConfirmDialog({
      message: `Delete "${p.name}"? Its expenses will remain but won't appear until reassigned.`,
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'projects', p.id))
          if (activeProject?.id === p.id) {
            const remaining = projects.filter(x => x.id !== p.id)
            if (remaining.length) selectProject(remaining[0].id)
          }
          await reloadProjects()
        } catch (err) {
          alert('Could not delete: ' + err.message)
        }
      }
    })
  }

  function startEdit(p) { setEditId(p.id); setEditName(p.name); setEditColor(p.color) }

  return (
    <div className="page page-reading">
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
              <div key={p.id} className="project-card" style={isActive ? { borderColor: c.dot, background: c.bg } : {}}>
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
                      {isActive && <span className="project-active-badge" style={{ background: c.bg, color: c.text }}>Active</span>}
                      {p.userId !== auth.currentUser.uid && (
                        <span className="hint">Shared by {p.members?.[p.userId]?.email || 'the owner'}</span>
                      )}
                    </div>
                    <div className="project-card-actions">
                      {!isActive && (
                        <button onClick={() => selectProject(p.id)} className="btn-small btn-primary">Set Active</button>
                      )}
                      {p.userId === auth.currentUser.uid ? (
                        <>
                          <button onClick={() => startEdit(p)} className="btn-small">Edit</button>
                          <button onClick={() => (sharingId === p.id ? setSharingId(null) : startShare(p))} className="btn-small">
                            {sharingId === p.id ? 'Hide Sharing' : 'Share'}
                          </button>
                          {projects.length > 1 && !isActive && (
                            <button onClick={() => deleteProject(p)} className="btn-small btn-danger">Delete</button>
                          )}
                        </>
                      ) : null /* Only the owner can rename/recolor/delete/manage
                                  membership — the security rule enforces this
                                  server-side too, so showing those controls to
                                  a collaborator would just be a button that
                                  silently fails. A self-service "Leave
                                  Project" would need its own narrower rule
                                  (a member may remove only themselves) —
                                  not added yet, ask the owner to remove you
                                  from Settings for now. */}
                    </div>
                    {sharingId === p.id && (
                      <div className="project-share-panel">
                        {Object.entries(p.members || {}).filter(([uid]) => uid !== p.userId).length > 0 && (
                          <div className="project-share-members">
                            {Object.entries(p.members || {}).filter(([uid]) => uid !== p.userId).map(([uid, m]) => (
                              <div key={uid} className="category-row">
                                <span>{m.email} <span className="hint">· {m.role}</span></span>
                                <button className="btn-small btn-danger" onClick={() => removeCollaborator(p, uid)}>Remove</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="filter-row" style={{ marginTop: 8 }}>
                          <input
                            type="email"
                            placeholder="Invite by email…"
                            value={inviteEmail}
                            onChange={e => setInviteEmail(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && inviteCollaborator(p)}
                          />
                          <button className="btn-small btn-primary" disabled={inviting || !inviteEmail.trim()} onClick={() => inviteCollaborator(p)}>
                            {inviting ? 'Inviting…' : 'Invite'}
                          </button>
                        </div>
                        {inviteError && <p className="error-msg">{inviteError}</p>}
                        <p className="hint">
                          They must already have an account in Expense Operations Center. Invited
                          collaborators can view and edit expenses and statements for this project —
                          your personal-account transactions stay hidden until you classify them.
                        </p>
                      </div>
                    )}
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

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(null) }}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      <div className="app-version">
        Expense Operations Center {__APP_RELEASE__} · build {__APP_VERSION__} · deployed {new Date(__BUILD_TIME__).toLocaleString()}
      </div>
    </div>
  )
}

function ColorPicker({ value, onChange }) {
  return (
    <div className="color-swatches">
      {COLOR_KEYS.map(key => {
        const label = PROJECT_COLORS[key].label || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
        return (
          <button
            key={key}
            className={`color-swatch${value === key ? ' color-swatch-active' : ''}`}
            style={{ background: PROJECT_COLORS[key].dot }}
            onClick={() => onChange(key)}
            title={label}
            aria-label={`${label}${value === key ? ' (selected)' : ''}`}
            type="button"
          />
        )
      })}
    </div>
  )
}
