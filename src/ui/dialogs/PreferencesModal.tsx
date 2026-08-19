/** User preferences dialog (editor behavior toggles + paste behavior). */

import { Modal, ModalSection } from './Modal'
import { useDialogs } from './dialogStore'
import { useSettings, type PasteBehavior } from '../../state/settings'
import { usePlayback } from '../../state/playback'

function PrefToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-full flex items-start justify-between gap-4 py-2.5 text-left border-b border-black/[0.06] dark:border-white/[0.06] last:border-b-0"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[12px] font-medium text-black/85 dark:text-white/90">
          {label}{' '}
          <span className="text-[10px] font-medium text-black/40 dark:text-white/35">
            [{checked ? 'enabled' : 'disabled'}]
          </span>
        </span>
        <span className="text-[11px] leading-snug text-black/50 dark:text-white/45">{description}</span>
      </span>
      <span
        className={`shrink-0 mt-0.5 w-7 h-4 rounded-full p-px transition-colors ${
          checked ? 'bg-[#FD631F]' : 'bg-black/15 dark:bg-white/15'
        }`}
      >
        <span
          className={`block size-3.5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-3' : ''
          }`}
        />
      </span>
    </button>
  )
}

const PASTE_OPTIONS: { value: PasteBehavior; label: string }[] = [
  { value: 'ask', label: 'Show modal to select' },
  { value: 'replace', label: 'Default paste to replace media' },
  { value: 'new-shot', label: 'Default paste to add shot' },
]

export function PreferencesModal() {
  const open = useDialogs((s) => s.preferencesOpen)
  const setOpen = useDialogs((s) => s.setPreferencesOpen)
  const settings = useSettings()
  const simpleTimeline = usePlayback((s) => s.simpleTimeline)
  const setSimpleTimeline = usePlayback((s) => s.setSimpleTimeline)

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="User preferences" subtitle="Editor">
      <ModalSection label="Preferences" />
      <PrefToggle
        label="Snap to center"
        description="Mock up snaps to center for easier alignment."
        checked={settings.snapToCenter}
        onChange={settings.setSnapToCenter}
      />
      <PrefToggle
        label="Quick capture keyboard shortcut"
        description="Enable/disable the keyboard shortcut (cmd+s/ctrl+s) for quick capturing an image."
        checked={settings.quickCaptureShortcut}
        onChange={settings.setQuickCaptureShortcut}
      />
      <PrefToggle
        label="Sound effects"
        description="Subtle interface sounds — e.g. a chime when an export finishes, a blip when an action can't run."
        checked={settings.soundEffects}
        onChange={settings.setSoundEffects}
      />
      <PrefToggle
        label="Simple timeline"
        description="Stamp keyframes in one action; hide per-property tracks."
        checked={simpleTimeline}
        onChange={setSimpleTimeline}
      />

      <div className="pt-3">
        <div className="text-[12px] font-medium text-black/85 dark:text-white/90">Paste behavior</div>
        <div className="text-[11px] text-black/50 dark:text-white/45 mb-2">
          Where pasted media lands when the project already has media.
        </div>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Paste behavior">
          {PASTE_OPTIONS.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={settings.pasteBehavior === o.value}
              onClick={() => settings.setPasteBehavior(o.value)}
              className={`h-8 px-2.5 rounded-md flex items-center gap-2 text-[12px] transition-colors ${
                settings.pasteBehavior === o.value
                  ? 'bg-black/[0.07] dark:bg-white/[0.1] text-black dark:text-white'
                  : 'text-black/55 dark:text-white/50 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
              }`}
            >
              <span
                className={`size-3 rounded-full border ${
                  settings.pasteBehavior === o.value
                    ? 'border-[#FD631F] bg-[#FD631F] shadow-[inset_0_0_0_2.5px_rgba(250,250,250,0.9)] dark:shadow-[inset_0_0_0_2.5px_rgba(9,9,11,0.9)]'
                    : 'border-black/30 dark:border-white/30'
                }`}
              />
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
