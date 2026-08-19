/**
 * Shared inspector plumbing: dial commit helpers, selected-shot/keyframe
 * context hooks, per-theme background color memory, media hooks, and the
 * Reset-All target builder.
 */

import { useEffect, useState } from 'react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import {
  DEFAULT_RENDER_STATE,
  type AnimatableProp,
  type RenderState,
  type Shot,
} from '../../state/types'
import {
  MOCKUP_MODELS,
  defaultFinish,
  deviceLightingDefaults,
  type MockupModelDef,
} from '../../three/devices/registry'
import { analyzeImage, getCachedMediaUrl, getMediaUrl } from '../../lib/media'
import { keyframesForProp, kfMaxT, kfMinT, propsOf } from '../../video/timelineOps'
import { toast } from '../toast'

export const ACCENT = '#FD631F'
export const KF_SNAP = 0.02

// ---------------------------------------------------------------------------
// Dials
// ---------------------------------------------------------------------------

/** Commit a dial patch (history batched by the store). */
export function commitDials(patch: Partial<RenderState>, system = false): void {
  useProject.getState().setDials(patch, system ? { system: true } : undefined)
}

export function useDials(): RenderState {
  return useProject((s) => s.dials)
}

export function useSelectedShot(): Shot | null {
  return useProject((s) => s.scenes.find((x) => x.id === s.selectedSceneId) ?? null)
}

export function useModelDef(): MockupModelDef | null {
  const model = useProject((s) => s.dials.mockupModel)
  return model ? (MOCKUP_MODELS[model] ?? null) : null
}

// ---------------------------------------------------------------------------
// Keyframe context (diamonds only render in video context)
// ---------------------------------------------------------------------------

export interface KfContext {
  /** timeline visible + a mockup (non-text/logo) shot selected */
  active: boolean
  shot: Shot | null
  /** playhead normalized into the shot, clamped to the kf drag bounds */
  localT: number
}

export function useKfContext(): KfContext {
  const shot = useSelectedShot()
  const timelineVisible = usePlayback((s) => s.timelineVisible)
  const projectTime = usePlayback((s) => s.projectTime)
  if (!shot) return { active: false, shot: null, localT: 0 }
  const t = shot.duration > 0 ? (projectTime - shot.startTime) / shot.duration : 0
  const localT = Math.min(kfMaxT(shot), Math.max(kfMinT(shot), t))
  return { active: timelineVisible && !shot.kind, shot, localT }
}

export type KfRowState = 'keyed' | 'animated' | 'none'

export function kfStateFor(shot: Shot, props: readonly AnimatableProp[], t: number): KfRowState {
  const keyed =
    props.length > 0 &&
    props.every((p) => shot.keyframes.some((k) => Math.abs(k.t - t) <= KF_SNAP && propsOf(k).includes(p)))
  if (keyed) return 'keyed'
  const animated = props.some((p) => keyframesForProp(shot.keyframes, p).length > 0)
  return animated ? 'animated' : 'none'
}

/** Toggle keys for one or more props at the playhead (multi-prop pads key both). */
export function toggleKfAt(shot: Shot, props: readonly AnimatableProp[], t: number): void {
  const api = useProject.getState()
  const state = kfStateFor(shot, props, t)
  if (state === 'keyed') {
    for (const p of props) api.removePropKeyframe(shot.id, p, t)
  } else {
    for (const p of props) {
      const v = api.dials[p]
      if (typeof v === 'number') api.recordPropKeyframe(shot.id, p, t, v)
    }
  }
}

// ---------------------------------------------------------------------------
// Per-theme background color memory (localStorage "openmock-settings")
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'openmock-settings'

export interface PanelSettings {
  bgColorLight: string
  bgColorDark: string
}

const SETTINGS_DEFAULTS: PanelSettings = { bgColorLight: '#f2f2f2', bgColorDark: '#0a0a0a' }

export function loadPanelSettings(): PanelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...SETTINGS_DEFAULTS }
    return { ...SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<PanelSettings>) }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

export function savePanelSettings(patch: Partial<PanelSettings>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadPanelSettings(), ...patch }))
  } catch {
    /* non-fatal */
  }
}

/** Remember the user's bg color for the current theme. */
export function rememberBgColor(color: string, dark: boolean): void {
  savePanelSettings(dark ? { bgColorDark: color } : { bgColorLight: color })
}

// ---------------------------------------------------------------------------
// One-time notices
// ---------------------------------------------------------------------------

export function noticeOnce(storageKey: string, message: string): void {
  try {
    if (localStorage.getItem(storageKey)) return
    localStorage.setItem(storageKey, '1')
  } catch {
    /* still show it */
  }
  toast(message, 'info', 2400)
}

// ---------------------------------------------------------------------------
// Media hooks
// ---------------------------------------------------------------------------

export function useMediaUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(key ? getCachedMediaUrl(key) : null)
  useEffect(() => {
    let live = true
    if (!key) {
      setUrl(null)
      return
    }
    const cached = getCachedMediaUrl(key)
    if (cached) {
      setUrl(cached)
      return
    }
    getMediaUrl(key)
      .then((u) => {
        if (live) setUrl(u)
      })
      .catch(() => {
        if (live) setUrl(null)
      })
    return () => {
      live = false
    }
  }, [key])
  return url
}

export interface MediaAnalysis {
  average: string
  isDark: boolean
}

const analysisCache = new Map<string, MediaAnalysis>()

/** 64×64 downsample analysis of the shot's screenshot (Ghost gating). */
export function useMediaAnalysis(key: string | null | undefined): MediaAnalysis | null {
  const [res, setRes] = useState<MediaAnalysis | null>(key ? (analysisCache.get(key) ?? null) : null)
  useEffect(() => {
    let live = true
    if (!key) {
      setRes(null)
      return
    }
    const cached = analysisCache.get(key)
    if (cached) {
      setRes(cached)
      return
    }
    getMediaUrl(key)
      .then((url) => (url ? analyzeImage(url) : null))
      .then((r) => {
        if (r && live) {
          analysisCache.set(key, r)
          setRes(r)
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [key])
  return res
}

// ---------------------------------------------------------------------------
// Reset All
// ---------------------------------------------------------------------------

/**
 * Full "Reset All" target: defaults everywhere, camera at fov 24 / zoom 4.5,
 * borderRadius 0, bg color per theme; the active 3D model (and its lighting
 * defaults) is preserved.
 */
export function buildResetAllPatch(dials: RenderState, dark: boolean): Partial<RenderState> {
  const model = dials.mockupModel
  const def = model ? MOCKUP_MODELS[model] : undefined
  return {
    ...DEFAULT_RENDER_STATE,
    fov: 24,
    zoom: 4.5,
    borderRadius: 0,
    bgColor: dark ? '#0a0a0a' : '#f2f2f2',
    darkMode: dark,
    mockupModel: model,
    deviceFinish: model ? defaultFinish(model) : DEFAULT_RENDER_STATE.deviceFinish,
    ...(model ? deviceLightingDefaults(model) : {}),
    laptopHingeAngle: def?.hinge ? def.hinge.openDeg : DEFAULT_RENDER_STATE.laptopHingeAngle,
    deviceFeatures: {},
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
