/**
 * PMREM environment / IBL system + studio environment presets + the
 * 3D-model light rig (key light, hemisphere fill, contact shadows).
 *
 * Boot: a procedural RoomEnvironment PMREM fills scene.environment
 * immediately; the default studio HDRI then loads async and replaces it —
 * once as a color PMREM (scene.environment / flat-quad reflections) and once
 * as a GRAYSCALE PMREM (`screenEnvMap`) used by device screen materials so
 * screen reflections stay colorless.
 */

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { ENVIRONMENTS, LIGHTING_DEFAULTS, type EnvPreset } from './environments'
import { deviceHdrPitch } from './devices/registry'
import type { RenderParams } from './renderParams'

const DEG = Math.PI / 180

/** 1×1 transparent-black texture: assigning it as envMap suppresses IBL. */
export function createNoIblTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
  tex.needsUpdate = true
  return tex
}

/** Luma (Rec. 709) grayscale copy of a float RGBA equirect DataTexture. */
function grayscaleEquirect(src: THREE.DataTexture): THREE.DataTexture {
  const img = src.image as { data: Float32Array; width: number; height: number }
  const data = new Float32Array(img.data.length)
  const s = img.data
  for (let i = 0; i < s.length; i += 4) {
    const luma = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2]
    data[i] = luma
    data[i + 1] = luma
    data[i + 2] = luma
    data[i + 3] = s[i + 3]
  }
  const tex = new THREE.DataTexture(data, img.width, img.height, THREE.RGBAFormat, THREE.FloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.flipY = src.flipY
  tex.colorSpace = src.colorSpace
  tex.needsUpdate = true
  return tex
}

function disposeObject(obj: THREE.Object3D): void {
  const mesh = obj as THREE.Mesh
  mesh.geometry?.dispose?.()
  const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
  else mat?.dispose?.()
}

export class LightingSystem {
  /** default IBL: RoomEnvironment PMREM, replaced by the studio HDRI PMREM */
  envTex: THREE.Texture | null = null
  /** grayscale HDRI PMREM for device screen reflections */
  screenEnvMap: THREE.Texture | null = null
  currentEnvId: string | null = null
  currentPreset: EnvPreset | null = null

  readonly envRig: THREE.Group
  readonly noIblTex: THREE.DataTexture
  /** resolves when the default HDRI PMREMs exist (or load failed) */
  readonly defaultHdriReady: Promise<void>

  envGround: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  envBackdrop: THREE.Mesh | null = null
  envSpotLight: THREE.SpotLight | null = null
  envSpotTarget: THREE.Object3D | null = null

  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private pmrem: THREE.PMREMGenerator
  private equirectMode = false
  private roomRT: THREE.WebGLRenderTarget | null = null
  private defaultRT: THREE.WebGLRenderTarget | null = null
  private screenRT: THREE.WebGLRenderTarget | null = null
  private presetRT: THREE.WebGLRenderTarget | null = null
  private presetTextures: THREE.Texture[] = []
  private presetSpotDistance = 1
  private presetToken = 0
  private presetReady: Promise<void> = Promise.resolve()
  private ktx2: KTX2Loader | null = null
  private disposed = false

  // model-mode lights
  private keyLight: THREE.DirectionalLight
  private hemiFill: THREE.HemisphereLight

  // contact-shadow rig
  private contactGroup: THREE.Group
  private contactPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>
  private contactSpot: THREE.SpotLight

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer
    this.scene = scene
    this.noIblTex = createNoIblTexture()

    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()
    // double the PMREM cube size (≤2048) when generating from equirect HDRIs
    const pm = this.pmrem as unknown as { _setSize: (n: number) => void }
    const origSetSize = pm._setSize.bind(this.pmrem)
    pm._setSize = (size: number) => {
      origSetSize(this.equirectMode ? Math.min(2 * size, 2048) : size)
    }

    // boot IBL: procedural room while the HDRI streams in
    const room = new RoomEnvironment()
    this.roomRT = this.pmrem.fromScene(room, 0.04)
    ;(room as unknown as { dispose?: () => void }).dispose?.()
    this.envTex = this.roomRT.texture
    scene.environment = this.envTex
    scene.environmentRotation.set(
      LIGHTING_DEFAULTS.defaultEnvRotation.pitchDeg * DEG,
      LIGHTING_DEFAULTS.defaultEnvRotation.yawDeg * DEG,
      0,
    )

    // environment-preset rig (ground / backdrop / key spot)
    this.envRig = new THREE.Group()
    this.envRig.visible = false
    scene.add(this.envRig)

