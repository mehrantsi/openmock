/**
 * Live viewport renderer for logo shots. Owns a <canvas> + LogoRenderer and
 * runs a rAF loop while mounted so the procedural shader keeps flowing even
 * when playback is paused. Enter/exit windows follow the scene-local time.
 */

import { useEffect, useRef } from 'react'
import type { LogoStyle, Shot } from '@/state/types'
import { usePlayback } from '@/state/playback'
import { DEFAULT_LOGO_STYLE, rasterizeLogo, renderLogoFrameTo, type LogoImageSource } from './logoRenderer'

export interface LogoShotViewProps {
  shot: Shot
  localSec: number
  transitionOpacity?: number
}

export function LogoShotView({ shot, localSec, transitionOpacity = 1 }: LogoShotViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const logoImgRef = useRef<LogoImageSource | null>(null)

  // freshest per-frame inputs for the rAF loop
  const frameRef = useRef({ shot, localSec, transitionOpacity })
  frameRef.current = { shot, localSec, transitionOpacity }

  const style = shot.logo ?? DEFAULT_LOGO_STYLE

  // rasterize the uploaded logo (PNG data-url or recolored SVG source)
  const imageUrl = style.imageUrl ?? null
  const svgSource = style.svgSource ?? null
  const svgColor = style.svgColor
  useEffect(() => {
    let cancelled = false
    if (!imageUrl && !svgSource) {
      logoImgRef.current = null
      return
    }
    rasterizeLogo({ imageUrl, svgSource, svgColor }).then((img) => {
      if (!cancelled) logoImgRef.current = img
    })
    return () => {
      cancelled = true
    }
  }, [imageUrl, svgSource, svgColor])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const { shot: s, localSec: propLocal, transitionOpacity: fade } = frameRef.current
      const st = s.logo ?? DEFAULT_LOGO_STYLE

      // back the canvas at device resolution
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cw = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const ch = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }

      // shader time flows continuously; the enter/exit windows track the
      // playhead (fresh project time while playing, the prop otherwise)
      const wall = (performance.now() - t0) / 1000
      const pb = usePlayback.getState()
      const local =
        pb.phase === 'playing' ? Math.max(0, pb.projectTime - s.startTime) : Math.max(0, propLocal)

      // shared pooled WebGL renderer blitted into this 2D canvas — survives
      // GPU context eviction and never multiplies GL contexts
      renderLogoFrameTo(canvas, st, wall, {
        logoImage: logoImgRef.current,
        transitionOpacity: fade,
        pixelRatio: dpr,
        localSec: local,
        shotDuration: s.duration,
      })
    }
    raf = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      data-shot-kind="logo"
      style={{ background: style.transparentBg ? 'transparent' : style.bgColor }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Effect-picker thumbnails — small live canvases reusing LogoRenderer
// ---------------------------------------------------------------------------

/**
 * Draw one animated frame of a shader effect thumbnail (e.g. 480×270 picker
 * cards) via the shared pooled renderer. Call per rAF tick for a live
 * preview; safe to call with 'none'.
 */
export function renderLogoThumb(
  canvas: HTMLCanvasElement,
  shaderId: LogoStyle['shader'],
  themeColors: [string, string, string, string],
  timeSec?: number,
): void {
  const style: LogoStyle = {
    ...DEFAULT_LOGO_STYLE,
    shader: shaderId,
    shape: 'circle',
    colors: themeColors,
    enter: { effect: 'none', duration: 0 },
    exit: { effect: 'none', duration: 0 },
  }
  renderLogoFrameTo(canvas, style, timeSec ?? performance.now() / 1000, { pixelRatio: 1 })
}

/** Kept for API compatibility — the shared pool needs no per-canvas cleanup. */
export function disposeLogoThumb(_canvas: HTMLCanvasElement): void {
  // no-op: thumbnails blit from the shared pooled renderer
}
