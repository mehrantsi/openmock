/**
 * Video clip time mapping: shot-local seconds -> video source seconds,
 * honoring the clip's trim window, playback speed and loop flag.
 */

import { MAX_SHOT_DURATION, type SceneVideo } from '../state/types'

/** One frame at 30fps — the end-clamp epsilon so we never seek past the last frame. */
export const VIDEO_FRAME_EPS = 1 / 30

const MIN_TRIM_LEN = 1e-6

/** Length of the clip's trim window in source seconds (never below epsilon). */
export function clipTrimLength(video: SceneVideo): number {
  return Math.max(video.trim.sourceOut - video.trim.sourceIn, MIN_TRIM_LEN)
}

/**
 * Source time (seconds into the video file) for a given shot-local time.
 *
 *   sourceTime = sourceIn + localSec * speed
 *   loop       -> sourceIn + (localSec * speed mod trimLen)
 *   clamped to [sourceIn, sourceOut - 1/30]
 */
export function clipSourceTime(video: SceneVideo, localSec: number): number {
  const { sourceIn, sourceOut } = video.trim
  const speed = video.speed > 0 ? video.speed : 1
  const advance = Math.max(0, localSec) * speed
  let t: number
  if (video.loop) {
    const len = clipTrimLength(video)
    t = sourceIn + (advance % len)
  } else {
    t = sourceIn + advance
  }
  const end = Math.max(sourceIn, sourceOut - VIDEO_FRAME_EPS)
  return Math.min(Math.max(t, sourceIn), end)
}

/**
 * The longest a shot can run before its (non-looping) clip runs out of frames,
 * in shot-local seconds. Looping clips never run out. The trim window is
 * additionally bounded by the real source duration when known.
 */
export function shotVideoDurationLimit(video: SceneVideo, srcDurationSeconds: number): number {
  if (video.loop) return MAX_SHOT_DURATION
  const speed = video.speed > 0 ? video.speed : 1
  const end =
    srcDurationSeconds > 0 ? Math.min(video.trim.sourceOut, srcDurationSeconds) : video.trim.sourceOut
  const limit = (end - video.trim.sourceIn) / speed
  return Math.min(MAX_SHOT_DURATION, Math.max(0, limit))
}
