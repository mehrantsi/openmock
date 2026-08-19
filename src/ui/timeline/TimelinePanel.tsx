/**
 * TimelinePanel — the complete timeline UI.
 *
 * Frame (resize handle, minimized mode), transport row, scrollable ruler +
 * layer list + shot/property/audio lanes with playhead overlay, marquee
 * selection, keyboard shortcuts, simple mode, and the keyframe recorder.
 *
 * The chrome shell provides the playback engine through `TimelineCtx`
 * (see ./context). Without it a store-backed fallback keeps scrubbing usable.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { PROP_LANE_ORDER, PROP_LABELS, type AnimatableProp, type Shot } from '../../state/types'
import { animatedProps, canvasLength } from '../../video/timelineOps'
import { useKeyframeRecorder } from '../../video/recorder'
import { gestureFlags } from '../../lib/gestureFlags'
import { toast } from '../toast'
import { TimelineUICtx, useTimelineEngine, useTimelineUI, type EasingTarget, type TimelineUIValue } from './context'
import { MenuHost, useContextMenu, type MenuItem, menuSeparator } from './menu'
import { Ruler } from './Ruler'
import { PlayheadLine, PlayheadMarker, SnapLine } from './Playhead'
import { Transport, MiniTransport } from './Transport'
import { ShotBarLane, ShotGutterCell, TransitionPopover } from './ShotRow'
import { addAudioTrack, addMediaShot } from './mediaIngest'
import { clipboardKfCount } from './clipboard'
import { PropertyLaneKeyframes } from './keyframes'
import { AudioClipLane, AudioGutterCell } from './AudioLane'
import { VideoFilmstrip } from './VideoFilmstrip'
import { EasingPopover } from './EasingPopover'
import { AddTrackMenu } from './AddTrackMenu'
import { SimpleBarsRow, SimpleFilmstripRow, SimpleStripRow } from './SimpleTimeline'
import { replaceShotMedia } from './mediaIngest'
import {
  copyKfSelection,
  copyShot,
  deleteKfSelection,
  pasteKfsAtPlayhead,
  pasteSceneFromClipboard,
  selectAllShotKfs,
  splitSelectedAtPlayhead,
  stampChangedProps,
} from './kfOps'
import { getClipboard } from './clipboard'
import { KEY_EXPANDED, KEY_HEIGHT, KEY_ZOOM, readNumber, usePersistedState, writeString } from './persist'

export { TimelineCtx, type TimelineContextValue } from './context'

const PANEL_CSS = `
@keyframes om-rec-shake {
  0%, 100% { transform: translateX(0); }
  15% { transform: translateX(-4px); }
  30% { transform: translateX(3px); }
  45% { transform: translateX(-3px); }
  60% { transform: translateX(2px); }
  75% { transform: translateX(-1px); }
}
.om-rec-attention { animation: om-rec-shake 640ms ease; }
`

// ---------------------------------------------------------------------------

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function TimelinePanel({ exportSlot }: { exportSlot?: ReactNode }) {
  useKeyframeRecorder()
  const engine = useTimelineEngine()

  const scenes = useProject((s) => s.scenes)
  const audios = useProject((s) => s.audios)
  const sequenceDuration = useProject((s) => s.sequenceDuration)
  const selectedSceneId = useProject((s) => s.selectedSceneId)

  const minimized = usePlayback((s) => s.timelineMinimized)
  const simple = usePlayback((s) => s.simpleTimeline)
  const recording = usePlayback((s) => s.recording)
  const setSelectedKfIds = usePlayback((s) => s.setSelectedKfIds)

  // -- frame height ----------------------------------------------------------
  const [height, setHeight] = useState(() => readNumber(KEY_HEIGHT, 264))
  const clampHeight = (h: number) => Math.min(Math.max(120, h), Math.round(window.innerHeight * 0.85))

  // -- layout measurement ------------------------------------------------------
  const gutterW = simple ? 120 : 220
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(800)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(Math.max(80, el.clientWidth - gutterW)))
    ro.observe(el)
    setViewW(Math.max(80, el.clientWidth - gutterW))
    return () => ro.disconnect()
  }, [gutterW, minimized])

  // -- zoom (persisted, anchored at playhead) ----------------------------------
  const [zoom, setZoom] = useState(() => Math.min(8, Math.max(1, readNumber(KEY_ZOOM, 1))))
  const totalLen = Math.max(canvasLength(scenes, sequenceDuration), 0.001)
  const laneW = viewW * zoom
  const pxPerSec = laneW / totalLen
  const pendingAnchor = useRef<{ t: number; screenX: number } | null>(null)

  const setZoomAnchored = useCallback(
    (z: number) => {
      const nz = Math.min(8, Math.max(1, z))
      const scroller = scrollRef.current
      if (scroller) {
        const t = engine.getTime()
        const pxOld = t * pxPerSec
        pendingAnchor.current = { t, screenX: pxOld - scroller.scrollLeft }
      }
      writeString(KEY_ZOOM, String(nz))
      setZoom(nz)
    },
    [engine, pxPerSec],
  )

  useLayoutEffect(() => {
    const a = pendingAnchor.current
    if (!a) return
    pendingAnchor.current = null
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.scrollLeft = Math.max(0, a.t * pxPerSec - a.screenX)
  }, [zoom, pxPerSec])

  // ⌘/Ctrl + wheel zoom over the lane area
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      setZoomAnchored(zoomRef.current * Math.exp(-0.01 * e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [minimized, setZoomAnchored])
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // -- selection / interaction state ---------------------------------------------
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [kfDrag, setKfDrag] = useState<Record<string, number> | null>(null)
  const [shotDrag, setShotDrag] = useState<Record<string, { startTime: number; duration: number }> | null>(null)
  const [openStripId, setOpenStripId] = useState<string | null>(null)
  const [renameShotId, setRenameShotId] = useState<string | null>(null)
  const [easing, setEasing] = useState<EasingTarget | null>(null)
  const [recShake, setRecShake] = useState(0)
  const [expanded, setExpanded] = usePersistedState<Record<string, boolean>>(KEY_EXPANDED, {})
  const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null)

  const timeAtClientX = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      return (clientX - r.left + el.scrollLeft - gutterW) / (pxPerSec || 1)
    },
    [gutterW, pxPerSec],
  )

  const ui: TimelineUIValue = useMemo(
    () => ({
      engine,
      simple,
      gutterW,
      laneW,
      viewW,
      pxPerSec,
      totalLen,
      zoom,
      setZoomAnchored,
      getScrollEl: () => scrollRef.current,
      timeAtClientX,
      selectedShotIds,
      setSelectedShotIds,
      selectedClipId,
      setSelectedClipId,
      openEasing: setEasing,
      shakeRec: () => setRecShake((n) => n + 1),
      recShake,
      snapLine,
      setSnapLine,
      kfDrag,
      setKfDrag,
      shotDrag,
      setShotDrag,
      openStripId,
      setOpenStripId,
      renameShotId,
      setRenameShotId,
      expanded,
      toggleExpanded: (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] })),
    }),
    [
      engine,
      simple,
      gutterW,
      laneW,
      viewW,
      pxPerSec,
      totalLen,
      zoom,
      setZoomAnchored,
      timeAtClientX,
      selectedShotIds,
      selectedClipId,
      recShake,
      snapLine,
      kfDrag,
      shotDrag,
      openStripId,
      renameShotId,
      expanded,
      setExpanded,
    ],
  )

  // park the playhead into freshly created shots, and into any newly selected
  // shot the playhead isn't already inside (so the viewport shows what you
  // selected without pinning it over the rest of the timeline)
  const knownIds = useRef<Set<string>>(new Set(scenes.map((s) => s.id)))
  const lastSelected = useRef<string | null>(selectedSceneId)
  useEffect(() => {
    const shot = scenes.find((s) => s.id === selectedSceneId)
    const isNew = !!shot && !knownIds.current.has(shot.id)
    const reselected = selectedSceneId !== lastSelected.current
    knownIds.current = new Set(scenes.map((s) => s.id))
    lastSelected.current = selectedSceneId
    if (!shot) return
    const t = engine.getTime()
    const outside = t < shot.startTime - 1e-4 || t > shot.startTime + shot.duration + 1e-4
    if (isNew || (reselected && outside && usePlayback.getState().phase !== 'playing')) {
      engine.parkAt(shot.startTime + Math.min(0.2, shot.duration / 2))
    }
  }, [scenes, selectedSceneId, engine])

  // -- keyboard -----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const pb = usePlayback.getState()
      const proj = useProject.getState()

      if (e.code === 'Space' && !mod) {
        // Space doubles as the viewport pan modifier: consume the keydown but
        // toggle playback on keyup, and only when the hold wasn't used to pan.
        e.preventDefault()
        return
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const step = (mod ? 0.5 : 0.1) * (e.code === 'ArrowLeft' ? -1 : 1)
        engine.scrubTo(engine.getTime() + step)
        return
      }
      if (e.code === 'KeyK' && !mod) {
        e.preventDefault()
        stampChangedProps(engine)
        return
      }
      if ((e.code === 'Backspace' || e.code === 'Delete') && !mod) {
        e.preventDefault()
        if (deleteKfSelection()) return
        if (selectedClipId) {
          proj.setAudioClips(proj.audioClips.filter((c) => c.id !== selectedClipId))
          setSelectedClipId(null)
          return
        }
        const shotIds = selectedShotIds.length > 0 ? selectedShotIds : proj.selectedSceneId ? [proj.selectedSceneId] : []
        if (shotIds.length > 0) {
          proj.deleteScenes(shotIds)
          setSelectedShotIds([])
        }
        return
      }
      if (e.code === 'KeyA' && mod && e.altKey) {
        e.preventDefault()
        selectAllShotKfs()
        return
      }
      if (e.code === 'KeyD' && mod && e.shiftKey) {
        e.preventDefault()
        splitSelectedAtPlayhead(engine)
        return
      }
      if (e.code === 'KeyC' && mod && !e.shiftKey && !e.altKey) {
        if (copyKfSelection()) {
          e.preventDefault()
          return
        }
        const shot = proj.scenes.find((s) => s.id === proj.selectedSceneId)
        if (shot) {
          e.preventDefault()
          copyShot(shot)
        }
        return
      }
      if (e.code === 'KeyV' && mod && !e.shiftKey && !e.altKey) {
        const clip = getClipboard()
        if (!clip) return
        e.preventDefault()
        if (clip.kind === 'kf') pasteKfsAtPlayhead(engine)
        else pasteSceneFromClipboard()
        return
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return
      const wasPan = gestureFlags.spacePanned
      gestureFlags.spacePanned = false
      if (wasPan) return // the hold was a viewport pan, not a play/pause tap
      if (usePlayback.getState().recording) {
        toast('Can’t play whilst recording keyframes — stop recording first.', 'info', 2600)
        setRecShake((n) => n + 1)
        return
      }
      engine.toggle()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [engine, selectedClipId, selectedShotIds])

  // -- marquee selection ----------------------------------------------------------
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const onLanesPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-shot-id],[data-kf-hit],button,input,[data-gap-band],[role="slider"]')) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const y0 = e.clientY
    const additive = e.shiftKey
    const baseKfs = additive ? usePlayback.getState().selectedKfIds : []
    const baseShots = additive ? selectedShotIds : []
    let active = false
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 2) return
      active = true
      const rect = {
        left: Math.min(x0, ev.clientX),
        right: Math.max(x0, ev.clientX),
        top: Math.min(y0, ev.clientY),
        bottom: Math.max(y0, ev.clientY),
      }
      setMarquee({ x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom })
      const root = rootRef.current
      if (!root) return
      const kfIds: string[] = [...baseKfs]
      root.querySelectorAll<HTMLElement>('[data-kf-hit]').forEach((n) => {
        const r = n.getBoundingClientRect()
        if (r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom) {
          const id = n.dataset.kfHit
          if (id && !kfIds.includes(id)) kfIds.push(id)
        }
      })
      const shotIds: string[] = [...baseShots]
      root.querySelectorAll<HTMLElement>('[data-shot-id]').forEach((n) => {
        const r = n.getBoundingClientRect()
        if (r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom) {
          const id = n.dataset.shotId
          if (id && !shotIds.includes(id)) shotIds.push(id)
        }
      })
      setSelectedKfIds(kfIds)
      setSelectedShotIds(shotIds)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setMarquee(null)
      if (!active && !additive) {
        // plain click on empty space: clear selections
        setSelectedKfIds([])
        setSelectedShotIds([])
        setSelectedClipId(null)
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // -- resize handle -----------------------------------------------------------------
  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) => {
      const h = clampHeight(startH + (startY - ev.clientY))
      setHeight(h)
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      const h = clampHeight(startH + (startY - ev.clientY))
      writeString(KEY_HEIGHT, String(Math.round(h)))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // -- rows ------------------------------------------------------------------------
  const selectedShot = scenes.find((s) => s.id === selectedSceneId) ?? null
  const gutterBg = 'bg-white/90 dark:bg-[rgba(18,18,20,0.94)]'

  const advancedRows: ReactNode[] = []
  if (!simple) {
    scenes.forEach((shot, i) => {
      advancedRows.push(
        <div className="flex" key={shot.id}>
          <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg}`} style={{ width: gutterW }}>
            <ShotGutterCell shot={shot} index={i} />
          </div>
          <div className="relative border-b border-black/[0.04] dark:border-white/[0.04]">
            <ShotBarLane
              shot={shot}
              index={i}
              isFirst={i === 0}
              isLast={i === scenes.length - 1}
              onReplaceMedia={() => void replaceShotMedia(shot.id)}
            />
          </div>
        </div>,
      )
      if (!shot.kind && expanded[shot.id]) {
        const props = PROP_LANE_ORDER.filter((p) => animatedProps(shot).includes(p))
        for (const prop of props) {
          advancedRows.push(
            <div className="flex" key={`${shot.id}:${prop}`}>
              <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg}`} style={{ width: gutterW }}>
                <PropLaneGutter prop={prop} />
              </div>
              <div className="relative h-9 border-b border-black/[0.04] dark:border-white/[0.04]" style={{ width: laneW }}>
                <PropertyLaneKeyframes shot={shot} prop={prop} />
              </div>
            </div>,
          )
        }
        if (shot.video) {
          advancedRows.push(
            <div className="flex" key={`${shot.id}:filmstrip`}>
              <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg} flex items-center px-3`} style={{ width: gutterW }}>
                <span className="text-[10.5px] font-medium text-black/40 dark:text-white/40">Video preview</span>
              </div>
              <div className="relative h-[52px] py-1 border-b border-black/[0.04] dark:border-white/[0.04]" style={{ width: laneW }}>
                <div className="sticky inline-block align-top" style={{ left: gutterW + 8, marginLeft: 8 }}>
                  <VideoFilmstrip shot={shot} />
                </div>
              </div>
            </div>,
          )
        }
      }
    })
    audios.forEach((audio) => {
      advancedRows.push(
        <div className="flex" key={`audio:${audio.id}`}>
          <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg}`} style={{ width: gutterW }}>
            <AudioGutterCell audio={audio} />
          </div>
          <div className="relative border-b border-black/[0.04] dark:border-white/[0.04]">
            <AudioClipLane audio={audio} />
          </div>
        </div>,
      )
    })
    // add-track row at the bottom of the layer list
    advancedRows.push(
      <div className="flex" key="add-track-row">
        <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg}`} style={{ width: gutterW }}>
          <button
            className="h-9 w-full flex items-center gap-1.5 px-3 text-[11px] text-black/45 dark:text-white/45 hover:text-[#FD631F]"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setAddAnchor({ x: r.left + r.width / 2, y: r.top })
            }}
          >
            <Plus className="size-3.5" />
            Add track
          </button>
        </div>
        <div style={{ width: laneW }} className="h-9" />
      </div>,
    )
  }

  const openStripShot = simple && openStripId ? (scenes.find((s) => s.id === openStripId && !s.kind) ?? null) : null

  // ---------------------------------------------------------------------------

  return (
    <TimelineUICtx.Provider value={ui}>
      <MenuHost>
        <style>{PANEL_CSS}</style>
        <div
          ref={rootRef}
          className="relative rounded-2xl border border-black/[0.09] dark:border-white/[0.08] bg-[#f4f4f6]/85 dark:bg-[#101013]/85 backdrop-blur-xl flex flex-col overflow-hidden"
          style={{ height: minimized ? 40 : simple ? undefined : height }}
        >
          {/* resize handle (advanced, not minimized) */}
          {!minimized && !simple && (
            <div
              aria-label="Resize timeline"
              className="absolute -top-[2px] left-0 right-0 h-[7px] cursor-ns-resize z-30 group flex items-start justify-center touch-none"
              onPointerDown={onResizeDown}
            >
              <div className="mt-[2px] h-[3px] w-9 rounded-full bg-black/15 dark:bg-white/20 group-hover:bg-[#FD631F] transition-colors" />
            </div>
          )}

          {minimized ? (
            <MiniTransport />
          ) : (
            <>
              <Transport exportSlot={exportSlot} />
              {scenes.length === 0 ? (
                <div className="flex-1 min-h-[64px] flex items-center justify-center">
                  <span className="text-[12px] font-mono text-black/40 dark:text-white/40">
                    Choose a mockup in the viewport to get started
                  </span>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-1 overflow-auto overscroll-contain relative">
                  <div style={{ width: gutterW + laneW }} className="relative min-h-full">
                    {/* sticky ruler row */}
                    <div className="sticky top-0 z-20 flex bg-white/85 dark:bg-[rgba(14,14,16,0.9)] backdrop-blur border-b border-black/[0.07] dark:border-white/[0.07]">
                      <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg}`} style={{ width: gutterW }} />
                      <div className="relative">
                        <Ruler />
                        <PlayheadMarker />
                      </div>
                    </div>

                    {/* lanes */}
                    <LanesWrapper onPointerDown={onLanesPointerDown}>
                      {simple ? (
                        <>
                          <div className="flex">
                            <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg} flex items-center px-3`} style={{ width: gutterW }}>
                              <span className="text-[10.5px] font-medium text-black/40 dark:text-white/40">Shots</span>
                            </div>
                            <SimpleBarsRow />
                          </div>
                          {openStripShot && (
                            <div className="flex">
                              <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg} flex items-center px-3`} style={{ width: gutterW }}>
                                <span className="text-[10.5px] font-medium truncate text-black/40 dark:text-white/40">{openStripShot.name}</span>
                              </div>
                              <SimpleStripRow shot={openStripShot} />
                            </div>
                          )}
                          {selectedShot?.video && (
                            <div className="flex">
                              <div className={`sticky left-0 z-10 shrink-0 border-r border-black/[0.07] dark:border-white/[0.07] ${gutterBg} flex items-center px-3`} style={{ width: gutterW }}>
                                <span className="text-[10.5px] font-medium text-black/40 dark:text-white/40">Video preview</span>
                              </div>
                              <SimpleFilmstripRow shot={selectedShot} />
                            </div>
                          )}
                        </>
                      ) : (
                        advancedRows
                      )}

                      {/* playhead + snap overlay across the lanes */}
                      <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: gutterW, width: laneW }}>
                        <PlayheadLine />
                        <SnapLine />
                      </div>
                    </LanesWrapper>
                  </div>
                </div>
              )}
            </>
          )}

          {/* recording tint */}
          {recording && !minimized && (
            <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-[#FD631F]/50" />
          )}
        </div>

        {easing && <EasingPopover target={easing} onClose={() => setEasing(null)} />}
        {addAnchor && <AddTrackMenu anchor={addAnchor} onClose={() => setAddAnchor(null)} />}
        {marquee && (
          <div
            className="fixed z-[9990] border border-[#FD631F]/70 bg-[#FD631F]/10 pointer-events-none"
            style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }}
          />
        )}
      </MenuHost>
    </TimelineUICtx.Provider>
  )
}

function PropLaneGutter({ prop }: { prop: AnimatableProp }) {
  return (
    <div className="h-9 flex items-center gap-1.5 pl-8 pr-2 border-b border-black/[0.05] dark:border-white/[0.05]">
      <span className="size-[6px] rotate-45 bg-black/25 dark:bg-white/30 shrink-0" />
      <span className="text-[10px] font-mono text-black/55 dark:text-white/55 truncate">{PROP_LABELS[prop]}</span>
    </div>
  )
}

/**
 * Lanes container: marquee pointer handling passed in, plus the empty-space
 * context menu (Add media/text/logo/audio, paste, select/deselect all) and the
 * simple-mode transition popover host.
 */
function LanesWrapper({ children, onPointerDown }: { children: ReactNode; onPointerDown(e: React.PointerEvent): void }) {
  const ui = useTimelineUI()
  const openCtx = useContextMenu()
  const setSelectedKfIds = usePlayback((s) => s.setSelectedKfIds)
  const [transition, setTransition] = useState<{ shotId: string; anchor: { x: number; y: number } } | null>(null)

  // simple mode has no ShotBarLane mounted to catch the shot-menu event
  useEffect(() => {
    if (!ui.simple) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { shotId: string; x: number; y: number }
      if (detail) setTransition({ shotId: detail.shotId, anchor: { x: detail.x, y: detail.y } })
    }
    window.addEventListener('openmock:open-transition', handler)
    return () => window.removeEventListener('openmock:open-transition', handler)
  }, [ui.simple])

  const trShot = transition ? useProject.getState().scenes.find((s) => s.id === transition.shotId) : null

  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-shot-id],[data-kf-hit],[data-lane-bg],[data-gap-band],button,input')) return
    e.preventDefault()
    const pasteN = clipboardKfCount()
    const p = useProject.getState()
    const items: MenuItem[] = [
      { label: 'Add media…', onSelect: () => void addMediaShot() },
      { label: 'Add text', onSelect: () => void p.addTextScene() },
      { label: 'Add logo', onSelect: () => void p.addLogoScene() },
      { label: 'Add audio…', onSelect: () => void addAudioTrack() },
      menuSeparator,
      {
        label: pasteN > 0 ? `Paste keyframes (${pasteN})` : 'Paste keyframes',
        disabled: pasteN === 0,
        onSelect: () => pasteKfsAtPlayhead(ui.engine),
      },
      { label: 'Select all keyframes', onSelect: () => selectAllShotKfs() },
      {
        label: 'Deselect all',
        onSelect: () => {
          setSelectedKfIds([])
          ui.setSelectedShotIds([])
          ui.setSelectedClipId(null)
        },
      },
    ]
    openCtx(e, items)
  }

  return (
    <div className="relative" onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
      {children}
      {transition && trShot && (
        <TransitionPopover
          anchor={transition.anchor}
          title="Transition out"
          value={trShot.transitionOut}
          onChange={(tr) => useProject.getState().setSceneTransition(trShot.id, tr)}
          onClose={() => setTransition(null)}
        />
      )}
    </div>
  )
}

export default TimelinePanel
