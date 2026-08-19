/**
 * The playback engine: a wall-clock rAF loop driving the usePlayback store,
 * plus a hidden HTMLVideoElement pool that keeps shot video clips in sync
 * with the playhead (playing, scrubbing, or parked).
 *
 * The engine owns time; rendering is delegated to the caller's `renderFrame`
 * callback so it composes with whatever viewport/engine is mounted.
 */

import { useEffect, useRef } from 'react'
import { useProject } from '../state/project'
import { usePlayback } from '../state/playback'
import type { Shot } from '../state/types'
import { canvasLength, frameStackAtTime, sampleShotState, totalDuration } from './timelineOps'
import { clipSourceTime, clipTrimLength, VIDEO_FRAME_EPS } from './videoClock'
import { getMediaUrl } from '../lib/media'
import { requestViewportRender } from '../ui/viewport/engineRef'

/** Throttle for React `projectTime` pushes while playing / scrub-previewing. */
const REACT_PUSH_MS = 150
/** Allowed |element.currentTime - target| before we hard-correct while playing. */
const DRIFT_TOLERANCE = 0.15

// ---------------------------------------------------------------------------
// Video element pool
// ---------------------------------------------------------------------------

export interface ShotVideoElements {
  /** Per-frame sync while the engine drives time (playing or parked frames). */
  sync(pt: number, playing: boolean): void
  /** Cheap approximate seek used while scrubbing (skips while a seek is in flight). */
  scrub(pt: number): void
  /** Exact seek (scrub release, park, pause). */
  seek(pt: number): void
  /** The pool's element for a project video (created on demand; may not be loaded yet). */
  getVideoElement(videoId: string): HTMLVideoElement | null
}

interface PoolEntry {
  el: HTMLVideoElement
  url: string | null
}

interface ActiveClip {
  shot: Shot
  video: NonNullable<Shot['video']>
  localSec: number
}

function resolveActiveClip(scenes: Shot[], pt: number): ActiveClip | null {
  // the clip that matters is the engine-rendered base layer, not whatever
  // overlay card happens to sit above it
  const { floor, floorIsEngine } = frameStackAtTime(scenes, pt)
  const shot = floor && floorIsEngine ? scenes[floor.sceneIndex] : null
  if (!shot?.video || !floor) return null
  return { shot, video: shot.video, localSec: Math.max(0, floor.localT * shot.duration) }
}

/** The shot starting soonest at/after this shot's end (for prewarming). */
function nextShotAfter(scenes: Shot[], shot: Shot): Shot | null {
  const end = shot.startTime + shot.duration
  let best: Shot | null = null
  for (const s of scenes) {
    if (s.id === shot.id) continue
    if (s.startTime >= end - 1e-4 && (!best || s.startTime < best.startTime)) best = s
  }
  return best
}

function safeSetCurrentTime(el: HTMLVideoElement, t: number): void {
  try {
    el.currentTime = t
  } catch {
    // media not seekable yet — the next sync will retry
  }
}

/**
 * Manages one hidden <video> element per project video id. Elements are
 * created lazily from the IndexedDB media cache (`media:<videoId>`), never
 * attached to the DOM, and dropped when their project video is removed.
 */
