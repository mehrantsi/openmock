/**
 * The WebGL viewport: letterboxed canvas + engine hookup + pointer controls +
 * all in-viewport overlays (choose-a-mockup gate, text/logo shot layers,
 * center guides, DOF guides, model-loading pill, context menu, WebGL errors,
 * empty-media hint).
 */

import { useEffect, useRef, useState } from 'react'
import { Camera, Download, Redo2, Undo2, Upload } from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { useUI } from '../../state/ui'
import type { Shot, TextStyle } from '../../state/types'
import { viewportRatioAspect } from '../../export/resolutions'
import { useViewportRatio } from '../../state/settings'
import { isOverlayShot } from '../../video/timelineOps'
import { TextShotView } from '../../shots/TextShotView'
import { LogoShotView } from '../../shots/LogoShotView'
import { openMediaPicker } from '../useMediaIngest'
import { quickCapture, useExportApi } from '../chrome/exportContext'
import { ExportProgressPill } from '../dialogs/ExportPopover'
import { useEngine, type EngineHost, type ModelLoadingState } from './useEngine'
import { usePointerControls } from './usePointerControls'
import { usePlaybackView } from './playbackView'
import { DofOverlay } from './DofOverlay'
import { MockupGate } from './MockupGate'
import type { ShotVideoElements } from '../../video/playbackEngine'

export type { EngineHost }
export { useEngine }
export type { ShotVideoElements }

// ---------------------------------------------------------------------------
// Text / logo shot overlay
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

interface OverlayLayer {
  shot: Shot
  localSec: number
  fade: number
}

