/**
 * Transient per-frame view state written by the viewport render loop while
 * the playhead drives rendering (playing / scrubbing / parked). Text and logo
 * shot overlays subscribe to it for frame-accurate local time.
 *
 * `layers` is the visible card stack in paint order (bottom → top). When
 * `coversCanvas` is true, layers[0] is an opaque text/logo card and the WebGL
 * canvas is hidden; otherwise every layer is a transparent overlay composited
 * over the engine frame.
 */

import { create } from 'zustand'

export interface PlaybackLayer {
  shotId: string
  kind: 'text' | 'logo'
  localSec: number
  /** cross-shot fade opacity for this layer */
  fade: number
}

export interface PlaybackViewState {
  /** true while the playhead (not the selected-shot dials) drives the view */
  active: boolean
  layers: PlaybackLayer[]
  coversCanvas: boolean
}

interface PlaybackViewStore extends PlaybackViewState {
  set(v: PlaybackViewState): void
  clear(): void
}

const IDLE: PlaybackViewState = { active: false, layers: [], coversCanvas: false }

function sameLayers(a: PlaybackLayer[], b: PlaybackLayer[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.shotId !== y.shotId || x.kind !== y.kind || x.localSec !== y.localSec || x.fade !== y.fade) return false
  }
  return true
}

export const usePlaybackView = create<PlaybackViewStore>((set, get) => ({
  ...IDLE,
  set: (v) => {
    const cur = get()
    if (
      cur.active === v.active &&
      cur.coversCanvas === v.coversCanvas &&
      sameLayers(cur.layers, v.layers)
    ) {
      return
    }
    set(v)
  },
  clear: () => {
    if (get().active) set({ ...IDLE })
  },
}))
