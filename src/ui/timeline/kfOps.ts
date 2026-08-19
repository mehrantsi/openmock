/**
 * Timeline operations glue: selection resolution, copy/paste, keyframe drag
 * commits, split/stamp helpers. Pure-ish wrappers over the project store.
 */

import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import {
  ANIMATABLE_PROPS,
  ANIMATABLE_SET,
  MIN_SHOT_DURATION,
  MAX_SHOT_DURATION,
  MAX_PROJECT_DURATION,
  SAMPLE_DEFAULTS,
  type AnimatableProp,
  type BezierHandle,
  type Keyframe,
  type ProjectVideo,
  type Shot,
} from '../../state/types'
import {
  addKeyframeAt,
  keyframesForProp,
  kfMaxT,
  kfMinT,
  minKfGap,
  normalizeOrder,
  propsOf,
  sampleProp,
} from '../../video/timelineOps'
import { keyframeId } from '../../lib/ids'
import { toast } from '../toast'
import { getClipboard, makeKfEntries, setClipboard } from './clipboard'
import type { PlaybackEngine } from '../../video/playbackEngine'

/** Snap window for keyframe/bar drags & playhead snapping (seconds). */
export const SNAP_SEC = 0.05

export function selectedShot(): Shot | null {
  const p = useProject.getState()
  return p.scenes.find((s) => s.id === p.selectedSceneId) ?? null
}

/** Playhead position normalized into the shot, clamped to the kf drag bounds. */
export function playheadLocalT(shot: Shot, pt: number): number {
  const t = shot.duration > 0 ? (pt - shot.startTime) / shot.duration : 0
  return Math.min(kfMaxT(shot), Math.max(kfMinT(shot), t))
}

/** Derived-id parsing: `${kfId}:${prop}` -> parent id (plain ids pass through). */
export function parentKfId(id: string): string {
  const ci = id.lastIndexOf(':')
  if (ci < 0) return id
  return ANIMATABLE_SET.has(id.slice(ci + 1)) ? id.slice(0, ci) : id
}

export function derivedProp(id: string): AnimatableProp | null {
  const ci = id.lastIndexOf(':')
  if (ci < 0) return null
  const suffix = id.slice(ci + 1)
  return ANIMATABLE_SET.has(suffix) ? (suffix as AnimatableProp) : null
}

export interface SelectionItem {
  kf: Keyframe
  /** set when the selection entry is a per-prop key (`kfId:prop`) */
  prop?: AnimatableProp
}

/** Resolve selection ids against a shot's keyframes. */
export function resolveSelection(shot: Shot, ids: string[]): SelectionItem[] {
  const items: SelectionItem[] = []
  for (const id of ids) {
    const whole = shot.keyframes.find((k) => k.id === id)
    if (whole) {
      items.push({ kf: whole })
      continue
    }
    const prop = derivedProp(id)
    if (!prop) continue
    const parent = shot.keyframes.find((k) => k.id === parentKfId(id))
    if (parent && propsOf(parent).includes(prop)) items.push({ kf: parent, prop })
  }
  return items
}

/** Is this keyframe (or one of its props) selected? */
export function isKfSelected(selection: string[], kfId: string, prop?: AnimatableProp): boolean {
  if (prop) return selection.includes(`${kfId}:${prop}`) || selection.includes(kfId)
  if (selection.includes(kfId)) return true
  return selection.some((id) => parentKfId(id) === kfId)
}

// ---------------------------------------------------------------------------
// Copy / paste
// ---------------------------------------------------------------------------

export function copyKfSelection(): boolean {
  const shot = selectedShot()
  if (!shot) return false
  const items = resolveSelection(shot, usePlayback.getState().selectedKfIds)
  if (items.length === 0) return false
  setClipboard({ kind: 'kf', entries: makeKfEntries(items) })
  return true
}

export function copyShot(shot: Shot): void {
  setClipboard({ kind: 'scene', shot: structuredClone(shot) })
}

/** Paste copied keyframes at the playhead into the selected mockup shot. */
export function pasteKfsAtPlayhead(engine: PlaybackEngine): void {
  const clip = getClipboard()
  if (clip?.kind !== 'kf' || clip.entries.length === 0) return
  const shot = selectedShot()
  if (!shot || shot.kind) return
  const baseT = playheadLocalT(shot, engine.getTime())
  const maxT = kfMaxT(shot)
  const minT = kfMinT(shot)
  let kfs = [...shot.keyframes]
  const seen = new Set(kfs.map((k) => k.id))
  const origIds = new Set(seen)
  for (const e of clip.entries) {
    const t = Math.min(maxT, Math.max(minT, baseT + e.dt))
    kfs = addKeyframeAt(kfs, t, structuredClone(e.state), e.props ? [...e.props] : undefined)
    const added = kfs.find((k) => !seen.has(k.id))
    if (added) {
      seen.add(added.id)
      if (e.outEasing) added.outEasing = [...e.outEasing] as BezierHandle
      if (e.inEasing) added.inEasing = [...e.inEasing] as BezierHandle
    }
  }
  useProject.getState().setKeyframes(shot.id, kfs)
  usePlayback.getState().setSelectedKfIds(kfs.filter((k) => !origIds.has(k.id)).map((k) => k.id))
}

