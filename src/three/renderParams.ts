/**
 * RenderParams: the flat, engine-facing frame description. Derived from a
 * RenderState plus per-frame runtime values. The engine consumes ONLY this.
 */

import type { RenderState } from '../state/types'
import { findGradientPreset, type GradientData } from '../lib/presets/gradients'

export interface RenderParams {
  // camera rig
  tiltX: number
  tiltY: number
  tiltZ: number
  zoom: number
  fov: number
  panX: number
  panY: number
  flap: number
  flapX: number
  mockupLift: number

  // DOF
  blurMode: 0 | 1 | 2 // radial | directional | tilt-shift
  blurStrength: number // 0 when state.blurMode === 'none'
  blurBokeh: boolean
  focusX: number
  focusY: number
  focusSize: number
  blurAngle: number // radians
  tiltBand: number
  dirPosition: number
  blurFalloff: number

  // effects
  sharpen: number
  vignette: number
  grain: number
  pixelGrid: number
  caStrength: number
  bloomEnabled: boolean
  bloomStrength: number
  bloomThreshold: number
  bloomRadius: number
  lightingEnabled: boolean
  lightingAngle: number // radians
  lightingIntensity: number
  lightingSoftness: number
  ghostOpacity: number // zeroed unless enabled && mediaIsDark
  ghostOffsetX: number
  ghostOffsetY: number
  ghostBlur: number
  ghostDepth: number
  reflectionStrength: number
  screenGlass: boolean
  screenGlassTarget: 'mockup' | 'frame'
  screenGlassStrength: number
  screenGlassShine: number
  extrudeDepth: number
  extrudeColor: string
  borderRadius: number
  borderStyle: 0 | 2 // none | glass
  glassWidth: number
  glassDark: boolean

  // background
  bgColor: [number, number, number] // sRGB floats 0..1
  bgPresetData: GradientData | null
  bgImageActive: boolean
  transparentBg: boolean
  showCheckerBg: boolean
  environment: string // env preset id or ''
  envLightHeight: number
  envLightX: number
  envLightZ: number

  // device
  mockupModel: string
  deviceFinish: string
  bandColor: string
  laptopHingeAngle: number
  mockupBg: [number, number, number]
  mockupBgImageActive: boolean
  mockupPadding: number
  statusBarEnabled: boolean
  notchEnabled: boolean
  hdrYaw: number
  keyLight: number
  screenGlow: number
  keyLightHeight: number
  keyLightRotation: number
  contactShadow: boolean
  iblIntensity: number
  deviceFeatures: Record<string, boolean>

  // runtime
  time: number
  opacity: number
  mockupOpacity: number
  /** exportWidth / canvasWidth — scales resolution-dependent effects */
  captureScale: number
}

export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const BLUR_MODE_INDEX: Record<string, 0 | 1 | 2> = { none: 0, radial: 0, directional: 1, 'tilt-shift': 2 }

export interface RuntimeOverrides {
  time?: number
  opacity?: number
  mockupOpacity?: number
  captureScale?: number
  showCheckerBg?: boolean
  transparentBg?: boolean
  grain?: number
  blurStrength?: number
  mediaIsDark?: boolean
  extrudeColor?: string
}

/** Build engine params from a control state. */
export function toRenderParams(s: RenderState, rt: RuntimeOverrides = {}): RenderParams {
  const blurOn = s.blurMode !== 'none'
  const strength = rt.blurStrength ?? (blurOn ? s.blurStrength : 0)
  const mediaIsDark = rt.mediaIsDark ?? false
  return {
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    tiltZ: s.tiltZ,
    zoom: s.zoom,
    fov: s.fov,
    panX: s.panX,
    panY: s.panY,
    flap: s.flap,
    flapX: s.flapX,
    mockupLift: s.lift,

    blurMode: BLUR_MODE_INDEX[s.blurMode] ?? 0,
    blurStrength: strength,
    blurBokeh: s.blurBokeh,
    focusX: s.focusX,
    focusY: s.focusY,
    focusSize: s.focusSize,
    blurAngle: (s.blurAngle * Math.PI) / 180,
    tiltBand: s.blurMode === 'tilt-shift' ? s.focusSize : 0.1,
    dirPosition: s.dirPosition,
    blurFalloff: s.blurFalloff,

    sharpen: s.sharpen,
    vignette: s.vignette,
    grain: rt.grain ?? s.grain,
    pixelGrid: s.pixelGrid,
    caStrength: s.caStrength,
    bloomEnabled: s.bloomEnabled,
    bloomStrength: s.bloomStrength,
    bloomThreshold: s.bloomThreshold,
    bloomRadius: s.bloomRadius,
    lightingEnabled: s.lightingEnabled,
    lightingAngle: (s.lightingAngle * Math.PI) / 180,
    lightingIntensity: s.lightingIntensity,
    lightingSoftness: s.lightingSoftness,
    ghostOpacity: s.ghostEnabled && mediaIsDark && !s.mockupModel ? Math.min(0.2, Math.max(0, s.ghostOpacity)) : 0,
    ghostOffsetX: Math.min(0.02, Math.max(-0.02, s.ghostOffsetX)),
    ghostOffsetY: s.ghostOffsetY,
    ghostBlur: s.ghostBlur,
    ghostDepth: s.ghostDepth,
    reflectionStrength: s.reflectionStrength,
    screenGlass: s.screenGlass,
    screenGlassTarget: s.screenGlassTarget,
    screenGlassStrength: s.screenGlassStrength,
    screenGlassShine: s.screenGlassShine,
    extrudeDepth: s.mockupModel ? 0 : s.extrudeDepth,
    extrudeColor: rt.extrudeColor ?? '#808080',
    borderRadius: s.borderRadius,
    borderStyle: s.borderStyle === 'glass' && !s.mockupModel ? 2 : 0,
    glassWidth: s.glassWidth,
    glassDark: s.darkMode,

    bgColor: hexToRgb01(s.bgColor),
    bgPresetData:
      s.bgMode === 'preset' && s.bgPreset ? (findGradientPreset(s.bgPreset)?.data ?? null) : null,
    bgImageActive: s.bgMode === 'image' && !!s.bgImage,
    transparentBg: rt.transparentBg ?? s.transparentBg,
    showCheckerBg: rt.showCheckerBg ?? (s.transparentBg && !(rt.transparentBg === false)),
    environment: s.bgMode === 'environment' ? s.envId : '',
    envLightHeight: s.envLightHeight,
    envLightX: s.envLightX,
    envLightZ: s.envLightZ,

    mockupModel: s.mockupModel,
    deviceFinish: s.deviceFinish,
    bandColor: s.bandColor,
    laptopHingeAngle: s.laptopHingeAngle,
    mockupBg: hexToRgb01(s.mockupBg),
    mockupBgImageActive: s.mockupBgMode === 'image' && !!s.mockupBgImage,
    mockupPadding: Math.min(0.45, Math.max(0, s.mockupPadding)),
    statusBarEnabled: s.statusBarEnabled,
    notchEnabled: s.notchEnabled,
    hdrYaw: s.hdrYaw,
    keyLight: s.keyLight,
    screenGlow: s.screenGlow ?? 0,
    keyLightHeight: s.keyLightHeight,
    keyLightRotation: s.keyLightRotation,
    contactShadow: s.contactShadow,
    iblIntensity: s.iblIntensity,
    deviceFeatures: s.deviceFeatures,

    time: rt.time ?? 0,
    opacity: rt.opacity ?? 1,
    mockupOpacity: rt.mockupOpacity ?? 1,
    captureScale: rt.captureScale ?? 1,
  }
}
