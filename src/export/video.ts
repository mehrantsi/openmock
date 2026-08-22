/**
 * Client-side video export: an offscreen render engine + WebCodecs
 * VideoEncoder muxed into MP4 (mp4-muxer, in-memory fast start).
 *
 * Pipeline per export:
 *  1. resolve output size / bitrate / AVC level, gate on WebCodecs support
 *  2. preload every asset the timeline needs (device models, environments,
 *     per-shot screenshots, hidden <video> elements for video shots, scene
 *     background images, text fonts / bg images, rasterized logos)
 *  3. decode + mix audio clips offline, AAC-encode them fully BEFORE video
 *  4. frame loop: sample the timeline per frame, render mockup shots through
 *     the engine (optionally through the motion-blur accumulator), text/logo
 *     shots through their 2D renderers, then encode VideoFrames with forced
 *     keyframes every 2 s, backpressure, abort and stall guards
 *  5. flush (30 s timeout), finalize the muxer, return the MP4 blob
 *
 * Imported MP4/MOV videos are frame-served by a WebCodecs demux/decode
 * pipeline (frameServer.ts) — deterministic and Safari-safe. Containers or
 * codecs it can't serve (WebM, unsupported profiles) fall back to seeking a
 * hidden HTMLVideoElement per frame (await `seeked`, 5 s timeout).
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { createEngine } from '../three/engine'
import type { RuntimeOverrides } from '../three/renderParams'
import type {
  AudioClip,
  ProjectAudio,
  ProjectVideo,
  SceneVideo,
  Shot,
  Transition,
  VideoExportOptions,
} from '../state/types'
import { DEFAULT_TEXT_STYLE, prepareTextShotAssets, renderTextShotToCanvas } from '../shots/textCanvas'
import {
  DEFAULT_LOGO_STYLE,
  disposeLogoExportPool,
  rasterizeLogo,
  renderLogoShotToCanvas,
  type LogoImageSource,
} from '../shots/logoRenderer'
import { drawShotBgToCanvas, getShotBgImage, resolveShotBg } from '../shots/shotBg'
import { shotRenderParams, transitionOpacity, type ProjectFades } from '../video/interpolate'
import { frameStackAtTime, isOverlayShot, sampleShotState, totalDuration } from '../video/timelineOps'
import { clipSourceTime } from '../video/videoClock'
import { pickAvcCodec, resolveExportSize, videoBitrate } from './resolutions'
import { mixdownAudio, type AudioMixdown } from './audioMix'
import { analyzeImage } from '../lib/media'
import {
  MOTION_BLUR_SHUTTER,
  MOTION_PROBE_COUNT,
  MotionBlurAccumulator,
  adaptiveSampleCount,
  estimateMotionPx,
  shutterSampleTimes,
  type CameraMotionSample,
} from './motionBlur'
import { webkitVideoPresentQuirk } from '../lib/browser'
import { VideoFrameServer } from './frameServer'

export interface VideoExportArgs {
  scenes: Shot[]
  videos: ProjectVideo[]
  audios: ProjectAudio[]
  audioClips: AudioClip[]
  fadeIn: Transition
  fadeOut: Transition
  options: VideoExportOptions
  /**
   * Editor canvas width; captureScale = exportWidth / previewWidth keeps
   * resolution-dependent effects (blur/bloom/sharpen footprints) matching the
   * live preview. Omitted -> captureScale 1.
   */
  previewWidth?: number
  /** Free tier: stamp a translucent centered openmock.app mark onto every frame. */
  watermark?: boolean
  getMediaBlob(key: string): Promise<Blob | undefined>
  onProgress(p: number): void
  signal: AbortSignal
}

export interface VideoExportResult {
  blob: Blob
  width: number
  height: number
}

export const VIDEO_EXPORT_UNSUPPORTED_MESSAGE =
  'Video export needs a browser with WebCodecs (Chrome, Edge, or Safari 16.4+). Please update your browser and try again.'

const ENCODER_QUEUE_LIMIT = 12
const AUDIO_QUEUE_LIMIT = 16
const ENCODER_STALL_MS = 15000
const FLUSH_TIMEOUT_MS = 30000
const SEEK_TIMEOUT_MS = 5000

