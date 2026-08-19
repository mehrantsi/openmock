import { useCallback, useRef } from 'react'

/**
 * 2-D XY pad (Focus Position, Light Position): crosshair grid + draggable dot.
 * Values map linearly into [min, max] on both axes (top-left = min/min).
 * Set `invertY` for y-up value spaces (e.g. UV focus coordinates, where
 * y = 1 is the TOP of the frame) so the dot and drags match what's on screen.
 */
export function LightPad({
  label,
  x,
  y,
  min,
  max,
  step,
  invertY = false,
  onChange,
}: {
  label: string
  x: number
  y: number
  min: number
  max: number
  step: number
  invertY?: boolean
  onChange: (x: number, y: number) => void
}) {
  const padRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const quantize = useCallback(
    (v: number) => Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step)),
    [min, max, step],
  )

  const apply = useCallback(
    (clientX: number, clientY: number) => {
      const el = padRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const nx = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      let ny = Math.min(1, Math.max(0, (clientY - r.top) / r.height))
      if (invertY) ny = 1 - ny
      onChange(quantize(min + nx * (max - min)), quantize(min + ny * (max - min)))
    },
    [min, max, invertY, onChange, quantize],
  )

  const span = max - min || 1
  const px = ((x - min) / span) * 100
  const py = (invertY ? 1 - (y - min) / span : (y - min) / span) * 100
  const prec = step < 1 ? (String(step).split('.')[1]?.length ?? 2) : 0

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-medium text-black/60 dark:text-white/55">{label}</span>
        <span className="text-[10px] tabular-nums text-black/40 dark:text-white/35">
          {x.toFixed(prec)}, {y.toFixed(prec)}
        </span>
      </div>
      <div
        ref={padRef}
        className="relative w-full h-[104px] rounded-md bg-black/[0.05] dark:bg-white/[0.06] overflow-hidden cursor-crosshair touch-none select-none"
        onPointerDown={(e) => {
          ;(e.target as Element).setPointerCapture(e.pointerId)
          dragging.current = true
          apply(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (dragging.current) apply(e.clientX, e.clientY)
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
      >
        {/* crosshair grid */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-black/10 dark:bg-white/10 pointer-events-none" />
        <div className="absolute top-1/2 left-0 right-0 h-px bg-black/10 dark:bg-white/10 pointer-events-none" />
        <div className="absolute left-1/4 top-0 bottom-0 w-px bg-black/[0.04] dark:bg-white/[0.05] pointer-events-none" />
        <div className="absolute left-3/4 top-0 bottom-0 w-px bg-black/[0.04] dark:bg-white/[0.05] pointer-events-none" />
        <div className="absolute top-1/4 left-0 right-0 h-px bg-black/[0.04] dark:bg-white/[0.05] pointer-events-none" />
        <div className="absolute top-3/4 left-0 right-0 h-px bg-black/[0.04] dark:bg-white/[0.05] pointer-events-none" />
        {/* dot */}
        <div
          className="absolute size-2.5 rounded-full bg-[#FD631F] border border-white/70 shadow -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${px}%`, top: `${py}%` }}
        />
      </div>
    </div>
  )
}
