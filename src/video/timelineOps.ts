/**
 * Pure functions over the timeline model (no store, no three.js).
 * Time units: shot times in seconds; keyframe `t` normalized 0..1 per shot.
 */

import {
  ANIMATABLE_PROPS,
  ANIMATABLE_SET,
  CAMERA_PROPS,
  MAX_PROJECT_DURATION,
  MAX_SHOT_DURATION,
  MIN_KF_SEPARATION,
  MIN_SHOT_DURATION,
  SAMPLE_DEFAULTS,
  type AnimatableProp,
  type Keyframe,
  type RenderState,
  type Shot,
  type Transition,
} from '../state/types'
import { evalBezier, segmentBezier, splitBezier, NEW_KF_IN, NEW_KF_OUT } from './easing'
import { keyframeId } from '../lib/ids'

/** Props keyed by a keyframe (legacy keyframes without `props` key all camera props). */
export function propsOf(kf: Keyframe): readonly AnimatableProp[] {
  if (!kf.props) return CAMERA_PROPS
  return kf.props.filter((p) => ANIMATABLE_SET.has(p))
}

export function keyframesForProp(kfs: Keyframe[], prop: AnimatableProp): Keyframe[] {
  return kfs.filter((k) => propsOf(k).includes(prop)).sort((a, b) => a.t - b.t)
}

/** Does the shot animate the camera pose at all? */
export function hasCameraKeyframes(shot: Shot): boolean {
  return shot.keyframes.some((k) => propsOf(k).some((p) => (CAMERA_PROPS as readonly string[]).includes(p)))
}

/** Props that appear in any keyframe of the shot (for property lanes). */
export function animatedProps(shot: Shot): AnimatableProp[] {
  const set = new Set<AnimatableProp>()
  for (const k of shot.keyframes) for (const p of propsOf(k)) set.add(p)
  return ANIMATABLE_PROPS.filter((p) => set.has(p))
}

function valueOf(kf: Keyframe, prop: AnimatableProp): number {
  const v = kf.state?.[prop]
  return typeof v === 'number' && Number.isFinite(v) ? v : SAMPLE_DEFAULTS[prop]
}

/** Sample one property at normalized time t. Returns null with no keys. */
export function sampleProp(kfs: Keyframe[], prop: AnimatableProp, t: number): number | null {
  const list = keyframesForProp(kfs, prop)
  if (list.length === 0) return null
  if (t <= list[0].t) return valueOf(list[0], prop)
  const last = list[list.length - 1]
  if (t >= last.t) return valueOf(last, prop)
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const f = span > 1e-9 ? (t - a.t) / span : 1
      const y = evalBezier(segmentBezier(a, b), f)
      const va = valueOf(a, prop)
      return va + (valueOf(b, prop) - va) * y
    }
  }
  return valueOf(last, prop)
}

/** Full state at normalized t: baseState (or first kf state) + sampled animatables. */
export function sampleShotState(shot: Shot, t: number): RenderState | null {
  const base = shot.baseState ?? shot.keyframes[0]?.state ?? null
  if (!base) return null
  const out: RenderState = { ...base, deviceFeatures: { ...base.deviceFeatures } }
  for (const prop of ANIMATABLE_PROPS) {
    const v = sampleProp(shot.keyframes, prop, t)
    if (v !== null) (out as unknown as Record<string, number>)[prop] = v
  }
  return out
}

/** Minimum separation between keys of a shot, in normalized units (50ms real). */
export function minKfGap(shot: Shot): number {
  return shot.duration > 0 ? Math.min(0.05 / shot.duration, MIN_KF_SEPARATION) || MIN_KF_SEPARATION : MIN_KF_SEPARATION
}

/** Drag bounds for keyframes (may extend past the shot within the project cap). */
export function kfMaxT(shot: Shot): number {
  return Math.max(1, (MAX_PROJECT_DURATION - shot.startTime) / shot.duration)
}
export function kfMinT(shot: Shot): number {
  return Math.min(0, -shot.startTime / shot.duration)
}

function stripPropsNear(kfs: Keyframe[], t: number, props: readonly AnimatableProp[], eps = MIN_KF_SEPARATION): Keyframe[] {
  const out: Keyframe[] = []
  for (const k of kfs) {
    if (Math.abs(k.t - t) > eps) {
      out.push(k)
      continue
    }
    const remaining = propsOf(k).filter((p) => !props.includes(p))
    if (remaining.length === 0) continue
    out.push({ ...k, props: [...remaining] })
  }
  return out
}

