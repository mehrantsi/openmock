import { useProject } from '../../state/project'

/** Header for text/logo shot panels: "← Back" + wordmark. */
export function ShotPanelHeader({ wordmark }: { wordmark: string }) {
  const goBack = () => {
    const p = useProject.getState()
    const idx = p.scenes.findIndex((s) => s.id === p.selectedSceneId)
    // nearest mockup (non-text/logo) shot: search backwards, then forwards
    let target: string | null = null
    for (let i = idx - 1; i >= 0; i--) {
      if (!p.scenes[i].kind) {
        target = p.scenes[i].id
        break
      }
    }
    if (!target) {
      for (let i = idx + 1; i < p.scenes.length; i++) {
        if (!p.scenes[i].kind) {
          target = p.scenes[i].id
          break
        }
      }
    }
    p.selectScene(target)
  }

  return (
    <div className="h-11 shrink-0 flex items-center justify-between px-3 border-b border-black/10 dark:border-white/10">
      <button
        aria-label="Back to sidebar"
        onClick={goBack}
        className="text-[10.5px] font-medium text-black/45 dark:text-white/40 hover:text-black/80 dark:hover:text-white/80 transition-colors"
      >
        ← Back
      </button>
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-black/80 dark:text-white/80">
        {wordmark}
      </span>
    </div>
  )
}
