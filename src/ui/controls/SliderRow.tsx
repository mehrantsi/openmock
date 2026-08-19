import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Figma-style scrubbing value row: full-width control, label on the left,
 * value on the right, drag anywhere horizontally to change, double-click to
 * type an exact value. A subtle fill bar indicates position in range.
 */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  precision,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  precision?: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const dragging = useRef(false)

  const prec = precision ?? (step < 1 ? String(step).split('.')[1]?.length ?? 1 : 0)
  const fmt = (v: number) => `${v.toFixed(prec)}${unit}`

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step)),
    [min, max, step],
  )

  const posToValue = useCallback(
    (clientX: number) => {
      const el = ref.current!
      const r = el.getBoundingClientRect()
      const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      return clamp(min + t * (max - min))
    },
    [clamp, min, max],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragging.current = true
    onChange(posToValue(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) onChange(posToValue(e.clientX))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    onCommit?.(posToValue(e.clientX))
  }

  const startEdit = () => {
    setText(String(value))
    setEditing(true)
  }
  const commitEdit = () => {
    setEditing(false)
    const v = parseFloat(text)
    if (!Number.isNaN(v)) {
      const c = clamp(v)
      onChange(c)
      onCommit?.(c)
    }
  }

  useEffect(() => {
    if (!editing) return
    const el = ref.current?.querySelector('input')
    el?.focus()
    el?.select()
  }, [editing])

  const fillPct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))

  return (
    <div
      ref={ref}
      className="group relative h-9 w-full rounded-lg flex flex-col justify-center gap-1 px-2 cursor-ew-resize select-none touch-none hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={startEdit}
    >
      <div className="flex items-center justify-between gap-2 leading-none">
        <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70 truncate">{label}</span>
        {editing ? (
          <input
            className="w-16 bg-transparent text-right text-[11px] font-mono tabular-nums text-black dark:text-white outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="text-[11px] font-mono tabular-nums text-black/50 dark:text-white/45">{fmt(value)}</span>
        )}
      </div>
      <div className="relative h-[3px] rounded-full bg-black/[0.09] dark:bg-white/[0.11] pointer-events-none">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent/80 group-hover:bg-accent"
          style={{ width: `${fillPct}%` }}
        />
        <div
          className="absolute top-1/2 size-[9px] -translate-y-1/2 -translate-x-1/2 rounded-full bg-white border border-black/15 shadow-sm dark:border-black/40"
          style={{ left: `${fillPct}%` }}
        />
      </div>
    </div>
  )
}
