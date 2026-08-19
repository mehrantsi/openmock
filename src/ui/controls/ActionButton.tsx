/** Full-width inspector action button (Reset Camera, camera presets, …). */
export function ActionButton({
  label,
  onClick,
  disabled = false,
  title,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-8 w-full rounded-lg flex items-center justify-center px-2.5 text-[11.5px] font-medium border transition-colors ${
        disabled
          ? 'border-black/[0.05] dark:border-white/[0.05] text-black/25 dark:text-white/20 cursor-not-allowed'
          : 'border-black/[0.09] dark:border-white/[0.09] text-black/65 dark:text-white/65 hover:border-accent/50 hover:text-accent'
      }`}
    >
      {label}
    </button>
  )
}
