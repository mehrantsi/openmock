import { useEffect, useRef, useState } from 'react'

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Normalize any accepted hex to #rrggbb for the native color input. */
function toRgbHex(hex: string): string {
  if (!HEX_RE.test(hex)) return '#000000'
  let h = hex.slice(1)
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  return `#${h.slice(0, 6).toLowerCase()}`
}

/**
 * Inspector color row: label, editable hex text (double-click), native color
 * swatch. Right-click resets to the default color.
 */
export function ColorControl({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string
  value: string
  defaultValue?: string
  onChange: (hex: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commitEdit = () => {
    setEditing(false)
    const t = text.startsWith('#') ? text : `#${text}`
    if (HEX_RE.test(t)) onChange(t.toLowerCase())
  }

  return (
    <div
      className="h-8 w-full rounded-lg flex items-center justify-between px-2 hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors"
      onContextMenu={(e) => {
        e.preventDefault()
        if (defaultValue !== undefined && value !== defaultValue) onChange(defaultValue)
      }}
    >
      <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70">{label}</span>
      <span className="flex items-center gap-1.5">
        {editing ? (
          <input
            ref={inputRef}
            className="w-[74px] bg-transparent text-right text-[11px] font-mono text-black dark:text-white outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditing(false)
              e.stopPropagation()
            }}
          />
        ) : (
          <button
            className="text-[11px] font-mono text-black/45 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
            onDoubleClick={() => {
              setText(value)
              setEditing(true)
            }}
            onClick={() => {
              setText(value)
              setEditing(true)
            }}
          >
            {value}
          </button>
        )}
        <span
          className="relative w-6 h-4.5 rounded-[5px] border border-black/15 dark:border-white/20 shadow-sm overflow-hidden shrink-0"
          style={{ background: value }}
        >
          <input
            type="color"
            aria-label="Pick color"
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            value={toRgbHex(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        </span>
      </span>
    </div>
  )
}
