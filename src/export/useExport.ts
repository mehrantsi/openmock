/**
 * React glue for the export pipeline.
 *
 * - `registerViewportEngine` lets the viewport hand its live engine to the
 *   export system (image capture renders through the on-screen engine; video
 *   export only reads its canvas width for captureScale parity).
 * - `useExport` exposes exportImageNow / exportVideoNow / cancel plus the
 *   progress state and the last output (kept for re-download).
 * - Video-export readiness follows the timeline rule: exportable once any
 *   shot is text/logo, carries a video clip, or has >= 2 keyframes.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { useProject } from '../state/project'
import { usePlayback } from '../state/playback'
import { toast } from '../ui/toast'
import { getMediaBlob } from '../lib/media'
import type { Engine } from '../three/contracts'
import type { ImageExportOptions, Shot } from '../state/types'
import {
  frameStackAtTime,
  sampleShotState,
  totalDuration,
  transitionOpacity,
  type FrameStack,
} from '../video/timelineOps'
import { getImageAnalysis } from '../ui/viewport/mediaCache'
import {
  DEFAULT_TEXT_STYLE,
  prepareTextShotAssets,
  renderTextShotToCanvas,
} from '../shots/textCanvas'
import { DEFAULT_LOGO_STYLE, rasterizeLogo, renderLogoShotToCanvas } from '../shots/logoRenderer'
import { exportImage, transcodeToWebp } from './image'
import { exportVideo } from './video'
import { resolveExportSize } from './resolutions'
import { isProNow } from '../state/license'
import { FREE_MAX_FPS, FREE_MAX_VIDEO_EDGE } from '../lib/pro'
import { imageFilename, saveBlob, videoFilename } from './download'

// ---------------------------------------------------------------------------
// Viewport engine registry
// ---------------------------------------------------------------------------

let viewportEngine: Engine | null = null

/** The viewport calls this with its engine on mount (and null on unmount). */
export function registerViewportEngine(engine: Engine | null): void {
  viewportEngine = engine
}

export function getViewportEngine(): Engine | null {
  return viewportEngine
}

// ---------------------------------------------------------------------------
// Video-export readiness (timeline.md §11.8)
// ---------------------------------------------------------------------------

export type VideoExportReadiness = 'ready' | 'no-keyframes' | 'no-video'

export const VIDEO_EXPORT_REASON_TEXT: Record<Exclude<VideoExportReadiness, 'ready'>, string> = {
  'no-keyframes': 'Add a keyframe to animate the camera.',
  'no-video': 'Upload a video or add a keyframe to enable video export.',
}

export function videoExportReadiness(scenes: Shot[]): VideoExportReadiness {
  const exportable = scenes.some(
    (s) => s.kind === 'text' || s.kind === 'logo' || !!s.video || s.keyframes.length >= 2,
  )
  if (exportable) return 'ready'
  const hasAnyKeyframe = scenes.some((s) => s.keyframes.length > 0)
  return hasAnyKeyframe ? 'no-keyframes' : 'no-video'
}

// ---------------------------------------------------------------------------
// Hook state
// ---------------------------------------------------------------------------

export type ExportPhase = 'idle' | 'rendering' | 'error'

export interface ExportOutput {
  blob: Blob
  url: string
  size: number
  filename: string
  kind: 'image' | 'video'
  width: number
  height: number
}

export interface ExportState {
  phase: ExportPhase
  /** 0..1 (video renders report per-frame; images jump to 1) */
  progress: number
  /** last successful export, kept for re-download */
  output: ExportOutput | null
  error: string | null
}

