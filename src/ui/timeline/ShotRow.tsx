/**
 * Advanced-mode shot row: layer-list gutter cell (grip reorder, rename, kind
 * icon, duration, expand chevron) + the shot bar lane (trim handles, move
 * drag with playhead snapping, transition chips, combined keyframe strip).
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  GripVertical,
  Hexagon,
  Image as ImageIcon,
  TriangleAlert,
  Type,
} from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { FADE_DURATION_CHOICES, type Shot, type Transition } from '../../state/types'
import { useTimelineUI } from './context'
import { useContextMenu, AnchoredPopover, type MenuItem, menuSeparator } from './menu'
import { StripKeyframes } from './keyframes'
import {
  SNAP_SEC,
  applyNormalizedOrder,
  copyShot,
  leftTrimRange,
  pasteKfsAtPlayhead,
  pasteSceneFromClipboard,
  rightTrimRange,
  splitSelectedAtPlayhead,
} from './kfOps'
import { clipboardHasScene, clipboardKfCount } from './clipboard'
import { fmtSecondsShort } from './format'

// ---------------------------------------------------------------------------
// Shot context menu (shared with simple mode)
// ---------------------------------------------------------------------------

export function useShotMenu() {
  const openCtx = useContextMenu()
  const ui = useTimelineUI()

  return function onShotContextMenu(e: React.MouseEvent, shot: Shot, extra?: { replaceMedia?(): void }): void {
    e.preventDefault()
    e.stopPropagation()
    const p = useProject.getState()
    if (p.selectedSceneId !== shot.id) p.selectScene(shot.id)
    const selShots = ui.selectedShotIds.includes(shot.id) ? ui.selectedShotIds : [shot.id]
    const isLast = p.scenes.length > 0 && p.scenes.reduce((m, s) => (s.startTime > m.startTime ? s : m)).id === shot.id
    const hasMedia = !!shot.video || !!shot.imageKey
    const items: MenuItem[] = [
      { label: 'Rename', onSelect: () => ui.setRenameShotId(shot.id) },
    ]
    if (!shot.kind) {
      items.push({
        label: hasMedia ? 'Replace media…' : 'Upload media…',
        onSelect: () => extra?.replaceMedia?.(),
        disabled: !extra?.replaceMedia,
      })
      if (shot.video) items.push({ label: 'Remove video', onSelect: () => p.updateShot(shot.id, { video: undefined }) })
      if (shot.imageKey)
        items.push({ label: 'Remove media', onSelect: () => p.updateShot(shot.id, { imageKey: null, video: undefined }) })
    }
    items.push(
      { label: 'Duplicate', onSelect: () => void p.duplicateScene(shot.id) },
      {
        label: 'Reverse',
        disabled: shot.keyframes.length < 2,
        onSelect: () => p.reverseScene(shot.id),
      },
      { label: 'Split at playhead', onSelect: () => splitSelectedAtPlayhead(ui.engine) },
      menuSeparator,
      { label: 'Copy', onSelect: () => copyShot(shot) },
      {
        label: 'Paste',
        disabled: !clipboardHasScene() && clipboardKfCount() === 0,
        onSelect: () => {
          if (clipboardHasScene()) pasteSceneFromClipboard()
          else pasteKfsAtPlayhead(ui.engine)
        },
      },
      menuSeparator,
      { label: 'Add text shot', onSelect: () => void p.addTextScene() },
      { label: 'Add logo shot', onSelect: () => void p.addLogoScene() },
      {
        label: 'Set transition-out…',
        disabled: isLast,
        onSelect: () => {
          window.dispatchEvent(
            new CustomEvent('openmock:open-transition', { detail: { shotId: shot.id, x: e.clientX, y: e.clientY } }),
          )
        },
      },
      menuSeparator,
      {
        label: selShots.length > 1 ? `Delete ${selShots.length} shots` : 'Delete',
        danger: true,
        onSelect: () => {
          p.deleteScenes(selShots)
          ui.setSelectedShotIds([])
        },
      },
    )
    openCtx(e, items)
  }
}

// ---------------------------------------------------------------------------
// Transition popover
// ---------------------------------------------------------------------------

export function TransitionPopover({
  anchor,
  value,
  onChange,
  onClose,
  title,
}: {
  anchor: { x: number; y: number }
  value: Transition
  onChange(tr: Transition): void
  onClose(): void
  title?: string
}) {
  const isFade = value.kind === 'fade'
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} width={196} className="p-2">
      {title && <div className="text-[10.5px] font-medium text-black/40 dark:text-white/40 px-0.5 pb-1.5">{title}</div>}
      <div className="grid grid-cols-2 gap-1">
        <button
          className={`h-7 rounded-md text-[11px] font-medium ${
            !isFade ? 'bg-[#FD631F] text-white' : 'bg-black/[0.05] dark:bg-white/[0.07] text-black/60 dark:text-white/60'
          }`}
          onClick={() => onChange({ kind: 'cut' })}
        >
          Cut
        </button>
        <button
          className={`h-7 rounded-md text-[11px] font-medium ${
            isFade ? 'bg-[#FD631F] text-white' : 'bg-black/[0.05] dark:bg-white/[0.07] text-black/60 dark:text-white/60'
          }`}
          onClick={() => onChange({ kind: 'fade', durationMs: isFade ? value.durationMs : 500 })}
        >
          Fade
        </button>
      </div>
      {isFade && (
        <div className="mt-1 grid grid-cols-4 gap-1">
          {FADE_DURATION_CHOICES.map((ms) => (
            <button
              key={ms}
              className={`h-6 rounded-md text-[10px] font-mono ${
                value.durationMs === ms
                  ? 'bg-[#FD631F] text-white'
                  : 'bg-black/[0.05] dark:bg-white/[0.07] text-black/55 dark:text-white/55'
              }`}
              onClick={() => onChange({ kind: 'fade', durationMs: ms })}
            >
              {ms}
            </button>
          ))}
        </div>
      )}
    </AnchoredPopover>
  )
}

function FadeGlyph({ active }: { active: boolean }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" className="pointer-events-none">
      {active ? (
        <>
          <path d="M 1 9 L 9 1 L 9 9 Z" fill="#fd631f" opacity={0.9} />
          <path d="M 1 9 L 9 1" stroke="#fd631f" strokeWidth={1.2} fill="none" />
        </>
      ) : (
        <rect x={4} y={1} width={2} height={8} rx={1} className="fill-black/60 dark:fill-white/70" />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Gutter cell
// ---------------------------------------------------------------------------

function KindIcon({ shot }: { shot: Shot }) {
  const cls = 'size-3 shrink-0 text-black/40 dark:text-white/40'
  if (shot.kind === 'text') return <Type className={cls} />
  if (shot.kind === 'logo') return <Hexagon className={cls} />
  if (shot.video) return <Clapperboard className={cls} />
  return <ImageIcon className={cls} />
}

export function ShotGutterCell({ shot, index }: { shot: Shot; index: number }) {
  const ui = useTimelineUI()
  const selectScene = useProject((s) => s.selectScene)
  const renameScene = useProject((s) => s.renameScene)
  const reorderSceneTo = useProject((s) => s.reorderSceneTo)
  const selectedSceneId = useProject((s) => s.selectedSceneId)
  const [name, setName] = useState(shot.name)
  const [dragY, setDragY] = useState<number | null>(null)
  const [slotY, setSlotY] = useState<number | null>(null)
  const renaming = ui.renameShotId === shot.id
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) {
      setName(shot.name)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [renaming, shot.name])

  const commitRename = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== shot.name) renameScene(shot.id, trimmed)
    ui.setRenameShotId(null)
  }

  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    let active = false
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-shot-gutter]'))
    let dropIndex = index
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      if (!active && Math.abs(dy) < 4) return
      active = true
      setDragY(dy)
      // nearest slot: boundaries between shot rows
      const rects = rows().map((r) => r.getBoundingClientRect())
      let best = rects.length
      for (let i = 0; i < rects.length; i++) {
        if (ev.clientY < rects[i].top + rects[i].height / 2) {
          best = i
          break
        }
      }
      dropIndex = best
      const y = best < rects.length ? rects[best].top : (rects[rects.length - 1]?.bottom ?? 0)
      setSlotY(y)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDragY(null)
      setSlotY(null)
      if (!active) return
      const target = dropIndex > index ? dropIndex - 1 : dropIndex
      if (target !== index) reorderSceneTo(shot.id, target)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const expandable = !shot.kind
  const expanded = !!ui.expanded[shot.id]
  const selected = selectedSceneId === shot.id

  return (
    <div
      data-shot-gutter={shot.id}
      className={`h-9 flex items-center gap-1 pl-1 pr-2 border-b border-black/[0.05] dark:border-white/[0.05] ${
        selected ? 'bg-[#FD631F]/[0.07]' : ''
      }`}
      style={dragY !== null ? { transform: `translateY(${dragY}px)`, position: 'relative', zIndex: 30 } : undefined}
      onClick={() => selectScene(shot.id)}
    >
      <button
        className="p-0.5 cursor-grab text-black/25 dark:text-white/25 hover:text-black/50 dark:hover:text-white/50 touch-none"
        title="Drag to reorder"
        onPointerDown={onGripDown}
      >
        <GripVertical className="size-3.5" />
      </button>
      <KindIcon shot={shot} />
      {renaming ? (
        <input
          ref={inputRef}
          className="flex-1 min-w-0 h-6 px-1 rounded bg-black/[0.06] dark:bg-white/[0.08] text-[11px] outline-none border border-[#FD631F]/60 text-black/80 dark:text-white/85"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') ui.setRenameShotId(null)
          }}
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-[11px] text-black/70 dark:text-white/70"
          title="Double-click to rename"
          onDoubleClick={() => ui.setRenameShotId(shot.id)}
        >
          {shot.name}
        </span>
      )}
      <span className="text-[10px] font-mono text-black/35 dark:text-white/35">{fmtSecondsShort(shot.duration)}</span>
      {expandable && (
        <button
          className="p-0.5 text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70"
          aria-label={expanded ? 'Collapse layer' : 'Expand layer'}
          title={expanded ? 'Collapse layer' : 'Expand layer'}
          onClick={(e) => {
            e.stopPropagation()
            ui.toggleExpanded(shot.id)
          }}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      )}
      {slotY !== null &&
        createPortal(
          <div className="fixed h-[2px] bg-[#FD631F] z-[10020] pointer-events-none" style={{ left: 8, width: ui.gutterW - 16, top: slotY - 1 }} />,
          document.body,
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bar lane
// ---------------------------------------------------------------------------

export function ShotBarLane({
  shot,
  index,
  isFirst,
  isLast,
  onReplaceMedia,
}: {
  shot: Shot
  index: number
  isFirst: boolean
  isLast: boolean
  onReplaceMedia(): void
}) {
  const ui = useTimelineUI()
  const p = useProject
  const scenes = useProject((s) => s.scenes)
  const videos = useProject((s) => s.videos)
  const selectedSceneId = useProject((s) => s.selectedSceneId)
  const fadeIn = useProject((s) => s.fadeIn)
  const fadeOut = useProject((s) => s.fadeOut)
  const onShotMenu = useShotMenu()
  const [transitionPop, setTransitionPop] = useState<null | { anchor: { x: number; y: number }; which: 'out' | 'fadeIn' | 'fadeOut' }>(null)

  // open transition popover from the shot context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { shotId: string; x: number; y: number }
      if (detail?.shotId === shot.id) setTransitionPop({ anchor: { x: detail.x, y: detail.y }, which: 'out' })
    }
    window.addEventListener('openmock:open-transition', handler)
    return () => window.removeEventListener('openmock:open-transition', handler)
  }, [shot.id])

  const drag = ui.shotDrag?.[shot.id]
  const startTime = drag?.startTime ?? shot.startTime
  const duration = drag?.duration ?? shot.duration
  const left = startTime * ui.pxPerSec
  const width = Math.max(2, duration * ui.pxPerSec)

  const selected = selectedSceneId === shot.id
  const multi = !selected && ui.selectedShotIds.includes(shot.id)
  const missingVideo = !!shot.video && !videos.some((v) => v.id === shot.video!.videoId)

  // -- move drag -------------------------------------------------------------
  const onBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.shiftKey) {
      const sel = ui.selectedShotIds
      ui.setSelectedShotIds(sel.includes(shot.id) ? sel.filter((x) => x !== shot.id) : [...sel, shot.id])
      return
    }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let dragging = false
    const movedIds = ui.selectedShotIds.includes(shot.id) ? [...ui.selectedShotIds] : [shot.id]
    const all = useProject.getState().scenes
    const moved = all.filter((s) => movedIds.includes(s.id))
    const others = all.filter((s) => !movedIds.includes(s.id))
    const groupMin = Math.min(...moved.map((s) => s.startTime))
    const groupMaxEnd = Math.max(...moved.map((s) => s.startTime + s.duration))
    // single-shot neighbor clamp — media only, against other media. Text/logo
    // cards drag freely over anything (overlap = composite/cover), and media
    // slides past floating cards.
    let minDt = -groupMin
    let maxDt = 180 - groupMaxEnd
    if (moved.length === 1 && !moved[0].kind) {
      const s0 = moved[0]
      let prevEnd = 0
      let nextStart = Infinity
      for (const o of others) {
        if (o.kind) continue
        const e0 = o.startTime + o.duration
        if (e0 <= s0.startTime + 1e-6) prevEnd = Math.max(prevEnd, e0)
        if (o.startTime >= s0.startTime + s0.duration - 1e-6) nextStart = Math.min(nextStart, o.startTime)
      }
      minDt = Math.max(minDt, prevEnd - s0.startTime)
      if (nextStart < Infinity) maxDt = Math.min(maxDt, nextStart - (s0.startTime + s0.duration))
    }
    let finalDt = 0

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < 4) return
      dragging = true
      let dt = Math.min(maxDt, Math.max(minDt, dx / ui.pxPerSec))
      // snap dragged bar's start/end to playhead (nearest wins)
      const pt = ui.engine.getTime()
      const ns = shot.startTime + dt
      const ne = ns + shot.duration
      const dStart = Math.abs(ns - pt)
      const dEnd = Math.abs(ne - pt)
      if (dStart <= SNAP_SEC || dEnd <= SNAP_SEC) {
        dt = Math.min(maxDt, Math.max(minDt, dStart <= dEnd ? dt + (pt - ns) : dt + (pt - ne)))
        ui.setSnapLine(pt)
      } else {
        ui.setSnapLine(null)
      }
      finalDt = dt
      const preview: Record<string, { startTime: number; duration: number }> = {}
      for (const s of moved) preview[s.id] = { startTime: s.startTime + dt, duration: s.duration }
      ui.setShotDrag(preview)
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      ui.setSnapLine(null)
      ui.setShotDrag(null)
      const proj = p.getState()
      if (dragging) {
        if (Math.abs(finalDt) > 1e-6) {
          for (const s of moved) proj.setSceneStartTime(s.id, s.startTime + finalDt)
          applyNormalizedOrder()
        }
        return
      }
      // plain click: select + place playhead at the clicked x within the shot
      proj.selectScene(shot.id)
      ui.setSelectedShotIds([shot.id])
      usePlayback.getState().setSelectedKfIds([])
      const t = ui.timeAtClientX(ev.clientX)
      ui.engine.scrubTo(Math.min(Math.max(t, shot.startTime), shot.startTime + shot.duration))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // -- trim handles ------------------------------------------------------------
  const onTrim = (edge: 'l' | 'r') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const orig = useProject.getState().scenes.find((s) => s.id === shot.id)
    if (!orig) return
    const rRange = rightTrimRange(orig, useProject.getState().scenes, useProject.getState().videos)
    const lRange = leftTrimRange(orig, useProject.getState().scenes)
    const end = orig.startTime + orig.duration
    let finalDur = orig.duration
    let didDrag = false

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!didDrag && Math.abs(dx) < 2) return
      didDrag = true
      if (edge === 'l') {
        let dur = orig.duration - dx / ui.pxPerSec
        dur = Math.min(lRange.max, Math.max(lRange.min, dur))
        finalDur = dur
        ui.setShotDrag({ [shot.id]: { startTime: end - dur, duration: dur } })
        ui.setSnapLine(null)
      } else {
        let dur = orig.duration + dx / ui.pxPerSec
        // snap end to playhead, then to the 0.5s grid (tolerance 0.05)
        const pt = ui.engine.getTime()
        const newEnd = orig.startTime + dur
        const gridEnd = Math.round(newEnd * 2) / 2
        if (Math.abs(newEnd - pt) <= SNAP_SEC) {
          dur = pt - orig.startTime
          ui.setSnapLine(pt)
        } else if (Math.abs(newEnd - gridEnd) <= SNAP_SEC) {
          dur = gridEnd - orig.startTime
          ui.setSnapLine(gridEnd)
        } else {
          ui.setSnapLine(null)
        }
        dur = Math.min(rRange.max, Math.max(rRange.min, dur))
        finalDur = dur
        ui.setShotDrag({ [shot.id]: { startTime: orig.startTime, duration: dur } })
      }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      ui.setSnapLine(null)
      ui.setShotDrag(null)
      if (!didDrag) return
      p.getState().setSceneDuration(shot.id, finalDur, edge === 'l' ? { fromStart: true } : undefined)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const barClass = missingVideo
    ? 'border border-dashed border-amber-500/60 bg-zinc-300/50 dark:border-amber-400/50 dark:bg-zinc-700/40'
    : selected
      ? 'bg-accent/[0.12] dark:bg-accent/[0.2] border border-accent/70 ring-1 ring-accent/25 shadow-sm'
      : multi
        ? 'bg-white dark:bg-[#26262c] border border-accent/50 shadow-sm'
        : 'bg-white dark:bg-[#26262c] border border-black/[0.09] dark:border-white/[0.10] shadow-sm hover:border-black/25 dark:hover:border-white/25'

  return (
    <div className="relative h-9" style={{ width: ui.laneW }}>
      <div
        data-shot-id={shot.id}
        className={`absolute top-1 bottom-1 rounded-lg ${barClass} cursor-grab select-none touch-none overflow-visible`}
        style={{ left, width }}
        onPointerDown={onBarPointerDown}
        onContextMenu={(e) => onShotMenu(e, shot, { replaceMedia: onReplaceMedia })}
      >
        <div className="absolute inset-0 flex items-center px-2 overflow-hidden pointer-events-none">
          {missingVideo && <TriangleAlert className="size-3 mr-1 shrink-0 text-amber-500" aria-label="Source not found on this device — re-upload this shot" />}
          <span className={`text-[10.5px] font-medium truncate ${selected ? 'text-black/85 dark:text-white' : 'text-black/60 dark:text-white/70'}`}>
            {shot.name}
          </span>
        </div>

        {/* keyframe strip (mockup shots) */}
        {!shot.kind && <StripKeyframes shot={shot} />}

        {/* trim handles */}
        <div
          className="absolute left-0 top-0 bottom-0 w-[10px] cursor-ew-resize touch-none group/trim"
          onPointerDown={onTrim('l')}
        >
          <div className={`absolute left-[2px] top-1/2 -translate-y-1/2 h-3.5 w-[3px] rounded-full ${selected ? 'bg-accent/70' : 'bg-black/30 dark:bg-white/40'} group-hover/trim:bg-[#FD631F]`} />
        </div>
        <div
          className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize touch-none group/trimr"
          onPointerDown={onTrim('r')}
        >
          <div className={`absolute right-[2px] top-1/2 -translate-y-1/2 h-3.5 w-[3px] rounded-full ${selected ? 'bg-accent/70' : 'bg-black/30 dark:bg-white/40'} group-hover/trimr:bg-[#FD631F]`} />
        </div>

        {/* project fade-in chip on the first bar */}
        {isFirst && (
          <button
            className="absolute left-[13px] top-1/2 -translate-y-1/2 size-[18px] rounded-[5px] flex items-center justify-center bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20"
            title={fadeIn.kind === 'fade' ? `Fade-in ${fadeIn.durationMs / 1000}s — click to edit` : 'Hard cut at the start — click to add a fade-in'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setTransitionPop({ anchor: { x: r.left + r.width / 2, y: r.top }, which: 'fadeIn' })
            }}
          >
            <FadeGlyph active={fadeIn.kind === 'fade'} />
          </button>
        )}

        {/* project fade-out chip on the last bar */}
        {isLast && (
          <button
            className="absolute right-[13px] top-1/2 -translate-y-1/2 size-[18px] rounded-[5px] flex items-center justify-center bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20"
            title={fadeOut.kind === 'fade' ? `Fade-out ${fadeOut.durationMs / 1000}s — click to edit` : 'Hard cut at the end — click to add a fade-out'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setTransitionPop({ anchor: { x: r.left + r.width / 2, y: r.top }, which: 'fadeOut' })
            }}
          >
            <FadeGlyph active={fadeOut.kind === 'fade'} />
          </button>
        )}

        {/* transition-out chip at the boundary (not on the last shot) */}
        {!isLast && (
          <button
            className="absolute -right-[9px] top-1/2 -translate-y-1/2 size-[18px] rounded-[5px] flex items-center justify-center bg-white dark:bg-zinc-800 border border-black/15 dark:border-white/15 hover:border-[#FD631F] z-[4]"
            title={
              shot.transitionOut.kind === 'fade'
                ? `Fade ${shot.transitionOut.durationMs}ms — click to edit`
                : 'Cut — click to edit'
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setTransitionPop({ anchor: { x: r.left + r.width / 2, y: r.top }, which: 'out' })
            }}
          >
            <FadeGlyph active={shot.transitionOut.kind === 'fade'} />
          </button>
        )}
      </div>

      {transitionPop && (
        <TransitionPopover
          anchor={transitionPop.anchor}
          title={transitionPop.which === 'out' ? 'Transition out' : transitionPop.which === 'fadeIn' ? 'Project fade-in' : 'Project fade-out'}
          value={
            transitionPop.which === 'out' ? shot.transitionOut : transitionPop.which === 'fadeIn' ? fadeIn : fadeOut
          }
          onChange={(tr) => {
            const proj = p.getState()
            if (transitionPop.which === 'out') proj.setSceneTransition(shot.id, tr)
            else if (transitionPop.which === 'fadeIn') proj.setFades(tr, proj.fadeOut)
            else proj.setFades(proj.fadeIn, tr)
          }}
          onClose={() => setTransitionPop(null)}
        />
      )}
    </div>
  )
}
