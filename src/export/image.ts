/**
 * Still-image export: resolve the output size, bake export runtime overrides
 * into the render params (captureScale drives resolution-dependent effects),
 * and capture through the engine. WEBP falls back to a canvas re-encode when
 * the engine's toBlob produced a different container.
 */

import type { Engine } from '../three/contracts'
import type { RenderState } from '../state/types'
import { toRenderParams } from '../three/renderParams'
import { resolveExportSize } from './resolutions'

export interface ImageExportArgs {
  format: 'jpeg' | 'png' | 'webp'
  size: string
  customWidth: number
  customHeight: number
  transparent: boolean
  /** dark-screenshot flag (enables the ghost echo, matches the live preview) */
  mediaIsDark?: boolean
  /** average media color used to tint the extrude slab */
  extrudeColor?: string
}

export interface ImageExportResult {
  blob: Blob
  width: number
  height: number
}

/** Re-encode any raster blob as WEBP at quality 0.95 (keeps original on failure). */
export async function transcodeToWebp(blob: Blob): Promise<Blob> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob)
  } catch {
    return blob
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(bmp, 0, 0)
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.95))
    return out && out.type === 'image/webp' ? out : blob
  } finally {
    bmp.close()
  }
}

/**
 * Capture the current look of `state` through `engine` at the requested
 * export size. Transparency only applies to non-JPEG formats.
 */
export async function exportImage(
  engine: Engine,
  state: RenderState,
  opts: ImageExportArgs,
): Promise<ImageExportResult> {
  const { width, height } = resolveExportSize(opts.size, opts.customWidth, opts.customHeight, 'image')
  const transparent = opts.transparent && opts.format !== 'jpeg'

  // resolution-dependent effects (blur, bloom radius, sharpen …) scale with
  // output-width / on-screen-width so the export matches the preview
  const viewW = engine.getSize().width
  const captureScale = viewW > 0 ? width / viewW : 1

  const params = toRenderParams(state, {
    captureScale,
    time: 0,
    transparentBg: transparent,
    showCheckerBg: false,
    mediaIsDark: opts.mediaIsDark,
    extrudeColor: opts.extrudeColor,
  })

  let blob = await engine.captureToBlob({
    width,
    height,
    format: opts.format,
    quality: opts.format === 'jpeg' ? 0.94 : opts.format === 'webp' ? 0.95 : undefined,
    transparent,
    params,
  })

  // Browsers without native canvas WEBP encoding hand back PNG — re-encode.
  if (opts.format === 'webp' && blob.type !== 'image/webp') {
    blob = await transcodeToWebp(blob)
  }

  return { blob, width, height }
}
