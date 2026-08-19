/** Studio environment presets (background + ground + lighting bundles). */

export interface LightFormer {
  kind: 'rect'
  position: [number, number, number]
  target: [number, number, number]
  size: [number, number]
  color: string
  intensity: number
}

export interface EnvPreset {
  id: string
  name: string
  hdri: string
  hdriIntensity: number
  toneMappingExposure: number
  bgColor?: string
  fog?: { near: number; far: number; color?: string }
  ground: {
    y: number
    size: number
    collide: boolean
    maps?: {
      albedo: string
      roughness: string
      normal: string
      normalIsDirectX?: boolean
    }
    uvRepeat: number
    uvOffset?: [number, number]
    tint: string
    roughness?: number
    litByIbl?: boolean
  }
  backdrop: { kind: 'cyc'; color: string; z: number; height: number; curveRadius: number } | null
  keyLight: {
    kind: 'spot'
    position: [number, number, number]
    target: [number, number, number]
    color: string
    intensity: number
    angle: number
    penumbra: number
    distance: number
    decay: number
    shadowMapSize: number
    shadowBias: number
    shadowRadius: number
  }
  referenceZoom: number
  lightFormers: LightFormer[]
}

export const ENVIRONMENTS: Record<string, EnvPreset> = {
  'studio-concrete': {
    id: 'studio-concrete',
    name: 'Concrete',
    hdri: '/hdri/studio_small_08_1k.hdr',
    hdriIntensity: 0.22,
    toneMappingExposure: 0.9,
    fog: { near: 20, far: 30, color: '#000000' },
    ground: {
      y: -1.05,
      size: 60,
      collide: true,
      maps: {
        albedo: '/textures/concrete-layers/concrete_layers_02_diff_2k.ktx2',
        roughness: '/textures/concrete-layers/concrete_layers_02_diff_2k.ktx2',
        normal: '/textures/concrete-layers/concrete_layers_02_nor_dx_2k.ktx2',
        normalIsDirectX: true,
      },
      uvRepeat: 8,
      uvOffset: [0.37, 0.41],
      tint: '#a8acb0',
      roughness: 0.88,
    },
    backdrop: { kind: 'cyc', color: '#000000', z: -28, height: 24, curveRadius: 1.4 },
    keyLight: {
      kind: 'spot',
      position: [0, 5, 1.5],
      target: [0, -1.05, -2.5],
      color: '#ffffff',
      intensity: 650,
      angle: Math.PI / 14,
      penumbra: 0.8,
      distance: 30,
      decay: 2,
      shadowMapSize: 4096,
      shadowBias: -5e-4,
      shadowRadius: 8,
    },
    referenceZoom: 2.5,
    lightFormers: [
      { kind: 'rect', position: [0, 8, -1.5], target: [0, -1.05, -2.5], size: [8, 5], color: '#ffffff', intensity: 12 },
      { kind: 'rect', position: [-4, 1.5, 2], target: [0, 0, -2.5], size: [4, 4], color: '#cfd6e0', intensity: 3 },
      { kind: 'rect', position: [3, 1.8, 2.5], target: [0, 0, -2.5], size: [3, 3], color: '#d8d8d8', intensity: 2.2 },
      { kind: 'rect', position: [0, 2, -7], target: [0, 0, -2.5], size: [3, 1.5], color: '#a8c4ff', intensity: 7 },
      { kind: 'rect', position: [0, -0.6, 3.5], target: [0, 0.5, -2.5], size: [4, 1.6], color: '#ffffff', intensity: 2 },
    ],
  },
  'studio-bright': {
    id: 'studio-bright',
    name: 'Studio',
    hdri: '/hdri/studio_small_08_1k.hdr',
    hdriIntensity: 0.28,
    toneMappingExposure: 1,
    bgColor: '#f0f0f0',
    fog: { near: 5, far: 26 },
    ground: { y: -1.05, size: 80, collide: true, uvRepeat: 1, tint: '#f0f0f0', litByIbl: true },
    backdrop: null,
    keyLight: {
      kind: 'spot',
      position: [-2.5, 7.5, 2.5],
      target: [0, -1.05, -2.5],
      color: '#ffffff',
      intensity: 550,
      angle: Math.PI / 6,
      penumbra: 0.85,
      distance: 40,
      decay: 2,
      shadowMapSize: 4096,
      shadowBias: -5e-4,
      shadowRadius: 16,
    },
    referenceZoom: 2.5,
    lightFormers: [
      { kind: 'rect', position: [-3, 8, -1], target: [0, -1.05, -2.5], size: [16, 10], color: '#ffffff', intensity: 14 },
      { kind: 'rect', position: [5, 3, 1], target: [0, 0.5, -2.5], size: [8, 6], color: '#ffffff', intensity: 4.5 },
      { kind: 'rect', position: [0, 1.5, 4], target: [0, 0.5, -2.5], size: [10, 4], color: '#ffffff', intensity: 2 },
      { kind: 'rect', position: [0, 3, -6.5], target: [0, 0.5, -2.5], size: [5, 2], color: '#dce6ff', intensity: 5 },
      { kind: 'rect', position: [0, -0.5, 3.5], target: [0, 0.5, -2.5], size: [6, 2], color: '#ffffff', intensity: 2.5 },
    ],
  },
}

/** Default (non-environment) lighting profile. */
export const LIGHTING_DEFAULTS = {
  hdriPath: '/hdri/brown_photostudio_04_2k.hdr',
  envIntensityMul: 0.8,
  hemiFillIntensity: 0.1,
  defaultEnvRotation: { pitchDeg: -15, yawDeg: 210 },
  contactShadow: {
    lightY: 5,
    lightZ: 5,
    coneDeg: 70,
    mapSize: 512,
    opacity: 0.4,
    penumbra: 1,
    bias: 0.002,
    normalBias: 0,
  },
  materialGrain: { enabled: true, strength: 0.08, tiling: 7 },
}
