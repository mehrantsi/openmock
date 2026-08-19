import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { FONTS, ensureFontLoaded, findFont, fontFamilyCss, type FontDef } from '../../lib/presets/fonts'

/** One option row: lazily loads its Google font when scrolled into view. */
function FontOption({
  font,
  active,
  onPick,
}: {
  font: FontDef
  active: boolean
  onPick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !font.google) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            ensureFontLoaded(font, 400)
            io.disconnect()
            return
          }
        }
      },
      { threshold: 0.1 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [font])

  return (
    <button
      ref={ref}
      onClick={onPick}
      className="w-full flex items-center gap-2 px-2.5 py-[7px] text-left hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
    >
      <span
        className="flex-1 truncate text-[13px] text-black/80 dark:text-white/75"
        style={{ fontFamily: fontFamilyCss(font), fontWeight: 400 }}
      >
        {font.label}
      </span>
      {active && <Check className="size-3 text-[#FD631F] shrink-0" strokeWidth={3} />}
    </button>
  )
}

/** Searchable font family combobox with live in-family previews. */
export function FontCombobox({ value, onChange }: { value: string; onChange: (fontId: string) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0 })

  const current = findFont(value)
  const q = query.trim().toLowerCase()
  const filtered = q ? FONTS.filter((f) => f.label.toLowerCase().includes(q)) : FONTS

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const estH = 320
    const top = r.bottom + estH + 8 > window.innerHeight ? Math.max(8, r.top - estH - 4) : r.bottom + 4
    setPos({ left: r.left, top, width: r.width })
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const id = requestAnimationFrame(() => searchRef.current?.focus())
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
      cancelAnimationFrame(id)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-full rounded-md flex items-center justify-between px-2.5 bg-black/[0.05] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.09] transition-colors"
      >
        <span className="text-[11px] font-medium text-black/60 dark:text-white/55">Family</span>
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-black/45 dark:text-white/40 truncate max-w-[110px]">{current.label}</span>
          <ChevronDown className="size-3 text-black/35 dark:text-white/30 shrink-0" strokeWidth={2.5} />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={dropRef}
            className="fixed z-[10020] rounded-lg border border-black/15 dark:border-white/10 bg-white dark:bg-[#141416] shadow-xl flex flex-col overflow-hidden"
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: 320 }}
          >
            <div className="p-1.5 border-b border-black/10 dark:border-white/10 shrink-0">
              <input
                ref={searchRef}
                placeholder="Search fonts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full h-6 px-2 rounded bg-black/[0.05] dark:bg-white/[0.07] text-[11px] text-black dark:text-white outline-none placeholder:text-black/30 dark:placeholder:text-white/25"
              />
            </div>
            <div className="overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-black/40 dark:text-white/35">
                  No fonts match “{query}”
                </div>
              ) : (
                filtered.map((f) => (
                  <FontOption
                    key={f.id}
                    font={f}
                    active={f.id === value}
                    onPick={() => {
                      setOpen(false)
                      onChange(f.id)
                    }}
                  />
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
