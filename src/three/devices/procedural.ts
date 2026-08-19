/**
 * Procedural device models: Apple Watch Ultra 3, iPad Pro, Pro Display XDR,
 * MacBook Pro 14"/16".
 *
 * These devices ship no redistributable GLB, so they are built from three.js
 * geometry with matching proportions and PBR materials, and returned in the
 * exact LoadedDeviceModel shape the engine expects. Mesh/material names are
 * chosen so the finish systems in applyFinish.ts (classified / watch tables)
 * pick them up.
 */

import * as THREE from 'three'
import type { LidHinge, LoadedDeviceModel } from '../contracts'
import type { MockupModelDef } from './registry'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Rounded rect with true circular-arc corners (quadratic corners read "cut"). */
function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const hw = w / 2
  const hh = h / 2
  const rr = Math.min(r, hw, hh)
  const s = new THREE.Shape()
  s.moveTo(-hw + rr, -hh)
  s.lineTo(hw - rr, -hh)
  s.absarc(hw - rr, -hh + rr, rr, -Math.PI / 2, 0, false)
  s.lineTo(hw, hh - rr)
  s.absarc(hw - rr, hh - rr, rr, 0, Math.PI / 2, false)
  s.lineTo(-hw + rr, hh)
  s.absarc(-hw + rr, hh - rr, rr, Math.PI / 2, Math.PI, false)
  s.lineTo(-hw, -hh + rr)
  s.absarc(-hw + rr, -hh + rr, rr, Math.PI, Math.PI * 1.5, false)
  return s
}

/** Rounded-rect slab, z-centered, with a small edge bevel for crisp specular lines. */
function slabGeometry(
  w: number,
  h: number,
  depth: number,
  r: number,
  bevel: number,
  curveSegments = 24,
  bevelSegments = 3,
): THREE.ExtrudeGeometry {
  const inner = Math.max(0.001, depth - 2 * bevel)
  const geo = new THREE.ExtrudeGeometry(roundedRectShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.001, r - bevel)), {
    depth: inner,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
  })
  geo.translate(0, 0, -inner / 2)
  return geo
}

/** Rounded-rect screen face with UVs normalized 0..1 (v up), facing +Z. */
function screenFaceGeometry(w: number, h: number, r: number): THREE.ShapeGeometry {
  const geo = new THREE.ShapeGeometry(roundedRectShape(w, h, r), 24)
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

function makeScreenMesh(
  geo: THREE.BufferGeometry,
  screenMaterial: THREE.MeshPhysicalMaterial,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, screenMaterial)
  mesh.name = 'screen'
  mesh.userData.openmockRole = 'proDisplayScreen'
  mesh.renderOrder = 999
  mesh.layers.enable(3)
  return mesh
}

function averageWorldNormal(mesh: THREE.Mesh): THREE.Vector3 {
  const geo = mesh.geometry
  if (!geo.attributes.normal) geo.computeVertexNormals()
  const attr = geo.attributes.normal
  const sum = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let i = 0; i < attr.count; i++) {
    sum.add(v.set(attr.getX(i), attr.getY(i), attr.getZ(i)))
  }
  sum.applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
  return sum.lengthSq() > 0 ? sum.normalize() : new THREE.Vector3(0, 0, 1)
}

function disposeTree(root: THREE.Object3D, keepMaterial: THREE.Material): void {
  const seen = new Set<THREE.Material>()
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (mat === keepMaterial || seen.has(mat)) continue
      seen.add(mat)
      const rec = mat as unknown as Record<string, unknown>
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        const tex = rec[slot] as THREE.Texture | undefined
        if (tex?.isTexture && !tex.userData?.openmockShared) tex.dispose()
      }
      mat.dispose()
    }
  })
}

/**
 * Recenter on the screen, compute tilt/scale/AABB and wrap everything into
 * the LoadedDeviceModel contract (mirrors the tail of the GLB pipeline).
 */
function finalizeModel(
  def: MockupModelDef,
  content: THREE.Group,
  screenMesh: THREE.Mesh,
  screenMaterial: THREE.MeshPhysicalMaterial,
  faceAspect: number,
): LoadedDeviceModel {
  const wrapper = new THREE.Group()
  wrapper.name = `device:${def.id}`
  wrapper.add(content)
  wrapper.updateMatrixWorld(true)

  // recenter on the screen bounds center
  const center = new THREE.Box3().setFromObject(screenMesh).getCenter(new THREE.Vector3())
  content.position.sub(center)
  wrapper.updateMatrixWorld(true)

  const normal = averageWorldNormal(screenMesh)
  wrapper.userData._screenTiltX = Math.atan2(normal.y, normal.z)
  wrapper.userData._baseRotX = wrapper.rotation.x

  // shadows + feature nodes
  const featureNodes = new Map<string, THREE.Object3D[]>()
  wrapper.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh !== screenMesh) mesh.castShadow = true
    const role = obj.userData?.openmockRole as string | undefined
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
    notchNodes: [],
    notchFillMesh: null,
    lidHinge: null,
    dispose() {
      disposeTree(wrapper, screenMaterial)
      screenMaterial.dispose()
    },
  }
  return model
}

function phys(opts: THREE.MeshPhysicalMaterialParameters & { name: string }): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial(opts)
  mat.name = opts.name
  return mat
}

// ---------------------------------------------------------------------------
// Apple logo (canvas alpha mask, shared)
// ---------------------------------------------------------------------------

// simple-icons "apple" glyph (24×24 viewBox)
const APPLE_LOGO_PATH =
  'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.031 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

let appleLogoTex: THREE.CanvasTexture | null = null

/** White glyph on black — used as alphaMap so the material drives the color. */
function appleLogoTexture(): THREE.CanvasTexture {
  if (appleLogoTex) return appleLogoTex
  const S = 512
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, S, S)
  // glyph bbox ≈ x[2.6, 21.5], y[0, 24] → center on (12.05, 12)
  const s = (S / 24) * 0.86
  g.setTransform(s, 0, 0, s, S / 2 - 12.05 * s, S / 2 - 12 * s)
  g.fillStyle = '#fff'
  g.fill(new Path2D(APPLE_LOGO_PATH))
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  tex.userData.openmockShared = true
  appleLogoTex = tex
  return tex
}

/** Logo aspect (w/h) of the glyph inside its box. */
const APPLE_LOGO_ASPECT = 1

function appleLogoMesh(width: number, color: number, name = 'logo_back'): THREE.Mesh {
  const mat = phys({
    name,
    color,
    metalness: 0.95,
    roughness: 0.22,
    transparent: true,
    alphaMap: appleLogoTexture(),
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / APPLE_LOGO_ASPECT), mat)
  mesh.name = name
  return mesh
}

// ---------------------------------------------------------------------------
// iPhone 17 (base + Pro/Max bodies)
// ---------------------------------------------------------------------------

interface IphoneFinishColors {
  back: number
  frame: number
  camera: number
  logo: number
}

/** Base iPhone 17 colorways. */
const IPHONE_FINISHES: Record<string, IphoneFinishColors> = {
  white: { back: 0xf4f4f5, frame: 0xcccac6, camera: 0xe4e4e4, logo: 0xffffff },
  black: { back: 0x46484b, frame: 0x36383a, camera: 0x535556, logo: 0x6d6f73 },
  mistBlue: { back: 0xb5cdf4, frame: 0x8297b2, camera: 0x8da8cd, logo: 0xdbe7fb },
  sage: { back: 0xa0b28b, frame: 0x879973, camera: 0xa8b680, logo: 0xcdd8c0 },
  lavender: { back: 0xd9c6ec, frame: 0xb3a1c8, camera: 0xdec9f0, logo: 0xf0e6fa },
}

