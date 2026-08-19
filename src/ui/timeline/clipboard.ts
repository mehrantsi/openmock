/**
 * In-memory timeline clipboard: either a set of keyframe entries (relative to
 * the first copied key) or a whole shot. Kind tracked so ⌘V pastes the right
 * thing.
 */

import type { AnimatableProp, BezierHandle, Keyframe, RenderState, Shot } from '../../state/types'

export interface KfClipEntry {
  /** offset (normalized t) from the first copied keyframe */
  dt: number
  state: RenderState
  props?: AnimatableProp[]
  outEasing?: BezierHandle
  inEasing?: BezierHandle
}

export type ClipboardContent =
  | { kind: 'kf'; entries: KfClipEntry[] }
  | { kind: 'scene'; shot: Shot }

let content: ClipboardContent | null = null

export function setClipboard(c: ClipboardContent | null): void {
  content = c
}

export function getClipboard(): ClipboardContent | null {
  return content
}

export function clipboardKfCount(): number {
  return content?.kind === 'kf' ? content.entries.length : 0
}

export function clipboardHasScene(): boolean {
  return content?.kind === 'scene'
}

/** Build clipboard entries from resolved keyframe selection items. */
export function makeKfEntries(items: { kf: Keyframe; prop?: AnimatableProp }[]): KfClipEntry[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => a.kf.t - b.kf.t)
  const baseT = sorted[0].kf.t
  return sorted.map(({ kf, prop }) => ({
    dt: kf.t - baseT,
    state: structuredClone(kf.state),
    props: prop ? [prop] : kf.props ? [...kf.props] : undefined,
    outEasing: kf.outEasing ? ([...kf.outEasing] as BezierHandle) : undefined,
    inEasing: kf.inEasing ? ([...kf.inEasing] as BezierHandle) : undefined,
  }))
}
