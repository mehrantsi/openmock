/**
 * First-record guide modal: looping demo video + the 4-step recording guide.
 * Shown once (localStorage `openmock-record-guide-seen`), CTA starts recording.
 */

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { startRecording } from '../../video/recorder'
import { usePlayback } from '../../state/playback'
import { useTimelineUI } from './context'
import { KEY_RECORD_GUIDE, writeString } from './persist'

const STEPS = [
  'Press the record button. Camera and blur changes are captured as you make them.',
  'Move the playhead, then tweak a dial in the sidebar or in the viewport.',
  'Rinse and repeat. Move along in time, and continue adding keyframes to build animations.',
  'Stop recording and view your animation.',
]

export function RecordGuideModal({ onClose }: { onClose(): void }) {
  const ui = useTimelineUI()
  const start = () => {
    writeString(KEY_RECORD_GUIDE, '1')
    onClose()
    if (usePlayback.getState().phase === 'playing') ui.engine.pause()
    startRecording()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Recording keyframes"
        className="w-[480px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-2xl border border-black/[0.09] dark:border-white/[0.09] bg-white dark:bg-[#17171b] text-black dark:text-white shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="relative">
          <video
            src="/guide-videos/keyframe-demo-web.mp4"
            className="w-full rounded-t-2xl bg-black/[0.06] dark:bg-black/40"
            style={{ aspectRatio: '1280 / 800' }}
            autoPlay
            loop
            muted
            playsInline
            onError={(e) => {
              ;(e.currentTarget as HTMLVideoElement).style.display = 'none'
            }}
          />
          <button
            className="absolute top-3 right-3 p-1.5 rounded-md bg-black/40 text-white/70 hover:text-white"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">
          <h2 className="text-[15px] font-semibold">Recording keyframes</h2>
          <ol className="mt-3 space-y-2">
            {STEPS.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-black/65 dark:text-white/65">
                <span className="shrink-0 size-[18px] rounded-full bg-accent/15 text-accent text-[10px] font-semibold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
          <div className="mt-4 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.07] p-3 text-[11px] leading-relaxed text-black/55 dark:text-white/55">
            <span className="font-semibold text-black/75 dark:text-white/80">Tips:</span> You can copy/paste keyframes, click and drag to
            select multiple, move them around in the timeline and change easing.
          </div>
          <button
            className="mt-4 w-full h-9 rounded-lg bg-accent hover:bg-accent-strong text-white text-[12px] font-semibold"
            onClick={start}
          >
            Start recording
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
