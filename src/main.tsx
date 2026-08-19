import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './index.css'

// keep projects + media exempt from browser storage eviction (Safari especially)
void navigator.storage?.persist?.().catch(() => {})
import App from './App'
import { useProject } from './state/project'
import { usePlayback } from './state/playback'

if (import.meta.env.DEV) {
  // dev-only store access for debugging/tests
  ;(window as unknown as Record<string, unknown>).__openmock = { useProject, usePlayback }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
