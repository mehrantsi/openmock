/**
 * Per-shot state sampling for playback and export.
 *
 * Thin composition layer over the pure timeline ops: sample a shot's full
 * RenderState at a normalized time, fold in cross-shot fade opacity, and map
 * the result through `toRenderParams` into the flat engine-facing shape.
 */

import type { RenderState, Shot, Transition } from '../state/types'
import { toRenderParams, type RenderParams, type RuntimeOverrides } from '../three/renderParams'
import { sampleShotState, sceneAtTime, transitionOpacity } from './timelineOps'

// Callers deciding whether to apply the sampled camera pose (live-edit vs
// playback override) need this: pose props only override when the shot
// actually animates the camera.
export { hasCameraKeyframes, sceneAtTime, transitionOpacity, frameStackAtTime, isOverlayShot } from './timelineOps'
export type { FrameLayer, FrameStack } from './timelineOps'

export interface ProjectFades {
  fadeIn: Transition
  fadeOut: Transition
}

/**
 * Full render state of a shot at normalized local time `localT` (0..1 within
 * the shot). Per-prop bezier sampling on top of the shot's baseState; returns
 * null when the shot has no base snapshot to sample from.
 *
 * Note for callers: the 10 camera pose props in the result should only be
 * applied as a playback override when `hasCameraKeyframes(shot)` is true —
 * blur / hdrYaw / laptopHingeAngle / opacity always apply.
 */
export function sampleShotRenderState(shot: Shot, localT: number): RenderState | null {
  return sampleShotState(shot, localT)
}

/**
 * Engine params for scene `sceneIndex` at local time `localT`, with cross-shot
 * fade opacity baked into `mockupOpacity` (multiplied with any runtime
 * override). Returns null for an unknown scene or a shot without a baseState.
 */
export function shotRenderParams(
  scenes: Shot[],
  sceneIndex: number,
  localT: number,
  project: ProjectFades,
  rt?: RuntimeOverrides,
): RenderParams | null {
  const shot = scenes[sceneIndex]
  if (!shot) return null
  const state = sampleShotState(shot, localT)
  if (!state) return null
  const fade = transitionOpacity(scenes, sceneIndex, localT, project)
  const mockupOpacity = fade * (rt?.mockupOpacity ?? 1)
  return toRenderParams(state, { ...rt, mockupOpacity })
}

/**
 * Engine params at absolute project time `pt`. In a gap between shots the
 * nothing is sampled and null is returned (callers hide the mockup).
 */
export function renderParamsAtTime(
  scenes: Shot[],
  pt: number,
  project: ProjectFades,
  rt?: RuntimeOverrides,
): RenderParams | null {
  const { sceneIndex, localT } = sceneAtTime(scenes, pt)
  if (sceneIndex < 0) return null
  return shotRenderParams(scenes, sceneIndex, localT, project, rt)
}

/**
 * Tilt band rule: in tilt-shift mode the band mirrors focusSize; every other
 * blur mode uses the fixed default band (0.1). `toRenderParams` already
 * applies this — exported for callers that need the raw rule (UI overlays).
 */
export function tiltBandFor(blurMode: RenderState['blurMode'], focusSize: number): number {
  return blurMode === 'tilt-shift' ? focusSize : 0.1
}
