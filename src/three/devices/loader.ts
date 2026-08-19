/**
 * Device model loader.
 *
 * Loads Meshopt/KTX2-compressed GLBs, finds the screen mesh via the
 * `openmockRole: "proDisplayScreen"` extras baked into the files, swaps in
 * the emissive screen material (fed by the DeviceScreenComposer render
 * target), recenters/orients the model so the screen faces +Z, rebuilds the
 * screen UVs by planar projection, and normalizes scale so the largest AABB
 * dimension is 2 world units x the registry scaleMultiplier.
 *
 * Procedural devices (watch / iPad / XDR) are delegated to procedural.ts and
 * come back in the same LoadedDeviceModel shape.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { LoadedDeviceModel, LidHinge } from '../contracts'
import { MOCKUP_MODELS, resolveModelId, type MockupModelDef } from './registry'
import { buildProceduralDevice } from './procedural'
import { applyLoadFixups } from './applyFinish'

// Per-frame device driving lives in applyFinish.ts; re-exported here so the
// engine can import the whole device API from one module.
export { applyModelFrame, applyFinish, applyLoadFixups } from './applyFinish'

// ---------------------------------------------------------------------------
// Screen material (shared shape for GLB + procedural screens)
// ---------------------------------------------------------------------------

export interface ScreenMaterialUniforms {
  uLightAngle: THREE.IUniform<number>
  uLightIntensity: THREE.IUniform<number>
  uLightSoftness: THREE.IUniform<number>
  uPixelGrid: THREE.IUniform<number>
  uBorderRadius: THREE.IUniform<number>
  uQuadAspect: THREE.IUniform<number>
}

/**
 * Subpixel-triad grid, anchored to the emissive map UVs so density scales
 * with zoom. 1350 columns x 759 rows of RGB stripes; every 3rd row darkens.
 */
const PIXEL_GRID_GLSL = /* glsl */ `
  if (uPixelGrid > 0.0) {
    float pgColIdx = mod(vEmissiveMapUv.x * 1350.0, 3.0);
    vec3 pgMask;
    if (pgColIdx < 1.0)      pgMask = vec3(1.4, 0.8, 0.8);
    else if (pgColIdx < 2.0) pgMask = vec3(0.8, 1.4, 0.8);
    else                     pgMask = vec3(0.8, 0.8, 1.4);
    float pgRowIdx = mod(vEmissiveMapUv.y * 759.0, 3.0);
    float pgGap = pgRowIdx < 2.0 ? 1.0 : (1.0 - 0.5 * uPixelGrid);
    outgoingLight = mix(outgoingLight, outgoingLight * pgMask * pgGap, uPixelGrid * 0.7);
  }
`

/**
 * "Screen Fade": directional darkening gradient across the screen plus a
 * 1-LSB screen-space dither to hide 8-bit banding in the gradient.
 */
const SCREEN_FADE_GLSL = /* glsl */ `
  if (uLightIntensity > 0.0) {
    vec2 lDir = vec2(cos(uLightAngle), sin(uLightAngle));
    float lt = dot(vEmissiveMapUv - 0.5, lDir) + 0.5;
    float lFalloff = smoothstep(0.0, 0.5 + uLightSoftness * 0.8, lt);
    outgoingLight *= 1.0 - lFalloff * uLightIntensity * 0.85;
    float lNoise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    outgoingLight += vec3((lNoise - 0.5) / 255.0);
  }
`

/** Rounded-corner SDF alpha cut (same math as the flat quad). */
const ROUNDED_CORNER_GLSL = /* glsl */ `
  if (uBorderRadius > 0.0) {
    vec2 rcSz = uQuadAspect >= 1.0 ? vec2(uQuadAspect, 1.0) : vec2(1.0, 1.0 / uQuadAspect);
    vec2 rcP = (vEmissiveMapUv - 0.5) * 2.0 * rcSz;
    float rcHalfR = uBorderRadius * min(rcSz.x, rcSz.y);
    vec2 rcD = abs(rcP) - rcSz + rcHalfR;
    float rcSdf = length(max(rcD, 0.0)) - rcHalfR;
    float rcEdge = fwidth(rcSdf);
    diffuseColor.a *= 1.0 - smoothstep(-rcEdge, rcEdge, rcSdf);
    if (diffuseColor.a < 0.001) discard;
  }
`