/** Pro colorways (tint applied to the whole body; the plateau tints itself). */
const IPHONE_PRO_FINISHES: Record<string, IphoneFinishColors> = {
  silver: { back: 0xeff0f2, frame: 0xd4d5d8, camera: 0xe4e4e4, logo: 0xffffff },
  orange: { back: 0xf0733a, frame: 0xd05f2c, camera: 0xf0733a, logo: 0xffd9c2 },
  matteBlack: { back: 0x3a3a3d, frame: 0x2c2c2f, camera: 0x3a3a3d, logo: 0x646468 },
  titanium: { back: 0xd8cfc2, frame: 0xbdb4a6, camera: 0xd8cfc2, logo: 0xf2ece2 },
}

export interface IphoneHandle {
  setFinish(finishId: string): void
}

const IPHONE_KEY = '_openmockIphone'

export function iphoneHandleOf(model: LoadedDeviceModel): IphoneHandle | undefined {
  return (model.wrapper.userData as Record<string, unknown>)[IPHONE_KEY] as IphoneHandle | undefined
}

function buildIphone17(def: MockupModelDef, screenMaterial: THREE.MeshPhysicalMaterial): LoadedDeviceModel {
  const isPro = def.id !== 'iphone17'
  const faceAspect = def.id === 'iphone17ProMax' ? 1320 / 2868 : 1206 / 2622
  const W = 2.0
  const bezel = 0.045
  const Sw = W - 2 * bezel
  const Sh = Sw / faceAspect
  const H = Sh + 2 * bezel
  const D = 0.21
  const r = 0.32 // body corner radius

  const content = new THREE.Group()

  // aluminum unibody frame — restrained metalness so the rails read as brushed
  // aluminum instead of blowing out under the studio HDRI
  const frameMat = phys({ name: 'iphone_frame', color: 0xcccac6, metalness: 0.7, roughness: 0.45 })
  const body = new THREE.Mesh(slabGeometry(W, H, D, r, 0.028, 48, 5), frameMat)
  body.name = 'iphone_body'
  content.add(body)

  // back glass (glossy, finish-colored) + Apple logo
  const backMat = phys({
    name: 'iphone_back',
    color: 0xf4f4f5,
    metalness: 0.12,
    roughness: 0.38,
    clearcoat: 0.4,
    clearcoatRoughness: 0.28,
  })
  backMat.envMapIntensity = 0.8
  const back = new THREE.Mesh(screenFaceGeometry(W - 0.07, H - 0.07, r - 0.035), backMat)
  back.rotation.y = Math.PI
  back.position.z = -D / 2 - 0.0012
  back.name = 'iphone_back_glass'
  content.add(back)

  const logoMat = phys({
    name: 'iphone_logo',
    color: 0xffffff,
    metalness: 0.9,
    roughness: 0.25,
    transparent: true,
    alphaMap: appleLogoTexture(),
    depthWrite: false,
  })
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46), logoMat)
  logo.name = 'iphone_logo'
  logo.rotation.y = Math.PI
  // proud enough of the back glass that depth precision never swallows it
  logo.position.set(0, H / 2 - 0.42 * H, -D / 2 - 0.008)
  logo.renderOrder = 10
  content.add(logo)

  // single rear camera — local +X so it reads top-LEFT when viewing the back
  // (Pro bodies get their plateau on top of this)
  const lensX = W / 2 - 0.36
  const lensY = H / 2 - 0.36
  const ringMat = phys({ name: 'camera_ring', color: 0xd7d5d1, metalness: 0.9, roughness: 0.3 })
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.285, 0.075, 48), ringMat)
  ring.rotation.x = Math.PI / 2
  ring.position.set(lensX, lensY, -D / 2 - 0.03)
  ring.name = 'iphone_camera_ring'
  content.add(ring)
  const lensGlass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 0.02, 48),
    phys({ name: 'camera_glass', color: 0x0a0d14, metalness: 0.1, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.05 }),
  )
  lensGlass.rotation.x = Math.PI / 2
  lensGlass.position.set(lensX, lensY, -D / 2 - 0.065)
  content.add(lensGlass)
  const lensInner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.11, 0.02, 32),
    phys({ name: 'camera_inner', color: 0x1c2740, metalness: 0.2, roughness: 0.2 }),
  )
  lensInner.rotation.x = Math.PI / 2
  lensInner.position.set(lensX, lensY, -D / 2 - 0.07)
  content.add(lensInner)
  const flash = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.012, 24),
    phys({ name: 'camera_flash', color: 0xf2ecd8, metalness: 0, roughness: 0.35, emissive: 0x1f1a0a }),
  )
  flash.rotation.x = Math.PI / 2
  flash.position.set(lensX - 0.46, lensY + 0.06, -D / 2 - 0.005)
  content.add(flash)

  // front glass + screen + Dynamic Island — glass runs almost to the rails so
  // only a hair-thin metal edge shows face-on
  const front = new THREE.Mesh(
    screenFaceGeometry(W - 0.012, H - 0.012, r - 0.006),
    phys({ name: 'front_glass', color: 0x060709, metalness: 0.08, roughness: 0.14, clearcoat: 0.7, clearcoatRoughness: 0.08 }),
  )
  front.position.z = D / 2 + 0.0006
  content.add(front)

  const screenMesh = makeScreenMesh(screenFaceGeometry(Sw, Sh, r - bezel), screenMaterial)
  screenMesh.position.z = D / 2 + 0.0014
  content.add(screenMesh)

  // real Dynamic Island proportions: 126×37.3pt on a 393pt-wide screen
  const islandW = 0.32 * Sw
  const islandH = 0.095 * Sw
  const island = new THREE.Mesh(
    screenFaceGeometry(islandW, islandH, islandH / 2),
    phys({ name: 'dynamic_island', color: 0x000000, metalness: 0, roughness: 0.3 }),
  )
  island.name = 'dynamic_island'
  island.position.set(0, Sh / 2 - 0.013 * Sh - islandH / 2, D / 2 + 0.002)
  island.renderOrder = 1000
  content.add(island)

  // side buttons — slim pills in the frame's own tone, barely proud
  const buttonMat = phys({ name: 'iphone_button', color: 0xcccac6, metalness: 0.7, roughness: 0.42 })
  const sideButton = (x: number, y: number, len: number): THREE.Mesh => {
    const geo = slabGeometry(0.07, len, 0.03, 0.03, 0.008, 12)
    geo.rotateY(Math.PI / 2)
    const b = new THREE.Mesh(geo, buttonMat)
    b.position.set(x, y, 0.02)
    return b
  }
  content.add(sideButton(-W / 2 - 0.002, H / 2 - 0.72, 0.15)) // action
  content.add(sideButton(-W / 2 - 0.002, H / 2 - 1.04, 0.28)) // vol +
  content.add(sideButton(-W / 2 - 0.002, H / 2 - 1.4, 0.28)) // vol -
  content.add(sideButton(W / 2 + 0.002, H / 2 - 1.1, 0.44)) // power
  content.add(sideButton(W / 2 + 0.002, -H / 2 + 1.05, 0.2)) // camera control

  // bottom edge: USB-C port, speaker grille (right), mic holes (left)
  const portMat = phys({ name: 'iphone_port', color: 0x232426, metalness: 0.4, roughness: 0.5 })
  const port = new THREE.Mesh(screenFaceGeometry(0.3, 0.075, 0.037), portMat)
  port.geometry.rotateX(Math.PI / 2) // face down (−y)
  port.position.set(0, -H / 2 - 0.0012, 0)
  content.add(port)
  const holeGeo = new THREE.CircleGeometry(0.017, 16)
  holeGeo.rotateX(Math.PI / 2)
  for (let i = 0; i < 6; i++) {
    const hole = new THREE.Mesh(holeGeo, portMat)
    hole.position.set(0.32 + i * 0.075, -H / 2 - 0.0012, 0)
    content.add(hole)
  }
  for (let i = 0; i < 3; i++) {
    const hole = new THREE.Mesh(holeGeo, portMat)
    hole.position.set(-0.32 - i * 0.075, -H / 2 - 0.0012, 0)
    content.add(hole)
  }

  const model = finalizeModel(def, content, screenMesh, screenMaterial, faceAspect)
  model.notchNodes.push(island)

  const table = isPro ? IPHONE_PRO_FINISHES : IPHONE_FINISHES
  const fallback = isPro ? IPHONE_PRO_FINISHES.titanium : IPHONE_FINISHES.white
  const handle: IphoneHandle = {
    setFinish(finishId: string) {
      const f = table[finishId] ?? fallback
      backMat.color.set(f.back)
      frameMat.color.set(f.frame)
      buttonMat.color.set(f.frame)
      ringMat.color.set(f.camera)
      logoMat.color.set(f.logo)
      if (isPro && finishId === 'matteBlack') {
        backMat.roughness = 0.5
        backMat.clearcoat = 0.25
      } else {
        backMat.roughness = 0.22
        backMat.clearcoat = 1
      }
    },
  }
  ;(model.wrapper.userData as Record<string, unknown>)[IPHONE_KEY] = handle
  return model
}

