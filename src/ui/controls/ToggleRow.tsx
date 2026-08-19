/** Inspector row with a switch on the right. */
export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="h-8 w-full rounded-lg flex items-center justify-between px-2 hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors"
    >
      <span className="text-[11.5px] font-medium text-black/70 dark:text-white/70">{label}</span>
      <span
        className={`w-[26px] h-[15px] rounded-full p-[1.5px] transition-colors ${
          checked ? 'bg-accent' : 'bg-black/[0.14] dark:bg-white/[0.16]'
        }`}
      >
        <span
          className={`block size-3 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[11px]' : ''
          }`}
        />
      </span>
    </button>
  )
}