/**
 * Build the emissive screen material. Its emissiveMap is the composited
 * screen render target; direct specular is killed so scene lights never
 * wash out the display, and the Screen Fade / pixel-grid / rounded-corner
 * snippets are injected (uniforms exposed via userData.screenUniforms).
 */
export function createScreenMaterial(screenTexture: THREE.Texture): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    emissive: 0xffffff,
    emissiveMap: screenTexture,
    emissiveIntensity: 1,
    roughness: 0.2,
    metalness: 0,
    clearcoat: 0.001,
    clearcoatRoughness: 0.1,
    envMapIntensity: 0,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const uniforms: ScreenMaterialUniforms = {
    uLightAngle: { value: 0 },
    uLightIntensity: { value: 0 },
    uLightSoftness: { value: 0.5 },
    uPixelGrid: { value: 0 },
    uBorderRadius: { value: 0 },
    uQuadAspect: { value: 16 / 9 },
  }
  mat.userData.screenUniforms = uniforms
  mat.userData.isDeviceScreen = true
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLightAngle = uniforms.uLightAngle
    shader.uniforms.uLightIntensity = uniforms.uLightIntensity
    shader.uniforms.uLightSoftness = uniforms.uLightSoftness
    shader.uniforms.uPixelGrid = uniforms.uPixelGrid
    shader.uniforms.uBorderRadius = uniforms.uBorderRadius
    shader.uniforms.uQuadAspect = uniforms.uQuadAspect
    // The screen emits its content; direct light must not add speculars.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      '#include <lights_fragment_end>\n' +
        'reflectedLight.directSpecular = vec3(0.0);\n' +
        '#ifdef USE_CLEARCOAT\nclearcoatSpecularDirect = vec3(0.0);\n#endif',
    )
    shader.fragmentShader =
      'uniform float uLightAngle;\nuniform float uLightIntensity;\nuniform float uLightSoftness;\n' +
      'uniform float uPixelGrid;\nuniform float uBorderRadius;\nuniform float uQuadAspect;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        PIXEL_GRID_GLSL + SCREEN_FADE_GLSL + ROUNDED_CORNER_GLSL + '\n#include <opaque_fragment>',
      )
  }
  mat.customProgramCacheKey = () => 'openmock-device-screen'
  return mat
}

// ---------------------------------------------------------------------------
// GLB fetch/parse with caching + progress
// ---------------------------------------------------------------------------

const glbCache = new Map<string, Promise<ArrayBuffer>>()
const glbProgress = new Map<string, Set<(p: number) => void>>()

function fetchGlb(url: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  if (onProgress) {
    let set = glbProgress.get(url)
    if (!set) glbProgress.set(url, (set = new Set()))
    set.add(onProgress)
  }
  let pending = glbCache.get(url)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch model ${url}: ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const notify = (p: number) => {
        const set = glbProgress.get(url)
        if (set) for (const cb of set) cb(p)
      }
      if (!res.body || !(total > 0)) {
        const buf = await res.arrayBuffer()
        notify(1)
        return buf
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          received += value.byteLength
          notify(Math.min(1, received / total))
        }
      }
      const out = new Uint8Array(received)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.byteLength
      }
      notify(1)
      return out.buffer
    })()
    pending.finally(() => glbProgress.delete(url)).catch(() => {})
    pending.catch(() => glbCache.delete(url))
    glbCache.set(url, pending)
  }
  return pending
}

let ktx2Loader: KTX2Loader | null = null

function getKtx2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/')
  ktx2Loader.detectSupport(renderer)
  return ktx2Loader
}

// ---------------------------------------------------------------------------
// Model assembly helpers
// ---------------------------------------------------------------------------

function roleOf(obj: THREE.Object3D): string | undefined {
  const direct = obj.userData?.openmockRole as string | undefined
  if (direct) return direct
  const geo = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  return geo?.userData?.openmockRole as string | undefined
}

