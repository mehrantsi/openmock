import { useRef } from 'react'
import { Upload, X } from 'lucide-react'
import { useProject } from '../../state/project'
import { MAX_PROJECT_VIDEOS, type Shot } from '../../state/types'
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
import { uid, videoId } from '../../lib/ids'
import { toast } from '../toast'
import { Segmented } from '../controls/Segmented'
import { ToggleRow } from '../controls/ToggleRow'
import { formatSeconds, useMediaUrl } from './dialHelpers'

/** Replace the selected shot's media with a dropped/picked file (self-contained ingest). */
export async function replaceShotMedia(shot: Shot, file: File): Promise<void> {
  const p = useProject.getState()
  if (IMAGE_TYPES.includes(file.type)) {
    let blob: Blob
    try {
      blob = await ingestImage(file)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read image.', 'error')
      return
    }
    const key = `media:${uid('img')}`
    await saveMediaBlob(key, blob)
    p.updateShot(shot.id, { imageKey: key, video: undefined })
    return
  }
  if (VIDEO_TYPES.includes(file.type)) {
    if (file.size > MAX_VIDEO_BYTES) {
      toast('Video is too large. Keep it under 500 MB.', 'error')
      return
    }
    if (p.videos.length >= MAX_PROJECT_VIDEOS) {
      toast(`A project can use up to ${MAX_PROJECT_VIDEOS} different videos.`, 'error')
      return
    }
    let probe: { duration: number; width: number; height: number }
    try {
      probe = await probeVideo(file)
    } catch {
      toast('Could not read video.', 'error')
      return
    }
    if (probe.duration > MAX_VIDEO_SECONDS) {
      toast(`Video is too long. Keep it under ${MAX_VIDEO_SECONDS} seconds.`, 'error')
      return
    }
    const id = videoId()
    const mediaKey = `media:${id}`
    try {
      await saveMediaBlob(mediaKey, file)
    } catch {
      toast('Couldn’t save the video (storage full). Try again with a smaller video or clear space.', 'error')
      return
    }
    useProject.getState().addProjectVideo({
      id,
      durationSeconds: probe.duration,
      width: probe.width,
      height: probe.height,
      name: file.name,
      byteSize: file.size,
      mediaKey,
    })
    useProject.getState().updateShot(shot.id, {
      video: { videoId: id, trim: { sourceIn: 0, sourceOut: probe.duration }, speed: 1, loop: true },
      imageKey: null,
    })
    return
  }
  toast('File type not supported, use: PNG, JPG, WEBP or MP4, WebM, MOV', 'error')
}

export function clearShotMedia(shot: Shot): void {
  useProject.getState().updateShot(shot.id, { imageKey: null, video: undefined })
}

/** SOURCE block: media preview + replace/clear + video speed & loop. */
export function SourceBlock({ shot }: { shot: Shot }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const videos = useProject((s) => s.videos)
  const projectVideo = shot.video ? (videos.find((v) => v.id === shot.video!.videoId) ?? null) : null
  const imageUrl = useMediaUrl(shot.imageKey)
  const videoUrl = useMediaUrl(projectVideo?.mediaKey ?? null)

  const hasVideo = !!shot.video && !!projectVideo
  const hasMedia = hasVideo || !!shot.imageKey

  const pickFile = () => fileRef.current?.click()

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-1 pt-0.5">
        <span className="text-[10.5px] font-medium text-black/55 dark:text-white/50">
          Source
        </span>
        <span className="text-[10px] font-medium text-black/30 dark:text-white/25 truncate max-w-[130px]">
          {shot.name}
        </span>
      </div>

      {hasMedia ? (
        <div className="relative group">
          <button
            aria-label="Replace media"
            onClick={pickFile}
            className="relative w-full h-[92px] rounded-md overflow-hidden border border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center"
          >
            {hasVideo ? (
              videoUrl ? (
                <video src={videoUrl} muted playsInline preload="metadata" className="w-full h-full object-cover" />
              ) : (
                <span className="text-[10px] text-black/35 dark:text-white/30">Loading…</span>
              )
            ) : imageUrl ? (
              <img src={imageUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-[10px] text-black/35 dark:text-white/30">Loading…</span>
            )}
            {hasVideo && projectVideo && (
              <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/65 text-white font-mono text-[9px] tracking-[0.06em]">
                ▶ VIDEO · {formatSeconds(projectVideo.durationSeconds)}
              </span>
            )}
          </button>
          <button
            aria-label="Clear media"
            title="Clear media"
            onClick={() => clearShotMedia(shot)}
            className="absolute top-1.5 right-1.5 size-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          >
            <X className="size-3" strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <button
          aria-label="Upload media"
          onClick={pickFile}
          className="w-full h-[92px] rounded-md border border-dashed border-black/20 dark:border-white/20 flex flex-col items-center justify-center gap-1 text-black/45 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:border-black/35 dark:hover:border-white/35 transition-colors"
        >
          <Upload className="size-4" strokeWidth={2} />
          <span className="text-[11px] font-medium">Click to upload</span>
          <span className="text-[9px] text-black/30 dark:text-white/25">Drag &amp; drop or paste</span>
        </button>
      )}

      {hasVideo && shot.video && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-black/60 dark:text-white/55 px-1 shrink-0">Speed</span>
            <Segmented
              className="flex-1"
              value={String(shot.video.speed) as '0.5' | '1' | '1.5' | '2'}
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '1.5', label: '1.5×' },
                { value: '2', label: '2×' },
              ]}
              onChange={(v) =>
                useProject.getState().updateShot(shot.id, { video: { ...shot.video!, speed: parseFloat(v) } })
              }
            />
          </div>
          <ToggleRow
            label="Loop"
            checked={shot.video.loop}
            onChange={(v) => useProject.getState().updateShot(shot.id, { video: { ...shot.video!, loop: v } })}
          />
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={MEDIA_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void replaceShotMedia(shot, f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
