/**
 * Depth-of-field guide overlay. Appears for 700 ms after any blur dial edit
 * (fading out over 260 ms):
 * - radial: solid circle of height (focusSize+0.7)·100% centered on the focus
 *   point, plus a dashed circle +0.3·(1+3·falloff) larger
 * - directional: solid focus line (position remapped) + dashed falloff line,
 *   rotated by the blur angle
 * - tilt-shift: two solid lines at ±focusSize around the scan line and two
 *   dashed at ±(focusSize + 0.15·(1+3·falloff)), rotated by the angle
 */

import { useEffect, useRef, useState } from 'react'
import { useProject } from '../../state/project'
import type { RenderState } from '../../state/types'

const BLUR_KEYS: ReadonlySet<keyof RenderState> = new Set<keyof RenderState>([
  'blurMode',
  'blurStrength',
  'focusX',
  'focusY',
  'focusSize',
  'blurAngle',
  'dirPosition',
  'blurFalloff',
  'blurBokeh',
])

const SHOW_MS = 700
const FADE_MS = 260

const solidLine = 'absolute left-[-50%] w-[200%] h-px bg-white/80 shadow-[0_0_2px_rgba(0,0,0,0.55)]'
const dashedLine =
  'absolute left-[-50%] w-[200%] h-px bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.7)_0_6px,transparent_6px_12px)]'

export function DofOverlay() {
  const [visible, setVisible] = useState(false)
  const [fading, setFading] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, force] = useState(0)

  useEffect(() => {
    const bump = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (removeTimer.current) clearTimeout(removeTimer.current)
      setVisible(true)
      setFading(false)
      force((n) => n + 1)
      hideTimer.current = setTimeout(() => {
        setFading(true)
        removeTimer.current = setTimeout(() => setVisible(false), FADE_MS)
      }, SHOW_MS)
    }
    const unsub = useProject.subscribe((s, prev) => {
      if (s.dialEditSeq === prev.dialEditSeq) return
      const edit = s.lastDialEdit
      if (!edit || edit.system) return
      if (!edit.changed.some((k) => BLUR_KEYS.has(k))) return
      if (s.dials.blurMode === 'none' && !edit.changed.includes('blurMode')) return
      bump()
    })
    return () => {
      unsub()
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (removeTimer.current) clearTimeout(removeTimer.current)
    }
  }, [])

  const d = useProject.getState().dials
  if (!visible || d.blurMode === 'none') return null

  const falloffPad = 0.15 * (1 + 3 * d.blurFalloff)

  let guides: React.ReactNode = null
  if (d.blurMode === 'radial') {
    const solidPct = (d.focusSize + 0.7) * 100
    const dashedPct = (d.focusSize + 0.7 + 0.3 * (1 + 3 * d.blurFalloff)) * 100
    const cx = d.focusX * 100
    const cy = (1 - d.focusY) * 100
    guides = (
      <>
        <div
          className="absolute rounded-full border border-white/80 shadow-[0_0_2px_rgba(0,0,0,0.55)]"
          style={{
            left: `${cx}%`,
            top: `${cy}%`,
            height: `${solidPct}%`,
            aspectRatio: '1',
            transform: 'translate(-50%, -50%)',
          }}
        />
        <div
          className="absolute rounded-full border border-dashed border-white/60"
          style={{
            left: `${cx}%`,
            top: `${cy}%`,
            height: `${dashedPct}%`,
            aspectRatio: '1',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </>
    )
  } else if (d.blurMode === 'directional') {
    const pos = (d.dirPosition - 0.5) * 2 * (16 / 9 / 2 + 0.5) + 0.35
    guides = (
      <div className="absolute inset-0" style={{ transform: `rotate(${d.blurAngle}deg)` }}>
        <div className={solidLine} style={{ top: `${pos * 100}%` }} />
        <div className={dashedLine} style={{ top: `${(pos + falloffPad) * 100}%` }} />
      </div>
    )
  } else {
    // tilt-shift
    const cy = (1 - d.focusY) * 100
    const band = d.focusSize * 100
    const dashed = (d.focusSize + falloffPad) * 100
    guides = (
      <div className="absolute inset-0" style={{ transform: `rotate(${d.blurAngle}deg)` }}>
        <div className={solidLine} style={{ top: `${cy - band}%` }} />
        <div className={solidLine} style={{ top: `${cy + band}%` }} />
        <div className={dashedLine} style={{ top: `${cy - dashed}%` }} />
        <div className={dashedLine} style={{ top: `${cy + dashed}%` }} />
      </div>
    )
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden z-20 transition-opacity"
      style={{ opacity: fading ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
    >
      {guides}
    </div>
  )
}