/** Role can live on the mesh, its geometry, or any ancestor node. */
function hasRole(obj: THREE.Object3D, root: THREE.Object3D, role: string): boolean {
  let cur: THREE.Object3D | null = obj
  while (cur) {
    if (roleOf(cur) === role) return true
    if (cur === root) break
    cur = cur.parent
  }
  return false
}

function findScreenMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  root.traverse((obj) => {
    if (found) return
    if ((obj as THREE.Mesh).isMesh && hasRole(obj, root, 'proDisplayScreen')) {
      found = obj as THREE.Mesh
    }
  })
  return found
}

function findRoleNode(root: THREE.Object3D, role: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  root.traverse((obj) => {
    if (!found && roleOf(obj) === role) found = obj
  })
  return found
}

/** Area-agnostic average of the mesh's vertex normals, in world space. */
function averageWorldNormal(mesh: THREE.Mesh): THREE.Vector3 {
  const geo = mesh.geometry
  if (!geo.attributes.normal) geo.computeVertexNormals()
  const attr = geo.attributes.normal
  const sum = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let i = 0; i < attr.count; i++) {
    v.set(attr.getX(i), attr.getY(i), attr.getZ(i))
    sum.add(v)
  }
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
  sum.applyMatrix3(nm)
  return sum.lengthSq() > 0 ? sum.normalize() : new THREE.Vector3(0, 0, 1)
}

interface ScreenProjection {
  faceAspect: number
  normal: THREE.Vector3
  uAxis: THREE.Vector3
  vAxis: THREE.Vector3
  minU: number
  minV: number
  rangeU: number
  rangeV: number
  planeOffset: number
  /** map normalized (u,v) back to a world-space point on the screen plane */
  pointAt(u: number, v: number, lift: number): THREE.Vector3
}

/**
 * Rebuild the screen mesh UVs by planar projection: world positions are
 * projected onto in-plane axes (world X and Y, orthogonalized against the
 * screen normal), then normalized 0..1 over the projected extents.
 */
function rebuildScreenUvs(mesh: THREE.Mesh, normal: THREE.Vector3): ScreenProjection {
  const n = normal.clone().normalize()
  let uAxis = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x)
  if (uAxis.lengthSq() < 1e-8) uAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n)
  uAxis.normalize()
  const vAxis = new THREE.Vector3(0, 1, 0)
    .addScaledVector(n, -n.y)
    .addScaledVector(uAxis, -uAxis.y)
  if (vAxis.lengthSq() < 1e-8) vAxis.crossVectors(n, uAxis)
  vAxis.normalize()

  const pos = mesh.geometry.attributes.position
  const p = new THREE.Vector3()
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  let offSum = 0
  const us = new Float32Array(pos.count)
  const vs = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
    const u = p.dot(uAxis)
    const v = p.dot(vAxis)
    us[i] = u
    vs[i] = v
    offSum += p.dot(n)
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const rangeU = Math.max(1e-8, maxU - minU)
  const rangeV = Math.max(1e-8, maxV - minV)
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (us[i] - minU) / rangeU
    uv[i * 2 + 1] = (vs[i] - minV) / rangeV
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  const planeOffset = offSum / Math.max(1, pos.count)
  const base = new THREE.Vector3()
  return {
    faceAspect: rangeU / rangeV,
    normal: n,
    uAxis,
    vAxis,
    minU,
    minV,
    rangeU,
    rangeV,
    planeOffset,
    pointAt(u: number, v: number, lift: number): THREE.Vector3 {
      return base
        .set(0, 0, 0)
        .addScaledVector(uAxis, minU + u * rangeU)
        .addScaledVector(vAxis, minV + v * rangeV)
        .addScaledVector(n, planeOffset + lift)
        .clone()
    },
  }
}

/**
 * Fill quad covering the Dynamic Island cutout while the notch is hidden.
 * A UV-space rect around the island is mapped back onto the screen plane
 * (the planar projection IS the affine UV<->plane map) and textured with
 * the shared screen material so it seamlessly shows screen content.
 */
