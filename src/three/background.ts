/**
 * In-scene background system.
 *
 * The canvas is opaque (alpha:false); the 2D background is a full-screen quad
 * living INSIDE the WebGL scene on layer 2 with renderOrder −1000. Its vertex
 * shader pins it to the far plane regardless of camera. Modes:
 *   0 = texture (bg image or gradient-preset RT, cover-crop via u_bgUVRect)
 *   1 = checkerboard (transparent-bg editor preview, 20 px cells)
 *   2 = solid color (raw sRGB bytes, decoded to linear in-shader)
 *
 * u_writeAlpha doubles as the render-path signal: 1 on the direct-to-canvas
 * fast path (the shader sRGB-encodes itself and writes alpha 1), 0 on the
 * composer path (linear output with alpha 0, which the patched OutputPass
 * keys on to bypass tone mapping per pixel).
 */

import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { GradientData } from '../lib/presets/gradients'
import type { RenderParams } from './renderParams'

const BG_VERTEX = /* glsl */ `
out vec2 vEmissiveMapUv;
void main() {
  vEmissiveMapUv = uv;
  gl_Position = vec4(position.xy * 2.0, 1.0, 1.0);
}
`

const BG_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vEmissiveMapUv;
out vec4 fragColor;
uniform int u_mode;               // 0 texture, 1 checker, 2 solid
uniform sampler2D u_bgTex;
uniform vec4 u_bgUVRect;          // cover-crop rect (x0, y0, x1, y1)
uniform vec3 u_checkerColorA;
uniform vec3 u_checkerColorB;
uniform vec3 u_solidColor;
uniform float u_cellSize;
uniform float u_writeAlpha;       // 1 = direct path, 0 = composer path

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 outRgb;
  if (u_mode == 2) {
    outRgb = srgbToLinear(u_solidColor);
  } else if (u_mode == 1) {
    vec2 cell = floor(gl_FragCoord.xy / u_cellSize);
    float c = mod(cell.x + cell.y, 2.0);
    outRgb = srgbToLinear(mix(u_checkerColorA, u_checkerColorB, c));
  } else {
    vec2 coverUv = vec2(
      mix(u_bgUVRect.x, u_bgUVRect.z, vEmissiveMapUv.x),
      mix(u_bgUVRect.y, u_bgUVRect.w, vEmissiveMapUv.y)
    );
    outRgb = texture(u_bgTex, coverUv).rgb;
  }
  if (u_writeAlpha > 0.5) outRgb = linearToSrgb(outRgb);
  fragColor = vec4(outRgb, u_writeAlpha);
}
`

/** ≤4 radial layers (≤3 stops each) over a 2-stop linear base. */
const GRADIENT_VERTEX = /* glsl */ `
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const GRADIENT_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

#define MAX_RADIALS 4
#define MAX_STOPS 3

uniform int u_numRadials;
uniform vec2 u_centers[MAX_RADIALS];
uniform vec2 u_sizes[MAX_RADIALS];
uniform int u_stopCounts[MAX_RADIALS];
uniform vec4 u_stops[MAX_RADIALS * MAX_STOPS];
uniform float u_offsets[MAX_RADIALS * MAX_STOPS];

uniform vec4 u_baseColor0;
uniform vec4 u_baseColor1;
uniform float u_baseDirX;
uniform float u_baseDirY;

vec4 sampleRadial(int idx, vec2 uv) {
  vec2 d = (uv - u_centers[idx]) / u_sizes[idx];
  float r = length(d);
  int base = idx * MAX_STOPS;
  int count = u_stopCounts[idx];
  if (r <= u_offsets[base]) return u_stops[base];
  if (r >= u_offsets[base + count - 1]) return u_stops[base + count - 1];
  for (int j = 0; j < MAX_STOPS - 1; j++) {
    if (j >= count - 1) break;
    float o0 = u_offsets[base + j];
    float o1 = u_offsets[base + j + 1];
    if (r >= o0 && r <= o1) {
      float t = (r - o0) / (o1 - o0);
      return mix(u_stops[base + j], u_stops[base + j + 1], t);
    }
  }
  return u_stops[base + count - 1];
}

