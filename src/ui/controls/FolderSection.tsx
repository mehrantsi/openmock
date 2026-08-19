import { useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'

/**
 * Collapsible inspector folder: semibold title, chevron on the right, body in
 * a soft card. Open state persists at `localStorage["openmock-folder2:<key>"]`.
 * Shows a per-folder reset button when `dirty` and an optional extra header
 * control (e.g. "+ Add").
 */
export function FolderSection({
  folderKey,
  title,
  defaultOpen = true,
  dirty = false,
  onReset,
  headerExtra,
  children,
}: {
  folderKey: string
  title: string
  defaultOpen?: boolean
  dirty?: boolean
  onReset?: () => void
  headerExtra?: ReactNode
  children: ReactNode
}) {
  const storageKey = `openmock-folder2:${folderKey}`
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v === null ? defaultOpen : v === '1'
    } catch {
      return defaultOpen
    }
  })

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(storageKey, next ? '1' : '0')
    } catch {
      /* quota — non-fatal */
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 h-8 px-1 group/folder">
        <button className="flex items-center gap-1.5 flex-1 min-w-0 text-left" onClick={toggle}>
          <span className="text-[12px] font-semibold tracking-tight text-black/75 dark:text-white/80 truncate">
            {title}
          </span>
        </button>
        {dirty && onReset && (
          <button
            aria-label={`Reset ${title}`}
            title={`Reset ${title}`}
            onClick={onReset}
            className="size-5 flex items-center justify-center rounded-md text-black/30 dark:text-white/25 hover:text-accent opacity-0 group-hover/folder:opacity-100 transition-opacity"
          >
            <RotateCcw className="size-3" strokeWidth={2.2} />
          </button>
        )}
        {headerExtra}
        <button
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          onClick={toggle}
          className="size-5 flex items-center justify-center rounded-md text-black/30 dark:text-white/30 hover:text-black/60 dark:hover:text-white/60"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
            strokeWidth={2.4}
          />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 rounded-xl border border-black/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-white/[0.03] p-1.5 mb-1">
          {children}
        </div>
      )}
    </div>
  )
}
