import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

async function setup({ expenseRead, projectSnapshot, membershipAlreadyMigrated = true, authUser }) {
  const state = []
  const saved = new Map(membershipAlreadyMigrated ? [['projects_membership_migrated_tiffany', '1']] : [])
  const calls = { addProject: 0 }
  let cursor = 0
  let firstRender = true
  let authChanged
  let snapshotChanged
  let snapshotFailed

  const mocks = {
    react: {
      createContext: () => ({ Provider: 'Provider' }),
      useContext: () => null,
      useState: initial => {
        const index = cursor++
        if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
        return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
      },
      useEffect: callback => { if (firstRender) callback() },
    },
    'react/jsx-runtime': { jsx: (_, props) => ({ props }) },
    'firebase/auth': { onAuthStateChanged: (_, callback) => { authChanged = callback; return () => {} } },
    'firebase/firestore': {
      collection: (_, name) => name,
      query: (name, condition) => ({ name, condition }),
      where: (field, operator, value) => ({ field, operator, value }),
      getDocs: query => query.name === 'expenses' ? expenseRead() : Promise.resolve({ docs: [] }),
      onSnapshot: (_, callback, error) => { snapshotChanged = callback; snapshotFailed = error; return () => {} },
      addDoc: async () => { calls.addProject++; return { id: 'new-default' } },
      serverTimestamp: () => 'now',
      writeBatch: () => ({ update() {}, commit: async () => {} }),
    },
    '../firebase': { db: {}, auth: {} },
  }
  globalThis.__projectLoadingMocks = mocks
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
  }
  const result = await build({
    entryPoints: ['src/contexts/ProjectContext.jsx'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    write: false,
    plugins: [{
      name: 'mock-project-dependencies',
      setup(plugin) {
        plugin.onResolve({ filter: /^(react|react\/jsx-runtime|firebase\/auth|firebase\/firestore|\.\.\/firebase)$/ }, args => ({ path: args.path, namespace: 'mock' }))
        plugin.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: `module.exports = globalThis.__projectLoadingMocks[${JSON.stringify(args.path)}]`, loader: 'js' }))
      },
    }],
  })
  const module = { exports: {} }
  vm.runInThisContext('(function(module, exports) {' + result.outputFiles[0].text + '\n})')(module, module.exports)
  const render = () => {
    cursor = 0
    const value = module.exports.ProjectProvider({ children: null }).props.value
    firstRender = false
    return value
  }
  render()
  await authChanged(authUser || { uid: 'tiffany', email: 'bookkeeper@example.test' })
  if (projectSnapshot) await snapshotChanged(projectSnapshot)
  return { render, snapshotChanged, snapshotFailed, calls, saved }
}

const existingProject = { id: 'existing-default', data: () => ({ name: 'Default', memberUids: ['tiffany'] }) }

test('an existing project appears even when expense migration is denied', async () => {
  const app = await setup({ expenseRead: () => Promise.reject(new Error('permission-denied')), membershipAlreadyMigrated: false })
  await app.snapshotChanged({ docs: [existingProject] })
  const view = app.render()
  assert.equal(view.activeProject.id, 'existing-default')
  assert.equal(view.loading, false)
  assert.equal(view.projectError, false)
  assert.equal(app.calls.addProject, 0)
  assert.equal(app.saved.get('projects_membership_migrated_tiffany'), '1')
  assert.equal(app.saved.has('expenses_migrated_tiffany'), false)
})

test('an existing project appears before a stalled expense migration finishes', async () => {
  const app = await setup({ expenseRead: () => new Promise(() => {}) })
  app.snapshotChanged({ docs: [existingProject] })
  const view = app.render()
  assert.equal(view.activeProject.id, 'existing-default')
  assert.equal(view.loading, false)
})

test('a genuinely empty project list still creates the Default project', async () => {
  const app = await setup({ expenseRead: () => Promise.resolve({ docs: [] }) })
  await app.snapshotChanged({ docs: [] })
  assert.equal(app.calls.addProject, 1)
})

test('a new unverified password account does not start project setup', async () => {
  const app = await setup({
    expenseRead: () => Promise.resolve({ docs: [] }),
    authUser: {
      uid: 'pending', email: 'mistyped@example.test', emailVerified: false,
      providerData: [{ providerId: 'password' }],
      metadata: { creationTime: '2026-10-27T00:00:00Z' },
    },
  })
  assert.equal(app.render().loading, false)
  assert.equal(app.calls.addProject, 0)
  assert.equal(app.snapshotChanged, undefined)
})

test('a failed project query is surfaced instead of looking like no project', async () => {
  const app = await setup({ expenseRead: () => Promise.resolve({ docs: [] }) })
  app.snapshotFailed(new Error('permission-denied'))
  const view = app.render()
  assert.equal(view.projectError, true)
  assert.equal(view.loading, false)
  assert.equal(app.calls.addProject, 0)
})
