import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Inspector section: small icon + semibold label header, then stacked rows. */
export function Section({
  icon: Icon,
  label,
  action,
  children,
}: {
  icon?: LucideIcon
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1 pt-1 pb-0.5">
        {Icon && <Icon className="size-3 text-accent/70" strokeWidth={2.2} />}
        <span className="text-[12px] font-semibold tracking-tight text-black/70 dark:text-white/75">{label}</span>
        {action && <span className="ml-auto flex items-center">{action}</span>}
      </div>
      {children}
    </div>
  )
}