function abortError(): DOMException {
  return new DOMException('Export aborted', 'AbortError')
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Spin until the encoder queue drains below `limit` (abort + 15 s stall guard). */
async function drainQueue(
  enc: { encodeQueueSize: number },
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  let lastSize = enc.encodeQueueSize
  let lastProgress = performance.now()
  while (enc.encodeQueueSize > limit) {
    if (signal.aborted) throw abortError()
    const size = enc.encodeQueueSize
    const now = performance.now()
    if (size < lastSize) {
      lastSize = size
      lastProgress = now
    } else if (now - lastProgress > ENCODER_STALL_MS) {
      throw new Error(
        `Video encoder stalled: ${size} frames pending with no progress for ${ENCODER_STALL_MS}ms`,
      )
    }
    await sleep(0)
  }
}

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load background image.'))
    img.src = url
  })
}

function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, mark: HTMLImageElement | null): void {
  if (!mark || !(mark.naturalWidth > 0)) return
  const aspect = mark.naturalWidth / mark.naturalHeight
  let mw = w * 0.44
  if (mw / aspect > h * 0.26) mw = h * 0.26 * aspect
  const mh = mw / aspect
  ctx.save()
  ctx.globalAlpha = 0.5
  // soft dark halo keeps the white lockup readable on light footage
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = mh * 0.14
  ctx.drawImage(mark, (w - mw) / 2, (h - mh) / 2, mw, mh)
  ctx.restore()
}

interface VideoPoolEntry {
  el: HTMLVideoElement | null
  url: string | null
  work: HTMLCanvasElement
  server: VideoFrameServer | null
}

/**
 * Frame source for one project video: WebCodecs demux/decode when the
 * container and codec allow it, hidden-element seeking otherwise.
 */
async function loadVideoSource(blob: Blob): Promise<VideoPoolEntry> {
  const server = await VideoFrameServer.create(blob)
  if (server) {
    const work = document.createElement('canvas')
    work.width = Math.max(2, server.width)
    work.height = Math.max(2, server.height)
    return { el: null, url: null, work, server }
  }
  return loadVideoElement(blob)
}

function loadVideoElement(blob: Blob): Promise<VideoPoolEntry> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    // Safari presents seeked frames unreliably for detached elements
    el.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
    document.body.appendChild(el)
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener('loadeddata', onReady)
      el.removeEventListener('error', onError)
    }
    const timer = setTimeout(() => {
      cleanup()
      el.remove()
      URL.revokeObjectURL(url)
      reject(new Error('Timed out waiting for video loadeddata'))
    }, 15000)
    const onReady = () => {
      cleanup()
      const work = document.createElement('canvas')
      work.width = Math.max(2, el.videoWidth)
      work.height = Math.max(2, el.videoHeight)
      resolve({ el, url, work, server: null })
    }
    const onError = () => {
      cleanup()
      el.remove()
      URL.revokeObjectURL(url)
      reject(new Error(`Video decode failed (${el.error?.code ?? 0})`))
    }
    el.addEventListener('loadeddata', onReady)
    el.addEventListener('error', onError)
    el.src = url
  })
}

/**
 * Safari presents the seeked frame after `seeked` fires, so a capture must
 * also wait for the presentation callback or it samples the previous frame.
 * Chromium presents by `seeked` and keeps the fast path.
 */
const needsPresentWait =
  webkitVideoPresentQuirk &&
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

/**
 * Presentation-wait cap after `seeked`. When the element's presentation
 * callback is known to fire (it has before), a short cap only covers seeks
 * that land inside the already-presented source frame — those never present
 * a new one. Until the first callback proves itself, wait generously: Safari
 * can present well after `seeked` under encoder load, and sampling early
 * freezes the exported screen on a stale frame.
 */
const PRESENT_GRACE_FAST_MS = 60
const PRESENT_GRACE_SLOW_MS = 250

const rvfcProven = new WeakSet<HTMLVideoElement>()