// ---------------------------------------------------------------------------
// iPad Pro (Space Black)
// ---------------------------------------------------------------------------

function buildIpadPro(def: MockupModelDef, screenMaterial: THREE.MeshPhysicalMaterial): LoadedDeviceModel {
  const faceAspect = 2752 / 2064 // 4:3 landscape panel
  const W = 2.0
  const bezelW = 0.075
  const Sw = W - 2 * bezelW
  const Sh = Sw / faceAspect
  const H = Sh + 2 * bezelW
  const D = 0.046
  const tilt = (10 * Math.PI) / 180

  const content = new THREE.Group()
  const device = new THREE.Group()
  device.name = 'ipadBody'
  content.add(device)

  const bodyMat = phys({
    name: 'body_frame',
    color: 0x2c2d30, // space black
    metalness: 0.75,
    roughness: 0.5,
  })
  const body = new THREE.Mesh(slabGeometry(W, H, D, 0.045 * W, 0.006, 32), bodyMat)
  body.name = 'ipad_body'
  device.add(body)

  // edge-to-edge front glass (thin dark bezel around the panel)
  const glass = new THREE.Mesh(
    screenFaceGeometry(W - 0.016, H - 0.016, 0.042 * W),
    phys({ name: 'front_glass', color: 0x08090b, metalness: 0.1, roughness: 0.14, clearcoat: 0.6, clearcoatRoughness: 0.1 }),
  )
  glass.position.z = D / 2 + 0.0004
  device.add(glass)

  const screenMesh = makeScreenMesh(screenFaceGeometry(Sw, Sh, 0.045), screenMaterial)
  screenMesh.position.z = D / 2 + 0.001
  device.add(screenMesh)

  // Apple logo centered on the back (landscape orientation, like the device)
  const logo = appleLogoMesh(0.30, 0x505259)
  logo.rotation.y = Math.PI
  logo.position.z = -D / 2 - 0.0015
  device.add(logo)

  // camera bump on the back top-left corner (as seen from the front)
  const lensMat = phys({ name: 'camera_lens', color: 0x0a0a12, metalness: 0.1, roughness: 0.05 })
  const bump = new THREE.Group()
  bump.name = 'cameraBump'
  const plateGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.22, 0.22, 0.075), {
    depth: 0.008,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 3,
    curveSegments: 32,
  })
  plateGeo.translate(0, 0, -0.014)
  const plate = new THREE.Mesh(plateGeo, bodyMat)
  bump.add(plate)
  // single wide camera + flash + mic (M-series iPad Pro layout)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.018, 40), lensMat)
  lens.rotation.x = Math.PI / 2
  lens.position.set(-0.042, 0.042, -0.018)
  bump.add(lens)
  const lensInner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.004, 28),
    phys({ name: 'camera_lens_inner', color: 0x1a2030, metalness: 0.2, roughness: 0.08 }),
  )
  lensInner.rotation.x = Math.PI / 2
  lensInner.position.set(-0.042, 0.042, -0.028)
  bump.add(lensInner)
  const flash = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.004, 20),
    phys({ name: 'camera_flash', color: 0xf5efdb, metalness: 0, roughness: 0.4, emissive: 0x201a08 }),
  )
  flash.rotation.x = Math.PI / 2
  flash.position.set(0.055, 0.048, -0.017)
  bump.add(flash)
  const mic = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.004, 16),
    phys({ name: 'camera_mic', color: 0x131316, metalness: 0.3, roughness: 0.5 }),
  )
  mic.rotation.x = Math.PI / 2
  mic.position.set(0.055, -0.025, -0.017)
  bump.add(mic)
  bump.position.set(-W / 2 + 0.17, H / 2 - 0.17, -D / 2 + 0.002)
  device.add(bump)

  // Tilt the device back as if propped on the keyboard case; levelScreen
  // (feature off) cancels this via _screenTiltX in applyModelFrame.
  device.rotation.x = -tilt
  device.updateMatrixWorld(true)
  const screenCenter = new THREE.Vector3().setFromMatrixPosition(screenMesh.matrixWorld)
  device.position.sub(screenCenter)
  device.updateMatrixWorld(true)

  // --- Case + Keyboard feature -------------------------------------------
  const kb = new THREE.Group()
  kb.name = 'caseKeyboard'
  kb.userData.openmockRole = 'feature:caseKeyboard'
  content.add(kb)

  const bottomEdge = new THREE.Vector3(0, -H / 2, 0).applyMatrix4(device.matrixWorld)
  const deskY = bottomEdge.y
  const caseMat = phys({ name: 'case_body', color: 0x26272a, metalness: 0.05, roughness: 0.8 })
  const keyMat = phys({ name: 'case_key', color: 0x0e0f11, metalness: 0.05, roughness: 0.55 })

  const baseGeo = new THREE.ExtrudeGeometry(roundedRectShape(W, 0.7, 0.06), {
    depth: 0.016,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
    curveSegments: 16,
  })
  baseGeo.rotateX(-Math.PI / 2) // lie flat, thickness up
  const base = new THREE.Mesh(baseGeo, caseMat)
  base.position.set(0, deskY - 0.02, bottomEdge.z + 0.35)
  kb.add(base)
  const baseTopY = deskY - 0.02 + 0.02

  // key grid: 4 rows of 13 + a bottom row with a spacebar
  const keyGeo = new THREE.BoxGeometry(0.115, 0.014, 0.078)
  const keyCount = 13 * 4 + 5
  const keys = new THREE.InstancedMesh(keyGeo, keyMat, keyCount)
  keys.name = 'case_keys'
  const m4 = new THREE.Matrix4()
  const pitchX = 0.142
  const rows = [0.1, 0.2, 0.3, 0.4].map((dz) => bottomEdge.z + dz)
  let ki = 0
  for (const rz of rows) {
    for (let c = 0; c < 13; c++) {
      m4.makeTranslation((c - 6) * pitchX, baseTopY + 0.008, rz)
      keys.setMatrixAt(ki++, m4)
    }
  }
  const bottomZ = bottomEdge.z + 0.5
  const sideCols = [-6, -5, 5, 6]
  for (const c of sideCols) {
    m4.makeTranslation(c * pitchX, baseTopY + 0.008, bottomZ)
    keys.setMatrixAt(ki++, m4)
  }
  m4.makeScale(6.5, 1, 1).setPosition(0, baseTopY + 0.008, bottomZ)
  keys.setMatrixAt(ki++, m4)
  keys.instanceMatrix.needsUpdate = true
  kb.add(keys)

  const trackpadGeo = slabGeometry(0.74, 0.16, 0.008, 0.02, 0.002, 12)
  trackpadGeo.rotateX(-Math.PI / 2)
  const trackpad = new THREE.Mesh(
    trackpadGeo,
    phys({ name: 'case_trackpad', color: 0x303236, metalness: 0.1, roughness: 0.5 }),
  )
  trackpad.position.set(0, baseTopY + 0.004, bottomEdge.z + 0.62)
  kb.add(trackpad)

  // folded folio wedge propping the device from behind
  const wedgeShape = new THREE.Shape()
  wedgeShape.moveTo(-(bottomEdge.z - 0.01), deskY - 0.018)
  wedgeShape.lineTo(-(bottomEdge.z - 0.34), deskY - 0.018)
  wedgeShape.lineTo(-(bottomEdge.z - 0.1), deskY + 0.62)
  wedgeShape.closePath()
  const wedgeGeo = new THREE.ExtrudeGeometry(wedgeShape, { depth: 1.7, bevelEnabled: false })
  wedgeGeo.rotateY(Math.PI / 2)
  wedgeGeo.translate(-0.85, 0, 0)
  const wedge = new THREE.Mesh(wedgeGeo, caseMat)
  wedge.name = 'case_stand'
  kb.add(wedge)

  return finalizeModel(def, content, screenMesh, screenMaterial, faceAspect)
}

