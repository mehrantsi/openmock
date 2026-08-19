/**
 * Device finish systems + per-frame model driving.
 *
 * - 'iphone17' / 'v2'  procedural iPhone body handle (v2 adds the Pro plateau)
 * - 'classified'       name/color heuristic classes (iPad / XDR) with per-finish PBR targets
 * - 'macbookPro'       procedural MacBook deck/body handle (Pro 14/16 + Neo)
 * - 'watch'            band recolor + matte-black mesh table
 *
 * Plus the on-load material fixups (bodyMatte, iPad uniforming) and
 * applyModelFrame — the per-frame hook the engine calls with the current
 * RenderParams.
 */

import * as THREE from 'three'
import type { LoadedDeviceModel } from '../contracts'
import type { RenderParams } from '../renderParams'
import { MOCKUP_MODELS } from './registry'
import { ensureIphoneProPlateau, iphoneHandleOf, macbookProHandleOf } from './procedural'
import {
  CLASSIFIED_FINISHES,
  XDR_TITANIUM_PANEL,
  WATCH_BAND_MESHES,
  WATCH_MATTE_BLACK,
  type ClassTarget,
} from './finishes'

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type BodyMaterial = THREE.MeshStandardMaterial &
  Partial<Pick<THREE.MeshPhysicalMaterial, 'clearcoat' | 'clearcoatRoughness' | 'anisotropy'>>

interface ScreenUniformSet {
  uLightAngle: THREE.IUniform<number>
  uLightIntensity: THREE.IUniform<number>
  uLightSoftness: THREE.IUniform<number>
  uPixelGrid: THREE.IUniform<number>
  uBorderRadius: THREE.IUniform<number>
  uQuadAspect: THREE.IUniform<number>
}

function isScreenMaterial(mat: THREE.Material): boolean {
  return mat.userData?.isDeviceScreen === true
}

function meshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function forEachBodyMesh(model: LoadedDeviceModel, cb: (mesh: THREE.Mesh) => void): void {
  model.wrapper.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (meshMaterials(mesh).some(isScreenMaterial)) return
    cb(mesh)
  })
}

/** Visit each unique non-screen material once, in traverse order. */
function forEachBodyMaterial(model: LoadedDeviceModel, cb: (mat: BodyMaterial, mesh: THREE.Mesh) => void): void {
  const seen = new Set<THREE.Material>()
  forEachBodyMesh(model, (mesh) => {
    for (const mat of meshMaterials(mesh)) {
      if (seen.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
      seen.add(mat)
      cb(mat as BodyMaterial, mesh)
    }
  })
}

/** Clone a mesh's material once so per-mesh recolors don't leak to siblings. */
const ownedMaterials = new WeakSet<THREE.Mesh>()
function ownMaterial(mesh: THREE.Mesh): BodyMaterial {
  if (!ownedMaterials.has(mesh) && !Array.isArray(mesh.material)) {
    mesh.material = mesh.material.clone()
    ownedMaterials.add(mesh)
  }
  return mesh.material as BodyMaterial
}

interface StockPbr {
  color: THREE.Color
  metalness: number
  roughness: number
  envMapIntensity: number
  clearcoat: number
  anisotropy: number
}

const stockPbrCache = new WeakMap<THREE.Material, StockPbr>()
function stockOf(mat: BodyMaterial): StockPbr {
  let f = stockPbrCache.get(mat)
  if (!f) {
    f = {
      color: mat.color.clone(),
      metalness: mat.metalness,
      roughness: mat.roughness,
      envMapIntensity: mat.envMapIntensity,
      clearcoat: mat.clearcoat ?? 0,
      anisotropy: mat.anisotropy ?? 0,
    }
    stockPbrCache.set(mat, f)
  }
  return f
}

const stockColorCache = new WeakMap<THREE.Material, THREE.Color>()
function recolor(mat: BodyMaterial, apply: (c: THREE.Color) => void): void {
  if (!stockColorCache.has(mat)) stockColorCache.set(mat, mat.color.clone())
  apply(mat.color)
}
function revertColor(mat: BodyMaterial): void {
  const stock = stockColorCache.get(mat)
  if (stock) mat.color.copy(stock)
}

// shader patch chaining (multiple injections must compose + keep unique
// program cache keys — three's default key would collide across closures)
const patchKeyCache = new WeakMap<THREE.Material, string[]>()
function addShaderPatch(
  mat: THREE.Material,
  key: string,
  patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
): void {
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    patch(shader)
  }
  const keys = patchKeyCache.get(mat) ?? []
  keys.push(key)
  patchKeyCache.set(mat, keys)
  mat.customProgramCacheKey = () => keys.join('|')
  mat.needsUpdate = true
}

