/**
 * Video trim filmstrip (44px): thumbnails across the full source duration,
 * dimmed out-of-trim regions, and a draggable orange trim window with edge
 * handles + center time badge. Drives the shot's video trim (and duration for
 * non-looping clips).
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useProject } from '../../state/project'
import { MIN_SHOT_DURATION, type Shot, type VideoTrim } from '../../state/types'
import { getMediaUrl } from '../../lib/media'
import { useTimelineUI } from './context'
import { fmtTimecode } from './format'

interface ThumbSet {
  thumbs: string[]
  duration: number
}

const thumbCache = new Map<string, Promise<ThumbSet | null>>()

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      resolve()
    }
    const guard = setTimeout(done, 900)
    video.addEventListener('seeked', () => {
      clearTimeout(guard)
      done()
    })
    try {
      video.currentTime = t
    } catch {
      clearTimeout(guard)
      done()
    }
  })
}

async function generateThumbs(videoId: string, count: number): Promise<ThumbSet | null> {
  const url = await getMediaUrl(`media:${videoId}`)
  if (!url) return null
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('timeout')), 8000)
    video.onloadeddata = () => {
      clearTimeout(guard)
      resolve()
    }
    video.onerror = () => {
      clearTimeout(guard)
      reject(new Error('video error'))
    }
  }).catch(() => null)
  const duration = video.duration
  if (!Number.isFinite(duration) || duration <= 0) return null
  const W = 72
  const H = 44
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const thumbs: string[] = []
  for (let i = 0; i < count; i++) {
    await seekTo(video, ((i + 0.5) / count) * duration)
    const vw = video.videoWidth || W
    const vh = video.videoHeight || H
    // cover crop
    const scale = Math.max(W / vw, H / vh)
    const dw = vw * scale
    const dh = vh * scale
    try {
      ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh)
      thumbs.push(canvas.toDataURL('image/jpeg', 0.6))
    } catch {
      thumbs.push('')
    }
  }
  video.removeAttribute('src')
  video.load()
  return { thumbs, duration }
}

function useThumbs(videoId: string, count: number): ThumbSet | null | 'loading' {
  const [result, setResult] = useState<ThumbSet | null | 'loading'>('loading')
  useEffect(() => {
    let live = true
    setResult('loading')
    const key = `${videoId}:${count}`
    let p = thumbCache.get(key)
    if (!p) {
      p = generateThumbs(videoId, count)
      thumbCache.set(key, p)
    }
    void p.then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [videoId, count])
  return result
}

export function VideoFilmstrip({ shot }: { shot: Shot }) {
  const ui = useTimelineUI()
  const updateShot = useProject((s) => s.updateShot)
  const setSceneDuration = useProject((s) => s.setSceneDuration)
  const pool = useProject((s) => s.videos)
  const stripRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<VideoTrim | null>(null)

  const video = shot.video
  const poolEntry = video ? pool.find((v) => v.id === video.videoId) : null
  const stripW = Math.max(120, ui.viewW - 16)
  const count = Math.min(18, Math.max(3, Math.round(stripW / 72)))
  const thumbs = useThumbs(video?.videoId ?? '', count)

  if (!video) return null

  const srcDur = thumbs && thumbs !== 'loading' ? thumbs.duration : (poolEntry?.durationSeconds ?? video.trim.sourceOut)
  const trim = preview ?? video.trim
  const pxPerSrc = srcDur > 0 ? stripW / srcDur : 1
  const inX = Math.max(0, trim.sourceIn * pxPerSrc)
  const outX = Math.min(stripW, Math.min(trim.sourceOut, srcDur) * pxPerSrc)
  const speed = video.speed > 0 ? video.speed : 1
  const minLen = MIN_SHOT_DURATION * speed

  const commit = (t: VideoTrim, edge: 'l' | 'r' | 'move') => {
    const cur = useProject.getState().scenes.find((s) => s.id === shot.id)
    if (!cur?.video) return
    if (edge === 'move' || cur.video.loop) {
      updateShot(shot.id, { video: { ...cur.video, trim: t } })
      return
    }
    if (edge === 'l') {
      updateShot(shot.id, { video: { ...cur.video, trim: { sourceIn: cur.video.trim.sourceIn, sourceOut: t.sourceOut } } })
      setSceneDuration(shot.id, (t.sourceOut - t.sourceIn) / speed, { fromStart: true })
    } else {
      setSceneDuration(shot.id, (t.sourceOut - t.sourceIn) / speed)
    }
  }

  const drag = (mode: 'move' | 'l' | 'r') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const orig = { ...video.trim }
    const len = orig.sourceOut - orig.sourceIn
    let last: VideoTrim = orig
    let dragged = false
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) / pxPerSrc
      if (!dragged && Math.abs(ev.clientX - startX) < 2) return
      dragged = true
      if (mode === 'move') {
        const sIn = Math.max(0, Math.min(orig.sourceIn + d, srcDur - len))
        last = { sourceIn: sIn, sourceOut: sIn + len }
      } else if (mode === 'l') {
        const sIn = Math.max(0, Math.min(orig.sourceIn + d, orig.sourceOut - minLen))
        last = { sourceIn: sIn, sourceOut: orig.sourceOut }
      } else {
        const sOut = Math.min(srcDur, Math.max(orig.sourceOut + d, orig.sourceIn + minLen))
        last = { sourceIn: orig.sourceIn, sourceOut: sOut }
      }
      setPreview(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setPreview(null)
      if (dragged) commit(last, mode === 'move' ? 'move' : mode)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div className="h-[44px] relative select-none" style={{ width: stripW }} ref={stripRef}>
      <div className="absolute inset-0 rounded-xl overflow-hidden bg-black/[0.06] dark:bg-white/[0.06]">
        {thumbs === 'loading' ? (
          <div className="h-full flex items-center justify-center gap-2 text-[10px] font-mono text-black/45 dark:text-white/45">
            <Loader2 className="size-3.5 animate-spin" />
            Video preview loading…
          </div>
        ) : thumbs === null ? (
          <div className="h-full flex items-center justify-center text-[10px] font-mono text-amber-600 dark:text-amber-400">
            Source not found on this device — re-upload this shot
          </div>
        ) : (
          <div className="flex h-full">
            {thumbs.thumbs.map((src, i) =>
              src ? (
                <img key={i} src={src} className="h-full flex-1 object-cover min-w-0" draggable={false} alt="" />
              ) : (
                <div key={i} className="h-full flex-1 bg-zinc-400/30" />
              ),
            )}
          </div>
        )}
        {/* dimmed out-of-trim regions */}
        <div className="absolute top-0 bottom-0 left-0 bg-white/60 dark:bg-black/55 pointer-events-none" style={{ width: inX }} />
        <div className="absolute top-0 bottom-0 right-0 bg-white/60 dark:bg-black/55 pointer-events-none" style={{ width: Math.max(0, stripW - outX) }} />
      </div>

      {/* trim window */}
      <div
        role="slider"
        aria-label="Drag to move the trim window"
        className="absolute top-0 bottom-0 border-[1.5px] border-[#FD631F] rounded-xl cursor-grab touch-none"
        style={{ left: inX, width: Math.max(8, outX - inX) }}
        onPointerDown={drag('move')}
      >
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 h-[15px] rounded bg-zinc-900/85 text-white text-[9px] font-mono leading-[15px] whitespace-nowrap pointer-events-none">
          {fmtTimecode(trim.sourceIn)} → {fmtTimecode(Math.min(trim.sourceOut, srcDur))}
        </div>
        <div className="absolute -left-[5px] top-0 bottom-0 w-[10px] cursor-ew-resize" onPointerDown={drag('l')}>
          <div className="absolute left-[3px] top-1/2 -translate-y-1/2 h-4 w-[4px] rounded-full bg-[#FD631F]" />
        </div>
        <div className="absolute -right-[5px] top-0 bottom-0 w-[10px] cursor-ew-resize" onPointerDown={drag('r')}>
          <div className="absolute right-[3px] top-1/2 -translate-y-1/2 h-4 w-[4px] rounded-full bg-[#FD631F]" />
        </div>
      </div>
    </div>
  )
}
