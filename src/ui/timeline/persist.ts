/** localStorage-persisted timeline UI state (all keys `openmock-` prefixed). */

import { useCallback, useState } from 'react'

export const KEY_ZOOM = 'openmock-timeline-zoom'
export const KEY_HEIGHT = 'openmock-timeline-height'
export const KEY_EXPANDED = 'openmock-timeline-shot-expanded'
export const KEY_GAP_TIP = 'openmock-gap-tip-seen'
export const KEY_RECORD_GUIDE = 'openmock-record-guide-seen'
export const KEY_CENTER_GUIDES = 'openmock-snap-center-enabled'

export function readNumber(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '')
    return Number.isFinite(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode etc. */
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** useState persisted as JSON under `key`. */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readJson(key, initial))
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
        writeString(key, JSON.stringify(next))
        return next
      })
    },
    [key],
  )
  return [value, set]
}