function buildNotchFillMesh(
  def: MockupModelDef,
  proj: ScreenProjection,
  screenMaterial: THREE.MeshPhysicalMaterial,
  wrapper: THREE.Group,
): THREE.Mesh | null {
  const notch = def.notch
  if (!notch) return null
  const vTop = 1 - notch.fromTop - notch.halfHeight
  const R = Math.min(0.4, Math.max(0.22, 2.2 * notch.halfWidth))
  const u0 = Math.max(0.02, 0.5 - R)
  const u1 = Math.min(0.98, 0.5 + R)
  const v0 = Math.max(0.02, vTop - 4 * notch.halfHeight - 0.02)
  const v1 = Math.min(0.999, 1 - 0.4 * notch.fromTop)
  // Slightly above the (already nudged) screen plane so it wins the depth
  // test against both the screen and any island geometry hugging the glass.
  const lift = 12e-4
  const corners: [number, number][] = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ]
  // projection data is in world space; the fill is a child of the wrapper,
  // so convert through the wrapper's (possibly rotated) transform
  wrapper.updateMatrixWorld(true)
  const invQuat = wrapper.getWorldQuaternion(new THREE.Quaternion()).invert()
  const localNormal = proj.normal.clone().applyQuaternion(invQuat)
  const positions = new Float32Array(12)
  const uvs = new Float32Array(8)
  const normals = new Float32Array(12)
  corners.forEach(([u, v], i) => {
    const p = wrapper.worldToLocal(proj.pointAt(u, v, lift))
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z
    uvs[i * 2] = u
    uvs[i * 2 + 1] = v
    normals[i * 3] = localNormal.x
    normals[i * 3 + 1] = localNormal.y
    normals[i * 3 + 2] = localNormal.z
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  const mesh = new THREE.Mesh(geo, screenMaterial)
  mesh.name = '__notchFill'
  mesh.renderOrder = 998
  mesh.layers.enable(3)
  mesh.visible = false // notch defaults to enabled
  return mesh
}

/** Insert a hinge pivot group at the lid's bottom edge and reparent the lid. */
function buildLidHinge(def: MockupModelDef, root: THREE.Object3D): LidHinge | null {
  const hinge = def.hinge
  if (!hinge) return null
  const lid = findRoleNode(root, 'laptopLid')
  if (!lid) return null

  const box = new THREE.Box3().setFromObject(lid)
  if (box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  const maxLidDim = Math.max(size.x, size.y, size.z)
  const yThreshold = box.min.y + 0.03 * Math.max(1e-8, size.y)

  // Centroid of the vertices in the bottom 3% of the lid: the hinge line.
  const centroid = new THREE.Vector3()
  let count = 0
  const p = new THREE.Vector3()
  lid.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.attributes.position
    if (!pos) return
    for (let i = 0; i < pos.count; i++) {
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
      if (p.y <= yThreshold) {
        centroid.add(p)
        count++
      }
    }
  })
  if (count === 0) box.getCenter(centroid).setY(box.min.y)
  else centroid.divideScalar(count)
  centroid.y += hinge.nudge.y * maxLidDim
  centroid.z += hinge.nudge.z * maxLidDim

  // Hinge axis: along the wider in-plane direction of the lid.
  const axis = size.x >= size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)

  const parent = lid.parent ?? root
  const pivot = new THREE.Group()
  pivot.name = '__lidPivot'
  parent.add(pivot)
  pivot.position.copy(parent.worldToLocal(centroid.clone()))
  pivot.updateMatrixWorld(true)
  pivot.attach(lid)

  // Rotation direction: closing (angle -> 0 means rotating by +openDeg*dir)
  // must bring the lid's top edge DOWN toward the base.
  const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2)
  const rel = top.sub(centroid)
  const openRad = (hinge.openDeg * Math.PI) / 180
  const q = new THREE.Quaternion()
  const yPlus = rel.clone().applyQuaternion(q.setFromAxisAngle(axis, openRad)).y
  const yMinus = rel.clone().applyQuaternion(q.setFromAxisAngle(axis, -openRad)).y
  const dir = yPlus <= yMinus ? 1 : -1

  return { pivot, axis, dir, openDeg: hinge.openDeg }
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
] as const

