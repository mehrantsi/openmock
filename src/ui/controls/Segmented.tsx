export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T
  options: { value: T; label: React.ReactNode; title?: string }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div
      className={`flex p-[3px] h-8 rounded-lg bg-black/[0.05] dark:bg-white/[0.05] border border-black/[0.05] dark:border-white/[0.05] ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md text-[11px] transition-colors flex items-center justify-center gap-1 px-1 ${
            o.value === value
              ? 'bg-white dark:bg-[#26262c] text-accent font-semibold shadow-sm'
              : 'font-medium text-black/45 dark:text-white/40 hover:text-black/70 dark:hover:text-white/65'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
