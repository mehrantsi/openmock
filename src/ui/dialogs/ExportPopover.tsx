/**
 * Export popover (Image | Video tabs) + the floating export progress pill.
 * Images export ungated; free-tier video is capped (1080p, 30 fps, watermark)
 * with Pro unlocking the rest.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, RectangleHorizontal, RectangleVertical, Square, X } from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { useUI } from '../../state/ui'
import {
  APPSTORE_SIZES,
  MAX_IMAGE_EDGE,
  MAX_VIDEO_EDGE,
  MIN_EDGE,
  ORIENTATION_DEFAULT,
  ORIENTATION_SIZES,
  RATIO_DEFAULT_SIZE,
  lookupResolution,
  pickAvcCodec,
  resolveExportSize,
  videoBitrate,
} from '../../export/resolutions'
import { VIDEO_EXPORT_REASON_TEXT } from '../../export/useExport'
import { useViewportRatio } from '../../state/settings'
import { toast } from '../toast'
import { Segmented } from '../controls/Segmented'
import { openMediaPicker } from '../useMediaIngest'
import { useExportApi, selectedMediaOverrides } from '../chrome/exportContext'
import { requestViewportRender } from '../viewport/engineRef'
import { playSuccess } from '../chrome/sounds'
import { sceneAtTime } from '../../video/timelineOps'
import type { ImageExportOptions, MotionBlurLevel, VideoQuality } from '../../state/types'
import { useIsPro } from '../../state/license'
import { KEY_FREE_EXPORT_TIP, readFlag } from '../timeline/persist'
import { FREE_MAX_VIDEO_EDGE, videoSizeNeedsPro } from '../../lib/pro'

function ProChip() {
  return (
    <span className="ml-2 shrink-0 px-1.5 py-[1px] rounded-full bg-accent/12 text-accent text-[9px] font-semibold">
      PRO
    </span>
  )
}

type Orientation = 'landscape' | 'square' | 'portrait'

const FORMAT_OPTIONS: { value: ImageExportOptions['format']; label: string }[] = [
  { value: 'jpeg', label: 'JPG — SMALLEST FILE' },
  { value: 'png', label: 'PNG — LOSSLESS, TRANSPARENCY' },
  { value: 'webp', label: 'WEBP — MODERN, SMALL' },
]
const FORMAT_SHORT: Record<ImageExportOptions['format'], string> = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP' }
const FORMAT_DESC: Record<ImageExportOptions['format'], string> = {
  jpeg: 'Smallest file. No transparency.',
  png: 'Lossless. Supports transparency.',
  webp: 'Modern and small. Supports transparency.',
}
const QUALITY_DESC: Record<VideoQuality, string> = {
  low: 'Smallest file, fastest export.',
  medium: 'Balanced quality and size.',
  high: 'High quality. Recommended.',
  ultra: 'Maximum bitrate, largest files.',
}
const MOTION_DESC: Record<MotionBlurLevel, string> = {
  off: 'No blur on camera moves.',
  low: 'Subtle smoothing on fast camera moves.',
  medium: 'Cinematic 180° shutter. Slower export.',
  high: 'Long, dramatic blur trails. Slower export.',
}

function orientationOf(size: string, customW?: number, customH?: number): Orientation | null {
  for (const o of ['landscape', 'square', 'portrait'] as const) {
    if (ORIENTATION_SIZES[o].includes(size)) return o
  }
  const r = size === 'custom' && customW && customH ? { width: customW, height: customH } : lookupResolution(size)
  if (r) return r.width > r.height ? 'landscape' : r.width < r.height ? 'portrait' : 'square'
  return null
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium text-black/45 dark:text-white/40 mb-1.5">
      {children}
    </div>
  )
}

function SwitchRow({
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
      onClick={() => onChange(!checked)}
      className="w-full h-8 flex items-center justify-between px-2.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.07] dark:hover:bg-white/[0.08] transition-colors"
    >
      <span className="text-[11px] font-medium text-black/70 dark:text-white/70">{label}</span>
      <span className={`w-7 h-4 rounded-full p-px transition-colors ${checked ? 'bg-[#FD631F]' : 'bg-black/15 dark:bg-white/15'}`}>
        <span className={`block size-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-3' : ''}`} />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Size dropdown
// ---------------------------------------------------------------------------

function SizeDropdown({
  kind,
  orientation,
  value,
  onChange,
  locked,
  onLocked,
}: {
  kind: 'image' | 'video'
  orientation: Orientation
  value: string
  onChange: (size: string) => void
  locked?: (size: string) => boolean
  onLocked?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const sizes = ORIENTATION_SIZES[orientation]
  const appstore = APPSTORE_SIZES[kind]
  const current =
    value === 'custom' ? 'Custom…' : (lookupResolution(value, kind)?.label ?? value)

  const item = (size: string) => {
    const r = lookupResolution(size, kind)
    if (!r) return null
    const isLocked = locked?.(size) ?? false
    return (
      <button
        key={size}
        onClick={() => {
          setOpen(false)
          if (isLocked) onLocked?.()
          else onChange(size)
        }}
        className="w-full h-[30px] px-2.5 rounded-md flex items-center justify-between text-[11px] text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
      >
        <span className="truncate">{r.label}</span>
        {isLocked ? <ProChip /> : value === size && <Check className="size-3 text-[#FD631F]" />}
      </button>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full h-8 px-2.5 rounded-md flex items-center justify-between bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.07] dark:hover:bg-white/[0.08] text-[11px] font-medium text-black/80 dark:text-white/80 transition-colors"
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="size-3 opacity-50 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-[800] max-h-[300px] overflow-y-auto rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-[#1a1a1d] shadow-xl p-1">
          {sizes.map(item)}
          <div className="my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]" />
          <div className="px-2.5 py-1 text-[10px] font-medium text-black/40 dark:text-white/35">
            App Store
          </div>
          {appstore.map(item)}
          <div className="my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]" />
          <button
            onClick={() => {
              onChange('custom')
              setOpen(false)
            }}
            className="w-full h-[30px] px-2.5 rounded-md flex items-center justify-between text-[11px] text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          >
            <span>CUSTOM…</span>
            {value === 'custom' && <Check className="size-3 text-[#FD631F]" />}
          </button>
        </div>
      )}
    </div>
  )
}

function CustomSizeInputs({
  kind,
  width,
  height,
  onCommit,
}: {
  kind: 'image' | 'video'
  width: number
  height: number
  onCommit: (w: number, h: number) => void
}) {
  const [wText, setWText] = useState(String(width))
  const [hText, setHText] = useState(String(height))
  useEffect(() => setWText(String(width)), [width])
  useEffect(() => setHText(String(height)), [height])

  const maxEdge = kind === 'video' ? MAX_VIDEO_EDGE : MAX_IMAGE_EDGE

  const commit = () => {
    const parse = (t: string, fallback: number) => {
      const n = Math.round(parseFloat(t))
      return Number.isFinite(n) ? n : fallback
    }
    let w = parse(wText, width)
    let h = parse(hText, height)
    if (w > maxEdge || h > maxEdge) {
      toast(kind === 'video' ? `Max video export size ${MAX_VIDEO_EDGE} pixels` : `Max export size ${MAX_IMAGE_EDGE} pixels`)
    }
    w = Math.min(maxEdge, Math.max(MIN_EDGE, w))
    h = Math.min(maxEdge, Math.max(MIN_EDGE, h))
    onCommit(w, h)
  }

  const cls =
    'w-full h-8 px-2.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] text-[11px] font-medium text-black dark:text-white outline-none focus:ring-1 focus:ring-[#FD631F]/60'

  return (
    <div>
      <div className="text-[10px] text-black/45 dark:text-white/40 mb-1.5">
        Match the viewport aspect to avoid letterboxing.{kind === 'video' ? ` Max ${MAX_VIDEO_EDGE}px per edge.` : ''}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={cls}
          inputMode="numeric"
          value={wText}
          onChange={(e) => setWText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label="Width"
        />
        <span className="text-[11px] text-black/40 dark:text-white/35">×</span>
        <input
          className={cls}
          inputMode="numeric"
          value={hText}
          onChange={(e) => setHText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label="Height"
        />
      </div>
    </div>
  )
}

const ORIENTATION_OPTIONS = [
  { value: 'landscape' as Orientation, label: <RectangleHorizontal className="size-[11px]" />, title: 'Landscape' },
  { value: 'square' as Orientation, label: <Square className="size-[11px]" />, title: 'Square' },
  { value: 'portrait' as Orientation, label: <RectangleVertical className="size-[11px]" />, title: 'Portrait' },
]

// ---------------------------------------------------------------------------
// Image tab
// ---------------------------------------------------------------------------

function ImageTab({ onStarted }: { onStarted: () => void }) {
  const ex = useExportApi()
  const opts = useProject((s) => s.imageExportOptions)
  const setOpts = useProject((s) => s.setImageExportOptions)
  const [orientation, setOrientation] = useState<Orientation>(() => orientationOf(opts.size) ?? 'landscape')

  const busy = ex?.phase === 'rendering'
  const { width, height } = resolveExportSize(opts.size, opts.customWidth, opts.customHeight, 'image')
  const transparencyOk = opts.format !== 'jpeg'

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>Format</Label>
        <div className="relative">
          <select
            value={opts.format}
            onChange={(e) => setOpts({ format: e.target.value as ImageExportOptions['format'] })}
            className="w-full h-8 px-2.5 pr-7 rounded-md appearance-none bg-black/[0.04] dark:bg-white/[0.05] text-[11px] font-medium text-black/80 dark:text-white/80 outline-none"
          >
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3 opacity-50 pointer-events-none" />
        </div>
      </div>

      {transparencyOk && (
        <SwitchRow
          label="Transparent Background"
          checked={opts.transparent}
          onChange={(v) => setOpts({ transparent: v })}
        />
      )}

      <div>
        <Label>Orientation</Label>
        <Segmented
          value={orientation}
          options={ORIENTATION_OPTIONS}
          onChange={(o) => {
            setOrientation(o)
            setOpts({ size: ORIENTATION_DEFAULT[o] })
          }}
        />
      </div>

      <div>
        <Label>Size</Label>
        <SizeDropdown
          kind="image"
          orientation={orientation}
          value={opts.size}
          onChange={(size) => {
            setOpts({ size })
            const o = orientationOf(size)
            if (o) setOrientation(o)
          }}
        />
      </div>

      {opts.size === 'custom' && (
        <CustomSizeInputs
          kind="image"
          width={opts.customWidth}
          height={opts.customHeight}
          onCommit={(w, h) => setOpts({ customWidth: w, customHeight: h })}
        />
      )}

      <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-2">
        <div className="text-[12px] font-semibold tabular-nums">
          {width} × {height}
          <span className="ml-2 text-[10px] font-medium text-black/45 dark:text-white/40">
            {FORMAT_SHORT[opts.format]}
            {opts.transparent && transparencyOk ? ' · transparent' : ''}
          </span>
        </div>
        <div className="text-[10px] text-black/45 dark:text-white/40">{FORMAT_DESC[opts.format]}</div>
      </div>

      <button
        disabled={busy}
        onClick={() => {
          void ex
            ?.exportImageNow(selectedMediaOverrides())
            .then((out) => {
              if (out) onStarted()
            })
            .finally(() => requestViewportRender())
        }}
        className="h-9 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {busy ? 'Exporting…' : 'Export Image'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Video tab
// ---------------------------------------------------------------------------

function VideoTab({ onStarted }: { onStarted: () => void }) {
  const ex = useExportApi()
  const pro = useIsPro()
  const setProOpen = useUI((s) => s.setProOpen)
  const setFreeTipOpen = useUI((s) => s.setFreeTipOpen)
  const opts = useProject((s) => s.exportOptions)
  const setOpts = useProject((s) => s.setExportOptions)
  const scenes = useProject((s) => s.scenes)
  const selectedSceneId = useProject((s) => s.selectedSceneId)
  const addKeyframe = useProject((s) => s.addKeyframe)
  const [orientation, setOrientation] = useState<Orientation>(
    () => orientationOf(opts.size, opts.customWidth, opts.customHeight) ?? 'landscape',
  )
  const [softwareEncode, setSoftwareEncode] = useState(false)

  const busy = ex?.phase === 'rendering'
  const ready = ex?.canExportVideo ?? false
  const reason = ex?.exportVideoReason ?? 'no-video'

  if (!ready) {
    const addKf = () => {
      const shot = scenes.find((s) => s.id === selectedSceneId) ?? scenes[0]
      if (!shot) return
      const pt = usePlayback.getState().projectTime
      const { sceneIndex, localT } = sceneAtTime(scenes, pt)
      const t = scenes[sceneIndex]?.id === shot.id ? Math.min(1, Math.max(0, localT)) : 0
      addKeyframe(shot.id, t)
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-relaxed text-black/60 dark:text-white/55">
          {VIDEO_EXPORT_REASON_TEXT[reason === 'ready' ? 'no-video' : reason]}
        </p>
        <div className="flex gap-2">
          {reason === 'no-video' && (
            <button
              onClick={() => openMediaPicker('replace')}
              className="flex-1 h-9 rounded-lg border border-black/15 dark:border-white/15 text-[12px] font-semibold text-black/75 dark:text-white/75 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              Upload a Video
            </button>
          )}
          <button
            onClick={addKf}
            className="flex-1 h-9 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 transition-opacity"
          >
            Add a Keyframe
          </button>
        </div>
      </div>
    )
  }

  const { width, height } = resolveExportSize(opts.size, opts.customWidth, opts.customHeight, 'video')
  const mbps = Math.round(videoBitrate(opts.quality, width, height) / 1e6)
  const effFps = !pro && opts.fps === 60 ? 30 : opts.fps

  useEffect(() => {
    let cancelled = false
    setSoftwareEncode(false)
    if (typeof VideoEncoder === 'undefined') return
    void VideoEncoder.isConfigSupported({
      codec: pickAvcCodec(width, height, effFps),
      width,
      height,
      framerate: effFps,
      hardwareAcceleration: 'prefer-hardware',
    })
      .then((s) => {
        if (!cancelled) setSoftwareEncode(!s.supported)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [width, height, effFps])

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>Orientation</Label>
        <Segmented
          value={orientation}
          options={ORIENTATION_OPTIONS}
          onChange={(o) => {
            setOrientation(o)
            setOpts({ size: ORIENTATION_DEFAULT[o] })
          }}
        />
      </div>

      <div>
        <Label>Size</Label>
        <SizeDropdown
          kind="video"
          orientation={orientation}
          value={opts.size}
          onChange={(size) => {
            setOpts({ size })
            const o = orientationOf(size)
            if (o) setOrientation(o)
          }}
          locked={(size) => !pro && videoSizeNeedsPro(size, opts.customWidth, opts.customHeight)}
          onLocked={() => setProOpen(true)}
        />
      </div>

      {opts.size === 'custom' && (
        <CustomSizeInputs
          kind="video"
          width={opts.customWidth}
          height={opts.customHeight}
          onCommit={(w, h) => setOpts({ customWidth: w, customHeight: h })}
        />
      )}

      <div>
        <Label>Quality</Label>
        <Segmented
          value={opts.quality}
          options={[
            { value: 'low' as VideoQuality, label: 'Low' },
            { value: 'medium' as VideoQuality, label: 'Med' },
            { value: 'high' as VideoQuality, label: 'High' },
            { value: 'ultra' as VideoQuality, label: 'Ultra' },
          ]}
          onChange={(quality) => setOpts({ quality })}
        />
        <div className="text-[10px] text-black/45 dark:text-white/40 mt-1">{QUALITY_DESC[opts.quality]}</div>
      </div>

      <div>
        <Label>Frame rate</Label>
        <Segmented
          value={String(effFps) as '30' | '60'}
          options={[
            { value: '30' as const, label: '30 fps' },
            { value: '60' as const, label: pro ? '60 fps' : '60 fps · Pro' },
          ]}
          onChange={(v) => {
            if (v === '60' && !pro) {
              setProOpen(true)
              return
            }
            setOpts({ fps: v === '30' ? 30 : 60 })
          }}
        />
      </div>

      <div>
        <Label>Motion Blur</Label>
        <Segmented
          value={opts.motionBlur}
          options={[
            { value: 'off' as MotionBlurLevel, label: 'Off' },
            { value: 'low' as MotionBlurLevel, label: 'Low' },
            { value: 'medium' as MotionBlurLevel, label: 'Med' },
            { value: 'high' as MotionBlurLevel, label: 'High' },
          ]}
          onChange={(motionBlur) => setOpts({ motionBlur })}
        />
        <div className="text-[10px] text-black/45 dark:text-white/40 mt-1">{MOTION_DESC[opts.motionBlur]}</div>
      </div>

      <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-2">
        <div className="text-[12px] font-semibold tabular-nums">
          {width} × {height}
          <span className="ml-2 text-[10px] font-medium text-black/45 dark:text-white/40">
            {effFps} fps · ~{mbps} Mbps
          </span>
        </div>
        <div className="text-[10px] text-black/45 dark:text-white/40">{QUALITY_DESC[opts.quality]}</div>
        {softwareEncode && (
          <div className="text-[10px] leading-snug text-amber-700 dark:text-amber-400 mt-1">
            No hardware encoder for this size in this browser — export will be slow. A smaller size
            (1080p) exports much faster.
          </div>
        )}
      </div>

      {!pro && (
        <div className="flex items-center justify-between rounded-md bg-accent/[0.08] px-2.5 py-2">
          <span className="text-[10px] leading-snug text-black/60 dark:text-white/55">
            Free video exports include a watermark
            {Math.max(width, height) > FREE_MAX_VIDEO_EDGE
              ? ` and will be scaled down to ${FREE_MAX_VIDEO_EDGE}px`
              : ''}
            . Images are always free.
          </span>
          <button
            onClick={() => setProOpen(true)}
            className="shrink-0 ml-2 text-[10.5px] font-semibold text-accent hover:underline"
          >
            Get Pro
          </button>
        </div>
      )}

      <button
        disabled={busy}
        onClick={() => {
          onStarted()
          if (!pro && !readFlag(KEY_FREE_EXPORT_TIP)) {
            setFreeTipOpen(true)
            return
          }
          void ex?.exportVideoNow()
        }}
        className="h-9 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {busy ? 'Exporting…' : 'Export Video'}
      </button>

      <div className="text-[10px] leading-relaxed text-black/40 dark:text-white/35">
        Keep this tab open while exporting. If you switch tabs or minimise, the export pauses and
        resumes when you return.
        {scenes.length > 1 ? ` Exports all ${scenes.length} scenes back to back.` : ''}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Popover content
// ---------------------------------------------------------------------------

export function ExportPopoverContent({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'image' | 'video'>(() =>
    localStorage.getItem('openmock-export-tab') === 'video' ? 'video' : 'image',
  )
  const setImageOpts = useProject((s) => s.setImageExportOptions)
  const setVideoOpts = useProject((s) => s.setExportOptions)

  // viewport ratio changed since last open → reset sizes to the ratio default
  useEffect(() => {
    const ratio = useViewportRatio.getState().ratio
    const last = localStorage.getItem('openmock-export-lastratio')
    if (last !== ratio) {
      localStorage.setItem('openmock-export-lastratio', ratio)
      const def = RATIO_DEFAULT_SIZE[ratio]
      if (def) {
        setImageOpts({ size: def })
        setVideoOpts({ size: def })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickTab = (t: 'image' | 'video') => {
    setTab(t)
    localStorage.setItem('openmock-export-tab', t)
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={tab}
        options={[
          { value: 'image' as const, label: 'Image' },
          { value: 'video' as const, label: 'Video' },
        ]}
        onChange={pickTab}
      />
      {tab === 'image' ? <ImageTab onStarted={() => {}} /> : <VideoTab onStarted={onClose} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Progress pill (bottom-center of the viewport area)
// ---------------------------------------------------------------------------

export function ExportProgressPill() {
  const ex = useExportApi()
  const [flourish, setFlourish] = useState(false)
  const prevPhase = useRef<string>('idle')

  const phase = ex?.phase ?? 'idle'
  const progress = ex?.progress ?? 0

  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = phase
    if (prev === 'rendering' && phase === 'idle' && progress >= 0.95) {
      setFlourish(true)
      playSuccess()
      const t = setTimeout(() => setFlourish(false), 1100)
      return () => clearTimeout(t)
    }
  }, [phase, progress])

  if (phase !== 'rendering' && !flourish) return null
  const pct = Math.round(progress * 100)
  const done = flourish && phase !== 'rendering'

  return (
    <div
      role="status"
      aria-label={done ? 'Export complete' : `Exporting video, ${pct} percent`}
      className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5 h-9 px-3.5 rounded-full border shadow-lg backdrop-blur-md ${
        done
          ? 'bg-white/90 dark:bg-[rgba(14,14,16,0.9)] border-[#f97316]/40'
          : 'bg-white/90 dark:bg-[rgba(14,14,16,0.9)] border-black/10 dark:border-white/10'
      }`}
    >
      <span className="text-[10.5px] font-medium text-black/70 dark:text-white/75">
        {done ? 'Exported' : 'Exporting'}
      </span>
      {done ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <>
          <span className="w-[140px] h-[6px] rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
            <span
              className="block h-full rounded-full bg-[#f97316] transition-[width] duration-[160ms] ease-linear"
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-black/60 dark:text-white/60">{pct}%</span>
          <button
            aria-label="Cancel export"
            onClick={() => ex?.cancel()}
            className="size-5 rounded-full flex items-center justify-center text-black/45 dark:text-white/45 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <X className="size-3" />
          </button>
        </>
      )}
    </div>
  )
}
