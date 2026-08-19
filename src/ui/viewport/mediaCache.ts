/**
 * Session caches for viewport media: decoded HTMLImageElements per IndexedDB
 * media key, plus per-key image analysis (average color for the extrude slab
 * tint, dark-mode detection for the Ghost effect).
 */

import { analyzeImage, getMediaUrl } from '../../lib/media'

export interface ImageAnalysis {
  average: string
  isDark: boolean
}

const images = new Map<string, HTMLImageElement>()
const imagePending = new Map<string, Promise<HTMLImageElement | null>>()
const analyses = new Map<string, ImageAnalysis>()

/** Synchronous cache hit (or null). Does not trigger a load. */
export function getLoadedImage(key: string): HTMLImageElement | null {
  return images.get(key) ?? null
}

export function getImageAnalysis(key: string): ImageAnalysis | null {
  return analyses.get(key) ?? null
}

/** Load (and analyze) the image stored at `key` ("media:…"). Cached. */
export function loadImageForKey(key: string): Promise<HTMLImageElement | null> {
  const hit = images.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = imagePending.get(key)
  if (pending) return pending

  const p = (async (): Promise<HTMLImageElement | null> => {
    const url = await getMediaUrl(key)
    if (!url) return null
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not read image.'))
      img.src = url
    })
    images.set(key, img)
    // analysis is best-effort; failures leave the entry absent
    void analyzeImage(url)
      .then((a) => analyses.set(key, a))
      .catch(() => {})
    return img
  })().catch(() => null)

  imagePending.set(key, p)
  void p.finally(() => imagePending.delete(key))
  return p
}

/** Load a plain URL (background image presets / data-urls). Cached by URL. */
export function loadImageUrl(url: string): Promise<HTMLImageElement | null> {
  const cacheKey = `url:${url}`
  const hit = images.get(cacheKey)
  if (hit) return Promise.resolve(hit)
  const pending = imagePending.get(cacheKey)
  if (pending) return pending
  const p = (async (): Promise<HTMLImageElement | null> => {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not read image.'))
      img.src = url
    })
    images.set(cacheKey, img)
    return img
  })().catch(() => null)
  imagePending.set(cacheKey, p)
  void p.finally(() => imagePending.delete(cacheKey))
  return p
}
