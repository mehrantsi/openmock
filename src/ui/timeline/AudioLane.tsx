/**
 * Audio lanes: one 36px lane per project audio; sky-blue clips with move /
 * trim / fade-triangle drags, a min-max peak waveform (decoded once per
 * audio), and a click popover (mute, volume, trim, fades, delete).
 */

import { useEffect, useState } from 'react'
import { Music, Volume2, VolumeX, TriangleAlert } from 'lucide-react'
import { useProject } from '../../state/project'
import type { AudioClip, ProjectAudio } from '../../state/types'
import { getMediaBlob } from '../../lib/media'
import { useTimelineUI } from './context'
import { AnchoredPopover, useContextMenu } from './menu'
import { fmtSecondsShort } from './format'

const MIN_CLIP_LEN = 0.1

// ---------------------------------------------------------------------------
// Waveform peaks (module cache)
// ---------------------------------------------------------------------------

const PEAK_BUCKETS = 400
const peaksCache = new Map<string, { value: Float32Array | null; done: boolean }>()
const peaksListeners = new Set<() => void>()

function requestPeaks(audio: ProjectAudio): Float32Array | null {
  const key = audio.id
  const hit = peaksCache.get(key)
  if (hit) return hit.value
  peaksCache.set(key, { value: null, done: false })
  void (async () => {
    try {
      const blob = await getMediaBlob(audio.mediaKey ?? `media:${audio.id}`)
      if (!blob) throw new Error('missing')
      const bytes = await blob.arrayBuffer()
      const ctx = new OfflineAudioContext(1, 1, 44100)
      const buf = await ctx.decodeAudioData(bytes)
      const ch = buf.getChannelData(0)
      const peaks = new Float32Array(PEAK_BUCKETS)
      const per = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS))
      for (let i = 0; i < PEAK_BUCKETS; i++) {
        let max = 0
        const start = i * per
        const end = Math.min(ch.length, start + per)
        for (let j = start; j < end; j += 16) {
          const v = Math.abs(ch[j])
          if (v > max) max = v
        }
        peaks[i] = max
      }
      // normalize
      let top = 0
      for (const v of peaks) top = Math.max(top, v)
      if (top > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= top
      peaksCache.set(key, { value: peaks, done: true })
    } catch {
      peaksCache.set(key, { value: null, done: true })
    }
    for (const l of peaksListeners) l()
  })()
  return null
}

function usePeaks(audio: ProjectAudio): Float32Array | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    peaksListeners.add(l)
    return () => {
      peaksListeners.delete(l)
    }
  }, [])
  return requestPeaks(audio)
}

