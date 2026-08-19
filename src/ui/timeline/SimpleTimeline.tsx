/**
 * Simple-timeline mode: 26px bordered bars (reorder-only drag, double-click
 * opens a 22px combined keyframe strip), range labels, trailing dashed
 * add button, and the labeled video-preview filmstrip row.
 */

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import type { Shot } from '../../state/types'
import { useTimelineUI } from './context'
import { StripKeyframes } from './keyframes'
import { useShotMenu } from './ShotRow'
import { AddTrackMenu } from './AddTrackMenu'
import { VideoFilmstrip } from './VideoFilmstrip'
import { replaceShotMedia } from './mediaIngest'

function SimpleBar({ shot, index, orderOffset, dragging, onDragState }: {
  shot: Shot
  index: number
  orderOffset: number
  dragging: boolean
  onDragState(state: { id: string; dx: number } | null, commitIndex?: number): void
}) {
  const ui = useTimelineUI()
  const selectedSceneId = useProject((s) => s.selectedSceneId)
  const onShotMenu = useShotMenu()
  const selected = selectedSceneId === shot.id
  const left = shot.startTime * ui.pxPerSec
  const width = Math.max(24, shot.duration * ui.pxPerSec)
  const [dx, setDx] = useState(0)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let active = false
    let localDx = 0
    const scenes = useProject.getState().scenes
    const move = (ev: PointerEvent) => {
      localDx = ev.clientX - startX
      if (!active && Math.abs(localDx) < 4) return
      active = true
      setDx(localDx)
      onDragState({ id: shot.id, dx: localDx })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDx(0)
      if (active) {
        // slot detection: which shot midpoint did we pass?
        const centerX = left + width / 2 + localDx
        let target = 0
        for (let i = 0; i < scenes.length; i++) {
          const s = scenes[i]
          if (s.id === shot.id) continue
          const mid = (s.startTime + s.duration / 2) * ui.pxPerSec
          if (centerX > mid) target = i >= index ? i : i + 1
        }
        onDragState(null, target)
        return
      }
      onDragState(null)
      const proj = useProject.getState()
      proj.selectScene(shot.id)
      usePlayback.getState().setSelectedKfIds([])
      const t = ui.timeAtClientX(ev.clientX)
      ui.engine.scrubTo(Math.min(Math.max(t, shot.startTime), shot.startTime + shot.duration))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      className={`absolute top-1/2 -translate-y-1/2 h-[26px] rounded-[10px] border px-2 flex items-center gap-2 cursor-grab touch-none select-none overflow-hidden ${
        selected
          ? 'border-[#FD631F] bg-[#FD631F]/[0.07]'
          : 'border-black/15 bg-black/[0.04] dark:border-white/15 dark:bg-white/[0.05]'
      }`}
      style={{
        left,
        width,
        transform: `translate(${dragging ? dx : orderOffset}px, -50%)`,
        transition: dragging ? 'none' : 'transform 160ms cubic-bezier(0.2,0.8,0.2,1)',
        zIndex: dragging ? 20 : undefined,
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => ui.setOpenStripId(ui.openStripId === shot.id ? null : shot.id)}
      onContextMenu={(e) => onShotMenu(e, shot, { replaceMedia: () => void replaceShotMedia(shot.id) })}
    >
      <span className={`text-[10.5px] font-medium truncate ${selected ? 'text-[#FD631F]' : 'text-black/60 dark:text-white/65'}`}>
        {shot.name}
      </span>
      <span className="ml-auto text-[9px] font-mono text-black/35 dark:text-white/35 whitespace-nowrap">
        {Math.round(shot.startTime * 10) / 10}-{Math.round((shot.startTime + shot.duration) * 10) / 10}s
      </span>
    </div>
  )
}

export function SimpleBarsRow() {
  const ui = useTimelineUI()
  const scenes = useProject((s) => s.scenes)
  const reorderSceneTo = useProject((s) => s.reorderSceneTo)
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null)
  const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null)

  const endX = scenes.reduce((m, s) => Math.max(m, s.startTime + s.duration), 0) * ui.pxPerSec

  return (
    <div className="relative h-[34px]" style={{ width: ui.laneW }}>
      {scenes.map((shot, i) => (
        <SimpleBar
          key={shot.id}
          shot={shot}
          index={i}
          orderOffset={0}
          dragging={drag?.id === shot.id}
          onDragState={(state, commitIndex) => {
            setDrag(state)
            if (commitIndex !== undefined && commitIndex !== i) reorderSceneTo(shot.id, commitIndex)
          }}
        />
      ))}
      <button
        className="absolute top-1/2 -translate-y-1/2 h-[26px] w-10 rounded-[10px] border border-dashed border-black/25 dark:border-white/25 flex items-center justify-center text-black/40 dark:text-white/40 hover:border-[#FD631F] hover:text-[#FD631F]"
        style={{ left: endX + 8 }}
        title="Add track"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setAddAnchor({ x: r.left + r.width / 2, y: r.top })
        }}
      >
        <Plus className="size-3.5" />
      </button>
      {addAnchor && <AddTrackMenu anchor={addAnchor} onClose={() => setAddAnchor(null)} />}
    </div>
  )
}

export function SimpleStripRow({ shot }: { shot: Shot }) {
  const ui = useTimelineUI()
  return (
    <div className="relative h-[22px]" style={{ width: ui.laneW }}>
      <div
        className="absolute top-0 bottom-0 rounded-md bg-black/[0.04] dark:bg-white/[0.05]"
        style={{ left: shot.startTime * ui.pxPerSec, width: Math.max(2, shot.duration * ui.pxPerSec) }}
      >
        <StripKeyframes shot={shot} />
      </div>
    </div>
  )
}

export function SimpleFilmstripRow({ shot }: { shot: Shot }) {
  const ui = useTimelineUI()
  return (
    <div className="relative h-[48px] py-0.5" style={{ width: ui.laneW }}>
      <div className="sticky inline-block" style={{ left: ui.gutterW + 8, marginLeft: 8 }}>
        <VideoFilmstrip shot={shot} />
      </div>
    </div>
  )
}
