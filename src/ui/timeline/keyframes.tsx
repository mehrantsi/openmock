/**
 * Keyframe visuals + interaction: 7×7 rotate-45 diamonds, segment lines with
 * bezier easing chips, drag (translate / alt group-scale / multi-prop split)
 * with 0.05s snapping against playhead, sibling keys and shot edges, and the
 * per-item context menus.
 */

import { useRef } from 'react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import type { AnimatableProp, Keyframe, Shot } from '../../state/types'
import { PROP_LABELS, SAMPLE_DEFAULTS } from '../../state/types'
import { keyframesForProp, propsOf, sampleProp } from '../../video/timelineOps'
import { segmentBezier } from '../../video/easing'
import { useTimelineUI } from './context'
import { useContextMenu, type MenuItem, menuSeparator } from './menu'
import {
  SNAP_SEC,
  applyKfMoves,
  copyKfSelection,
  deleteKfSelection,
  isKfSelected,
  pasteKfsAtPlayhead,
  resolveSelection,
  selectAllPropKfs,
  selectAllShotKfs,
  sortedKfs,
  type KfMove,
} from './kfOps'
import { clipboardKfCount } from './clipboard'

// ---------------------------------------------------------------------------
// Diamond
// ---------------------------------------------------------------------------

export function kfLeftCss(t: number): string {
  const pct = `${t * 100}%`
  if (t < 0 || t > 1) return pct
  return `clamp(8px, ${pct}, calc(100% - 8px))`
}

