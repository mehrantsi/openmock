/**
 * Custom bloom pass. Unlike UnrealBloom this thresholds SATURATION, not
 * luminance: only saturated colors glow. It renders its own mockup-only copy
 * of the scene (camera layer 0, transparent clear), extracts by saturation,
 * then runs a separable Gaussian at half resolution. The result stays in
 * `targetA` — the DoF vertical pass composites it additively; this pass never
 * swaps composer buffers (needsSwap = false).
 */

import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { PASS_VERTEX } from './dofPass'

const EXTRACT_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_threshold;

void main() {
  vec3 c = texture2D(u_texture, v_uv).rgb;
  float maxc = max(c.r, max(c.g, c.b));
  float minc = min(c.r, min(c.g, c.b));
  float sat = (maxc - minc) / max(maxc, 0.001);
  float mask = smoothstep(u_threshold, u_threshold + 0.1, sat);
  gl_FragColor = vec4(c * mask, 1.0);
}
`

/** Separable Gaussian shared by BloomPass and GhostPass (±14 taps). */
export const SEPARABLE_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_texelSize;
uniform vec2 u_direction;
uniform float u_radius;

void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  float sigma = max(u_radius * 12.0, 0.5);
  float invSigma2 = 1.0 / (2.0 * sigma * sigma);
  for (int i = -14; i <= 14; i++) {
    float x = float(i);
    float w = exp(-x * x * invSigma2);
    vec2 offset = u_direction * (x * u_radius * 4.0) * u_texelSize;
    sum += texture2D(u_texture, v_uv + offset) * w;
    total += w;
  }
  gl_FragColor = sum / total;
}
`

const TARGET_OPTS: THREE.RenderTargetOptions = {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  colorSpace: THREE.LinearSRGBColorSpace,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
}

export function makeBlurMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      u_texture: { value: null },
      u_texelSize: { value: new THREE.Vector2(1, 1) },
      u_direction: { value: new THREE.Vector2(1, 0) },
      u_radius: { value: 0.5 },
    },
    vertexShader: PASS_VERTEX,
    fragmentShader: SEPARABLE_BLUR_FRAGMENT,
    blending: THREE.NoBlending,
    transparent: false,
    depthTest: false,
    depthWrite: false,
  })
}

const _clearColor = new THREE.Color()

export class BloomPass extends Pass {
  threshold = 0.5
  radius = 0.6

  /** full-res mockup-only render (with depth) */
  readonly sourceTarget: THREE.WebGLRenderTarget
  /** half-res ping-pong; final blurred bloom lives in targetA */
  readonly targetA: THREE.WebGLRenderTarget
  readonly targetB: THREE.WebGLRenderTarget

  private sceneRef: THREE.Scene
  private cameraRef: THREE.PerspectiveCamera
  private extractMaterial: THREE.ShaderMaterial
  private blurMaterial: THREE.ShaderMaterial
  private quad: FullScreenQuad

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super()
    this.needsSwap = false
    this.sceneRef = scene
    this.cameraRef = camera

    this.sourceTarget = new THREE.WebGLRenderTarget(1, 1, { ...TARGET_OPTS, depthBuffer: true })
    this.targetA = new THREE.WebGLRenderTarget(1, 1, TARGET_OPTS)
    this.targetB = new THREE.WebGLRenderTarget(1, 1, TARGET_OPTS)

    this.extractMaterial = new THREE.ShaderMaterial({
      uniforms: { u_texture: { value: null }, u_threshold: { value: 0.5 } },
      vertexShader: PASS_VERTEX,
      fragmentShader: EXTRACT_FRAGMENT,
      blending: THREE.NoBlending,
      transparent: false,
      depthTest: false,
      depthWrite: false,
    })
    this.blurMaterial = makeBlurMaterial()
    this.quad = new FullScreenQuad(this.extractMaterial)
  }

  override setSize(width: number, height: number): void {
    const hw = Math.max(1, Math.floor(width / 2))
    const hh = Math.max(1, Math.floor(height / 2))
    this.sourceTarget.setSize(width, height)
    this.targetA.setSize(hw, hh)
    this.targetB.setSize(hw, hh)
  }

  override render(renderer: THREE.WebGLRenderer): void {
    const prevTarget = renderer.getRenderTarget()
    renderer.getClearColor(_clearColor)
    const prevAlpha = renderer.getClearAlpha()
    const prevMask = this.cameraRef.layers.mask

    // mockup/device only — background, glass border, contact plane excluded
    this.cameraRef.layers.set(0)
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.sourceTarget)
    renderer.clear()
    renderer.render(this.sceneRef, this.cameraRef)

    // saturation-threshold extract → targetA (half res)
    this.extractMaterial.uniforms.u_texture.value = this.sourceTarget.texture
    this.extractMaterial.uniforms.u_threshold.value = this.threshold
    this.quad.material = this.extractMaterial
    renderer.setRenderTarget(this.targetA)
    this.quad.render(renderer)

    // separable Gaussian: A → B (horizontal), B → A (vertical)
    const bu = this.blurMaterial.uniforms
    ;(bu.u_texelSize.value as THREE.Vector2).set(1 / this.targetA.width, 1 / this.targetA.height)
    bu.u_radius.value = this.radius
    this.quad.material = this.blurMaterial

    bu.u_texture.value = this.targetA.texture
    ;(bu.u_direction.value as THREE.Vector2).set(1, 0)
    renderer.setRenderTarget(this.targetB)
    this.quad.render(renderer)

    bu.u_texture.value = this.targetB.texture
    ;(bu.u_direction.value as THREE.Vector2).set(0, 1)
    renderer.setRenderTarget(this.targetA)
    this.quad.render(renderer)

    // restore
    this.cameraRef.layers.mask = prevMask
    renderer.setClearColor(_clearColor, prevAlpha)
    renderer.setRenderTarget(prevTarget)
  }

  override dispose(): void {
    this.sourceTarget.dispose()
    this.targetA.dispose()
    this.targetB.dispose()
    this.extractMaterial.dispose()
    this.blurMaterial.dispose()
    this.quad.dispose()
  }
}