// ---------------------------------------------------------------------------
// Apple Watch Ultra 3
// ---------------------------------------------------------------------------

/**
 * Flat band swept along a side-profile curve. Built as an extruded 2D profile
 * (constant width across the wrist) so orientation is unambiguous: shape space
 * (x, y) = (−world z, world y), extruded along world X with a soft edge bevel.
 */
function strapMesh(
  pts: [number, number][],
  width: number,
  thick: number,
  mat: THREE.Material,
  name: string,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(pts.map(([y, z]) => new THREE.Vector3(0, y, z)))
  const N = 40
  const top: THREE.Vector2[] = []
  const bot: THREE.Vector2[] = []
  let endHalf = thick / 2
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const p = curve.getPoint(t)
    const tg = curve.getTangent(t)
    const tx = -tg.z
    const ty = tg.y
    const il = 1 / Math.max(1e-6, Math.hypot(tx, ty))
    const nx = -ty * il
    const ny = tx * il
    // taper toward the free end so the band reads like a real strap tip
    const k = t < 0.72 ? 1 : 1 - 0.4 * ((t - 0.72) / 0.28) ** 2
    endHalf = (thick / 2) * k
    top.push(new THREE.Vector2(-p.z + nx * endHalf, p.y + ny * endHalf))
    bot.push(new THREE.Vector2(-p.z - nx * endHalf, p.y - ny * endHalf))
  }
  const shape = new THREE.Shape()
  shape.moveTo(top[0].x, top[0].y)
  for (const v of top) shape.lineTo(v.x, v.y)
  // rounded tip: bulge past the last sample along the curve tangent
  {
    const pEnd = curve.getPoint(1)
    const tg = curve.getTangent(1)
    const tx = -tg.z
    const ty = tg.y
    const il = 1 / Math.max(1e-6, Math.hypot(tx, ty))
    const tipX = -pEnd.z + tx * il * endHalf * 1.4
    const tipY = pEnd.y + ty * il * endHalf * 1.4
    shape.quadraticCurveTo(tipX, tipY, bot[N].x, bot[N].y)
  }
  for (let i = N; i >= 0; i--) shape.lineTo(bot[i].x, bot[i].y)
  shape.closePath()
  const bev = Math.min(0.02, thick * 0.3)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bev,
    bevelEnabled: true,
    bevelThickness: bev,
    bevelSize: bev,
    bevelSegments: 3,
    curveSegments: 8,
  })
  geo.rotateY(Math.PI / 2) // shape (x,y,z) → world (z=−x_s stays via rotation, extrusion → +x)
  // extrusion now spans world x ∈ [−bev, width−bev] → center it
  geo.translate(-(width / 2 - bev), 0, 0)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = name
  return mesh
}

function buildWatchUltra3(def: MockupModelDef, screenMaterial: THREE.MeshPhysicalMaterial): LoadedDeviceModel {
  const faceAspect = 1266 / 1542
  const content = new THREE.Group()

  // Mesh names are picked from the watch finish tables so the matteBlack
  // recolor + band recolor systems address them without special-casing.
  const titanium = phys({ name: 'watch_case', color: 0xc4bdb1, metalness: 0.85, roughness: 0.45 })

  const W = 1.5
  const H = 1.7
  const D = 0.42
  const caseMesh = new THREE.Mesh(slabGeometry(W, H, D, 0.45, 0.045, 48, 4), titanium)
  caseMesh.name = 'watch_case_body'
  content.add(caseMesh)

  // flat sapphire front, nearly edge-to-edge with a thin titanium rim
  const glassGeo = new THREE.ExtrudeGeometry(roundedRectShape(1.44, 1.66, 0.44), {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.01,
    bevelSegments: 3,
    curveSegments: 48,
  })
  glassGeo.translate(0, 0, 0.2)
  const glass = new THREE.Mesh(
    glassGeo,
    phys({ name: 'watch_glass', color: 0x0b0d10, metalness: 0, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 }),
  )
  glass.name = 'watch_glass_plate'
  content.add(glass)

  const Sw = 1.28
  const screenMesh = makeScreenMesh(screenFaceGeometry(Sw, Sw / faceAspect, 0.3), screenMaterial)
  screenMesh.position.z = 0.224
  content.add(screenMesh)

  // right edge: one raised guard plateau housing the digital crown (orange
  // ring) and a flush side button — like the Ultra's crown-guard structure
  // (shape = y/z side profile; extrusion becomes the x protrusion after rotateY)
  const guardGeo = slabGeometry(0.3, 1.0, 0.09, 0.13, 0.02, 32)
  guardGeo.rotateY(Math.PI / 2)
  const guard = new THREE.Mesh(guardGeo, titanium)
  guard.position.set(0.735, 0.02, 0.05)
  guard.name = 'watch_crown_guard'
  content.add(guard)

  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.1, 48), phys({ name: 'watch_crown', color: 0xc9c2b6, metalness: 0.95, roughness: 0.3 }))
  crown.rotation.z = Math.PI / 2
  crown.position.set(0.81, 0.34, 0.05)
  crown.name = 'watch_crown_knob'
  content.add(crown)

  const crownRing = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 12, 48), phys({ name: 'watch_crown_ring', color: 0xe6682e, metalness: 0.5, roughness: 0.45 }))
  crownRing.rotation.y = Math.PI / 2
  crownRing.position.set(0.864, 0.34, 0.05)
  crownRing.name = 'watch_crown_accent'
  content.add(crownRing)

  // flat side button, barely proud of the guard
  const sideBtnGeo = slabGeometry(0.11, 0.32, 0.035, 0.05, 0.008, 16)
  sideBtnGeo.rotateY(Math.PI / 2)
  const sideBtn = new THREE.Mesh(sideBtnGeo, phys({ name: 'watch_side_button', color: 0xbdb6aa, metalness: 0.9, roughness: 0.4 }))
  sideBtn.position.set(0.778, -0.26, 0.05)
  sideBtn.name = 'watch_side_btn'
  content.add(sideBtn)

  // orange action button on the left edge
  const actionGeo = slabGeometry(0.055, 0.34, 0.16, 0.025, 0.01, 16)
  actionGeo.rotateY(Math.PI / 2)
  const actionBtn = new THREE.Mesh(actionGeo, phys({ name: 'watch_action_button', color: 0xe05f1f, metalness: 0.5, roughness: 0.45 }))
  actionBtn.position.set(-0.762, 0.1, 0.04)
  actionBtn.name = 'watch_action_btn'
  content.add(actionBtn)

  // back sensor puck
  const back = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.05, 48), phys({ name: 'watch_back', color: 0x2b2d30, metalness: 0.3, roughness: 0.5 }))
  back.rotation.x = Math.PI / 2
  back.position.set(0, 0, -0.215)
  back.name = 'watch_back_puck'
  content.add(back)

  // bands: flat straps tucked under the case edges, wrapping down and back
  // around an implied wrist. Names come from WATCH_BAND_MESHES so the
  // band-colour control finds them.
  const bandMat = phys({ name: 'watch_band', color: 0x3b3b3b, metalness: 0, roughness: 0.92 })
  const strapPath: [number, number][] = [
    [0.6, -0.05],
    [0.95, -0.07],
    [1.3, -0.16],
    [1.62, -0.35],
    [1.9, -0.66],
    [2.06, -1.02],
  ]
  content.add(strapMesh(strapPath, 0.78, 0.075, bandMat, 'watch_band_top'))
  content.add(
    strapMesh(strapPath.map(([y, z]) => [-y, z] as [number, number]), 0.78, 0.075, bandMat, 'watch_band_bottom'),
  )

  return finalizeModel(def, content, screenMesh, screenMaterial, faceAspect)
}

