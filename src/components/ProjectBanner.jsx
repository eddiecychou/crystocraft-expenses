import { useProject, PROJECT_COLORS } from '../contexts/ProjectContext'

export default function ProjectBanner() {
  const { activeProject } = useProject()
  if (!activeProject) return null
  const c = PROJECT_COLORS[activeProject.color] || PROJECT_COLORS.green
  return (
    <div className="project-banner">
      <span className="project-dot" style={{ background: c.dot }} />
      <span className="project-banner-name" style={{ color: c.text }}>{activeProject.name}</span>
    </div>
  )
}
