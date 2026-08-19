import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Inspector slider row: label + value line over a real slider track with a
 * thumb. The whole row is a drag surface; double-click edits the value as
 * text, right-click resets to the default. Commit-style: `onChange` fires for
 * every change (the store batches history).
 */
export function DialSlider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  precision,
  unit = '',
  defaultValue,
  disabled = false,
  disabledReason,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  precision?: number
  unit?: string
  defaultValue?: number
  disabled?: boolean
  disabledReason?: string
  onChange: (v: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragging = useRef(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  const prec = precision ?? (step < 1 ? (String(step).split('.')[1]?.length ?? 2) : 0)
  const fmt = (v: number) => `${v.toFixed(prec)}${unit}`

  const quantize = useCallback(
    (v: number) => {
      const q = min + Math.round((v - min) / step) * step
      return Math.min(max, Math.max(min, q))
    },
    [min, max, step],
  )

  const posToValue = useCallback(
    (clientX: number) => {
      const el = ref.current
      if (!el) return value
      const r = el.getBoundingClientRect()
      const t = Math.min(1, Math.max(0, (clientX - r.left - 8) / (r.width - 16)))
      return quantize(min + t * (max - min))
    },
    [quantize, min, max, value],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing || e.button !== 0) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragging.current = true
    onChange(posToValue(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) onChange(posToValue(e.clientX))
  }
  const onPointerUp = () => {
    dragging.current = false
  }

  const startEdit = () => {
    if (disabled) return
    setText(String(value))
    setEditing(true)
  }
  const commitEdit = () => {
    setEditing(false)
    const v = parseFloat(text)
    if (!Number.isNaN(v)) onChange(quantize(v))
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const fillPct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0

  return (
    <div
      ref={ref}
      title={disabled ? disabledReason : undefined}
      className={`group relative h-9 w-full rounded-lg flex flex-col justify-center gap-1 px-2 select-none touch-none transition-colors ${
        disabled
          ? 'opacity-45 cursor-not-allowed'
          : 'cursor-ew-resize hover:bg-black/[0.035] dark:hover:bg-white/[0.045]'
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={startEdit}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!disabled && defaultValue !== undefined && value !== defaultValue) onChange(quantize(defaultValue))
      }}
    >
      <div className="flex items-center justify-between gap-2 leading-none">
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70 truncate">{label}</span>
          {hint && (
            <span className="text-[8.5px] font-medium uppercase tracking-[0.07em] text-black/25 dark:text-white/25">
              {hint}
            </span>
          )}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="w-16 bg-transparent text-right text-[11px] font-mono tabular-nums text-black dark:text-white outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditing(false)
              e.stopPropagation()
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-[11px] font-mono tabular-nums text-black/50 dark:text-white/45 shrink-0">
            {fmt(value)}
          </span>
        )}
      </div>

      {/* track + thumb */}
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