function forEachTexture(mat: THREE.Material, cb: (tex: THREE.Texture) => void): void {
  const anyMat = mat as unknown as Record<string, unknown>
  for (const slot of TEXTURE_SLOTS) {
    const tex = anyMat[slot]
    if (tex && (tex as THREE.Texture).isTexture) cb(tex as THREE.Texture)
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function disposeModelTree(model: LoadedDeviceModel): void {
  const seen = new Set<THREE.Material>()
  model.wrapper.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    for (const mat of materialsOf(mesh)) {
      if (seen.has(mat)) continue
      seen.add(mat)
      forEachTexture(mat, (tex) => {
        // Never dispose the shared screen RT or globally cached textures.
        if (tex === model.screenMaterial.emissiveMap) return
        if (tex.userData?.openmockShared) return
        tex.dispose()
      })
      mat.dispose()
    }
  })
}

// ---------------------------------------------------------------------------
// GLB assembly
// ---------------------------------------------------------------------------

function assembleGlbModel(
  def: MockupModelDef,
  scene: THREE.Group,
  screenTexture: THREE.Texture,
  maxAnisotropy: number,
): LoadedDeviceModel {
  const wrapper = new THREE.Group()
  wrapper.name = `device:${def.id}`
  wrapper.add(scene)
  scene.updateMatrixWorld(true)

  // 1. screen mesh
  const screenMesh = findScreenMesh(scene)
  if (!screenMesh) {
    throw new Error(`[devices] ${def.id}: no screen mesh found (missing openmockRole extras)`)
  }
  const screenMaterial = createScreenMaterial(screenTexture)
  for (const m of materialsOf(screenMesh)) m.dispose()
  screenMesh.material = screenMaterial
  screenMesh.renderOrder = 999
  screenMesh.layers.enable(3)
  screenMesh.castShadow = false

  // 2. recenter the scene on the screen bounds center
  const screenBox = new THREE.Box3().setFromObject(screenMesh)
  scene.position.sub(screenBox.getCenter(new THREE.Vector3()))
  scene.updateMatrixWorld(true)

  // 3. orient the wrapper so the screen faces +Z
  let normal = averageWorldNormal(screenMesh)
  if (normal.z < -0.5) {
    wrapper.rotation.y = Math.PI
  } else if (Math.abs(normal.z) < 0.5) {
    wrapper.quaternion.setFromUnitVectors(normal.clone(), new THREE.Vector3(0, 0, 1))
  }
  wrapper.updateMatrixWorld(true)
  normal = averageWorldNormal(screenMesh)
  wrapper.userData._screenTiltX = Math.atan2(normal.y, normal.z)
  wrapper.userData._baseRotX = wrapper.rotation.x

  // 4. rebuild screen UVs by planar projection
  const proj = rebuildScreenUvs(screenMesh, normal)
  const faceAspect = proj.faceAspect

  // 5. nudge the screen off the glass along its normal to avoid z-fighting
  {
    const parent = screenMesh.parent ?? scene
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    const anchor = new THREE.Vector3().setFromMatrixPosition(screenMesh.matrixWorld)
    const nudged = anchor.clone().addScaledVector(proj.normal, 5e-4)
    const delta = nudged.applyMatrix4(inv).sub(anchor.applyMatrix4(inv))
    screenMesh.position.add(delta)
    screenMesh.updateMatrixWorld(true)
  }

  // 6. shadows + texture anisotropy
  const seenMats = new Set<THREE.Material>()
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh !== screenMesh) mesh.castShadow = true
    for (const mat of materialsOf(mesh)) {
      if (seenMats.has(mat)) continue
      seenMats.add(mat)
      forEachTexture(mat, (tex) => {
        tex.anisotropy = Math.min(maxAnisotropy, 16)
      })
    }
  })

  // 7. feature nodes
  const featureNodes = new Map<string, THREE.Object3D[]>()
  scene.traverse((obj) => {
    const role = roleOf(obj)
    if (role?.startsWith('feature:')) {
      const id = role.slice('feature:'.length)
      const list = featureNodes.get(id) ?? []
      list.push(obj)
      featureNodes.set(id, list)
    }
  })
  for (const feat of def.features ?? []) {
    for (const node of featureNodes.get(feat.id) ?? []) node.visible = feat.defaultOn
  }

  // 8. notch nodes + fill quad
  const notchNodes: THREE.Object3D[] = []
  if (def.notchNodeNames?.length) {
    const names = new Set(def.notchNodeNames)
    scene.traverse((obj) => {
      if (names.has(obj.name)) notchNodes.push(obj)
    })
  }
  const notchFillMesh = buildNotchFillMesh(def, proj, screenMaterial, wrapper)
  if (notchFillMesh) wrapper.add(notchFillMesh)

  // 9. lid hinge
  const lidHinge = buildLidHinge(def, scene)
  wrapper.updateMatrixWorld(true)

  // 10. scale normalization
  const bbox = new THREE.Box3().setFromObject(wrapper)
  const size = bbox.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 1e-8)
  const baseScale = (2 / maxDim) * (def.scaleMultiplier ?? 1)
  const localAABB = new THREE.Box3(
    bbox.min.clone().multiplyScalar(baseScale),
    bbox.max.clone().multiplyScalar(baseScale),
  )

  const model: LoadedDeviceModel = {
    id: def.id,
    wrapper,
    screenMesh,
    screenMaterial,
    baseScale,
    faceAspect,
    localAABB,
    featureNodes,
    notchNodes,
    notchFillMesh,
    lidHinge,
    dispose() {
      disposeModelTree(model)
      uncacheModel(def.id)
    },
  }
  return model
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Per-renderer model caches (models hold GL resources of their context). */
const modelCaches = new WeakMap<THREE.WebGLRenderer, Map<string, Promise<LoadedDeviceModel>>>()
const cacheOwners = new Set<Map<string, Promise<LoadedDeviceModel>>>()

