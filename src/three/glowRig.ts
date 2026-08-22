/**
 * Screen glow: the composited screen content acts as a real light source.
 *
 * Two layers, both driven by the `screenGlow` dial:
 *  - a RectAreaLight sized/posed to the device's screen each frame, tinted by
 *    the average screen color (tiny GPU downsample + 1px readback), so the
 *    body and environment ground pick up broad bounce light;
 *  - a plane-projected reflection injected into body/ground materials
 *    (patchGlowReflection): each fragment reflects its view ray, intersects
 *    the screen plane, and samples a small mipmapped copy of the screen so
 *    the actual content — video included — mirrors off nearby surfaces with
 *    roughness-dependent softness.
 */

import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { LoadedDeviceModel } from './contracts'

export interface GlowUniforms {
  uGlowTex: { value: THREE.Texture | null }
  /** view space -> screen-local space (orthonormal; z = screen normal) */
  uGlowMat: { value: THREE.Matrix4 }
  /** screen half extents in world units */
  uGlowHalf: { value: THREE.Vector2 }
  uGlowStrength: { value: number }
}

const COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`

const COPY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`

const AVG_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 5; y++)
    for (int x = 0; x < 5; x++)
      sum += texture2D(tSrc, vec2((float(x) + 0.5) / 5.0, (float(y) + 0.5) / 5.0)).rgb;
  gl_FragColor = vec4(sum / 25.0, 1.0);
}`

let rectLibReady = false

export class GlowRig {
  readonly uniforms: GlowUniforms = {
    uGlowTex: { value: null },
    uGlowMat: { value: new THREE.Matrix4() },
    uGlowHalf: { value: new THREE.Vector2(1, 1) },
    uGlowStrength: { value: 0 },
  }

  private renderer: THREE.WebGLRenderer
  private light: THREE.RectAreaLight
  private blurRT: THREE.WebGLRenderTarget
  private avgRT: THREE.WebGLRenderTarget
  private copyQuad: FullScreenQuad
  private avgQuad: FullScreenQuad
  private avgPixel = new Uint8Array(4)
  private frame = new THREE.Matrix4()
  private frameInv = new THREE.Matrix4()
  private scratch = new THREE.Matrix4()
  private bbox = new THREE.Box3()
  private cx = new THREE.Vector3()
  private cy = new THREE.Vector3()
  private cz = new THREE.Vector3()
  private center = new THREE.Vector3()
  private localNormal = new THREE.Vector3(0, 0, 1)
  private normalFor: THREE.BufferGeometry | null = null

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer
    if (!rectLibReady) {
      RectAreaLightUniformsLib.init()
      rectLibReady = true
    }
    this.light = new THREE.RectAreaLight(0xffffff, 0, 1, 1)
    this.light.visible = false
    scene.add(this.light)

    this.blurRT = new THREE.WebGLRenderTarget(64, 64, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    })
    this.blurRT.texture.wrapS = THREE.ClampToEdgeWrapping
    this.blurRT.texture.wrapT = THREE.ClampToEdgeWrapping
    this.avgRT = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    })
    this.copyQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null } },
        vertexShader: COPY_VERT,
        fragmentShader: COPY_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.avgQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null } },
        vertexShader: COPY_VERT,
        fragmentShader: AVG_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.uniforms.uGlowTex.value = this.blurRT.texture
  }

  update(
    model: LoadedDeviceModel | null,
    strength: number,
    screenTex: THREE.Texture,
    camera: THREE.Camera,
    /** scene ambient brightness 0-1; glow is a dark-scene phenomenon */
    ambient: number,
  ): void {
    const on = !!model && strength > 0.001
    this.light.visible = on
    if (!on || !model) {
      this.uniforms.uGlowStrength.value = 0
      this.light.intensity = 0
      return
    }

    // small mipmapped copy of the screen (reflection source) + 1px average
    const prev = this.renderer.getRenderTarget()
    const copyMat = this.copyQuad.material as THREE.ShaderMaterial
    copyMat.uniforms.tSrc.value = screenTex
    this.renderer.setRenderTarget(this.blurRT)
    this.copyQuad.render(this.renderer)
    const avgMat = this.avgQuad.material as THREE.ShaderMaterial
    avgMat.uniforms.tSrc.value = this.blurRT.texture
    this.renderer.setRenderTarget(this.avgRT)
    this.avgQuad.render(this.renderer)
    this.renderer.readRenderTargetPixels(this.avgRT, 0, 0, 1, 1, this.avgPixel)
    this.renderer.setRenderTarget(prev)

    // screen frame in world space, from the mesh's local bbox + face normal
    const mesh = model.screenMesh
    mesh.updateWorldMatrix(true, false)
    const geo = mesh.geometry
    if (this.normalFor !== geo) {
      this.normalFor = geo
      geo.computeBoundingBox()
      const n = geo.getAttribute('normal')
      if (n && n.count > 0) this.localNormal.set(n.getX(0), n.getY(0), n.getZ(0)).normalize()
      else this.localNormal.set(0, 0, 1)
    }
    const bb = geo.boundingBox ?? this.bbox.setFromObject(mesh)
    // in-plane axes = the two largest bbox extents
    const size = bb.getSize(this.cx)
    const ext = [size.x, size.y, size.z]
    const nAxis =
      Math.abs(this.localNormal.x) > 0.7 ? 0 : Math.abs(this.localNormal.y) > 0.7 ? 1 : 2
    const axes = [0, 1, 2].filter((a) => a !== nAxis)
    const m = mesh.matrixWorld

    const col = (i: number, out: THREE.Vector3) => out.setFromMatrixColumn(m, i)
    col(axes[0], this.cx)
    col(axes[1], this.cy)
    const halfX = (ext[axes[0]] / 2) * this.cx.length()
    const halfY = (ext[axes[1]] / 2) * this.cy.length()
    this.cx.normalize()
    this.cy.normalize()
    this.cz.copy(this.localNormal).transformDirection(m)
    bb.getCenter(this.center).applyMatrix4(m)

    this.uniforms.uGlowHalf.value.set(Math.max(1e-4, halfX), Math.max(1e-4, halfY))
    this.frame.makeBasis(this.cx, this.cy, this.cz).setPosition(this.center)
    this.frameInv.copy(this.frame).invert()
    // view -> world -> screen-local
    this.uniforms.uGlowMat.value.multiplyMatrices(this.frameInv, this.scratch.copy(camera.matrixWorld))

    // rect light: at the screen, shining along the outward normal
    // (lights aim their local -Z at the lookAt target = emission direction)
    this.light.position.copy(this.center).addScaledVector(this.cz, 0.01)
    this.light.width = halfX * 2
    this.light.height = halfY * 2
    this.light.lookAt(this.cx.copy(this.center).addScaledVector(this.cz, 1))
    const r = this.avgPixel[0] / 255
    const g = this.avgPixel[1] / 255
    const b = this.avgPixel[2] / 255
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    this.light.color.setRGB(
      Math.min(1, r * 1.15 + 0.03),
      Math.min(1, g * 1.15 + 0.03),
      Math.min(1, b * 1.15 + 0.03),
      THREE.SRGBColorSpace,
    )
    // luminance-compensated (bright content tames itself, dark content gets
    // boosted) and ambient-damped: the wash belongs to dark scenes — a lit
    // room drowns screen glow in reality too. The reflection survives bright
    // scenes with milder damping.
    const comp = 0.45 / (0.22 + lum)
    const a2 = ambient * ambient
    this.uniforms.uGlowStrength.value = (strength * (2 - strength) * comp) / (1 + 2.5 * a2)
    this.light.intensity = (Math.pow(strength, 1.5) * 240 * lum * comp) / (1 + 10 * a2)
  }

  dispose(): void {
    this.light.removeFromParent()
    this.blurRT.dispose()
    this.avgRT.dispose()
    this.copyQuad.dispose()
    this.avgQuad.dispose()
  }
}

const GLOW_FRAG_DECL = /* glsl */ `
uniform sampler2D uGlowTex;
uniform mat4 uGlowMat;
uniform vec2 uGlowHalf;
uniform float uGlowStrength;
`

const GLOW_FRAG_APPLY = /* glsl */ `
#include <emissivemap_fragment>
if (uGlowStrength > 0.001) {
  vec3 gP = -vViewPosition;
  vec3 gV = normalize(vViewPosition);
  vec3 gR = reflect(-gV, normal);
  vec3 gO = (uGlowMat * vec4(gP, 1.0)).xyz;
  vec3 gD = mat3(uGlowMat) * gR;
  if (abs(gO.z) > 1e-4 && sign(gD.z) != sign(gO.z)) {
    float gT = -gO.z / gD.z;
    vec2 gHit = gO.xy + gD.xy * gT;
    vec2 gUv = gHit / (2.0 * uGlowHalf) + 0.5;
    vec2 gM = smoothstep(vec2(-0.02), vec2(0.08), gUv) * (vec2(1.0) - smoothstep(vec2(0.92), vec2(1.02), gUv));
    float gMask = gM.x * gM.y;
    if (gMask > 0.001) {
      float gGloss = 1.0 - roughnessFactor;
      vec3 gC = texture2D(uGlowTex, gUv, roughnessFactor * 5.0).rgb;
      float gFres = pow(1.0 - clamp(dot(gV, normal), 0.0, 1.0), 2.0);
      float gFall = 1.0 / (1.0 + 0.25 * gT * gT);
      // energy-conserving glossy blend: the mirror replaces diffuse response
      // instead of stacking on it, so bright content can't blow out the body
      float gW = clamp(uGlowStrength * gMask * gFall * (0.4 + 0.6 * gFres) * gGloss * gGloss * 2.6, 0.0, 0.85);
      totalEmissiveRadiance += gC * gW;
      diffuseColor.rgb *= 1.0 - gW * 0.9;
    }
  }
}
`

/**
 * Inject plane-projected screen reflection into a standard/physical material.
 * Safe on any material; contribution is zero while the glow dial is at 0.
 */
export function patchGlowReflection(
  mat: THREE.Material,
  uniforms: GlowUniforms,
): void {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return
  const marked = mat as THREE.Material & { userData: { openmockGlow?: boolean } }
  if (marked.userData.openmockGlow) return
  marked.userData.openmockGlow = true
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r)
    shader.uniforms.uGlowTex = uniforms.uGlowTex
    shader.uniforms.uGlowMat = uniforms.uGlowMat
    shader.uniforms.uGlowHalf = uniforms.uGlowHalf
    shader.uniforms.uGlowStrength = uniforms.uGlowStrength
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', GLOW_FRAG_DECL + '\nvoid main() {')
      .replace('#include <emissivemap_fragment>', GLOW_FRAG_APPLY)
  }
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => prevKey() + '|omglow'
}

/** Patch every body material of a loaded model (the screen itself excluded). */
export function patchModelGlow(model: LoadedDeviceModel, uniforms: GlowUniforms): void {
  model.wrapper.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || mesh === model.screenMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) patchGlowReflection(m, uniforms)
  })
}