export interface ImageExportOverrides extends Partial<ImageExportOptions> {
  /** dark-screenshot flag from the viewport's media analysis (ghost parity) */
  mediaIsDark?: boolean
  /** average media color for the extrude slab tint */
  extrudeColor?: string
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Capture the frame at the playhead — what the viewport shows: the floor
 * layer (engine mockup or an opaque text/logo card) with every transparent
 * overlay composited on top.
 */
async function exportFrameImage(
  stack: FrameStack,
  opts: ImageExportOptions,
  overrides: ImageExportOverrides | undefined,
): Promise<{ blob: Blob; width: number; height: number }> {
  const p = useProject.getState()
  const fades = { fadeIn: p.fadeIn, fadeOut: p.fadeOut }
  const floorShot = stack.floor ? p.scenes[stack.floor.sceneIndex] : null

  // -- engine base ------------------------------------------------------------
  const renderEngineBase = async (): Promise<{ blob: Blob; width: number; height: number }> => {
    const engine = viewportEngine
    if (!engine) throw new Error('Export failed. Try again after closing any open modal.')
    // live dials when the floor shot is selected (dial sync keeps them equal
    // while parked, and unsaved tweaks stay visible); timeline sample otherwise
    const floor = stack.floor
    const sampled = !!floorShot && !!floor && floorShot.id !== p.selectedSceneId
    const baseState = sampled ? (sampleShotState(floorShot, floor.localT) ?? p.dials) : p.dials
    const a = sampled && floorShot.imageKey ? getImageAnalysis(floorShot.imageKey) : null
    return exportImage(engine, baseState, {
      format: opts.format,
      size: opts.size,
      customWidth: opts.customWidth,
      customHeight: opts.customHeight,
      transparent: opts.transparent,
      mediaIsDark: sampled ? a?.isDark : overrides?.mediaIsDark,
      extrudeColor: sampled ? a?.average : overrides?.extrudeColor,
    })
  }

  const engineFloor = !stack.floor || stack.floorIsEngine
  if (engineFloor && stack.overlays.length === 0) return renderEngineBase() // fast path, no re-encode

  const { width, height } = resolveExportSize(opts.size, opts.customWidth, opts.customHeight, 'image')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Export failed. Please try again.')

  if (engineFloor) {
    const base = await renderEngineBase()
    const bmp = await createImageBitmap(base.blob)
    try {
      ctx.drawImage(bmp, 0, 0, width, height)
    } finally {
      bmp.close()
    }
  } else if (stack.floor && floorShot) {
    // opaque card floor fills the frame (fades composite over black, matching video export)
    const localSec = stack.floor.localT * floorShot.duration
    const fade = transitionOpacity(p.scenes, stack.floor.sceneIndex, stack.floor.localT, fades)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
    if (floorShot.kind === 'text') {
      await prepareTextShotAssets(floorShot.text ?? DEFAULT_TEXT_STYLE)
      renderTextShotToCanvas(ctx, floorShot, width, height, localSec, fade)
    } else {
      const style = floorShot.logo ?? DEFAULT_LOGO_STYLE
      const logoImage = await rasterizeLogo(style)
      renderLogoShotToCanvas(canvas, style, localSec, logoImage as ImageBitmap | null, fade, floorShot.duration)
    }
  }

  // -- transparent overlays -----------------------------------------------------
  let scratch: HTMLCanvasElement | null = null
  for (const layer of stack.overlays) {
    const shot = p.scenes[layer.sceneIndex]
    const localSec = layer.localT * shot.duration
    const fade = transitionOpacity(p.scenes, layer.sceneIndex, layer.localT, fades)
    if (shot.kind === 'text') {
      await prepareTextShotAssets(shot.text ?? DEFAULT_TEXT_STYLE)
      renderTextShotToCanvas(ctx, shot, width, height, localSec, fade)
    } else {
      const style = shot.logo ?? DEFAULT_LOGO_STYLE
      const logoImage = await rasterizeLogo(style)
      if (!scratch) {
        scratch = document.createElement('canvas')
        scratch.width = width
        scratch.height = height
      }
      renderLogoShotToCanvas(scratch, style, localSec, logoImage as ImageBitmap | null, fade, shot.duration)
      ctx.drawImage(scratch, 0, 0)
    }
  }

  const mime = opts.format === 'png' ? 'image/png' : opts.format === 'webp' ? 'image/webp' : 'image/jpeg'
  const quality = opts.format === 'jpeg' ? 0.94 : opts.format === 'webp' ? 0.95 : undefined
  let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, quality))
  if (!blob) throw new Error('Export failed. Please try again.')
  if (opts.format === 'webp' && blob.type !== 'image/webp') blob = await transcodeToWebp(blob)
  return { blob, width, height }
}

export interface UseExportApi extends ExportState {
  exportImageNow(overrides?: ImageExportOverrides): Promise<ExportOutput | null>
  exportVideoNow(): Promise<ExportOutput | null>
  cancel(): void
  /** re-download the last successful export without re-rendering */
  downloadLast(): void
  canExportVideo: boolean
  exportVideoReason: VideoExportReadiness
}