/** Seek a hidden video element and wait for the frame to land (5 s timeout). */
function seekVideo(el: HTMLVideoElement, t: number): Promise<void> {
  const dur = Number.isFinite(el.duration) ? el.duration : Infinity
  const target = Math.max(0, Math.min(t, dur - 0.001))
  if (Math.abs(el.currentTime - target) < 1e-4 && el.readyState >= 2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let done = false
    let presented = false
    let seeked = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('error', onError)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Timed out waiting for video seeked')), SEEK_TIMEOUT_MS)
    const onSeeked = () => {
      seeked = true
      if (!needsPresentWait || presented) finish()
      else {
        const grace = rvfcProven.has(el) ? PRESENT_GRACE_FAST_MS : PRESENT_GRACE_SLOW_MS
        graceTimer = setTimeout(() => finish(), grace)
      }
    }
    const onError = () => finish(new Error(`Video decode failed (${el.error?.code ?? 0})`))
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('error', onError)
    if (needsPresentWait) {
      el.requestVideoFrameCallback(() => {
        rvfcProven.add(el)
        presented = true
        if (seeked) finish()
      })
    }
    el.currentTime = target
  })
}

interface ShotScreenMedia {
  kind: 'video' | 'image' | 'none'
  video?: SceneVideo
  pool?: VideoPoolEntry
  bitmap?: ImageBitmap
  isDark?: boolean
  average?: string
}

/** Nearest shot to a gap time: previous shot's tail wins, else the next shot's head. */
function nearestSceneIndex(scenes: Shot[], pt: number): { index: number; edgeT: number } {
  let prevIdx = -1
  let prevEnd = -Infinity
  let nextIdx = -1
  let nextStart = Infinity
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]
    const end = s.startTime + s.duration
    if (end <= pt + 1e-9 && end > prevEnd) {
      prevEnd = end
      prevIdx = i
    }
    if (s.startTime >= pt - 1e-9 && s.startTime < nextStart) {
      nextStart = s.startTime
      nextIdx = i
    }
  }
  if (prevIdx >= 0) return { index: prevIdx, edgeT: 1 }
  if (nextIdx >= 0) return { index: nextIdx, edgeT: 0 }
  return { index: -1, edgeT: 0 }
}

