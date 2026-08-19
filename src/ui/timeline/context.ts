/**
 * Timeline contexts.
 *
 * - `TimelineCtx` (public): the chrome shell provides the playback engine
 *   (from usePlaybackEngine) + optional video element pool here. The timeline
 *   consumes it gracefully: when absent a store-backed fallback engine is used
 *   so scrubbing/parking still works (play/pause become no-ops since no render
 *   loop exists without the chrome).
 * - `TimelineUICtx` (internal): shared layout/selection state provided by
 *   TimelinePanel to its children.
 */

import { createContext, useContext } from 'react'
import type { PlaybackEngine, ShotVideoElements } from '../../video/playbackEngine'
import { usePlayback } from '../../state/playback'
import { useProject } from '../../state/project'
import { canvasLength, totalDuration } from '../../video/timelineOps'

// ---------------------------------------------------------------------------
// Public context (provided by the chrome shell)
// ---------------------------------------------------------------------------

export interface TimelineContextValue {
  engine: PlaybackEngine
  /** optional hidden <video> pool (for filmstrip/scrub consumers) */
  videos?: ShotVideoElements
}

export const TimelineCtx = createContext<TimelineContextValue | null>(null)

function clampProjectTime(t: number): number {
  const s = useProject.getState()
  return Math.min(Math.max(0, t), canvasLength(s.scenes, s.sequenceDuration))
}

/** Store-backed engine used when no chrome-provided engine exists. */
const fallbackEngine: PlaybackEngine = {
  play() {},
  pause() {
    usePlayback.getState().setPhase('paused')
  },
  toggle() {},
  scrubTo(t) {
    usePlayback.getState().setProjectTime(clampProjectTime(t))
  },
  scrubPreview(t) {
    usePlayback.getState().setProjectTime(clampProjectTime(t))
  },
  parkAt(t) {
    usePlayback.getState().setProjectTime(clampProjectTime(t))
  },
  stop() {
    usePlayback.getState().setPhase('idle')
    usePlayback.getState().setProjectTime(0)
  },
  getTime: () => usePlayback.getState().projectTime,
  getTotal: () => totalDuration(useProject.getState().scenes),
}

/** The playback engine — chrome-provided, or the graceful fallback. */
export function useTimelineEngine(): PlaybackEngine {
  const ctx = useContext(TimelineCtx)
  return ctx?.engine ?? fallbackEngine
}

export function useTimelineVideos(): ShotVideoElements | null {
  return useContext(TimelineCtx)?.videos ?? null
}

// ---------------------------------------------------------------------------
// Internal UI context (provided by TimelinePanel)
// ---------------------------------------------------------------------------

export interface EasingTarget {
  shotId: string
  /** explicit segment (easing chip) */
  startId?: string
  endId?: string
  /** apply to every segment adjacent to the current keyframe selection */
  forSelection?: boolean
  /** viewport anchor point the popover opens above */
  anchor: { x: number; y: number }
}

export interface TimelineUIValue {
  engine: PlaybackEngine
  simple: boolean
  /** left layer-list gutter width (220 advanced / 120 simple) */
  gutterW: number
  /** zoomed lane content width in px */
  laneW: number
  /** visible (unzoomed) lane width in px */
  viewW: number
  pxPerSec: number
  /** ruler length in seconds (canvasLength) */
  totalLen: number
  zoom: number
  setZoomAnchored(z: number): void
  getScrollEl(): HTMLDivElement | null
  /** convert a clientX into project seconds (unclamped) */
  timeAtClientX(clientX: number): number
  selectedShotIds: string[]
  setSelectedShotIds(ids: string[]): void
  selectedClipId: string | null
  setSelectedClipId(id: string | null): void
  openEasing(target: EasingTarget): void
  /** shake the record button (playback blocked while recording) */
  shakeRec(): void
  /** bumped by shakeRec — the record button animates on change */
  recShake: number
  /** snap indicator line, in project seconds */
  snapLine: number | null
  setSnapLine(v: number | null): void
  /** live keyframe drag preview: (kfId | `${kfId}:${prop}`) -> t override */
  kfDrag: Record<string, number> | null
  setKfDrag(v: Record<string, number> | null): void
  /** shot geometry drag preview (trim/move), keyed by shot id */
  shotDrag: Record<string, { startTime: number; duration: number }> | null
  setShotDrag(v: Record<string, { startTime: number; duration: number }> | null): void
  /** simple mode: shot id whose keyframe strip is open */
  openStripId: string | null
  setOpenStripId(id: string | null): void
  /** inline shot rename */
  renameShotId: string | null
  setRenameShotId(id: string | null): void
  /** expanded shots (persisted) */
  expanded: Record<string, boolean>
  toggleExpanded(id: string): void
}

export const TimelineUICtx = createContext<TimelineUIValue | null>(null)

export function useTimelineUI(): TimelineUIValue {
  const v = useContext(TimelineUICtx)
  if (!v) throw new Error('useTimelineUI outside TimelinePanel')
  return v
}
