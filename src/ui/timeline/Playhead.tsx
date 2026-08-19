/**
 * Playhead visuals: orange ▼ marker + floating time badge (in the sticky ruler
 * row) and the vertical line across the lanes. Self-animates with rAF while
 * playing (the store's projectTime is throttled), tracks the store otherwise.
 */

import { useEffect, useRef } from 'react'
import { usePlayback } from '../../state/playback'
import { fmtRulerBadge } from './format'
import { useTimelineUI } from './context'

/** Drive `apply(t)` from the precise engine clock (rAF while playing). */
function usePlayheadTime(apply: (t: number) => void): void {
  const ui = useTimelineUI()
  const applyRef = useRef(apply)
  applyRef.current = apply

  const phase = usePlayback((s) => s.phase)
  const projectTime = usePlayback((s) => s.projectTime)
  const scrubbing = usePlayback((s) => s.scrubbing)

  // store-driven updates (paused / parked / throttled pushes)
  useEffect(() => {
    applyRef.current(ui.engine.getTime())
  }, [projectTime, ui.engine, ui.pxPerSec, ui.laneW])

  // rAF while playing or scrubbing for smooth motion
  useEffect(() => {
    if (phase !== 'playing' && !scrubbing) return
    let raf = 0
    const tick = () => {
      applyRef.current(ui.engine.getTime())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, scrubbing, ui.engine])
}

/** ▼ marker + floating `s.cc` badge, rendered inside the sticky ruler row. */
export function PlayheadMarker() {
  const ui = useTimelineUI()
  const markerRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLDivElement>(null)

  usePlayheadTime((t) => {
    const x = t * ui.pxPerSec
    if (markerRef.current) markerRef.current.style.transform = `translateX(${x}px)`
    const badge = badgeRef.current
    if (badge) {
      const scroller = ui.getScrollEl()
      const scrollLeft = scroller?.scrollLeft ?? 0
      const visibleW = (scroller?.clientWidth ?? ui.viewW + ui.gutterW) - ui.gutterW
      const half = badge.offsetWidth / 2 || 16
      const bx = Math.min(Math.max(x, scrollLeft + half + 2), scrollLeft + visibleW - half - 2)
      badge.style.transform = `translateX(${bx}px)`
      badge.textContent = fmtRulerBadge(t)
    }
  })

  return (
    <>
      <div ref={markerRef} className="absolute top-0 bottom-0 left-0 pointer-events-none z-10" aria-label="Playhead time">
        <svg width="6" height="5" viewBox="0 0 6 5" className="absolute -left-[3px] top-[15px]">
          <path d="M 0 0 H 6 L 3 5 Z" fill="#fd631f" />
        </svg>
      </div>
      <div
        ref={badgeRef}
        className="absolute top-0 left-0 -translate-x-1/2 h-[15px] px-1 rounded-[4px] bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 text-[9px] leading-[15px] font-mono pointer-events-none z-10 whitespace-nowrap"
        style={{ marginLeft: 0 }}
      />
    </>
  )
}

/** Vertical playhead line across the lanes area. */
export function PlayheadLine() {
  const ui = useTimelineUI()
  const ref = useRef<HTMLDivElement>(null)
  usePlayheadTime((t) => {
    if (ref.current) ref.current.style.transform = `translateX(${t * ui.pxPerSec}px)`
  })
  return (
    <div ref={ref} className="absolute top-0 bottom-0 left-0 w-px bg-[#fd631f] pointer-events-none z-[5]" />
  )
}

/** Snap indicator line (shown while a drag snaps to the playhead / grid). */
export function SnapLine() {
  const ui = useTimelineUI()
  if (ui.snapLine === null) return null
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-[#fd631f]/70 pointer-events-none z-[6]"
      style={{ left: ui.snapLine * ui.pxPerSec }}
    />
  )
}
