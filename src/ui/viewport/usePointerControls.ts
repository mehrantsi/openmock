/**
 * Viewport camera interaction (no OrbitControls):
 * - 1-pointer drag: tiltY += 0.5·dx, tiltX += 0.5·dy (flat ±70/±60, 3D ±180)
 * - Space- or Alt-drag: panX += 0.001·dx·zoom, panY −= 0.001·dy·zoom, clamp ±3,
 *   with snap-to-center (enter |v| < 0.0025·zoom, release > 0.0035·zoom)
 * - Wheel: zoom = clamp(zoom + 0.005·ΔY, 0.5, 10), committed 150 ms after the
 *   last event
 * - Pinch (2 pointers): mid-point delta tilts, distance delta zooms
 *
 * Moves are written transiently; lifting the last pointer commits one undoable
 * edit (pre-gesture values are silently restored, then committed over).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../../state/project'
import { useSettings } from '../../state/settings'
import { gestureFlags } from '../../lib/gestureFlags'
import type { RenderState } from '../../state/types'

type GestureKey = 'tiltX' | 'tiltY' | 'panX' | 'panY' | 'zoom'

const GESTURE_KEYS: GestureKey[] = ['tiltX', 'tiltY', 'panX', 'panY', 'zoom']

export interface CenterGuides {
  x: boolean
  y: boolean
}

export interface PointerControls {
  cursor: 'grab' | 'grabbing'
  guides: CenterGuides
  onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void
  onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void
  onPointerUp(e: React.PointerEvent<HTMLCanvasElement>): void
  onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>): void
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Commit a finished gesture as ONE undoable edit despite transient moves. */
function commitKeys(before: Partial<Record<GestureKey, number>>): void {
  const p = useProject.getState()
  const restore: Partial<RenderState> = {}
  const after: Partial<RenderState> = {}
  let any = false
  for (const k of GESTURE_KEYS) {
    const b = before[k]
    if (typeof b !== 'number') continue
    const a = p.dials[k]
    if (Math.abs(a - b) < 1e-9) continue
    restore[k] = b
    after[k] = a
    any = true
  }
  if (!any) return
  // silently rewind so the commit registers as a change (history + recorder)
  useProject.setState({ dials: { ...p.dials, ...restore } })
  p.setDials(after)
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input, textarea, select, [contenteditable="true"]')
}

