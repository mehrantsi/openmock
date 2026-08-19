/**
 * Device model registry. All devices are available.
 *
 * Sources: iPhone and MacBook devices load real GLB models. Devices whose
 * original assets aren't redistributable are built procedurally at load time
 * (`procedural`) with matching proportions and materials.
 */

export interface DeviceFeature {
  id: string
  label: string
  defaultOn: boolean
  whenOff?: { levelScreen?: boolean }
}

export interface DeviceHinge {
  openDeg: number
  maxDeg: number
  nudge: { y: number; z: number }
}

export interface MockupModelDef {
  id: string
  label: string
  /** GLB url; empty when procedural */
  url: string
  /** build this device procedurally instead of loading a GLB */
  procedural?: boolean
  screenFit?: 'cover' | 'contain'
  hideMockupPadding?: boolean
  hideMockupBg?: boolean
  /** shader-drawn bezel fraction of face height */
  bezel?: number
  /** shifts media up inside the glass rect */
  screenNudgeY?: number
  notch?: { halfWidth: number; halfHeight: number; fromTop: number }
  /** GLTF node names forming the Dynamic Island (toggleable) */
  notchNodeNames?: string[]
  scaleMultiplier?: number
  features?: DeviceFeature[]
  hasLid?: boolean
  hinge?: DeviceHinge
  bodyMatte?: boolean
  /** finish recolor system to apply */
  finishSystem?: 'iphone17' | 'v2' | 'classified' | 'macbookPro' | 'watch'
  credit?: { title: string; url: string; author: string; license: string }
}

export const MOCKUP_MODELS: Record<string, MockupModelDef> = {
  iphone17: {
    id: 'iphone17',
    label: 'iPhone 17',
    url: '',
    procedural: true,
    screenFit: 'cover',
    hideMockupPadding: true,
    hideMockupBg: true,
    notch: { halfWidth: 0.16, halfHeight: 0.022, fromTop: 0.013 },
    scaleMultiplier: 0.55,
    finishSystem: 'iphone17',
  },
  iphone17Pro: {
    id: 'iphone17Pro',
    label: 'iPhone 17 Pro',
    url: '', // shared procedural body; Pro plateau + finishes via v2 system
    procedural: true,
    screenFit: 'cover',
    hideMockupPadding: true,
    hideMockupBg: true,
    notch: { halfWidth: 0.16, halfHeight: 0.022, fromTop: 0.013 },
    scaleMultiplier: 0.55,
    finishSystem: 'v2',
  },
  iphone17ProMax: {
    id: 'iphone17ProMax',
    label: 'iPhone 17 Pro Max',
    url: '',
    procedural: true,
    screenFit: 'cover',
    hideMockupPadding: true,
    hideMockupBg: true,
    notch: { halfWidth: 0.16, halfHeight: 0.022, fromTop: 0.013 },
    scaleMultiplier: 0.6,
    finishSystem: 'v2',
  },
  watchUltra3: {
    id: 'watchUltra3',
    label: 'Apple Watch Ultra 3',
    url: '',
    procedural: true,
    screenFit: 'cover',
    hideMockupPadding: true,
    hideMockupBg: true,
    scaleMultiplier: 0.68,
    finishSystem: 'watch',
  },
  proDisplayXdr: {
    id: 'proDisplayXdr',
    label: 'XDR Display',
    url: '',
    procedural: true,
    bezel: 0.025,
    bodyMatte: true,
    finishSystem: 'classified',
  },
  ipadPro: {
    id: 'ipadPro',
    label: 'iPad Pro',
    url: '',
    procedural: true,
    features: [{ id: 'caseKeyboard', label: 'Case + Keyboard', defaultOn: false, whenOff: { levelScreen: true } }],
    finishSystem: 'classified',
  },
  macbookPro16M3: {
    id: 'macbookPro16M3',
    label: 'MacBook Pro 16"',
    url: '',
    procedural: true,
    hasLid: true,
    hinge: { openDeg: 110, maxDeg: 135, nudge: { y: 0.006, z: 0.013 } },
    scaleMultiplier: 0.75,
    finishSystem: 'macbookPro',
  },
  macbookPro14: {
    id: 'macbookPro14',
    label: 'MacBook Pro 14"',
    url: '',
    procedural: true,
    hasLid: true,
    hinge: { openDeg: 110, maxDeg: 135, nudge: { y: 0.005, z: 0.013 } },
    scaleMultiplier: 0.68,
    finishSystem: 'macbookPro',
  },
  macbookNeo: {
    id: 'macbookNeo',
    label: 'MacBook Neo',
    url: '',
    procedural: true,
    hasLid: true,
    hinge: { openDeg: 110, maxDeg: 135, nudge: { y: 0.006, z: 0.013 } },
    scaleMultiplier: 0.63,
    finishSystem: 'macbookPro',
  },
}

/** Legacy saved-id aliases. */
export const MODEL_ID_ALIASES: Record<string, string> = {
  iphoneV2: 'iphone17Pro',
  ipadProSpaceBlack: 'ipadPro',
}

export function resolveModelId(id: string): string {
  return MODEL_ID_ALIASES[id] ?? id
}

/** Device picker cards (order matters; Flat card is added first by the UI). */
export interface DeviceCard {
  id: string
  label: string
  resolution: [number, number]
  thumb: string
  icon: 'phone' | 'watch' | 'tablet' | 'laptop' | 'monitor'
}