export function useShotVideoElements(): ShotVideoElements {
  const poolRef = useRef<Map<string, PoolEntry>>(new Map())
  const apiRef = useRef<ShotVideoElements | null>(null)

  if (!apiRef.current) {
    const pool = poolRef.current

    const ensure = (videoId: string): PoolEntry => {
      let entry = pool.get(videoId)
      if (entry) return entry
      const el = document.createElement('video')
      el.muted = true
      el.playsInline = true
      el.preload = 'auto'
      el.style.display = 'none'
      // the viewport renders on demand — repaint when a parked seek lands.
      // Not while scrubbing: that repaint uses the committed playhead state
      // and fights the scrub preview's pose
      el.addEventListener('seeked', () => {
        if (!usePlayback.getState().scrubbing) requestViewportRender()
      })
      entry = { el, url: null }
      pool.set(videoId, entry)
      void getMediaUrl(`media:${videoId}`).then((url) => {
        const live = pool.get(videoId)
        if (!live || live.el !== el || !url) return
        live.url = url
        el.src = url
        el.load()
      })
      return entry
    }

    const pauseOthers = (activeId: string | null) => {
      for (const [id, entry] of pool) {
        if (id !== activeId && !entry.el.paused) entry.el.pause()
      }
    }

    const exactSeek = (el: HTMLVideoElement, target: number) => {
      if (el.readyState < 1) return
      if (Math.abs(el.currentTime - target) > 1e-3) safeSetCurrentTime(el, target)
    }

    const sync = (pt: number, playing: boolean) => {
      const scenes = useProject.getState().scenes
      const active = resolveActiveClip(scenes, pt)
      pauseOthers(active?.video.videoId ?? null)
      if (!active) return

      const entry = ensure(active.video.videoId)
      const el = entry.el
      const clip = active.video
      const target = clipSourceTime(clip, active.localSec)

      if (playing) {
        const speed = clip.speed > 0 ? clip.speed : 1
        // out of frames on a non-looping clip -> hold the last frame
        const exhausted = !clip.loop && active.localSec * speed >= clipTrimLength(clip) - VIDEO_FRAME_EPS
        if (exhausted) {
          if (!el.paused) el.pause()
          exactSeek(el, target)
        } else {
          const rate = Math.min(16, Math.max(0.0625, speed))
          if (el.playbackRate !== rate) el.playbackRate = rate
          if (el.readyState >= 2 && !el.seeking && Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) {
            safeSetCurrentTime(el, target)
          }
          if (el.paused) void el.play().catch(() => {})
        }

        // prewarm the upcoming shot's clip during this shot's last second
        if (active.localSec > active.shot.duration - 1) {
          const next = nextShotAfter(scenes, active.shot)
          if (next?.video && next.video.videoId !== clip.videoId) {
            const warm = ensure(next.video.videoId)
            const startT = clipSourceTime(next.video, 0)
            if (warm.el.readyState >= 1 && !warm.el.seeking && Math.abs(warm.el.currentTime - startT) > 0.05) {
              safeSetCurrentTime(warm.el, startT)
            }
          }
        }
      } else {
        if (!el.paused) el.pause()
        exactSeek(el, target)
      }
    }

    const scrub = (pt: number) => {
      const scenes = useProject.getState().scenes
      const active = resolveActiveClip(scenes, pt)
      pauseOthers(active?.video.videoId ?? null)
      if (!active) return
      const el = ensure(active.video.videoId).el
      if (!el.paused) el.pause()
      if (el.readyState < 1 || el.seeking) return // approximate: never queue seeks
      const target = clipSourceTime(active.video, active.localSec)
      if (Math.abs(el.currentTime - target) < VIDEO_FRAME_EPS) return
      const fast = el as HTMLVideoElement & { fastSeek?: (t: number) => void }
      if (typeof fast.fastSeek === 'function') fast.fastSeek(target)
      else safeSetCurrentTime(el, target)
    }

    const seek = (pt: number) => {
      const scenes = useProject.getState().scenes
      const active = resolveActiveClip(scenes, pt)
      pauseOthers(active?.video.videoId ?? null)
      if (!active) return
      const el = ensure(active.video.videoId).el
      if (!el.paused) el.pause()
      exactSeek(el, clipSourceTime(active.video, active.localSec))
    }

    const getVideoElement = (videoId: string): HTMLVideoElement | null => {
      if (!videoId) return null
      return ensure(videoId).el
    }

    apiRef.current = { sync, scrub, seek, getVideoElement }
  }

  // drop pool entries whose project video was removed
  useEffect(() => {
    const unsub = useProject.subscribe((state, prev) => {
      if (state.videos === prev.videos) return
      const keep = new Set(state.videos.map((v) => v.id))
      for (const [id, entry] of poolRef.current) {
        if (keep.has(id)) continue
        entry.el.pause()
        entry.el.removeAttribute('src')
        entry.el.load()
        poolRef.current.delete(id)
      }
    })
    return unsub
  }, [])

  // teardown on unmount
  useEffect(() => {
    const pool = poolRef.current
    return () => {
      for (const [, entry] of pool) {
        entry.el.pause()
        entry.el.removeAttribute('src')
        entry.el.load()
      }
      pool.clear()
    }
  }, [])

  return apiRef.current
}

// ---------------------------------------------------------------------------
// Playback engine
// ---------------------------------------------------------------------------

export interface PlaybackEngineOptions {
  /** Render one frame at project time `pt`. `playing` distinguishes loop ticks from stills. */
  renderFrame(pt: number, playing: boolean): void
  /** Called when playback reaches the end without loop. */
  onEnded?(total: number): void
  /** Optional video pool, kept in sync on every engine-driven frame. */
  videos?: ShotVideoElements
}

export interface PlaybackEngine {
  play(): void
  pause(): void
  toggle(): void
  /** Exact seek (scrub release, keyboard nudge). Re-anchors if currently playing. */
  scrubTo(t: number): void
  /** Cheap seek while dragging the ruler (throttled store pushes, approximate video seek). */
  scrubPreview(t: number): void
  /** Park the playhead without any video re-placement semantics beyond an exact seek. */
  parkAt(t: number): void
  /** End playback and park at 0. */
  stop(): void
  /** Precise playhead (the store's projectTime is throttled while playing). */
  getTime(): number
  /** max(scenes end) in seconds. */
  getTotal(): number
}

interface EngineClock {
  raf: number
  anchorPt: number
  anchorWall: number
  time: number
  lastPush: number
}

/**
 * Drives usePlayback: wall-clock playback (`pt = anchor + (now - anchorWall)/1000`),
 * scrubbing, parking. React `projectTime` updates are throttled to >=150ms
 * while time is moving; every park/pause pushes the exact value.
 */