function Waveform({ audio, clip, width, height }: { audio: ProjectAudio; clip: AudioClip; width: number; height: number }) {
  const peaks = usePeaks(audio)
  if (!peaks || width < 8) return null
  const i0 = Math.floor((clip.trim.sourceIn / audio.durationSeconds) * PEAK_BUCKETS)
  const i1 = Math.ceil((Math.min(clip.trim.sourceOut, audio.durationSeconds) / audio.durationSeconds) * PEAK_BUCKETS)
  const bars: React.ReactNode[] = []
  const step = 3 // barWidth 2 + gap 1
  const n = Math.max(1, Math.floor(width / step))
  for (let i = 0; i < n; i++) {
    const idx = Math.min(PEAK_BUCKETS - 1, i0 + Math.floor(((i + 0.5) / n) * Math.max(1, i1 - i0)))
    const h = Math.max(1, peaks[idx] * (height - 4))
    bars.push(<rect key={i} x={i * step} y={height - h} width={2} height={h} rx={1} />)
  }
  return (
    <svg width={width} height={height} className="absolute inset-0 fill-sky-700 dark:fill-sky-200 opacity-25 pointer-events-none">
      {bars}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Gutter row
// ---------------------------------------------------------------------------

export function AudioGutterCell({ audio }: { audio: ProjectAudio }) {
  const clips = useProject((s) => s.audioClips)
  const setAudioClips = useProject((s) => s.setAudioClips)
  const removeProjectAudio = useProject((s) => s.removeProjectAudio)
  const openCtx = useContextMenu()
  const mine = clips.filter((c) => c.audioId === audio.id)
  const allMuted = mine.length > 0 && mine.every((c) => c.muted)

  const toggleMute = () => {
    setAudioClips(clips.map((c) => (c.audioId === audio.id ? { ...c, muted: !allMuted } : c)))
  }

  return (
    <div
      className="h-9 flex items-center gap-1.5 pl-2 pr-2 border-b border-black/[0.05] dark:border-white/[0.05]"
      onContextMenu={(e) =>
        openCtx(e, [
          { label: allMuted ? 'Unmute track' : 'Mute track', onSelect: toggleMute },
          { label: 'Delete audio track', danger: true, onSelect: () => removeProjectAudio(audio.id) },
        ])
      }
    >
      <button
        className="p-0.5 text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
        title={allMuted ? 'Unmute clip' : 'Mute clip'}
        onClick={toggleMute}
      >
        {allMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
      <Music className="size-3 shrink-0 text-sky-600/70 dark:text-sky-300/70" />
      <span className="flex-1 min-w-0 truncate text-[11px] text-black/70 dark:text-white/70">{audio.name ?? 'Audio'}</span>
      <span className="text-[10px] font-mono text-black/35 dark:text-white/35">{fmtSecondsShort(audio.durationSeconds)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Clip lane
// ---------------------------------------------------------------------------

export function AudioClipLane({ audio }: { audio: ProjectAudio }) {
  const ui = useTimelineUI()
  const clips = useProject((s) => s.audioClips)
  const mine = clips.filter((c) => c.audioId === audio.id).sort((a, b) => a.startTime - b.startTime)
  const [preview, setPreview] = useState<{ id: string; patch: Partial<AudioClip> } | null>(null)
  const [popover, setPopover] = useState<{ clipId: string; anchor: { x: number; y: number } } | null>(null)
  const [sourceMissing, setSourceMissing] = useState(false)

  useEffect(() => {
    let live = true
    void getMediaBlob(audio.mediaKey ?? `media:${audio.id}`).then((b) => {
      if (live) setSourceMissing(!b)
    })
    return () => {
      live = false
    }
  }, [audio])

  const commitClip = (id: string, patch: Partial<AudioClip>) => {
    const all = useProject.getState().audioClips
    useProject.getState().setAudioClips(all.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  const clipDrag = (
    clip: AudioClip,
    mode: 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out',
  ) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let dragged = false
    const len = clip.trim.sourceOut - clip.trim.sourceIn
    const prev = mine.filter((c) => c.id !== clip.id && c.startTime + (c.trim.sourceOut - c.trim.sourceIn) <= clip.startTime + 1e-6)
    const next = mine.filter((c) => c.id !== clip.id && c.startTime >= clip.startTime + len - 1e-6)
    const prevEnd = prev.reduce((m, c) => Math.max(m, c.startTime + (c.trim.sourceOut - c.trim.sourceIn)), 0)
    const nextStart = next.reduce((m, c) => Math.min(m, c.startTime), Infinity)
    let patch: Partial<AudioClip> = {}

    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) / ui.pxPerSec
      if (!dragged && Math.abs(ev.clientX - startX) < 3) return
      dragged = true
      if (mode === 'move') {
        let st = clip.startTime + d
        st = Math.max(prevEnd, Math.min(st, Math.min(nextStart, 180) - len))
        st = Math.max(0, st)
        patch = { startTime: st }
      } else if (mode === 'trim-l') {
        let dd = d
        dd = Math.max(dd, -clip.trim.sourceIn) // can't extend before source start
        dd = Math.max(dd, prevEnd - clip.startTime)
        dd = Math.min(dd, len - MIN_CLIP_LEN)
        patch = {
          startTime: clip.startTime + dd,
          trim: { sourceIn: clip.trim.sourceIn + dd, sourceOut: clip.trim.sourceOut },
        }
      } else if (mode === 'trim-r') {
        let out = clip.trim.sourceOut + d
        out = Math.min(out, audio.durationSeconds)
        out = Math.min(out, clip.trim.sourceIn + (Math.min(nextStart, 180) - clip.startTime))
        out = Math.max(out, clip.trim.sourceIn + MIN_CLIP_LEN)
        patch = { trim: { sourceIn: clip.trim.sourceIn, sourceOut: out } }
      } else if (mode === 'fade-in') {
        const f = Math.max(0, Math.min((clip.fadeIn ?? 0) + d, len - (clip.fadeOut ?? 0)))
        patch = { fadeIn: f }
      } else {
        const f = Math.max(0, Math.min((clip.fadeOut ?? 0) - d, len - (clip.fadeIn ?? 0)))
        patch = { fadeOut: f }
      }
      setPreview({ id: clip.id, patch })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setPreview(null)
      if (dragged) {
        commitClip(clip.id, patch)
      } else if (mode === 'move') {
        ui.setSelectedClipId(clip.id)
        setPopover({ clipId: clip.id, anchor: { x: ev.clientX, y: ev.clientY - 8 } })
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const popClip = popover ? (mine.find((c) => c.id === popover.clipId) ?? null) : null

  return (
    <div className="relative h-9" style={{ width: ui.laneW }}>
      {mine.map((clip) => {
        const p = preview?.id === clip.id ? { ...clip, ...preview.patch } : clip
        const len = p.trim.sourceOut - p.trim.sourceIn
        const left = p.startTime * ui.pxPerSec
        const width = Math.max(4, len * ui.pxPerSec)
        const selected = ui.selectedClipId === clip.id
        const fadeInW = ((p.fadeIn ?? 0) / len) * width
        const fadeOutW = ((p.fadeOut ?? 0) / len) * width
        return (
          <div
            key={clip.id}
            className={`absolute top-1 bottom-1 rounded-lg overflow-hidden cursor-grab touch-none ${
              sourceMissing
                ? 'border border-dashed border-amber-500/60 bg-zinc-300/50 dark:border-amber-400/50 dark:bg-zinc-700/40'
                : selected
                  ? 'bg-sky-500/40 ring-1 ring-sky-600'
                  : 'bg-sky-500/20'
            }`}
            style={{ left, width }}
            title={sourceMissing ? 'Audio source not found on this device — re-upload it, or this clip is silent on export' : undefined}
            onPointerDown={clipDrag(clip, 'move')}
          >
            <Waveform audio={audio} clip={p} width={width} height={28} />
            <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
              {sourceMissing && <TriangleAlert className="size-3 mr-1 shrink-0 text-amber-500" />}
              <span className="text-[10.5px] font-medium truncate text-sky-900 dark:text-sky-50">
                {audio.name ?? 'Audio'}
              </span>
              {clip.muted && <VolumeX className="size-3 ml-1 shrink-0 text-sky-900/70 dark:text-sky-50/70" />}
            </div>
            {/* fade triangles */}
            {fadeInW > 1 && (
              <svg className="absolute left-0 top-0 h-full pointer-events-none" width={fadeInW} preserveAspectRatio="none" viewBox="0 0 10 10">
                <path d="M 0 10 L 10 0 L 0 0 Z" className="fill-sky-900/25 dark:fill-sky-50/25" />
              </svg>
            )}
            {fadeOutW > 1 && (
              <svg className="absolute right-0 top-0 h-full pointer-events-none" width={fadeOutW} preserveAspectRatio="none" viewBox="0 0 10 10">
                <path d="M 10 10 L 0 0 L 10 0 Z" className="fill-sky-900/25 dark:fill-sky-50/25" />
              </svg>
            )}
            {/* fade drag handles */}
            <div className="absolute top-0 size-3 cursor-ew-resize" style={{ left: Math.max(0, fadeInW - 6) }} title="Fade in" onPointerDown={clipDrag(clip, 'fade-in')} />
            <div className="absolute top-0 size-3 cursor-ew-resize" style={{ right: Math.max(0, fadeOutW - 6) }} title="Fade out" onPointerDown={clipDrag(clip, 'fade-out')} />
            {/* trim handles */}
            <div className="absolute left-0 top-0 bottom-0 w-[8px] cursor-ew-resize" onPointerDown={clipDrag(clip, 'trim-l')} />
            <div className="absolute right-0 top-0 bottom-0 w-[8px] cursor-ew-resize" onPointerDown={clipDrag(clip, 'trim-r')} />
          </div>
        )
      })}

      {popClip && popover && (
        <AudioClipPopover
          audio={audio}
          clip={popClip}
          anchor={popover.anchor}
          onClose={() => setPopover(null)}
          onChange={(patch) => commitClip(popClip.id, patch)}
          onDelete={() => {
            const all = useProject.getState().audioClips
            useProject.getState().setAudioClips(all.filter((c) => c.id !== popClip.id))
            setPopover(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Clip popover
// ---------------------------------------------------------------------------

function NumField({ label, value, onCommit, step = 0.1 }: { label: string; value: number; onCommit(v: number): void; step?: number }) {
  const [raw, setRaw] = useState(value.toFixed(2))
  useEffect(() => setRaw(value.toFixed(2)), [value])
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-black/50 dark:text-white/50">{label}</span>
      <input
        className="w-16 h-6 px-1.5 rounded bg-black/[0.05] dark:bg-white/[0.07] text-[11px] font-mono text-right outline-none focus:ring-1 focus:ring-[#FD631F]/60 text-black/80 dark:text-white/85"
        value={raw}
        step={step}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          const v = parseFloat(raw)
          if (Number.isFinite(v)) onCommit(v)
          else setRaw(value.toFixed(2))
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function AudioClipPopover({
  audio,
  clip,
  anchor,
  onClose,
  onChange,
  onDelete,
}: {
  audio: ProjectAudio
  clip: AudioClip
  anchor: { x: number; y: number }
  onClose(): void
  onChange(patch: Partial<AudioClip>): void
  onDelete(): void
}) {
  const len = clip.trim.sourceOut - clip.trim.sourceIn
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} width={248} className="p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium truncate text-black/80 dark:text-white/85">{audio.name ?? 'Audio'}</span>
        <button
          className="p-1 rounded text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white"
          title={clip.muted ? 'Unmute clip' : 'Mute clip'}
          onClick={() => onChange({ muted: !clip.muted })}
        >
          {clip.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </button>
      </div>
      <div className="text-[10px] font-mono text-black/40 dark:text-white/40 mt-0.5">
        {len.toFixed(2)}s · src {audio.durationSeconds.toFixed(2)}s
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] text-black/50 dark:text-white/50 w-12">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(clip.volume * 100)}
          className="flex-1 accent-[#FD631F]"
          onChange={(e) => onChange({ volume: parseInt(e.target.value, 10) / 100 })}
        />
        <span className="text-[10px] font-mono w-7 text-right text-black/50 dark:text-white/50">{Math.round(clip.volume * 100)}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <NumField
          label="In"
          value={clip.trim.sourceIn}
          onCommit={(v) => {
            const nv = Math.max(0, Math.min(v, clip.trim.sourceOut - MIN_CLIP_LEN))
            onChange({ trim: { sourceIn: nv, sourceOut: clip.trim.sourceOut } })
          }}
        />
        <NumField
          label="Out"
          value={clip.trim.sourceOut}
          onCommit={(v) => {
            const nv = Math.min(audio.durationSeconds, Math.max(v, clip.trim.sourceIn + MIN_CLIP_LEN))
            onChange({ trim: { sourceIn: clip.trim.sourceIn, sourceOut: nv } })
          }}
        />
        <NumField label="Fade in" value={clip.fadeIn ?? 0} onCommit={(v) => onChange({ fadeIn: Math.max(0, Math.min(v, len - (clip.fadeOut ?? 0))) })} />
        <NumField label="Fade out" value={clip.fadeOut ?? 0} onCommit={(v) => onChange({ fadeOut: Math.max(0, Math.min(v, len - (clip.fadeIn ?? 0))) })} />
      </div>
      <button
        className="mt-3 w-full h-7 rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 text-[11px] font-medium"
        onClick={onDelete}
      >
        Delete clip
      </button>
    </AnchoredPopover>
  )
}
