/**
 * Offline audio mixdown for video export.
 *
 * Renders every audible timeline clip into one OfflineAudioContext pass:
 * per-clip trim/start scheduling, gain automation (linear fade-in/out ramps
 * scaled by clip volume), then interleaves the rendered channels into a
 * single Float32Array hard-clipped to [-1, 1] ready for AudioData chunks.
 */

import type { AudioClip, ProjectAudio } from '../state/types'

export interface AudioMixdown {
  /** interleaved f32 samples (frame-major: L R L R …) */
  data: Float32Array<ArrayBuffer>
  sampleRate: number
  numberOfChannels: number
}

interface ScheduledClip {
  clip: AudioClip
  buffer: AudioBuffer
}

/**
 * Mix the timeline's audio clips into one interleaved buffer.
 *
 * @param clips    timeline audio clips (project-time seconds)
 * @param audios   project audio records (matched by clip.audioId)
 * @param buffers  decoded AudioBuffers keyed by ProjectAudio.id
 * @param totalSec total project duration to render
 * @returns        interleaved mixdown, or null when nothing is audible
 */
export async function mixdownAudio(
  clips: AudioClip[],
  audios: ProjectAudio[],
  buffers: Map<string, AudioBuffer>,
  totalSec: number,
): Promise<AudioMixdown | null> {
  if (!(totalSec > 0)) return null

  const audioIds = new Set(audios.map((a) => a.id))
  const scheduled: ScheduledClip[] = []
  for (const clip of clips) {
    if (clip.muted || clip.volume <= 0) continue
    if (!audioIds.has(clip.audioId)) continue
    const buffer = buffers.get(clip.audioId)
    if (!buffer) continue
    scheduled.push({ clip, buffer })
  }
  if (scheduled.length === 0) return null

  const numberOfChannels = Math.max(
    1,
    Math.min(2, scheduled.reduce((m, s) => Math.max(m, s.buffer.numberOfChannels), 1)),
  )
  const sampleRate = scheduled[0].buffer.sampleRate || 48000
  const length = Math.max(1, Math.ceil(totalSec * sampleRate))
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)

  for (const { clip, buffer } of scheduled) {
    const when = Math.max(0, clip.startTime)
    const offset = Math.max(0, clip.trim.sourceIn)
    const playLen = Math.min(clip.trim.sourceOut, buffer.duration) - offset
    if (!(playLen > 0)) continue

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)

    const volume = clip.volume
    const fadeIn = Math.max(0, Math.min(clip.fadeIn ?? 0, playLen))
    const fadeOut = Math.max(0, Math.min(clip.fadeOut ?? 0, playLen - fadeIn))
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, when)
      gain.gain.linearRampToValueAtTime(volume, when + fadeIn)
    } else {
      gain.gain.setValueAtTime(volume, when)
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(volume, when + playLen - fadeOut)
      gain.gain.linearRampToValueAtTime(0, when + playLen)
    }

    source.start(when, offset, playLen)
  }

  const rendered = await ctx.startRendering()

  // interleave + hard clip
  const frames = rendered.length
  const data = new Float32Array(frames * numberOfChannels)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const src = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1))
    for (let i = 0; i < frames; i++) {
      const v = src[i]
      data[i * numberOfChannels + ch] = v > 1 ? 1 : v < -1 ? -1 : v
    }
  }

  return { data, sampleRate, numberOfChannels }
}