    // 3D-model "Key Light"
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0)
    this.keyLight.position.set(3, 5, 4)
    scene.add(this.keyLight)
    scene.add(this.keyLight.target)

    // hemisphere fill for 3D models
    this.hemiFill = new THREE.HemisphereLight(0xe6efff, 0x2a2b2e, 0)
    scene.add(this.hemiFill)

    // contact-shadow rig (models without an environment preset)
    this.contactGroup = new THREE.Group()
    this.contactGroup.visible = false
    this.contactPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.ShadowMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
    )
    this.contactPlane.rotation.x = -Math.PI / 2
    this.contactPlane.receiveShadow = true
    this.contactPlane.layers.set(1)
    this.contactSpot = new THREE.SpotLight(0xffffff, 0, 25, Math.PI / 3.6, 0.9, 2)
    this.contactSpot.castShadow = true
    this.contactSpot.position.set(0, 3.5, 6)
    this.contactSpot.shadow.mapSize.set(256, 256)
    this.contactSpot.shadow.camera.near = 1
    this.contactSpot.shadow.camera.far = 20
    this.contactSpot.shadow.camera.fov = 50
    this.contactSpot.shadow.bias = -8e-4
    this.contactSpot.shadow.normalBias = 0.03
    this.contactSpot.layers.set(1)
    const contactTarget = new THREE.Object3D()
    this.contactSpot.target = contactTarget
    this.contactGroup.add(this.contactPlane, this.contactSpot, contactTarget)
    scene.add(this.contactGroup)

    this.defaultHdriReady = this.loadDefaultHdri()
  }

  private pmremFromEquirect(tex: THREE.Texture): THREE.WebGLRenderTarget {
    this.equirectMode = true
    try {
      return this.pmrem.fromEquirectangular(tex)
    } finally {
      this.equirectMode = false
    }
  }

  private async loadDefaultHdri(): Promise<void> {
    try {
      const tex = (await new RGBELoader()
        .setDataType(THREE.FloatType)
        .loadAsync(LIGHTING_DEFAULTS.hdriPath)) as THREE.DataTexture
      tex.mapping = THREE.EquirectangularReflectionMapping
      if (this.disposed) {
        tex.dispose()
        return
      }
      const colorRT = this.pmremFromEquirect(tex)
      const gray = grayscaleEquirect(tex)
      const grayRT = this.pmremFromEquirect(gray)
      this.defaultRT = colorRT
      this.screenRT = grayRT
      this.envTex = colorRT.texture
      this.screenEnvMap = grayRT.texture
      // only take over scene.environment when no preset owns it
      if (!this.currentPreset) this.scene.environment = this.envTex
      this.roomRT?.dispose()
      this.roomRT = null
      tex.dispose()
      gray.dispose()
    } catch (err) {
      console.warn('[env] HDR load failed; staying on procedural RoomEnvironment:', err)
    }
  }

  private getKtx2(): KTX2Loader {
    if (!this.ktx2) {
      this.ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer)
    }
    return this.ktx2
  }

  /** Switch environment presets. Idempotent; safe to call every frame. */
  applyEnvironment(idRaw: string | null): void {
    const id = idRaw || null
    if (id === this.currentEnvId) return
    this.presetToken++
    this.teardownPreset()
    this.currentEnvId = id
    const preset = id ? (ENVIRONMENTS[id] ?? null) : null
    this.currentPreset = preset

    if (!preset) {
      this.envRig.visible = false
      this.renderer.shadowMap.enabled = false
      this.scene.fog = null
      this.scene.environment = this.envTex
      this.presetReady = Promise.resolve()
      return
    }

    this.envRig.visible = true
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.VSMShadowMap

    // fog
    if (preset.fog) {
      const fogColor = preset.fog.color ?? preset.bgColor ?? preset.backdrop?.color ?? '#ffffff'
      this.scene.fog = new THREE.Fog(new THREE.Color(fogColor), preset.fog.near, preset.fog.far)
    } else {
      this.scene.fog = null
    }

    // ground plane
    const g = preset.ground
    const groundMat = new THREE.MeshStandardMaterial({
      roughness: g.roughness ?? 1,
      metalness: 0,
      color: new THREE.Color(g.tint),
      envMap: g.litByIbl ? null : this.noIblTex,
      envMapIntensity: g.litByIbl ? 1 : 0,
    })
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(g.size, g.size), groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = g.y
    ground.receiveShadow = true
    this.envRig.add(ground)
    this.envGround = ground

    const jobs: Promise<void>[] = []
    if (g.maps) jobs.push(this.loadGroundMaps(ground, preset))

    // backdrop cyc (a flat plane despite the name)
    if (preset.backdrop) {
      const b = preset.backdrop
      const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(30 * b.curveRadius, b.height),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(b.color),
          roughness: 1,
          metalness: 0,
          envMap: this.noIblTex,
          envMapIntensity: 0,
        }),
      )
      backdrop.position.set(0, g.y + b.height / 2, b.z)
      backdrop.receiveShadow = true
      this.envRig.add(backdrop)
      this.envBackdrop = backdrop
    }

    // key spotlight (VSM soft shadow)
    const kl = preset.keyLight
    const spot = new THREE.SpotLight(
      new THREE.Color(kl.color),
      kl.intensity,
      kl.distance,
      kl.angle,
      kl.penumbra,
      kl.decay,
    )
    spot.castShadow = true
    spot.shadow.mapSize.set(kl.shadowMapSize, kl.shadowMapSize)
    spot.shadow.bias = 2 * kl.shadowBias
    spot.shadow.radius = kl.shadowRadius
    spot.shadow.blurSamples = 50
    spot.shadow.normalBias = 0.05
    spot.shadow.camera.near = 2
    spot.shadow.camera.far = 25
    spot.position.set(kl.position[0], kl.position[1], kl.position[2])
    const target = new THREE.Object3D()
    target.position.set(kl.target[0], kl.target[1], kl.target[2])
    spot.target = target
    this.envRig.add(spot, target)
    this.envSpotLight = spot
    this.envSpotTarget = target
    const dx = kl.position[0] - kl.target[0]
    const dy = kl.position[1] - kl.target[1]
    const dz = kl.position[2] - kl.target[2]
    this.presetSpotDistance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1

    // IBL: lightFormer bake wins over the preset HDRI
    if (preset.lightFormers.length > 0) {
      const bake = new THREE.Scene()
      for (const lf of preset.lightFormers) {
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(lf.size[0], lf.size[1]),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(lf.color).multiplyScalar(lf.intensity),
            toneMapped: false,
            side: THREE.DoubleSide,
          }),
        )
        panel.position.set(lf.position[0], lf.position[1], lf.position[2])
        panel.lookAt(lf.target[0], lf.target[1], lf.target[2])
        bake.add(panel)
      }
      this.presetRT = this.pmrem.fromScene(bake, 0.04)
      this.scene.environment = this.presetRT.texture
      for (const child of [...bake.children]) disposeObject(child)
    } else {
      jobs.push(this.loadPresetHdri(preset))
    }

    this.presetReady = Promise.all(jobs).then(() => undefined)
  }

  private async loadGroundMaps(
    ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>,
    preset: EnvPreset,
  ): Promise<void> {
    const g = preset.ground
    const maps = g.maps!
    const token = this.presetToken
    try {
      const loader = this.getKtx2()
      const [albedo, normal] = await Promise.all([
        loader.loadAsync(maps.albedo),
        loader.loadAsync(maps.normal),
      ])
      if (token !== this.presetToken || this.disposed) {
        albedo.dispose()
        normal.dispose()
        return
      }
      const maxAniso = this.renderer.capabilities.getMaxAnisotropy()
      for (const t of [albedo, normal]) {
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.repeat.set(g.uvRepeat, g.uvRepeat)
        if (g.uvOffset) t.offset.set(g.uvOffset[0], g.uvOffset[1])
        t.anisotropy = maxAniso
        t.needsUpdate = true
      }
      albedo.colorSpace = THREE.SRGBColorSpace
      const mat = ground.material
      mat.map = albedo
      // presets reuse the diffuse texture as their roughness source
      mat.roughnessMap = albedo
      mat.normalMap = normal
      if (maps.normalIsDirectX) mat.normalScale.y = -1
      mat.needsUpdate = true
      this.presetTextures.push(albedo, normal)
    } catch (err) {
      console.warn('[env] ground texture load failed:', err)
    }
  }

  private async loadPresetHdri(preset: EnvPreset): Promise<void> {
    const token = this.presetToken
    try {
      const tex = (await new RGBELoader()
        .setDataType(THREE.FloatType)
        .loadAsync(preset.hdri)) as THREE.DataTexture
      tex.mapping = THREE.EquirectangularReflectionMapping
      if (token !== this.presetToken || this.disposed) {
        tex.dispose()
        return
      }
      this.presetRT = this.pmremFromEquirect(tex)
      this.scene.environment = this.presetRT.texture
      tex.dispose()
    } catch (err) {
      console.warn('[env] preset HDR load failed:', err)
    }
  }

  private teardownPreset(): void {
    for (const child of [...this.envRig.children]) {
      disposeObject(child)
      this.envRig.remove(child)
    }
    for (const t of this.presetTextures) t.dispose()
    this.presetTextures = []
    this.presetRT?.dispose()
    this.presetRT = null
    this.envGround = null
    this.envBackdrop = null
    this.envSpotLight = null
    this.envSpotTarget = null
  }

  /** Awaits the default HDRI, applies the preset, then its async resources. */
  async prepareEnvironment(envId: string | null): Promise<void> {
    await this.defaultHdriReady
    this.applyEnvironment(envId)
    await this.presetReady
  }

  /** Per-frame lighting/env updates. */
  updateFrame(params: RenderParams, modelActive: boolean, modelId: string): void {
    const preset = this.currentPreset
    const scene = this.scene

    if (preset) {
      this.envRig.position.set(0, 0, preset.referenceZoom)
      if (this.envGround) this.envGround.position.y = preset.ground.y
      if (preset.backdrop && this.envBackdrop) {
        this.envBackdrop.position.y = preset.ground.y + preset.backdrop.height / 2
      }
      if (this.envSpotLight && this.envSpotTarget) {
        const kl = preset.keyLight
        this.envSpotLight.position.set(
          kl.position[0] + (params.envLightX ?? 0),
          kl.position[1] + (params.envLightHeight ?? 0),
          kl.position[2] + (params.envLightZ ?? 0),
        )
        this.envSpotTarget.position.set(kl.target[0], kl.target[1], kl.target[2])
        // keep the shadow softness perceptually stable as the light moves
        const c = this.envSpotLight.position.distanceTo(this.envSpotTarget.position) / this.presetSpotDistance
        this.envSpotLight.shadow.radius = kl.shadowRadius * c * c
      }
    }

    scene.environmentIntensity =
      (preset?.hdriIntensity ?? 1) *
      LIGHTING_DEFAULTS.envIntensityMul *
      (modelActive && !preset ? params.iblIntensity : 1)

    // model key light
    this.keyLight.intensity = modelActive && !preset ? params.keyLight : 0
    if (this.keyLight.position.y !== params.keyLightHeight) this.keyLight.position.y = params.keyLightHeight
    const ang = Math.atan2(4, 3) + params.keyLightRotation * DEG
    this.keyLight.position.x = 5 * Math.cos(ang)
    this.keyLight.position.z = 5 * Math.sin(ang)

    // hemisphere fill
    this.hemiFill.intensity = modelActive && !preset ? LIGHTING_DEFAULTS.hemiFillIntensity : 0

    // IBL rotation
    if (modelActive && !preset) {
      scene.environmentRotation.set(deviceHdrPitch(modelId) * DEG, params.hdrYaw * DEG, 0)
    } else {
      scene.environmentRotation.set(
        LIGHTING_DEFAULTS.defaultEnvRotation.pitchDeg * DEG,
        LIGHTING_DEFAULTS.defaultEnvRotation.yawDeg * DEG,
        0,
      )
    }
  }

  /**
   * Contact-shadow rig for 3D models without an environment preset. The rig
   * sits under the model's rotated AABB (`floorLocalY` = lowest corner Y).
   */
  updateContactShadow(active: boolean, modelPos: THREE.Vector3, floorLocalY: number): void {
    const r = this.renderer
    if (active) {
      const cs = LIGHTING_DEFAULTS.contactShadow
      if (!r.shadowMap.enabled) {
        r.shadowMap.enabled = true
        r.shadowMap.type = THREE.PCFShadowMap
      } else if (r.shadowMap.type !== THREE.PCFShadowMap) {
        r.shadowMap.type = THREE.PCFShadowMap
      }
      const spot = this.contactSpot
      if (spot.position.y !== cs.lightY || spot.position.z !== cs.lightZ) {
        spot.position.set(0, cs.lightY, cs.lightZ)
      }
      const angle = cs.coneDeg * DEG
      if (spot.angle !== angle) spot.angle = angle
      if (spot.penumbra !== cs.penumbra) spot.penumbra = cs.penumbra
      if (spot.shadow.mapSize.x !== cs.mapSize) {
        spot.shadow.mapSize.set(cs.mapSize, cs.mapSize)
        spot.shadow.map?.dispose()
        spot.shadow.map = null
      }
      if (spot.shadow.bias !== cs.bias) spot.shadow.bias = cs.bias
      if (spot.shadow.normalBias !== cs.normalBias) spot.shadow.normalBias = cs.normalBias
      const mat = this.contactPlane.material
      if (mat.opacity !== cs.opacity) mat.opacity = cs.opacity
      this.contactGroup.position.set(modelPos.x, modelPos.y + floorLocalY, modelPos.z)
      spot.target.position.set(0, 0, 0)
      this.contactGroup.visible = true
    } else {
      this.contactGroup.visible = false
      if (!this.currentPreset && r.shadowMap.enabled) r.shadowMap.enabled = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.presetToken++
    this.teardownPreset()
    this.roomRT?.dispose()
    this.defaultRT?.dispose()
    this.screenRT?.dispose()
    this.pmrem.dispose()
    this.ktx2?.dispose()
    this.noIblTex.dispose()
    disposeObject(this.contactPlane)
    this.contactSpot.shadow.map?.dispose()
  }
}
