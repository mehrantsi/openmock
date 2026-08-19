/**
 * Camera-move recording ("auto-keyframe") and in-place keyframe editing.
 *
 * Not time-sampled: the recorder subscribes to the project store's dial-commit
 * signal (dialEditSeq/lastDialEdit). Each user-originated commit is diffed
 * against the previously seen dial snapshot; every animatable prop that moved
 * by more than 1e-6 is stamped at the playhead via `recordPropKeyframe`
 * (upsert within +-0.02 t, so a continuous drag at a fixed playhead keeps
 * editing the same keyframe).
 *
 * While recording is OFF the same subscription does in-place editing instead:
 * a dial change updates an existing keyframe for that prop when one sits
 * within 0.02 of the playhead (and playback isn't running or scrubbing).
 *
 * Starter keyframes: on the first change of a prop in a recording session,
 * if the prop has no keys yet and the playhead has moved more than 0.02 from
 * where recording was armed, the prop's pre-record value is stamped at the
 * arm position first — so the move animates from where the camera was when
 * recording began.
 */

import { useEffect } from 'react'
import { useProject } from '../state/project'
import { usePlayback } from '../state/playback'
import { ANIMATABLE_PROPS, type AnimatableProp, type RenderState, type Shot } from '../state/types'
import { keyframesForProp, kfMaxT, kfMinT, propsOf } from './timelineOps'

/** Minimum dial movement that counts as a change. */
const CHANGE_EPS = 1e-6
/** Keyframe upsert / "keyed here" snap window (normalized t). */
const KF_SNAP = 0.02

type ProjectState = ReturnType<typeof useProject.getState>

interface RecorderState {
  /** last processed dialEditSeq */
  lastSeq: number
  /** last seen committed dial snapshot (updated on every commit, system or not) */
  prevDials: RenderState | null
  /** normalized playhead-in-shot t when recording started */
  armT: number | null
  /** per-prop dial values captured when recording started */
  armValues: Partial<Record<AnimatableProp, number>> | null
  /** props already stamped at least once this recording session */
  startedProps: Set<AnimatableProp>
  /** shot the arm snapshot belongs to */
  armedSceneId: string | null
}

const rec: RecorderState = {
  lastSeq: -1,
  prevDials: null,
  armT: null,
  armValues: null,
  startedProps: new Set(),
  armedSceneId: null,
}

/** Playhead position normalized into the shot, clamped to the kf drag bounds. */
function playheadLocalT(shot: Shot, projectTime: number): number {
  const t = shot.duration > 0 ? (projectTime - shot.startTime) / shot.duration : 0
  return Math.min(kfMaxT(shot), Math.max(kfMinT(shot), t))
}

/** Snapshot arm state (playhead t + all 18 dial values) for the selected shot. */
function armNow(): void {
  const p = useProject.getState()
  const shot = p.scenes.find((s) => s.id === p.selectedSceneId) ?? null
  rec.armT = shot ? playheadLocalT(shot, usePlayback.getState().projectTime) : null
  const values: Partial<Record<AnimatableProp, number>> = {}
  for (const prop of ANIMATABLE_PROPS) values[prop] = p.dials[prop]
  rec.armValues = values
  rec.startedProps = new Set()
  rec.armedSceneId = shot?.id ?? null
}

/**
 * Arm and enable recording. Pausing playback first (playback is blocked while
 * recording) is the UI's responsibility.
 */
export function startRecording(): void {
  const pb = usePlayback.getState()
  if (pb.recording) return
  armNow()
  pb.setRecording(true)
}

/** Disable recording and clear the arm state. */
export function stopRecording(): void {
  const pb = usePlayback.getState()
  if (!pb.recording) return
  pb.setRecording(false)
  rec.armT = null
  rec.armValues = null
  rec.startedProps = new Set()
  rec.armedSceneId = null
}

export function toggleRecording(): void {
  if (usePlayback.getState().recording) stopRecording()
  else startRecording()
}

function handleProjectChange(state: ProjectState): void {
  // switching shots mid-recording re-arms against the new shot
  if (usePlayback.getState().recording && state.selectedSceneId !== rec.armedSceneId) {
    armNow()
  }

  if (state.dialEditSeq === rec.lastSeq) return
  rec.lastSeq = state.dialEditSeq

  const before = rec.prevDials
  rec.prevDials = state.dials
  const edit = state.lastDialEdit
  if (!before || !edit) return
  if (edit.system) return // internal write / history restore / selection

  // diff the 18 animatable props against the previous seen snapshot
  const changed: AnimatableProp[] = []
  for (const prop of ANIMATABLE_PROPS) {
    const next = state.dials[prop]
    if (typeof next === 'number' && Math.abs(next - before[prop]) > CHANGE_EPS) changed.push(prop)
  }
  if (changed.length === 0) return

  const shot = state.scenes.find((s) => s.id === state.selectedSceneId)
  if (!shot || shot.kind) return // non-mockup shot: nothing to stamp

  const pb = usePlayback.getState()
  const t = playheadLocalT(shot, pb.projectTime)
  const api = useProject.getState()

  if (pb.recording) {
    for (const prop of changed) {
      const firstThisSession = !rec.startedProps.has(prop)
      rec.startedProps.add(prop)
      // starter keyframe: animate from the pre-record value at the arm position
      if (
        firstThisSession &&
        rec.armT !== null &&
        Math.abs(rec.armT - t) > KF_SNAP &&
        keyframesForProp(shot.keyframes, prop).length === 0
      ) {
        const armValue = rec.armValues?.[prop]
        if (typeof armValue === 'number') api.recordPropKeyframe(shot.id, prop, rec.armT, armValue)
      }
      api.recordPropKeyframe(shot.id, prop, t, state.dials[prop])
    }
    return
  }

  // not recording: in-place edit of a keyframe sitting at the playhead
  if (pb.phase === 'playing' || pb.scrubbing) return
  for (const prop of changed) {
    const keyedHere = shot.keyframes.some((k) => Math.abs(k.t - t) <= KF_SNAP && propsOf(k).includes(prop))
    if (keyedHere) api.recordPropKeyframe(shot.id, prop, t, state.dials[prop])
  }
}

/**
 * Mount-once hook wiring the recorder to the project store. Renders nothing;
 * safe to call from the app shell.
 */
export function useKeyframeRecorder(): void {
  useEffect(() => {
    const p = useProject.getState()
    rec.lastSeq = p.dialEditSeq
    rec.prevDials = p.dials
    const unsub = useProject.subscribe(handleProjectChange)
    return () => {
      unsub()
      rec.prevDials = null
    }
  }, [])
}
