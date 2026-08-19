/**
 * "Add track" popover: Media / Text / Logo / Audio rows with descriptions.
 * Used from the transport bar and the bottom of the layer list.
 */

import { Clapperboard, Hexagon, Music, Type } from 'lucide-react'
import { useProject } from '../../state/project'
import { toast } from '../toast'
import { MAX_SCENES } from '../../state/types'
import { AnchoredPopover } from './menu'
import { addAudioTrack, addMediaShot } from './mediaIngest'

const ITEMS = [
  { id: 'media', label: 'Media', desc: 'New shot from image or video', icon: Clapperboard },
  { id: 'text', label: 'Text', desc: 'Title or caption shot', icon: Type },
  { id: 'logo', label: 'Logo', desc: 'Brand mark shot', icon: Hexagon },
  { id: 'audio', label: 'Audio', desc: 'Music or voiceover track', icon: Music },
] as const

export function AddTrackMenu({ anchor, placement = 'above', onClose }: { anchor: { x: number; y: number }; placement?: 'above' | 'below'; onClose(): void }) {
  const run = (id: (typeof ITEMS)[number]['id']) => {
    onClose()
    const p = useProject.getState()
    switch (id) {
      case 'media':
        void addMediaShot()
        break
      case 'text':
        if (!p.addTextScene()) toast(`Scene limit reached (${MAX_SCENES}).`, 'error')
        break
      case 'logo':
        if (!p.addLogoScene()) toast(`Scene limit reached (${MAX_SCENES}).`, 'error')
        break
      case 'audio':
        void addAudioTrack()
        break
    }
  }

  return (
    <AnchoredPopover anchor={anchor} placement={placement} onClose={onClose} width={232} className="p-1.5">
      <div className="px-2 pt-1.5 pb-1 text-[10.5px] font-medium text-black/40 dark:text-white/40">
        Add to timeline
      </div>
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className="w-full flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-black/[0.05] dark:hover:bg-white/[0.07] text-left"
          onClick={() => run(it.id)}
        >
          <it.icon className="size-4 mt-0.5 shrink-0 text-black/50 dark:text-white/50" />
          <span className="flex flex-col">
            <span className="text-[12px] font-medium text-black/80 dark:text-white/85">{it.label}</span>
            <span className="text-[10px] text-black/45 dark:text-white/45">{it.desc}</span>
          </span>
        </button>
      ))}
    </AnchoredPopover>
  )
}