/** Paste a copied shot after the selected one. */
export function pasteSceneFromClipboard(): void {
  const clip = getClipboard()
  if (clip?.kind !== 'scene') return
  const p = useProject.getState()
  const src = clip.shot
  const created = src.kind === 'text' ? p.addTextScene() : src.kind === 'logo' ? p.addLogoScene() : p.addScene()
  if (!created) {
    toast('Scene limit reached (20).', 'error')
    return
  }
  p.updateShot(created.id, {
    name: src.name,
    baseState: src.baseState ? structuredClone(src.baseState) : null,
    transitionOut: structuredClone(src.transitionOut),
    text: src.text ? structuredClone(src.text) : undefined,
    logo: src.logo ? structuredClone(src.logo) : undefined,
    video: src.video ? structuredClone(src.video) : undefined,
    imageKey: src.imageKey,
  })
  p.setSceneDuration(created.id, src.duration)
  p.setKeyframes(
    created.id,
    src.keyframes.map((k) => ({ ...structuredClone(k), id: keyframeId() })),
  )
  applyNormalizedOrder()
}

// ---------------------------------------------------------------------------
// Order helpers
// ---------------------------------------------------------------------------

/** Apply normalizeOrder (push overlaps right, keep gaps) via store actions. */
export function applyNormalizedOrder(): void {
  const p = useProject.getState()
  const norm = normalizeOrder(p.scenes)
  for (const s of norm) {
    const cur = useProject.getState().scenes.find((x) => x.id === s.id)
    if (cur && Math.abs(cur.startTime - s.startTime) > 1e-6) p.setSceneStartTime(s.id, s.startTime)
  }
}

// ---------------------------------------------------------------------------
// Deletion / selection
// ---------------------------------------------------------------------------

export function deleteKfSelection(): boolean {
  const p = useProject.getState()
  const pb = usePlayback.getState()
  const ids = pb.selectedKfIds
  const shot = selectedShot()
  if (!shot || ids.length === 0) return false
  const wholeDelete = new Set<string>()
  const propRemovals = new Map<string, Set<AnimatableProp>>()
  for (const id of ids) {
    if (shot.keyframes.some((k) => k.id === id)) {
      wholeDelete.add(id)
      continue
    }
    const prop = derivedProp(id)
    if (!prop) continue
    const parent = parentKfId(id)
    const set = propRemovals.get(parent) ?? new Set<AnimatableProp>()
    set.add(prop)
    propRemovals.set(parent, set)
  }
  if (wholeDelete.size === 0 && propRemovals.size === 0) return false
  const next: Keyframe[] = []
  for (const k of shot.keyframes) {
    if (wholeDelete.has(k.id)) continue
    const rem = propRemovals.get(k.id)
    if (!rem) {
      next.push(k)
      continue
    }
    const remaining = propsOf(k).filter((pr) => !rem.has(pr))
    if (remaining.length === 0) continue
    next.push({ ...k, props: [...remaining] })
  }
  p.setKeyframes(shot.id, next)
  pb.setSelectedKfIds([])
  return true
}

export function selectAllShotKfs(): void {
  const shot = selectedShot()
  if (!shot) return
  usePlayback.getState().setSelectedKfIds(shot.keyframes.map((k) => k.id))
}

export function selectAllPropKfs(shot: Shot, prop: AnimatableProp): void {
  usePlayback.getState().setSelectedKfIds(keyframesForProp(shot.keyframes, prop).map((k) => `${k.id}:${prop}`))
}

// ---------------------------------------------------------------------------
// Stamping / splitting
// ---------------------------------------------------------------------------

/**
 * "Add keyframe" (K): one keyframe at the playhead keying every animatable prop
 * whose dial value differs > 1e-6 from the sampled/base value. Props that
 * already have >= 2 keys are skipped (they are animated; the static dial value
 * would spuriously diff mid-curve).
 */
