/**
 * Pre-export interstitial for the free tier: explains the watermark and the
 * 1080p cap, recommends 4K via Pro, then hands off to the export. Shown once
 * unless the user unchecks "don't show again".
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useUI } from '../../state/ui'
import { useExportApi } from '../chrome/exportContext'
import { KEY_FREE_EXPORT_TIP, writeString } from '../timeline/persist'

export function FreeExportTip() {
  const open = useUI((s) => s.freeTipOpen)
  const setOpen = useUI((s) => s.setFreeTipOpen)
  const setProOpen = useUI((s) => s.setProOpen)
  const ex = useExportApi()
  const [dontShow, setDontShow] = useState(true)

  if (!open) return null

  const persist = () => {
    if (dontShow) writeString(KEY_FREE_EXPORT_TIP, '1')
  }
  const exportFree = () => {
    persist()
    setOpen(false)
    void ex?.exportVideoNow()
  }
  const getPro = () => {
    persist()
    setOpen(false)
    setProOpen(true)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onPointerDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Free export"
        className="w-[400px] max-w-[92vw] rounded-2xl border border-black/[0.09] dark:border-white/[0.09] bg-white dark:bg-[#17171b] text-black dark:text-white shadow-2xl p-5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <h2 className="text-[14px] font-semibold tracking-tight">Exporting on the free plan</h2>
          <button
            className="p-1 -m-1 rounded-md text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="text-[12px] leading-relaxed text-black/60 dark:text-white/60">
          Free video exports include an OpenMock watermark and top out at 720p 30 fps. For sharp
          promo videos we recommend 1080p or 4K, available with Pro. Images always export free,
          full quality, no watermark.
        </p>
        <label className="flex items-center gap-2 mt-4 text-[11.5px] text-black/60 dark:text-white/55 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          Don’t show this again
        </label>
        <div className="flex gap-2 mt-4">
          <button
            onClick={exportFree}
            className="flex-1 h-9 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 transition-opacity"
          >
            Export Free Video
          </button>
          <button
            onClick={getPro}
            className="flex-1 h-9 rounded-lg bg-accent hover:bg-accent-strong text-white text-[12px] font-semibold transition-colors"
          >
            Get Pro
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
