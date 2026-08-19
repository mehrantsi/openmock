/** "Paste media" chooser — where pasted media lands (replace vs new shot). */

import { useState } from 'react'
import { Modal } from './Modal'
import {
  cancelPaste,
  resolvePaste,
  selectedShotIsLogo,
  useIngestStore,
  type IngestTarget,
} from '../useMediaIngest'

function OptionCard({
  title,
  description,
  onClick,
}: {
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex flex-col items-start gap-1 rounded-xl border border-black/10 dark:border-white/10 p-3.5 text-left hover:border-[#FD631F] hover:bg-[#FD631F]/5 transition-colors"
    >
      <span className="text-[12px] font-semibold uppercase tracking-[0.04em]">{title}</span>
      <span className="text-[11px] leading-snug text-black/50 dark:text-white/45">{description}</span>
    </button>
  )
}

export function PasteModal() {
  const pending = useIngestStore((s) => s.pastePending)
  const [remember, setRemember] = useState(false)
  const isLogo = selectedShotIsLogo()

  const choose = (mode: IngestTarget) => resolvePaste(mode, remember)

  return (
    <Modal open={!!pending} onClose={cancelPaste} title="Paste media" subtitle="Choose where it lands">
      <div className="flex gap-2.5">
        <OptionCard
          title={isLogo ? 'Replace logo' : 'Replace media'}
          description={
            isLogo ? 'Replace the logo in the selected shot' : 'Replace the media in the selected shot'
          }
          onClick={() => choose('replace')}
        />
        <OptionCard
          title="Add new shot"
          description="Add a new shot with this media"
          onClick={() => choose('new-shot')}
        />
      </div>
      <label className="flex items-center gap-2 mt-4 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="size-3.5 accent-[#FD631F]"
        />
        <span className="text-[12px] text-black/70 dark:text-white/70">Remember selection</span>
        <span className="text-[10px] font-medium text-black/40 dark:text-white/35">
          You can change this in the preferences.
        </span>
      </label>
    </Modal>
  )
}
