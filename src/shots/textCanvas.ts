/**
 * Text-shot rendering core: tokenization, per-unit enter/exit animation math,
 * and a canvas-2D renderer used by the export pipeline. TextShotView.tsx uses
 * the exact same tokenizer + sampling so preview and export match.
 *
 * Sizing model (shared with the DOM view):
 *   fontSizePx    = (font.size / 50) * frameHeight
 *   letterSpacing = (font.letterSpacing / 100) em
 *   lineHeight    = 1.2 × fontSize
 *   wrap width    = 84% of frame width
 *   blur/offset px are authored at a 1080p reference and scale with height.
 */

import type { Shot, TextAnim, TextStyle } from '@/state/types'
import { ensureFontLoaded, findFont, fontFamilyCss } from '@/lib/presets/fonts'
import { drawShotBgToCanvas, getShotBgImage, loadShotBgImage, resolveShotBg } from './shotBg'

export type TextPer = TextAnim['per']

/** Default style for a fresh text shot (ui.md §5). */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  content: 'Your text here',
  font: { family: 'inter', weight: 600, size: 6, align: 'center', letterSpacing: 0 },
  color: '#ffffff',
  bg: { kind: 'color', color: '#0a0a0a' },
  enter: { effect: 'soft-blur', speed: 0.5, per: 'line' },
  exit: { effect: 'soft-blur', speed: 0.5, per: 'line' },
}

export const TEXT_WRAP_FRACTION = 0.84
export const TEXT_LINE_HEIGHT = 1.2
/** Reference frame height the blur/offset pixel constants are authored at. */
export const TEXT_REF_HEIGHT = 1080

export function textFontSizePx(size: number, frameHeight: number): number {
  return (size / 50) * frameHeight
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export interface TextChar {
  ch: string
  enterUnit: number
  exitUnit: number
}

export interface TextToken {
  text: string
  space: boolean
  enterUnit: number
  exitUnit: number
  /** per-character units, present only when either anim splits by character */
  chars: TextChar[] | null
}

export interface TextLineTokens {
  tokens: TextToken[]
  enterUnit: number
  exitUnit: number
}

/** The finest split either animation needs. */
export function textGranularity(enterPer: TextPer, exitPer: TextPer): TextPer {
  if (enterPer === 'character' || exitPer === 'character') return 'character'
  if (enterPer === 'word' || exitPer === 'word') return 'word'
  return 'line'
}

/**
 * Split content into lines → word/space tokens, resolving each token's
 * enter/exit stagger unit index (global across the whole text). Whitespace
 * inherits the preceding unit so it animates alongside its neighbors.
 */
export function tokenizeTextShot(content: string, enterPer: TextPer, exitPer: TextPer): TextLineTokens[] {
  const needChars = enterPer === 'character' || exitPer === 'character'
  const lines = content.split('\n')
  let wordIdx = 0
  let charIdx = 0

  const unitFor = (per: TextPer, lineIdx: number, word: number, char: number): number =>
    per === 'line' ? lineIdx : per === 'word' ? word : char

  return lines.map((lineText, lineIdx) => {
    const parts = lineText.split(/(\s+)/).filter((s) => s.length > 0)
    const tokens: TextToken[] = []
    let prevEnter = unitFor(enterPer, lineIdx, wordIdx, charIdx)
    let prevExit = unitFor(exitPer, lineIdx, wordIdx, charIdx)

    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        tokens.push({ text: part, space: true, enterUnit: prevEnter, exitUnit: prevExit, chars: null })
        continue
      }
      const startChar = charIdx
      const enterUnit = unitFor(enterPer, lineIdx, wordIdx, startChar)
      const exitUnit = unitFor(exitPer, lineIdx, wordIdx, startChar)
      let chars: TextChar[] | null = null
      if (needChars) {
        chars = Array.from(part).map((ch) => {
          const c: TextChar = {
            ch,
            enterUnit: unitFor(enterPer, lineIdx, wordIdx, charIdx),
            exitUnit: unitFor(exitPer, lineIdx, wordIdx, charIdx),
          }
          charIdx += 1
          return c
        })
      } else {
        charIdx += Array.from(part).length
      }
      tokens.push({ text: part, space: false, enterUnit, exitUnit, chars })
      prevEnter = enterUnit
      prevExit = exitUnit
      wordIdx += 1
    }

    return {
      tokens,
      enterUnit: unitFor(enterPer, lineIdx, wordIdx, charIdx),
      exitUnit: unitFor(exitPer, lineIdx, wordIdx, charIdx),
    }
  })
}

