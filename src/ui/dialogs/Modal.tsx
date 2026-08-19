/**
 * Shared modal scaffold: dark blurred backdrop, squircle card, Geist
 * title + bracketed GeistMono subtitle, close X, Esc-to-close.
 */

import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[10000] bg-[rgba(6,6,7,0.6)] backdrop-blur-[10px] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${
          wide ? 'w-[min(560px,calc(100vw-32px))]' : 'w-[min(460px,calc(100vw-32px))]'
        } max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-black/10 dark:border-white/10 bg-[#fafafa] text-[#09090b] dark:bg-[#09090b] dark:text-[#fafafa] shadow-[0_20px_60px_-16px_rgba(0,0,0,0.5)] p-5`}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[16px] font-semibold tracking-tight leading-none">{title}</h2>
            {subtitle && (
              <span className="text-[10.5px] font-medium text-black/45 dark:text-white/40">
                {subtitle}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="size-7 rounded-md flex items-center justify-center text-black/45 dark:text-white/45 hover:bg-black/5 dark:hover:bg-white/10 hover:text-black dark:hover:text-white transition-colors"
          >
            <X className="size-[14px]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Section header inside a modal body. */
export function ModalSection({ label }: { label: string }) {
  return (
    <div className="text-[11px] font-semibold tracking-tight text-black/55 dark:text-white/50 mt-4 mb-2">
      {label}
    </div>
  )
}