/** Insert a keyframe keying `props` at t (strips those props from neighbors within eps). */
export function addKeyframeAt(
  kfs: Keyframe[],
  t: number,
  state: RenderState,
  props?: AnimatableProp[],
): Keyframe[] {
  const keyed = props ?? [...CAMERA_PROPS]
  const cleaned = stripPropsNear(kfs, t, keyed)
  const kf: Keyframe = { id: keyframeId(), t, state, props: props ? [...props] : undefined, outEasing: [...NEW_KF_OUT], inEasing: [...NEW_KF_IN] }
  return [...cleaned, kf].sort((a, b) => a.t - b.t)
}

/**
 * Upsert a single property key at t: if a keyframe keying `prop` exists within
 * eps, update its state value; else append a new single-prop keyframe seeded
 * from `seedState`.
 */
export function upsertPropKeyframe(
  kfs: Keyframe[],
  prop: AnimatableProp,
  t: number,
  value: number,
  seedState: RenderState,
): Keyframe[] {
  const idx = kfs.findIndex((k) => propsOf(k).includes(prop) && Math.abs(k.t - t) <= MIN_KF_SEPARATION)
  if (idx >= 0) {
    const next = [...kfs]
    const k = next[idx]
    next[idx] = { ...k, state: { ...k.state, [prop]: value } }
    return next
  }
  const kf: Keyframe = {
    id: keyframeId(),
    t,
    state: { ...seedState, [prop]: value },
    props: [prop],
    outEasing: [...NEW_KF_OUT],
    inEasing: [...NEW_KF_IN],
  }
  return [...kfs, kf].sort((a, b) => a.t - b.t)
}

/** Remove one property's key near t (drops the keyframe if it was the last prop). */
export function removePropKeyframeAt(kfs: Keyframe[], prop: AnimatableProp, t: number): Keyframe[] {
  return stripPropsNear(kfs, t, [prop])
}

/** Remove a property from every keyframe (delete track). */
export function deleteTrack(kfs: Keyframe[], prop: AnimatableProp): Keyframe[] {
  const out: Keyframe[] = []
  for (const k of kfs) {
    const remaining = propsOf(k).filter((p) => p !== prop)
    if (remaining.length === 0) continue
    out.push({ ...k, props: [...remaining] })
  }
  return out
}

const KF_T_CLAMP = MAX_SHOT_DURATION / MIN_SHOT_DURATION // ±1800

/** Rescale keyframe times when a shot's duration changes (offset trims from the left). */
export function rescaleKeyframes(kfs: Keyframe[], oldDur: number, newDur: number, offsetSec = 0): Keyframe[] {
  if (newDur <= 0) return kfs
  return kfs.map((k) => {
    let t = (k.t * oldDur - offsetSec) / newDur
    if (k.t >= 0 && k.t <= 1) t = Math.min(1, Math.max(0, t))
    else t = Math.min(KF_T_CLAMP, Math.max(-KF_T_CLAMP, t))
    return { ...k, t }
  })
}