// ---------------------------------------------------------------------------
// Animation sampling
// ---------------------------------------------------------------------------

export interface TextUnitVisual {
  opacity: number
  /** blur px at the 1080p reference height */
  blur: number
  /** translateY px at the 1080p reference height */
  dy: number
  scale: number
}

const VISIBLE: TextUnitVisual = { opacity: 1, blur: 0, dy: 0, scale: 1 }

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3)
}

/**
 * Eased progress (0 hidden → 1 shown) of stagger unit `unit` at `t` seconds
 * into the animation. delay = unit·0.06/speed, duration = 0.45/speed.
 */
export function evalTextAnimProgress(anim: TextAnim, unit: number, t: number): number {
  if (anim.effect === 'none') return 1
  const speed = Math.max(anim.speed, 0.05)
  const delay = (unit * 0.06) / speed
  const dur = 0.45 / speed
  const p = Math.min(1, Math.max(0, (t - delay) / dur))
  return easeOutCubic(p)
}

function effectVisual(effect: TextAnim['effect'], p: number): TextUnitVisual {
  switch (effect) {
    case 'soft-blur':
      return { opacity: p, blur: 12 * (1 - p), dy: 0, scale: 1 }
    case 'fade-up':
      return { opacity: p, blur: 0, dy: 24 * (1 - p), scale: 1 }
    case 'scale-up':
      return { opacity: p, blur: 0, dy: 0, scale: 0.92 + 0.08 * p }
    case 'scale-down':
      return { opacity: p, blur: 0, dy: 0, scale: 1.08 - 0.08 * p }
    case 'blur-scale-up':
      return { opacity: p, blur: 12 * (1 - p), dy: 0, scale: 0.92 + 0.08 * p }
    case 'blur-scale-down':
      return { opacity: p, blur: 12 * (1 - p), dy: 0, scale: 1.08 - 0.08 * p }
    default:
      return VISIBLE
  }
}

/**
 * Combined enter+exit visual of a unit at `localSec` in a shot of
 * `shotDuration` seconds. Exit is the enter math mirrored in time (evaluated
 * against the remaining seconds), so the text leaves the way it arrived.
 */
export function sampleTextUnit(
  style: TextStyle,
  shotDuration: number,
  enterUnit: number,
  exitUnit: number,
  localSec: number,
): TextUnitVisual {
  const t = Math.max(0, localSec)
  const enter = effectVisual(style.enter.effect, evalTextAnimProgress(style.enter, enterUnit, t))
  const exit = effectVisual(style.exit.effect, evalTextAnimProgress(style.exit, exitUnit, shotDuration - t))
  return {
    opacity: enter.opacity * exit.opacity,
    blur: enter.blur + exit.blur,
    dy: enter.dy + exit.dy,
    scale: enter.scale * exit.scale,
  }
}

// ---------------------------------------------------------------------------
// Whole-frame background envelope: the backdrop participates in enter/exit
// (blur-in + zoom-settle) instead of popping in statically behind the text.
// Self-contained ops only (no opacity), so DOM preview and canvas export
// match without needing a reveal base. Scale stays ≥ 1 (edge-safe).
// ---------------------------------------------------------------------------

export interface FrameFx {
  /** blur px at the 1080p reference height */
  blur: number
  /** uniform scale, always ≥ 1 */
  scale: number
  /** translateY px at the 1080p reference height */
  dy: number
}

const FRAME_STILL: FrameFx = { blur: 0, scale: 1, dy: 0 }