export function stampChangedProps(engine: PlaybackEngine): void {
  const p = useProject.getState()
  const shot = selectedShot()
  if (!shot || shot.kind) return
  const t = playheadLocalT(shot, engine.getTime())
  const changed: AnimatableProp[] = []
  for (const prop of ANIMATABLE_PROPS) {
    const cur = p.dials[prop]
    if (typeof cur !== 'number') continue
    if (keyframesForProp(shot.keyframes, prop).length >= 2) continue
    const base = shot.baseState?.[prop]
    const ref = sampleProp(shot.keyframes, prop, t) ?? (typeof base === 'number' ? base : SAMPLE_DEFAULTS[prop])
    if (Math.abs(cur - ref) > 1e-6) changed.push(prop)
  }
  if (changed.length === 0) {
    toast('Nothing changed to keyframe.')
    return
  }
  p.addKeyframe(shot.id, t, changed, p.dials)
}

/** Split the selected shot at the playhead (with the vendor's error toasts). */
export function splitSelectedAtPlayhead(engine: PlaybackEngine): void {
  const p = useProject.getState()
  const shot = selectedShot()
  if (!shot) {
    toast('Nothing to split here')
    return
  }
  if (shot.kind) {
    toast('Text and logo shots can’t be split')
    return
  }
  const pt = engine.getTime()
  const local = pt - shot.startTime
  if (local <= 1e-6 || local >= shot.duration - 1e-6) {
    toast('Nothing to split here')
    return
  }
  if (local < MIN_SHOT_DURATION || shot.duration - local < MIN_SHOT_DURATION) {
    toast('Too close to the shot edge')
    return
  }
  p.splitSceneAt(shot.id, local / shot.duration)
}

// ---------------------------------------------------------------------------
// Keyframe drag commit
// ---------------------------------------------------------------------------

export interface KfMove {
  kfId: string
  /** per-prop move (property lane); splits multi-prop parents */
  prop?: AnimatableProp
  t: number
}

function propsOverlap(a: readonly AnimatableProp[], b: readonly AnimatableProp[]): boolean {
  if (a.length === 0 || b.length === 0) return true
  return a.some((p) => b.includes(p))
}

/**
 * Apply a set of keyframe moves to a shot, splitting multi-prop keyframes when
 * a single prop is dragged, avoiding collisions with unmoved keys sharing
 * props. Returns the new keyframe array + the selection ids to keep.
 */
export function applyKfMoves(shot: Shot, moves: KfMove[]): { kfs: Keyframe[]; selection: string[] } {
  const maxT = kfMaxT(shot)
  const minT = kfMinT(shot)
  const gap = minKfGap(shot)
  const clampT = (t: number) => Math.min(maxT, Math.max(minT, t))

  const wholeMoves = new Map<string, number>()
  const propMoves = new Map<string, { prop: AnimatableProp; t: number }[]>()
  for (const m of moves) {
    if (m.prop) {
      const list = propMoves.get(m.kfId) ?? []
      list.push({ prop: m.prop, t: m.t })
      propMoves.set(m.kfId, list)
    } else {
      wholeMoves.set(m.kfId, m.t)
    }
  }

  const out: Keyframe[] = []
  const movedIds = new Set<string>()
  const selection: string[] = []
  const splitCounters = new Map<string, number>()
  const takenIds = new Set(shot.keyframes.map((k) => k.id))

  for (const kf of shot.keyframes) {
    const whole = wholeMoves.get(kf.id)
    if (whole !== undefined) {
      out.push({ ...kf, t: clampT(whole) })
      movedIds.add(kf.id)
      selection.push(kf.id)
      continue
    }
    const pmoves = propMoves.get(kf.id)
    if (!pmoves) {
      out.push(kf)
      continue
    }
    const kfProps = propsOf(kf)
    const movedProps = new Set(pmoves.map((m) => m.prop))
    const remaining = kfProps.filter((p) => !movedProps.has(p))
    const byT = new Map<number, AnimatableProp[]>()
    for (const m of pmoves) {
      const list = byT.get(m.t) ?? []
      list.push(m.prop)
      byT.set(m.t, list)
    }
    if (remaining.length === 0 && byT.size === 1) {
      // every keyed prop moves together — move the keyframe itself
      out.push({ ...kf, t: clampT(pmoves[0].t) })
      movedIds.add(kf.id)
      for (const p of kfProps) selection.push(`${kf.id}:${p}`)
      continue
    }
    if (remaining.length > 0) out.push({ ...kf, props: [...remaining] })
    for (const [t, props] of byT) {
      let n = splitCounters.get(kf.id) ?? 0
      let id = `${kf.id}::sel${n === 0 ? '' : n}`
      while (takenIds.has(id)) {
        n++
        id = `${kf.id}::sel${n}`
      }
      splitCounters.set(kf.id, n + 1)
      takenIds.add(id)
      const clone: Keyframe = {
        id,
        t: clampT(t),
        state: structuredClone(kf.state),
        props: [...props],
        outEasing: kf.outEasing ? ([...kf.outEasing] as BezierHandle) : undefined,
        inEasing: kf.inEasing ? ([...kf.inEasing] as BezierHandle) : undefined,
      }
      out.push(clone)
      movedIds.add(id)
      for (const p of props) selection.push(`${id}:${p}`)
    }
  }

  // collision avoidance: step moved keys outward until clear of unmoved keys
  // sharing props (alternating direction, minGap units)
  for (const k of out) {
    if (!movedIds.has(k.id)) continue
    const collides = (t: number) =>
      out.some((o) => o !== k && !movedIds.has(o.id) && Math.abs(o.t - t) < gap && propsOverlap(propsOf(o), propsOf(k)))
    if (!collides(k.t)) continue
    for (let step = 1; step <= 64; step++) {
      const dir = step % 2 === 1 ? 1 : -1
      const mag = Math.ceil(step / 2)
      const cand = clampT(k.t + dir * mag * gap)
      if (!collides(cand)) {
        k.t = cand
        break
      }
    }
  }

  return { kfs: out.sort((a, b) => a.t - b.t), selection }
}

