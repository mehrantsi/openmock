/**
 * Per-device default screen media (bundled recreations of each platform's
 * stock lock screen / screensaver). Loaded when a shot starts without user
 * media, and swapped when switching devices while a builtin default is shown.
 */

import { ingestImage, saveMediaBlob } from './media'
import { useProject } from '../state/project'

const BUILTIN_PREFIX = 'media:builtin:'

/** modelId → bundled default image ('' = flat). */
export const DEVICE_DEFAULT_MEDIA: Record<string, string> = {
  '': '/defaults/wallpaper.jpg',
  iphone17: '/defaults/ios-lock.jpg',
  iphone17Pro: '/defaults/ios-lock.jpg',
  iphone17ProMax: '/defaults/ios-lock.jpg',
  ipadPro: '/defaults/ipad-lock.jpg',
  watchUltra3: '/defaults/watch-face.jpg',
  macbookNeo: '/defaults/mac-lock.jpg',
  // the Pro panels are 16:10.35 — separate render so `contain` fit has no bars
  macbookPro14: '/defaults/mac-lock-pro.jpg',
  macbookPro16M3: '/defaults/mac-lock-pro.jpg',
  proDisplayXdr: '/defaults/xdr-screensaver.jpg',
}

export function defaultMediaUrl(modelId: string): string {
  return DEVICE_DEFAULT_MEDIA[modelId] ?? DEVICE_DEFAULT_MEDIA['']
}

/** true when a shot's media is one of the bundled defaults (safe to swap). */
export function isBuiltinMediaKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(BUILTIN_PREFIX)
}

/**
 * Load the device's bundled default into the shot. Media keys are
 * deterministic per asset so repeated loads reuse the cached blob.
 */
export async function applyDefaultMediaForModel(modelId: string, shotId: string): Promise<void> {
  const url = defaultMediaUrl(modelId)
  const key = `${BUILTIN_PREFIX}${url.split('/').pop()?.replace(/\.[a-z]+$/i, '') ?? 'default'}`
  try {
    const res = await fetch(url)
    if (!res.ok) return
    const processed = await ingestImage(await res.blob())
    await saveMediaBlob(key, processed)
    const live = useProject.getState()
    if (live.scenes.some((s) => s.id === shotId)) {
      live.updateShot(shotId, { imageKey: key })
    }
  } catch {
    // defaults are a nicety — the shot simply starts empty
  }
}

/**
 * Device switched: if the selected shot has no media or is showing a builtin
 * default, load the new device's default in its place.
 */
export function maybeSwapDefaultMedia(modelId: string): void {
  const p = useProject.getState()
  const shot = p.scenes.find((s) => s.id === p.selectedSceneId)
  if (!shot || shot.kind || shot.video) return
  if (shot.imageKey && !isBuiltinMediaKey(shot.imageKey)) return
  void applyDefaultMediaForModel(modelId, shot.id)
}
