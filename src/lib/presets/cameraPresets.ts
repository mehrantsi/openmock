/** Static camera position presets (viewport panel "Presets" tab). */

export interface CameraPresetValues {
  tiltX: number
  tiltY: number
  tiltZ: number
  flap: number
  zoom: number
  panX: number
  panY: number
  fov: number
}

export const CAMERA_POSITION_PRESETS: { name: string; vals: CameraPresetValues }[] = [
  { name: 'Hero', vals: { tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, zoom: 1.35, panX: 0.39, panY: -0.4, fov: 45 } },
  { name: 'Angled', vals: { tiltX: -28, tiltY: 26, tiltZ: 5, flap: 0, zoom: 1.59, panX: 0.37, panY: -0.15, fov: 45 } },
  { name: 'Flat', vals: { tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, zoom: 2, panX: 0, panY: 0, fov: 45 } },
  { name: 'Bottom', vals: { tiltX: -50, tiltY: 1, tiltZ: 0, flap: 0, zoom: 1.5, panX: 0, panY: 0, fov: 45 } },
  { name: 'Detail', vals: { tiltX: 26, tiltY: -22, tiltZ: 1, flap: 0, zoom: 0.8, panX: -0.3, panY: -0.4, fov: 45 } },
]

/** "Reset Camera" target pose. */
export const CAMERA_RESET = { tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: 0, fov: 24, zoom: 4.5, panX: 0, panY: 0 }
