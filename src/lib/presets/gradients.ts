/**
 * Gradient background presets. Each has a CSS string (for DOM previews/text
 * shots) and a data form (for GPU/canvas rendering). Radial coordinates are
 * normalized to the frame with y-up (cy measured from the bottom).
 */

export interface GradientStop {
  offset: number
  r: number
  g: number
  b: number
  a: number
}
export interface GradientRadial {
  cx: number
  cy: number
  rx: number
  ry: number
  stops: GradientStop[]
}
export interface GradientData {
  base: { angle: number; stops: GradientStop[] }
  radials: GradientRadial[]
}
export interface GradientPreset {
  id: string
  name: string
  css: string
  data: GradientData
}

function hexStop(offset: number, hex: string, a = 1): GradientStop {
  const v = parseInt(hex.replace('#', '').padEnd(6, hex.replace('#', '')), 16)
  const n = hex.length === 4 ? parseInt(hex.slice(1).split('').map((c) => c + c).join(''), 16) : v
  return { offset, r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a }
}
function rgbaStop(offset: number, r: number, g: number, b: number, a = 1): GradientStop {
  return { offset, r: r / 255, g: g / 255, b: b / 255, a }
}

/** Standard 3-stop alpha ramp used by every multi-radial preset. */
function ramp(cx: number, cy: number, rx: number, ry: number, hex: string, midA: number): GradientRadial {
  const s0 = hexStop(0, hex)
  return {
    cx,
    cy,
    rx,
    ry,
    stops: [s0, { ...s0, offset: 0.45, a: midA }, { ...s0, offset: 0.92, a: 0 }],
  }
}

function cssRadial(rx: number, ry: number, cx: number, cy: number, hex: string, midA: number): string {
  const [r, g, b] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  const x = Math.round(cx * 100)
  const y = Math.round((1 - cy) * 100)
  return `radial-gradient(ellipse ${Math.round(rx * 100)}% ${Math.round(ry * 100)}% at ${x}% ${y}%, ${hex} 0%, rgba(${r},${g},${b},${midA}) 45%, rgba(${r},${g},${b},0) 92%)`
}

interface MultiSpec {
  id: string
  name: string
  baseTop: string
  baseBottom: string
  radials: [number, number, number, number, string, number][] // cx, cy, rx, ry, hex, midAlpha
}

function multi(spec: MultiSpec): GradientPreset {
  const css =
    spec.radials.map(([cx, cy, rx, ry, hex, a]) => cssRadial(rx, ry, cx, cy, hex, a)).join(', ') +
    `, linear-gradient(180deg, ${spec.baseTop} 0%, ${spec.baseBottom} 100%)`
  return {
    id: spec.id,
    name: spec.name,
    css,
    data: {
      base: { angle: Math.PI, stops: [hexStop(0, spec.baseTop), hexStop(1, spec.baseBottom)] },
      radials: spec.radials.map(([cx, cy, rx, ry, hex, a]) => ramp(cx, cy, rx, ry, hex, a)),
    },
  }
}

function linear(id: string, name: string, top: string, bottom: string): GradientPreset {
  return {
    id,
    name,
    css: `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`,
    data: { base: { angle: Math.PI, stops: [hexStop(0, top), hexStop(1, bottom)] }, radials: [] },
  }
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  multi({
    id: 'mono',
    name: 'Mono',
    baseTop: '#000000',
    baseBottom: '#0a0a0e',
    radials: [
      [-0.1, -0.2, 1.5, 1.2, '#d4d8e0', 0.92],
      [0.45, -0.2, 1.2, 1.0, '#e8e2da', 0.88],
      [1.15, -0.05, 1.1, 1.0, '#a8b0bc', 0.85],
      [1.25, 0.45, 0.9, 1.0, '#3a4252', 0.82],
    ],
  }),
  linear('metal', 'Metal', '#b8b8b8', '#2a2a2a'),
  linear('airy', 'Airy', '#ffffff', '#d0d0d0'),
  multi({
    id: 'aurora',
    name: 'Aurora',
    baseTop: '#000000',
    baseBottom: '#0a1535',
    radials: [
      [-0.1, -0.2, 1.5, 1.2, '#00d4ff', 0.92],
      [1.1, -0.1, 1.2, 1.0, '#7040ff', 0.88],
      [1.25, 0.05, 0.9, 0.8, '#c8d4ff', 0.75],
    ],
  }),
  multi({
    id: 'spectrum',
    name: 'Spectrum',
    baseTop: '#000000',
    baseBottom: '#1a0a2a',
    radials: [
      [-0.05, -0.15, 1.4, 1.1, '#00d97a', 0.92],
      [0.4, -0.25, 1.1, 0.95, '#ffb800', 0.88],
      [1.1, -0.05, 1.2, 1.0, '#ff2d8a', 0.88],
      [1.25, 0.45, 0.9, 1.0, '#7c1aff', 0.78],
    ],
  }),
  multi({
    id: 'sunset',
    name: 'Sunset',
    baseTop: '#000000',
    baseBottom: '#2a0810',
    radials: [
      [-0.1, -0.15, 1.4, 1.1, '#ff5050', 0.92],
      [0.45, -0.25, 1.3, 1.0, '#ffb84d', 0.88],
      [1.1, 0.1, 1.2, 1.0, '#ff2d6c', 0.88],
      [1.25, 0.55, 0.85, 0.95, '#b22038', 0.78],
    ],
  }),
  multi({
    id: 'ocean',
    name: 'Ocean',
    baseTop: '#000000',
    baseBottom: '#001528',
    radials: [
      [-0.05, -0.2, 1.5, 1.15, '#00d4ff', 0.92],
      [0.5, -0.15, 1.2, 1.0, '#00e0c4', 0.88],
      [1.15, 0.0, 1.1, 1.0, '#0066ff', 0.88],
      [1.25, 0.5, 0.9, 1.0, '#002a78', 0.82],
    ],
  }),
  multi({
    id: 'violet',
    name: 'Violet',
    baseTop: '#000000',
    baseBottom: '#1a0825',
    radials: [
      [-0.1, -0.2, 1.4, 1.15, '#a64dff', 0.92],
      [0.45, -0.2, 1.2, 1.0, '#ff4dff', 0.88],
      [1.15, -0.05, 1.1, 1.0, '#ff66d4', 0.85],
      [1.25, 0.45, 0.9, 1.0, '#5b00d9', 0.82],
    ],
  }),
  multi({
    id: 'emerald',
    name: 'Emerald',
    baseTop: '#000000',
    baseBottom: '#001f10',
    radials: [
      [-0.1, -0.2, 1.5, 1.2, '#00d97a', 0.92],
      [0.5, -0.2, 1.2, 1.0, '#5eff9c', 0.88],
      [1.15, 0.0, 1.1, 1.0, '#00b386', 0.88],
      [1.2, 0.5, 0.9, 1.0, '#003d22', 0.82],
    ],
  }),
  multi({
    id: 'ember',
    name: 'Ember',
    baseTop: '#000000',
    baseBottom: '#1f0500',
    radials: [
      [-0.05, -0.15, 1.4, 1.1, '#ff8c00', 0.92],
      [0.45, -0.25, 1.2, 1.0, '#ff3d3d', 0.88],
      [1.15, -0.05, 1.1, 1.0, '#ff2d6c', 0.88],
      [1.25, 0.5, 0.85, 0.95, '#6b1500', 0.82],
    ],
  }),
]

export const rgbaStopHelper = rgbaStop // exported for canvas renderer reuse

export function findGradientPreset(id: string): GradientPreset | undefined {
  return GRADIENT_PRESETS.find((p) => p.id === id)
}
