/** Transient playback/session state (not persisted with the project). */

import { create } from 'zustand'

export type PlaybackPhase = 'idle' | 'paused' | 'playing'

interface PlaybackStore {
  phase: PlaybackPhase
  projectTime: number
  loop: boolean
  /** keyframe recording armed */
  recording: boolean
  /** true while user is scrubbing the ruler */
  scrubbing: boolean
  /** selected keyframe ids (timeline) */
  selectedKfIds: string[]
  /** timeline visible / hidden (T shortcut) */
  timelineVisible: boolean
  timelineMinimized: boolean
  simpleTimeline: boolean

  setPhase(p: PlaybackPhase): void
  setProjectTime(t: number): void
  setLoop(v: boolean): void
  setRecording(v: boolean): void
  setScrubbing(v: boolean): void
  setSelectedKfIds(ids: string[]): void
  setTimelineVisible(v: boolean): void
  setTimelineMinimized(v: boolean): void
  setSimpleTimeline(v: boolean): void
}

export const usePlayback = create<PlaybackStore>((set) => ({
  phase: 'idle',
  projectTime: 0,
  loop: false,
  recording: false,
  scrubbing: false,
  selectedKfIds: [],
  timelineVisible: localStorage.getItem('openmock-timeline-visible') !== '0',
  timelineMinimized: localStorage.getItem('openmock-timeline-minimized') === '1',
  simpleTimeline: localStorage.getItem('openmock-simple-timeline') === '1',

  setPhase: (phase) => set({ phase }),
  setProjectTime: (projectTime) => set({ projectTime }),
  setLoop: (loop) => set({ loop }),
  setRecording: (recording) => set({ recording }),
  setScrubbing: (scrubbing) => set({ scrubbing }),
  setSelectedKfIds: (selectedKfIds) => set({ selectedKfIds }),
  setTimelineVisible: (v) => {
    localStorage.setItem('openmock-timeline-visible', v ? '1' : '0')
    set({ timelineVisible: v })
  },
  setTimelineMinimized: (v) => {
    localStorage.setItem('openmock-timeline-minimized', v ? '1' : '0')
    set({ timelineMinimized: v })
  },
  setSimpleTimeline: (v) => {
    localStorage.setItem('openmock-simple-timeline', v ? '1' : '0')
    set({ simpleTimeline: v })
  },
}))
