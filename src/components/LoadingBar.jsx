import { useState, useEffect } from 'react'

export default function LoadingBar({ label = 'Loading…' }) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    // Rush to 60% quickly, then crawl to 85% while waiting for data
    const id = setInterval(() => {
      setProgress(p => {
        if (p < 60) return Math.min(60, p + 6)
        if (p < 85) return Math.min(85, p + 0.6)
        return p
      })
    }, 120)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="loading-bar-wrap">
      <p className="loading-bar-label">{label}</p>
      <div className="loading-bar-track">
        <div className="loading-bar-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