function frameSideFx(anim: TextAnim, t: number): FrameFx {
  if (anim.effect === 'none') return FRAME_STILL
  const speed = Math.max(anim.speed, 0.05)
  // slightly longer window than the text units so the backdrop settles last
  const win = 0.7 / speed
  const r = 1 - easeOutCubic(Math.min(1, Math.max(0, t / win))) // 1 = fully un-entered
  if (r <= 0.0001) return FRAME_STILL
  switch (anim.effect) {
    case 'soft-blur':
      return { blur: 14 * r, scale: 1, dy: 0 }
    case 'fade-up':
      // the 1.04 overscan keeps the shifted backdrop covering the frame
      return { blur: 0, scale: 1 + 0.04 * r, dy: 18 * r }
    case 'scale-up':
    case 'scale-down':
      return { blur: 0, scale: 1 + 0.06 * r, dy: 0 }
    case 'blur-scale-up':
    case 'blur-scale-down':
      return { blur: 14 * r, scale: 1 + 0.06 * r, dy: 0 }
    default:
      return FRAME_STILL
  }
}

/** Backdrop treatment at `localSec` — enter and exit combined. */
export function sampleFrameFx(style: TextStyle, shotDuration: number, localSec: number): FrameFx {
  const enter = frameSideFx(style.enter, Math.max(0, localSec))
  const exit = frameSideFx(style.exit, Math.max(0, shotDuration - localSec))
  return {
    blur: Math.max(enter.blur, exit.blur),
    scale: Math.max(enter.scale, exit.scale),
    dy: enter.dy + exit.dy,
  }
}

// ---------------------------------------------------------------------------
// Asset preparation (fonts + bg image) for deterministic canvas rendering
// ---------------------------------------------------------------------------

/**
 * Ensure the shot's font is registered/loaded and the background image is
 * cached, so `renderTextShotToCanvas` draws the final result on frame one.
 */
