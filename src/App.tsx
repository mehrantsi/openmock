/**
 * OpenMock app shell: layout (top bar / viewport / timeline / inspector),
 * global keyboard shortcuts, media ingestion listeners, dialogs, and the
 * playback-engine ↔ render-engine wiring.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from './state/project'
import { usePlayback } from './state/playback'
import { useUI } from './state/ui'
import { useSettings } from './state/settings'
import { ToastViewport } from './ui/toast'
import { ViewportToolbar } from './ui/chrome/TopBar'
import { MediaOverlays } from './ui/chrome/MediaOverlays'
import { Viewport } from './ui/viewport/Viewport'
import { useEngine } from './ui/viewport/useEngine'
import { usePlaybackEngine, useShotVideoElements } from './video/playbackEngine'
import { useMediaIngest } from './ui/useMediaIngest'
import { useExport } from './export/useExport'
import { ExportCtx, quickCapture } from './ui/chrome/exportContext'
import { TimelineCtx, type TimelineContextValue } from './ui/timeline/context'
import { TimelinePanel } from './ui/timeline/TimelinePanel'
import { InspectorPanel } from './ui/inspector/InspectorPanel'
import { ShortcutsModal } from './ui/dialogs/ShortcutsModal'
import { PreferencesModal } from './ui/dialogs/PreferencesModal'
import { InfoModal } from './ui/dialogs/InfoModal'
import { PasteModal } from './ui/dialogs/PasteModal'
import { ProModal } from './ui/dialogs/ProModal'
import { FreeExportTip } from './ui/dialogs/FreeExportTip'
import { ScreenGate, useScreenTooSmall } from './ui/chrome/ScreenGate'
import { maybeRefreshLicense, useLicense } from './state/license'
import { toast } from './ui/toast'

// hydrate the persisted project before anything renders
useProject.getState().hydrate()

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input, textarea, select, [contenteditable="true"]')
}

export default function App() {
  const timelineVisible = usePlayback((s) => s.timelineVisible)
  const [panelVisible, setPanelVisible] = useState(true)
  const tooSmall = useScreenTooSmall()

  // playback + rendering plumbing
  const videos = useShotVideoElements()
  const host = useEngine(videos)
  const playback = usePlaybackEngine({ renderFrame: host.renderAt, videos })
  const timelineCtxValue = useMemo<TimelineContextValue>(
    () => ({ engine: playback, videos }),
    [playback, videos],
  )

  // export API shared across top bar / popover / pill / context menu
  const exportApi = useExport()
  const exportRef = useRef(exportApi)
  exportRef.current = exportApi

  // background services (the timeline panel mounts the keyframe recorder)
  useMediaIngest()

  // license: claim on the post-checkout redirect, otherwise revalidate quietly
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.pathname === '/activate') {
      const sessionId = url.searchParams.get('session_id')
      window.history.replaceState(null, '', '/')
      if (sessionId) {
        void useLicense
          .getState()
          .claim(sessionId)
          .then((err) => {
            useUI.getState().setProOpen(true)
            if (err) toast(err, 'error')
            else toast('Pro is active. Your license key is saved on this device.', 'success', 5000)
          })
        return
      }
    }
    maybeRefreshLicense()
  }, [])

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target)
      const mod = e.metaKey || e.ctrlKey

      if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        if (typing) return
        e.preventDefault()
        if (e.shiftKey) useProject.getState().redo()
        else useProject.getState().undo()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        if (useSettings.getState().quickCaptureShortcut) void quickCapture(exportRef.current)
        return
      }
      if (typing || mod || e.altKey) return

      if (e.key === 't' || e.key === 'T') {
        const pb = usePlayback.getState()
        pb.setTimelineVisible(!pb.timelineVisible)
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        setPanelVisible((v) => !v)
        return
      }
      if (e.key === '?') {
        useUI.getState().setShortcutsOpen(true)
        return
      }
      if (e.key === 'Escape') {
        useUI.getState().setExportDialogOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)

    // suppress the browser context menu outside text inputs (the viewport
    // provides its own menu)
    const onCtx = (e: MouseEvent) => {
      if (!isTypingTarget(e.target)) e.preventDefault()
    }
    window.addEventListener('contextmenu', onCtx)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onCtx)
    }
  }, [])

  if (tooSmall) return <ScreenGate />

  return (
    <ExportCtx.Provider value={exportApi}>
      <TimelineCtx.Provider value={timelineCtxValue}>
        <div className="fixed inset-[14px] flex gap-[10px] z-[500]">
          {panelVisible && (
            <div className="hidden md:flex shrink-0 min-h-0">
              <InspectorPanel />
            </div>
          )}
          <div className="flex-1 flex flex-col min-w-0">
            <div data-viewport-area className="flex-1 relative min-h-0">
              <Viewport host={host} />
              <ViewportToolbar />
            </div>
            {timelineVisible && (
              <div data-timeline-area className="mt-[10px] relative">
                <TimelinePanel />
              </div>
            )}
          </div>
        </div>

        <MediaOverlays />
        <ShortcutsModal />
        <PreferencesModal />
        <InfoModal />
        <ProModal />
        <FreeExportTip />
        <PasteModal />
        <ToastViewport />
      </TimelineCtx.Provider>
    </ExportCtx.Provider>
  )
}
