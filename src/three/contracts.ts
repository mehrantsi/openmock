/**
 * Interfaces between the engine (engine.ts), the device subsystem
 * (devices/loader.ts, devices/procedural.ts), and consumers (viewport, export).
 */

import type * as THREE from 'three'
import type { RenderParams } from './renderParams'

export type MediaSource =
  | { kind: 'image'; element: HTMLImageElement | ImageBitmap }
  | { kind: 'video'; element: HTMLVideoElement }
  | { kind: 'frame'; element: HTMLCanvasElement } // pre-drawn video frame (export)
  | null

export interface LidHinge {
  pivot: THREE.Group
  axis: THREE.Vector3
  dir: number
  openDeg: number
}

export interface LoadedDeviceModel {
  id: string
  /** normalized, recentered wrapper — add to the model group */
  wrapper: THREE.Group
  screenMesh: THREE.Mesh
  /** physical screen material (emissiveMap = screen RT) */
  screenMaterial: THREE.MeshPhysicalMaterial
  baseScale: number
  /** width/height aspect of the screen face */
  faceAspect: number
  /** wrapper-space bounding box (scaled by baseScale) */
  localAABB: THREE.Box3
  featureNodes: Map<string, THREE.Object3D[]>
  notchNodes: THREE.Object3D[]
  notchFillMesh: THREE.Mesh | null
  lidHinge: LidHinge | null
  dispose(): void
}

export interface CaptureOptions {
  width: number
  height: number
  format: 'jpeg' | 'png' | 'webp'
  quality?: number
  transparent?: boolean
  params: RenderParams
}

export interface Engine {
  readonly canvas: HTMLCanvasElement
  /** draw one frame */
  render(params: RenderParams): void
  /** device-pixel size */
  resize(width: number, height: number): void
  getSize(): { width: number; height: number }

  setMedia(source: MediaSource): void
  /** aspect of the current media (w/h), used for the flat quad */
  getMediaAspect(): number
  setBgImage(img: HTMLImageElement | ImageBitmap | null): void
  setMockupBgImage(img: HTMLImageElement | ImageBitmap | null): void

  /** resolve when the model (and env HDRI) are ready to render */
  prepareModel(modelId: string): Promise<void>
  prepareEnvironment(envId: string | null): Promise<void>

  captureToBlob(opts: CaptureOptions): Promise<Blob>
  /** notifies when a model starts/finishes loading (UI progress pill) */
  onModelLoad?: (ev: { id: string; loading: boolean; progress: number }) => void

  dispose(): void
}

export interface EngineOptions {
  preserveDrawingBuffer?: boolean
  onLiftClamp?: (lift: number) => void
}