function uncacheModel(id: string): void {
  for (const cache of cacheOwners) cache.delete(id)
}

/**
 * Load (or return the cached) device model. GLB bytes are cached globally;
 * assembled models are cached per renderer + model id.
 */
export function loadDeviceModel(
  modelId: string,
  renderer: THREE.WebGLRenderer,
  screenTexture: THREE.Texture,
  onProgress?: (p: number) => void,
): Promise<LoadedDeviceModel> {
  const id = resolveModelId(modelId)
  const def = MOCKUP_MODELS[id]
  if (!def) return Promise.reject(new Error(`[devices] unknown model id "${modelId}"`))

  let cache = modelCaches.get(renderer)
  if (!cache) {
    modelCaches.set(renderer, (cache = new Map()))
    cacheOwners.add(cache)
  }
  const cached = cache.get(id)
  if (cached) {
    if (onProgress) cached.then(() => onProgress(1)).catch(() => {})
    return cached
  }

  const pending = (async () => {
    if (def.procedural) {
      onProgress?.(0.2)
      const model = buildProceduralDevice(def, createScreenMaterial(screenTexture))
      const dispose = model.dispose
      model.dispose = () => {
        dispose()
        uncacheModel(def.id)
      }
      applyLoadFixups(model)
      onProgress?.(1)
      return model
    }
    const buffer = await fetchGlb(def.url, onProgress ? (p) => onProgress(p * 0.9) : undefined)
    const loader = new GLTFLoader()
    loader.setKTX2Loader(getKtx2Loader(renderer))
    loader.setMeshoptDecoder(MeshoptDecoder)
    // parse from a copy: several model ids may share one GLB url
    const gltf = await loader.parseAsync(buffer.slice(0), '')
    onProgress?.(0.96)
    const model = assembleGlbModel(def, gltf.scene, screenTexture, renderer.capabilities.getMaxAnisotropy())
    applyLoadFixups(model)
    onProgress?.(1)
    return model
  })()
  pending.catch(() => cache.delete(id))
  cache.set(id, pending)
  return pending
}
