/**
 * Flat screen-quad mockup: the media plane shown when no 3D device model is
 * active, plus its satellites — the "Screen Fade" directional light rig, the
 * "Glass" border bezel quad, and the "Depth" extrude backing slab.
 *
 * Plane sizing: PlaneGeometry(1,1) scaled to (2*sx, 2*sy, 1) with
 * sx = aspect > 1 ? 1 : aspect and sy = aspect > 1 ? 1/aspect : 1, so the
 * longest edge is always 2 world units.
 */

import * as THREE from 'three'
import type { RenderParams } from './renderParams'
import { hexToRgb01 } from './renderParams'

/** Reflection parameter profiles swapped by the Reflection dial. */
export const REFLECTION_OFF = { clearcoat: 0.001, clearcoatRoughness: 1, roughness: 1 }
export const REFLECTION_ON = { envMapIntensity: 0.05, clearcoat: 1, clearcoatRoughness: 0, roughness: 1 }

const QUAD_UNIFORM_DECLS = /* glsl */ `
uniform float uBorderRadius;
uniform float uQuadAspect;
uniform float uPixelGrid;
uniform float uLightAngle;
uniform float uLightIntensity;
uniform float uLightSoftness;
`

/** Kills PBR direct specular so screen content stays clean under key lights. */
const KILL_DIRECT_SPECULAR = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.directSpecular = vec3(0.0);
#ifdef USE_CLEARCOAT
clearcoatSpecularDirect = vec3(0.0);
#endif
`

/**
 * Injected before the final color write: RGB subpixel grid, Screen Fade
 * directional darkening (with 1-LSB dither), and rounded-corner SDF alpha.
 */
const QUAD_OUTPUT_INJECT = /* glsl */ `
#ifdef USE_EMISSIVEMAP
vec2 omUv = vEmissiveMapUv;
#else
vec2 omUv = vec2(0.5);
#endif

if (uPixelGrid > 0.0) {
  // surface-space RGB triad, UV-anchored so density scales with zoom
  float pgColIdx = mod(omUv.x * 1350.0, 3.0);
  vec3 pgMask;
  if (pgColIdx < 1.0)      pgMask = vec3(1.4, 0.8, 0.8);
  else if (pgColIdx < 2.0) pgMask = vec3(0.8, 1.4, 0.8);
  else                     pgMask = vec3(0.8, 0.8, 1.4);
  float pgRowIdx = mod(omUv.y * 759.0, 3.0);
  float pgGap = pgRowIdx < 2.0 ? 1.0 : (1.0 - 0.5 * uPixelGrid);
  outgoingLight = mix(outgoingLight, outgoingLight * pgMask * pgGap, uPixelGrid * 0.7);
}

if (uLightIntensity > 0.0) {
  // Screen Fade: darken along a direction, softened edge, then add ±0.5/255
  // of hash noise so 8-bit output does not band
  vec2 lDir = vec2(cos(uLightAngle), sin(uLightAngle));
  float lt = dot(omUv - 0.5, lDir) + 0.5;
  float lFalloff = smoothstep(0.0, 0.5 + uLightSoftness * 0.8, lt);
  outgoingLight *= 1.0 - lFalloff * uLightIntensity * 0.85;
  float lNoise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outgoingLight += vec3((lNoise - 0.5) / 255.0);
}