// ---------------------------------------------------------------------------
// Micro-grain (triplanar normal perturbation on classified materials)
// ---------------------------------------------------------------------------

const GRAIN_ENABLED = true
const GRAIN_STRENGTH = 0.08
const GRAIN_TILING = 7
const GRAIN_SEED = 703710

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let grainTexture: THREE.DataTexture | null = null
function getGrainTexture(): THREE.DataTexture {
  if (grainTexture) return grainTexture
  const size = 256
  const rand = mulberry32(GRAIN_SEED)
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = (rand() - 0.5) * 0.6
    const y = (rand() - 0.5) * 0.6
    data[i * 4] = Math.round((0.5 * x + 0.5) * 255)
    data[i * 4 + 1] = Math.round((0.5 * y + 0.5) * 255)
    data[i * 4 + 2] = 255
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(12, 12)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.colorSpace = THREE.NoColorSpace
  tex.userData.openmockShared = true
  tex.needsUpdate = true
  grainTexture = tex
  return tex
}

const GRAIN_FRAG_COMMON = /* glsl */ `
uniform sampler2D uGrainTex;
uniform float uGrainScale;
uniform float uGrainStrength;
varying vec3 vGrainObjPos;
varying vec3 vGrainObjNor;
vec3 grainTriplanar() {
  vec3 absN = abs(vGrainObjNor);
  vec3 w = absN / max(absN.x + absN.y + absN.z, 1e-4);
  vec3 sX = texture2D(uGrainTex, vGrainObjPos.yz * uGrainScale).rgb * 2.0 - 1.0;
  vec3 sY = texture2D(uGrainTex, vGrainObjPos.xz * uGrainScale).rgb * 2.0 - 1.0;
  vec3 sZ = texture2D(uGrainTex, vGrainObjPos.xy * uGrainScale).rgb * 2.0 - 1.0;
  return sX * w.x + sY * w.y + sZ * w.z;
}
`

const grainInjected = new WeakSet<THREE.Material>()
function injectGrain(mat: BodyMaterial): void {
  if (!GRAIN_ENABLED || grainInjected.has(mat)) return
  grainInjected.add(mat)
  addShaderPatch(mat, 'openmock-grain', (shader) => {
    shader.uniforms.uGrainTex = { value: getGrainTexture() }
    shader.uniforms.uGrainScale = { value: GRAIN_TILING }
    shader.uniforms.uGrainStrength = { value: GRAIN_STRENGTH }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'varying vec3 vGrainObjPos;\nvarying vec3 vGrainObjNor;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainObjPos = position;\nvGrainObjNor = normal;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GRAIN_FRAG_COMMON)
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize(normal + grainTriplanar() * uGrainStrength);',
      )
  })
}

// ---------------------------------------------------------------------------
// Pro plateau tint per finish (sRGB midtones)
// ---------------------------------------------------------------------------

export const PRO_TINTS: Record<string, string> = {
  silver: '#eff0f2',
  orange: '#f0733a', // Cosmic Orange
  matteBlack: '#3a3a3d',
  titanium: '#d8cfc2',
}

// ---------------------------------------------------------------------------
// 'classified' — body/panel/logo/skip classes (iPad / XDR)
// ---------------------------------------------------------------------------

type FinishClass = 'body' | 'panel' | 'logo' | 'skip'
const finishClassCache = new WeakMap<THREE.Material, FinishClass>()

function classifyMaterial(mat: BodyMaterial): FinishClass {
  let cls = finishClassCache.get(mat)
  if (cls) return cls
  const name = mat.name ?? ''
  const mean = (mat.color.r + mat.color.g + mat.color.b) / 3
  if (mat.roughness < 0.15 || /lens|camera|glass|screen/.test(name)) cls = 'skip'
  else if (/logo/.test(name)) cls = 'logo'
  else if (/^body(_|$)/.test(name)) cls = 'body'
  else if (mean < 0.4) cls = 'skip'
  else if (mean > 0.9 || mean < 0.6) cls = 'panel'
  else cls = 'body'
  finishClassCache.set(mat, cls)
  if (cls !== 'skip') injectGrain(mat)
  return cls
}

const BODY_ENV_MAP_MUL = 1

