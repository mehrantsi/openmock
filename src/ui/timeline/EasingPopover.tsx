/**
 * Easing popover: 248px card with a 224×224 bezier graph (200px plot, 12px
 * pad), draggable P1/P2 handles, preset row (8 named curves × In/InOut/Out
 * variants) and an animated ball demo (2800ms ping-pong).
 *
 * Applies live to an explicit segment (easing chip) or to every segment
 * adjacent to the selected keyframes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import type { BezierHandle, Keyframe } from '../../state/types'
import {
  DEFAULT_IN,
  DEFAULT_OUT,
  EASING_CURVES,
  EASING_PICKER_LABELS,
  EASING_PICKER_ORDER,
  evalBezier,
  matchNamedEasing,
} from '../../video/easing'
import { AnchoredPopover } from './menu'
import { applySelectionEasing, selectionSegments, sortedKfs } from './kfOps'
import type { EasingTarget } from './context'

const PAD = 12
const PLOT = 200

const toPx = (u: number, v: number) => ({ x: PAD + u * PLOT, y: PAD + PLOT - v * PLOT })

export function EasingPopover({ target, onClose }: { target: EasingTarget; onClose(): void }) {
  const shot = useProject((s) => s.scenes.find((x) => x.id === target.shotId))
  const selectedKfIds = usePlayback((s) => s.selectedKfIds)
  const setSegmentEasing = useProject((s) => s.setSegmentEasing)

  // resolve the segment(s) this popover edits
  const seg = useMemo((): { a: Keyframe; b: Keyframe } | null => {
    if (!shot) return null
    if (target.forSelection) {
      const segs = selectionSegments(shot, selectedKfIds)
      return segs[0] ?? null
    }
    const sorted = sortedKfs(shot)
    const a = sorted.find((k) => k.id === target.startId)
    if (!a) return null
    const b = target.endId ? sorted.find((k) => k.id === target.endId) : sorted[sorted.indexOf(a) + 1]
    return b ? { a, b } : null
  }, [shot, target, selectedKfIds])

  const [p1, setP1] = useState<BezierHandle>(() => (seg?.a.outEasing ? [...seg.a.outEasing] : [...DEFAULT_OUT]) as BezierHandle)
  const [p2, setP2] = useState<BezierHandle>(() => (seg?.b.inEasing ? [...seg.b.inEasing] : [...DEFAULT_IN]) as BezierHandle)

  const commit = (np1: BezierHandle, np2: BezierHandle) => {
    if (!shot) return
    if (target.forSelection) applySelectionEasing(shot, selectedKfIds, np1, np2)
    else if (seg) setSegmentEasing(shot.id, seg.a.id, np1, np2, seg.b.id)
  }

  const apply = (np1: BezierHandle, np2: BezierHandle) => {
    setP1(np1)
    setP2(np2)
    commit(np1, np2)
  }

  // -- handle dragging -------------------------------------------------------
  const svgRef = useRef<SVGSVGElement>(null)
  const dragHandle = (which: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const svg = svgRef.current
    if (!svg) return
    const el = e.currentTarget as Element & { setPointerCapture(id: number): void }
    el.setPointerCapture(e.pointerId)
    const toUV = (ev: PointerEvent): BezierHandle => {
      const r = svg.getBoundingClientRect()
      const u = Math.min(1, Math.max(0, (ev.clientX - r.left - PAD) / PLOT))
      const v = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top - PAD) / PLOT))
      return [Math.round(u * 100) / 100, Math.round(v * 100) / 100]
    }
    const move = (ev: PointerEvent) => {
      const uv = toUV(ev)
      if (which === 1) apply(uv, [...p2ref.current] as BezierHandle)
      else apply([...p1ref.current] as BezierHandle, uv)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const p1ref = useRef(p1)
  const p2ref = useRef(p2)
  p1ref.current = p1
  p2ref.current = p2

  // -- ball demo -------------------------------------------------------------
  const ballRef = useRef<SVGCircleElement>(null)
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      const dot = ballRef.current
      if (dot) {
        const p = toPx(0.5, evalBezier({ p1: p1ref.current, p2: p2ref.current }, 0.5))
        dot.setAttribute('cx', String(p.x))
        dot.setAttribute('cy', String(p.y))
      }
      return
    }
    let raf = 0
    const tick = (now: number) => {
      const cycle = (now % 2800) / 2800
      const u = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2
      const y = evalBezier({ p1: p1ref.current, p2: p2ref.current }, u)
      const p = toPx(u, y)
      const dot = ballRef.current
      if (dot) {
        dot.setAttribute('cx', String(p.x))
        dot.setAttribute('cy', String(p.y))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const named = matchNamedEasing({ p1, p2 })
  const a0 = toPx(0, 0)
  const a1 = toPx(1, 1)
  const h1 = toPx(p1[0], p1[1])
  const h2 = toPx(p2[0], p2[1])

  const setNamed = (name: string, variant: 'in' | 'inOut' | 'out') => {
    const q = EASING_CURVES[name]?.[variant]
    if (!q) return
    apply([q[0], q[1]], [q[2], q[3]])
  }

  if (!shot || !seg) return null

  return (
    <AnchoredPopover anchor={target.anchor} onClose={onClose} width={248} className="p-3">
      <svg ref={svgRef} width={224} height={224} className="block touch-none">
        {/* grid */}
        {Array.from({ length: 6 }, (_, i) => (
          <g key={i} className="stroke-black/[0.08] dark:stroke-white/[0.08]">
            <line x1={PAD + (i * PLOT) / 5} x2={PAD + (i * PLOT) / 5} y1={PAD} y2={PAD + PLOT} />
            <line x1={PAD} x2={PAD + PLOT} y1={PAD + (i * PLOT) / 5} y2={PAD + (i * PLOT) / 5} />
          </g>
        ))}
        {/* dashed guides from anchors to handles */}
        <line x1={a0.x} y1={a0.y} x2={h1.x} y2={h1.y} strokeDasharray="3 3" className="stroke-black/30 dark:stroke-white/30" />
        <line x1={a1.x} y1={a1.y} x2={h2.x} y2={h2.y} strokeDasharray="3 3" className="stroke-black/30 dark:stroke-white/30" />
        {/* curve */}
        <path
          d={`M ${a0.x} ${a0.y} C ${h1.x} ${h1.y}, ${h2.x} ${h2.y}, ${a1.x} ${a1.y}`}
          fill="none"
          stroke="#fd631f"
          strokeWidth={2}
        />
        <circle ref={ballRef} r={4} fill="#fd631f" opacity={0.85} />
        {/* handles */}
        <circle cx={h1.x} cy={h1.y} r={6} className="fill-white stroke-[#fd631f] cursor-grab" strokeWidth={2} onPointerDown={dragHandle(1)} />
        <circle cx={h2.x} cy={h2.y} r={6} className="fill-white stroke-[#fd631f] cursor-grab" strokeWidth={2} onPointerDown={dragHandle(2)} />
      </svg>

      {/* preset names */}
      <div className="mt-2 grid grid-cols-4 gap-1">
        {EASING_PICKER_ORDER.map((name) => (
          <button
            key={name}
            className={`h-6 rounded-md text-[10px] font-mono ${
              named?.name === name
                ? 'bg-[#FD631F] text-white'
                : 'bg-black/[0.05] dark:bg-white/[0.07] text-black/60 dark:text-white/55 hover:bg-black/[0.09] dark:hover:bg-white/[0.11]'
            }`}
            onClick={() => setNamed(name, name === 'linear' ? 'inOut' : (named?.variant ?? 'inOut'))}
          >
            {EASING_PICKER_LABELS[name]}
          </button>
        ))}
      </div>

      {/* variant tabs (hidden for linear) */}
      {named?.name !== 'linear' && (
        <div className="mt-1.5 grid grid-cols-3 gap-1">
          {(['in', 'inOut', 'out'] as const).map((variant) => (
            <button
              key={variant}
              disabled={!named}
              className={`h-6 rounded-md text-[10px] font-mono disabled:opacity-40 ${
                named?.variant === variant
                  ? 'bg-[#FD631F] text-white'
                  : 'bg-black/[0.05] dark:bg-white/[0.07] text-black/60 dark:text-white/55 hover:bg-black/[0.09] dark:hover:bg-white/[0.11]'
              }`}
              onClick={() => named && setNamed(named.name, variant)}
            >
              {variant === 'in' ? 'In' : variant === 'inOut' ? 'InOut' : 'Out'}
            </button>
          ))}
        </div>
      )}
    </AnchoredPopover>
  )
}