// ---------------------------------------------------------------------------
// Easing application
// ---------------------------------------------------------------------------

export function sortedKfs(shot: Shot): Keyframe[] {
  return [...shot.keyframes].sort((a, b) => a.t - b.t)
}

/** Segments (consecutive kf pairs) where either endpoint is in the selection. */
export function selectionSegments(shot: Shot, selection: string[]): { a: Keyframe; b: Keyframe }[] {
  const parents = new Set(selection.map(parentKfId))
  const sorted = sortedKfs(shot)
  const out: { a: Keyframe; b: Keyframe }[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (parents.has(a.id) || parents.has(b.id)) out.push({ a, b })
  }
  return out
}

/** Set the easing of every segment adjacent to the selection (single commit). */
export function applySelectionEasing(shot: Shot, selection: string[], p1: BezierHandle, p2: BezierHandle): void {
  const segs = selectionSegments(shot, selection)
  if (segs.length === 0) return
  const outIds = new Set(segs.map((s) => s.a.id))
  const inIds = new Set(segs.map((s) => s.b.id))
  const kfs = shot.keyframes.map((k) => {
    let next = k
    if (outIds.has(k.id)) next = { ...next, outEasing: [...p1] as BezierHandle }
    if (inIds.has(k.id)) next = { ...next, inEasing: [...p2] as BezierHandle }
    return next
  })
  useProject.getState().setKeyframes(shot.id, kfs)
}

// ---------------------------------------------------------------------------
// Shot trim bounds
// ---------------------------------------------------------------------------

function projectVideoOf(shot: Shot, videos: ProjectVideo[]): ProjectVideo | null {
  return shot.video ? (videos.find((v) => v.id === shot.video!.videoId) ?? null) : null
}

/** Allowed duration range when right-trimming (end handle). */
export function rightTrimRange(shot: Shot, scenes: Shot[], videos: ProjectVideo[]): { min: number; max: number } {
  let max = Math.min(MAX_SHOT_DURATION, MAX_PROJECT_DURATION - shot.startTime)
  // don't run a media shot into the next media shot — cards float freely and
  // overlapping them is how compositing/covering is expressed
  if (!shot.kind) {
    for (const s of scenes) {
      if (s.id === shot.id || s.kind) continue
      if (s.startTime >= shot.startTime + shot.duration - 1e-6) {
        max = Math.min(max, s.startTime - shot.startTime)
      }
    }
  }
  const pv = projectVideoOf(shot, videos)
  if (shot.video && !shot.video.loop) {
    const speed = shot.video.speed > 0 ? shot.video.speed : 1
    const srcEnd = pv ? pv.durationSeconds : shot.video.trim.sourceOut
    max = Math.min(max, Math.max(MIN_SHOT_DURATION, (srcEnd - shot.video.trim.sourceIn) / speed))
  }
  return { min: MIN_SHOT_DURATION, max: Math.max(MIN_SHOT_DURATION, max) }
}

/** Allowed duration range when left-trimming (start handle, fromStart). */
export function leftTrimRange(shot: Shot, scenes: Shot[]): { min: number; max: number } {
  const end = shot.startTime + shot.duration
  let prevEnd = 0
  if (!shot.kind) {
    // media only backs into other media — cards float freely
    for (const s of scenes) {
      if (s.id === shot.id || s.kind) continue
      const e = s.startTime + s.duration
      if (e <= shot.startTime + 1e-6 && e > prevEnd) prevEnd = e
    }
  }
  let max = Math.min(MAX_SHOT_DURATION, end - prevEnd)
  if (shot.video && !shot.video.loop) {
    const speed = shot.video.speed > 0 ? shot.video.speed : 1
    // left extension limited by sourceIn headroom
    max = Math.min(max, shot.duration + shot.video.trim.sourceIn / speed)
  }
  return { min: MIN_SHOT_DURATION, max: Math.max(MIN_SHOT_DURATION, max) }
}
