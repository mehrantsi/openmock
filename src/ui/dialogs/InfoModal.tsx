/** About OpenMock: version, credits, licenses. */

import { Modal, ModalSection } from './Modal'
import { useUI } from '../../state/ui'
import { APP_VERSION } from '../../state/project'

export function InfoModal() {
  const open = useUI((s) => s.aboutOpen)
  const setOpen = useUI((s) => s.setAboutOpen)
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="OpenMock" subtitle={`v${APP_VERSION}`}>
      <div className="flex items-center gap-3 mb-2">
        <span className="size-9 rounded-[9px] overflow-hidden shrink-0">
          <img src="/brand/mark-light.png" alt="" className="size-full dark:hidden" />
          <img src="/brand/mark-dark.png" alt="" className="size-full hidden dark:block" />
        </span>
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold">OpenMock</span>
          <span className="text-[10px] font-medium text-black/45 dark:text-white/40">
            Cinematic device mockup studio
          </span>
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/60">
        OpenMock puts your screenshots on 3D devices and turns them into promo videos. Everything
        runs in your browser: projects, media, and exports never leave this device. No accounts, no
        watermarks, no quotas.
      </p>

      <ModalSection label="Details" />
      <div className="flex flex-col text-[12px]">
        <div className="flex items-center justify-between h-8 border-b border-black/[0.06] dark:border-white/[0.06]">
          <span className="text-black/50 dark:text-white/45">Version</span>
          <span className="font-mono text-[11px]">{APP_VERSION}</span>
        </div>
        <div className="flex items-center justify-between h-8 border-b border-black/[0.06] dark:border-white/[0.06]">
          <span className="text-black/50 dark:text-white/45">License</span>
          <span className="font-mono text-[11px]">FSL-1.1-MIT</span>
        </div>
        <div className="flex items-center justify-between h-8">
          <span className="text-black/50 dark:text-white/45">Source</span>
          <a
            href="https://github.com/mehrantsi/openmock"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent hover:underline"
          >
            GitHub
          </a>
        </div>
      </div>

      <ModalSection label="Credits" />
      <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/60">
        All device 3D models are procedural and built from scratch in three.js. Studio HDRIs and
        floor textures come from Poly Haven (CC0). Apple, iPhone, iPad, MacBook, and Apple Watch
        are trademarks of Apple Inc. OpenMock is an independent project, not affiliated with or
        endorsed by Apple.
      </p>
    </Modal>
  )
}