export async function exportVideo(args: VideoExportArgs): Promise<VideoExportResult> {
  const { scenes, videos, audios, audioClips, fadeIn, fadeOut, options, watermark, getMediaBlob, onProgress, signal } =
    args

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error(VIDEO_EXPORT_UNSUPPORTED_MESSAGE)
  }
  if (signal.aborted) throw abortError()

  const { width, height } = resolveExportSize(options.size, options.customWidth, options.customHeight, 'video')
  const fps = options.fps
  const bitrate = videoBitrate(options.quality, width, height)
  const codec = pickAvcCodec(width, height, fps)
  const total = totalDuration(scenes)
  if (scenes.length === 0 || !(total > 0)) {
    throw new Error('Nothing to export — the timeline is empty.')
  }
  const totalFrames = Math.max(1, Math.ceil(total * fps))
  const captureScale = args.previewWidth && args.previewWidth > 0 ? width / args.previewWidth : 1
  const fades: ProjectFades = { fadeIn, fadeOut }

  // ---- offscreen engine ----------------------------------------------------
  const engineCanvas = document.createElement('canvas')
  const engine = createEngine(engineCanvas, { preserveDrawingBuffer: true })

  const shotMedia = new Map<string, ShotScreenMedia>()
  const videoPool = new Map<string, VideoPoolEntry>()
  const imageCache = new Map<string, { bitmap: ImageBitmap; isDark?: boolean; average?: string }>()
  const watermarkImg = watermark ? await loadImageEl('/brand/watermark.png').catch(() => null) : null
  const bgImageCache = new Map<string, HTMLImageElement>()
  const logoImages = new Map<string, LogoImageSource | null>()

  const shutter = options.motionBlur !== 'off' ? MOTION_BLUR_SHUTTER[options.motionBlur] : 0
  let accumulator: MotionBlurAccumulator | null = null

  let encoder: VideoEncoder | null = null

  try {
    engine.resize(width, height)

    // ---- preload -----------------------------------------------------------
    const missingVideoShots: string[] = []
    const modelIds = new Set<string>()
    const envIds = new Set<string>()
    const bgUrls = new Set<string>()

    for (const shot of scenes) {
      if (signal.aborted) throw abortError()

      if (shot.kind === 'text') {
        await prepareTextShotAssets(shot.text ?? DEFAULT_TEXT_STYLE)
        continue
      }
      if (shot.kind === 'logo') {
        logoImages.set(shot.id, await rasterizeLogo(shot.logo ?? DEFAULT_LOGO_STYLE))
        continue
      }

      // mockup shot
      const base = shot.baseState
      if (base) {
        if (base.mockupModel) modelIds.add(base.mockupModel)
        if (base.bgMode === 'environment' && base.envId) envIds.add(base.envId)
        if (base.bgMode === 'image' && base.bgImage) bgUrls.add(base.bgImage)
        if (base.mockupBgMode === 'image' && base.mockupBgImage) bgUrls.add(base.mockupBgImage)
      }

      if (shot.video) {
        const pv = videos.find((v) => v.id === shot.video!.videoId)
        const blob = pv?.mediaKey ? await getMediaBlob(pv.mediaKey) : undefined
        if (!blob) {
          missingVideoShots.push(shot.name || 'Untitled shot')
          shotMedia.set(shot.id, { kind: 'none' })
          continue
        }
        let pool = videoPool.get(shot.video.videoId)
        if (!pool) {
          pool = await loadVideoSource(blob)
          videoPool.set(shot.video.videoId, pool)
        }
        shotMedia.set(shot.id, { kind: 'video', video: shot.video, pool })
        continue
      }

      if (shot.imageKey) {
        let entry = imageCache.get(shot.imageKey)
        if (!entry) {
          const blob = await getMediaBlob(shot.imageKey)
          if (blob) {
            // three ignores texture.flipY for ImageBitmap uploads — pre-flip here
            // so the export matches the live HTMLImageElement path
            const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' })
            entry = { bitmap }
            // extrude tint + dark-screenshot detection (ghost echo parity)
            const url = URL.createObjectURL(blob)
            try {
              const info = await analyzeImage(url)
              entry.isDark = info.isDark
              entry.average = info.average
            } catch {
              // defaults apply
            } finally {
              URL.revokeObjectURL(url)
            }
            imageCache.set(shot.imageKey, entry)
          }
        }
        if (entry) {
          shotMedia.set(shot.id, {
            kind: 'image',
            bitmap: entry.bitmap,
            isDark: entry.isDark,
            average: entry.average,
          })
          continue
        }
      }

      shotMedia.set(shot.id, { kind: 'none' })
    }

    if (missingVideoShots.length > 0) {
      throw new Error(
        `Can't export — the video for ${missingVideoShots.join(', ')} isn't available on this device. ` +
          'Re-upload it, or export from the device it was uploaded on.',
      )
    }

    for (const url of bgUrls) {
      try {
        bgImageCache.set(url, await loadImageEl(url))
      } catch {
        console.warn('[export] background image failed to load; exporting without it:', url)
      }
    }

    if (modelIds.size > 0) await engine.prepareEnvironment(null) // default HDRI for model lighting
    for (const id of envIds) await engine.prepareEnvironment(id)
    for (const id of modelIds) await engine.prepareModel(id)
    if (signal.aborted) throw abortError()

    // ---- audio (mixed + encoded fully before video) --------------------------
    let mix: AudioMixdown | null = null
    if (audioClips.length > 0 && audios.length > 0) {
      const buffers = new Map<string, AudioBuffer>()
      const decodeCtx = new OfflineAudioContext(2, 1, 48000)
      for (const a of audios) {
        if (!a.mediaKey) continue
        const blob = await getMediaBlob(a.mediaKey)
        if (!blob) continue
        try {
          buffers.set(a.id, await decodeCtx.decodeAudioData(await blob.arrayBuffer()))
        } catch (e) {
          console.warn('[export] audio decode failed for clip source; skipping', e)
        }
      }
      try {
        mix = await mixdownAudio(audioClips, audios, buffers, total)
      } catch (e) {
        console.warn('[export] audio mixdown failed; exporting without audio', e)
        mix = null
      }
    }

    let audioSupported = false
    if (mix && typeof AudioEncoder !== 'undefined') {
      try {
        const support = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: mix.sampleRate,
          numberOfChannels: mix.numberOfChannels,
          bitrate: 128_000,
        })
        audioSupported = support.supported === true
      } catch {
        audioSupported = false
      }
      if (!audioSupported) {
        console.warn('[audio-export] AAC encode unsupported on this platform; exporting without audio')
      }
    }
    const withAudio = mix !== null && audioSupported

    // ---- muxer + encoders ----------------------------------------------------
    const target = new ArrayBufferTarget()
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      ...(withAudio && mix
        ? { audio: { codec: 'aac' as const, numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate } }
        : {}),
      fastStart: 'in-memory',
    })

    let encodeError: Error | null = null
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta)
        } catch (e) {
          encodeError ??= toError(e)
        }
      },
      error: (e) => {
        encodeError ??= toError(e)
      },
    })
    // prefer the hardware encoder when the platform offers one (large speedup
    // over software x264-style encoding); fall back silently when unsupported
    const encoderConfig: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' }
    let finalConfig: VideoEncoderConfig = { ...encoderConfig, hardwareAcceleration: 'prefer-hardware' }
    try {
      const support = await VideoEncoder.isConfigSupported(finalConfig)
      if (!support.supported) finalConfig = encoderConfig
    } catch {
      finalConfig = encoderConfig
    }
    encoder.configure(finalConfig)

    if (withAudio && mix) {
      let audioError: Error | null = null
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addAudioChunk(chunk, meta)
          } catch (e) {
            audioError ??= toError(e)
          }
        },
        error: (e) => {
          audioError ??= toError(e)
        },
      })
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: mix.sampleRate,
        numberOfChannels: mix.numberOfChannels,
        bitrate: 128_000,
      })
      const { data, sampleRate, numberOfChannels } = mix
      const totalAudioFrames = Math.floor(data.length / numberOfChannels)
      try {
        for (let off = 0; off < totalAudioFrames; off += 1024) {
          if (signal.aborted) throw abortError()
          const frames = Math.min(1024, totalAudioFrames - off)
          const chunk = new AudioData({
            format: 'f32',
            sampleRate,
            numberOfFrames: frames,
            numberOfChannels,
            timestamp: Math.round((off / sampleRate) * 1e6),
            data: data.subarray(off * numberOfChannels, (off + frames) * numberOfChannels),
          })
          audioEncoder.encode(chunk)
          chunk.close()
          await drainQueue(audioEncoder, AUDIO_QUEUE_LIMIT, signal)
          if (audioError) throw audioError
        }
        await withTimeout(audioEncoder.flush(), FLUSH_TIMEOUT_MS, 'Audio encoder flush timed out (30s)')
        if (audioError) throw audioError
      } finally {
        try {
          if (audioEncoder.state !== 'closed') audioEncoder.close()
        } catch {
          // already torn down
        }
      }
    }

    // ---- frame loop ----------------------------------------------------------
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('Failed to acquire a 2D context for export')

    accumulator = shutter > 0 ? new MotionBlurAccumulator(width, height) : null

    let mediaKey = '' // identity of the media currently bound to the engine
    let curBgUrl: string | null | undefined
    let curMockupBgUrl: string | null | undefined
    let lastStaticKey: string | null = null // static-hold render skip

    /**
     * Render the mockup layer for this frame and return the canvas holding it
     * — the engine's own canvas when possible (encoding straight from WebGL
     * skips a full-frame 2D copy), the compositing canvas otherwise.
     */
    const renderMockupFrame = async (
      sceneIndex: number,
      localT: number,
      pt: number,
      hidden: boolean,
    ): Promise<HTMLCanvasElement> => {
      const shot = scenes[sceneIndex]
      const media = shotMedia.get(shot.id)

      // screen media
      if (media?.kind === 'video' && media.pool && media.video) {
        const t = clipSourceTime(media.video, localT * shot.duration)
        const work = media.pool.work
        const wctx = work.getContext('2d')
        if (media.pool.server) {
          const frame = await media.pool.server.frameAt(Math.min(t, media.pool.server.durationSec - 1e-4))
          // a null frame means the decoder died — keep the last drawn frame
          if (frame && wctx) media.pool.server.drawTo(wctx, frame, work.width, work.height)
        } else if (media.pool.el) {
          await seekVideo(media.pool.el, t)
          if (wctx) wctx.drawImage(media.pool.el, 0, 0, work.width, work.height)
        }
        const key = `video:${media.video.videoId}`
        if (mediaKey !== key) {
          engine.setMedia({ kind: 'frame', element: work })
          mediaKey = key
        }
      } else if (media?.kind === 'image' && media.bitmap) {
        const key = `image:${shot.imageKey ?? shot.id}`
        if (mediaKey !== key) {
          engine.setMedia({ kind: 'image', element: media.bitmap })
          mediaKey = key
        }
      } else if (mediaKey !== 'none') {
        engine.setMedia(null)
        mediaKey = 'none'
      }

      // scene background image / blur / screen background image
      const base = shot.baseState
      const bgUrl = base && base.bgMode === 'image' && base.bgImage ? base.bgImage : null
      if (bgUrl !== curBgUrl) {
        engine.setBgImage(bgUrl ? (bgImageCache.get(bgUrl) ?? null) : null)
        curBgUrl = bgUrl
      }
      engine.setBgBlur(base?.bgBlur ?? 0)
      const mbUrl = base && base.mockupBgMode === 'image' && base.mockupBgImage ? base.mockupBgImage : null
      if (mbUrl !== curMockupBgUrl) {
        engine.setMockupBgImage(mbUrl ? (bgImageCache.get(mbUrl) ?? null) : null)
        curMockupBgUrl = mbUrl
      }

      const rt: RuntimeOverrides = {
        time: pt,
        captureScale,
        transparentBg: false,
        showCheckerBg: false,
        mediaIsDark: media?.isDark,
        extrudeColor: media?.average,
        mockupOpacity: hidden ? 0 : 1,
      }
      const params = shotRenderParams(scenes, sceneIndex, localT, fades, rt)
      if (!params) {
        lastStaticKey = null
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)
        return out
      }

      // static-hold skip: image-media shots with no animated params render the
      // exact same frame — reuse the engine canvas (preserveDrawingBuffer keeps
      // it) instead of re-rendering. Grain and the glass border animate with
      // `time`, so they opt out.
      const staticKey =
        media?.kind !== 'video' && params.grain === 0 && params.borderStyle === 0
          ? `${shot.id}|${hidden}|${JSON.stringify({ ...params, time: 0 })}`
          : null
      if (staticKey && staticKey === lastStaticKey) return engineCanvas

      // adaptive motion blur
      let samples = 1
      if (!hidden && accumulator?.available && shutter > 0 && shot.duration > 0) {
        const probeTimes = shutterSampleTimes(localT, MOTION_PROBE_COUNT, shutter, fps, shot.duration)
        const probes: CameraMotionSample[] = []
        for (const t of probeTimes) {
          const st = sampleShotState(shot, t)
          if (st) probes.push(st)
        }
        samples = adaptiveSampleCount(estimateMotionPx(probes, width, height))
      }

      if (samples <= 1 || !accumulator?.available) {
        engine.render(params)
        lastStaticKey = staticKey
        return engineCanvas
      }

      const times = shutterSampleTimes(localT, samples, shutter, fps, shot.duration)
      accumulator.begin()
      for (const t of times) {
        const p = shotRenderParams(scenes, sceneIndex, t, fades, rt) ?? params
        engine.render(p)
        accumulator.addSample(engineCanvas, 1 / samples)
      }
      lastStaticKey = null
      if (accumulator.available) {
        accumulator.resolveTo(ctx)
      } else {
        // context lost mid-frame — fall back to an unblurred render
        engine.render(params)
        ctx.drawImage(engineCanvas, 0, 0)
      }
      return out
    }

    // transparent text/logo layers composited over the already-painted frame
    let overlayScratch: HTMLCanvasElement | null = null
    const drawOverlayLayers = (layers: { sceneIndex: number; localT: number }[]): void => {
      for (const layer of layers) {
        const shot = scenes[layer.sceneIndex]
        const localSec = layer.localT * shot.duration
        const fade = transitionOpacity(scenes, layer.sceneIndex, layer.localT, fades)
        if (shot.kind === 'text') {
          renderTextShotToCanvas(ctx, shot, width, height, localSec, fade)
          continue
        }
        // the pooled logo renderer clears its target — draw via a scratch
        // canvas so the base frame underneath survives
        if (!overlayScratch) {
          overlayScratch = document.createElement('canvas')
          overlayScratch.width = width
          overlayScratch.height = height
        }
        renderLogoShotToCanvas(
          overlayScratch,
          shot.logo ?? DEFAULT_LOGO_STYLE,
          localSec,
          (logoImages.get(shot.id) ?? null) as ImageBitmap | null,
          fade,
          shot.duration,
        )
        ctx.drawImage(overlayScratch, 0, 0)
      }
    }

    const renderOverlayFrame = (sceneIndex: number, localT: number, bgOnly: boolean): void => {
      const shot = scenes[sceneIndex]
      if (shot.kind === 'text') {
        const style = shot.text ?? DEFAULT_TEXT_STYLE
        if (bgOnly) {
          const { source } = resolveShotBg(style.bg)
          drawShotBgToCanvas(ctx, source, width, height, source.kind === 'image' ? getShotBgImage(source.imageUrl) : null)
          return
        }
        // fades composite over black, matching the mockup fade-to-background
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)
        renderTextShotToCanvas(
          ctx,
          shot,
          width,
          height,
          localT * shot.duration,
          transitionOpacity(scenes, sceneIndex, localT, fades),
        )
        return
      }
      const style = shot.logo ?? DEFAULT_LOGO_STYLE
      if (bgOnly) {
        ctx.fillStyle = style.bgColor
        ctx.fillRect(0, 0, width, height)
        return
      }
      renderLogoShotToCanvas(
        out,
        style,
        localT * shot.duration,
        (logoImages.get(shot.id) ?? null) as ImageBitmap | null,
        transitionOpacity(scenes, sceneIndex, localT, fades),
        shot.duration,
      )
    }

    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) throw abortError()
      if (encodeError) throw encodeError

      const pt = i === totalFrames - 1 ? total : i / fps
      const stack = frameStackAtTime(scenes, pt)

      // src = the canvas holding the finished base frame; frames that need no
      // 2D compositing encode straight from the engine's WebGL canvas
      let src: HTMLCanvasElement = out
      if (stack.floor && stack.floorIsEngine) {
        src = await renderMockupFrame(stack.floor.sceneIndex, stack.floor.localT, pt, false)
      } else if (stack.floor) {
        renderOverlayFrame(stack.floor.sceneIndex, stack.floor.localT, false)
      } else {
        // no floor (gap / overlay-only span): paint the nearest shot's look
        // with the mockup hidden as the backdrop
        const near = nearestSceneIndex(scenes, pt)
        const nearShot = near.index >= 0 ? scenes[near.index] : null
        if (nearShot && !nearShot.kind) {
          src = await renderMockupFrame(near.index, near.edgeT, pt, true)
        } else {
          ctx.fillStyle = '#000000'
          ctx.fillRect(0, 0, width, height)
          if (nearShot && !isOverlayShot(nearShot)) renderOverlayFrame(near.index, near.edgeT, true)
        }
      }

      if (stack.overlays.length > 0) {
        if (src !== out) {
          ctx.drawImage(src, 0, 0)
          src = out
        }
        drawOverlayLayers(stack.overlays)
      }

      if (watermark) {
        if (src !== out) {
          ctx.drawImage(src, 0, 0)
          src = out
        }
        drawWatermark(ctx, width, height, watermarkImg)
      }

      const frame = new VideoFrame(src, {
        timestamp: Math.round((i / fps) * 1e6),
        duration: Math.round(1e6 / fps),
      })
      try {
        encoder.encode(frame, { keyFrame: i % (2 * fps) === 0 })
      } finally {
        frame.close()
      }

      await drainQueue(encoder, ENCODER_QUEUE_LIMIT, signal)
      if (i % 5 === 4) await sleep(0)
      onProgress((i + 1) / totalFrames)
    }

    await withTimeout(encoder.flush(), FLUSH_TIMEOUT_MS, 'Video encoder flush timed out (30s)')
    if (encodeError) throw encodeError
    encoder.close()
    muxer.finalize()

    onProgress(1)
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), width, height }
  } finally {
    try {
      if (encoder && encoder.state !== 'closed') encoder.close()
    } catch {
      // already torn down
    }
    accumulator?.dispose()
    engine.dispose()
    for (const entry of videoPool.values()) {
      entry.server?.dispose()
      if (entry.el) {
        entry.el.removeAttribute('src')
        try {
          entry.el.load()
        } catch {
          // already torn down — nothing to do
        }
        entry.el.remove()
      }
      if (entry.url) URL.revokeObjectURL(entry.url)
    }
    for (const entry of imageCache.values()) entry.bitmap.close()
    disposeLogoExportPool()
  }
}
