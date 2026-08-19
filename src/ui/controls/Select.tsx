import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  /** optional CSS background for a preview swatch (gradients, images) */
  preview?: string
  /** small secondary text under the label */
  sub?: string
  disabledReason?: string
}

/**
 * Inspector select row: label left, value + chevron right; options open in a
 * body portal (the panel scroll container clips absolute children).
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  disabledReason,
  placeholder = 'Choose…',
}: {
  label: string
  value: T | '' | null
  options: SelectOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  disabledReason?: string
  placeholder?: string
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean }>({
    left: 0,
    top: 0,
    width: 0,
    up: false,
  })

  const current = options.find((o) => o.value === value) ?? null

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const estH = Math.min(options.length * 30 + 10, 320)
    const up = r.bottom + estH + 8 > window.innerHeight && r.top - estH - 8 > 0
    setPos({ left: r.left, top: up ? r.top - estH - 4 : r.bottom + 4, width: r.width, up })
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (dropRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`h-8 w-full rounded-lg flex items-center justify-between px-2 transition-colors ${
          disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.045]'
        }`}
      >
        <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70">{label}</span>
        <span className="flex items-center gap-1.5 min-w-0">
          {current?.preview && (
            <span className="w-6 h-3.5 rounded-[3px] shrink-0 border border-black/10 dark:border-white/10" style={{ background: current.preview }} />
          )}
          <span className="text-[11px] font-medium rounded-md px-1.5 py-0.5 bg-black/[0.05] dark:bg-white/[0.07] text-black/60 dark:text-white/55 truncate max-w-[110px]">
            {current ? current.label : placeholder}
          </span>
          <ChevronDown className="size-3 text-black/35 dark:text-white/30 shrink-0" strokeWidth={2.5} />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={dropRef}
            className="fixed z-[10020] rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-[#1a1a1f] shadow-2xl py-1 overflow-y-auto"
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: 320 }}
          >
            {options.map((o) => {
              const optDisabled = !!o.disabledReason
              return (
                <button
                  key={o.value}
                  title={o.disabledReason}
                  disabled={optDisabled}
                  onClick={() => {
                    setOpen(false)
                    onChange(o.value)
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-[6px] text-left text-[11px] transition-colors ${
                    optDisabled
                      ? 'opacity-40 cursor-not-allowed text-black/60 dark:text-white/50'
                      : 'text-black/75 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                  }`}
                >
                  {o.preview && (
                    <span className="w-7 h-4 rounded-[3px] shrink-0 border border-black/10 dark:border-white/10" style={{ background: o.preview }} />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.sub && <span className="block text-[9px] text-black/35 dark:text-white/30">{o.sub}</span>}
                  </span>
                  {o.value === value && <Check className="size-3 text-[#FD631F] shrink-0" strokeWidth={3} />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