{
  // rounded-corner cut: SDF in quad-local space with fwidth AA
  vec2 omSz = uQuadAspect >= 1.0 ? vec2(1.0, 1.0 / uQuadAspect) : vec2(uQuadAspect, 1.0);
  vec2 omP = (omUv - 0.5) * 2.0 * omSz;
  float omR = uBorderRadius * min(omSz.x, omSz.y);
  vec2 omQ = abs(omP) - omSz + omR;
  float omSd = length(max(omQ, 0.0)) + min(max(omQ.x, omQ.y), 0.0) - omR;
  float omAa = max(fwidth(omSd), 1e-5);
  diffuseColor.a *= 1.0 - smoothstep(-omAa, omAa, omSd);
}
if (diffuseColor.a < 0.001) discard;
#include <opaque_fragment>
`

const GLASS_VERTEX = /* glsl */ `
varying vec2 v_position;
void main() {
  v_position = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/**
 * Glass border bezel: two rounded-box SDFs (inner = screen edge, outer =
 * bezel edge). Between them the background is refracted with a slight
 * chromatic split, plus a spec streak, bevel darkening and rim highlights.
 * Transparent mode (transparent/checker bg) renders the highlights only.
 */
const GLASS_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 v_position;

uniform vec2 u_innerSize;
uniform vec2 u_outerSize;
uniform float u_innerRadius;
uniform float u_outerRadius;

uniform sampler2D u_bgTex;
uniform vec4 u_bgUVRect;
uniform int u_hasBgTex;
uniform vec3 u_bgColor;
uniform vec2 u_resolution;
uniform int u_isDark;
uniform int u_transparentMode;
uniform float u_opacity;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec2 coverUv(vec2 screenUv, vec4 rect) {
  return vec2(
    mix(rect.x, rect.z, screenUv.x),
    mix(rect.w, rect.y, screenUv.y)
  );
}

void main() {
  float innerSdf = sdRoundedBox(v_position, u_innerSize, u_innerRadius);
  float outerSdf = sdRoundedBox(v_position, u_outerSize, u_outerRadius);

  float aaOuter = max(fwidth(outerSdf), 1e-5);
  float aaInner = max(fwidth(innerSdf), 1e-5);
  float covOuter = 1.0 - smoothstep(-aaOuter, aaOuter, outerSdf);
  float covInner = smoothstep(-aaInner, aaInner, innerSdf);
  float coverage = covOuter * covInner;
  if (coverage <= 0.0) discard;

  float thickness = max(u_outerSize.x - u_innerSize.x, 1e-4);
  float t = clamp(innerSdf / thickness, 0.0, 1.0);

  // SDF gradient = border normal (central differences)
  vec2 dx = vec2(0.003, 0.0);
  vec2 dy = vec2(0.0, 0.003);
  vec2 grad = vec2(
    sdRoundedBox(v_position + dx, u_innerSize, u_innerRadius)
      - sdRoundedBox(v_position - dx, u_innerSize, u_innerRadius),
    sdRoundedBox(v_position + dy, u_innerSize, u_innerRadius)
      - sdRoundedBox(v_position - dy, u_innerSize, u_innerRadius)
  );
  vec2 normal = normalize(grad + vec2(1e-6));

  // refraction flips sign across the border midline
  float refractT = -cos(t * 3.14159265);
  float refractStrength = 0.12 * refractT;

  vec2 screenUv = gl_FragCoord.xy / u_resolution;
  vec2 refractOffset = normal * refractStrength;

  float ca = 0.0035 * abs(refractT);

  vec3 bg = vec3(0.0);
  if (u_transparentMode == 0) {
    if (u_hasBgTex == 1) {
      vec2 rUv = coverUv(screenUv - refractOffset - normal * ca, u_bgUVRect);
      vec2 gUv = coverUv(screenUv - refractOffset,               u_bgUVRect);
      vec2 bUv = coverUv(screenUv - refractOffset + normal * ca, u_bgUVRect);
      bg.r = texture2D(u_bgTex, rUv).r;
      bg.g = texture2D(u_bgTex, gUv).g;
      bg.b = texture2D(u_bgTex, bUv).b;
    } else {
      bg = u_bgColor;
    }
  }

  vec2 lightDir = normalize(vec2(-0.55, 0.85));
  float NdotL = max(dot(normal, lightDir), 0.0);
  float spec = pow(NdotL, 2.0);
  spec *= (1.0 - 0.85 * smoothstep(0.2, 0.5, abs(t - 0.5)));

  float outerEdgeDist = -outerSdf;
  float bevel = pow(1.0 - smoothstep(0.0, 0.012, outerEdgeDist), 1.5);

  float outerRim = 1.0 - smoothstep(0.0, 0.0025, outerEdgeDist);
  float innerRim = 1.0 - smoothstep(0.0, 0.002, innerSdf);

  vec3 lightContrib =
      spec * vec3(1.0, 1.0, 1.02) * (u_isDark == 1 ? 0.55 : 0.45)
    + outerRim * vec3(1.0) * (u_isDark == 1 ? 0.45 : 0.35)
    + innerRim * vec3(1.0) * (u_isDark == 1 ? 0.20 : 0.15);

  vec3 color;
  float alpha;
  if (u_transparentMode == 1) {
    color = lightContrib;
    alpha = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
  } else {
    color = bg;
    color *= 1.0 - bevel * 0.22;
    color += lightContrib;
    alpha = 1.0;
  }

  alpha *= coverage;
  alpha *= u_opacity;
  gl_FragColor = vec4(color, alpha);
}
`

/** Rounded-rect outline with quadratic-curve corners (extrude slab profile). */
function roundedRectShape(hw: number, hh: number, radius: number): THREE.Shape {
  const r = Math.min(radius, 0.999 * Math.min(hw, hh))
  const s = new THREE.Shape()
  s.moveTo(-hw + r, hh)
  s.lineTo(hw - r, hh)
  s.quadraticCurveTo(hw, hh, hw, hh - r)
  s.lineTo(hw, -hh + r)
  s.quadraticCurveTo(hw, -hh, hw - r, -hh)
  s.lineTo(-hw + r, -hh)
  s.quadraticCurveTo(-hw, -hh, -hw, -hh + r)
  s.lineTo(-hw, hh - r)
  s.quadraticCurveTo(-hw, hh, -hw + r, hh)
  return s
}

export interface FlatUpdateContext {
  lift: number
  flapQuat: THREE.Quaternion
  modelActive: boolean
  envActive: boolean
  canvasWidth: number
  canvasHeight: number
  /** default IBL PMREM texture (null before it exists) */
  envTex: THREE.Texture | null
  /** 1×1 transparent-black texture that suppresses IBL */
  noIblTex: THREE.Texture
  bgUniforms: Record<string, THREE.IUniform>
  bgHasImage: boolean
}

interface OpacityMaterial extends THREE.Material {
  __omOrigTransparent?: boolean
}

export class FlatMockup {
  readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>
  readonly glassMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  readonly extrudeMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  readonly fadeGroup: THREE.Group

  /** half extents of the media plane (world units) */
  halfW = 1
  halfH = 9 / 16

  private fadeLight: THREE.DirectionalLight
  private aspect = 16 / 9
  private hasMedia = false
  private quadUniforms: Record<string, THREE.IUniform> = {
    uBorderRadius: { value: 0.02 },
    uQuadAspect: { value: 16 / 9 },
    uPixelGrid: { value: 0 },
    uLightAngle: { value: 0 },
    uLightIntensity: { value: 0 },
    uLightSoftness: { value: 0.5 },
  }
  private glassUniforms: Record<string, THREE.IUniform>
  private wasTranslucent = false
  private extrudeKey = { hw: -1, hh: -1, radius: -1 }
  private extrudeColorHex = ''

  constructor() {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      roughness: 0.2,
      metalness: 0,
      clearcoat: 0.001,
      clearcoatRoughness: 0.06,
      envMapIntensity: 0,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    })
    const uniforms = this.quadUniforms
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.fragmentShader = QUAD_UNIFORM_DECLS + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_end>', KILL_DIRECT_SPECULAR)
        .replace('#include <opaque_fragment>', QUAD_OUTPUT_INJECT)
    }
    mat.customProgramCacheKey = () => 'openmock-flat-quad'

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    this.quad.rotation.order = 'YXZ'
    this.quad.renderOrder = 0
    this.quad.castShadow = true
    this.quad.visible = false

    // Screen Fade light rig: rotates with the DEVICE (flap), not the camera
    this.fadeGroup = new THREE.Group()
    this.fadeLight = new THREE.DirectionalLight(0xffffff, 0)
    const fadeTarget = new THREE.Object3D()
    this.fadeLight.target = fadeTarget
    this.fadeGroup.add(this.fadeLight)
    this.fadeGroup.add(fadeTarget)

    // glass border bezel
    this.glassUniforms = {
      u_innerSize: { value: new THREE.Vector2(1, 9 / 16) },
      u_outerSize: { value: new THREE.Vector2(1.03, 9 / 16 + 0.03) },
      u_innerRadius: { value: 0.02 },
      u_outerRadius: { value: 0.041 },
      u_bgTex: { value: null },
      u_bgUVRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      u_hasBgTex: { value: 0 },
      u_bgColor: { value: new THREE.Color(0, 0, 0) },
      u_resolution: { value: new THREE.Vector2(1, 1) },
      u_isDark: { value: 0 },
      u_transparentMode: { value: 0 },
      u_opacity: { value: 1 },
    }
    const glassMat = new THREE.ShaderMaterial({
      uniforms: this.glassUniforms,
      vertexShader: GLASS_VERTEX,
      fragmentShader: GLASS_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this.glassMesh = new THREE.Mesh(new THREE.PlaneGeometry((1 + 0.1) * 2, (9 / 16 + 0.1) * 2), glassMat)
    this.glassMesh.renderOrder = 1
    this.glassMesh.frustumCulled = false
    this.glassMesh.layers.set(2)
    this.glassMesh.visible = false

    // extrude backing slab
    const extrudeMat = new THREE.MeshStandardMaterial({
      color: 0x808080,
      roughness: 0.55,
      metalness: 0.05,
      envMapIntensity: 0.25,
      side: THREE.DoubleSide,
    })
    this.extrudeMesh = new THREE.Mesh(new THREE.BufferGeometry(), extrudeMat)
    this.extrudeMesh.renderOrder = 0
    this.extrudeMesh.frustumCulled = false
    this.extrudeMesh.visible = false
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.quad)
    scene.add(this.fadeGroup)
    scene.add(this.glassMesh)
    scene.add(this.extrudeMesh)
  }

  /** Assign the shared media texture as the quad's emissive map. */
  setMediaTexture(tex: THREE.Texture | null): void {
    const mat = this.quad.material
    const hadMap = !!mat.emissiveMap
    const wasVideo = mat.emissiveMap instanceof THREE.VideoTexture
    mat.emissiveMap = tex
    this.hasMedia = !!tex
    if (hadMap !== !!tex || wasVideo !== tex instanceof THREE.VideoTexture) mat.needsUpdate = true
  }

  /** Rescale the plane for a new media aspect (longest edge = 2 units). */
  setAspect(aspect: number): void {
    if (!(aspect > 0) || !Number.isFinite(aspect)) aspect = 16 / 9
    if (aspect === this.aspect) return
    this.aspect = aspect
    this.halfW = aspect > 1 ? 1 : aspect
    this.halfH = aspect > 1 ? 1 / aspect : 1
    this.quad.scale.set(2 * this.halfW, 2 * this.halfH, 1)
    this.glassMesh.geometry.dispose()
    this.glassMesh.geometry = new THREE.PlaneGeometry((this.halfW + 0.1) * 2, (this.halfH + 0.1) * 2)
  }

  update(params: RenderParams, ctx: FlatUpdateContext): void {
    const { modelActive } = ctx
    const quad = this.quad
    const mat = quad.material

    quad.scale.set(2 * this.halfW, 2 * this.halfH, 1)
    quad.position.set(0, ctx.lift, 0)
    quad.quaternion.copy(ctx.flapQuat)
    quad.visible = !modelActive && this.hasMedia

    // injected uniforms
    this.quadUniforms.uBorderRadius.value = params.borderRadius
    this.quadUniforms.uQuadAspect.value = this.aspect
    this.quadUniforms.uPixelGrid.value = params.pixelGrid

    // Screen Fade rig + uniforms
    const fadeOn = params.lightingEnabled && params.lightingIntensity > 1e-4
    const a = params.lightingAngle
    this.fadeGroup.quaternion.copy(ctx.flapQuat)
    this.fadeGroup.position.copy(quad.position)
    this.fadeLight.position.set(5 * Math.cos(a), 5 * Math.sin(a), 5)
    this.fadeLight.intensity = fadeOn ? 1.4 * params.lightingIntensity : 0
    this.quadUniforms.uLightAngle.value = a
    this.quadUniforms.uLightIntensity.value = fadeOn ? params.lightingIntensity : 0
    this.quadUniforms.uLightSoftness.value = params.lightingSoftness

    // reflection profile
    const reflectOn = params.reflectionStrength > 0
    const strength = reflectOn ? Math.max(0, Math.min(1, params.reflectionStrength)) : 0
    mat.envMapIntensity = strength * REFLECTION_ON.envMapIntensity
    mat.clearcoat = reflectOn ? REFLECTION_ON.clearcoat : Math.max(0.001, REFLECTION_OFF.clearcoat)
    mat.clearcoatRoughness = reflectOn ? REFLECTION_ON.clearcoatRoughness : REFLECTION_OFF.clearcoatRoughness
    mat.roughness = reflectOn ? REFLECTION_ON.roughness : REFLECTION_OFF.roughness
    const wantedEnv = ctx.envActive || modelActive ? null : reflectOn ? ctx.envTex : ctx.noIblTex
    if (mat.envMap !== wantedEnv) {
      mat.envMap = wantedEnv
      mat.needsUpdate = true
    }

    // glass border bezel (flat mockups only)
    const glassOn = !modelActive && this.hasMedia && params.borderStyle === 2
    if (glassOn) {
      this.glassMesh.position.copy(quad.position)
      this.glassMesh.quaternion.copy(ctx.flapQuat)
      this.glassMesh.visible = true
      const transparentMode = params.transparentBg || params.showCheckerBg
      const u = this.glassUniforms
      const inset = Math.max(0, Math.min(0.1, 0.01 * params.glassWidth))
      ;(u.u_innerSize.value as THREE.Vector2).set(this.halfW, this.halfH)
      ;(u.u_outerSize.value as THREE.Vector2).set(this.halfW + inset, this.halfH + inset)
      const innerRadius = params.borderRadius * Math.min(this.halfW, this.halfH)
      u.u_innerRadius.value = innerRadius
      u.u_outerRadius.value = innerRadius + 0.7 * inset
      u.u_bgTex.value = ctx.bgUniforms.u_bgTex.value
      ;(u.u_bgUVRect.value as THREE.Vector4).copy(ctx.bgUniforms.u_bgUVRect.value as THREE.Vector4)
      u.u_hasBgTex.value = ctx.bgHasImage && !transparentMode ? 1 : 0
      ;(u.u_bgColor.value as THREE.Color).setRGB(
        params.bgColor[0],
        params.bgColor[1],
        params.bgColor[2],
        THREE.SRGBColorSpace,
      )
      ;(u.u_resolution.value as THREE.Vector2).set(ctx.canvasWidth, ctx.canvasHeight)
      u.u_isDark.value = params.glassDark ? 1 : 0
      u.u_transparentMode.value = transparentMode ? 1 : 0
    } else {
      this.glassMesh.visible = false
    }

    // extrude backing slab (flat mockups only)
    if (!modelActive && this.hasMedia && params.extrudeDepth > 0.001) {
      const radius = params.borderRadius * Math.min(this.halfW, this.halfH)
      const k = this.extrudeKey
      if (k.hw !== this.halfW || k.hh !== this.halfH || k.radius !== radius) {
        this.extrudeMesh.geometry.dispose()
        this.extrudeMesh.geometry = new THREE.ExtrudeGeometry(
          roundedRectShape(this.halfW, this.halfH, radius),
          { depth: 1, bevelEnabled: false, curveSegments: 12 },
        )
        k.hw = this.halfW
        k.hh = this.halfH
        k.radius = radius
      }
      this.extrudeMesh.position.copy(quad.position)
      this.extrudeMesh.position.z -= 0.001
      this.extrudeMesh.quaternion.copy(ctx.flapQuat)
      this.extrudeMesh.scale.set(1, 1, -(0.3 * params.extrudeDepth))
      if (params.extrudeColor !== this.extrudeColorHex) {
        // vendor parity: raw 0-1 floats assigned without sRGB→linear conversion
        const [r, g, b] = hexToRgb01(params.extrudeColor)
        this.extrudeMesh.material.color.setRGB(r, g, b)
        this.extrudeColorHex = params.extrudeColor
      }
      this.extrudeMesh.visible = true
    } else {
      this.extrudeMesh.visible = false
    }
  }

  /**
   * Mockup-opacity handling for the flat path: drives material opacity on the
   * quad + slab and the glass shader's u_opacity. (With a 3D model, opacity
   * is handled by the two-target crossfade in the engine instead.)
   */
  applyMockupOpacity(opacity: number, modelActive: boolean): void {
    const a = Math.max(0, Math.min(1, opacity))
    this.glassUniforms.u_opacity.value = a
    if (modelActive) return
    const translucent = opacity < 1
    if (!translucent && !this.wasTranslucent) return
    const flip = translucent !== this.wasTranslucent
    const applyTo = (m: OpacityMaterial) => {
      m.opacity = a
      if (flip) {
        if (translucent) {
          if (m.__omOrigTransparent === undefined) m.__omOrigTransparent = m.transparent
          m.transparent = true
        } else {
          m.transparent = m.__omOrigTransparent ?? m.transparent
        }
        m.needsUpdate = true
      }
    }
    applyTo(this.quad.material)
    applyTo(this.extrudeMesh.material)
    this.wasTranslucent = translucent
  }

  dispose(): void {
    this.quad.geometry.dispose()
    this.quad.material.dispose()
    this.glassMesh.geometry.dispose()
    this.glassMesh.material.dispose()
    this.extrudeMesh.geometry.dispose()
    this.extrudeMesh.material.dispose()
  }
}