export function useExport(): UseExportApi {
  const [state, setState] = useState<ExportState>({
    phase: 'idle',
    progress: 0,
    output: null,
    error: null,
  })
  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)

  const scenes = useProject((s) => s.scenes)
  const exportVideoReason = useMemo(() => videoExportReadiness(scenes), [scenes])

  const commitOutput = useCallback(
    (blob: Blob, filename: string, kind: 'image' | 'video', width: number, height: number): ExportOutput => {
      const output: ExportOutput = {
        blob,
        url: URL.createObjectURL(blob),
        size: blob.size,
        filename,
        kind,
        width,
        height,
      }
      setState((prev) => {
        if (prev.output) URL.revokeObjectURL(prev.output.url)
        return { phase: 'idle', progress: 1, output, error: null }
      })
      // let the timeline's "Download last export" button pick it up
      window.dispatchEvent(
        new CustomEvent('openmock:export-output', {
          detail: { url: output.url, filename: output.filename, byteSize: output.size, kind: output.kind },
        }),
      )
      return output
    },
    [],
  )

  const exportImageNow = useCallback(
    async (overrides?: ImageExportOverrides): Promise<ExportOutput | null> => {
      if (busyRef.current) return null
      busyRef.current = true
      setState((s) => ({ ...s, phase: 'rendering', progress: 0, error: null }))
      try {
        const p = useProject.getState()
        const opts: ImageExportOptions = { ...p.imageExportOptions, ...overrides }
        // capture what the viewport shows at the playhead: the frame stack
        // (floor + overlays), not the selected shot
        const stack = frameStackAtTime(p.scenes, usePlayback.getState().projectTime)
        const { blob, width, height } = await exportFrameImage(stack, opts, overrides)

        const filename = imageFilename(opts.format)
        saveBlob(blob, filename)
        return commitOutput(blob, filename, 'image', width, height)
      } catch (e) {
        const message = (e instanceof Error && e.message) || 'Export failed. Please try again.'
        toast(message, 'error')
        setState((s) => ({ ...s, phase: 'error', error: message }))
        return null
      } finally {
        busyRef.current = false
      }
    },
    [commitOutput],
  )

  const exportVideoNow = useCallback(async (): Promise<ExportOutput | null> => {
    if (busyRef.current) return null
    const p = useProject.getState()
    const readiness = videoExportReadiness(p.scenes)
    if (readiness !== 'ready') {
      toast(VIDEO_EXPORT_REASON_TEXT[readiness], 'info')
      return null
    }

    busyRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    setState((s) => ({ ...s, phase: 'rendering', progress: 0, error: null }))
    try {
      const previewWidth = viewportEngine?.getSize().width
      const pro = isProNow()
      let options = p.exportOptions
      if (!pro) {
        const { width, height } = resolveExportSize(options.size, options.customWidth, options.customHeight, 'video')
        const edge = Math.max(width, height)
        if (edge > FREE_MAX_VIDEO_EDGE) {
          const k = FREE_MAX_VIDEO_EDGE / edge
          options = {
            ...options,
            size: 'custom',
            customWidth: Math.round((width * k) / 2) * 2,
            customHeight: Math.round((height * k) / 2) * 2,
          }
        }
        if (options.fps > FREE_MAX_FPS) options = { ...options, fps: FREE_MAX_FPS }
      }
      const result = await exportVideo({
        scenes: p.scenes,
        videos: p.videos,
        audios: p.audios,
        audioClips: p.audioClips,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        options,
        watermark: !pro,
        previewWidth: previewWidth && previewWidth > 0 ? previewWidth : undefined,
        getMediaBlob,
        onProgress: (progress) =>
          setState((s) => (s.phase === 'rendering' ? { ...s, progress } : s)),
        signal: controller.signal,
      })

      const ratio = localStorage.getItem('openmock-viewport-ratio') ?? 'fill'
      const filename = videoFilename(ratio, totalDuration(p.scenes))
      saveBlob(result.blob, filename)
      return commitOutput(result.blob, filename, 'video', result.width, result.height)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        // user cancel — back to idle silently
        setState((s) => ({ ...s, phase: 'idle', progress: 0, error: null }))
        return null
      }
      const message = (e instanceof Error && e.message) || 'Export failed'
      toast(message, 'error')
      setState((s) => ({ ...s, phase: 'error', error: message }))
      return null
    } finally {
      busyRef.current = false
      abortRef.current = null
    }
  }, [commitOutput])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const output = state.output
  const downloadLast = useCallback(() => {
    if (output) saveBlob(output.blob, output.filename)
  }, [output])

  return {
    ...state,
    exportImageNow,
    exportVideoNow,
    cancel,
    downloadLast,
    canExportVideo: exportVideoReason === 'ready',
    exportVideoReason,
  }
}