// ---------------------------------------------------------------------------
// Pro Display XDR
// ---------------------------------------------------------------------------

/** Deterministic normal map approximating the XDR's lattice-pattern back. */
let latticeNormals: THREE.DataTexture | null = null

function getLatticeNormalTexture(): THREE.DataTexture {
  if (latticeNormals) return latticeNormals
  const S = 256
  const cellW = 32
  const cellH = 28
  const holeR = 11.5
  const data = new Uint8Array(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let nx = 0
      let ny = 0
      let nz = 1
      // hex packing: alternate rows shift by half a cell; test both neighbors
      const row = Math.floor(y / cellH)
      for (const r of [row, row + 1]) {
        const cy = r * cellH
        const shift = r % 2 === 0 ? 0 : cellW / 2
        const col = Math.round((x - shift) / cellW)
        const cx = col * cellW + shift
        const dx = x - cx
        const dy = y - cy
        const d = Math.hypot(dx, dy)
        if (d < holeR) {
          // concave dimple: normal tilts toward the hole center
          const t = d / holeR
          const tilt = 0.85 * t
          nx = (-dx / Math.max(1e-4, d)) * tilt
          ny = (-dy / Math.max(1e-4, d)) * tilt
          nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
          break
        }
      }
      const i = (y * S + x) * 4
      data[i] = Math.round((nx * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(16, 8)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.colorSpace = THREE.NoColorSpace
  tex.userData.openmockShared = true
  tex.needsUpdate = true
  latticeNormals = tex
  return tex
}

function buildProDisplayXdr(def: MockupModelDef, screenMaterial: THREE.MeshPhysicalMaterial): LoadedDeviceModel {
  const faceAspect = 5515 / 2884
  const content = new THREE.Group()

  const W = 2.42
  const Sw = 2.4
  const Sh = Sw / faceAspect
  const H = Sh + 0.045
  const D = 0.09

  const bodyMat = phys({ name: 'body_frame', color: 0xe8e9eb, metalness: 0.9, roughness: 0.4 })
  const panel = new THREE.Mesh(slabGeometry(W, H, D, 0.05, 0.006), bodyMat)
  panel.name = 'xdr_panel'
  content.add(panel)

  const screenMesh = makeScreenMesh(screenFaceGeometry(Sw, Sh, 0.025), screenMaterial)
  screenMesh.position.z = D / 2 + 0.0008
  content.add(screenMesh)

  // lattice back plate (normal-mapped dimple pattern) — named as a body-class
  // material so classified finishes keep it aluminum (the 'panel' darkening
  // rule targeted the original GLB's screen surround, not the lattice)
  const backMat = phys({ name: 'body_back', color: 0xffffff, metalness: 0.8, roughness: 0.5 })
  backMat.normalMap = getLatticeNormalTexture()
  backMat.normalScale.set(1, 1)
  const backPlate = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.1, H - 0.09), backMat)
  backPlate.rotation.y = Math.PI
  backPlate.position.z = -D / 2 - 0.002
  backPlate.name = 'xdr_back'
  content.add(backPlate)

  // Pro Stand: slim arm on the back, foot extending backward (never in front)
  const standMat = phys({ name: 'body_stand', color: 0xe4e5e7, metalness: 0.9, roughness: 0.42 })
  const armGeo = slabGeometry(0.38, 1.18, 0.06, 0.055, 0.012, 24)
  const arm = new THREE.Mesh(armGeo, standMat)
  arm.rotation.x = 0.1 // lean: top against the panel, bottom kicked back
  arm.position.set(0, -0.34, -0.14)
  arm.name = 'xdr_stand_arm'
  content.add(arm)

  const footGeo = slabGeometry(0.44, 0.58, 0.05, 0.06, 0.008, 24)
  footGeo.rotateX(-Math.PI / 2) // lie flat: length along z
  const foot = new THREE.Mesh(footGeo, standMat)
  foot.position.set(0, -0.915, -0.36)
  foot.name = 'xdr_stand_foot'
  content.add(foot)

  return finalizeModel(def, content, screenMesh, screenMaterial, faceAspect)
}

// ---------------------------------------------------------------------------
// MacBook Pro 14" / 16"
// ---------------------------------------------------------------------------

interface MacbookProFinishColors {
  bg: string
  well: string
  key: string
  legend: string
  dot: string
  trackpad: string
  trackpadStroke: string
  logo: number
  bodyMetalness: number
  bodyRoughness: number
}

/** MacBook Neo colorways: tinted unibody, same-hue lighter keys, dark legends. */
const MACBOOK_NEO_FINISH_COLORS: Record<string, MacbookProFinishColors> = {
  silver: {
    bg: '#e2e3e5', well: '#c9cacd', key: '#f4f4f6', legend: '#4a4a4e', dot: '#c4c5c8',
    trackpad: '#dcdde0', trackpadStroke: 'rgba(0,0,0,0.12)', logo: 0x9a9ca1, bodyMetalness: 0.82, bodyRoughness: 0.42,
  },
  blush: {
    bg: '#f6cccb', well: '#dcb0af', key: '#ffe1e1', legend: '#6b4a49', dot: '#e0b8b7',
    trackpad: '#f0c4c3', trackpadStroke: 'rgba(0,0,0,0.10)', logo: 0xcba9a8, bodyMetalness: 0.7, bodyRoughness: 0.45,
  },
  citrus: {
    bg: '#f5f381', well: '#d9d76a', key: '#fffeaa', legend: '#6d6c33', dot: '#dedc75',
    trackpad: '#eeec7e', trackpadStroke: 'rgba(0,0,0,0.10)', logo: 0xcbca7d, bodyMetalness: 0.7, bodyRoughness: 0.45,
  },
  indigo: {
    bg: '#59657c', well: '#48536a', key: '#7c88aa', legend: '#eef1f8', dot: '#4d586c',
    trackpad: '#525e75', trackpadStroke: 'rgba(0,0,0,0.25)', logo: 0x8898bc, bodyMetalness: 0.72, bodyRoughness: 0.48,
  },
}

const MACBOOK_PRO_FINISHES: Record<string, MacbookProFinishColors> = {
  silver: {
    bg: '#d8dadd',
    well: '#0d0d0f',
    key: '#1a1b1e',
    legend: '#e3e5e8',
    dot: '#a7a9ad',
    trackpad: '#d1d3d7',
    trackpadStroke: 'rgba(0,0,0,0.16)',
    logo: 0x86888e,
    bodyMetalness: 0.85,
    bodyRoughness: 0.42,
  },
  matteBlack: {
    bg: '#2e2f33',
    well: '#0a0a0c',
    key: '#151619',
    legend: '#c9cbd0',
    dot: '#1c1d20',
    trackpad: '#292a2e',
    trackpadStroke: 'rgba(0,0,0,0.4)',
    logo: 0x5c5e64,
    bodyMetalness: 0.8,
    bodyRoughness: 0.5,
  },
}

export interface MacbookProHandle {
  setFinish(finishId: string): void
}

const MACBOOK_PRO_KEY = '_openmockMacbookPro'

type KeySpec = [label: string, width: number]

const KB_ROWS: KeySpec[][] = [
  [['esc', 1.4], ['F1', 1], ['F2', 1], ['F3', 1], ['F4', 1], ['F5', 1], ['F6', 1], ['F7', 1], ['F8', 1], ['F9', 1], ['F10', 1], ['F11', 1], ['F12', 1], ['@touchid', 1.4]],
  [['`', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['delete', 1.5]],
  [['tab', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1], ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1]],
  [['caps', 1.85], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1], ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ["'", 1], ['return', 1.85]],
  [['shift', 2.4], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1], ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['shift', 2.4]],
  [['fn', 1], ['control', 1], ['option', 1], ['command', 1.3], ['@space', 6.1], ['command', 1.3], ['option', 1], ['@arrows', 3]],
]

