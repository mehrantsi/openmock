/**
 * Motion blur for video export: a standalone WebGL2 accumulation buffer.
 *
 * Per exported frame the engine renders N camera sub-samples spread across a
 * shutter window; each sample is converted sRGB -> linear and added into an
 * RGBA16F accumulator with its weight riding in the alpha channel
 * (self-normalizing), then a resolve pass divides by the accumulated weight,
 * re-encodes to sRGB and flips vertically for 2D-canvas consumption.
 *
 * The sample count is adaptive: 7 probe sub-times estimate total screen-space
 * motion in pixels from the camera deltas (pan/zoom/tilt/roll/flap/fov);
 * below 0.75 px a single sample is used, otherwise ceil(motion / 1.25)
 * clamped to [2, 32] (16 if the estimate is non-finite).
 *
 * When float render targets are unavailable (or the context is lost) the
 * accumulator degrades gracefully: `available` turns false and the caller
 * exports without blur.
 */

/** Shutter as a fraction of one frame interval, per motion-blur level. */
export const MOTION_BLUR_SHUTTER: Record<'low' | 'medium' | 'high', number> = {
  low: 0.25,
  medium: 0.5, // cinematic 180° shutter
  high: 0.85,
}

/** Probe count used for the adaptive motion estimate. */
export const MOTION_PROBE_COUNT = 7

const MOTION_MIN_PX = 0.75
const MOTION_PX_PER_SAMPLE = 1.25
const MAX_SAMPLES = 32

/** Camera fields that contribute to apparent screen motion (all degrees/world units). */
export interface CameraMotionSample {
  panX: number
  panY: number
  zoom: number
  fov: number
  tiltX: number
  tiltY: number
  tiltZ: number
  flap: number
  flapX: number
}

/**
 * Normalized shot-local sample times across the shutter window centred on
 * `localT`:  t_i = clamp01(localT + shutter/fps/duration * ((i+.5)/n - .5)).
 */
export function shutterSampleTimes(
  localT: number,
  n: number,
  shutterFrac: number,
  fps: number,
  sceneDurationSec: number,
): number[] {
  const windowT = sceneDurationSec > 0 && fps > 0 ? shutterFrac / fps / sceneDurationSec : 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t = localT + windowT * ((i + 0.5) / n - 0.5)
    out.push(Math.min(1, Math.max(0, t)))
  }
  return out
}

const DEG = Math.PI / 180

/**
 * Estimate total screen-space motion (px) across consecutive probe samples.
 *
 * The camera model: `zoom` is the camera distance to the subject, pan is a
 * world-space offset at the subject plane, tilt orbits the camera and
 * flap/flapX spin the device (normalized to ~2 world units max dimension).
 */
export function estimateMotionPx(
  samples: readonly CameraMotionSample[],
  width: number,
  height: number,
): number {
  if (samples.length < 2 || width <= 0 || height <= 0) return 0
  const halfDiag = 0.5 * Math.hypot(width, height)
  let total = 0
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const tanA = Math.tan(Math.min(179, Math.max(1, a.fov)) * DEG * 0.5)
    const tanB = Math.tan(Math.min(179, Math.max(1, b.fov)) * DEG * 0.5)
    const zoomA = Math.max(0.05, Math.abs(a.zoom))
    const zoomB = Math.max(0.05, Math.abs(b.zoom))

    // world units per vertical pixel at the subject plane (pair average)
    const wpp = Math.max(1e-6, (zoomA * tanA + zoomB * tanB) / height)

    // camera translation across the subject plane
    const panPx = Math.hypot(b.panX - a.panX, b.panY - a.panY) / wpp

    // image-scale change from zoom distance and/or fov breathing
    const sA = 1 / (zoomA * tanA)
    const sB = 1 / (zoomB * tanB)
    const zoomPx = (Math.abs(sB - sA) / Math.max(sA, sB)) * halfDiag

    // camera orbit (tilt) — view rotation sweeps the frame
    const orbitPx = (Math.abs(b.tiltX - a.tiltX) + Math.abs(b.tiltY - a.tiltY)) * DEG * (height / 2)

    // roll spins around the frame centre — worst case at the corners
    const rollPx = Math.abs(b.tiltZ - a.tiltZ) * DEG * halfDiag

    // device spin — ~1 world unit half-extent projected to pixels
    const flapPx =
      (Math.abs(b.flap - a.flap) + Math.abs(b.flapX - a.flapX)) * DEG * (0.5 / wpp)

    total += panPx + zoomPx + orbitPx + rollPx + flapPx
  }
  return total
}

/** Adaptive sub-sample count from the motion estimate. */
export function adaptiveSampleCount(motionPx: number): number {
  if (!Number.isFinite(motionPx)) return 16
  if (motionPx < MOTION_MIN_PX) return 1
  return Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(motionPx / MOTION_PX_PER_SAMPLE)))
}

// ---------------------------------------------------------------------------
// WebGL2 accumulation
// ---------------------------------------------------------------------------

