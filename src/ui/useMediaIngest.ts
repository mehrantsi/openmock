/**
 * Media ingestion: drag & drop, paste, and file-picker flows.
 *
 * - Images run through the downscale ladder (ingestImage) and are stored in
 *   IndexedDB under "media:<id>"; the shot references them via `imageKey`.
 * - Videos are probed (≤500 MB, ≤180 s), stored whole, registered as project
 *   videos (max 6 distinct) and attached to shots as trimmed clips.
 * - Logo shots accept PNG (≤1 MiB, ≤4096²) or SVG uploads.
 * - Paste honors the "Paste behavior" preference; 'ask' opens the paste modal.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { useProject } from '../state/project'
import { useSettings, type PasteBehavior } from '../state/settings'
import {
  IMAGE_TYPES,
  IMAGE_TYPES_LABEL,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MEDIA_ACCEPT,
  VIDEO_TYPES,
  VIDEO_TYPES_LABEL,
  ingestImage,
  probeVideo,
  saveMediaBlob,
} from '../lib/media'
import { uid } from '../lib/ids'
import {
  MAX_PROJECT_VIDEOS,
  MAX_SHOT_DURATION,
  MIN_SHOT_DURATION,
  type LogoStyle,
  type SceneVideo,
  type Shot,
} from '../state/types'
import { remainingDuration } from '../video/timelineOps'
import { toast } from './toast'

export type IngestTarget = 'replace' | 'new-shot'

export const LOGO_ACCEPT = 'image/png,image/svg+xml'
const LOGO_MAX_BYTES = 1_048_576
const LOGO_MAX_EDGE = 4096
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ---------------------------------------------------------------------------
// Store (drag overlay + paste modal state)
// ---------------------------------------------------------------------------

interface IngestStore {
  /** >0 while a files-drag hovers the window */
  dragActive: boolean
  /** files waiting on the paste-behavior modal */
  pastePending: File[] | null
  setDragActive(v: boolean): void
  setPastePending(files: File[] | null): void
}

