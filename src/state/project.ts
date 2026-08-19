/**
 * The project store: live control state ("dials"), the timeline document,
 * selection, undo/redo, and local persistence.
 *
 * Semantics:
 * - `dials` is the editable state of the SELECTED shot. Committing an edit
 *   refreshes the shot's baseState; non-animatable fields propagate project-wide
 *   (to every shot's baseState and every keyframe snapshot) so scene/device/
 *   effect settings act globally while camera/blur moves stay per-shot.
 */

import { create } from 'zustand'
import {
  ANIMATABLE_SET,
  DEFAULT_RENDER_STATE,
  DEFAULT_SEQUENCE_DURATION,
  DEFAULT_SHOT_DURATION,
  DEFAULT_TEXT_SHOT_DURATION,
  MAX_PROJECT_DURATION,
  MAX_SCENES,
  MAX_SHOT_DURATION,
  MIN_SHOT_DURATION,
  type AnimatableProp,
  type AudioClip,
  type ImageExportOptions,
  type Keyframe,
  type LogoStyle,
  type Project,
  type ProjectAudio,
  type ProjectVideo,
  type RenderState,
  type Shot,
  type TextStyle,
  type Transition,
  type VideoExportOptions,
} from './types'
import { sceneId } from '../lib/ids'
import {
  addKeyframeAt,
  closeGapAt,
  deleteTrack,
  normalizeOrder,
  propsOf,
  removePropKeyframeAt,
  rescaleKeyframes,
  resequence,
  reverseKeyframes,
  sampleProp,
  splitShot,
  upsertPropKeyframe,
  remainingDuration,
} from '../video/timelineOps'
import { defaultFinish, deviceLightingDefaults } from '../three/devices/registry'

export const APP_VERSION = '1.0.0'
const STORAGE_KEY = 'openmock-project'

// ---------------------------------------------------------------------------

export interface HistoryEntry {
  dials: RenderState
  scenes: Shot[]
  sequenceDuration: number
  fadeIn: Transition
  fadeOut: Transition
  audioClips: AudioClip[]
  videos: ProjectVideo[]
  audios: ProjectAudio[]
  selectedSceneId: string | null
}

export interface DialCommitOptions {
  /** don't create a history entry (mid-drag) */
  transient?: boolean
  /** internal/system write — recorder must ignore it */
  system?: boolean
}

interface ProjectStore {
  // live control state
  dials: RenderState

  // document
  scenes: Shot[]
  sequenceDuration: number
  fadeIn: Transition
  fadeOut: Transition
  exportOptions: VideoExportOptions
  imageExportOptions: ImageExportOptions
  audioClips: AudioClip[]
  videos: ProjectVideo[]
  audios: ProjectAudio[]

  selectedSceneId: string | null

  /** bumped on every user-originated dial commit (recorder subscribes) */
  dialEditSeq: number
  lastDialEdit: { changed: (keyof RenderState)[]; system: boolean } | null

  // actions ------------------------------------------------------------
  setDials(patch: Partial<RenderState>, opts?: DialCommitOptions): void
  selectScene(id: string | null): void
  selectDevice(modelId: string): void

  addScene(): Shot | null
  addTextScene(): Shot | null
  addLogoScene(): Shot | null
  duplicateScene(id: string): Shot | null
  deleteScenes(ids: string[]): void
  renameScene(id: string, name: string): void
  updateShot(id: string, patch: Partial<Shot>): void
  setSceneTransition(id: string, tr: Transition): void
  setSceneDuration(id: string, duration: number, opts?: { fromStart?: boolean }): void
  setSceneStartTime(id: string, startTime: number): void
  reorderSceneTo(id: string, index: number): void
  closeGap(t: number): void
  resequenceScenes(): void
  splitSceneAt(id: string, fraction: number): boolean
  reverseScene(id: string): void
  setSequenceDuration(v: number): void
  setFades(fadeIn: Transition, fadeOut: Transition): void
  setExportOptions(patch: Partial<VideoExportOptions>): void
  setImageExportOptions(patch: Partial<ImageExportOptions>): void