export function KfDiamond({
  selected,
  left,
  hitId,
  onPointerDown,
  onContextMenu,
}: {
  selected: boolean
  left: string
  hitId: string
  onPointerDown?(e: React.PointerEvent): void
  onContextMenu?(e: React.MouseEvent): void
}) {
  return (
    <div
      data-kf-hit={hitId}
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-[17px] flex items-center justify-center cursor-ew-resize touch-none pointer-events-auto z-[3]"
      style={{ left }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <div
        className={`size-[7px] rotate-45 ${
          selected
            ? 'bg-white outline outline-[1.5px] outline-[#FD631F]'
            : 'bg-zinc-800 dark:bg-white/85'
        }`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Easing chip
// ---------------------------------------------------------------------------

export function EasingChip({
  a,
  b,
  leftPct,
  onOpen,
}: {
  a: Keyframe
  b: Keyframe
  leftPct: number
  onOpen(anchor: { x: number; y: number }, startId: string, endId: string): void
}) {
  const bz = segmentBezier(a, b)
  const px = (u: number) => 1.5 + u * 9
  const py = (v: number) => 10.5 - v * 9
  const d = `M ${px(0)} ${py(0)} C ${px(bz.p1[0])} ${py(bz.p1[1])}, ${px(bz.p2[0])} ${py(bz.p2[1])}, ${px(1)} ${py(1)}`
  return (
    <button
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-[14px] rounded-[4px] bg-white dark:bg-zinc-800 border border-black/15 dark:border-white/15 hover:border-[#FD631F] flex items-center justify-center z-[2] pointer-events-auto"
      style={{ left: `${leftPct}%` }}
      title="Edit easing"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        onOpen({ x: r.left + r.width / 2, y: r.top }, a.id, b.id)
      }}
    >
      <svg width={12} height={12} viewBox="0 0 12 12" className="pointer-events-none">
        <path d={d} fill="none" strokeWidth={1.2} className="stroke-black/70 dark:stroke-white/80" />
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

interface DragItem {
  kfId: string
  prop?: AnimatableProp
  t0: number
}

/** Pointer-down handler factory for keyframe diamonds (strip + lanes). */
export function useKfDragHandler() {
  const ui = useTimelineUI()
  const stateRef = useRef<{ finalTs: number[] } | null>(null)

  return function onDiamondPointerDown(e: React.PointerEvent, shot: Shot, kf: Keyframe, prop?: AnimatableProp): void {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const pb = usePlayback.getState()
    const id = prop ? `${kf.id}:${prop}` : kf.id

    if (e.shiftKey) {
      // toggle in selection, no drag
      const sel = pb.selectedKfIds
      pb.setSelectedKfIds(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])
      return
    }

    if (!isKfSelected(pb.selectedKfIds, kf.id, prop)) pb.setSelectedKfIds([id])

    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const alt = e.altKey
    let dragging = false

    // resolve the moved set once at drag start
    const selIds = usePlayback.getState().selectedKfIds
    const resolved = resolveSelection(shot, selIds)
    const items: DragItem[] =
      resolved.length > 0
        ? resolved.map((r) => ({ kfId: r.kf.id, prop: r.prop, t0: r.kf.t }))
        : [{ kfId: kf.id, prop, t0: kf.t }]
    let di = items.findIndex((it) => it.kfId === kf.id && it.prop === prop)
    if (di < 0) di = items.findIndex((it) => it.kfId === kf.id)
    if (di < 0) di = 0

    // group-scale mode: alt+drag from an end key with 2+ selected
    const ts = items.map((it) => it.t0)
    const tMin = Math.min(...ts)
    const tMax = Math.max(...ts)
    const gscale = alt && items.length >= 2 && (items[di].t0 === tMin || items[di].t0 === tMax) && tMax - tMin > 1e-9
    const anchor = gscale ? (items[di].t0 === tMax ? tMin : tMax) : 0

    const movedKfIds = new Set(items.map((it) => it.kfId))

    // snap candidates in seconds (not part of the moved set)
    const snapCandidates: number[] = [ui.engine.getTime(), shot.startTime, shot.startTime + shot.duration]
    for (const k of shot.keyframes) {
      if (movedKfIds.has(k.id)) continue
      if (prop && !propsOf(k).includes(prop)) continue
      snapCandidates.push(shot.startTime + k.t * shot.duration)
    }

    const pxPerT = shot.duration * ui.pxPerSec

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < 2) return
      dragging = true
      const dtRaw = dx / (pxPerT || 1)

      let newTs: number[]
      if (gscale) {
        const dragT = items[di].t0 + dtRaw
        const ratio = (dragT - anchor) / (items[di].t0 - anchor)
        newTs = items.map((it) => anchor + (it.t0 - anchor) * ratio)
        ui.setSnapLine(null)
      } else {
        let dt = dtRaw
        // snap the dragged key (start OR the key itself)
        const dragSec = shot.startTime + (items[di].t0 + dt) * shot.duration
        let best: number | null = null
        let bestDist = SNAP_SEC
        for (const c of snapCandidates) {
          const dist = Math.abs(c - dragSec)
          if (dist <= bestDist) {
            best = c
            bestDist = dist
          }
        }
        if (best !== null) {
          dt = (best - shot.startTime) / shot.duration - items[di].t0
          ui.setSnapLine(best)
        } else {
          ui.setSnapLine(null)
        }
        newTs = items.map((it) => it.t0 + dt)
      }

      stateRef.current = { finalTs: newTs }
      const map: Record<string, number> = {}
      items.forEach((it, i) => {
        map[it.prop ? `${it.kfId}:${it.prop}` : it.kfId] = newTs[i]
      })
      ui.setKfDrag(map)
    }

    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      ui.setSnapLine(null)
      if (!dragging) return
      const finalTs = stateRef.current?.finalTs
      ui.setKfDrag(null)
      if (!finalTs) return
      const moves: KfMove[] = items.map((it, i) => ({ kfId: it.kfId, prop: it.prop, t: finalTs[i] }))
      const shotNow = useProject.getState().scenes.find((s) => s.id === shot.id)
      if (!shotNow) return
      const { kfs, selection } = applyKfMoves(shotNow, moves)
      useProject.getState().setKeyframes(shot.id, kfs)
      usePlayback.getState().setSelectedKfIds(selection)
    }

    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

export function useKfContextMenu() {
  const openCtx = useContextMenu()
  const ui = useTimelineUI()
  const proj = useProject

  return function onKfContextMenu(e: React.MouseEvent, shot: Shot, kf: Keyframe, prop?: AnimatableProp): void {
    const pb = usePlayback.getState()
    const id = prop ? `${kf.id}:${prop}` : kf.id
    if (!isKfSelected(pb.selectedKfIds, kf.id, prop)) pb.setSelectedKfIds([id])
    const selCount = usePlayback.getState().selectedKfIds.length
    const pasteN = clipboardKfCount()

    const openEasingHere = () => {
      ui.openEasing({ shotId: shot.id, forSelection: true, anchor: { x: e.clientX, y: e.clientY } })
    }

    const items: MenuItem[] = [
      { label: selCount > 1 ? `Copy (${selCount})` : 'Copy', onSelect: () => void copyKfSelection() },
      {
        label: pasteN > 0 ? `Paste (${pasteN})` : 'Paste',
        disabled: pasteN === 0,
        onSelect: () => pasteKfsAtPlayhead(ui.engine),
      },
      { label: prop ? 'Graph editor…' : 'Edit easing…', onSelect: openEasingHere },
      menuSeparator,
    ]
    if (prop) {
      items.push({
        label: `Delete ${PROP_LABELS[prop]} only`,
        onSelect: () => proj.getState().removePropKeyframe(shot.id, prop, kf.t),
      })
    }
    items.push({
      label: selCount > 1 ? `Delete (${selCount})` : 'Delete',
      danger: true,
      onSelect: () => deleteKfSelection(),
    })
    items.push(menuSeparator)
    if (prop) {
      items.push({
        label: `Select all ${PROP_LABELS[prop]} keyframes`,
        onSelect: () => selectAllPropKfs(shot, prop),
      })
    }
    items.push({ label: 'Select all keyframes', onSelect: () => selectAllShotKfs() })
    openCtx(e, items)
  }
}

export function useLaneBackgroundMenu() {
  const openCtx = useContextMenu()
  const ui = useTimelineUI()

  return function onLaneContextMenu(e: React.MouseEvent, shot: Shot, prop?: AnimatableProp): void {
    const t = shot.duration > 0 ? (ui.timeAtClientX(e.clientX) - shot.startTime) / shot.duration : 0
    const pasteN = clipboardKfCount()
    const p = useProject.getState()
    const items: MenuItem[] = []
    if (prop) {
      items.push({
        label: `Add ${PROP_LABELS[prop]} keyframe`,
        onSelect: () => {
          const shotNow = useProject.getState().scenes.find((s) => s.id === shot.id)
          if (!shotNow) return
          const value =
            sampleProp(shotNow.keyframes, prop, t) ??
            (typeof shotNow.baseState?.[prop] === 'number' ? (shotNow.baseState[prop] as number) : SAMPLE_DEFAULTS[prop])
          p.recordPropKeyframe(shot.id, prop, t, value)
        },
      })
    }
    items.push({
      label: 'Add keyframe (all properties)',
      onSelect: () => p.addKeyframe(shot.id, t),
    })
    items.push({
      label: pasteN > 0 ? `Paste (${pasteN})` : 'Paste',
      disabled: pasteN === 0,
      onSelect: () => pasteKfsAtPlayhead(ui.engine),
    })
    items.push(menuSeparator)
    if (prop) {
      items.push({ label: `Select all ${PROP_LABELS[prop]} keyframes`, onSelect: () => selectAllPropKfs(shot, prop) })
    }
    items.push({ label: 'Select all keyframes', onSelect: () => selectAllShotKfs() })
    openCtx(e, items)
  }
}

// ---------------------------------------------------------------------------
// Strip (combined whole-keyframe view, inside the shot bar / simple strip)
// ---------------------------------------------------------------------------

export function StripKeyframes({ shot }: { shot: Shot }) {
  const ui = useTimelineUI()
  const selectedKfIds = usePlayback((s) => s.selectedKfIds)
  const onDown = useKfDragHandler()
  const onMenu = useKfContextMenu()

  const dispT = (kf: Keyframe): number => ui.kfDrag?.[kf.id] ?? kf.t
  const kfs = [...shot.keyframes].sort((a, b) => dispT(a) - dispT(b))
  const shotW = shot.duration * ui.pxPerSec

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* segment lines + easing chips */}
      {kfs.slice(0, -1).map((a, i) => {
        const b = kfs[i + 1]
        const t1 = dispT(a)
        const t2 = dispT(b)
        const wPx = (t2 - t1) * shotW
        if (wPx <= 0) return null
        return (
          <div key={`${a.id}-seg`}>
            <div
              className="absolute top-1/2 h-px bg-black/20 dark:bg-white/25"
              style={{ left: `${t1 * 100}%`, width: `${(t2 - t1) * 100}%` }}
            />
            {wPx >= 36 && (
              <EasingChip
                a={a}
                b={b}
                leftPct={((t1 + t2) / 2) * 100}
                onOpen={(anchor, startId, endId) => ui.openEasing({ shotId: shot.id, startId, endId, anchor })}
              />
            )}
          </div>
        )
      })}
      {kfs.map((kf) => (
        <KfDiamond
          key={kf.id}
          hitId={kf.id}
          selected={isKfSelected(selectedKfIds, kf.id)}
          left={kfLeftCss(dispT(kf))}
          onPointerDown={(e) => onDown(e, shot, kf)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onMenu(e, shot, kf)
          }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Property lane
// ---------------------------------------------------------------------------

export function PropertyLaneKeyframes({ shot, prop }: { shot: Shot; prop: AnimatableProp }) {
  const ui = useTimelineUI()
  const selectedKfIds = usePlayback((s) => s.selectedKfIds)
  const onDown = useKfDragHandler()
  const onMenu = useKfContextMenu()
  const onLaneMenu = useLaneBackgroundMenu()

  const dispT = (kf: Keyframe): number => ui.kfDrag?.[`${kf.id}:${prop}`] ?? ui.kfDrag?.[kf.id] ?? kf.t
  const kfs = keyframesForProp(shot.keyframes, prop).sort((a, b) => dispT(a) - dispT(b))
  const shotW = shot.duration * ui.pxPerSec

  return (
    <div
      data-lane-bg="1"
      className="absolute top-0 bottom-0"
      style={{ left: shot.startTime * ui.pxPerSec, width: shotW }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onLaneMenu(e, shot, prop)
      }}
    >
      <div className="absolute inset-x-0 top-1 bottom-1 rounded-md bg-black/[0.04] dark:bg-white/[0.05]" />
      {kfs.slice(0, -1).map((a, i) => {
        const b = kfs[i + 1]
        const t1 = dispT(a)
        const t2 = dispT(b)
        const wPx = (t2 - t1) * shotW
        if (wPx <= 0) return null
        return (
          <div key={`${a.id}-seg`}>
            <div
              className="absolute top-1/2 h-px bg-black/20 dark:bg-white/25"
              style={{ left: `${t1 * 100}%`, width: `${(t2 - t1) * 100}%` }}
            />
            {wPx >= 36 && (
              <EasingChip
                a={a}
                b={b}
                leftPct={((t1 + t2) / 2) * 100}
                onOpen={(anchor, startId, endId) => ui.openEasing({ shotId: shot.id, startId, endId, anchor })}
              />
            )}
          </div>
        )
      })}
      {kfs.map((kf) => (
        <KfDiamond
          key={kf.id}
          hitId={`${kf.id}:${prop}`}
          selected={isKfSelected(selectedKfIds, kf.id, prop)}
          left={kfLeftCss(dispT(kf))}
          onPointerDown={(e) => onDown(e, shot, kf, prop)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onMenu(e, shot, kf, prop)
          }}
        />
      ))}
    </div>
  )
}
