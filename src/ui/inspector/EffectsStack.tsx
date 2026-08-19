import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Eye, EyeOff, Minus, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FolderSection } from '../controls/FolderSection'
import { DialSlider } from '../controls/DialSlider'
import { Select, type SelectOption } from '../controls/Select'

// ---------------------------------------------------------------------------
// Definitions (values are read fresh each render; setters commit)
// ---------------------------------------------------------------------------

export interface StackSliderDef {
  id: string
  label: string
  min: number
  max: number
  step: number
  def: number
  value: number
  set: (v: number) => void
}

export interface StackSelectDef {
  id: string
  label: string
  options: SelectOption[]
  def: string
  value: string
  set: (v: string) => void
}

export interface StackEffectDef {
  key: string
  label: string
  icon: LucideIcon
  /** on/off state for toggle effects (bloom, screen fade, ghost, liquid glass) */
  enabled?: { value: boolean; set: (v: boolean) => void }
  /** rendered before the sliders (Liquid Glass "Applies to") */
  select?: StackSelectDef
  sliders: StackSliderDef[]
  /** whole-effect disabled reason (Depth/Ghost on 3D models, …) */
  disabledReason?: string | null
}

interface Stash {
  sliders: Record<string, number>
  select?: string
  enabled?: boolean
}

function isDirty(e: StackEffectDef): boolean {
  if (e.enabled?.value) return true
  if (e.select && e.select.value !== e.select.def) return true
  return e.sliders.some((s) => s.value !== s.def)
}

function resetEffect(e: StackEffectDef): void {
  e.enabled?.set(false)
  e.select?.set(e.select.def)
  for (const s of e.sliders) if (s.value !== s.def) s.set(s.def)
}

// ---------------------------------------------------------------------------
// "+ Add effect" picker
// ---------------------------------------------------------------------------

