/**
 * Ruler row: adaptive ticks + labels, scrub interaction (pointer capture,
 * preview while moving, exact seek on release), and orange gap bands with a
 * right-click "Close gap" + first-time gap helper spotlight.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { findGaps } from '../../video/timelineOps'
import { useTimelineUI } from './context'
import { useContextMenu } from './menu'
import { KEY_GAP_TIP, readFlag, writeString } from './persist'

interface Tick {
  x: number
  h: number
  label?: string
}

const LABEL_STEPS = [1, 2, 5, 10, 15, 30]

function buildTicks(pxPerSec: number, totalLen: number, compact: boolean): Tick[] {
  const ticks: Tick[] = []
  if (!(pxPerSec > 0) || !(totalLen > 0)) return ticks
  const labelStep = LABEL_STEPS.find((n) => pxPerSec * n >= 42) ?? 30
  const levels: { step: number; h: number; minPx: number }[] = compact
    ? [{ step: 1, h: 8, minPx: 0 }]
    : [
        { step: 1, h: 8, minPx: 0 },
        { step: 0.5, h: 6, minPx: 7 },
        { step: 0.1, h: 4, minPx: 5 },
        { step: 0.01, h: 3, minPx: 3 },
      ]
  const drawn = new Set<number>()
  for (const lvl of levels) {
    if (lvl.minPx > 0 && pxPerSec * lvl.step < lvl.minPx) continue
    const count = Math.floor(totalLen / lvl.step) + 1
    for (let i = 0; i <= count; i++) {
      const t = i * lvl.step
      if (t > totalLen + 1e-9) break
      const key = Math.round(t * 1000)
      if (drawn.has(key)) continue
      drawn.add(key)
      const tick: Tick = { x: t * pxPerSec, h: lvl.h }
      if (lvl.step === 1 && Math.round(t) % labelStep === 0) tick.label = `${Math.round(t)}s`
      ticks.push(tick)
    }
  }
  return ticks
}

export function Ruler() {
  const ui = useTimelineUI()
  const scenes = useProject((s) => s.scenes)
  const setScrubbing = usePlayback((s) => s.setScrubbing)
  const openCtx = useContextMenu()
  const closeGap = useProject((s) => s.closeGap)
  const ref = useRef<HTMLDivElement>(null)

  const compact = ui.viewW < 680
  const ticks = useMemo(() => buildTicks(ui.pxPerSec, ui.totalLen, compact), [ui.pxPerSec, ui.totalLen, compact])
  const gaps = useMemo(() => findGaps(scenes), [scenes])

  // -- scrub ---------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    setScrubbing(true)
    const seek = (clientX: number) => Math.max(0, Math.min(ui.totalLen, ui.timeAtClientX(clientX)))
    ui.engine.scrubPreview(seek(e.clientX))
    const move = (ev: PointerEvent) => ui.engine.scrubPreview(seek(ev.clientX))
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setScrubbing(false)
      ui.engine.scrubTo(seek(ev.clientX))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={ref}
      aria-label="Scrub timeline"
      className="relative h-[22px] cursor-pointer select-none"
      style={{ width: ui.laneW }}
      onPointerDown={onPointerDown}
    >
      <svg width={ui.laneW} height={22} className="absolute inset-0 pointer-events-none">
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x + 0.5}
            x2={t.x + 0.5}
            y1={22 - t.h}
            y2={22}
            className="stroke-black/25 dark:stroke-white/25"
            strokeWidth={1}
          />
        ))}
      </svg>
      {ticks
        .filter((t) => t.label)
        .map((t, i) => (
          <span
            key={i}
            className="absolute top-[1px] text-[9px] leading-none font-mono text-black/40 dark:text-white/35 pointer-events-none"
            style={{ left: t.x + 3 }}
          >
            {t.label}
          </span>
        ))}
      {gaps.map((g, i) => (
        <div
          key={i}
          data-gap-band={i === 0 ? 'first' : undefined}
          role="note"
          aria-label={`Gap between ${g.beforeName} and ${g.afterName}`}
          title={`Gap between ${g.beforeName} and ${g.afterName} — right-click to close`}
          className="absolute top-0 bottom-0 bg-[#fd631f]/20 cursor-context-menu"
          style={{ left: g.start * ui.pxPerSec, width: Math.max(2, (g.end - g.start) * ui.pxPerSec) }}
          onContextMenu={(e) =>
            openCtx(e, [
              {
                label: 'Close gap',
                onSelect: () => closeGap((g.start + g.end) / 2),
              },
            ])
          }
        />
      ))}
      <GapTip hasGaps={gaps.length > 0} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// First-gap helper spotlight
// ---------------------------------------------------------------------------

function GapTip({ hasGaps }: { hasGaps: boolean }) {
  const [show, setShow] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!hasGaps || readFlag(KEY_GAP_TIP)) {
      setShow(false)
      return
    }
    const h = setTimeout(() => {
      const band = document.querySelector('[data-gap-band="first"]')
      if (band) {
        setRect(band.getBoundingClientRect())
        setShow(true)
      }
    }, 700)
    return () => clearTimeout(h)
  }, [hasGaps])

  if (!show || !rect) return null

  const dismiss = () => {
    writeString(KEY_GAP_TIP, '1')
    setShow(false)
  }

  const cardX = Math.min(Math.max(12, rect.left + rect.width / 2 - 140), window.innerWidth - 292)
  const cardY = Math.max(12, rect.top - 148)

  return createPortal(
    <div className="fixed inset-0 z-[10010]" style={{ background: 'rgba(8,8,10,0.7)' }} onPointerDown={dismiss}>
      <div
        className="fixed rounded-md pointer-events-none"
        style={{
          left: rect.left - 4,
          top: rect.top - 4,
          width: rect.width + 8,
          height: rect.height + 8,
          boxShadow: '0 0 0 2px rgba(253,99,31,0.55), 0 0 24px rgba(253,99,31,0.35)',
        }}
      />
      <div
        className="fixed w-[280px] rounded-xl border border-black/[0.09] dark:border-white/[0.09] bg-white dark:bg-[#17171b] text-black dark:text-white p-4 shadow-2xl"
        style={{ left: cardX, top: cardY }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="text-[12px] font-semibold tracking-tight mb-1.5">Gap between shots</div>
        <p className="text-[12px] leading-relaxed text-black/60 dark:text-white/60">
          This highlighted band means there’s an empty gap between shots. Right-click it to automatically close the
          gap and pull the shots together.
        </p>
        <button
          className="mt-3 h-7 px-3 rounded-md bg-accent hover:bg-accent-strong text-white text-[11px] font-medium"
          onClick={dismiss}
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  )
}
