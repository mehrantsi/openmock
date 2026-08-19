/**
 * Camera animation presets: each replaces the shot's keyframes with the given
 * two-keyframe move. Absolute values win; `d`-prefixed fields would be deltas
 * (none used by the shipped presets).
 */

export interface AnimKfSpec {
  t: number
  tiltX: number
  tiltY: number
  tiltZ: number
  flap: number
  flapX: number
  zoom: number
  fov: number
  panX: number
  panY: number
}

export interface CameraAnimationPreset {
  id: string
  label: string
  defaultDuration: number
  kfSpecs: AnimKfSpec[]
  previewTuning?: Partial<{
    scaleK: number
    fovHalfTanMin: number
    baselineTy: number
    factorXNumerator: number
    factorYNumerator: number
    sizeExponent: number
  }>
}

export const CAMERA_ANIMATION_PRESETS: CameraAnimationPreset[] = [
  {
    id: 'scan-left-to-right',
    label: 'Scan left to right',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: -46.65, tiltY: 42.49, tiltZ: 0, flap: -20, flapX: -1, zoom: 1.785, fov: 24, panX: 0.673, panY: -0.133 },
      { t: 1, tiltX: -46.65, tiltY: 42.49, tiltZ: 0, flap: -20, flapX: -1, zoom: 1.785, fov: 24, panX: 0.054, panY: -0.31 },
    ],
  },
  {
    id: 'left-top-to-bottom',
    label: 'Left – top to bottom',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: 0, zoom: 0.8, fov: 45, panX: 0.536, panY: -0.452 },
      { t: 1, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: 0, zoom: 0.8, fov: 45, panX: 0.544, panY: 0.5 },
    ],
    previewTuning: { scaleK: 1.36, factorXNumerator: 85, factorYNumerator: 116 },
  },
  {
    id: 'low-angle-pan-up',
    label: 'Low-angle pan up',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: -57.83, tiltY: -8.7, tiltZ: 0, flap: -16, flapX: 0, zoom: 1.51, fov: 29, panX: -0.634, panY: -0.082 },
      { t: 1, tiltX: -46.65, tiltY: -7.94, tiltZ: 0, flap: -16, flapX: 0, zoom: 1.51, fov: 25, panX: -0.613, panY: -0.268 },
    ],
  },
  {
    id: 'slow-zoom-out',
    label: 'Slow zoom out',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -14, zoom: 0.715, fov: 45, panX: 0, panY: 0 },
      { t: 1, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -14, zoom: 2.1, fov: 45, panX: 0, panY: 0 },
    ],
    previewTuning: { scaleK: 0.84, factorXNumerator: 85, factorYNumerator: 157, baselineTy: 35.5, sizeExponent: 1.19 },
  },
  {
    id: 'overhead-pan',
    label: 'Overhead pan',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: 24.8, tiltY: 17.04, tiltZ: 0, flap: 18, flapX: -40, zoom: 0.5, fov: 60, panX: -0.065, panY: -0.195 },
      { t: 1, tiltX: 34.19, tiltY: 15.28, tiltZ: 0, flap: 9, flapX: -40, zoom: 0.5, fov: 60, panX: -0.217, panY: -0.476 },
    ],
  },
  {
    id: 'out-and-back',
    label: 'Out and back',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -5, zoom: 0.5, fov: 45, panX: 0, panY: 0 },
      { t: 1, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -21, zoom: 0.6, fov: 45, panX: 0, panY: 0 },
    ],
    previewTuning: { scaleK: 0.72, sizeExponent: 0.49, baselineTy: 42 },
  },
  {
    id: 'fold-up',
    label: 'Fold up',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -42.96, zoom: 2.05, fov: 31, panX: 0, panY: 0 },
      { t: 1, tiltX: 0, tiltY: 0, tiltZ: 0, flap: 0, flapX: -12.01, zoom: 2, fov: 31, panX: 0, panY: -0.179 },
    ],
  },
  {
    id: 'flat-truck',
    label: 'Flat truck',
    defaultDuration: 4,
    kfSpecs: [
      { t: 0, tiltX: -30.29, tiltY: 60, tiltZ: 0, flap: -24, flapX: -39, zoom: 1.99, fov: 13, panX: 0.238, panY: 0.135 },
      { t: 1, tiltX: -30.29, tiltY: 60, tiltZ: 0, flap: -24, flapX: -39, zoom: 1.99, fov: 13, panX: -0.204, panY: 0.039 },
    ],
    previewTuning: { factorXNumerator: 27, factorYNumerator: 38, fovHalfTanMin: 0.12, sizeExponent: 0.85, baselineTy: 24, scaleK: 1.31 },
  },
]
