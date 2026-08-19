/**
 * Live DOM renderer for text shots: resolved background + per-unit staggered
 * enter/exit animation. Uses the same tokenizer/sampling as textCanvas.ts so
 * the preview matches exported frames. Optional inline editing (double-click)
 * writes the content back through onChange.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Shot, TextStyle } from '@/state/types'
import { ensureFontLoaded, findFont, fontFamilyCss } from '@/lib/presets/fonts'
import { resolveShotBg } from './shotBg'
import {
  DEFAULT_TEXT_STYLE,
  TEXT_LINE_HEIGHT,
  TEXT_REF_HEIGHT,
  TEXT_WRAP_FRACTION,
  sampleFrameFx,
  sampleTextUnit,
  textFontSizePx,
  textGranularity,
  tokenizeTextShot,
} from './textCanvas'

export interface TextShotViewProps {
  shot: Shot
  localSec: number
  editable?: boolean
  onChange?: (text: TextStyle) => void
}

export function TextShotView({ shot, localSec, editable = false, onChange }: TextShotViewProps) {
  const style = shot.text ?? DEFAULT_TEXT_STYLE
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const cancelledRef = useRef(false)
  const [frameH, setFrameH] = useState(0)
  const [editing, setEditing] = useState(false)

  // container height drives the vh-relative font size
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setFrameH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const font = findFont(style.font.family)
  useEffect(() => {
    ensureFontLoaded(font, style.font.weight)
  }, [font, style.font.weight])

  // focus + select all when entering edit mode
  useEffect(() => {
    if (!editing) return
    const el = editorRef.current
    if (!el) return
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [editing])

  const bg = useMemo(() => resolveShotBg(style.bg), [style.bg])
  const bgBlurPx = style.bg.kind === 'image' ? 60 * (style.bg.blur ?? 0) : 0

  const lines = useMemo(
    () => tokenizeTextShot(style.content, style.enter.per, style.exit.per),
    [style.content, style.enter.per, style.exit.per],
  )
  const gran = textGranularity(style.enter.per, style.exit.per)

  const fontSize = textFontSizePx(style.font.size, frameH)
  const k = frameH > 0 ? frameH / TEXT_REF_HEIGHT : 0
  const duration = shot.duration

  const unitStyle = (enterUnit: number, exitUnit: number): CSSProperties => {
    const v = sampleTextUnit(style, duration, enterUnit, exitUnit, localSec)
    const transforms: string[] = []
    if (v.dy !== 0) transforms.push(`translateY(${(v.dy * k).toFixed(2)}px)`)
    if (v.scale !== 1) transforms.push(`scale(${v.scale.toFixed(4)})`)
    return {
      display: 'inline-block',
      whiteSpace: 'pre',
      opacity: Math.min(1, Math.max(0, v.opacity)),
      transform: transforms.length ? transforms.join(' ') : undefined,
      filter: v.blur > 0.1 ? `blur(${(v.blur * k).toFixed(1)}px)` : undefined,
      willChange: 'opacity, transform, filter',
    }
  }

  const textBlockStyle: CSSProperties = {
    maxWidth: `${TEXT_WRAP_FRACTION * 100}%`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'normal',
    textAlign: style.font.align,
    color: style.color,
    fontFamily: fontFamilyCss(font),
    fontWeight: style.font.weight,
    fontSize: `${fontSize.toFixed(2)}px`,
    lineHeight: TEXT_LINE_HEIGHT,
    letterSpacing: `${style.font.letterSpacing / 100}em`,
  }

  const commitEdit = () => {
    const el = editorRef.current
    setEditing(false)
    if (!el || cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const content = el.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '')
    if (content !== style.content) onChange?.({ ...style, content })
  }

  // the animated layer paints the real backdrop; the container keeps a solid
  // base color so blur edge-bleed never reveals the page behind the card
  const baseColor = bg.source.kind === 'color' ? bg.source.color : bg.source.kind === 'image' ? bg.source.fallback : '#0a0a0a'

  // whole-frame enter/exit treatment: the backdrop blurs in and zoom-settles
  // with the card instead of popping in statically behind the text
  const fx = sampleFrameFx(style, duration, localSec)
  const fxBlurPx = fx.blur * k
  const totalBlurPx = bgBlurPx + fxBlurPx
  const bgTransforms: string[] = []
  if (Math.abs(fx.dy) > 0.01) bgTransforms.push(`translateY(${(fx.dy * k).toFixed(2)}px)`)
  if (fx.scale > 1.0001) bgTransforms.push(`scale(${fx.scale.toFixed(4)})`)
  const bgLayerStyle: CSSProperties = {
    position: 'absolute',
    // overscan: blur bleeds transparently at edges and the settle scale/shift
    // must never reveal the base underneath
    inset: '-6%',
    filter: totalBlurPx >= 0.5 ? `blur(${totalBlurPx.toFixed(1)}px)` : undefined,
    transform: bgTransforms.length ? bgTransforms.join(' ') : undefined,
    willChange: 'transform, filter',
    ...(style.bg.kind === 'image'
      ? {
          backgroundColor: baseColor,
          backgroundImage: `url("${style.bg.imageUrl}")`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }
      : { background: bg.css }),
  }

  const renderAnimatedText = () => {
    if (gran === 'line') {
      // one stagger unit per content line
      return lines.map((line, li) => (
        <span key={li}>
          <span style={unitStyle(li, li)}>{line.tokens.map((t) => t.text).join('') || ' '}</span>
          {li < lines.length - 1 ? '\n' : null}
        </span>
      ))
    }
    return lines.map((line, li) => (
      <span key={li}>
        {line.tokens.map((token, ti) => {
          if (token.space) return <span key={ti}>{token.text}</span>
          if (gran === 'character' && token.chars) {
            return (
              <span key={ti} style={{ display: 'inline-block', whiteSpace: 'pre' }}>
                {token.chars.map((c, ci) => (
                  <span key={ci} style={unitStyle(c.enterUnit, c.exitUnit)}>
                    {c.ch}
                  </span>
                ))}
              </span>
            )
          }
          return (
            <span key={ti} style={unitStyle(token.enterUnit, token.exitUnit)}>
              {token.text}
            </span>
          )
        })}
        {li < lines.length - 1 ? '\n' : null}
      </span>
    ))
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ background: baseColor }}
      onDoubleClick={
        editable && onChange
          ? (e) => {
              e.stopPropagation()
              setEditing(true)
            }
          : undefined
      }
      data-shot-kind="text"
    >
      <div aria-hidden style={bgLayerStyle} />

      <div className="absolute inset-0 flex items-center justify-center">
        {editing ? (
          <div
            ref={editorRef}
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            spellCheck={false}
            style={{ ...textBlockStyle, outline: 'none', caretColor: style.color, cursor: 'text', minWidth: '1ch' }}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                cancelledRef.current = true
                e.currentTarget.blur()
              }
              e.stopPropagation()
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {style.content}
          </div>
        ) : (
          <div style={{ ...textBlockStyle, cursor: editable ? 'text' : undefined }}>{frameH > 0 ? renderAnimatedText() : null}</div>
        )}
      </div>
    </div>
  )
}
