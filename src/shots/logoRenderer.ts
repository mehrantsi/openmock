/**
 * Logo-shot renderer: a self-contained WebGL2 pipeline that draws the
 * procedural brand shaders (liquid-metal / gem-smoke / heatmap masked by a
 * shape), an optional uploaded logo image, and the logo post stack from
 * effects.md §12 — half-res luma-threshold bloom (9-tap fixed-weight
 * separable blur), constant-shift chromatic aberration, hash grain and the
 * RGB-triad pixel grid — composited over the shot's background color.
 *
 * Shader field + logo fade/scale/blur through u_shaderOpacity/u_shaderScale
 * (enter/exit animation × transition opacity).
 */

import type { LogoAnimEffect, LogoStyle } from '@/state/types'

export type LogoImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement

export interface LogoRenderOptions {
  logoImage?: LogoImageSource | null
  transitionOpacity?: number
  pixelRatio?: number
  /** scene-local seconds driving enter/exit; defaults to timeSec */
  localSec?: number
  /** shot duration in seconds — required for the exit animation to apply */
  shotDuration?: number
}

/** Default style for a fresh logo shot (ui.md §6). */
export const DEFAULT_LOGO_STYLE: LogoStyle = {
  shader: 'none',
  shape: 'metaballs',
  bgColor: '#0a0a0a',
  theme: 'gold',
  colors: ['#ffd24a', '#e6b85c', '#fff3a0', '#a87a2e'],
  speed: 1,
  scale: 3.5,
  param1: 0.8,
  param2: 0.5,
  effects: { bloom: false, bloomStrength: 1, bloomThreshold: 0.35, bloomRadius: 0.5, grain: 0, caStrength: 0, pixelGrid: 0 },
  enter: { effect: 'fade', duration: 0.4 },
  exit: { effect: 'fade', duration: 0.4 },
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function hexToRgb(hex: string): [number, number, number] {
  let s = hex.replace('#', '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  const n = parseInt(s.slice(0, 6), 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3)
}

interface LogoAnimVisual {
  opacity: number
  scale: number
  /** blur px at a 1080p reference height */
  blur: number
}

function logoEffectVisual(effect: LogoAnimEffect, p: number): LogoAnimVisual {
  switch (effect) {
    case 'fade':
      return { opacity: p, scale: 1, blur: 0 }
    case 'scale-up':
      return { opacity: p, scale: 0.92 + 0.08 * p, blur: 0 }
    case 'scale-down':
      return { opacity: p, scale: 1.08 - 0.08 * p, blur: 0 }
    case 'blur-scale-up':
      return { opacity: p, scale: 0.92 + 0.08 * p, blur: 12 * (1 - p) }
    case 'blur-scale-down':
      return { opacity: p, scale: 1.08 - 0.08 * p, blur: 12 * (1 - p) }
    default:
      return { opacity: 1, scale: 1, blur: 0 }
  }
}

/** Enter/exit sample of the logo/shader layer at `localSec` into the shot. */
export function sampleLogoAnim(style: LogoStyle, localSec: number, shotDuration?: number): LogoAnimVisual {
  const evalAnim = (anim: { effect: LogoAnimEffect; duration: number }, t: number): number => {
    if (anim.effect === 'none' || anim.duration <= 0.001) return 1
    return easeOutCubic(clamp(t / anim.duration, 0, 1))
  }
  const enter = logoEffectVisual(style.enter.effect, evalAnim(style.enter, Math.max(0, localSec)))
  const exit =
    shotDuration != null
      ? logoEffectVisual(style.exit.effect, evalAnim(style.exit, shotDuration - localSec))
      : { opacity: 1, scale: 1, blur: 0 }
  return {
    opacity: enter.opacity * exit.opacity,
    scale: enter.scale * exit.scale,
    blur: enter.blur + exit.blur,
  }
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const VERT_FULLSCREEN = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const VERT_SPRITE = `#version 300 es
layout(location = 0) in vec2 a_position;
uniform vec2 u_half;
uniform vec2 u_res;
uniform vec2 u_offset; // clip-space content offset
uniform float u_rot;   // radians, positive = clockwise on screen
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  vec2 p = a_position * u_half;
  // rotate in square (aspect-corrected) space so the sprite doesn't shear
  float mn = min(u_res.x, u_res.y);
  vec2 sq = p * u_res / mn;
  float cr = cos(u_rot);
  float sr = sin(u_rot);
  sq = mat2(cr, -sr, sr, cr) * sq;
  p = sq * mn / u_res;
  gl_Position = vec4(p + u_offset, 0.0, 1.0);
}
`

const FRAG_SPRITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
  fragColor = texture(u_tex, v_uv);
}
`

/** Procedural field: shader look × shape mask, straight alpha output. */
const FRAG_FIELD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_res;
uniform float u_time;   // seconds, pre-scaled by style speed
uniform int u_shader;   // 1 liquid-metal, 2 gem-smoke, 3 heatmap
uniform int u_shape;    // 0 circle, 1 daisy, 2 diamond, 3 metaballs
uniform float u_scale;  // 0..10
uniform vec2 u_offset;  // content offset in min-dim units
uniform float u_rot;    // radians, positive = clockwise on screen
uniform float u_p1;
uniform float u_p2;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += amp * vnoise(p);
    p = rot * p * 2.03 + 11.5;
    amp *= 0.55;
  }
  return v;
}

vec3 ramp4(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c = mix(u_c0, u_c1, smoothstep(0.0, 0.3333, x));
  c = mix(c, u_c2, smoothstep(0.3333, 0.6667, x));
  c = mix(c, u_c3, smoothstep(0.6667, 1.0, x));
  return c;
}

float shapeMask(vec2 q) {
  float R = 0.11 * u_scale;
  float aa = 1.5 / min(u_res.x, u_res.y);
  if (u_shape == 0) {
    return 1.0 - smoothstep(-aa, aa, length(q) - R);
  }
  if (u_shape == 1) {
    // 8-petal rose curve, slowly rotating
    float th = atan(q.y, q.x) + u_time * 0.15;
    float r = R * (0.62 + 0.38 * cos(8.0 * th));
    return 1.0 - smoothstep(-aa, aa, length(q) - r);
  }
  if (u_shape == 2) {
    return 1.0 - smoothstep(-aa, aa, abs(q.x) + abs(q.y) - R * 0.95);
  }
  // metaballs: 5 orbiting blobs merged by an inverse-square field
  float f = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ph = fi * 2.399 + u_time * (0.35 + 0.13 * fi);
    vec2 c = vec2(cos(ph), sin(ph * 1.31 + fi)) * R * (0.24 + 0.09 * fi);
    float rr = R * (0.34 - 0.025 * fi);
    vec2 d = q - c;
    f += (rr * rr) / max(dot(d, d), 1e-6);
  }
  return smoothstep(0.85, 1.15, f);
}

// Flowing metallic bands: fbm warped by the distortion param, a sharpening
// specular ramp over the 4-color palette; param1 softens the bands.
vec3 liquidMetal(vec2 q) {
  float t = u_time * 0.5;
  vec2 warp = vec2(fbm(q * 2.0 + t * 0.3), fbm(q * 2.0 - t * 0.25 + 7.7));
  vec2 p = q + (warp - 0.5) * (0.6 * u_p2 + 0.08);
  float n = fbm(p * 2.6 + vec2(t * 0.2, -t * 0.15));
  float band = p.x * 1.6 + p.y * 0.9 + n * 3.0 + t * 0.4;
  float wave = 0.5 + 0.5 * sin(band * 6.2831853);
  float soft = mix(7.0, 1.2, clamp(u_p1, 0.0, 1.0));
  float v = pow(wave, soft);
  vec3 col = mix(u_c3, u_c1, smoothstep(0.0, 0.55, v));
  col = mix(col, u_c0, smoothstep(0.35, 0.85, v));
  col = mix(col, u_c2, smoothstep(0.8, 0.98, v));
  col += u_c2 * pow(v, 16.0) * 0.35;
  return col;
}

// Billowing volumetric smoke: domain-warped fbm octaves; param1 lifts the
// glow, param2 drives the warp.
vec3 gemSmoke(vec2 q) {
  float t = u_time * 0.4;
  vec2 warp = vec2(fbm(q * 2.2 + vec2(0.0, t)), fbm(q * 2.2 + vec2(5.2, -t * 0.8)));
  vec2 p = q * 1.8 + (warp - 0.5) * (2.2 * u_p2 + 0.2) + vec2(0.0, -t * 0.6);
  float d = fbm(p + fbm(p * 1.7 + t * 0.15));
  d = smoothstep(0.25, 0.85, d);
  float x = pow(d, mix(1.7, 0.55, clamp(u_p1, 0.0, 1.0)));
  vec3 col = ramp4(x);
  col += u_c2 * pow(x, 6.0) * (0.5 * u_p1);
  return col;
}

// Thermal blobs: a moving metaball intensity field pushed through the
// 4-color heat ramp; param1 = glow gain, param2 = contour banding.
vec3 heatmap(vec2 q) {
  float t = u_time * 0.6;
  float f = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = 0.42 * vec2(sin(t * (0.5 + 0.11 * fi) + fi * 1.9), cos(t * (0.42 + 0.09 * fi) + fi * 3.1));
    vec2 d = q - c;
    f += 0.016 / (dot(d, d) + 0.012);
  }
  float v = clamp(f * 0.55 - 0.15, 0.0, 1.0);
  v = pow(v, mix(1.6, 0.6, clamp(u_p1, 0.0, 1.0)));
  float bands = 9.0;
  float banded = floor(v * bands) / (bands - 1.0);
  v = mix(v, banded, 0.85 * clamp(u_p2, 0.0, 1.0));
  return ramp4(v);
}

void main() {
  vec2 frag = v_uv * u_res;
  vec2 q = (frag - 0.5 * u_res) / min(u_res.x, u_res.y);
  // user placement: inverse-transform the sampling coords (offset in the
  // same min-dim units, rotation opposite to the sprite's geometry rotation)
  q -= u_offset;
  float cr = cos(u_rot);
  float sr = sin(u_rot);
  q = mat2(cr, sr, -sr, cr) * q;
  float m = shapeMask(q);
  if (m <= 0.001) {
    fragColor = vec4(0.0);
    return;
  }
  vec3 col = u_shader == 1 ? liquidMetal(q) : u_shader == 2 ? gemSmoke(q) : heatmap(q);
  fragColor = vec4(col, m);
}
`

/** Luma-threshold bright pass (effects.md §12). */
const FRAG_BRIGHT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(u_threshold, u_threshold + 0.1, luma);
  fragColor = vec4(c.rgb * k, c.a);
}
`

/** 9-tap fixed-weight separable blur; u_radius scales the per-tap UV step. */
const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_direction;
uniform float u_radius;
out vec4 fragColor;
void main() {
  vec2 step0 = u_direction * u_radius;
  vec4 sum = vec4(0.0);
  sum += texture(u_src, v_uv - step0 * 4.0) * 0.0162;
  sum += texture(u_src, v_uv - step0 * 3.0) * 0.0540;
  sum += texture(u_src, v_uv - step0 * 2.0) * 0.1216;
  sum += texture(u_src, v_uv - step0 * 1.0) * 0.1946;
  sum += texture(u_src, v_uv) * 0.2270;
  sum += texture(u_src, v_uv + step0 * 1.0) * 0.1946;
  sum += texture(u_src, v_uv + step0 * 2.0) * 0.1216;
  sum += texture(u_src, v_uv + step0 * 3.0) * 0.0540;
  sum += texture(u_src, v_uv + step0 * 4.0) * 0.0162;
  fragColor = sum;
}
`

/** Final composite over bgColor with CA, bloom add, grain, pixel grid. */
const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_bloom;
uniform vec3 u_bgColor;
uniform float u_transparent; // 1 = no backdrop, premultiplied-alpha output
uniform float u_shaderOpacity;
uniform float u_shaderScale;
uniform float u_blurUv;       // enter/exit blur radius in UV (0 = off)
uniform float u_caStrength;
uniform float u_bloomStrength;
uniform float u_bloomEnabled;
uniform float u_grain;
uniform float u_pixelGrid;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_time;
out vec4 fragColor;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// One tap of the FLATTENED scene: the content layer composited over the
// background color, with the enter/exit fade already applied. Flattening
// before filtering means the blur acts on the whole frame — averaging the
// raw layer instead would pull transparent-black texels into the kernel and
// draw a dark rim around the content's bounding box.
//
// Transparent mode (u_transparent = 1): premultiplied-alpha content instead
// of a flattened frame — averaging premultiplied taps is rim-free too, and
// the canvas (premultipliedAlpha: true) composites the layer over the base.
vec4 flatTap(vec2 uv) {
  vec4 s = texture(u_src, uv);
  float a = clamp(s.a * u_shaderOpacity, 0.0, 1.0);
  vec4 flat0 = vec4(mix(u_bgColor, s.rgb, a), 1.0);
  vec4 premul = vec4(s.rgb * a, a);
  return mix(flat0, premul, u_transparent);
}

vec4 sampleScene(vec2 uv) {
  if (u_blurUv <= 0.0001) return flatTap(uv);
  // two-ring whole-frame blur for the enter/exit blur-scale effects
  float r1 = u_blurUv * 0.5;
  float r2 = u_blurUv;
  vec4 s = flatTap(uv) * 0.2;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982; // 45° steps
    vec2 d = vec2(cos(a), sin(a));
    s += flatTap(uv + d * r1) * 0.05;
    s += flatTap(uv + d * r2) * 0.05;
  }
  return s;
}