void main() {
  vec2 uv = v_uv;
  float t = (uv.x - 0.5) * u_baseDirX + (uv.y - 0.5) * u_baseDirY + 0.5;
  t = clamp(t, 0.0, 1.0);
  vec4 color = mix(u_baseColor0, u_baseColor1, t);
  // painted back-to-front: LAST radial first so radial[0] ends up on top
  for (int i = MAX_RADIALS - 1; i >= 0; i--) {
    if (i >= u_numRadials) continue;
    vec4 layer = sampleRadial(i, uv);
    color.rgb = mix(color.rgb, layer.rgb, layer.a);
  }
  fragColor = vec4(color.rgb, 1.0);
}
`

const GRADIENT_RT_W = 1920
const GRADIENT_RT_H = 1080

// checker palettes (raw sRGB bytes / 255)
const CHECKER_LIGHT_A = new THREE.Vector3(0xd5 / 255, 0xd5 / 255, 0xd5 / 255)
const CHECKER_LIGHT_B = new THREE.Vector3(0xe8 / 255, 0xe8 / 255, 0xe8 / 255)
const CHECKER_DARK_A = new THREE.Vector3(0x1a / 255, 0x1a / 255, 0x1a / 255)
const CHECKER_DARK_B = new THREE.Vector3(0x0f / 255, 0x0f / 255, 0x0f / 255)

type BgImageSource = HTMLImageElement | ImageBitmap

function sourceSize(src: BgImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth || src.width || 1, h: src.naturalHeight || src.height || 1 }
  }
  return { w: src.width || 1, h: src.height || 1 }
}

function makeBgTexture(image: TexImageSource): THREE.Texture {
  const tex = new THREE.Texture(image as HTMLImageElement)
  tex.flipY = true
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export class BackgroundSystem {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  private renderer: THREE.WebGLRenderer

  // bg image + CPU blur pipeline
  private imageSource: BgImageSource | null = null
  private imageTexture: THREE.Texture | null = null
  private imageAspect = 16 / 9
  private blurAmount = 0
  private appliedBlur = -1
  private workCanvas: HTMLCanvasElement | null = null

  // gradient preset
  private gradientRT: THREE.WebGLRenderTarget | null = null
  private gradientQuad: FullScreenQuad | null = null
  private gradientMaterial: THREE.ShaderMaterial | null = null
  private appliedPreset: GradientData | null = null
  private hasGradient = false

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer

    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
    white.needsUpdate = true

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        u_mode: { value: 2 },
        u_bgTex: { value: white },
        u_bgUVRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        u_checkerColorA: { value: CHECKER_LIGHT_A.clone() },
        u_checkerColorB: { value: CHECKER_LIGHT_B.clone() },
        u_solidColor: { value: new THREE.Vector3(0.95, 0.95, 0.95) },
        u_cellSize: { value: 20 },
        u_writeAlpha: { value: 1 },
      },
      vertexShader: BG_VERTEX,
      fragmentShader: BG_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000
    this.mesh.layers.set(2)
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms
  }

  /** True when a background image texture is active (glass border samples it). */
  hasImage(): boolean {
    return this.imageTexture !== null
  }

  getImageTexture(): THREE.Texture | null {
    return this.imageTexture
  }

  setWriteAlpha(v: number): void {
    this.material.uniforms.u_writeAlpha.value = v
  }

  /** Set (or clear) the background image. Blur is re-applied CPU-side. */
  setImage(img: BgImageSource | null): void {
    this.imageSource = img
    this.appliedBlur = -1
    if (!img) {
      this.imageTexture?.dispose()
      this.imageTexture = null
      return
    }
    const { w, h } = sourceSize(img)
    this.imageAspect = h > 0 ? w / h : 16 / 9
    this.uploadImage()
  }

  /**
   * CSS-like background blur (`scene.bgBlur` 0–1 → blur(60*bgBlur px)),
   * applied on a 2D canvas and re-uploaded when |Δ| > 0.003.
   */
  setBlur(amount: number): void {
    this.blurAmount = amount
    if (this.imageSource && Math.abs(amount - this.appliedBlur) > 0.003) this.uploadImage()
  }

  private uploadImage(): void {
    const src = this.imageSource
    if (!src) return
    this.imageTexture?.dispose()
    this.imageTexture = null

    const blurPx = 60 * this.blurAmount
    if (blurPx < 0.5) {
      this.imageTexture = makeBgTexture(src as TexImageSource)
      this.appliedBlur = this.blurAmount
      return
    }

    // blur on a work canvas, capped by the GPU texture limit
    const { w, h } = sourceSize(src)
    const maxTex = Math.min(this.renderer.capabilities.maxTextureSize || 4096, 4096)
    const scale = Math.min(1, maxTex / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    if (!this.workCanvas) this.workCanvas = document.createElement('canvas')
    const canvas = this.workCanvas
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.filter = `blur(${(blurPx * scale).toFixed(1)}px)`
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src as CanvasImageSource, 0, 0, cw, ch)
    const tex = makeBgTexture(canvas)
    // the canvas is reused for future blurs; snapshot into the texture now
    tex.image = canvas
    tex.needsUpdate = true
    this.imageTexture = tex
    this.appliedBlur = this.blurAmount
  }

  /** Render a gradient preset once into a 1920×1080 HalfFloat linear RT. */
  private renderGradient(data: GradientData | null): void {
    this.appliedPreset = data
    this.hasGradient = false
    if (!data) return

    if (!this.gradientRT) {
      this.gradientRT = new THREE.WebGLRenderTarget(GRADIENT_RT_W, GRADIENT_RT_H, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      })
    }
    if (!this.gradientMaterial) {
      const MAXR = 4
      const MAXS = 3
      this.gradientMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          u_numRadials: { value: 0 },
          u_centers: { value: Array.from({ length: MAXR }, () => new THREE.Vector2()) },
          u_sizes: { value: Array.from({ length: MAXR }, () => new THREE.Vector2(1, 1)) },
          u_stopCounts: { value: new Array(MAXR).fill(0) },
          u_stops: { value: Array.from({ length: MAXR * MAXS }, () => new THREE.Vector4()) },
          u_offsets: { value: new Array(MAXR * MAXS).fill(0) },
          u_baseColor0: { value: new THREE.Vector4(0, 0, 0, 1) },
          u_baseColor1: { value: new THREE.Vector4(0, 0, 0, 1) },
          u_baseDirX: { value: 0 },
          u_baseDirY: { value: -1 },
        },
        vertexShader: GRADIENT_VERTEX,
        fragmentShader: GRADIENT_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      })
      this.gradientQuad = new FullScreenQuad(this.gradientMaterial)
    }

    const u = this.gradientMaterial.uniforms
    const radials = data.radials.slice(0, 4)
    u.u_numRadials.value = radials.length
    for (let i = 0; i < radials.length; i++) {
      const r = radials[i]
      ;(u.u_centers.value as THREE.Vector2[])[i].set(r.cx, r.cy)
      ;(u.u_sizes.value as THREE.Vector2[])[i].set(r.rx, r.ry)
      const stops = r.stops.slice(0, 3)
      ;(u.u_stopCounts.value as number[])[i] = stops.length
      for (let j = 0; j < stops.length; j++) {
        const s = stops[j]
        ;(u.u_stops.value as THREE.Vector4[])[i * 3 + j].set(s.r, s.g, s.b, s.a)
        ;(u.u_offsets.value as number[])[i * 3 + j] = s.offset
      }
    }
    const base = data.base
    const s0 = base.stops[0]
    const s1 = base.stops[base.stops.length - 1]
    ;(u.u_baseColor0.value as THREE.Vector4).set(s0.r, s0.g, s0.b, s0.a)
    ;(u.u_baseColor1.value as THREE.Vector4).set(s1.r, s1.g, s1.b, s1.a)
    u.u_baseDirX.value = Math.sin(base.angle)
    u.u_baseDirY.value = Math.cos(base.angle)

    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.gradientRT)
    this.gradientQuad!.render(this.renderer)
    this.renderer.setRenderTarget(prev)
    this.hasGradient = true
  }

  /** Per-frame mode dispatch + cover-crop rect. */
  update(params: RenderParams, canvasW: number, canvasH: number): void {
    if (params.bgPresetData !== this.appliedPreset) this.renderGradient(params.bgPresetData)

    const u = this.material.uniforms
    const envActive = params.environment !== ''

    if (params.showCheckerBg && !envActive) {
      // transparent-background editor preview
      this.mesh.visible = true
      u.u_mode.value = 1
      const dark = params.glassDark
      ;(u.u_checkerColorA.value as THREE.Vector3).copy(dark ? CHECKER_DARK_A : CHECKER_LIGHT_A)
      ;(u.u_checkerColorB.value as THREE.Vector3).copy(dark ? CHECKER_DARK_B : CHECKER_LIGHT_B)
      u.u_cellSize.value = 20
      return
    }

    if (envActive || params.transparentBg) {
      // env presets paint their own world; transparent renders nothing behind
      this.mesh.visible = false
      return
    }

    const useImage = params.bgImageActive && this.imageTexture !== null
    const useGradient = !useImage && this.hasGradient && params.bgPresetData !== null
    if (useImage || useGradient) {
      this.mesh.visible = true
      u.u_mode.value = 0
      u.u_bgTex.value = useImage ? this.imageTexture : this.gradientRT!.texture
      const texAspect = useImage ? this.imageAspect : GRADIENT_RT_W / GRADIENT_RT_H
      const canvasAspect = canvasH > 0 ? canvasW / canvasH : 16 / 9
      const rect = u.u_bgUVRect.value as THREE.Vector4
      if (texAspect > canvasAspect) {
        const x0 = (1 - canvasAspect / texAspect) * 0.5
        rect.set(x0, 0, 1 - x0, 1)
      } else {
        const y0 = (1 - texAspect / canvasAspect) * 0.5
        rect.set(0, y0, 1, 1 - y0)
      }
      return
    }

    this.mesh.visible = true
    u.u_mode.value = 2
    ;(u.u_solidColor.value as THREE.Vector3).set(params.bgColor[0], params.bgColor[1], params.bgColor[2])
  }

  dispose(): void {
    this.imageTexture?.dispose()
    ;(this.material.uniforms.u_bgTex.value as THREE.Texture | null)?.dispose?.()
    this.material.dispose()
    this.mesh.geometry.dispose()
    this.gradientRT?.dispose()
    this.gradientMaterial?.dispose()
    this.gradientQuad?.dispose()
  }
}