  // keyframes ----------------------------------------------------------
  addKeyframe(shotId: string, t: number, props?: AnimatableProp[], state?: RenderState): void
  recordPropKeyframe(shotId: string, prop: AnimatableProp, t: number, value: number): void
  togglePropKeyframe(shotId: string, prop: AnimatableProp, t: number): void
  removePropKeyframe(shotId: string, prop: AnimatableProp, t: number): void
  deletePropTrack(shotId: string, prop: AnimatableProp): void
  deleteKeyframes(shotId: string, kfIds: string[]): void
  setKeyframes(shotId: string, kfs: Keyframe[]): void
  setSegmentEasing(shotId: string, startId: string, p1: [number, number], p2: [number, number], endId?: string): void
  applyAnimationPreset(shotId: string, presetId: string): void

  // media --------------------------------------------------------------
  addProjectVideo(v: ProjectVideo): void
  removeProjectVideo(id: string): void
  addProjectAudio(a: ProjectAudio): void
  removeProjectAudio(id: string): void
  setAudioClips(clips: AudioClip[]): void

  // history ------------------------------------------------------------
  canUndo(): boolean
  canRedo(): boolean
  undo(): void
  redo(): void

  // persistence --------------------------------------------------------
  hydrate(): void
  resetProject(): void
}

// history kept outside react state for performance
const history: { past: HistoryEntry[]; future: HistoryEntry[] } = { past: [], future: [] }
let batchTimer: ReturnType<typeof setTimeout> | null = null
let batchBase: HistoryEntry | null = null

function snapshot(s: ProjectStore): HistoryEntry {
  return {
    dials: s.dials,
    scenes: s.scenes,
    sequenceDuration: s.sequenceDuration,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    audioClips: s.audioClips,
    videos: s.videos,
    audios: s.audios,
    selectedSceneId: s.selectedSceneId,
  }
}

function pushHistory(s: ProjectStore): void {
  // batch rapid commits (drags) into one entry per 80ms window
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = setTimeout(() => {
      batchTimer = null
      batchBase = null
    }, 80)
    return
  }
  batchBase = snapshot(s)
  history.past.push(batchBase)
  if (history.past.length > 50) history.past.shift()
  history.future = []
  batchTimer = setTimeout(() => {
    batchTimer = null
    batchBase = null
  }, 80)
}

function makeShot(name: string, startTime: number, duration: number, baseState: RenderState | null): Shot {
  return {
    id: sceneId(),
    name,
    startTime,
    duration,
    baseState,
    keyframes: [],
    transitionOut: { kind: 'cut' },
  }
}

const DEFAULT_TEXT: TextStyle = {
  content: 'Your text here',
  font: { family: 'inter', weight: 600, size: 6, align: 'center', letterSpacing: 0 },
  color: '#ffffff',
  bg: { kind: 'color', color: '#0a0a0a' },
  enter: { effect: 'soft-blur', speed: 0.5, per: 'line' },
  exit: { effect: 'soft-blur', speed: 0.5, per: 'line' },
}

const DEFAULT_LOGO: LogoStyle = {
  shader: 'none',
  shape: 'metaballs',
  bgColor: '#0a0a0a',
  theme: 'Gold',
  colors: ['#ffd24a', '#e6b85c', '#fff3a0', '#a87a2e'],
  speed: 1,
  scale: 3.5,
  param1: 0.8,
  param2: 0.5,
  imageUrl: null,
  svgSource: null,
  svgColor: '#000000',
  effects: { bloom: false, bloomStrength: 1, bloomThreshold: 0.35, bloomRadius: 0.5, grain: 0, caStrength: 0, pixelGrid: 0 },
  enter: { effect: 'fade', duration: 0.4 },
  exit: { effect: 'fade', duration: 0.4 },
}

/** luminance-based contrast color for text over a background */
export function contrastColor(bgHex: string): string {
  let h = bgHex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  const luma = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return luma > 0.55 ? '#0a0a0a' : '#ffffff'
}

/**
 * Non-animatable fields that still stay per-shot: device-look toggles a user
 * sets for one shot (e.g. status bar off on a close-up) must not leak into
 * every other shot on the timeline.
 */
const PER_SHOT_FIELDS = new Set<keyof RenderState>(['statusBarEnabled', 'notchEnabled', 'deviceFeatures'])