void main() {
  vec2 centered = v_uv - 0.5;
  vec2 shaderUv = centered / max(u_shaderScale, 0.001) + 0.5;

  vec4 col = sampleScene(shaderUv);
  if (u_caStrength > 0.0) {
    float caShift = u_caStrength * 0.008; // constant horizontal shift
    float r = sampleScene(shaderUv + vec2(caShift, 0.0)).r;
    float b = sampleScene(shaderUv - vec2(caShift, 0.0)).b;
    col.r = mix(col.r, r, u_caStrength);
    col.b = mix(col.b, b, u_caStrength);
  }

  // additive glow: in premultiplied output rgb may exceed alpha, so the bloom
  // halo brightens whatever the layer composites over
  vec3 bloom = texture(u_bloom, shaderUv).rgb * u_bloomEnabled;
  col.rgb += bloom * u_bloomStrength * u_shaderOpacity;

  if (u_grain > 0.0) {
    float n = rand(fract(v_uv + u_time)) - 0.5;
    col.rgb *= 1.0 + n * u_grain;
  }

  if (u_pixelGrid > 0.0) {
    vec2 px = v_uv * (u_resolution / max(u_pixelRatio, 1.0));
    float colWidth = 1.0;
    float pgColIdx = mod(px.x / colWidth, 3.0);
    vec3 pgMask;
    if (pgColIdx < 1.0)      pgMask = vec3(1.4, 0.8, 0.8);
    else if (pgColIdx < 2.0) pgMask = vec3(0.8, 1.4, 0.8);
    else                     pgMask = vec3(0.8, 0.8, 1.4);
    float pgRowIdx = mod(px.y / colWidth, 3.0);
    float pgGap = pgRowIdx < 2.0 ? 1.0 : (1.0 - 0.5 * u_pixelGrid);
    col.rgb = mix(col.rgb, col.rgb * pgMask * pgGap, u_pixelGrid * 0.7);
  }

  fragColor = vec4(col.rgb, mix(1.0, min(col.a, 1.0), u_transparent));
}
`

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const SHADER_INDEX: Record<LogoStyle['shader'], number> = {
  none: 0,
  'liquid-metal': 1,
  'gem-smoke': 2,
  heatmap: 3,
}
const SHAPE_INDEX: Record<LogoStyle['shape'], number> = {
  circle: 0,
  daisy: 1,
  diamond: 2,
  metaballs: 3,
}

interface Fbo {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}

export class LogoRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject
  private quad: WebGLBuffer
  private progField: WebGLProgram
  private progSprite: WebGLProgram
  private progBright: WebGLProgram
  private progBlur: WebGLProgram
  private progComposite: WebGLProgram
  private uniforms = new Map<string, WebGLUniformLocation | null>()
  private src: Fbo | null = null
  private bloomA: Fbo | null = null
  private bloomB: Fbo | null = null
  private blackTex: WebGLTexture
  private logoTex: WebGLTexture | null = null
  private logoSource: LogoImageSource | null = null
  private logoSize: [number, number] = [0, 0]
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // alpha + premultiplied: transparent logo layers composite correctly when
    // blitted into 2D canvases; opaque frames write alpha 1 and look identical
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
    })
    if (!gl) throw new Error('LogoRenderer: WebGL2 unsupported')
    this.gl = gl

    this.progField = this.link(VERT_FULLSCREEN, FRAG_FIELD, 'field')
    this.progSprite = this.link(VERT_SPRITE, FRAG_SPRITE, 'sprite')
    this.progBright = this.link(VERT_FULLSCREEN, FRAG_BRIGHT, 'bright')
    this.progBlur = this.link(VERT_FULLSCREEN, FRAG_BLUR, 'blur')
    this.progComposite = this.link(VERT_FULLSCREEN, FRAG_COMPOSITE, 'composite')

    const vao = gl.createVertexArray()
    const quad = gl.createBuffer()
    if (!vao || !quad) throw new Error('LogoRenderer: buffer allocation failed')
    this.vao = vao
    this.quad = quad
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const black = gl.createTexture()
    if (!black) throw new Error('LogoRenderer: texture allocation failed')
    this.blackTex = black
    gl.bindTexture(gl.TEXTURE_2D, black)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  }

  // -- GL plumbing ----------------------------------------------------------

  private compile(type: number, source: string, label: string): WebGLShader {
    const gl = this.gl
    const sh = gl.createShader(type)
    if (!sh) throw new Error(`LogoRenderer: could not create ${label} shader`)
    gl.shaderSource(sh, source)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error(`LogoRenderer: ${label} shader compile failed: ${log ?? ''}`)
    }
    return sh
  }

  private link(vert: string, frag: string, label: string): WebGLProgram {
    const gl = this.gl
    const prog = gl.createProgram()
    if (!prog) throw new Error(`LogoRenderer: could not create ${label} program`)
    const vs = this.compile(gl.VERTEX_SHADER, vert, `${label}.vert`)
    const fs = this.compile(gl.FRAGMENT_SHADER, frag, `${label}.frag`)
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(prog)
      gl.deleteProgram(prog)
      throw new Error(`LogoRenderer: ${label} link failed: ${log ?? ''}`)
    }
    return prog
  }

  private loc(prog: WebGLProgram, label: string, name: string): WebGLUniformLocation | null {
    const key = `${label}.${name}`
    if (!this.uniforms.has(key)) this.uniforms.set(key, this.gl.getUniformLocation(prog, name))
    return this.uniforms.get(key) ?? null
  }

  private createFbo(w: number, h: number): Fbo {
    const gl = this.gl
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) throw new Error('LogoRenderer: FBO allocation failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error('LogoRenderer: FBO incomplete')
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fbo, tex, w, h }
  }

  private deleteFbo(f: Fbo | null): void {
    if (!f) return
    this.gl.deleteFramebuffer(f.fbo)
    this.gl.deleteTexture(f.tex)
  }

  private ensureTargets(w: number, h: number): void {
    if (this.src && this.src.w === w && this.src.h === h) return
    this.deleteFbo(this.src)
    this.deleteFbo(this.bloomA)
    this.deleteFbo(this.bloomB)
    const bw = Math.max(1, w >> 1)
    const bh = Math.max(1, h >> 1)
    this.src = this.createFbo(w, h)
    this.bloomA = this.createFbo(bw, bh)
    this.bloomB = this.createFbo(bw, bh)
  }

  private uploadLogo(source: LogoImageSource): void {
    const gl = this.gl
    if (!this.logoTex) {
      const tex = gl.createTexture()
      if (!tex) return
      this.logoTex = tex
    }
    // UNPACK_FLIP_Y_WEBGL is ignored for ImageBitmap sources (their orientation
    // is fixed at creation) — route bitmaps through a 2D canvas so every
    // source type uploads with the same orientation.
    let upload: Exclude<LogoImageSource, ImageBitmap> | HTMLCanvasElement
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
      const c = document.createElement('canvas')
      c.width = source.width
      c.height = source.height
      c.getContext('2d')?.drawImage(source, 0, 0)
      upload = c
    } else {
      upload = source as Exclude<LogoImageSource, ImageBitmap>
    }
    gl.bindTexture(gl.TEXTURE_2D, this.logoTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const iw = source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const ih = source instanceof HTMLImageElement ? source.naturalHeight : source.height
    this.logoSize = [iw, ih]
    this.logoSource = source
  }

  // -- Frame ----------------------------------------------------------------

  render(style: LogoStyle, timeSec: number, opts: LogoRenderOptions = {}): void {
    const gl = this.gl
    if (this.disposed || gl.isContextLost()) return
    const w = this.canvas.width
    const h = this.canvas.height
    if (w < 1 || h < 1) return
    this.ensureTargets(w, h)
    const src = this.src!
    const bloomA = this.bloomA!
    const bloomB = this.bloomB!

    const fxRaw = style.effects ?? DEFAULT_LOGO_STYLE.effects
    const fx = {
      bloom: !!fxRaw.bloom,
      bloomStrength: clamp(fxRaw.bloomStrength ?? 1, 0, 2),
      bloomThreshold: clamp(fxRaw.bloomThreshold ?? 0.35, 0, 1),
      bloomRadius: clamp(fxRaw.bloomRadius ?? 0.5, 0, 1),
      grain: clamp(fxRaw.grain ?? 0, 0, 1),
      caStrength: clamp(fxRaw.caStrength ?? 0, 0, 1),
      pixelGrid: clamp(fxRaw.pixelGrid ?? 0, 0, 1),
    }

    const anim = sampleLogoAnim(style, opts.localSec ?? timeSec, opts.shotDuration)
    const opacity = clamp(anim.opacity * clamp(opts.transitionOpacity ?? 1, 0, 1), 0, 1)
    const fieldTime = timeSec * clamp(style.speed ?? 1, 0, 8)

    // user placement (shared by the shader field and the uploaded logo)
    const posX = clamp(style.posX ?? 0, -1.5, 1.5)
    const posY = clamp(style.posY ?? 0, -1.5, 1.5)
    const rot = ((clamp(style.rotation ?? 0, -180, 180) * Math.PI) / 180)
    const mn = Math.min(w, h)

    gl.bindVertexArray(this.vao)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)

    // 1) procedural field into the source target
    gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo)
    gl.viewport(0, 0, src.w, src.h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (style.shader !== 'none') {
      const p = this.progField
      gl.useProgram(p)
      gl.uniform2f(this.loc(p, 'field', 'u_res'), src.w, src.h)
      gl.uniform1f(this.loc(p, 'field', 'u_time'), fieldTime)
      gl.uniform1i(this.loc(p, 'field', 'u_shader'), SHADER_INDEX[style.shader] ?? 0)
      gl.uniform1i(this.loc(p, 'field', 'u_shape'), SHAPE_INDEX[style.shape] ?? 0)
      gl.uniform1f(this.loc(p, 'field', 'u_scale'), clamp(style.scale ?? 3.5, 0, 10))
      gl.uniform2f(this.loc(p, 'field', 'u_offset'), (posX * 0.5 * src.w) / mn, (posY * 0.5 * src.h) / mn)
      gl.uniform1f(this.loc(p, 'field', 'u_rot'), rot)
      gl.uniform1f(this.loc(p, 'field', 'u_p1'), clamp(style.param1 ?? 0.8, 0, 1))
      gl.uniform1f(this.loc(p, 'field', 'u_p2'), clamp(style.param2 ?? 0.5, 0, 1))
      const cols = style.colors ?? DEFAULT_LOGO_STYLE.colors
      const c0 = hexToRgb(cols[0])
      const c1 = hexToRgb(cols[1])
      const c2 = hexToRgb(cols[2])
      const c3 = hexToRgb(cols[3])
      gl.uniform3f(this.loc(p, 'field', 'u_c0'), c0[0], c0[1], c0[2])
      gl.uniform3f(this.loc(p, 'field', 'u_c1'), c1[0], c1[1], c1[2])
      gl.uniform3f(this.loc(p, 'field', 'u_c2'), c2[0], c2[1], c2[2])
      gl.uniform3f(this.loc(p, 'field', 'u_c3'), c3[0], c3[1], c3[2])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // 2) uploaded logo, centered contain-fit, size driven by style.scale
    const logo = opts.logoImage ?? null
    if (logo) {
      if (logo !== this.logoSource) this.uploadLogo(logo)
      const [iw, ih] = this.logoSize
      if (iw > 0 && ih > 0) {
        const imgAspect = iw / ih
        const cvAspect = src.w / src.h
        // contain box in clip half-extents
        let hx = 1
        let hy = 1
        if (imgAspect > cvAspect) hy = cvAspect / imgAspect
        else hx = imgAspect / cvAspect
        const size = clamp(style.scale ?? 3.5, 0, 10) * 0.09
        const p = this.progSprite
        gl.useProgram(p)
        gl.uniform2f(this.loc(p, 'sprite', 'u_half'), hx * size, hy * size)
        gl.uniform2f(this.loc(p, 'sprite', 'u_res'), src.w, src.h)
        gl.uniform2f(this.loc(p, 'sprite', 'u_offset'), posX, posY)
        gl.uniform1f(this.loc(p, 'sprite', 'u_rot'), rot)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.logoTex)
        gl.uniform1i(this.loc(p, 'sprite', 'u_tex'), 0)
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disable(gl.BLEND)
      }
    }

    // 3) half-res luma-threshold bloom
    if (fx.bloom) {
      const radius = 1 + 6 * fx.bloomRadius
      let p = this.progBright
      gl.useProgram(p)
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo)
      gl.viewport(0, 0, bloomA.w, bloomA.h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src.tex)
      gl.uniform1i(this.loc(p, 'bright', 'u_src'), 0)
      gl.uniform1f(this.loc(p, 'bright', 'u_threshold'), fx.bloomThreshold)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      p = this.progBlur
      gl.useProgram(p)
      // horizontal
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fbo)
      gl.bindTexture(gl.TEXTURE_2D, bloomA.tex)
      gl.uniform1i(this.loc(p, 'blur', 'u_src'), 0)
      gl.uniform2f(this.loc(p, 'blur', 'u_direction'), 1 / bloomA.w, 0)
      gl.uniform1f(this.loc(p, 'blur', 'u_radius'), radius)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      // vertical
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo)
      gl.bindTexture(gl.TEXTURE_2D, bloomB.tex)
      gl.uniform2f(this.loc(p, 'blur', 'u_direction'), 0, 1 / bloomA.h)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // 4) composite to the canvas
    const p = this.progComposite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(this.loc(p, 'composite', 'u_src'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, fx.bloom ? bloomA.tex : this.blackTex)
    gl.uniform1i(this.loc(p, 'composite', 'u_bloom'), 1)
    const bgc = hexToRgb(style.bgColor ?? '#0a0a0a')
    gl.uniform3f(this.loc(p, 'composite', 'u_bgColor'), bgc[0], bgc[1], bgc[2])
    gl.uniform1f(this.loc(p, 'composite', 'u_transparent'), style.transparentBg ? 1 : 0)
    gl.uniform1f(this.loc(p, 'composite', 'u_shaderOpacity'), opacity)
    gl.uniform1f(this.loc(p, 'composite', 'u_shaderScale'), Math.max(anim.scale, 0.001))
    gl.uniform1f(this.loc(p, 'composite', 'u_blurUv'), anim.blur > 0.05 ? anim.blur / 1080 : 0)
    gl.uniform1f(this.loc(p, 'composite', 'u_caStrength'), fx.caStrength)
    gl.uniform1f(this.loc(p, 'composite', 'u_bloomStrength'), fx.bloomStrength)
    gl.uniform1f(this.loc(p, 'composite', 'u_bloomEnabled'), fx.bloom ? 1 : 0)
    gl.uniform1f(this.loc(p, 'composite', 'u_grain'), fx.grain)
    gl.uniform1f(this.loc(p, 'composite', 'u_pixelGrid'), fx.pixelGrid)
    gl.uniform2f(this.loc(p, 'composite', 'u_resolution'), w, h)
    gl.uniform1f(this.loc(p, 'composite', 'u_pixelRatio'), Math.max(opts.pixelRatio ?? 1, 1))
    gl.uniform1f(this.loc(p, 'composite', 'u_time'), timeSec)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** true when the renderer can no longer draw (disposed or GPU-evicted) */
  isLost(): boolean {
    return this.disposed || this.gl.isContextLost()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    this.deleteFbo(this.src)
    this.deleteFbo(this.bloomA)
    this.deleteFbo(this.bloomB)
    this.src = this.bloomA = this.bloomB = null
    if (this.logoTex) gl.deleteTexture(this.logoTex)
    gl.deleteTexture(this.blackTex)
    gl.deleteBuffer(this.quad)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.progField)
    gl.deleteProgram(this.progSprite)
    gl.deleteProgram(this.progBright)
    gl.deleteProgram(this.progBlur)
    gl.deleteProgram(this.progComposite)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

// ---------------------------------------------------------------------------
// Logo rasterization (uploaded PNG / SVG source with optional recolor)
// ---------------------------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load logo image'))
    img.src = url
  })
}

/**
 * Rasterize a logo style's media into a texture-ready source. SVG sources are
 * drawn to a canvas (up to 1024px) and, when svgColor is set, recolored via
 * source-in compositing (preserving alpha).
 */
export async function rasterizeLogo(
  style: Pick<LogoStyle, 'imageUrl' | 'svgSource' | 'svgColor'>,
): Promise<LogoImageSource | null> {
  if (style.svgSource) {
    const blob = new Blob([style.svgSource], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    try {
      const img = await loadImage(url)
      const iw = img.naturalWidth || 512
      const ih = img.naturalHeight || 512
      const scale = Math.min(1024 / Math.max(iw, ih), 4)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(iw * scale))
      canvas.height = Math.max(1, Math.round(ih * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return img
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      if (style.svgColor) {
        ctx.globalCompositeOperation = 'source-in'
        ctx.fillStyle = style.svgColor
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.globalCompositeOperation = 'source-over'
      }
      return canvas
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  if (style.imageUrl) {
    try {
      return await loadImage(style.imageUrl)
    } catch {
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared pooled renderer — ONE WebGL2 context for every logo surface
// (viewport view, picker thumbnails, export frames). Browsers evict WebGL
// contexts once a page holds too many, so per-canvas renderers go blank;
// instead everything renders offscreen here and is blitted into 2D targets.
// ---------------------------------------------------------------------------

let sharedPool: { canvas: HTMLCanvasElement; renderer: LogoRenderer } | null = null

/**
 * Render one logo frame into `target` (a canvas used with a 2D context) at
 * its current width/height. Recovers automatically from GPU context loss.
 * Returns false when WebGL2 is unavailable.
 */
export function renderLogoFrameTo(
  target: HTMLCanvasElement,
  style: LogoStyle,
  timeSec: number,
  opts: LogoRenderOptions = {},
): boolean {
  if (sharedPool && sharedPool.renderer.isLost()) {
    sharedPool.renderer.dispose()
    sharedPool = null
  }
  if (!sharedPool) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, target.width)
    canvas.height = Math.max(1, target.height)
    try {
      sharedPool = { canvas, renderer: new LogoRenderer(canvas) }
    } catch {
      return false
    }
  }
  const { canvas, renderer } = sharedPool
  const w = Math.max(1, target.width)
  const h = Math.max(1, target.height)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  renderer.render(style, timeSec, opts)
  const ctx = target.getContext('2d')
  if (!ctx) return false
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(canvas, 0, 0, w, h)
  return true
}

/**
 * Render a logo-shot frame into `target` (2D canvas) at its current size.
 * Pass `shotDurationSec` to enable the exit animation window.
 */
export function renderLogoShotToCanvas(
  target: HTMLCanvasElement,
  style: LogoStyle,
  timeSec: number,
  logoImage: ImageBitmap | null,
  transitionOpacity: number,
  shotDurationSec?: number,
): void {
  renderLogoFrameTo(target, style, timeSec, {
    logoImage,
    transitionOpacity,
    pixelRatio: 1,
    localSec: timeSec,
    shotDuration: shotDurationSec,
  })
}

/** Free the pooled renderer (e.g. after an export completes). */
export function disposeLogoExportPool(): void {
  sharedPool?.renderer.dispose()
  sharedPool = null
}