export const useIngestStore = create<IngestStore>((set) => ({
  dragActive: false,
  pastePending: null,
  setDragActive: (dragActive) => set({ dragActive }),
  setPastePending: (pastePending) => set({ pastePending }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function projectHasMedia(): boolean {
  return useProject.getState().scenes.some((s) => !!s.imageKey || !!s.video)
}

export function selectedShot(): Shot | null {
  const p = useProject.getState()
  return p.scenes.find((s) => s.id === p.selectedSceneId) ?? null
}

export function selectedShotIsLogo(): boolean {
  return selectedShot()?.kind === 'logo'
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input, textarea, select, [contenteditable="true"]')
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

// ---------------------------------------------------------------------------
// Logo uploads (PNG / SVG)
// ---------------------------------------------------------------------------

export async function ingestLogoFile(file: File, shotId: string): Promise<void> {
  const p = useProject.getState()
  const shot = p.scenes.find((s) => s.id === shotId)
  if (!shot || shot.kind !== 'logo' || !shot.logo) return
  const logo = shot.logo

  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name)
  if (!isSvg && !isPng) {
    toast('Logo uploads must be PNG or SVG.', 'error')
    return
  }
  if (file.size > LOGO_MAX_BYTES) {
    toast(`Image is ${formatBytes(file.size)} — max 1.0 MB. Compress it or pick a smaller file.`, 'error')
    return
  }

  if (isSvg) {
    let text: string
    try {
      text = await file.text()
    } catch {
      toast('Couldn’t read that file.', 'error')
      return
    }
    if (!text.includes('<svg')) {
      toast('That file isn’t a valid SVG.', 'error')
      return
    }
    const next: LogoStyle = { ...logo, svgSource: text, imageUrl: null }
    p.updateShot(shotId, { logo: next })
    return
  }

  // PNG: magic bytes + decode + dimension check, stored as a data URL
  let head: Uint8Array
  try {
    head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  } catch {
    toast('Couldn’t read that file.', 'error')
    return
  }
  if (!PNG_MAGIC.every((b, i) => head[i] === b)) {
    toast('That file isn’t a valid PNG.', 'error')
    return
  }
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    toast('That PNG couldn’t be decoded.', 'error')
    return
  }
  const { width, height } = bmp
  bmp.close()
  if (width > LOGO_MAX_EDGE || height > LOGO_MAX_EDGE) {
    toast(`Logo is ${width}×${height} — max 4096×4096 pixels. Resize it and try again.`, 'error')
    return
  }
  const dataUrl = await new Promise<string | null>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
  if (!dataUrl) {
    toast('Couldn’t read that file.', 'error')
    return
  }
  const next: LogoStyle = { ...logo, imageUrl: dataUrl, svgSource: null }
  p.updateShot(shotId, { logo: next })
}

// ---------------------------------------------------------------------------
// Core ingestion
// ---------------------------------------------------------------------------

async function ingestImageFile(file: File, mode: IngestTarget): Promise<void> {
  let blob: Blob
  try {
    blob = await ingestImage(file)
  } catch {
    toast('Could not read image.', 'error')
    return
  }
  const key = `media:${uid('img')}`
  try {
    await saveMediaBlob(key, blob)
  } catch {
    toast(`Couldn't save ${file.name} — file is too large. Try a smaller source.`, 'error')
    return
  }
  const p = useProject.getState()
  const sel = p.scenes.find((s) => s.id === p.selectedSceneId)
  if (mode === 'replace' && sel && sel.kind !== 'text' && sel.kind !== 'logo') {
    p.updateShot(sel.id, { imageKey: key, video: undefined })
    return
  }
  const shot = p.addScene()
  if (!shot) {
    toast("Couldn't add a shot for this image. Free up some duration first.", 'error')
    return
  }
  p.updateShot(shot.id, { imageKey: key, video: undefined })
}

async function ingestVideoFile(file: File, mode: IngestTarget): Promise<void> {
  if (file.size > MAX_VIDEO_BYTES) {
    toast('Video is too large. Keep it under 500 MB.', 'error')
    return
  }
  let p = useProject.getState()
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
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    toast('Could not read video.', 'error')
    return
  }
  if (probe.duration > MAX_VIDEO_SECONDS) {
    toast(`Video is too long. Keep it under ${MAX_VIDEO_SECONDS} seconds.`, 'error')
    return
  }
  const id = uid('vid')
  try {
    await saveMediaBlob(`media:${id}`, file)
  } catch {
    toast('Couldn\'t save the video (storage full). Try again with a smaller video or clear space.', 'error')
    return
  }

  p = useProject.getState()
  p.addProjectVideo({
    id,
    durationSeconds: probe.duration,
    width: probe.width,
    height: probe.height,
    name: file.name,
    byteSize: file.size,
    mediaKey: `media:${id}`,
  })

  const video: SceneVideo = {
    videoId: id,
    trim: { sourceIn: 0, sourceOut: probe.duration },
    speed: 1,
    loop: true,
  }

  p = useProject.getState()
  const sel = p.scenes.find((s) => s.id === p.selectedSceneId)
  if (mode === 'replace' && sel && sel.kind !== 'text' && sel.kind !== 'logo') {
    const others = p.scenes.filter((s) => s.id !== sel.id)
    const allowed = Math.max(MIN_SHOT_DURATION, remainingDuration(others))
    const duration = Math.min(MAX_SHOT_DURATION, Math.min(probe.duration, allowed))
    p.updateShot(sel.id, { video, imageKey: null, duration })
    return
  }
  const remainingBefore = remainingDuration(p.scenes)
  const shot = p.addScene()
  if (!shot) {
    toast("Couldn't add a shot for this video. Free up some duration first.", 'error')
    return
  }
  const duration = Math.max(
    MIN_SHOT_DURATION,
    Math.min(MAX_SHOT_DURATION, Math.min(probe.duration, remainingBefore)),
  )
  useProject.getState().updateShot(shot.id, { video, imageKey: null, duration })
}

/**
 * Ingest a set of dropped/pasted/picked files. The first file honors
 * `target`; additional files always become new shots.
 */
export async function ingestFiles(files: File[], target: IngestTarget): Promise<void> {
  const list = [...files]
  if (list.length === 0) return

  // logo shots swallow the first PNG/SVG as their logo when replacing
  if (target === 'replace' && selectedShotIsLogo()) {
    const sel = selectedShot()
    if (sel) await ingestLogoFile(list[0], sel.id)
    return
  }

  let sawBadImage = false
  let sawBadVideo = false
  const valid: File[] = []
  for (const f of list) {
    if (IMAGE_TYPES.includes(f.type) || VIDEO_TYPES.includes(f.type)) valid.push(f)
    else if (f.type.startsWith('image/')) sawBadImage = true
    else if (f.type.startsWith('video/')) sawBadVideo = true
    else {
      sawBadImage = true
      sawBadVideo = true
    }
  }
  if (sawBadImage && sawBadVideo) {
    toast(`File type not supported, use: ${IMAGE_TYPES_LABEL} or ${VIDEO_TYPES_LABEL}`, 'error')
  } else if (sawBadImage) {
    toast(`File type not supported, use: ${IMAGE_TYPES_LABEL}`, 'error')
  } else if (sawBadVideo) {
    toast(`File type not supported, use: ${VIDEO_TYPES_LABEL}`, 'error')
  }

  for (let i = 0; i < valid.length; i++) {
    const f = valid[i]
    const mode: IngestTarget = i === 0 ? target : 'new-shot'
    if (IMAGE_TYPES.includes(f.type)) await ingestImageFile(f, mode)
    else await ingestVideoFile(f, mode)
  }
}

/** Open a native file picker and ingest the selection. */
export function openMediaPicker(target: IngestTarget = 'replace'): void {
  const input = document.createElement('input')
  input.type = 'file'
  if (target === 'replace' && selectedShotIsLogo()) {
    input.accept = LOGO_ACCEPT
  } else {
    input.accept = MEDIA_ACCEPT
    input.multiple = true
  }
  input.onchange = () => {
    const files = input.files ? [...input.files] : []
    void ingestFiles(files, target)
  }
  input.click()
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export function resolvePaste(mode: IngestTarget, remember: boolean): void {
  const store = useIngestStore.getState()
  const files = store.pastePending
  store.setPastePending(null)
  if (remember) useSettings.getState().setPasteBehavior(mode as PasteBehavior)
  if (files) void ingestFiles(files, mode)
}

export function cancelPaste(): void {
  useIngestStore.getState().setPastePending(null)
}

function handlePaste(e: ClipboardEvent): void {
  if (isTypingTarget(e.target)) return
  const files = e.clipboardData?.files ? [...e.clipboardData.files] : []
  if (files.length === 0) return
  e.preventDefault()
  if (!projectHasMedia()) {
    void ingestFiles(files, 'replace')
    return
  }
  const behavior = useSettings.getState().pasteBehavior
  if (behavior === 'ask') {
    useIngestStore.getState().setPastePending(files)
  } else {
    void ingestFiles(files, behavior)
  }
}

// ---------------------------------------------------------------------------
// Window listeners (mount once from the app shell)
// ---------------------------------------------------------------------------

function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

export function useMediaIngest(): void {
  useEffect(() => {
    let depth = 0
    const setActive = (v: boolean) => useIngestStore.getState().setDragActive(v)

    const onDragEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      depth++
      setActive(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      // zone overlays handle their own drops; this catches strays so the
      // browser never navigates to the file
      e.preventDefault()
      depth = 0
      setActive(false)
    }
    const onDragEnd = () => {
      depth = 0
      setActive(false)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('paste', handlePaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('paste', handlePaste)
    }
  }, [])
}