function propagateGlobalFields(scenes: Shot[], changed: (keyof RenderState)[], dials: RenderState, selectedId: string | null): Shot[] {
  const globals = changed.filter((k) => !ANIMATABLE_SET.has(k) && !PER_SHOT_FIELDS.has(k))
  if (globals.length === 0) {
    // only refresh selected baseState
    return scenes.map((s) => (s.id === selectedId ? { ...s, baseState: dials } : s))
  }
  return scenes.map((s) => {
    const patchState = (st: RenderState): RenderState => {
      const out = { ...st }
      for (const k of globals) {
        ;(out as unknown as Record<string, unknown>)[k] = dials[k]
      }
      return out
    }
    if (s.id === selectedId) {
      return { ...s, baseState: dials, keyframes: s.keyframes.map((k) => ({ ...k, state: patchState(k.state) })) }
    }
    return {
      ...s,
      baseState: s.baseState ? patchState(s.baseState) : s.baseState,
      keyframes: s.keyframes.map((k) => ({ ...k, state: patchState(k.state) })),
    }
  })
}

export const useProject = create<ProjectStore>((set, get) => ({
  dials: { ...DEFAULT_RENDER_STATE },
  scenes: [],
  sequenceDuration: DEFAULT_SEQUENCE_DURATION,
  fadeIn: { kind: 'cut' },
  fadeOut: { kind: 'cut' },
  exportOptions: { size: '1080p', customWidth: 1920, customHeight: 1080, quality: 'high', fps: 60, motionBlur: 'off' },
  imageExportOptions: { format: 'jpeg', size: '1080p', customWidth: 1920, customHeight: 1080, transparent: false },
  audioClips: [],
  videos: [],
  audios: [],
  selectedSceneId: null,
  dialEditSeq: 0,
  lastDialEdit: null,

  setDials(patch, opts = {}) {
    const s = get()
    const changed = (Object.keys(patch) as (keyof RenderState)[]).filter((k) => s.dials[k] !== patch[k])
    if (changed.length === 0) return
    if (!opts.transient) pushHistory(s)
    const dials = { ...s.dials, ...patch }
    const scenes = opts.transient ? s.scenes : propagateGlobalFields(s.scenes, changed, dials, s.selectedSceneId)
    set({
      dials,
      scenes,
      dialEditSeq: s.dialEditSeq + 1,
      lastDialEdit: { changed, system: !!opts.system },
    })
    scheduleSave()
  },

  selectScene(id) {
    const s = get()
    if (id === s.selectedSceneId) return
    const shot = s.scenes.find((x) => x.id === id)
    const dials = shot?.baseState ? { ...shot.baseState } : s.dials
    set({ selectedSceneId: id, dials, dialEditSeq: s.dialEditSeq + 1, lastDialEdit: { changed: [], system: true } })
  },

  selectDevice(modelId) {
    const s = get()
    const lighting = deviceLightingDefaults(modelId)
    const patch: Partial<RenderState> = {
      mockupModel: modelId,
      deviceFinish: defaultFinish(modelId),
      ...lighting,
    }
    // first device selection creates the first shot
    if (s.scenes.length === 0) {
      pushHistory(s)
      const dials = { ...s.dials, ...patch }
      const shot = makeShot('Shot 1', 0, DEFAULT_SHOT_DURATION, dials)
      set({ dials, scenes: [shot], selectedSceneId: shot.id, dialEditSeq: s.dialEditSeq + 1, lastDialEdit: { changed: Object.keys(patch) as (keyof RenderState)[], system: true } })
      scheduleSave()
      return
    }
    get().setDials(patch, { system: true })
  },

  addScene() {
    const s = get()
    if (s.scenes.length >= MAX_SCENES) return null
    const remaining = remainingDuration(s.scenes)
    if (remaining < MIN_SHOT_DURATION) return null
    pushHistory(s)
    const src = s.scenes.find((x) => x.id === s.selectedSceneId) ?? s.scenes[s.scenes.length - 1]
    const start = s.scenes.reduce((m, x) => Math.max(m, x.startTime + x.duration), 0)
    const shot = makeShot(`Shot ${s.scenes.length + 1}`, start, Math.min(remaining, DEFAULT_SHOT_DURATION), src?.baseState ?? s.dials)
    if (src?.video) {
      const vid = s.videos.find((v) => v.id === src.video!.videoId)
      if (vid) shot.video = { videoId: vid.id, trim: { sourceIn: 0, sourceOut: vid.durationSeconds }, speed: 1, loop: true }
    }
    if (src?.imageKey) shot.imageKey = src.imageKey
    set({ scenes: [...s.scenes, shot], selectedSceneId: shot.id, dials: shot.baseState ? { ...shot.baseState } : s.dials })
    scheduleSave()
    return shot
  },

  addTextScene() {
    const s = get()
    if (s.scenes.length >= MAX_SCENES) return null
    const remaining = remainingDuration(s.scenes)
    if (remaining < MIN_SHOT_DURATION) return null
    pushHistory(s)
    const idx = s.scenes.findIndex((x) => x.id === s.selectedSceneId)
    const n = s.scenes.filter((x) => x.kind === 'text').length + 1
    const bgColor = s.dials.bgColor
    const shot: Shot = {
      ...makeShot(`Text ${n}`, 0, Math.min(remaining, DEFAULT_TEXT_SHOT_DURATION), null),
      kind: 'text',
      text: { ...DEFAULT_TEXT, bg: { kind: 'color', color: bgColor }, color: contrastColor(bgColor) },
    }
    const scenes = [...s.scenes]
    scenes.splice(idx >= 0 ? idx + 1 : scenes.length, 0, shot)
    set({ scenes: resequence(scenes), selectedSceneId: shot.id })
    scheduleSave()
    return shot
  },

  addLogoScene() {
    const s = get()
    if (s.scenes.length >= MAX_SCENES) return null
    const remaining = remainingDuration(s.scenes)
    if (remaining < MIN_SHOT_DURATION) return null
    pushHistory(s)
    const idx = s.scenes.findIndex((x) => x.id === s.selectedSceneId)
    const n = s.scenes.filter((x) => x.kind === 'logo').length + 1
    const shot: Shot = {
      ...makeShot(`Logo ${n}`, 0, Math.min(remaining, DEFAULT_TEXT_SHOT_DURATION), null),
      kind: 'logo',
      logo: { ...DEFAULT_LOGO, bgColor: s.dials.bgColor },
    }
    const scenes = [...s.scenes]
    scenes.splice(idx >= 0 ? idx + 1 : scenes.length, 0, shot)
    set({ scenes: resequence(scenes), selectedSceneId: shot.id })
    scheduleSave()
    return shot
  },

  duplicateScene(id) {
    const s = get()
    if (s.scenes.length >= MAX_SCENES) return null
    const src = s.scenes.find((x) => x.id === id)
    if (!src) return null
    if (remainingDuration(s.scenes) < src.duration) return null
    pushHistory(s)
    const idx = s.scenes.indexOf(src)
    const copy: Shot = {
      ...structuredClone(src),
      id: sceneId(),
      name: `${src.name} copy`,
      keyframes: src.keyframes.map((k) => ({ ...structuredClone(k), id: k.id.replace(/^kf-.*/, '') || k.id })),
    }
    copy.keyframes = copy.keyframes.map((k) => ({ ...k, id: sceneId().replace('scene', 'kf') }))
    const scenes = [...s.scenes]
    scenes.splice(idx + 1, 0, copy)
    set({ scenes: resequence(scenes), selectedSceneId: copy.id })
    scheduleSave()
    return copy
  },

  deleteScenes(ids) {
    const s = get()
    pushHistory(s)
    const scenes = s.scenes.filter((x) => !ids.includes(x.id))
    const selected = ids.includes(s.selectedSceneId ?? '') ? (scenes[0]?.id ?? null) : s.selectedSceneId
    set({ scenes, selectedSceneId: selected })
    if (selected && selected !== s.selectedSceneId) get().selectScene(selected)
    scheduleSave()
  },

  renameScene(id, name) {
    const s = get()
    pushHistory(s)
    set({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, name: name.slice(0, 40) } : x)) })
    scheduleSave()
  },

  updateShot(id, patch) {
    const s = get()
    pushHistory(s)
    set({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
    scheduleSave()
  },

  setSceneTransition(id, tr) {
    get().updateShot(id, { transitionOut: tr })
  },

  setSceneDuration(id, duration, opts = {}) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === id)
    if (!shot) return
    const others = s.scenes.filter((x) => x.id !== id).reduce((sum, x) => sum + x.duration, 0)
    const dur = Math.min(Math.max(duration, MIN_SHOT_DURATION), Math.min(MAX_SHOT_DURATION, MAX_PROJECT_DURATION - others))
    if (Math.abs(dur - shot.duration) < 1e-6) return
    pushHistory(s)
    const offset = opts.fromStart ? shot.duration - dur : 0
    let video = shot.video
    if (video) {
      const sourceIn = opts.fromStart ? video.trim.sourceIn + offset * video.speed : video.trim.sourceIn
      video = { ...video, trim: { sourceIn, sourceOut: sourceIn + dur * video.speed } }
    }
    const updated: Shot = {
      ...shot,
      duration: dur,
      startTime: opts.fromStart ? shot.startTime + offset : shot.startTime,
      keyframes: rescaleKeyframes(shot.keyframes, shot.duration, dur, offset),
      video,
    }
    set({ scenes: s.scenes.map((x) => (x.id === id ? updated : x)) })
    scheduleSave()
  },

  setSceneStartTime(id, startTime) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === id)
    if (!shot) return
    pushHistory(s)
    const st = Math.min(Math.max(0, startTime), MAX_PROJECT_DURATION - shot.duration)
    set({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, startTime: st } : x)) })
    scheduleSave()
  },

  reorderSceneTo(id, index) {
    const s = get()
    const cur = s.scenes.findIndex((x) => x.id === id)
    if (cur < 0) return
    pushHistory(s)
    const scenes = [...s.scenes]
    const [shot] = scenes.splice(cur, 1)
    scenes.splice(Math.min(Math.max(0, index), scenes.length), 0, shot)
    set({ scenes: resequence(scenes) })
    scheduleSave()
  },

  closeGap(t) {
    const s = get()
    pushHistory(s)
    set({ scenes: closeGapAt(s.scenes, t) })
    scheduleSave()
  },

  resequenceScenes() {
    const s = get()
    pushHistory(s)
    set({ scenes: resequence(normalizeOrder(s.scenes)) })
    scheduleSave()
  },

  splitSceneAt(id, fraction) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === id)
    if (!shot) return false
    const parts = splitShot(shot, fraction)
    if (!parts) return false
    pushHistory(s)
    const idx = s.scenes.indexOf(shot)
    const scenes = [...s.scenes]
    scenes.splice(idx, 1, parts.left, parts.right)
    set({ scenes })
    scheduleSave()
    return true
  },

  reverseScene(id) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === id)
    if (!shot || shot.keyframes.length < 2) return
    pushHistory(s)
    set({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, keyframes: reverseKeyframes(x.keyframes) } : x)) })
    scheduleSave()
  },

  setSequenceDuration(v) {
    const s = get()
    pushHistory(s)
    set({ sequenceDuration: Math.min(MAX_PROJECT_DURATION, Math.max(0.1, v)) })
    scheduleSave()
  },

  setFades(fadeIn, fadeOut) {
    const s = get()
    pushHistory(s)
    set({ fadeIn, fadeOut })
    scheduleSave()
  },

  setExportOptions(patch) {
    set({ exportOptions: { ...get().exportOptions, ...patch } })
    scheduleSave()
  },

  setImageExportOptions(patch) {
    set({ imageExportOptions: { ...get().imageExportOptions, ...patch } })
    scheduleSave()
  },

  // -- keyframes ---------------------------------------------------------

  addKeyframe(shotId, t, props, state) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === shotId)
    if (!shot) return
    pushHistory(s)
    const snap = state ?? s.dials
    set({
      scenes: s.scenes.map((x) => (x.id === shotId ? { ...x, keyframes: addKeyframeAt(x.keyframes, t, snap, props) } : x)),
    })
    scheduleSave()
  },

  recordPropKeyframe(shotId, prop, t, value) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === shotId)
    if (!shot) return
    pushHistory(s)
    const seed = shot.keyframes[0]?.state ?? shot.baseState ?? s.dials
    set({
      scenes: s.scenes.map((x) =>
        x.id === shotId ? { ...x, keyframes: upsertPropKeyframe(x.keyframes, prop, t, value, seed) } : x,
      ),
    })
    scheduleSave()
  },

  togglePropKeyframe(shotId, prop, t) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === shotId)
    if (!shot) return
    const keyed = shot.keyframes.some((k) => propsOf(k).includes(prop) && Math.abs(k.t - t) <= 0.02)
    if (keyed) {
      get().removePropKeyframe(shotId, prop, t)
    } else {
      const value = (s.dials[prop] as number) ?? sampleProp(shot.keyframes, prop, t) ?? 0
      get().recordPropKeyframe(shotId, prop, t, value)
    }
  },

  removePropKeyframe(shotId, prop, t) {
    const s = get()
    pushHistory(s)
    set({
      scenes: s.scenes.map((x) => (x.id === shotId ? { ...x, keyframes: removePropKeyframeAt(x.keyframes, prop, t) } : x)),
    })
    scheduleSave()
  },

  deletePropTrack(shotId, prop) {
    const s = get()
    pushHistory(s)
    set({ scenes: s.scenes.map((x) => (x.id === shotId ? { ...x, keyframes: deleteTrack(x.keyframes, prop) } : x)) })
    scheduleSave()
  },

  deleteKeyframes(shotId, kfIds) {
    const s = get()
    pushHistory(s)
    set({
      scenes: s.scenes.map((x) =>
        x.id === shotId ? { ...x, keyframes: x.keyframes.filter((k) => !kfIds.includes(k.id)) } : x,
      ),
    })
    scheduleSave()
  },

  setKeyframes(shotId, kfs) {
    const s = get()
    pushHistory(s)
    set({ scenes: s.scenes.map((x) => (x.id === shotId ? { ...x, keyframes: [...kfs].sort((a, b) => a.t - b.t) } : x)) })
    scheduleSave()
  },

  setSegmentEasing(shotId, startId, p1, p2, endId) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === shotId)
    if (!shot) return
    pushHistory(s)
    const sorted = [...shot.keyframes].sort((a, b) => a.t - b.t)
    const si = sorted.findIndex((k) => k.id === startId)
    const end = endId ? sorted.find((k) => k.id === endId) : sorted[si + 1]
    const kfs = shot.keyframes.map((k) => {
      if (k.id === startId) return { ...k, outEasing: p1 }
      if (end && k.id === end.id) return { ...k, inEasing: p2 }
      return k
    })
    set({ scenes: s.scenes.map((x) => (x.id === shotId ? { ...x, keyframes: kfs } : x)) })
    scheduleSave()
  },

  applyAnimationPreset(shotId, presetId) {
    const s = get()
    const shot = s.scenes.find((x) => x.id === shotId)
    if (!shot) return
    // imported lazily to avoid a cycle at module init
    import('../lib/presets/animationPresets').then(({ CAMERA_ANIMATION_PRESETS }) => {
      const preset = CAMERA_ANIMATION_PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      const cur = get()
      const base = shot.baseState ?? cur.dials
      pushHistory(cur)
      const kfs: Keyframe[] = preset.kfSpecs.map((spec) => ({
        id: sceneId().replace('scene', 'kf'),
        t: spec.t,
        state: {
          ...base,
          tiltX: spec.tiltX,
          tiltY: spec.tiltY,
          tiltZ: spec.tiltZ,
          flap: spec.flap,
          flapX: spec.flapX,
          zoom: spec.zoom,
          fov: spec.fov,
          panX: spec.panX,
          panY: spec.panY,
        },
        props: ['tiltX', 'tiltY', 'tiltZ', 'flap', 'flapX', 'zoom', 'fov', 'panX', 'panY'],
        outEasing: [0, 0],
        inEasing: [1, 1],
      }))
      const scenes = cur.scenes.map((x) => {
        if (x.id !== shotId) return x
        const dur = cur.videos.length === 0 && preset.defaultDuration ? preset.defaultDuration : x.duration
        return { ...x, keyframes: kfs, duration: dur }
      })
      set({ scenes })
      scheduleSave()
    })
  },

  // -- media ---------------------------------------------------------------

  addProjectVideo(v) {
    const s = get()
    pushHistory(s)
    set({ videos: [...s.videos, v] })
    scheduleSave()
  },
  removeProjectVideo(id) {
    const s = get()
    pushHistory(s)
    set({
      videos: s.videos.filter((v) => v.id !== id),
      scenes: s.scenes.map((x) => (x.video?.videoId === id ? { ...x, video: undefined } : x)),
    })
    scheduleSave()
  },
  addProjectAudio(a) {
    const s = get()
    pushHistory(s)
    set({ audios: [...s.audios, a] })
    scheduleSave()
  },
  removeProjectAudio(id) {
    const s = get()
    pushHistory(s)
    set({
      audios: s.audios.filter((a) => a.id !== id),
      audioClips: s.audioClips.filter((c) => c.audioId !== id),
    })
    scheduleSave()
  },
  setAudioClips(clips) {
    const s = get()
    pushHistory(s)
    set({ audioClips: clips })
    scheduleSave()
  },

  // -- history ---------------------------------------------------------------

  canUndo: () => history.past.length > 0,
  canRedo: () => history.future.length > 0,

  undo() {
    const s = get()
    const prev = history.past.pop()
    if (!prev) return
    history.future.push(snapshot(s))
    set({ ...prev, dialEditSeq: s.dialEditSeq + 1, lastDialEdit: { changed: [], system: true } })
    scheduleSave()
  },

  redo() {
    const s = get()
    const next = history.future.pop()
    if (!next) return
    history.past.push(snapshot(s))
    set({ ...next, dialEditSeq: s.dialEditSeq + 1, lastDialEdit: { changed: [], system: true } })
    scheduleSave()
  },

  // -- persistence ------------------------------------------------------------

  hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const doc = JSON.parse(raw) as Project & { dials?: RenderState; selectedSceneId?: string | null }
      if (!doc || typeof doc !== 'object') return
      const scenes = (doc.timeline?.scenes ?? []).map((sc) => ({
        ...sc,
        duration: Math.min(MAX_SHOT_DURATION, Math.max(MIN_SHOT_DURATION, sc.duration || DEFAULT_SHOT_DURATION)),
        keyframes: sc.keyframes ?? [],
        transitionOut: sc.transitionOut ?? { kind: 'cut' as const },
      }))
      const first = scenes.find((x) => x.id === doc.selectedSceneId) ?? scenes[0]
      set({
        dials: doc.dials ? { ...DEFAULT_RENDER_STATE, ...doc.dials } : first?.baseState ? { ...DEFAULT_RENDER_STATE, ...first.baseState } : get().dials,
        scenes,
        sequenceDuration: doc.timeline?.sequenceDuration ?? DEFAULT_SEQUENCE_DURATION,
        fadeIn: doc.timeline?.fadeIn ?? { kind: 'cut' },
        fadeOut: doc.timeline?.fadeOut ?? { kind: 'cut' },
        exportOptions: { ...get().exportOptions, ...doc.timeline?.exportOptions },
        audioClips: doc.timeline?.audioClips ?? [],
        videos: doc.videos ?? [],
        audios: doc.audios ?? [],
        selectedSceneId: first?.id ?? null,
      })
    } catch (e) {
      console.warn('[openmock] failed to hydrate project', e)
    }
  },

  resetProject() {
    pushHistory(get())
    set({
      dials: { ...DEFAULT_RENDER_STATE },
      scenes: [],
      sequenceDuration: DEFAULT_SEQUENCE_DURATION,
      fadeIn: { kind: 'cut' },
      fadeOut: { kind: 'cut' },
      audioClips: [],
      videos: [],
      audios: [],
      selectedSceneId: null,
    })
    scheduleSave()
  },
}))

// -- autosave -----------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const s = useProject.getState()
    const doc = {
      schemaVersion: 1,
      openmockVersion: APP_VERSION,
      dials: s.dials,
      selectedSceneId: s.selectedSceneId,
      viewportRatio: localStorage.getItem('openmock-viewport-ratio') ?? 'fill',
      timeline: {
        scenes: s.scenes,
        sequenceDuration: s.sequenceDuration,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        exportOptions: s.exportOptions,
        audioClips: s.audioClips,
      },
      videos: s.videos,
      audios: s.audios,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc))
    } catch (e) {
      console.warn('[openmock] autosave failed', e)
    }
  }, 500)
}
