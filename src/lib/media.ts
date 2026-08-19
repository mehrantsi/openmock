/**
 * Media ingestion + runtime cache. Blobs live in IndexedDB under `media:<id>`;
 * object URLs are cached per key for the session.
 */

import { idbSet, idbGet, idbDelete } from './idb'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
export const IMAGE_TYPES_LABEL = 'PNG, JPG, WEBP'
export const VIDEO_TYPES_LABEL = 'MP4, WebM, MOV'
export const MEDIA_ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES].join(',')
export const BG_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif'

export const MAX_VIDEO_BYTES = 524_288_000 // 500 MB
export const MAX_VIDEO_SECONDS = 180

const urlCache = new Map<string, string>()

export async function saveMediaBlob(key: string, blob: Blob): Promise<void> {
  await idbSet(key, blob)
  const prev = urlCache.get(key)
  if (prev) URL.revokeObjectURL(prev)
  urlCache.set(key, URL.createObjectURL(blob))
}

export async function getMediaBlob(key: string): Promise<Blob | undefined> {
  return idbGet<Blob>(key)
}

/** Object URL for a stored media key (loads from IndexedDB on first use). */
export async function getMediaUrl(key: string): Promise<string | null> {
  const cached = urlCache.get(key)
  if (cached) return cached
  const blob = await idbGet<Blob>(key)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(key, url)
  return url
}

export function getCachedMediaUrl(key: string): string | null {
  return urlCache.get(key) ?? null
}

export async function deleteMedia(key: string): Promise<void> {
  const url = urlCache.get(key)
  if (url) URL.revokeObjectURL(url)
  urlCache.delete(key)
  await idbDelete(key)
}

/** Downscale ladder for oversized screenshots (max edge, then quality steps). */
const EDGE_LADDER = [4400, 4000, 3600, 3200, 2800, 2400, 2000, 1600, 1400]
const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4]
const IMAGE_BYTE_BUDGET = 8 * 1024 * 1024

export async function ingestImage(file: Blob): Promise<Blob> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error('Could not read image.')
  }
  const maxEdge = Math.max(bmp.width, bmp.height)
  if (maxEdge <= EDGE_LADDER[0] && file.size <= IMAGE_BYTE_BUDGET) {
    bmp.close()
    return file
  }
  for (const edge of EDGE_LADDER) {
    const scale = Math.min(1, edge / maxEdge)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    for (const q of [0.92, ...QUALITY_LADDER]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q))
      if (blob && blob.size <= IMAGE_BYTE_BUDGET) {
        bmp.close()
        return blob
      }
    }
  }
  bmp.close()
  throw new Error('Image is too large to process.')
}

export interface VideoProbe {
  duration: number
  width: number
  height: number
}

export function probeVideo(blob: Blob): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      const out = { duration: v.duration, width: v.videoWidth, height: v.videoHeight }
      URL.revokeObjectURL(url)
      resolve(out)
    }
    v.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read video.'))
    }
    v.src = url
  })
}

/** Average color of an image (for extrude tint) + dark-mode detection. */
export async function analyzeImage(url: string): Promise<{ average: string; isDark: boolean }> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not read image.'))
    img.src = url
  })
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, 64, 64)
  const data = ctx.getImageData(0, 0, 64, 64).data
  let r = 0
  let g = 0
  let b = 0
  const buckets = new Array(10).fill(0)
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
    buckets[Math.min(9, Math.floor(luma * 10))]++
  }
  const n = data.length / 4
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0')
  // modal luma bucket <= .32 means a dark screenshot
  const modal = buckets.indexOf(Math.max(...buckets))
  return { average: `#${hex(r)}${hex(g)}${hex(b)}`, isDark: (modal + 0.5) / 10 <= 0.32 }
}