function drawKey(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  colors: MacbookProFinishColors,
): void {
  const r = Math.min(9, h * 0.14)
  g.fillStyle = colors.key
  g.beginPath()
  g.roundRect(x, y, w, h, r)
  g.fill()
  // faint top-edge highlight for depth
  g.strokeStyle = 'rgba(255,255,255,0.05)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(x + r, y + 0.5)
  g.lineTo(x + w - r, y + 0.5)
  g.stroke()

  if (label === '@touchid') {
    g.strokeStyle = 'rgba(255,255,255,0.22)'
    g.lineWidth = Math.max(1.5, h * 0.03)
    g.beginPath()
    g.arc(x + w / 2, y + h / 2, h * 0.24, 0, Math.PI * 2)
    g.stroke()
    return
  }
  if (!label || label === '@space') return
  g.fillStyle = colors.legend
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const font = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"
  if (label.length === 1) {
    g.font = `500 ${Math.round(h * 0.42)}px ${font}`
    g.fillText(label, x + w / 2, y + h * 0.54)
  } else {
    g.font = `500 ${Math.round(h * 0.24)}px ${font}`
    g.fillText(label, x + w / 2, y + h * 0.72)
  }
}

function drawArrowCluster(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  gap: number,
  colors: MacbookProFinishColors,
): void {
  const kw = (w - 2 * gap) / 3
  const kh = (h - gap) / 2
  const glyph = (cx: number, cy: number, ch: string, keyH: number) => {
    g.fillStyle = colors.legend
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `500 ${Math.round(keyH * 0.6)}px -apple-system, Helvetica, Arial, sans-serif`
    g.fillText(ch, cx, cy + keyH * 0.06)
  }
  const key = (kx: number, ky: number, ch: string) => {
    g.fillStyle = colors.key
    g.beginPath()
    g.roundRect(kx, ky, kw, kh, Math.min(6, kh * 0.2))
    g.fill()
    glyph(kx + kw / 2, ky + kh / 2, ch, kh)
  }
  key(x, y + kh + gap, '◀')
  key(x + kw + gap, y, '▲')
  key(x + kw + gap, y + kh + gap, '▼')
  key(x + 2 * (kw + gap), y + kh + gap, '▶')
}

/** Per-size deck proportions (fractions of body width / deck depth). */
interface MacbookDeckLayout {
  /** keyboard well width (the 14" fits the same keyboard in a smaller body) */
  wellFrac: number
  /** speaker grille outer margin from the body edge */
  grilleMargin: number
  /** trackpad width */
  tpW: number
  /** trackpad depth */
  tpD: number
  /** draw speaker grilles flanking the well */
  grilles: boolean
}

/** Draw the full top deck (palm rest, speaker grilles, keyboard well, trackpad). */
function drawMacbookDeck(
  canvas: HTMLCanvasElement,
  worldW: number,
  worldD: number,
  layout: MacbookDeckLayout,
  colors: MacbookProFinishColors,
): void {
  const g = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  const px = w / worldW // pixels per world unit
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = colors.bg
  g.fillRect(0, 0, w, h)

  // NB canvas v maps: y=0 (top) = back/hinge edge of the deck
  const wellW = layout.wellFrac * worldW * px
  const wellX = (w - wellW) / 2
  const wellY = 0.025 * worldD * px

  // key metrics: total row units incl. gaps + padding must fit wellW
  const gapU = 0.13
  const padU = 0.3
  const maxRowUnits = Math.max(
    ...KB_ROWS.map((row) => row.reduce((a, [, kw]) => a + kw, 0) + (row.length - 1) * gapU),
  )
  const u = wellW / (maxRowUnits + 2 * padU)
  const gapPx = gapU * u
  const rowHeights = [0.62, 1, 1, 1, 1, 1].map((rh) => rh * u)
  const wellH = rowHeights.reduce((a, b) => a + b, 0) + 5 * gapPx + 2 * padU * u
  g.fillStyle = colors.well
  g.beginPath()
  g.roundRect(wellX, wellY, wellW, wellH, 10)
  g.fill()

  // keys
  let ky = wellY + padU * u
  for (let r = 0; r < KB_ROWS.length; r++) {
    const row = KB_ROWS[r]
    const unitsTotal = row.reduce((a, [, kw]) => a + kw, 0) + (row.length - 1) * gapU
    // scale this row to exactly fill the well interior
    const scale = (wellW - 2 * padU * u) / (unitsTotal * u)
    let kx = wellX + padU * u
    const kh = rowHeights[r]
    for (const [label, kwU] of row) {
      const kw = kwU * u * scale
      if (label === '@arrows') drawArrowCluster(g, kx, ky, kw, kh, gapPx * 0.7, colors)
      else drawKey(g, kx, ky, kw, kh, label, colors)
      kx += kw + gapPx * scale
    }
    ky += kh + gapPx
  }

  // speaker grilles flanking the well
  const grilleMargin = layout.grilleMargin * worldW * px
  const grilleGap = 0.018 * worldW * px
  const dotPitch = Math.max(4, Math.round(0.0055 * worldW * px))
  const dotR = dotPitch * 0.26
  g.fillStyle = colors.dot
  for (const [gx0, gx1] of layout.grilles
    ? [
        [grilleMargin, wellX - grilleGap],
        [wellX + wellW + grilleGap, w - grilleMargin],
      ]
    : []) {
    for (let yy = wellY + dotPitch; yy < wellY + wellH - dotPitch / 2; yy += dotPitch) {
      const shift = (Math.round(yy / dotPitch) % 2) * (dotPitch / 2)
      for (let xx = gx0 + dotPitch / 2 + shift; xx < gx1 - dotPitch / 4; xx += dotPitch) {
        g.beginPath()
        g.arc(xx, yy, dotR, 0, Math.PI * 2)
        g.fill()
      }
    }
  }

  // trackpad: fixed real-world proportions, centered below the well
  const tpW = layout.tpW * worldW * px
  const tpH = layout.tpD * worldD * px
  const tpTop = wellY + wellH + 0.035 * worldD * px
  g.fillStyle = colors.trackpad
  g.strokeStyle = colors.trackpadStroke
  g.lineWidth = 2
  g.beginPath()
  g.roundRect((w - tpW) / 2, tpTop, tpW, tpH, 14)
  g.fill()
  g.stroke()
}

