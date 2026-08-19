/**
 * "Choose a mockup" gate — full-viewport overlay shown while the project has
 * no scenes. Picking a card selects the device (creating the first shot) and
 * auto-loads the bundled starter screenshot as its media.
 */

import { useRef, useState } from 'react'
import { START_CHOICES } from '../../three/devices/registry'
import { useProject } from '../../state/project'
import { applyDefaultMediaForModel } from '../../lib/defaultMedia'

export function MockupGate() {
  const busyRef = useRef(false)
  const [picked, setPicked] = useState<string | null>(null)

  const choose = async (choice: (typeof START_CHOICES)[number]) => {
    if (busyRef.current) return
    busyRef.current = true
    setPicked(choice.id)
    const p = useProject.getState()
    p.selectDevice(choice.model)
    const shotId = useProject.getState().selectedSceneId
    try {
      // each device starts on its platform's stock screen
      if (shotId) await applyDefaultMediaForModel(choice.model, shotId)
    } finally {
      busyRef.current = false
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Choose a mockup to start"
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 backdrop-blur-[6px] bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.94),rgba(255,255,255,0.7))] dark:bg-[radial-gradient(ellipse_at_center,rgba(9,9,11,0.94),rgba(9,9,11,0.7))]"
    >
      <div className="flex flex-col items-center gap-1.5 text-center px-4">
        <h2 className="text-[16px] sm:text-[22px] font-bold uppercase tracking-[0.02em] text-black dark:text-white">
          Choose a mockup
        </h2>
        <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.08em] text-black/45 dark:text-white/45">
          Pick a device to start composing
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 max-w-[720px] w-full">
        {START_CHOICES.map((c) => (
          <button
            key={c.id}
            aria-label={`Start with ${c.label}`}
            onClick={() => void choose(c)}
            className={`group flex flex-col rounded-xl overflow-hidden border transition-all text-left ${
              picked === c.id
                ? 'border-[#FD631F] ring-2 ring-[#FD631F]/30'
                : 'border-black/10 dark:border-white/10 hover:border-[#FD631F]/70 hover:-translate-y-0.5'
            } bg-white dark:bg-[#101012] shadow-sm`}
          >
            <div className="aspect-[4/3] overflow-hidden">
              <img
                src={c.image}
                alt=""
                draggable={false}
                className="w-full h-full object-cover object-top group-hover:scale-[1.03] transition-transform duration-300"
              />
            </div>
            <span className="px-2.5 py-2 text-[10px] font-medium text-black/60 dark:text-white/60">
              {picked === c.id ? 'Loading…' : c.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
