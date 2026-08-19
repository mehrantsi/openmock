/** Keyboard shortcuts reference. ⌘/⌥ swap to Ctrl/Alt on non-Mac platforms. */

import { Modal, ModalSection } from './Modal'
import { useUI } from '../../state/ui'

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const MOD = IS_MAC ? '⌘' : 'Ctrl'
const ALT = IS_MAC ? '⌥' : 'Alt'
const SHIFT = '⇧'

interface Row {
  keys: string[]
  label: string
}

const GENERAL: Row[] = [
  { keys: [`${MOD}S`], label: 'Capture image' },
  { keys: [`${MOD}V`], label: 'Paste image or video' },
  { keys: [`${MOD}Z`], label: 'Undo' },
  { keys: [`${MOD}${SHIFT}Z`], label: 'Redo' },
  { keys: ['Esc'], label: 'Close any open modal' },
]

const WORKSPACE: Row[] = [
  { keys: ['T'], label: 'Toggle video mode (timeline)' },
  { keys: ['P'], label: 'Toggle control panel' },
]

const CAMERA: Row[] = [
  { keys: ['Scroll'], label: 'Zoom' },
  { keys: ['Drag'], label: 'Tilt camera' },
  { keys: ['Space+Drag'], label: 'Pan camera' },
  { keys: [`${ALT}+Drag`], label: 'Pan camera (alt)' },
]

const TIMELINE: Row[] = [
  { keys: ['Space'], label: 'Play / pause preview' },
  { keys: ['⌫'], label: 'Delete selected keyframe(s) / shot' },
  { keys: [`${MOD}${ALT}A`], label: 'Select all keyframes' },
  { keys: ['Shift+Click'], label: 'Toggle keyframe in selection' },
  { keys: [`${MOD}C`], label: 'Copy selected keyframe / shot' },
  { keys: [`${MOD}V`], label: 'Paste keyframe / shot' },
]

function Rows({ rows }: { rows: Row[] }) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center justify-between h-8 border-b border-black/[0.06] dark:border-white/[0.06] last:border-b-0"
        >
          <span className="text-[12px] text-black/70 dark:text-white/70">{r.label}</span>
          <span className="flex gap-1">
            {r.keys.map((k) => (
              <kbd
                key={k}
                className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-black/15 dark:border-white/15 bg-black/[0.04] dark:bg-white/[0.06] text-black/70 dark:text-white/70"
              >
                {k}
              </kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ShortcutsModal() {
  const open = useUI((s) => s.shortcutsOpen)
  const setOpen = useUI((s) => s.setShortcutsOpen)
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      subtitle={IS_MAC ? 'macOS' : 'Windows / Linux'}
    >
      <ModalSection label="General" />
      <Rows rows={GENERAL} />
      <ModalSection label="Workspace" />
      <Rows rows={WORKSPACE} />
      <ModalSection label="Camera / viewport" />
      <Rows rows={CAMERA} />
      <ModalSection label="Timeline" />
      <Rows rows={TIMELINE} />
    </Modal>
  )
}