function makeBezelTexture(worldW: number, worldH: number, label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = Math.round((1024 * worldH) / worldW)
  const g = c.getContext('2d')!
  g.fillStyle = '#050506'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#43444a'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = "500 17px -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"
  // canvas y=0 is v=1 (top of the open screen); the chin is at the bottom
  if (label) g.fillText(label, c.width / 2, c.height - 20)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function buildMacbookPro(def: MockupModelDef, screenMaterial: THREE.MeshPhysicalMaterial): LoadedDeviceModel {
  const is16 = def.id === 'macbookPro16M3'
  const isNeo = def.id === 'macbookNeo'
  const faceAspect = isNeo ? 2408 / 1506 : is16 ? 3456 / 2234 : 3024 / 1964
  const W = 2.0
  const Dbase = isNeo ? 1.4 : is16 ? 1.395 : 1.415
  const th = isNeo ? 0.072 : is16 ? 0.094 : 0.099
  // real-device deck proportions: the Pro sizes share the same absolute
  // keyboard (so the 14" well fills more of its width and its grilles are much
  // narrower); the Neo is a slim consumer body with no visible grilles
  const layout: MacbookDeckLayout = isNeo
    ? { wellFrac: 0.8, grilleMargin: 0.05, tpW: 0.42, tpD: 0.38, grilles: false }
    : is16
      ? { wellFrac: 0.765, grilleMargin: 0.028, tpW: 0.45, tpD: 0.41, grilles: true }
      : { wellFrac: 0.87, grilleMargin: 0.02, tpW: 0.415, tpD: 0.37, grilles: true }
  const openDeg = def.hinge?.openDeg ?? 110

  const finishTable = isNeo ? MACBOOK_NEO_FINISH_COLORS : MACBOOK_PRO_FINISHES
  const finish = finishTable[isNeo || !is16 ? (isNeo ? 'silver' : 'matteBlack') : 'silver'] ?? finishTable.silver

  const content = new THREE.Group()

  // --- base ---------------------------------------------------------------
  const bodyMat = phys({
    name: 'body_frame',
    color: finish.bg,
    metalness: finish.bodyMetalness,
    roughness: finish.bodyRoughness,
  })
  const baseGeo = slabGeometry(W, Dbase, th, 0.06, 0.014, 32, 4)
  baseGeo.rotateX(-Math.PI / 2) // lie flat
  const base = new THREE.Mesh(baseGeo, bodyMat)
  base.name = 'macbook_base'
  content.add(base)

  // top deck (canvas-drawn keyboard/grilles/trackpad)
  const deckCanvas = document.createElement('canvas')
  deckCanvas.width = 2048
  deckCanvas.height = Math.round((2048 * Dbase) / W)
  drawMacbookDeck(deckCanvas, W, Dbase, layout, finish)
  const deckTex = new THREE.CanvasTexture(deckCanvas)
  deckTex.colorSpace = THREE.SRGBColorSpace
  deckTex.anisotropy = 8
  const deckMat = phys({ name: 'deck', color: 0xffffff, metalness: 0.5, roughness: 0.52 })
  deckMat.map = deckTex
  const deckGeo = screenFaceGeometry(W - 0.03, Dbase - 0.03, 0.05)
  deckGeo.rotateX(-Math.PI / 2) // face up; shape +y (v=1) → −z (back edge)
  const deck = new THREE.Mesh(deckGeo, deckMat)
  deck.position.y = th / 2 + 0.0008
  deck.name = 'macbook_deck'
  content.add(deck)

  // feet
  const footMat = phys({ name: 'macbook_foot', color: 0x121214, metalness: 0.1, roughness: 0.8 })
  for (const [fx, fz] of [
    [-0.82, -Dbase / 2 + 0.13],
    [0.82, -Dbase / 2 + 0.13],
    [-0.82, Dbase / 2 - 0.13],
    [0.82, Dbase / 2 - 0.13],
  ]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.045, 0.014, 24), footMat)
    foot.position.set(fx, -th / 2 - 0.007, fz)
    content.add(foot)
  }

  // --- lid (built closed, opened by rotating lidBody; engine drives pivot) --
  const lidTh = 0.042
  const Dlid = isNeo ? 1.32 : is16 ? 1.36 : 1.375
  const Sw2 = W - 2 * 0.035
  const Sh2 = Sw2 / faceAspect
  const chin = 0.07
  const openRad = (openDeg * Math.PI) / 180

  const pivot = new THREE.Group()
  pivot.name = 'macbook_lid_pivot'
  pivot.position.set(0, th / 2 + lidTh / 2 + 0.004, -Dbase / 2 + 0.04)
  content.add(pivot)

  const lidBody = new THREE.Group()
  lidBody.name = 'macbook_lid'
  lidBody.rotation.x = -openRad // bake the open pose; engine adds (openDeg − angle)
  pivot.add(lidBody)

  const lidGeo = slabGeometry(W, Dlid, lidTh, 0.06, 0.012, 32, 4)
  lidGeo.rotateX(-Math.PI / 2)
  lidGeo.translate(0, 0, Dlid / 2 - 0.02) // hinge at the lid's back edge
  const lid = new THREE.Mesh(lidGeo, bodyMat)
  lid.name = 'macbook_lid_shell'
  lidBody.add(lid)

  // Apple logo on the outer face (upright for an onlooker when the lid is open)
  const logo = appleLogoMesh(0.34, finish.logo, 'logo_lid')
  logo.geometry.rotateX(-Math.PI / 2)
  logo.geometry.rotateY(Math.PI)
  logo.position.set(0, lidTh / 2 + 0.001, Dlid / 2)
  lidBody.add(logo)

  // display bezel (black glass w/ "MacBook Pro" chin engraving) on the inner face
  const bezelGeo = screenFaceGeometry(W - 0.05, Dlid - 0.05, 0.045)
  bezelGeo.rotateX(Math.PI / 2) // face down (closed); v=1 toward the lid's far edge
  const bezelMat = phys({ name: 'screen_bezel', color: 0xffffff, metalness: 0.05, roughness: 0.14, clearcoat: 0.5, clearcoatRoughness: 0.1 })
  bezelMat.map = makeBezelTexture(W - 0.05, Dlid - 0.05, isNeo ? 'MacBook' : 'MacBook Pro')
  const bezel = new THREE.Mesh(bezelGeo, bezelMat)
  bezel.position.set(0, -lidTh / 2 - 0.0006, 0.025 + (Dlid - 0.05) / 2)
  lidBody.add(bezel)

  const screenGeo = screenFaceGeometry(Sw2, Sh2, 0.014)
  screenGeo.rotateX(Math.PI / 2)
  const screenMesh = makeScreenMesh(screenGeo, screenMaterial)
  screenMesh.position.set(0, -lidTh / 2 - 0.0014, chin + Sh2 / 2)
  lidBody.add(screenMesh)

  // physical notch (+ camera dot), toggleable via model.notchNodes
  const notchW = 0.3
  const notchH = 0.035
  const notchGeo = screenFaceGeometry(notchW, notchH, 0.013)
  notchGeo.rotateX(Math.PI / 2)
  const notch = new THREE.Mesh(notchGeo, phys({ name: 'macbook_notch', color: 0x050506, metalness: 0, roughness: 0.4 }))
  notch.name = 'macbook_notch'
  notch.position.set(0, -lidTh / 2 - 0.002, chin + Sh2 - notchH / 2 + 0.004)
  notch.renderOrder = 1000
  const camDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 20),
    phys({ name: 'macbook_camera', color: 0x101418, metalness: 0.2, roughness: 0.3 }),
  )
  camDot.geometry.rotateX(Math.PI / 2)
  camDot.position.set(0, -0.0006, 0)
  camDot.renderOrder = 1001
  notch.add(camDot)
  if (!isNeo) lidBody.add(notch) // the Neo has a plain (notch-free) display

  // hinge clutch bar
  const clutch = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, W * 0.62, 24),
    phys({ name: 'macbook_hinge', color: 0x101012, metalness: 0.2, roughness: 0.6 }),
  )
  clutch.rotation.z = Math.PI / 2
  clutch.position.set(0, th / 2 + 0.012, -Dbase / 2 + 0.038)
  content.add(clutch)

  const model = finalizeModel(def, content, screenMesh, screenMaterial, faceAspect)

  // wire the lid hinge + notch into the contract
  const hinge: LidHinge = { pivot, axis: new THREE.Vector3(1, 0, 0), dir: 1, openDeg }
  model.lidHinge = hinge
  if (!isNeo) model.notchNodes.push(notch)

  // finish handle: retints aluminum + redraws the deck canvas
  const handle: MacbookProHandle = {
    setFinish(finishId: string) {
      const f = finishTable[finishId] ?? finishTable.silver
      bodyMat.color.set(f.bg)
      bodyMat.metalness = f.bodyMetalness
      bodyMat.roughness = f.bodyRoughness
      ;(logo.material as THREE.MeshPhysicalMaterial).color.set(f.logo)
      drawMacbookDeck(deckCanvas, W, Dbase, layout, f)
      deckTex.needsUpdate = true
    },
  }
  ;(model.wrapper.userData as Record<string, unknown>)[MACBOOK_PRO_KEY] = handle
  return model
}

