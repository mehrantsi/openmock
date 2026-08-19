/**
 * "Add track" media flows: file pickers + ingest for media shots and audio
 * tracks. Everything stays local (IndexedDB media cache, `media:` keys).
 */

import { useProject } from '../../state/project'
import {
  MAX_PROJECT_AUDIOS,
  MAX_PROJECT_VIDEOS,
  MAX_SCENES,
  MIN_SHOT_DURATION,
  type SceneVideo,
  type Shot,
} from '../../state/types'
import {
  IMAGE_TYPES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MEDIA_ACCEPT,
  VIDEO_TYPES,
  ingestImage,
  probeVideo,
  saveMediaBlob,
} from '../../lib/media'
import { audioClipId, audioId, uid, videoId } from '../../lib/ids'
import { toast } from '../toast'
import { applyNormalizedOrder } from './kfOps'
import { shotVideoDurationLimit } from '../../video/videoClock'

export const AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/webm,audio/flac'

/** Open a native file picker; resolves null when dismissed. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    // cancel detection (best effort)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

interface IngestedMedia {
  imageKey?: string
  video?: SceneVideo
  videoDuration?: number
}

/** Ingest a media file into the pools; returns the shot patch pieces. */
async function ingestMediaFile(file: File): Promise<IngestedMedia | null> {
  const p = useProject.getState()
  if (VIDEO_TYPES.includes(file.type)) {
    if (p.videos.length >= MAX_PROJECT_VIDEOS) {
      toast('A project can use up to 6 different videos.', 'error')
      return null
    }
    if (file.size > MAX_VIDEO_BYTES) {
      toast('Video is too large (500 MB max).', 'error')
      return null
    }
    let probe
    try {
      probe = await probeVideo(file)
    } catch {
      toast('Could not read video.', 'error')
      return null
    }
    if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
      toast('Could not read video.', 'error')
      return null
    }
    const dur = Math.min(probe.duration, MAX_VIDEO_SECONDS)
    const id = videoId()
    await saveMediaBlob(`media:${id}`, file)
    p.addProjectVideo({
      id,
      durationSeconds: dur,
      width: probe.width,
      height: probe.height,
      name: file.name,
      byteSize: file.size,
      mediaKey: `media:${id}`,
    })
    return {
      video: { videoId: id, trim: { sourceIn: 0, sourceOut: dur }, speed: 1, loop: false },
      videoDuration: dur,
    }
  }
  if (IMAGE_TYPES.includes(file.type) || file.type.startsWith('image/')) {
    let blob: Blob
    try {
      blob = await ingestImage(file)
    } catch {
      toast('Could not read image.', 'error')
      return null
    }
    const key = `media:${uid('img')}`
    await saveMediaBlob(key, blob)
    return { imageKey: key }
  }
  toast('Unsupported file type.', 'error')
  return null
}

/** Add a new media shot from a picked image/video file. */
export async function addMediaShot(): Promise<void> {
  const p = useProject.getState()
  if (p.scenes.length >= MAX_SCENES) {
    toast(`Scene limit reached (${MAX_SCENES}).`, 'error')
    return
  }
  const file = await pickFile(MEDIA_ACCEPT)
  if (!file) return
  const media = await ingestMediaFile(file)
  if (!media) return
  const proj = useProject.getState()
  const shot = proj.addScene()
  if (!shot) {
    toast(`Scene limit reached (${MAX_SCENES}).`, 'error')
    return
  }
  applyIngestToShot(shot, media)
}

/** Replace (or add) the media of an existing shot. */
export async function replaceShotMedia(shotId: string): Promise<void> {
  const file = await pickFile(MEDIA_ACCEPT)
  if (!file) return
  const media = await ingestMediaFile(file)
  if (!media) return
  const shot = useProject.getState().scenes.find((s) => s.id === shotId)
  if (!shot) return
  applyIngestToShot(shot, media)
}

function applyIngestToShot(shot: Shot, media: IngestedMedia): void {
  const p = useProject.getState()
  if (media.video) {
    p.updateShot(shot.id, { video: media.video, imageKey: shot.imageKey ?? null })
    // shot runs the whole (trimmed) clip; store clamps vs remaining project time
    const limit = shotVideoDurationLimit(media.video, media.videoDuration ?? media.video.trim.sourceOut)
    p.setSceneDuration(shot.id, Math.max(MIN_SHOT_DURATION, limit))
    applyNormalizedOrder()
  } else if (media.imageKey) {
    p.updateShot(shot.id, { imageKey: media.imageKey, video: undefined })
  }
}

/** Add an audio track (pool entry + one clip starting at 0). */
export async function addAudioTrack(): Promise<void> {
  const p = useProject.getState()
  if (p.audios.length >= MAX_PROJECT_AUDIOS) {
    toast(`A project can use up to ${MAX_PROJECT_AUDIOS} different audio files.`, 'error')
    return
  }
  const file = await pickFile(AUDIO_ACCEPT)
  if (!file) return
  let decoded: AudioBuffer
  try {
    const bytes = await file.arrayBuffer()
    const ctx = new OfflineAudioContext(1, 1, 44100)
    decoded = await ctx.decodeAudioData(bytes)
  } catch {
    toast('Could not decode audio file.', 'error')
    return
  }
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    toast('Could not decode audio file.', 'error')
    return
  }
  const id = audioId()
  await saveMediaBlob(`media:${id}`, file)
  const proj = useProject.getState()
  proj.addProjectAudio({
    id,
    durationSeconds: decoded.duration,
    sampleRate: decoded.sampleRate,
    channelCount: Math.min(2, decoded.numberOfChannels || 1),
    name: file.name,
    byteSize: file.size,
    mediaKey: `media:${id}`,
  })
  proj.setAudioClips([
    ...proj.audioClips,
    {
      id: audioClipId(),
      audioId: id,
      startTime: 0,
      trim: { sourceIn: 0, sourceOut: decoded.duration },
      volume: 1,
      muted: false,
    },
  ])
}