/** Reverse a shot's animation (t -> 1-t, easing handles mirrored). */
export function reverseKeyframes(kfs: Keyframe[]): Keyframe[] {
  return kfs
    .map((k) => ({
      ...k,
      t: 1 - k.t,
      outEasing: k.inEasing ? ([1 - k.inEasing[0], 1 - k.inEasing[1]] as [number, number]) : undefined,
      inEasing: k.outEasing ? ([1 - k.outEasing[0], 1 - k.outEasing[1]] as [number, number]) : undefined,
    }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Split a shot at `fraction` into two shots. Inserts boundary keyframes for
 * every property spanning the cut using bezier subdivision.
 */
export function splitShot(shot: Shot, fraction: number): { left: Shot; right: Shot } | null {
  if (shot.kind) return null
  const leftDur = shot.duration * fraction
  const rightDur = shot.duration - leftDur
  if (leftDur < MIN_SHOT_DURATION || rightDur < MIN_SHOT_DURATION) return null

  let kfs = [...shot.keyframes]
  const cut = fraction
  for (const prop of ANIMATABLE_PROPS) {
    const list = keyframesForProp(kfs, prop)
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (a.t < cut && b.t > cut) {
        const f = (cut - a.t) / (b.t - a.t)
        const { left, right } = splitBezier(segmentBezier(a, b), f)
        const v = sampleProp(kfs, prop, cut)!
        // skip boundary keys hugging the cut
        if (cut - a.t > MIN_KF_SEPARATION && b.t - cut > MIN_KF_SEPARATION) {
          const base = a.state
          const leftKf: Keyframe = {
            id: keyframeId(),
            t: cut - 1e-6,
            state: { ...base, [prop]: v },
            props: [prop],
            inEasing: left.p2,
            outEasing: [...NEW_KF_OUT],
          }
          const rightKf: Keyframe = {
            id: keyframeId(),
            t: cut + 1e-6,
            state: { ...base, [prop]: v },
            props: [prop],
            outEasing: right.p1,
            inEasing: [...NEW_KF_IN],
          }
          kfs.push(leftKf, rightKf)
        }
        break
      }
    }
  }
  kfs = kfs.sort((x, y) => x.t - y.t)

  const leftKfs = rescaleKeyframes(kfs.filter((k) => k.t <= cut), shot.duration, leftDur, 0)
  const rightKfs = rescaleKeyframes(kfs.filter((k) => k.t > cut), shot.duration, rightDur, leftDur)

  const left: Shot = { ...shot, duration: leftDur, keyframes: leftKfs, transitionOut: { kind: 'cut' } }
  const right: Shot = {
    ...shot,
    id: keyframeId().replace('kf', 'scene'),
    startTime: shot.startTime + leftDur,
    duration: rightDur,
    keyframes: rightKfs,
  }
  if (shot.video) {
    const l = shot.video
    const splitSrc = l.trim.sourceIn + leftDur * l.speed
    left.video = { ...l, trim: { sourceIn: l.trim.sourceIn, sourceOut: splitSrc } }
    right.video = { ...l, trim: { sourceIn: splitSrc, sourceOut: l.trim.sourceOut } }
  }
  return { left, right }
}

// ---------------------------------------------------------------------------
// Sequence math
// ---------------------------------------------------------------------------

export function totalDuration(scenes: Shot[]): number {
  return scenes.reduce((m, s) => Math.max(m, s.startTime + s.duration), 0)
}

export function remainingDuration(scenes: Shot[]): number {
  return Math.max(0, MAX_PROJECT_DURATION - scenes.reduce((sum, s) => sum + s.duration, 0))
}

export function canvasLength(scenes: Shot[], sequenceDuration: number): number {
  const total = totalDuration(scenes)
  return Math.max(Math.min(MAX_PROJECT_DURATION, sequenceDuration), total)
}

/**
 * A text/logo shot with a transparent background is an *overlay*: it floats
 * freely on the timeline (excluded from sequence packing) and composites over
 * whatever plays beneath it instead of covering the frame.
 */
export function isOverlayShot(s: Shot): boolean {
  if (s.kind === 'text') return s.text?.bg.kind === 'transparent'
  if (s.kind === 'logo') return !!s.logo?.transparentBg
  return false
}

export interface FrameLayer {
  sceneIndex: number
  localT: number
}

export interface FrameStack {
  /** bottom-most visible layer: a media/mockup shot or an opaque text/logo card */
  floor: FrameLayer | null
  /** true when the floor is a media/mockup shot rendered by the engine */
  floorIsEngine: boolean
  /** transparent text/logo layers above the floor, in paint order (bottom → top) */
  overlays: FrameLayer[]
}

const EMPTY_STACK: FrameStack = { floor: null, floorIsEngine: false, overlays: [] }

/**
 * Everything visible at project time `pt`.
 *
 * Floor: an active opaque text/logo card wins over an active media shot (an
 * opaque card overlapping a mockup only ever means "cover it"); among the
 * same class the topmost row (scenes array order, row 0 first) wins.
 * Overlays: every active transparent card renders above the floor — timeline
 * row order decides only how overlays stack among themselves.
 * Past the end of the timeline, the final frame is held.
 */
export function frameStackAtTime(scenes: Shot[], pt: number): FrameStack {
  if (scenes.length === 0) return EMPTY_STACK
  const overlaysTopDown: FrameLayer[] = []
  let cardFloor: FrameLayer | null = null
  let mediaFloor: FrameLayer | null = null
  let anyActive = false
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]
    if (pt < s.startTime || pt >= s.startTime + s.duration) continue
    anyActive = true
    const layer = { sceneIndex: i, localT: (pt - s.startTime) / s.duration }
    if (isOverlayShot(s)) {
      overlaysTopDown.push(layer)
      continue
    }
    if (s.kind) cardFloor ??= layer
    else mediaFloor ??= layer
  }
  if (!anyActive) {
    // hold the final frame past the end (mirrors sceneAtTime's tail behavior)
    const lastEnd = scenes.reduce((m, s) => Math.max(m, s.startTime + s.duration), 0)
    if (pt >= lastEnd && lastEnd > 0) return frameStackAtTime(scenes, Math.max(0, lastEnd - 1e-4))
    return EMPTY_STACK
  }
  const floor = cardFloor ?? mediaFloor
  return {
    floor,
    floorIsEngine: !!floor && !scenes[floor.sceneIndex].kind,
    overlays: overlaysTopDown.reverse(),
  }
}

/** Which scene plays at project time pt. In a gap → index -1. Past end → last scene at t=1. */
export function sceneAtTime(scenes: Shot[], pt: number): { sceneIndex: number; localT: number } {
  if (scenes.length === 0) return { sceneIndex: -1, localT: 0 }
  let lastEndIdx = -1
  let lastEnd = -Infinity
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]
    if (pt >= s.startTime && pt < s.startTime + s.duration) {
      return { sceneIndex: i, localT: (pt - s.startTime) / s.duration }
    }
    const end = s.startTime + s.duration
    if (end > lastEnd) {
      lastEnd = end
      lastEndIdx = i
    }
  }
  if (pt >= lastEnd) return { sceneIndex: lastEndIdx, localT: 1 }
  return { sceneIndex: -1, localT: 0 }
}

