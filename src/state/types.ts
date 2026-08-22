/**
 * Core data model. One project document, JSON-serializable, persisted locally.
 */

export type BlurMode = 'none' | 'radial' | 'directional' | 'tilt-shift'
export type BgMode = 'color' | 'preset' | 'image' | 'environment'
export type BorderStyle = 'none' | 'glass'
export type ScreenGlassTarget = 'mockup' | 'frame'
export type MockupBgMode = 'color' | 'image'

/**
 * The full render/control state ("look"). Snapshotted into shot baseStates and
 * keyframes. All fields JSON-safe.
 */
export interface RenderState {
  // camera rig
  tiltX: number
  tiltY: number
  tiltZ: number
  zoom: number
  fov: number
  panX: number
  panY: number
  flap: number // device rotate Y (deg)
  flapX: number // device rotate X (deg)

  // depth-of-field
  blurMode: BlurMode
  blurStrength: number
  focusX: number
  focusY: number
  focusSize: number
  blurAngle: number // degrees
  dirPosition: number
  blurFalloff: number
  blurBokeh: boolean

  // border
  borderRadius: number
  borderStyle: BorderStyle
  glassWidth: number

  // effects
  extrudeDepth: number // "Depth" (flat only)
  sharpen: number
  vignette: number
  grain: number
  pixelGrid: number
  caStrength: number
  bloomEnabled: boolean
  bloomStrength: number
  bloomThreshold: number
  bloomRadius: number
  lightingEnabled: boolean // "Screen Fade"
  lightingAngle: number // degrees
  lightingIntensity: number
  lightingSoftness: number
  ghostEnabled: boolean
  ghostOpacity: number
  ghostOffsetX: number
  ghostOffsetY: number
  ghostBlur: number
  ghostDepth: number
  reflectionStrength: number
  screenGlass: boolean
  screenGlassTarget: ScreenGlassTarget
  screenGlassStrength: number
  screenGlassShine: number

  // scene / background
  bgMode: BgMode
  bgColor: string
  bgPreset: string // gradient preset id or ''
  bgImage: string | null // url or data-url
  bgBlur: number
  envId: string // environment preset id or ''
  lift: number // mockup height in env scenes
  envLightHeight: number
  envLightX: number
  envLightZ: number
  transparentBg: boolean
  darkMode: boolean

  // device
  mockupModel: string // '' = flat
  deviceFinish: string
  bandColor: string
  laptopHingeAngle: number
  mockupBgMode: MockupBgMode
  mockupBg: string // screen bg color behind media
  mockupBgImage: string | null
  mockupPadding: number
  statusBarEnabled: boolean
  notchEnabled: boolean
  hdrYaw: number
  keyLight: number
  /** screen content as a light source: body + scene glow/reflection (0-1) */
  screenGlow: number
  keyLightHeight: number
  keyLightRotation: number
  contactShadow: boolean
  iblIntensity: number
  deviceFeatures: Record<string, boolean>
}

/** Properties that can be keyframed on the timeline. */
export const CAMERA_PROPS = [
  'tiltX',
  'tiltY',
  'tiltZ',
  'flap',
  'flapX',
  'zoom',
  'fov',
  'panX',
  'panY',
  'hdrYaw',
] as const
export const BLUR_PROPS = [
  'blurStrength',
  'blurFalloff',
  'focusSize',
  'focusX',
  'focusY',
  'blurAngle',
  'dirPosition',
] as const
export const DEVICE_PROPS = ['laptopHingeAngle'] as const
export const ANIMATABLE_PROPS = [...CAMERA_PROPS, ...BLUR_PROPS, ...DEVICE_PROPS] as const
export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number]
export const ANIMATABLE_SET: ReadonlySet<string> = new Set(ANIMATABLE_PROPS)

export const PROP_LABELS: Record<AnimatableProp, string> = {
  zoom: 'Zoom',
  panX: 'Pan X',
  panY: 'Pan Y',
  tiltX: 'Tilt X',
  tiltY: 'Tilt Y',
  tiltZ: 'Roll',
  flap: 'Rotate Y',
  flapX: 'Rotate X',
  fov: 'FOV',
  hdrYaw: 'Light Rotation',
  blurStrength: 'Blur Strength',
  blurFalloff: 'Blur Falloff',
  focusSize: 'Focus Size',
  focusX: 'Focus X',
  focusY: 'Focus Y',
  blurAngle: 'Blur Angle',
  dirPosition: 'Blur Position',
  laptopHingeAngle: 'Lid Angle',
}

