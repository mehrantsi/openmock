import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Upload } from 'lucide-react'
import { toast } from '../toast'
import { BG_IMAGE_ACCEPT } from '../../lib/media'

export interface ImagePreset {
  value: string
  label: string
  /** CSS background for the tile */
  preview: string
}

const MAX_UPLOAD_BYTES = 1_048_576 // 1 MiB — picker uploads only

/**
 * Image picker row: select-style trigger with a thumbnail; flyout opens to the
 * LEFT of the panel with a 2-column preset grid plus an upload tile.
 * Uploaded files are stored as data URLs; files over 1 MiB are rejected.
 */
export function ImagePickerControl({
  label,
  value,
  presets,
  onChange,
  accept = BG_IMAGE_ACCEPT,
}: {
  label: string
  value: string | null
  presets: ImagePreset[]
  onChange: (url: string) => void
  accept?: string
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  const FLY_W = 252
  const currentPreset = presets.find((p) => p.value === value) ?? null
  const isCustom = !!value && !currentPreset
  const valueLabel = currentPreset ? currentPreset.label : isCustom ? 'Custom' : 'Choose…'

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const rows = Math.ceil((presets.length + 1) / 2)
    const estH = Math.min(rows * 84 + 14, 420)
    const top = Math.max(8, Math.min(r.top, window.innerHeight - estH - 8))
    setPos({ left: Math.max(8, r.left - FLY_W - 10), top })
  }, [open, presets.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (flyRef.current?.contains(t) || triggerRef.current?.contains(t)) return
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

  const handleFile = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / 1_048_576).toFixed(1)
      toast(`Image is ${mb} MB — max 1.0 MB. Compress it or pick a smaller file.`, 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onChange(reader.result)
        setOpen(false)
      }
    }
    reader.onerror = () => toast('Couldn’t read that file.', 'error')
    reader.readAsDataURL(file)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-full rounded-md flex items-center justify-between px-2.5 bg-black/[0.05] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.09] transition-colors"
      >
        <span className="text-[11px] font-medium text-black/60 dark:text-white/55">{label}</span>
        <span className="flex items-center gap-1.5 min-w-0">
          {value && (
            <span
              className="w-6 h-3.5 rounded-[3px] shrink-0 border border-black/10 dark:border-white/10 bg-cover bg-center"
              style={{ background: currentPreset ? currentPreset.preview : `url("${value}") center / cover no-repeat` }}
            />
          )}
          <span className="text-[11px] text-black/45 dark:text-white/40 truncate max-w-[96px]">{valueLabel}</span>
          <ChevronDown className="size-3 text-black/35 dark:text-white/30 shrink-0" strokeWidth={2.5} />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={flyRef}
            className="fixed z-[10020] rounded-xl border border-black/15 dark:border-white/10 bg-white dark:bg-[#141416] shadow-xl p-1.5 overflow-y-auto"
            style={{ left: pos.left, top: pos.top, width: FLY_W, maxHeight: 420 }}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.value}
                  onClick={() => {
                    onChange(p.value)
                    setOpen(false)
                  }}
                  className="relative aspect-[8/5] rounded-lg overflow-hidden border border-black/10 dark:border-white/10 group"
                  style={{ background: p.preview }}
                >
                  <span className="absolute bottom-1 left-1.5 text-[9px] font-medium text-white drop-shadow [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                    {p.label}
                  </span>
                  {p.value === value && (
                    <span className="absolute top-1 right-1 size-4 rounded-full bg-[#FD631F] flex items-center justify-center">
                      <Check className="size-2.5 text-white" strokeWidth={3.5} />
                    </span>
                  )}
                </button>
              ))}
              <button
                onClick={() => fileRef.current?.click()}
                className={`relative aspect-[8/5] rounded-lg border border-dashed flex flex-col items-center justify-center gap-1 text-black/45 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 transition-colors ${
                  isCustom ? 'border-[#FD631F]/60' : 'border-black/20 dark:border-white/20'
                }`}
                style={isCustom ? { background: `url("${value}") center / cover no-repeat` } : undefined}
              >
                <span
                  className={`flex flex-col items-center gap-1 ${isCustom ? 'bg-black/45 rounded-md px-1.5 py-1 text-white' : ''}`}
                >
                  <Upload className="size-3.5" strokeWidth={2} />
                  <span className="text-[9px] font-medium">{isCustom ? 'Replace custom image' : 'Upload'}</span>
                </span>
                {isCustom && (
                  <span className="absolute top-1 right-1 size-4 rounded-full bg-[#FD631F] flex items-center justify-center">
                    <Check className="size-2.5 text-white" strokeWidth={3.5} />
                  </span>
                )}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
                e.target.value = ''
              }}
            />
          </div>,
          document.body,
        )}
    </>
  )
}
