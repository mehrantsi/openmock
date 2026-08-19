/**
 * Camera pose math for the OpenMock viewport.
 *
 * The camera is NOT orbit-controlled: every frame its world matrix is rebuilt
 * from the dial values as
 *
 *   world = T(0, lift, 0) · R(tiltQuat)⁻¹ · T(panX, panY, −zoom)⁻¹
 *
 * with the tilt Euler evaluated in "YXZ" order. `zoom` is therefore the
 * camera's distance from the origin and tilt orbits the camera around the
 * device. `flap`/`flapX` are applied to the DEVICE group instead (so lighting
 * and reflections respond to flap but not to tilt).
 */

import * as THREE from 'three'
import type { RenderParams } from './renderParams'

/** Substitution defaults for non-finite camera-pose params. */
export const CAMERA_POSE_DEFAULTS: ReadonlyArray<readonly [keyof RenderParams, number]> = [
  ['panX', 0],
  ['panY', 0],
  ['zoom', 2.25],
  ['tiltX', 0],
  ['tiltY', 0],
  ['tiltZ', 0],
  ['flap', 0],
  ['flapX', 0],
  ['fov', 45],
  ['mockupLift', 0],
]

/**
 * Replace non-finite camera-pose fields in place with safe defaults.
 * Returns the list of offending field names (empty when all were finite).
 */
export function sanitizeCameraParams(p: RenderParams): string[] {
  const offenders: string[] = []
  for (const [field, def] of CAMERA_POSE_DEFAULTS) {
    const v = p[field]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      offenders.push(field as string)
      ;(p as unknown as Record<string, number>)[field as string] = def
    }
  }
  return offenders
}

const DEG = Math.PI / 180
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)

// module-level scratch (single-threaded render loop)
const _euler = new THREE.Euler()
const _tiltQuat = new THREE.Quaternion()
const _qx = new THREE.Quaternion()
const _mPan = new THREE.Matrix4()
const _mTilt = new THREE.Matrix4()
const _mLift = new THREE.Matrix4()
const _mWorld = new THREE.Matrix4()
const _scale = new THREE.Vector3()
const _corner = new THREE.Vector3()

/** flapQuat = R(y, flap°) · R(x, flapX°) — applied to the device group. */
export function computeFlapQuat(out: THREE.Quaternion, flapDeg: number, flapXDeg: number): THREE.Quaternion {
  out.setFromAxisAngle(AXIS_Y, flapDeg * DEG)
  _qx.setFromAxisAngle(AXIS_X, flapXDeg * DEG)
  out.multiply(_qx)
  return out
}

export interface CameraPoseParams {
  tiltX: number
  tiltY: number
  tiltZ: number
  panX: number
  panY: number
  zoom: number
  fov: number
}

/**
 * Apply the dial pose to the camera. `lift` is the (possibly ground-clamped)
 * mockup lift; the whole rig translates up with it.
 */
export function applyCameraPose(
  camera: THREE.PerspectiveCamera,
  p: CameraPoseParams,
  aspect: number,
  lift: number,
): void {
  camera.fov = p.fov
  camera.aspect = aspect
  camera.near = 0.1
  camera.far = 100
  camera.updateProjectionMatrix()

  _euler.set(p.tiltX * DEG, p.tiltY * DEG, p.tiltZ * DEG, 'YXZ')
  _tiltQuat.setFromEuler(_euler)

  _mPan.makeTranslation(p.panX, p.panY, -p.zoom).invert()
  _mTilt.makeRotationFromQuaternion(_tiltQuat).invert()
  _mLift.makeTranslation(0, lift, 0)
  _mWorld.identity().multiply(_mLift).multiply(_mTilt).multiply(_mPan)
  _mWorld.decompose(camera.position, camera.quaternion, _scale)
  camera.updateMatrixWorld(true)
}

/** Lowest world-Y of the 8 AABB corners after rotating the box by `quat`. */
export function lowestCornerY(box: THREE.Box3, quat: THREE.Quaternion): number {
  let min = Infinity
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    )
    _corner.applyQuaternion(quat)
    if (_corner.y < min) min = _corner.y
  }
  return min
}

/**
 * Ground-collision lift clamp for environment scenes:
 * lift ≥ groundY − lowestCornerY(deviceAABB rotated by flapQuat).
 */
export function resolveLift(
  requestedLift: number,
  groundY: number,
  aabb: THREE.Box3,
  flapQuat: THREE.Quaternion,
): number {
  const required = groundY - lowestCornerY(aabb, flapQuat)
  return requestedLift < required ? required : requestedLift
}

/** Keep the camera slightly above the ground plane in environment scenes. */
export function clampCameraAboveGround(camera: THREE.PerspectiveCamera, groundY: number): void {
  const minY = groundY + 0.02
  if (camera.position.y < minY) {
    camera.position.y = minY
    camera.updateMatrixWorld(true)
  }
}