/** Display order for timeline property lanes. */
export const PROP_LANE_ORDER: AnimatableProp[] = [
  'zoom',
  'panX',
  'panY',
  'tiltX',
  'tiltY',
  'tiltZ',
  'flap',
  'flapX',
  'fov',
  'hdrYaw',
  'blurStrength',
  'blurFalloff',
  'focusSize',
  'focusX',
  'focusY',
  'blurAngle',
  'dirPosition',
  'laptopHingeAngle',
]

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

export type BezierHandle = [number, number]

export interface Keyframe {
  id: string
  /** normalized 0..1 within the shot (may exceed range after trims) */
  t: number
  /** full state snapshot; only `props` are keyed */
  state: RenderState
  /** which properties this keyframe keys; absent = all camera props */
  props?: AnimatableProp[]
  /** bezier P1 for the segment leaving this keyframe */
  outEasing?: BezierHandle
  /** bezier P2 for the segment entering this keyframe */
  inEasing?: BezierHandle
}

export type Transition = { kind: 'cut' } | { kind: 'fade'; durationMs: number }

export interface VideoTrim {
  sourceIn: number
  sourceOut: number
}

export interface SceneVideo {
  videoId: string
  trim: VideoTrim
  speed: number
  loop: boolean
}

export interface TextStyle {
  content: string
  font: { family: string; weight: number; size: number; align: 'left' | 'center' | 'right'; letterSpacing: number }
  color: string
  bg: TextBg
  enter: TextAnim
  exit: TextAnim
}
export type TextBg =
  | { kind: 'color'; color: string }
  | { kind: 'preset'; presetId: string }
  | { kind: 'image'; imageUrl: string; blur?: number }
  /** no backdrop — the shot composites over whatever plays beneath it */
  | { kind: 'transparent' }
export interface TextAnim {
  effect: 'none' | 'soft-blur' | 'fade-up' | 'scale-up' | 'scale-down' | 'blur-scale-up' | 'blur-scale-down'
  speed: number
  per: 'line' | 'word' | 'character'
}

export interface LogoStyle {
  shader: 'none' | 'liquid-metal' | 'gem-smoke' | 'heatmap'
  shape: 'circle' | 'daisy' | 'diamond' | 'metaballs'
  bgColor: string
  /** render without a backdrop and composite over the shots beneath */
  transparentBg?: boolean
  theme: string
  colors: [string, string, string, string]
  speed: number
  scale: number
  /** content offset in half-frame units (−1 = left/bottom edge, 1 = right/top edge) */
  posX?: number
  posY?: number
  /** degrees, positive = clockwise */
  rotation?: number
  param1: number
  param2: number
  imageUrl?: string | null
  svgSource?: string | null
  svgColor?: string
  effects: {
    bloom: boolean
    bloomStrength: number
    bloomThreshold: number
    bloomRadius: number
    grain: number
    caStrength: number
    pixelGrid: number
  }
  enter: { effect: LogoAnimEffect; duration: number }
  exit: { effect: LogoAnimEffect; duration: number }
}
export type LogoAnimEffect = 'fade' | 'scale-up' | 'scale-down' | 'blur-scale-up' | 'blur-scale-down' | 'none'

export interface Shot {
  id: string
  name: string
  startTime: number // seconds
  duration: number // seconds, [0.1, 180]
  baseState: RenderState | null
  keyframes: Keyframe[]
  transitionOut: Transition
  kind?: 'text' | 'logo' // absent = mockup/media shot
  text?: TextStyle
  logo?: LogoStyle
  video?: SceneVideo
  /** IndexedDB media key of the per-shot screenshot */
  imageKey?: string | null
}

export interface ProjectVideo {
  id: string
  durationSeconds: number
  width: number
  height: number
  name?: string
  byteSize?: number
  /** IndexedDB media key */
  mediaKey?: string
}

export interface ProjectAudio {
  id: string
  durationSeconds: number
  sampleRate: number
  channelCount: number
  name?: string
  byteSize?: number
  mediaKey?: string
}

export interface AudioClip {
  id: string
  audioId: string
  startTime: number
  trim: VideoTrim
  volume: number
  muted: boolean
  fadeIn?: number
  fadeOut?: number
}