export const DEVICE_CARDS: DeviceCard[] = [
  { id: 'iphone17', label: 'iPhone 17', resolution: [1206, 2622], thumb: '/device-thumbs/iphone17.png', icon: 'phone' },
  { id: 'iphone17Pro', label: 'iPhone 17 Pro', resolution: [1206, 2622], thumb: '/device-thumbs/iphone17Pro.png', icon: 'phone' },
  { id: 'iphone17ProMax', label: 'iPhone 17 Pro Max', resolution: [1320, 2868], thumb: '/device-thumbs/iphone17ProMax.png', icon: 'phone' },
  { id: 'watchUltra3', label: 'Apple Watch Ultra 3', resolution: [1266, 1542], thumb: '/device-thumbs/watchUltra3.png', icon: 'watch' },
  { id: 'ipadPro', label: 'iPad Pro', resolution: [2752, 2064], thumb: '/device-thumbs/ipadPro.png', icon: 'tablet' },
  { id: 'macbookNeo', label: 'MacBook Neo', resolution: [2408, 1506], thumb: '/device-thumbs/macbookNeo.png', icon: 'laptop' },
  { id: 'macbookPro14', label: 'MacBook Pro 14"', resolution: [3024, 1964], thumb: '/device-thumbs/macbookPro14.png', icon: 'laptop' },
  { id: 'macbookPro16M3', label: 'MacBook Pro 16"', resolution: [3456, 2234], thumb: '/device-thumbs/macbookPro16M3.png', icon: 'laptop' },
  { id: 'proDisplayXdr', label: 'XDR Display', resolution: [5515, 2884], thumb: '/device-thumbs/proDisplayXdr.png', icon: 'monitor' },
]

/** Start-screen chooser cards (device renders wearing their stock screens). */
export const START_CHOICES = [
  { id: 'flat', label: 'Flat', image: '/defaults/cards/flat.jpg', model: '' },
  { id: 'iphone', label: 'iPhone', image: '/defaults/cards/iphone.jpg', model: 'iphone17Pro' },
  { id: 'macbook', label: 'MacBook', image: '/defaults/cards/macbook.jpg', model: 'macbookPro16M3' },
  { id: 'xdr', label: 'Pro Display', image: '/defaults/cards/xdr.jpg', model: 'proDisplayXdr' },
]

/** Finish options per model (first entry = default). */
export const FINISH_OPTIONS: Record<string, { value: string; label: string }[]> = {
  iphone17: [
    { value: 'white', label: 'White' },
    { value: 'black', label: 'Black' },
    { value: 'mistBlue', label: 'Mist Blue' },
    { value: 'sage', label: 'Sage' },
    { value: 'lavender', label: 'Lavender' },
  ],
  iphone17Pro: [
    { value: 'silver', label: 'Silver' },
    { value: 'orange', label: 'Orange' },
    { value: 'matteBlack', label: 'Matte Black' },
    { value: 'titanium', label: 'Titanium' },
  ],
  iphone17ProMax: [
    { value: 'silver', label: 'Silver' },
    { value: 'orange', label: 'Orange' },
    { value: 'matteBlack', label: 'Matte Black' },
    { value: 'titanium', label: 'Titanium' },
  ],
  watchUltra3: [
    { value: 'titanium', label: 'Titanium' },
    { value: 'matteBlack', label: 'Black' },
  ],
  macbookNeo: [
    { value: 'silver', label: 'Silver' },
    { value: 'blush', label: 'Blush' },
    { value: 'citrus', label: 'Citrus' },
    { value: 'indigo', label: 'Indigo' },
  ],
  macbookPro16M3: [
    { value: 'silver', label: 'Silver' },
    { value: 'matteBlack', label: 'Space Black' },
  ],
  macbookPro14: [
    { value: 'matteBlack', label: 'Space Black' },
    { value: 'silver', label: 'Silver' },
  ],
  ipadPro: [
    { value: 'matteBlack', label: 'Space Black' },
    { value: 'silver', label: 'Silver' },
  ],
  proDisplayXdr: [
    { value: 'titanium', label: 'Titanium' },
    { value: 'silver', label: 'Silver' },
    { value: 'matteBlack', label: 'Matte Black' },
  ],
}

export function defaultFinish(modelId: string): string {
  return FINISH_OPTIONS[modelId]?.[0]?.value ?? 'titanium'
}

/** Per-model lighting defaults (iPhone Pro models ship a styled key light). */
export function deviceLightingDefaults(modelId: string): {
  hdrYaw: number
  keyLight: number
  keyLightHeight: number
  keyLightRotation: number
} {
  const isPro = modelId === 'iphone17Pro' || modelId === 'iphone17ProMax'
  return isPro
    ? { hdrYaw: 32, keyLight: 2.35, keyLightHeight: 1.4, keyLightRotation: 130 }
    : { hdrYaw: 190, keyLight: 0, keyLightHeight: 5, keyLightRotation: 0 }
}

/** HDRI pitch per model family (degrees). */
export function deviceHdrPitch(modelId: string): number {
  if (modelId === 'macbookPro16M3') return -42
  if (modelId === 'proDisplayXdr') return -15
  return -10
}