function ShotOverlay() {
  const pv = usePlaybackView()
  const scenes = useProject((s) => s.scenes)
  const selectedId = useProject((s) => s.selectedSceneId)
  const updateShot = useProject((s) => s.updateShot)
  const phase = usePlayback((s) => s.phase)
  const projectTime = usePlayback((s) => s.projectTime)

  // the visible card stack (bottom → top) comes from the playback view; the
  // selected-card fallback covers the first frame before any paint has run
  let layers: OverlayLayer[] = []
  if (pv.active && pv.layers.length > 0) {
    layers = pv.layers
      .map((l) => {
        const shot = scenes.find((x) => x.id === l.shotId)
        return shot ? { shot, localSec: l.localSec, fade: l.fade } : null
      })
      .filter((l): l is OverlayLayer => l !== null)
  } else if (phase !== 'playing') {
    const sel = scenes.find((x) => x.id === selectedId) ?? null
    if (sel && (sel.kind === 'text' || sel.kind === 'logo')) {
      const inShot = projectTime >= sel.startTime && projectTime <= sel.startTime + sel.duration
      if (inShot) {
        layers = [{ shot: sel, localSec: clamp(projectTime - sel.startTime, 0, sel.duration), fade: 1 }]
      }
    }
  }

  if (layers.length === 0) return null

  return (
    <>
      {layers.map(({ shot, localSec, fade }, i) => {
        const editable = phase !== 'playing' && shot.id === selectedId
        // transparent overlays must not steal pointer/wheel input from the
        // canvas beneath — only an editable text card (inline editing) or an
        // opaque floor card (the canvas under it is invisible) takes events
        const isOpaqueFloor = pv.active ? pv.coversCanvas && i === 0 : !isOverlayShot(shot)
        const interactive = isOpaqueFloor || (editable && shot.kind === 'text')
        const pe = { pointerEvents: interactive ? ('auto' as const) : ('none' as const) }
        if (shot.kind === 'text') {
          const onChange = (text: TextStyle) => updateShot(shot.id, { text })
          return (
            <div key={shot.id} className="absolute inset-0 z-10" style={{ opacity: fade, ...pe }}>
              <TextShotView shot={shot} localSec={localSec} editable={editable} onChange={onChange} />
            </div>
          )
        }
        return (
          <div key={shot.id} className="absolute inset-0 z-10" style={pe}>
            <LogoShotView shot={shot} localSec={localSec} transitionOpacity={fade} />
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Model loading pill
// ---------------------------------------------------------------------------

function ModelLoadingPill({ loading }: { loading: ModelLoadingState | null }) {
  const [pct, setPct] = useState(0)
  const id = loading?.id ?? null

  useEffect(() => {
    if (!id) return
    setPct(0)
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      // eased fake progress: 95·(1 − e^(−t/2500))
      setPct(Math.round(95 * (1 - Math.exp(-(performance.now() - t0) / 2500))))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [id])

  if (!loading) return null
  return (
    <div
      aria-label="Loading 3D model"
      className="absolute top-3 left-1/2 -translate-x-1/2 z-30 h-7 px-3 flex items-center gap-2 rounded-full bg-[rgba(14,14,16,0.82)] text-white/90 backdrop-blur-md border border-white/10"
    >
      <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="text-[10px] font-medium">Model loading… {pct}%</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface CtxMenuState {
  x: number
  y: number
}

function ViewportContextMenu({ menu, onClose }: { menu: CtxMenuState; onClose: () => void }) {
  const ex = useExportApi()
  const setExportOpen = useUI((s) => s.setExportDialogOpen)

  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (!el?.closest?.('[data-viewport-ctxmenu]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const itemCls =
    'w-full flex items-center gap-2 px-2.5 py-[5px] rounded-[5px] text-[11px] text-left text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black dark:hover:text-white transition-colors'

  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div
      data-viewport-ctxmenu
      className="fixed z-[9999] w-[190px] rounded-xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[rgba(14,14,16,0.94)] backdrop-blur-md shadow-xl p-1"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className={itemCls} onClick={run(() => void quickCapture(ex))}>
        <Camera className="size-3 opacity-60" /> Quick capture
      </button>
      <button className={itemCls} onClick={run(() => setExportOpen(true))}>
        <Download className="size-3 opacity-60" /> Export…
      </button>
      <div className="my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]" />
      <button className={itemCls} onClick={run(() => useProject.getState().undo())}>
        <Undo2 className="size-3 opacity-60" /> Undo
      </button>
      <button className={itemCls} onClick={run(() => useProject.getState().redo())}>
        <Redo2 className="size-3 opacity-60" /> Redo
      </button>
      <div className="my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]" />
      <button className={itemCls} onClick={run(() => openMediaPicker('replace'))}>
        <Upload className="size-3 opacity-60" /> Add media…
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty-media hint
// ---------------------------------------------------------------------------

function EmptyMediaHint() {
  return (
    <div
      aria-label="Get started hint"
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-3 rounded-2xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[rgba(14,14,16,0.8)] backdrop-blur-md px-6 py-5 shadow-lg"
    >
      <span className="text-[12px] text-black/70 dark:text-white/70 text-center max-w-[220px]">
        Upload media to get started — or paste / drop.
      </span>
      <button
        onClick={() => openMediaPicker('replace')}
        className="h-8 px-4 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[11px] font-semibold hover:opacity-90 transition-opacity"
      >
        Upload
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export function Viewport({ host }: { host: EngineHost }) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState({ w: 0, h: 0 })
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)

  const ratio = useViewportRatio((s) => s.ratio)
  const scenes = useProject((s) => s.scenes)
  const selectedId = useProject((s) => s.selectedSceneId)
  const pvCovers = usePlaybackView((s) => s.active && s.coversCanvas)

  const controls = usePointerControls(host.canvasEl, host.setInteracting)

  // available space for the letterboxed box
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setAvail({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const aspect = viewportRatioAspect(ratio)
  let boxW = avail.w
  let boxH = avail.h
  if (aspect && avail.w > 0 && avail.h > 0) {
    if (avail.w / avail.h > aspect) {
      boxH = avail.h
      boxW = avail.h * aspect
    } else {
      boxW = avail.w
      boxH = avail.w / aspect
    }
  }

  const sel = scenes.find((s) => s.id === selectedId) ?? null
  // hide the canvas only when an OPAQUE card fully covers the frame — the
  // playhead frame otherwise shows through (transparent overlays composite
  // over it). The selected-card check covers the first frame before a paint.
  const inSelShot = usePlayback((s) => {
    if (s.phase === 'playing' || !sel || (sel.kind !== 'text' && sel.kind !== 'logo')) return false
    if (isOverlayShot(sel)) return false
    return s.projectTime >= sel.startTime && s.projectTime <= sel.startTime + sel.duration
  })
  const overlayActive = pvCovers || inSelShot
  const showEmptyHint =
    scenes.length > 0 && !!sel && !sel.kind && !sel.imageKey && !sel.video && !host.webglError && !overlayActive

  return (
    <div ref={areaRef} className="absolute inset-0 flex items-center justify-center">
      <div
        className="relative rounded-2xl border border-black/15 dark:border-white/10 overflow-hidden bg-[#fafafa] dark:bg-[#09090b]"
        style={{ width: Math.max(0, Math.round(boxW)), height: Math.max(0, Math.round(boxH)) }}
      >
        <canvas
          ref={host.setCanvas}
          data-viewport-canvas
          className="absolute inset-0 w-full h-full"
          style={{
            touchAction: 'none',
            objectFit: 'cover',
            cursor: controls.cursor,
            opacity: overlayActive ? 0 : 1,
          }}
          onPointerDown={controls.onPointerDown}
          onPointerMove={controls.onPointerMove}
          onPointerUp={controls.onPointerUp}
          onPointerCancel={controls.onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtxMenu({ x: e.clientX, y: e.clientY })
          }}
        />

        <ShotOverlay />

        {/* center guides while snap-to-center is engaged */}
        {controls.guides.x && (
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-500/80 z-30 pointer-events-none" />
        )}
        {controls.guides.y && (
          <div className="absolute top-1/2 left-0 right-0 h-px bg-zinc-500/80 z-30 pointer-events-none" />
        )}

        <DofOverlay />
        <ModelLoadingPill loading={host.modelLoading} />
        {showEmptyHint && <EmptyMediaHint />}
        <ExportProgressPill />

        {host.webglError && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/85 dark:bg-black/85">
            <div className="flex flex-col items-center gap-2 text-center px-6">
              <span className="text-[14px] font-semibold uppercase tracking-[0.04em] text-black dark:text-white">
                {host.webglError === 'lost' ? 'WebGL context lost' : 'WebGL is unavailable on this device'}
              </span>
              <span className="text-[10.5px] font-medium text-black/50 dark:text-white/45 max-w-[320px]">
                {host.webglError === 'lost'
                  ? 'Reload the page to restore the 3D view.'
                  : 'Hardware acceleration may be disabled, or too many WebGL contexts are active.'}
              </span>
            </div>
          </div>
        )}

        {scenes.length === 0 && <MockupGate />}
      </div>

      {ctxMenu && <ViewportContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </div>
  )
}
