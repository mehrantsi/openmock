/**
 * Tiny generated WebAudio blips (no assets). All playback is gated by the
 * "Sound effects" preference.
 */

import { useSettings } from '../../state/settings'

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}

function enabled(): boolean {
  return useSettings.getState().soundEffects
}

function tone(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  gain: number,
  type: OscillatorType = 'sine',
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, startAt)
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(gain, startAt + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

/** Short keyframe tick. */
export function playTick(): void {
  if (!enabled()) return
  const ac = audioContext()
  if (!ac) return
  tone(ac, 1180, ac.currentTime, 0.055, 0.06, 'square')
}

/** Two-note chime — export finished. */
export function playSuccess(): void {
  if (!enabled()) return
  const ac = audioContext()
  if (!ac) return
  const t = ac.currentTime
  tone(ac, 660, t, 0.14, 0.08)
  tone(ac, 990, t + 0.09, 0.22, 0.08)
}

/** Low blip — an action couldn't run. */
export function playBlip(): void {
  if (!enabled()) return
  const ac = audioContext()
  if (!ac) return
  tone(ac, 220, ac.currentTime, 0.12, 0.07, 'triangle')
}