export async function prepareTextShotAssets(style: TextStyle): Promise<void> {
  const font = findFont(style.font.family)
  ensureFontLoaded(font, style.font.weight)
  const spec = `${style.font.weight} 16px ${fontFamilyCss(font)}`
  try {
    await document.fonts.load(spec, style.content || 'Ag')
  } catch {
    // fall back to whatever is available
  }
  if (style.bg.kind === 'image') {
    try {
      await loadShotBgImage(style.bg.imageUrl)
    } catch {
      // fallback color paints instead
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas renderer
// ---------------------------------------------------------------------------

interface PlacedToken {
  token: TextToken
  x: number
  width: number
}

interface VisualLine {
  placed: PlacedToken[]
  width: number
  enterUnit: number
  exitUnit: number
}

type SpacingCtx = CanvasRenderingContext2D & { letterSpacing?: string }

function layoutLines(
  ctx: CanvasRenderingContext2D,
  lines: TextLineTokens[],
  maxWidth: number,
): VisualLine[] {
  const out: VisualLine[] = []
  for (const line of lines) {
    let placed: PlacedToken[] = []
    let x = 0
    let wrapped = false
    const flush = () => {
      out.push({ placed, width: x, enterUnit: line.enterUnit, exitUnit: line.exitUnit })
      placed = []
      x = 0
      wrapped = true
    }
    for (const token of line.tokens) {
      // drop whitespace at the head of a wrapped (not explicit) line
      if (token.space && placed.length === 0 && wrapped) continue
      const tw = ctx.measureText(token.text).width
      if (!token.space && placed.length > 0 && x + tw > maxWidth) flush()
      placed.push({ token, x, width: tw })
      x += tw
    }
    out.push({ placed, width: x, enterUnit: line.enterUnit, exitUnit: line.exitUnit })
  }
  return out
}

/**
 * Draw a full text-shot frame (background + animated text) into a 2D context.
 * Mirrors TextShotView's DOM output so exported video matches the preview.
 */
export function renderTextShotToCanvas(
  ctx: CanvasRenderingContext2D,
  shot: Shot,
  w: number,
  h: number,
  localSec: number,
  globalOpacity: number,
): void {
  const style = shot.text ?? DEFAULT_TEXT_STYLE
  const alpha = Math.min(1, Math.max(0, globalOpacity))
  // NB: never clear here — callers own the backdrop (overlay shots composite
  // over an already-painted base frame)
  if (alpha <= 0) return

  ctx.save()
  ctx.globalAlpha = alpha

  // background — participates in enter/exit (blur-in + zoom-settle).
  // Transparent shots have no backdrop: only the text composites.
  if (style.bg.kind !== 'transparent') {
    const { source } = resolveShotBg(style.bg)
    const bgImage = source.kind === 'image' ? getShotBgImage(source.imageUrl) : null
    const fx = sampleFrameFx(style, shot.duration, localSec)
    const fxScaleK = h / TEXT_REF_HEIGHT
    const fxBlurPx = fx.blur * fxScaleK
    // overscan enough that the blur's transparent edge bleed stays offscreen
    const fxScale = Math.max(fx.scale, 1 + (3 * fxBlurPx) / Math.min(w, h))
    ctx.save()
    if (fxScale > 1.0001 || Math.abs(fx.dy) > 0.01) {
      ctx.translate(w / 2, h / 2 + fx.dy * fxScaleK)
      ctx.scale(fxScale, fxScale)
      ctx.translate(-w / 2, -h / 2)
    }
    if (fxBlurPx >= 0.5) ctx.filter = `blur(${fxBlurPx.toFixed(1)}px)`
    drawShotBgToCanvas(ctx, source, w, h, bgImage)
    ctx.restore()
  }

  const content = style.content
  if (content.trim().length === 0) {
    ctx.restore()
    return
  }

  // typography
  const font = findFont(style.font.family)
  const fontSize = textFontSizePx(style.font.size, h)
  const lineH = fontSize * TEXT_LINE_HEIGHT
  ctx.font = `${style.font.weight} ${fontSize}px ${fontFamilyCss(font)}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const spacingCtx = ctx as SpacingCtx
  if ('letterSpacing' in spacingCtx) {
    spacingCtx.letterSpacing = `${((style.font.letterSpacing / 100) * fontSize).toFixed(2)}px`
  }

  const lines = tokenizeTextShot(content, style.enter.per, style.exit.per)
  const gran = textGranularity(style.enter.per, style.exit.per)
  const visual = layoutLines(ctx, lines, w * TEXT_WRAP_FRACTION)

  const blockW = visual.reduce((m, l) => Math.max(m, l.width), 0)
  const blockLeft = (w - blockW) / 2
  const totalH = visual.length * lineH
  const yTop = (h - totalH) / 2
  const k = h / TEXT_REF_HEIGHT // scale for the 1080p-authored px constants
  const duration = shot.duration

  ctx.fillStyle = style.color

  const drawUnit = (
    text: string,
    x: number,
    width: number,
    cy: number,
    enterUnit: number,
    exitUnit: number,
  ) => {
    const v = sampleTextUnit(style, duration, enterUnit, exitUnit, localSec)
    if (v.opacity <= 0.002) return
    ctx.save()
    ctx.globalAlpha = alpha * Math.min(1, v.opacity)
    if (v.blur > 0.1) ctx.filter = `blur(${(v.blur * k).toFixed(1)}px)`
    const cx = x + width / 2
    ctx.translate(cx, cy + v.dy * k)
    if (v.scale !== 1) ctx.scale(v.scale, v.scale)
    ctx.fillText(text, -width / 2, 0)
    ctx.restore()
  }

  visual.forEach((line, li) => {
    const lineX =
      style.font.align === 'left'
        ? blockLeft
        : style.font.align === 'right'
          ? blockLeft + blockW - line.width
          : (w - line.width) / 2
    const cy = yTop + (li + 0.5) * lineH

    if (gran === 'line') {
      // whole visual line animates as one unit (unit index = content line)
      const first = line.placed[0]
      if (!first) return
      const text = line.placed.map((p) => p.token.text).join('')
      drawUnit(text, lineX, line.width, cy, first.token.enterUnit, first.token.exitUnit)
      return
    }

    for (const p of line.placed) {
      if (p.token.space) continue
      if (gran === 'character' && p.token.chars) {
        let prefix = ''
        for (const c of p.token.chars) {
          const cx0 = lineX + p.x + ctx.measureText(prefix).width
          const cw = ctx.measureText(c.ch).width
          drawUnit(c.ch, cx0, cw, cy, c.enterUnit, c.exitUnit)
          prefix += c.ch
        }
      } else {
        drawUnit(p.token.text, lineX + p.x, p.width, cy, p.token.enterUnit, p.token.exitUnit)
      }
    }
  })

  if ('letterSpacing' in spacingCtx) spacingCtx.letterSpacing = '0px'
  ctx.restore()
}
