/**
 * Module-level registry for the live viewport engine, so non-React code
 * (export pipeline, quick capture) can reach it without prop drilling.
 */

import type { OpenMockEngine } from '../../three/engine'

let current: OpenMockEngine | null = null
const listeners = new Set<(engine: OpenMockEngine | null) => void>()

export function setViewportEngine(engine: OpenMockEngine | null): void {
  current = engine
  for (const fn of listeners) fn(engine)
}

export function getViewportEngine(): OpenMockEngine | null {
  return current
}

export function onViewportEngine(fn: (engine: OpenMockEngine | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Ask the viewport to repaint (listened to by the viewport render scheduler). */
export function requestViewportRender(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('openmock:render-needed'))
}
