/**
 * User preferences (persisted) + viewport ratio selection.
 *
 * Persisted at localStorage["openmock-settings-v1"] (JSON via zustand persist)
 * and localStorage["openmock-viewport-ratio"] (raw string).
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type PasteBehavior = 'ask' | 'replace' | 'new-shot'

export interface SettingsState {
  /** Mockup snaps to center while panning for easier alignment. */
  snapToCenter: boolean
  /** cmd+s / ctrl+s quick capture shortcut enabled. */
  quickCaptureShortcut: boolean
  /** Subtle interface sounds (export chime, keyframe tick). */
  soundEffects: boolean
  /** Draw crosshair guides while snapped to center. */
  centerGuides: boolean
  /** Where pasted media lands when the project already has media. */
  pasteBehavior: PasteBehavior

  setSnapToCenter(v: boolean): void
  setQuickCaptureShortcut(v: boolean): void
  setSoundEffects(v: boolean): void
  setCenterGuides(v: boolean): void
  setPasteBehavior(v: PasteBehavior): void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      snapToCenter: true,
      quickCaptureShortcut: true,
      soundEffects: true,
      centerGuides: true,
      pasteBehavior: 'ask',

      setSnapToCenter: (snapToCenter) => set({ snapToCenter }),
      setQuickCaptureShortcut: (quickCaptureShortcut) => set({ quickCaptureShortcut }),
      setSoundEffects: (soundEffects) => set({ soundEffects }),
      setCenterGuides: (centerGuides) => set({ centerGuides }),
      setPasteBehavior: (pasteBehavior) => set({ pasteBehavior }),
    }),
    {
      name: 'openmock-settings-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        snapToCenter: s.snapToCenter,
        quickCaptureShortcut: s.quickCaptureShortcut,
        soundEffects: s.soundEffects,
        centerGuides: s.centerGuides,
        pasteBehavior: s.pasteBehavior,
      }),
    },
  ),
)

// ---------------------------------------------------------------------------
// Viewport ratio (top bar selector; drives the viewport letterbox)
// ---------------------------------------------------------------------------

const RATIO_KEY = 'openmock-viewport-ratio'

interface ViewportRatioState {
  ratio: string
  setRatio(r: string): void
}

export const useViewportRatio = create<ViewportRatioState>((set) => ({
  ratio: (typeof localStorage !== 'undefined' && localStorage.getItem(RATIO_KEY)) || 'fill',
  setRatio: (ratio) => {
    try {
      localStorage.setItem(RATIO_KEY, ratio)
    } catch {
      // storage full/unavailable — keep in-memory value
    }
    set({ ratio })
  },
}))
