/**
 * Shares one `useExport()` instance (created in App) across the top bar,
 * export popover, progress pill, and viewport context menu, plus the quick
 * capture flow (⌘S / capture button / context menu): a 3× supersample of the
 * on-screen viewport through the live engine.
 */

import { createContext, useContext } from 'react'
import type { UseExportApi } from '../../export/useExport'
import { useProject } from '../../state/project'
import { toast } from '../toast'
import { getImageAnalysis } from '../viewport/mediaCache'
import { requestViewportRender } from '../viewport/engineRef'

export const ExportCtx = createContext<UseExportApi | null>(null)

export function useExportApi(): UseExportApi | null {
  return useContext(ExportCtx)
}

/** Analysis overrides (ghost/extrude parity) for the selected shot's media. */
export function selectedMediaOverrides(): { mediaIsDark?: boolean; extrudeColor?: string } {
  const p = useProject.getState()
  const shot = p.scenes.find((s) => s.id === p.selectedSceneId)
  const a = shot?.imageKey ? getImageAnalysis(shot.imageKey) : null
  return { mediaIsDark: a?.isDark, extrudeColor: a?.average }
}

/** Quick capture: 3× viewport supersample in the persisted image format. */
export async function quickCapture(ex: UseExportApi | null): Promise<void> {
  if (!ex || ex.phase === 'rendering') return
  const canvas = document.querySelector<HTMLCanvasElement>('[data-viewport-canvas]')
  const rect = canvas?.getBoundingClientRect()
  const w = rect && rect.width > 0 ? Math.round(3 * rect.width) : 1920
  const h = rect && rect.height > 0 ? Math.round(3 * rect.height) : 1080
  toast('Capturing image...')
  try {
    await ex.exportImageNow({
      size: 'custom',
      customWidth: w,
      customHeight: h,
      transparent: false,
      ...selectedMediaOverrides(),
    })
  } finally {
    // capture resizes the shared renderer — repaint the viewport
    requestViewportRender()
  }
}
