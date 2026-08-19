/**
 * Text/logo shot background resolution + canvas-2D rendering.
 *
 * A TextBg resolves to a CSS string (for DOM previews) plus a `source`
 * description that the canvas renderer can draw identically for export, per
 * backgrounds.md §7: one resolver shared by editor DOM and export.
 */

import type { TextBg } from '@/state/types'
import { findGradientPreset, type GradientData, type GradientStop } from '@/lib/presets/gradients'

export type ShotBgSource =
  | { kind: 'color'; color: string }
  | { kind: 'preset'; data: GradientData; fallback: string }
  | { kind: 'image'; imageUrl: string; fallback: string; blur: number }

export interface ResolvedShotBg {
  css: string
  source: ShotBgSource
}

/** Default fallback color behind text-shot backgrounds. */
export const SHOT_BG_FALLBACK = '#0a0a0a'

/**
 * Resolve a per-shot TextBg into a CSS background string and a canvas-drawable
 * source. `fallbackColor` paints behind cover-cropped images while they load.
 */
export function resolveShotBg(bg: TextBg | undefined, opts: { fallbackColor?: string } = {}): ResolvedShotBg {
  const fallback = opts.fallbackColor ?? SHOT_BG_FALLBACK
  if (!bg) return { css: fallback, source: { kind: 'color', color: fallback } }

  if (bg.kind === 'transparent') {
    // canvas fillRect with 'transparent' is a no-op, so the same source shape works
    return { css: 'transparent', source: { kind: 'color', color: 'transparent' } }
  }
  if (bg.kind === 'image') {
    return {
      css: `url("${bg.imageUrl}") center / cover no-repeat ${fallback}`,
      source: { kind: 'image', imageUrl: bg.imageUrl, fallback, blur: bg.blur ?? 0 },
    }
  }
  if (bg.kind === 'preset') {
    const preset = findGradientPreset(bg.presetId)
    if (preset) return { css: preset.css, source: { kind: 'preset', data: preset.data, fallback } }
    return { css: fallback, source: { kind: 'color', color: fallback } }
  }
  return { css: bg.color, source: { kind: 'color', color: bg.color } }
}

// ---------------------------------------------------------------------------
// Background image cache (data urls / preset urls)
// ---------------------------------------------------------------------------

const imageCache = new Map<string, HTMLImageElement>()
const imagePending = new Map<string, Promise<HTMLImageElement>>()

/** Load (and cache) a background image; resolves once decodable. */
export function loadShotBgImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url)
  if (cached) return Promise.resolve(cached)
  const pending = imagePending.get(url)
  if (pending) return pending
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      imageCache.set(url, img)
      imagePending.delete(url)
      resolve(img)
    }
    img.onerror = () => {
      imagePending.delete(url)
      reject(new Error('Could not load background image'))
    }
    img.src = url
  })
  imagePending.set(url, p)
  return p
}

/** Synchronous cache lookup; kicks off a load when missing. */
export function getShotBgImage(url: string): HTMLImageElement | null {
  const cached = imageCache.get(url)
  if (cached) return cached
  void loadShotBgImage(url).catch(() => {})
  return null
}

// ---------------------------------------------------------------------------
// Canvas-2D renderer (backgrounds.md §7 — matches the GPU gradient plane)
// ---------------------------------------------------------------------------

function stopColor(s: GradientStop): string {
  const r = Math.round(255 * s.r)
  const g = Math.round(255 * s.g)
  const b = Math.round(255 * s.b)
  return `rgba(${r},${g},${b},${s.a})`
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function drawGradientData(ctx: CanvasRenderingContext2D, data: GradientData, w: number, h: number): void {
  // Base linear gradient through the frame center. Direction (sinθ, −cosθ)
  // with y flipped for canvas (data is y-up); half-length spans the frame.
  const angle = data.base.angle
  const dx = Math.sin(angle)
  const dy = -Math.cos(angle)
  const half = (Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * h) / 2
  const cx = w / 2
  const cy = h / 2
  const base = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  for (const s of data.base.stops) base.addColorStop(clamp01(s.offset), stopColor(s))
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  // Radials painted in array order (radial[0] first = bottom), each an
  // ellipse: unit circle of radius rx*w scaled vertically by (ry*h)/(rx*w).
  for (const radial of data.radials) {
    const rpx = radial.rx * w
    if (rpx <= 0) continue
    const sy = (radial.ry * h) / rpx
    if (sy <= 0) continue
    const tx = radial.cx * w
    const ty = (1 - radial.cy) * h // data cy is measured from the bottom
    ctx.save()
    ctx.translate(tx, ty)
    ctx.scale(1, sy)
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rpx)
    for (const s of radial.stops) grad.addColorStop(clamp01(s.offset), stopColor(s))
    ctx.fillStyle = grad
    // Fill the whole canvas expressed in the transformed local space.
    ctx.fillRect(-tx, -ty / sy, w, h / sy)
    ctx.restore()
  }
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width?: number; height?: number },
  w: number,
  h: number,
  blur: number,
): void {
  const iw =
    img instanceof HTMLImageElement ? img.naturalWidth : typeof img.width === 'number' ? img.width : 0
  const ih =
    img instanceof HTMLImageElement ? img.naturalHeight : typeof img.height === 'number' ? img.height : 0
  if (!iw || !ih) return
  const scale = Math.max(w / iw, h / ih)
  const dw = iw * scale
  const dh = ih * scale
  const blurPx = 60 * blur
  ctx.save()
  if (blurPx >= 0.5) ctx.filter = `blur(${blurPx.toFixed(1)}px)`
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
  ctx.restore()
}

/**
 * Paint a resolved shot background into a 2D context covering (0,0,w,h).
 * For image sources, pass a preloaded element via `image` or rely on the
 * module cache (`loadShotBgImage`); the fallback color paints when absent.
 */
export function drawShotBgToCanvas(
  ctx: CanvasRenderingContext2D,
  source: ShotBgSource,
  w: number,
  h: number,
  image?: CanvasImageSource | null,
): void {
  if (source.kind === 'color') {
    ctx.fillStyle = source.color
    ctx.fillRect(0, 0, w, h)
    return
  }
  if (source.kind === 'preset') {
    ctx.fillStyle = source.fallback
    ctx.fillRect(0, 0, w, h)
    drawGradientData(ctx, source.data, w, h)
    return
  }
  // image
  ctx.fillStyle = source.fallback
  ctx.fillRect(0, 0, w, h)
  const img = image ?? getShotBgImage(source.imageUrl)
  if (img) drawCoverImage(ctx, img as CanvasImageSource & { width?: number; height?: number }, w, h, source.blur)
}