/**
 * Cross-shot fade opacity at (sceneIndex, localT). A fade of durationMs spends
 * half on each side of the cut. Neighbor fades use time-adjacency within the
 * main (non-overlay) sequence — row order no longer implies time order.
 * Project fadeIn/fadeOut apply at the timeline's absolute head / tail to every
 * layer, so overlays fade with the frame instead of popping.
 */
export function transitionOpacity(
  scenes: Shot[],
  sceneIndex: number,
  localT: number,
  project: { fadeIn: Transition; fadeOut: Transition },
): number {
  const s = scenes[sceneIndex]
  if (!s) return 1
  const tSec = localT * s.duration
  const remaining = s.duration - tSec
  let opacity = 1
  const apply = (edgeTime: number, tr: Transition) => {
    if (tr.kind !== 'fade') return
    const half = tr.durationMs / 2000
    if (half > 0) opacity = Math.min(opacity, Math.max(0, Math.min(1, edgeTime / half)))
  }
  if (!isOverlayShot(s)) {
    // fade in from the time-adjacent predecessor's transitionOut
    const prev = scenes.find(
      (x) => x !== s && !isOverlayShot(x) && Math.abs(x.startTime + x.duration - s.startTime) < 1e-4,
    )
    if (prev) apply(tSec, prev.transitionOut)
    // own tail fade always plays — whether something follows, an overlay
    // covers the cut, or the shot simply ends into a gap
    apply(remaining, s.transitionOut)
  }
  // project-level head/tail fades, measured in absolute project time
  const pt = s.startTime + tSec
  const totalEnd = totalDuration(scenes)
  apply(pt, project.fadeIn)
  apply(totalEnd - pt, project.fadeOut)
  return opacity
}

/**
 * Re-sequence the main sequence back-to-back from t=0 preserving order.
 * Overlay shots float freely and keep their own placement.
 */
export function resequence(scenes: Shot[]): Shot[] {
  let t = 0
  return scenes.map((s) => {
    if (isOverlayShot(s)) return s
    const out = { ...s, startTime: t }
    t += s.duration
    return out
  })
}

/**
 * Push overlapping media scenes right, keep intentional gaps. Text/logo cards
 * float freely — dropping one over another shot is how compositing/covering
 * is expressed, so they are never pushed.
 */
export function normalizeOrder(scenes: Shot[]): Shot[] {
  const sorted = [...scenes].sort((a, b) => a.startTime - b.startTime)
  let cursor = 0
  const moved = new Map<string, number>()
  for (const s of sorted) {
    if (s.kind) continue
    const start = Math.max(s.startTime, cursor)
    cursor = start + s.duration
    if (start !== s.startTime) moved.set(s.id, start)
  }
  if (moved.size === 0) return scenes
  return scenes.map((s) => (moved.has(s.id) ? { ...s, startTime: moved.get(s.id)! } : s))
}

/** Close the gap at time t by shifting all later scenes left (overlays shift along). */
export function closeGapAt(scenes: Shot[], t: number): Shot[] {
  const sorted = [...scenes].sort((a, b) => a.startTime - b.startTime)
  let gapStart = 0
  let gapLen = 0
  let cursor = 0
  for (const s of sorted) {
    if (isOverlayShot(s)) continue // overlays float — they don't cover gaps
    if (s.startTime > cursor + 1e-4 && t >= cursor && t <= s.startTime) {
      gapStart = cursor
      gapLen = s.startTime - cursor
      break
    }
    cursor = Math.max(cursor, s.startTime + s.duration)
  }
  if (gapLen <= 0) return scenes
  return scenes.map((s) => (s.startTime >= gapStart + gapLen - 1e-6 ? { ...s, startTime: s.startTime - gapLen } : s))
}

/** Gaps between shots (for ruler gap bands). */
export function findGaps(scenes: Shot[]): { start: number; end: number; beforeName: string; afterName: string }[] {
  const sorted = [...scenes].sort((a, b) => a.startTime - b.startTime)
  const gaps: { start: number; end: number; beforeName: string; afterName: string }[] = []
  let cursor = 0
  let prevName = ''
  for (const s of sorted) {
    if (isOverlayShot(s)) continue // gaps are a main-sequence concept
    if (s.startTime > cursor + 1e-4 && prevName) {
      gaps.push({ start: cursor, end: s.startTime, beforeName: prevName, afterName: s.name })
    }
    cursor = Math.max(cursor, s.startTime + s.duration)
    prevName = s.name
  }
  return gaps
}