function applyClassifiedFinish(model: LoadedDeviceModel, finishId: string): void {
  const table = CLASSIFIED_FINISHES[finishId] ?? CLASSIFIED_FINISHES.titanium
  const effective = CLASSIFIED_FINISHES[finishId] ? finishId : 'titanium'

  forEachBodyMaterial(model, (mat) => {
    const cls = classifyMaterial(mat)
    if (cls === 'skip') return
    const f = stockOf(mat)
    let target: ClassTarget
    if (cls === 'body') target = typeof table.body === 'function' ? table.body(model.id) : table.body
    else if (cls === 'panel' && effective === 'titanium' && model.id === 'proDisplayXdr') target = XDR_TITANIUM_PANEL
    else target = table[cls]

    if (target.color) {
      mat.color.setRGB(target.color[0], target.color[1], target.color[2])
      // textured parts carry their detail in the map — a dark flat tint
      // crushes it, so keep mapped materials noticeably lighter
      if (mat.map) {
        const lum = 0.2126 * mat.color.r + 0.7152 * mat.color.g + 0.0722 * mat.color.b
        if (lum < 0.3) mat.color.lerp(new THREE.Color(0xffffff), 0.55)
      }
    } else {
      mat.color.copy(f.color)
    }
    mat.metalness = target.metalness ?? f.metalness
    mat.roughness = target.roughness ?? f.roughness
    const env = target.envMapIntensity ?? f.envMapIntensity
    mat.envMapIntensity = cls === 'body' ? env * BODY_ENV_MAP_MUL : env
    if (mat.clearcoat !== undefined) mat.clearcoat = target.clearcoat ?? f.clearcoat
    if (mat.anisotropy !== undefined) mat.anisotropy = target.anisotropy ?? f.anisotropy
  })
}

// ---------------------------------------------------------------------------
// 'watch' — band recolor + matte-black case table
// ---------------------------------------------------------------------------

function applyWatchFinish(model: LoadedDeviceModel, finishId: string, bandColor: string): void {
  const matte = finishId === 'matteBlack'
  forEachBodyMesh(model, (mesh) => {
    const name = mesh.name
    if (WATCH_BAND_MESHES.has(name)) {
      ownMaterial(mesh).color.set(bandColor)
      return
    }
    const hex = WATCH_MATTE_BLACK[name]
    if (hex) {
      const mat = ownMaterial(mesh)
      if (matte) recolor(mat, (c) => c.set(hex))
      else revertColor(mat)
    }
  })
}

// ---------------------------------------------------------------------------
// On-load material fixups
// ---------------------------------------------------------------------------

function bodyMatteFixups(model: LoadedDeviceModel): void {
  forEachBodyMaterial(model, (mat) => {
    if (mat.roughness < 0.15) return
    if ((mat.clearcoat ?? 0) > 0.3) {
      mat.clearcoat = 0.15
      mat.clearcoatRoughness = Math.max(mat.clearcoatRoughness ?? 0, 0.45)
      if (mat.roughness < 0.4) mat.roughness = Math.min(1, mat.roughness + 0.15)
    }
    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1)
    if (mat.anisotropy !== undefined) mat.anisotropy = Math.max(mat.anisotropy, 0.4)
    if (mat.normalMap) {
      const s = model.id === 'ipadPro' ? 0.5 : model.id === 'proDisplayXdr' ? 0.2 : 0.7
      mat.normalScale.set(s, s)
    }
  })
}

function ipadUniformFixups(model: LoadedDeviceModel): void {
  // materials that belong to feature nodes are exempt
  const featureMats = new Set<THREE.Material>()
  for (const nodes of model.featureNodes.values()) {
    for (const node of nodes) {
      node.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh) for (const m of meshMaterials(mesh)) featureMats.add(m)
      })
    }
  }
  let count = 0
  forEachBodyMaterial(model, (mat) => {
    if (featureMats.has(mat) || mat.transparent || mat.roughness < 0.15) return
    if (!(mat.roughnessMap || mat.metalnessMap || mat.aoMap || mat.emissiveMap)) return
    for (const slot of ['roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
      const tex = mat[slot]
      if (tex) {
        if (!tex.userData?.openmockShared) tex.dispose()
        mat[slot] = null
      }
    }
    mat.roughness = 0.55
    mat.metalness = 0.55
    mat.emissive.set(0x000000)
    mat.needsUpdate = true
    count++
  })
  if (count > 0) console.info(`[ipadPro] uniformed ${count} body materials`)
}

/** One-time material fixups after a model is assembled. */
export function applyLoadFixups(model: LoadedDeviceModel): void {
  const def = MOCKUP_MODELS[model.id]
  if (!def) return
  if (model.id === 'ipadPro') ipadUniformFixups(model)
  if (def.bodyMatte) bodyMatteFixups(model)
}

// ---------------------------------------------------------------------------
// Finish dispatch + per-frame driving
// ---------------------------------------------------------------------------