export function usePlaybackEngine(opts: PlaybackEngineOptions): PlaybackEngine {
  const optsRef = useRef(opts)
  optsRef.current = opts

  const clockRef = useRef<EngineClock>({ raf: 0, anchorPt: 0, anchorWall: 0, time: 0, lastPush: 0 })
  const engineRef = useRef<PlaybackEngine | null>(null)

  if (!engineRef.current) {
    const clock = clockRef.current

    const getTotal = () => totalDuration(useProject.getState().scenes)

    const clampT = (t: number) => {
      const s = useProject.getState()
      const len = canvasLength(s.scenes, s.sequenceDuration)
      return Math.min(Math.max(0, t), len)
    }

    const pushTime = (t: number, force: boolean) => {
      const now = performance.now()
      if (!force && now - clock.lastPush < REACT_PUSH_MS) return
      clock.lastPush = now
      usePlayback.getState().setProjectTime(t)
    }

    const cancelLoop = () => {
      if (clock.raf) {
        cancelAnimationFrame(clock.raf)
        clock.raf = 0
      }
    }

    const renderStill = (t: number) => {
      optsRef.current.videos?.seek(t)
      optsRef.current.renderFrame(t, false)
    }

    /**
     * Sync the live dials to the sampled pose at the parked playhead (system
     * + transient: no history entry, invisible to the recorder). Keeps the
     * inspector and any subsequent camera drag continuous with the frame the
     * user is looking at after a pause/park.
     */
    const syncDialsToParkedFrame = (t: number) => {
      const p = useProject.getState()
      const { floor, floorIsEngine } = frameStackAtTime(p.scenes, t)
      const shot = floor && floorIsEngine ? p.scenes[floor.sceneIndex] : null
      if (!shot || !floor || shot.id !== p.selectedSceneId) return
      const sampled = sampleShotState(shot, floor.localT)
      if (sampled) p.setDials(sampled, { system: true, transient: true })
    }

    const tick = () => {
      clock.raf = 0
      const now = performance.now()
      const total = getTotal()
      let pt = clock.anchorPt + (now - clock.anchorWall) / 1000
      if (pt >= total) {
        if (usePlayback.getState().loop && total > 0) {
          // seamless wrap
          clock.anchorPt = 0
          clock.anchorWall = now
          pt = 0
          pushTime(0, true)
        } else {
          clock.time = total
          pushTime(total, true)
          usePlayback.getState().setPhase('idle')
          syncDialsToParkedFrame(total)
          renderStill(total)
          optsRef.current.onEnded?.(total)
          return
        }
      }
      clock.time = pt
      pushTime(pt, false)
      optsRef.current.videos?.sync(pt, true)
      optsRef.current.renderFrame(pt, true)
      clock.raf = requestAnimationFrame(tick)
    }

    const play = () => {
      const total = getTotal()
      if (total <= 0) return
      cancelLoop()
      let start = clock.time
      if (start >= total - 1e-6) start = 0 // restart from the top at the end
      clock.time = start
      clock.anchorPt = start
      clock.anchorWall = performance.now()
      usePlayback.getState().setPhase('playing')
      pushTime(start, true)
      clock.raf = requestAnimationFrame(tick)
    }

    const pause = () => {
      cancelLoop()
      usePlayback.getState().setPhase('paused')
      pushTime(clock.time, true)
      syncDialsToParkedFrame(clock.time)
      renderStill(clock.time)
    }

    const toggle = () => {
      if (usePlayback.getState().phase === 'playing') pause()
      else play()
    }

    const scrubTo = (t: number) => {
      const ct = clampT(t)
      clock.time = ct
      if (clock.raf) {
        // keep playing from the new time
        clock.anchorPt = ct
        clock.anchorWall = performance.now()
        pushTime(ct, true)
        optsRef.current.videos?.seek(ct)
        return
      }
      if (usePlayback.getState().phase === 'playing') usePlayback.getState().setPhase('paused')
      pushTime(ct, true)
      syncDialsToParkedFrame(ct)
      renderStill(ct)
    }

    const scrubPreview = (t: number) => {
      if (clock.raf) {
        cancelLoop()
        usePlayback.getState().setPhase('paused')
      }
      const ct = clampT(t)
      clock.time = ct
      pushTime(ct, false)
      optsRef.current.videos?.scrub(ct)
      optsRef.current.renderFrame(ct, false)
    }

    const parkAt = (t: number) => {
      cancelLoop()
      const ct = clampT(t)
      clock.time = ct
      pushTime(ct, true)
      syncDialsToParkedFrame(ct)
      renderStill(ct)
    }

    const stop = () => {
      cancelLoop()
      usePlayback.getState().setPhase('idle')
      clock.time = 0
      pushTime(0, true)
      syncDialsToParkedFrame(0)
      renderStill(0)
    }

    engineRef.current = {
      play,
      pause,
      toggle,
      scrubTo,
      scrubPreview,
      parkAt,
      stop,
      getTime: () => clock.time,
      getTotal,
    }
  }

  useEffect(() => {
    const clock = clockRef.current
    return () => {
      if (clock.raf) {
        cancelAnimationFrame(clock.raf)
        clock.raf = 0
      }
    }
  }, [])

  return engineRef.current
}