function AddEffectMenu({ candidates, onPick }: { candidates: StackEffectDef[]; onPick: (key: string) => void }) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const estH = candidates.length * 30 + 10
    const top = r.bottom + estH + 8 > window.innerHeight ? Math.max(8, r.top - estH - 4) : r.bottom + 4
    setPos({ left: Math.max(8, r.right - 200), top })
  }, [open, candidates.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
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
        ref={btnRef}
        aria-label="Add effect"
        title="+ Add effect"
        disabled={candidates.length === 0}
        onClick={() => setOpen((v) => !v)}
        className="size-5 flex items-center justify-center rounded text-black/35 dark:text-white/30 hover:text-black/75 dark:hover:text-white/75 disabled:opacity-30"
      >
        <Plus className="size-3.5" strokeWidth={2.4} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[10020] w-[200px] rounded-lg border border-black/15 dark:border-white/10 bg-white dark:bg-[#141416] shadow-xl py-1"
            style={{ left: pos.left, top: pos.top }}
          >
            {candidates.map((c) => (
              <button
                key={c.key}
                onClick={() => {
                  setOpen(false)
                  onPick(c.key)
                }}
                className="w-full flex items-center gap-2 px-2.5 py-[6px] text-left text-[11px] text-black/75 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <c.icon className="size-3 text-black/40 dark:text-white/35" strokeWidth={2.2} />
                {c.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function RowActions({
  label,
  hidden,
  onToggleHide,
  onRemove,
}: {
  label: string
  hidden: boolean
  onToggleHide: () => void
  onRemove: () => void
}) {
  return (
    <span className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover/effect:flex items-center gap-0.5 rounded-md bg-white/90 dark:bg-[#1a1a1d]/95 border border-black/10 dark:border-white/10 px-0.5 py-0.5 shadow-sm">
      <button
        aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
        title={hidden ? 'Show' : 'Toggle visibility'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleHide()
        }}
        className="w-[18px] h-[18px] flex items-center justify-center rounded text-black/45 dark:text-white/40 hover:text-black/80 dark:hover:text-white/80"
      >
        {hidden ? <EyeOff className="size-3" strokeWidth={2.2} /> : <Eye className="size-3" strokeWidth={2.2} />}
      </button>
      <button
        aria-label={`Remove ${label}`}
        title="Remove effect"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="w-[18px] h-[18px] flex items-center justify-center rounded text-black/45 dark:text-white/40 hover:text-red-500"
      >
        <Minus className="size-3" strokeWidth={2.2} />
      </button>
    </span>
  )
}

function MiniSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`w-6 h-3.5 rounded-full p-px transition-colors shrink-0 ${
        checked ? 'bg-[#FD631F]' : 'bg-black/15 dark:bg-white/15'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span className={`block size-3 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-2.5' : ''}`} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

/**
 * Generic effects stack: rows appear when enabled/dirty/explicitly added,
 * a "+" picker offers the rest, hover actions hide (stash + reset) or remove
 * (reset). Used by the Viewport panel and (subset) by the Logo panel.
 */
export function EffectsStack({
  folderKey,
  title = 'Effects',
  effects,
  onEdit,
}: {
  folderKey: string
  title?: string
  effects: StackEffectDef[]
  onEdit?: () => void
}) {
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const stashRef = useRef<Map<string, Stash>>(new Map())

  const visible = effects.filter((e) => isDirty(e) || added.has(e.key) || hiddenKeys.has(e.key))
  const candidates = effects.filter((e) => !visible.includes(e))

  const edit = (fn: () => void) => {
    fn()
    onEdit?.()
  }

  const toggleHide = (e: StackEffectDef) => {
    if (hiddenKeys.has(e.key)) {
      // restore stashed values
      const stash = stashRef.current.get(e.key)
      edit(() => {
        if (stash) {
          for (const s of e.sliders) if (stash.sliders[s.id] !== undefined) s.set(stash.sliders[s.id])
          if (e.select && stash.select !== undefined) e.select.set(stash.select)
          if (e.enabled && stash.enabled !== undefined) e.enabled.set(stash.enabled)
        }
      })
      stashRef.current.delete(e.key)
      setHiddenKeys((prev) => {
        const next = new Set(prev)
        next.delete(e.key)
        return next
      })
    } else {
      // stash + reset to defaults, keep the row
      const stash: Stash = { sliders: {} }
      for (const s of e.sliders) stash.sliders[s.id] = s.value
      if (e.select) stash.select = e.select.value
      if (e.enabled) stash.enabled = e.enabled.value
      stashRef.current.set(e.key, stash)
      edit(() => resetEffect(e))
      setHiddenKeys((prev) => new Set(prev).add(e.key))
      setAdded((prev) => new Set(prev).add(e.key))
    }
  }

  const remove = (e: StackEffectDef) => {
    stashRef.current.delete(e.key)
    edit(() => resetEffect(e))
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      next.delete(e.key)
      return next
    })
    setAdded((prev) => {
      const next = new Set(prev)
      next.delete(e.key)
      return next
    })
  }

  const addEffect = (key: string) => {
    const e = effects.find((x) => x.key === key)
    if (!e) return
    setAdded((prev) => new Set(prev).add(key))
    if (e.enabled && !e.disabledReason) edit(() => e.enabled!.set(true))
    if (e.enabled || e.sliders.length > 1) setExpanded((prev) => new Set(prev).add(key))
  }

  return (
    <FolderSection folderKey={folderKey} title={title} headerExtra={<AddEffectMenu candidates={candidates} onPick={addEffect} />}>
      {visible.length === 0 && (
        <div className="px-1 py-1 text-[10px] text-black/30 dark:text-white/25">No effects — add one with +</div>
      )}
      {visible.map((e) => {
        const hidden = hiddenKeys.has(e.key)
        const rowDisabled = !!e.disabledReason || hidden
        const reason = hidden ? 'Effect hidden' : (e.disabledReason ?? undefined)
        const multi = !!e.enabled || e.sliders.length > 1 || !!e.select
        const isOpen = expanded.has(e.key)

        if (!multi) {
          const s = e.sliders[0]
          return (
            <div key={e.key} className="relative group/effect flex items-center gap-1.5">
              <e.icon className="size-3 shrink-0 text-black/40 dark:text-white/35" strokeWidth={2.2} />
              <div className="flex-1 min-w-0">
                <DialSlider
                  label={e.label}
                  value={s.value}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  defaultValue={s.def}
                  disabled={rowDisabled}
                  disabledReason={reason}
                  onChange={(v) => edit(() => s.set(v))}
                />
              </div>
              <RowActions label={e.label} hidden={hidden} onToggleHide={() => toggleHide(e)} onRemove={() => remove(e)} />
            </div>
          )
        }

        return (
          <div key={e.key} className="flex flex-col gap-1">
            <div
              className={`relative group/effect h-7 rounded-md flex items-center gap-1.5 px-2 bg-black/[0.05] dark:bg-white/[0.06] cursor-pointer select-none ${
                e.disabledReason ? 'opacity-60' : ''
              }`}
              title={reason}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(e.key)) next.delete(e.key)
                  else next.add(e.key)
                  return next
                })
              }
            >
              <e.icon className="size-3 shrink-0 text-black/40 dark:text-white/35" strokeWidth={2.2} />
              <span className="flex-1 text-[11px] font-medium text-black/60 dark:text-white/55 truncate">{e.label}</span>
              {e.enabled && (
                <MiniSwitch
                  checked={e.enabled.value}
                  disabled={rowDisabled}
                  onChange={(v) => edit(() => e.enabled!.set(v))}
                />
              )}
              <ChevronDown
                className={`size-3 shrink-0 text-black/35 dark:text-white/30 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                strokeWidth={2.5}
              />
              <RowActions label={e.label} hidden={hidden} onToggleHide={() => toggleHide(e)} onRemove={() => remove(e)} />
            </div>
            {isOpen && (
              <div className="flex flex-col gap-1 pl-3">
                {e.select && (
                  <Select
                    label={e.select.label}
                    value={e.select.value}
                    options={e.select.options}
                    disabled={rowDisabled}
                    disabledReason={reason}
                    onChange={(v) => edit(() => e.select!.set(v))}
                  />
                )}
                {e.sliders.map((s) => (
                  <DialSlider
                    key={s.id}
                    label={s.label}
                    value={s.value}
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    defaultValue={s.def}
                    disabled={rowDisabled}
                    disabledReason={reason}
                    onChange={(v) => edit(() => s.set(v))}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </FolderSection>
  )
}