export function applyFinish(model: LoadedDeviceModel, params: RenderParams): void {
  const def = MOCKUP_MODELS[model.id]
  switch (def?.finishSystem) {
    case 'iphone17':
      iphoneHandleOf(model)?.setFinish(params.deviceFinish)
      break
    case 'v2': {
      // Pro models ride the shared iPhone body: add the Pro camera plateau
      // and tint body + plateau to the finish
      ensureIphoneProPlateau(model)
      iphoneHandleOf(model)?.setFinish(params.deviceFinish)
      const plateau = (model.wrapper.userData as Record<string, unknown>)._openmockProPlateau as
        | { setTint(t: THREE.Color): void }
        | undefined
      plateau?.setTint(new THREE.Color(PRO_TINTS[params.deviceFinish] ?? PRO_TINTS.titanium))
      break
    }
    case 'classified':
      applyClassifiedFinish(model, params.deviceFinish)
      break
    case 'macbookPro':
      macbookProHandleOf(model)?.setFinish(params.deviceFinish)
      break
    case 'watch':
      applyWatchFinish(model, params.deviceFinish, params.bandColor)
      break
  }
}

/** Screen reflection profiles (envMapIntensity is scaled by strength). */
const REFLECTION_ON = { envMapIntensity: 0.05, clearcoat: 1, clearcoatRoughness: 0, roughness: 1 }
const REFLECTION_OFF = { clearcoat: 0.001, clearcoatRoughness: 1, roughness: 1 }

/**
 * Per-frame model driving: lid hinge, finish (when changed), feature-node
 * visibility (+ iPad levelScreen), notch nodes/fill, screen reflection
 * profile + env map, and the screen material uniforms.
 */
export function applyModelFrame(
  model: LoadedDeviceModel,
  params: RenderParams,
  ctx: { screenEnvMap: THREE.Texture | null },
): void {
  const def = MOCKUP_MODELS[model.id]
  const wrapper = model.wrapper

  // lid hinge
  if (model.lidHinge) {
    const maxDeg = def?.hinge?.maxDeg ?? 135
    const angle = Math.max(0, Math.min(maxDeg, params.laptopHingeAngle))
    const deltaRad = ((model.lidHinge.openDeg - angle) * Math.PI) / 180
    model.lidHinge.pivot.quaternion.setFromAxisAngle(model.lidHinge.axis, model.lidHinge.dir * deltaRad)
  }

  // finish (only when it changed)
  const finishKey = `${params.deviceFinish}|${params.bandColor}`
  if (wrapper.userData._appliedFinishKey !== finishKey) {
    applyFinish(model, params)
    wrapper.userData._appliedFinishKey = finishKey
  }

  // feature nodes + levelScreen
  if (def?.features?.length) {
    let extraRotX = 0
    let touched = false
    for (const feat of def.features) {
      const nodes = model.featureNodes.get(feat.id)
      if (!nodes?.length) continue
      touched = true
      const on = params.deviceFeatures[feat.id] ?? feat.defaultOn
      for (const node of nodes) node.visible = on
      if (!on && feat.whenOff?.levelScreen) {
        const tilt = wrapper.userData._screenTiltX
        extraRotX += typeof tilt === 'number' ? tilt : 0
      }
    }
    if (touched) {
      const base = typeof wrapper.userData._baseRotX === 'number' ? wrapper.userData._baseRotX : wrapper.rotation.x
      wrapper.rotation.x = base + extraRotX
    }
  }

  // notch nodes + fill quad
  for (const node of model.notchNodes) node.visible = params.notchEnabled
  if (model.notchFillMesh) model.notchFillMesh.visible = !params.notchEnabled

  // screen material: reflection profile + grayscale env map
  const screen = model.screenMaterial
  if (ctx.screenEnvMap && screen.envMap !== ctx.screenEnvMap) {
    screen.envMap = ctx.screenEnvMap
    screen.needsUpdate = true
  }
  const strength = Math.max(0, Math.min(1, params.reflectionStrength))
  const on = strength > 0
  screen.envMapIntensity = strength * REFLECTION_ON.envMapIntensity
  screen.clearcoat = on ? REFLECTION_ON.clearcoat : REFLECTION_OFF.clearcoat
  screen.clearcoatRoughness = on ? REFLECTION_ON.clearcoatRoughness : REFLECTION_OFF.clearcoatRoughness
  screen.roughness = on ? REFLECTION_ON.roughness : REFLECTION_OFF.roughness

  // screen-fade / pixel-grid / border-radius uniforms. The pixel grid and
  // rounded corners of the media rect are composited into the screen RT by
  // DeviceScreenComposer, so they stay 0 here to avoid double application.
  const u = screen.userData.screenUniforms as ScreenUniformSet | undefined
  if (u) {
    u.uLightAngle.value = params.lightingAngle
    u.uLightIntensity.value = params.lightingEnabled ? params.lightingIntensity : 0
    u.uLightSoftness.value = params.lightingSoftness
    u.uQuadAspect.value = model.faceAspect
    u.uPixelGrid.value = 0
    u.uBorderRadius.value = 0
  }
}