export function usePointerControls(
  canvas: HTMLCanvasElement | null,
  setInteracting: (v: boolean) => void,
): PointerControls {
  const [cursor, setCursor] = useState<'grab' | 'grabbing'>('grab')
  const [guides, setGuides] = useState<CenterGuides>({ x: false, y: false })

  const ref = useRef({
    spaceDown: false,
    pointers: new Map<number, { x: number; y: number }>(),
    dragging: false,
    mode: 'tilt' as 'tilt' | 'pan',
    startX: 0,
    startY: 0,
    base: {} as Partial<Record<GestureKey, number>>,
    gestureBefore: null as Partial<Record<GestureKey, number>> | null,
    zoomAtStart: 2,
    snappedX: false,
    snappedY: false,
    // pinch
    lastMid: null as { x: number; y: number } | null,
    lastDist: 0,
    // wheel
    wheelBefore: null as number | null,
    wheelTimer: 0 as ReturnType<typeof setTimeout> | 0,
  })

  const api = useMemo<PointerControls>(() => {
    const st = ref.current

    const beginGestureIfNeeded = () => {
      if (st.gestureBefore) return
      const d = useProject.getState().dials
      st.gestureBefore = { tiltX: d.tiltX, tiltY: d.tiltY, panX: d.panX, panY: d.panY, zoom: d.zoom }
    }

    const anchorSingle = (x: number, y: number, mode: 'tilt' | 'pan') => {
      const d = useProject.getState().dials
      st.mode = mode
      st.startX = x
      st.startY = y
      st.base = { tiltX: d.tiltX, tiltY: d.tiltY, panX: d.panX, panY: d.panY }
      st.zoomAtStart = d.zoom
    }

    const tiltLimits = () => {
      const model = !!useProject.getState().dials.mockupModel
      return model ? { x: 180, y: 180 } : { x: 70, y: 60 }
    }

    const snapAxis = (v: number, snapped: boolean, zoom: number): [number, boolean] => {
      if (!useSettings.getState().snapToCenter) return [v, false]
      if (snapped) {
        if (Math.abs(v) > 0.0035 * zoom) return [v, false]
        return [0, true]
      }
      if (Math.abs(v) < 0.0025 * zoom) return [0, true]
      return [v, false]
    }

    const updateGuides = () => {
      const show = useSettings.getState().centerGuides
      setGuides((g) => {
        const next = { x: show && st.snappedX, y: show && st.snappedY }
        return g.x === next.x && g.y === next.y ? g : next
      })
    }

    const endGesture = () => {
      st.dragging = false
      st.lastMid = null
      st.snappedX = false
      st.snappedY = false
      updateGuides()
      setCursor('grab')
      setInteracting(false)
      if (st.gestureBefore) {
        commitKeys(st.gestureBefore)
        st.gestureBefore = null
      }
    }

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      beginGestureIfNeeded()
      setInteracting(true)
      setCursor('grabbing')
      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()]
        st.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        st.lastDist = Math.hypot(a.x - b.x, a.y - b.y)
        st.dragging = false
      } else {
        st.dragging = true
        const pan = st.spaceDown || e.altKey
        if (st.spaceDown) gestureFlags.spacePanned = true // this Space hold is a pan, not play/pause
        anchorSingle(e.clientX, e.clientY, pan ? 'pan' : 'tilt')
      }
    }

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!st.pointers.has(e.pointerId)) return
      st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const p = useProject.getState()

      if (st.pointers.size >= 2 && st.lastMid) {
        const [a, b] = [...st.pointers.values()]
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const lim = tiltLimits()
        const d = p.dials
        const patch: Partial<RenderState> = {
          tiltY: clamp(d.tiltY + 0.5 * (mid.x - st.lastMid.x), -lim.y, lim.y),
          tiltX: clamp(d.tiltX + 0.5 * (mid.y - st.lastMid.y), -lim.x, lim.x),
          zoom: clamp(d.zoom - 0.005 * (dist - st.lastDist), 0.5, 10),
        }
        st.lastMid = mid
        st.lastDist = dist
        p.setDials(patch, { transient: true })
        return
      }

      if (!st.dragging) return
      const dx = e.clientX - st.startX
      const dy = e.clientY - st.startY

      // switch into pan mid-drag when the modifier arrives
      const wantPan = st.spaceDown || e.altKey
      if ((st.mode === 'pan') !== wantPan) {
        anchorSingle(e.clientX, e.clientY, wantPan ? 'pan' : 'tilt')
        return
      }

      if (st.mode === 'tilt') {
        const lim = tiltLimits()
        p.setDials(
          {
            tiltY: clamp((st.base.tiltY ?? 0) + 0.5 * dx, -lim.y, lim.y),
            tiltX: clamp((st.base.tiltX ?? 0) + 0.5 * dy, -lim.x, lim.x),
          },
          { transient: true },
        )
      } else {
        const zoom = st.zoomAtStart
        const rawX = clamp((st.base.panX ?? 0) + 0.001 * dx * zoom, -3, 3)
        const rawY = clamp((st.base.panY ?? 0) - 0.001 * dy * zoom, -3, 3)
        const [panX, sx] = snapAxis(rawX, st.snappedX, zoom)
        const [panY, sy] = snapAxis(rawY, st.snappedY, zoom)
        st.snappedX = sx
        st.snappedY = sy
        updateGuides()
        p.setDials({ panX, panY }, { transient: true })
      }
    }

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!st.pointers.has(e.pointerId)) return
      st.pointers.delete(e.pointerId)
      if (st.pointers.size === 1) {
        // pinch → single drag: re-anchor on the remaining pointer
        const [remaining] = [...st.pointers.values()]
        st.lastMid = null
        st.dragging = true
        anchorSingle(remaining.x, remaining.y, st.spaceDown ? 'pan' : 'tilt')
        return
      }
      if (st.pointers.size === 0) endGesture()
    }

    return {
      cursor: 'grab',
      guides: { x: false, y: false },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setInteracting])

  // space modifier tracking
  useEffect(() => {
    const st = ref.current
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) st.spaceDown = true
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') st.spaceDown = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // wheel zoom (non-passive)
  useEffect(() => {
    if (!canvas) return
    const st = ref.current
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = useProject.getState()
      if (st.wheelBefore === null) st.wheelBefore = p.dials.zoom
      setInteracting(true)
      p.setDials({ zoom: clamp(p.dials.zoom + 0.005 * e.deltaY, 0.5, 10) }, { transient: true })
      if (st.wheelTimer) clearTimeout(st.wheelTimer)
      st.wheelTimer = setTimeout(() => {
        st.wheelTimer = 0
        setInteracting(false)
        if (st.wheelBefore !== null) {
          commitKeys({ zoom: st.wheelBefore })
          st.wheelBefore = null
        }
      }, 150)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      if (st.wheelTimer) {
        clearTimeout(st.wheelTimer)
        st.wheelTimer = 0
      }
    }
  }, [canvas, setInteracting])

  return { ...api, cursor, guides }
}
