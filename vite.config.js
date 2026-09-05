import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

function shortSha() {
  // Netlify sets COMMIT_REF during CI builds; fall back to local git for dev builds.
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() }
  catch { return 'unknown' }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(shortSha()),
    __APP_RELEASE__: JSON.stringify(`V${version.replace(/\.0$/, '')}`),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