const MB_VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`

const COLOR_HELPERS = `
vec3 srgbToLinear(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.04045));
  vec3 linLo = c / 12.92;
  vec3 linHi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(linHi, linLo, vec3(lo));
}
vec3 linearToSrgb(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  vec3 sLo = c * 12.92;
  vec3 sHi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(sHi, sLo, vec3(lo));
}
`

const MB_ACCUMULATE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uWeight;
in vec2 vUv;
out vec4 outColor;
${COLOR_HELPERS}
void main() {
  vec3 c = srgbToLinear(texture(uSrc, vUv).rgb);
  outColor = vec4(c * uWeight, uWeight); // weight rides in alpha, self-normalizing
}
`

const MB_RESOLVE = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
in vec2 vUv;
out vec4 outColor;
${COLOR_HELPERS}
void main() {
  vec4 a = texture(uAccum, vec2(vUv.x, 1.0 - vUv.y));
  vec3 c = a.rgb / max(a.a, 1e-6);
  outColor = vec4(linearToSrgb(c), 1.0);
}
`

function compileProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      console.warn('[export] motion-blur shader compile failed:', gl.getShaderInfoLog(sh))
      gl.deleteShader(sh)
      return null
    }
    return sh
  }
  const vs = compile(gl.VERTEX_SHADER, vertSrc)
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.warn('[export] motion-blur program link failed:', gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

export class MotionBlurAccumulator {
  /** false when float render targets are unavailable or the context was lost */
  available = false
  readonly canvas: HTMLCanvasElement

  private gl: WebGL2RenderingContext | null = null
  private accumProgram: WebGLProgram | null = null
  private resolveProgram: WebGLProgram | null = null
  private srcTex: WebGLTexture | null = null
  private accumTex: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private uWeight: WebGLUniformLocation | null = null
  private uSrc: WebGLUniformLocation | null = null
  private uAccum: WebGLUniformLocation | null = null
  private readonly width: number
  private readonly height: number
  private warnedLost = false

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.width
    this.canvas.height = this.height

    const gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: true,
    }) as WebGL2RenderingContext | null
    if (!gl) {
      console.warn('[export] motion blur unavailable (no WebGL2 context); exporting without blur')
      return
    }
    this.gl = gl

    const floatExt = gl.getExtension('EXT_color_buffer_float')
    const halfExt = floatExt ? null : gl.getExtension('EXT_color_buffer_half_float')
    if (!floatExt && !halfExt) {
      console.warn('[export] motion blur unavailable (no float render targets); exporting without blur')
      return
    }

    this.accumProgram = compileProgram(gl, MB_VERTEX, MB_ACCUMULATE)
    this.resolveProgram = compileProgram(gl, MB_VERTEX, MB_RESOLVE)
    if (!this.accumProgram || !this.resolveProgram) return
    this.uSrc = gl.getUniformLocation(this.accumProgram, 'uSrc')
    this.uWeight = gl.getUniformLocation(this.accumProgram, 'uWeight')
    this.uAccum = gl.getUniformLocation(this.resolveProgram, 'uAccum')

    const makeTex = (): WebGLTexture | null => {
      const tex = gl.createTexture()
      if (!tex) return null
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return tex
    }

    this.srcTex = makeTex()
    if (this.srcTex) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }

    this.accumTex = makeTex()
    if (this.accumTex) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null)
    }

    this.fbo = gl.createFramebuffer()
    if (!this.srcTex || !this.accumTex || !this.fbo) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumTex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[export] motion blur unavailable (accumulation FBO incomplete); exporting without blur')
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)

    this.available = true
  }

  private checkLost(): boolean {
    if (!this.gl) return true
    if (this.gl.isContextLost()) {
      if (!this.warnedLost) {
        this.warnedLost = true
        console.warn('[export] motion-blur context lost; continuing without blur')
      }
      this.available = false
      return true
    }
    return false
  }

  /** Reset the accumulation buffer for a new output frame. */
  begin(): void {
    const gl = this.gl
    if (!this.available || !gl || this.checkLost()) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Add one rendered sub-frame (sRGB canvas) with the given weight. */
  addSample(source: HTMLCanvasElement, weight: number): void {
    const gl = this.gl
    if (!this.available || !gl || this.checkLost()) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.useProgram(this.accumProgram)
    gl.uniform1i(this.uSrc, 0)
    gl.uniform1f(this.uWeight, weight)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Resolve the accumulated frame and draw it into a 2D context at (0,0). */
  resolveTo(ctx: CanvasRenderingContext2D): void {
    const gl = this.gl
    if (!this.available || !gl || this.checkLost()) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.useProgram(this.resolveProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.accumTex)
    gl.uniform1i(this.uAccum, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    ctx.drawImage(this.canvas, 0, 0)
  }

  dispose(): void {
    const gl = this.gl
    this.available = false
    if (!gl) return
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.srcTex) gl.deleteTexture(this.srcTex)
    if (this.accumTex) gl.deleteTexture(this.accumTex)
    if (this.accumProgram) gl.deleteProgram(this.accumProgram)
    if (this.resolveProgram) gl.deleteProgram(this.resolveProgram)
    this.fbo = null
    this.srcTex = null
    this.accumTex = null
    this.accumProgram = null
    this.resolveProgram = null
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.gl = null
  }
}
