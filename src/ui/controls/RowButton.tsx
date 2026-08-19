import type { ReactNode } from 'react'

/** Generic inspector row that acts as a button (e.g. opens a picker). */
export function RowButton({
  label,
  value,
  onClick,
  children,
}: {
  label: string
  value?: ReactNode
  onClick?: () => void
  children?: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="h-8 w-full rounded-lg flex items-center justify-between px-2 hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors"
    >
      <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70">{label}</span>
      <span className="text-[11px] text-black/45 dark:text-white/40 flex items-center gap-1.5">
        {value}
        {children}
      </span>
    </button>
  )
}