/** Finish hook used by applyFinish ('macbookPro' system). */
export function macbookProHandleOf(model: LoadedDeviceModel): MacbookProHandle | undefined {
  return (model.wrapper.userData as Record<string, unknown>)[MACBOOK_PRO_KEY] as MacbookProHandle | undefined
}

// ---------------------------------------------------------------------------

export function buildProceduralDevice(
  def: MockupModelDef,
  screenMaterial: THREE.MeshPhysicalMaterial,
): LoadedDeviceModel {
  switch (def.id) {
    case 'iphone17':
    case 'iphone17Pro':
    case 'iphone17ProMax':
      return buildIphone17(def, screenMaterial)
    case 'macbookNeo':
      return buildMacbookPro(def, screenMaterial)
    case 'watchUltra3':
      return buildWatchUltra3(def, screenMaterial)
    case 'ipadPro':
      return buildIpadPro(def, screenMaterial)
    case 'proDisplayXdr':
      return buildProDisplayXdr(def, screenMaterial)
    case 'macbookPro14':
    case 'macbookPro16M3':
      return buildMacbookPro(def, screenMaterial)
    default:
      throw new Error(`[devices] no procedural builder for "${def.id}"`)
  }
}

// ---------------------------------------------------------------------------
// iPhone Pro camera plateau — procedurally added onto the shared iPhone 17
// body so the Pro models carry the Pro's full-width plateau + triple camera.
// ---------------------------------------------------------------------------

export interface ProPlateauHandle {
  setTint(tint: THREE.Color): void
}

const PRO_PLATEAU_KEY = '_openmockProPlateau'

/**
 * Build (once) the Pro plateau on the back of the device and return a handle
 * for finish tinting. Geometry is derived from the model's local bounds.
 */
export function ensureIphoneProPlateau(model: LoadedDeviceModel): ProPlateauHandle {
  const ud = model.wrapper.userData as Record<string, unknown>
  const existing = ud[PRO_PLATEAU_KEY] as ProPlateauHandle | undefined
  if (existing) return existing

  const s = model.baseScale || 1
  const min = model.localAABB.min.clone().divideScalar(s)
  const max = model.localAABB.max.clone().divideScalar(s)
  const W = max.x - min.x
  const H = max.y - min.y
  const D = max.z - min.z

  // plateau spans nearly the full width, corner radius following the body
  // (covers the base model's camera bump)
  const sideMargin = 0.024 * W
  const pw = W - 2 * sideMargin
  const ph = 0.275 * H
  const topY = max.y - 0.019 * H
  const cy = topY - ph / 2
  const zFront = min.z + 0.72 * D // buried inside the body
  const zBack = min.z - 0.005 * W // proud of the back face (incl. stock bump)
  const pd = zFront - zBack
  const cz = (zFront + zBack) / 2

  const group = new THREE.Group()
  group.name = 'openmock_pro_plateau'

  const plateauMat = new THREE.MeshPhysicalMaterial({
    color: 0xd8cfc2,
    metalness: 0.72,
    roughness: 0.42,
    clearcoat: 0.25,
    clearcoatRoughness: 0.4,
  })
  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x8f8a82, metalness: 0.85, roughness: 0.35 })
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a0d14,
    metalness: 0.1,
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  })
  const innerMat = new THREE.MeshStandardMaterial({ color: 0x1c2740, metalness: 0.2, roughness: 0.25 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x161616, metalness: 0.3, roughness: 0.5 })

  // extruded rounded rect: big in-plane corner radius independent of depth
  const slabGeo = slabGeometry(pw, ph, pd, 0.19 * ph, Math.min(0.008 * W, pd * 0.3), 40, 3)
  const slab = new THREE.Mesh(slabGeo, plateauMat)
  slab.position.set((min.x + max.x) / 2, cy, cz)
  slab.castShadow = true
  group.add(slab)

  // triple camera column — at local +X so it reads LEFT when viewing the back
  const r = 0.105 * W
  const inset = 0.05 * W
  const lensZ = zBack - 0.004 * W
  const leftX = max.x - sideMargin - inset - r
  const positions: [number, number][] = [
    [leftX, cy + ph / 2 - inset - r],
    [leftX, cy - ph / 2 + inset + r],
    [leftX - 2.05 * r, cy],
  ]
  for (const [lx, ly] of positions) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.012 * W, 48), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.set(lx, ly, lensZ)
    ring.castShadow = true
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.014 * W, 48), glassMat)
    glass.rotation.x = Math.PI / 2
    glass.position.set(lx, ly, lensZ - 0.002 * W)
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.34, r * 0.34, 0.016 * W, 32), innerMat)
    inner.rotation.x = Math.PI / 2
    inner.position.set(lx, ly, lensZ - 0.003 * W)
    group.add(ring, glass, inner)
  }

  // flash + lidar + mic on the other half (reads right from the back)
  const rightX = min.x + sideMargin + inset + 0.05 * W
  const flash = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * W, 0.045 * W, 0.01 * W, 32),
    new THREE.MeshStandardMaterial({ color: 0xfff3d8, emissive: 0x83744a, emissiveIntensity: 0.25, roughness: 0.4 }))
  flash.rotation.x = Math.PI / 2
  flash.position.set(rightX, cy + ph / 2 - inset - 0.05 * W, zBack - 0.001 * W)
  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * W, 0.035 * W, 0.01 * W, 32), darkMat)
  lidar.rotation.x = Math.PI / 2
  lidar.position.set(rightX, cy - ph / 2 + inset + 0.045 * W, zBack - 0.001 * W)
  const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.012 * W, 0.012 * W, 0.01 * W, 16), darkMat)
  mic.rotation.x = Math.PI / 2
  mic.position.set(rightX, cy + 0.02 * H, zBack - 0.001 * W)
  group.add(flash, lidar, mic)

  model.wrapper.add(group)

  const handle: ProPlateauHandle = {
    setTint(tint: THREE.Color) {
      plateauMat.color.copy(tint)
      ringMat.color.copy(tint).multiplyScalar(0.62)
    },
  }
  ud[PRO_PLATEAU_KEY] = handle
  return handle
}
