/**
 * Ghost pass: renders a mockup-only copy of the scene (camera layer 0,
 * transparent clear) into `sourceTarget`, then Gaussian-blurs it into the
 * half-res `targetA`. The DoF vertical pass composites the blurred copy
 * additively at a screen-space offset, using `sourceTarget`'s (un-blurred)
 * alpha as a clip mask. Like BloomPass this never swaps composer buffers.
 *
 * The UV offset itself is computed engine-side: an offset authored in the
 * mockup's own plane is rotated by the device quaternion, projected through
 * the live camera, halved to UV scale and clamped to ±0.25.
 */

import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { makeBlurMaterial } from './bloomPass'

const TARGET_OPTS: THREE.RenderTargetOptions = {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  colorSpace: THREE.LinearSRGBColorSpace,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
}

const _clearColor = new THREE.Color()

export class GhostPass extends Pass {
  radius = 0.5

  /** full-res sharp mockup render — its alpha is the composite clip mask */
  readonly sourceTarget: THREE.WebGLRenderTarget
  /** half-res ping-pong; final blurred ghost lives in targetA */
  readonly targetA: THREE.WebGLRenderTarget
  readonly targetB: THREE.WebGLRenderTarget

  private sceneRef: THREE.Scene
  private cameraRef: THREE.PerspectiveCamera
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

    this.blurMaterial = makeBlurMaterial()
    this.quad = new FullScreenQuad(this.blurMaterial)
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

    this.cameraRef.layers.set(0)
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.sourceTarget)
    renderer.clear()
    renderer.render(this.sceneRef, this.cameraRef)

    // blur only (no extract): source → B (horizontal), B → A (vertical)
    const bu = this.blurMaterial.uniforms
    ;(bu.u_texelSize.value as THREE.Vector2).set(1 / this.targetA.width, 1 / this.targetA.height)
    bu.u_radius.value = this.radius
    this.quad.material = this.blurMaterial

    bu.u_texture.value = this.sourceTarget.texture
    ;(bu.u_direction.value as THREE.Vector2).set(1, 0)
    renderer.setRenderTarget(this.targetB)
    this.quad.render(renderer)

    bu.u_texture.value = this.targetB.texture
    ;(bu.u_direction.value as THREE.Vector2).set(0, 1)
    renderer.setRenderTarget(this.targetA)
    this.quad.render(renderer)

    this.cameraRef.layers.mask = prevMask
    renderer.setClearColor(_clearColor, prevAlpha)
    renderer.setRenderTarget(prevTarget)
  }

  override dispose(): void {
    this.sourceTarget.dispose()
    this.targetA.dispose()
    this.targetB.dispose()
    this.blurMaterial.dispose()
    this.quad.dispose()
  }
}