export type VideoQuality = 'low' | 'medium' | 'high' | 'ultra'
export type MotionBlurLevel = 'off' | 'low' | 'medium' | 'high'

export interface VideoExportOptions {
  size: string
  customWidth: number
  customHeight: number
  quality: VideoQuality
  fps: 30 | 60
  motionBlur: MotionBlurLevel
}

export interface ImageExportOptions {
  format: 'jpeg' | 'png' | 'webp'
  size: string
  customWidth: number
  customHeight: number
  transparent: boolean
}

export interface Project {
  schemaVersion: number
  openmockVersion: string
  viewportRatio: string
  timeline: {
    scenes: Shot[]
    sequenceDuration: number
    fadeIn: Transition
    fadeOut: Transition
    exportOptions: VideoExportOptions
    audioClips: AudioClip[]
  }
  videos: ProjectVideo[]
  audios: ProjectAudio[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_SHOT_DURATION = 0.1
export const MAX_SHOT_DURATION = 180
export const DEFAULT_SHOT_DURATION = 4
export const DEFAULT_TEXT_SHOT_DURATION = 3
export const DEFAULT_SEQUENCE_DURATION = 12
export const MAX_PROJECT_DURATION = 180
export const MAX_SCENES = 20
export const MAX_PROJECT_VIDEOS = 6
export const MAX_PROJECT_AUDIOS = 4
export const MIN_KF_SEPARATION = 0.02
export const DEFAULT_FADE_MS = 500
export const FADE_DURATION_CHOICES = [250, 500, 1000, 1500]

/** Default render state for a fresh project (light theme, flat mockup). */
export const DEFAULT_RENDER_STATE: RenderState = {
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  zoom: 2,
  fov: 45,
  panX: 0,
  panY: 0,
  flap: 0,
  flapX: 0,

  blurMode: 'none',
  blurStrength: 0,
  focusX: 0.37,
  focusY: 0.5,
  focusSize: 0.5,
  blurAngle: 0,
  dirPosition: 0.5,
  blurFalloff: 0,
  blurBokeh: false,

  borderRadius: 0.02,
  borderStyle: 'none',
  glassWidth: 3,

  extrudeDepth: 0,
  sharpen: 0,
  vignette: 0,
  grain: 0,
  pixelGrid: 0,
  caStrength: 0,
  bloomEnabled: false,
  bloomStrength: 1,
  bloomThreshold: 0.35,
  bloomRadius: 0.5,
  lightingEnabled: false,
  lightingAngle: 135,
  lightingIntensity: 0.45,
  lightingSoftness: 0.5,
  ghostEnabled: false,
  ghostOpacity: 0.05,
  ghostOffsetX: 0,
  ghostOffsetY: 0,
  ghostBlur: 0.2,
  ghostDepth: 0.01,
  reflectionStrength: 0,
  screenGlass: false,
  screenGlassTarget: 'mockup',
  screenGlassStrength: 0.5,
  screenGlassShine: 0.3,

  bgMode: 'color',
  bgColor: '#f2f2f2',
  bgPreset: '',
  bgImage: null,
  bgBlur: 0,
  envId: '',
  lift: 0,
  envLightHeight: 0,
  envLightX: 0,
  envLightZ: 0,
  transparentBg: false,
  darkMode: false,

  mockupModel: '',
  deviceFinish: 'titanium',
  bandColor: '#3b3b3b',
  laptopHingeAngle: 110,
  mockupBgMode: 'color',
  mockupBg: '#1e1e1e',
  mockupBgImage: null,
  mockupPadding: 0, // stock screens fill edge-to-edge; padding is opt-in
  statusBarEnabled: true,
  notchEnabled: true,
  hdrYaw: 190,
  keyLight: 0,
  screenGlow: 0,
  keyLightHeight: 5,
  keyLightRotation: 0,
  contactShadow: false,
  iblIntensity: 1,
  deviceFeatures: {},
}

/** Numeric defaults used when sampling a property with no keyframes. */
export const SAMPLE_DEFAULTS: Record<AnimatableProp, number> = {
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  flap: 0,
  flapX: 0,
  zoom: 2.25,
  fov: 45,
  panX: 0,
  panY: 0,
  hdrYaw: 190,
  blurStrength: 0,
  focusX: 0.5,
  focusY: 0.5,
  focusSize: 0.35,
  blurAngle: 0,
  dirPosition: 0.5,
  blurFalloff: 0,
  laptopHingeAngle: 110,
}
