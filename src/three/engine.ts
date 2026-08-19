/**
 * OpenMock render engine: WebGLRenderer + scene graph + post chain.
 *
 * Render paths per frame:
 *  - FAST PATH: with no post effect, no 3D model, full opacity and no
 *    transparent capture, the scene is drawn straight to the canvas (the
 *    background quad sRGB-encodes itself, u_writeAlpha = 1).
 *  - COMPOSER PATH: RenderPass → BloomPass → GhostPass → blurH → blurV
 *    (composites ghost/bloom/vignette/CA/grain/sharpen/opacity) → Liquid
 *    Glass → patched OutputPass, over a HalfFloat linear MSAA target.
 *
 * Special cases: mockup-opacity crossfade renders the scene twice (model
 * hidden/shown) into two RGBA8 MSAA targets and mixes them into the composer
 * read buffer; opaque 3D models get their screen mesh (layer 3) re-rendered
 * untonemapped on top after the composer; transparent PNG capture reads the
 * composer buffer back with forced non-opaque alpha.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type {
  CaptureOptions,
  Engine,
  EngineOptions,
  LoadedDeviceModel,
  MediaSource,
} from './contracts'
import type { RenderParams } from './renderParams'
import { BackgroundSystem } from './background'
import { FlatMockup } from './flatMockup'
import { LightingSystem } from './lighting'
import { createBlurHPass, createBlurVPass } from './passes/dofPass'
import { BloomPass } from './passes/bloomPass'
import { GhostPass } from './passes/ghostPass'
import { createGlassScreenPass } from './passes/glassScreenPass'
import { PatchedOutputPass } from './passes/outputPass'
import {
  applyCameraPose,
  clampCameraAboveGround,
  computeFlapQuat,
  lowestCornerY,
  resolveLift,
  sanitizeCameraParams,
} from './cameraRig'
import { loadDeviceModel, applyModelFrame } from './devices/loader'
import { DeviceScreenComposer } from './devices/deviceScreen'
import { webkitVideoPresentQuirk } from '../lib/browser'

/** Engine with OpenMock extensions beyond the base contract. */
export interface OpenMockEngine extends Engine {
  /** background image blur (scene.bgBlur, 0–1 → blur(60*v px), CPU-side) */
  setBgBlur(amount: number): void
}

const BLEND_VERTEX = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const BLEND_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_full;
uniform sampler2D u_bg;
uniform float u_mix;
void main() {
  vec4 full = texture2D(u_full, v_uv);
  vec4 bg = texture2D(u_bg, v_uv);
  gl_FragColor = mix(bg, full, u_mix);
}
`

const COPY_VERTEX = /* glsl */ `in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`

const COPY_FRAGMENT = /* glsl */ `precision highp float;
in vec2 vUv;
uniform sampler2D tDiffuse;
out vec4 fragColor;
void main() { fragColor = texture(tDiffuse, vUv); }`

const WEBGL_UNSUPPORTED_MESSAGE =
  'Failed to create a WebGL context. The device may have hardware acceleration disabled, ' +
  'be in low-power mode, or have too many active WebGL contexts.'

function clampAbs(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v))
}

export function createEngine(canvas: HTMLCanvasElement, opts: EngineOptions = {}): OpenMockEngine {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    })
  } catch {
    throw new Error(WEBGL_UNSUPPORTED_MESSAGE)
  }
  renderer.setPixelRatio(1)
  renderer.autoClear = true
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping

  const onContextLost = (ev: Event) => ev.preventDefault()
  canvas.addEventListener('webglcontextlost', onContextLost)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100)
  camera.position.set(0, 0, 0)
  camera.layers.enable(2) // background + glass border
  camera.layers.enable(1) // contact shadow

  const background = new BackgroundSystem(renderer)
  scene.add(background.mesh)

  const flat = new FlatMockup()
  flat.addTo(scene)

  const modelGroup = new THREE.Group()
  modelGroup.visible = false
  scene.add(modelGroup)

  const lighting = new LightingSystem(renderer, scene)
  const screenComposer = new DeviceScreenComposer(renderer)

  // ---- composer chain ----------------------------------------------------
  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
  })
  const composer = new EffectComposer(renderer, composerTarget)
  const renderPass = new RenderPass(scene, camera)
  const bloomPass = new BloomPass(scene, camera)
  const ghostPass = new GhostPass(scene, camera)
  const blurH = createBlurHPass()
  const blurV = createBlurVPass()
  const glassPass = createGlassScreenPass()
  const outputPass = new PatchedOutputPass()
  composer.addPass(renderPass)
  composer.addPass(bloomPass)
  composer.addPass(ghostPass)
  composer.addPass(blurH)
  composer.addPass(blurV)
  composer.addPass(glassPass)
  composer.addPass(outputPass)
  blurV.uniforms.u_bloomTex.value = bloomPass.targetA.texture
  blurV.uniforms.u_ghostTex.value = ghostPass.targetA.texture
  blurV.uniforms.u_ghostMaskTex.value = ghostPass.sourceTarget.texture

  // mockup-opacity crossfade targets + blend quad
  const xfadeOpts: THREE.RenderTargetOptions = {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
  }
  const xfadeFull = new THREE.WebGLRenderTarget(1, 1, xfadeOpts)
  const xfadeBg = new THREE.WebGLRenderTarget(1, 1, xfadeOpts)
  const blendMaterial = new THREE.ShaderMaterial({
    uniforms: { u_full: { value: null }, u_bg: { value: null }, u_mix: { value: 1 } },
    vertexShader: BLEND_VERTEX,
    fragmentShader: BLEND_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  })
  const blendQuad = new FullScreenQuad(blendMaterial)

  // transparent-capture readback blit
  const copyMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tDiffuse: { value: null } },
    vertexShader: COPY_VERTEX,
    fragmentShader: COPY_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    blending: THREE.NoBlending,
  })
  const copyQuad = new FullScreenQuad(copyMaterial)
  let captureRT: THREE.WebGLRenderTarget | null = null

  // ---- media -------------------------------------------------------------
  let mediaTexture: THREE.Texture | null = null
  let mediaAspect = 16 / 9
  let mediaKind: 'image' | 'video' | 'frame' | null = null
  let mockupBgTexture: THREE.Texture | null = null

  function setMedia(source: MediaSource): void {
    mediaTexture?.dispose()
    mediaTexture = null
    mediaKind = null
    if (!source) {
      mediaAspect = 16 / 9
      flat.setMediaTexture(null)
      flat.setAspect(mediaAspect)
      screenComposer.setMedia(null, mediaAspect, false)
      return
    }
    if (source.kind === 'video') {
      const el = source.element
      const tex = new THREE.VideoTexture(el)
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      mediaTexture = tex
      mediaAspect = el.videoWidth > 0 && el.videoHeight > 0 ? el.videoWidth / el.videoHeight : 16 / 9
    } else if (source.kind === 'frame') {
      const el = source.element
      const tex = new THREE.CanvasTexture(el)
      tex.flipY = true
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      mediaTexture = tex
      mediaAspect = el.width > 0 && el.height > 0 ? el.width / el.height : 16 / 9
    } else {
      const el = source.element
      const tex = new THREE.Texture(el as HTMLImageElement)
      tex.flipY = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = true
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      mediaTexture = tex
      const w =
        el instanceof HTMLImageElement ? el.naturalWidth || el.width : (el as ImageBitmap).width
      const h =
        el instanceof HTMLImageElement ? el.naturalHeight || el.height : (el as ImageBitmap).height
      mediaAspect = w > 0 && h > 0 ? w / h : 16 / 9
    }
    mediaKind = source.kind
    flat.setMediaTexture(mediaTexture)
    flat.setAspect(mediaAspect)
    screenComposer.setMedia(mediaTexture, mediaAspect, source.kind === 'video')
  }

  function setMockupBgImage(img: HTMLImageElement | ImageBitmap | null): void {
    mockupBgTexture?.dispose()
    mockupBgTexture = null
    if (img) {
      const tex = new THREE.Texture(img as HTMLImageElement)
      tex.flipY = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = true
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      mockupBgTexture = tex
    }
    screenComposer.setBgImage(mockupBgTexture)
  }

  // ---- models ------------------------------------------------------------
  const models = new Map<string, LoadedDeviceModel>()
  const pendingModels = new Map<string, Promise<void>>()
  let lastConfiguredModelId = ''

  function emitModelLoad(id: string, loading: boolean, progress: number): void {
    engine.onModelLoad?.({ id, loading, progress })
  }

  async function prepareModel(modelId: string): Promise<void> {
    if (!modelId || models.has(modelId)) return
    let pending = pendingModels.get(modelId)
    if (!pending) {
      pending = (async () => {
        emitModelLoad(modelId, true, 0)
        try {
          const model = await loadDeviceModel(modelId, renderer, screenComposer.texture, (p) =>
            emitModelLoad(modelId, true, p),
          )
          models.set(modelId, model)
          modelGroup.add(model.wrapper)
          model.wrapper.visible = false
          emitModelLoad(modelId, false, 1)
        } catch (err) {
          pendingModels.delete(modelId)
          emitModelLoad(modelId, false, 0)
          throw err
        }
      })()
      pendingModels.set(modelId, pending)
    }
    await pending
  }

  // ---- sizing ------------------------------------------------------------
  let curWidth = -1
  let curHeight = -1

  function resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (w === curWidth && h === curHeight) return
    curWidth = w
    curHeight = h
    renderer.setSize(w, h, false)
    composer.setSize(w, h)
    xfadeFull.setSize(w, h)
    xfadeBg.setSize(w, h)
  }

  // ---- render ------------------------------------------------------------
  const flapQuat = new THREE.Quaternion()
  const flatAABB = new THREE.Box3()
  const ghostLocal = new THREE.Vector3()
  const ghostP0 = new THREE.Vector3()
  const ghostP1 = new THREE.Vector3()
  const cornerV = new THREE.Vector3()
  const clearScratch = new THREE.Color()
  let warnedNonFinite = false

  function renderFrame(params: RenderParams, transparentCapture: boolean): void {
    const offenders = sanitizeCameraParams(params)
    if (offenders.length > 0 && !warnedNonFinite) {
      warnedNonFinite = true
      console.error('openmock engine: non-finite render params substituted with defaults', offenders)
    }

    const width = canvas.width
    const height = canvas.height
    if (width <= 0 || height <= 0) return
    const aspect = width / height

    // canvas frames have no change signal; VideoTexture relies on
    // requestVideoFrameCallback, which Safari doesn't fire for paused seeks
    if ((mediaKind === 'frame' || (mediaKind === 'video' && webkitVideoPresentQuirk)) && mediaTexture)
      mediaTexture.needsUpdate = true

    lighting.applyEnvironment(params.environment || null)
    const preset = lighting.currentPreset
    const model = params.mockupModel ? (models.get(params.mockupModel) ?? null) : null
    const modelActive = model !== null

    // per-frame renderer invariants (tone mapping stays OFF; OutputPass only
    // performs the sRGB transfer)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.NoToneMapping
    renderer.toneMappingExposure = 1

    // device rotation + lift (with env ground collision)
    computeFlapQuat(flapQuat, params.flap, params.flapX)
    let lift = params.mockupLift ?? 0
    if (preset?.ground.collide) {
      let aabb: THREE.Box3
      if (model) {
        aabb = model.localAABB
      } else {
        flatAABB.min.set(-flat.halfW, -flat.halfH, 0)
        flatAABB.max.set(flat.halfW, flat.halfH, 0)
        aabb = flatAABB
      }
      const clamped = resolveLift(lift, preset.ground.y, aabb, flapQuat)
      if (clamped > lift && Math.abs(clamped - lift) > 1e-4) opts.onLiftClamp?.(clamped)
      lift = clamped
    }
    applyCameraPose(camera, params, aspect, lift)
    if (preset?.ground.collide) clampCameraAboveGround(camera, preset.ground.y)

    // model / flat dispatch
    if (model) {
      if (model.id !== lastConfiguredModelId) {
        screenComposer.configureFor(model)
        lastConfiguredModelId = model.id
      }
      modelGroup.visible = true
      modelGroup.scale.setScalar(model.baseScale)
      modelGroup.position.set(0, lift, 0)
      modelGroup.quaternion.copy(flapQuat)
      for (const m of models.values()) m.wrapper.visible = m === model
      applyModelFrame(model, params, { screenEnvMap: lighting.screenEnvMap })
      screenComposer.update(model, params)
    } else {
      modelGroup.visible = false
    }

    // flat quad, Screen Fade rig, glass border, extrude slab
    flat.update(params, {
      lift,
      flapQuat,
      modelActive,
      envActive: preset !== null,
      canvasWidth: width,
      canvasHeight: height,
      envTex: lighting.envTex,
      noIblTex: lighting.noIblTex,
      bgUniforms: background.uniforms,
      bgHasImage: background.hasImage(),
    })

    // env rig / IBL / key light / hemisphere fill
    lighting.updateFrame(params, modelActive, model?.id ?? '')

    // contact shadows (models without an env preset)
    const contactActive = modelActive && !preset && params.contactShadow && model !== null
    lighting.updateContactShadow(
      contactActive,
      modelGroup.position,
      model ? lowestCornerY(model.localAABB, flapQuat) : 0,
    )

    // clear color
    if (params.transparentBg) {
      renderer.setClearColor(0x000000, 0)
    } else if (preset) {
      renderer.setClearColor(clearScratch.set(preset.bgColor ?? preset.backdrop?.color ?? '#000000'), 1)
    } else {
      renderer.setClearColor(
        clearScratch.setRGB(params.bgColor[0], params.bgColor[1], params.bgColor[2], THREE.SRGBColorSpace),
        1,
      )
    }

    // background quad mode dispatch
    background.update(params, width, height)

    // mockup opacity
    const rawOpacity = params.mockupOpacity ?? 1
    const mockupOpacity = Math.max(0, Math.min(1, rawOpacity))
    flat.applyMockupOpacity(mockupOpacity, modelActive)
    const fullyHidden = rawOpacity <= 0.001
    const crossfading = modelActive && !fullyHidden && rawOpacity < 0.999

    // fast path vs composer
    const blurActive = params.blurStrength >= 0.5
    const caActive = params.caStrength > 0
    const pixelEffects =
      params.vignette > 0 || params.grain > 0 || params.opacity < 1 || params.sharpen > 0 || caActive
    const bloomActive = params.bloomEnabled && params.bloomStrength > 0
    const ghostActive = params.ghostOpacity > 0
    const useComposer =
      blurActive ||
      pixelEffects ||
      bloomActive ||
      ghostActive ||
      params.screenGlass ||
      modelActive ||
      transparentCapture ||
      crossfading

    background.setWriteAlpha(useComposer ? 0 : 1)
    if (!useComposer) {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return
    }

    // ---- composer uniforms ----
    const captureScale = params.captureScale ?? 1
    const v2 = params.blurBokeh ? 1 : 0
    const strength =
      (params.blurBokeh ? Math.min(params.blurStrength, 20) : params.blurStrength) * captureScale

    for (const uniforms of [blurH.uniforms, blurV.uniforms]) {
      ;(uniforms.u_resolution.value as THREE.Vector2).set(width, height)
      uniforms.u_blurStrength.value = strength
      ;(uniforms.u_focusPoint.value as THREE.Vector2).set(params.focusX, params.focusY)
      uniforms.u_focusSize.value = params.focusSize
      uniforms.u_blurMode.value = params.blurMode
      uniforms.u_blurAngle.value = params.blurAngle
      uniforms.u_tiltBand.value = params.tiltBand
      uniforms.u_dirPosition.value = params.dirPosition
      uniforms.u_blurFalloff.value = params.blurFalloff
      uniforms.u_v2.value = v2
    }

    const vu = blurV.uniforms
    vu.u_vignette.value = params.vignette
    vu.u_grain.value = params.grain
    vu.u_sharpen.value = params.sharpen
    vu.u_sharpenScale.value = captureScale
    vu.u_time.value = params.time
    vu.u_opacity.value = params.opacity
    vu.u_caStrength.value = caActive ? params.caStrength : 0

    if (bloomActive) {
      bloomPass.enabled = true
      bloomPass.threshold = params.bloomThreshold
      bloomPass.radius = params.bloomRadius * captureScale
      vu.u_bloomStrength.value = crossfading ? params.bloomStrength * mockupOpacity : params.bloomStrength
    } else {
      bloomPass.enabled = false
      vu.u_bloomStrength.value = 0
    }

    if (ghostActive) {
      ghostPass.enabled = true
      ghostPass.radius = params.ghostBlur * captureScale
      // author the echo offset in the mockup's own plane, then project it
      // through the live camera so tilt/zoom/foreshortening are baked in
      const hw = flat.halfW
      const hh = flat.halfH
      ghostLocal
        .set(params.ghostOffsetX * hw * 2, -params.ghostOffsetY * hh * 2, -params.ghostDepth * hh * 2)
        .applyQuaternion(flat.quad.quaternion)
      ghostP0.copy(flat.quad.position).project(camera)
      ghostP1.copy(flat.quad.position).add(ghostLocal).project(camera)
      ;(vu.u_ghostOffset.value as THREE.Vector2).set(
        clampAbs((ghostP1.x - ghostP0.x) * 0.5, 0.25),
        clampAbs((ghostP1.y - ghostP0.y) * 0.5, 0.25),
      )
      vu.u_ghostOpacity.value = crossfading ? params.ghostOpacity * mockupOpacity : params.ghostOpacity
    } else {
      ghostPass.enabled = false
      vu.u_ghostOpacity.value = 0
    }

    // bokeh resolves its whole 2D kernel in the V pass — the H pass would be
    // a full-resolution passthrough copy, so skip it entirely
    blurH.enabled = blurActive && !params.blurBokeh
    glassPass.enabled = params.screenGlass

    if (params.screenGlass) {
      const gu = glassPass.uniforms
      ;(gu.u_resolution.value as THREE.Vector2).set(width, height)
      gu.u_strength.value = params.screenGlassStrength
      gu.u_radius.value = params.borderRadius
      gu.u_shine.value = params.screenGlassShine
      gu.u_isDark.value = params.glassDark ? 1 : 0
      const p00 = gu.u_p00.value as THREE.Vector2
      const p10 = gu.u_p10.value as THREE.Vector2
      const p11 = gu.u_p11.value as THREE.Vector2
      const p01 = gu.u_p01.value as THREE.Vector2
      let useQuad = params.screenGlassTarget !== 'frame' && !params.mockupModel
      if (useQuad) {
        camera.updateMatrixWorld()
        flat.quad.updateWorldMatrix(true, false)
        const corners: Array<[number, number, THREE.Vector2]> = [
          [-0.5, -0.5, p00],
          [0.5, -0.5, p10],
          [0.5, 0.5, p11],
          [-0.5, 0.5, p01],
        ]
        for (const [cx, cy, out] of corners) {
          cornerV.set(cx, cy, 0).applyMatrix4(flat.quad.matrixWorld).project(camera)
          const sx = 0.5 * cornerV.x + 0.5
          const sy = 0.5 * cornerV.y + 0.5
          if (!Number.isFinite(sx) || !Number.isFinite(sy) || cornerV.z > 1) {
            useQuad = false
            break
          }
          out.set(sx, sy)
        }
        // reject a degenerate (near-zero area) projected quad
        if (
          useQuad &&
          Math.abs((p10.x - p00.x) * (p01.y - p00.y) - (p10.y - p00.y) * (p01.x - p00.x)) < 1e-4
        ) {
          useQuad = false
        }
      }
      if (!useQuad) {
        p00.set(0, 0)
        p10.set(1, 0)
        p11.set(1, 1)
        p01.set(0, 1)
      }
    }

    // ---- mockup-opacity crossfade (3D models) ----
    if (crossfading) {
      renderPass.enabled = false
      const wasVisible = modelGroup.visible
      modelGroup.visible = false
      renderer.setRenderTarget(xfadeBg)
      renderer.render(scene, camera)
      modelGroup.visible = true
      renderer.setRenderTarget(xfadeFull)
      renderer.render(scene, camera)
      modelGroup.visible = wasVisible
      blendMaterial.uniforms.u_bg.value = xfadeBg.texture
      blendMaterial.uniforms.u_full.value = xfadeFull.texture
      blendMaterial.uniforms.u_mix.value = mockupOpacity
      renderer.setRenderTarget(composer.readBuffer)
      blendQuad.render(renderer)
    } else {
      renderPass.enabled = true
    }

    // mockupOpacity ≈ 0: hide every mockup element during the composer render
    let hiddenState: { model: boolean; quad: boolean; glass: boolean; extrude: boolean } | null = null
    if (fullyHidden) {
      hiddenState = {
        model: modelGroup.visible,
        quad: flat.quad.visible,
        glass: flat.glassMesh.visible,
        extrude: flat.extrudeMesh.visible,
      }
      modelGroup.visible = false
      flat.quad.visible = false
      flat.glassMesh.visible = false
      flat.extrudeMesh.visible = false
    }

    composer.render()

    if (hiddenState) {
      modelGroup.visible = hiddenState.model
      flat.quad.visible = hiddenState.quad
      flat.glassMesh.visible = hiddenState.glass
      flat.extrudeMesh.visible = hiddenState.extrude
    }

    // re-render the device screen (layer 3) on top, untonemapped, so screen
    // content stays crisp when the model is fully opaque
    if (modelActive && !crossfading && !fullyHidden) {
      const prevTone = renderer.toneMapping
      const prevAuto = renderer.autoClear
      const prevMask = camera.layers.mask
      try {
        renderer.toneMapping = THREE.NoToneMapping
        renderer.autoClear = false
        camera.layers.set(3)
        renderer.setRenderTarget(composer.renderToScreen ? null : composer.readBuffer)
        renderer.render(scene, camera)
      } finally {
        camera.layers.mask = prevMask
        renderer.autoClear = prevAuto
        renderer.toneMapping = prevTone
      }
    }
  }

  // ---- capture -----------------------------------------------------------
  async function captureToBlob(o: CaptureOptions): Promise<Blob> {
    const prevW = curWidth
    const prevH = curHeight
    const mime = o.format === 'png' ? 'image/png' : o.format === 'webp' ? 'image/webp' : 'image/jpeg'
    const quality = o.quality ?? (o.format === 'webp' ? 0.95 : 0.94)
    const transparent = !!o.transparent && o.format !== 'jpeg'
    const params: RenderParams = { ...o.params }

    try {
      resize(o.width, o.height)
      const out = document.createElement('canvas')
      out.width = o.width
      out.height = o.height
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('Failed to acquire 2D context for capture')

      if (transparent) {
        const prevRTS = composer.renderToScreen
        const prevForce = outputPass.getForceOpaqueAlpha()
        composer.renderToScreen = false
        outputPass.setForceOpaqueAlpha(0)
        try {
          renderFrame(params, true)
        } finally {
          composer.renderToScreen = prevRTS
          outputPass.setForceOpaqueAlpha(prevForce)
        }

        // resolve the composer read buffer into a plain RGBA8 target
        if (!captureRT || captureRT.width !== o.width || captureRT.height !== o.height) {
          captureRT?.dispose()
          captureRT = new THREE.WebGLRenderTarget(o.width, o.height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: false,
            stencilBuffer: false,
          })
        }
        copyMaterial.uniforms.tDiffuse.value = composer.readBuffer.texture
        const prevTarget = renderer.getRenderTarget()
        const prevAuto = renderer.autoClear
        renderer.setRenderTarget(captureRT)
        renderer.autoClear = true
        renderer.setClearColor(0x000000, 0)
        renderer.clear(true, true, true)
        copyQuad.render(renderer)
        renderer.setRenderTarget(prevTarget)
        renderer.autoClear = prevAuto

        const pixels = new Uint8Array(o.width * o.height * 4)
        renderer.readRenderTargetPixels(captureRT, 0, 0, o.width, o.height, pixels)
        const imgData = ctx.createImageData(o.width, o.height)
        for (let y = 0; y < o.height; y++) {
          const srcOff = (o.height - 1 - y) * o.width * 4
          imgData.data.set(pixels.subarray(srcOff, srcOff + o.width * 4), y * o.width * 4)
        }
        ctx.putImageData(imgData, 0, 0)
      } else {
        renderFrame(params, false)
        ctx.drawImage(canvas, 0, 0)
      }

      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, mime, quality))
      if (!blob) throw new Error('Capture toBlob failed')
      return blob
    } finally {
      if (prevW > 0 && prevH > 0) resize(prevW, prevH)
    }
  }

  // ---- teardown ----------------------------------------------------------
  function dispose(): void {
    canvas.removeEventListener('webglcontextlost', onContextLost)
    for (const m of models.values()) m.dispose()
    models.clear()
    pendingModels.clear()
    screenComposer.dispose()
    flat.dispose()
    background.dispose()
    lighting.dispose()
    mediaTexture?.dispose()
    mockupBgTexture?.dispose()
    bloomPass.dispose()
    ghostPass.dispose()
    blurH.dispose()
    blurV.dispose()
    glassPass.dispose()
    outputPass.dispose()
    composer.dispose()
    xfadeFull.dispose()
    xfadeBg.dispose()
    blendMaterial.dispose()
    blendQuad.dispose()
    copyMaterial.dispose()
    copyQuad.dispose()
    captureRT?.dispose()
    renderer.dispose()
  }

  const engine: OpenMockEngine = {
    canvas,
    render: (params: RenderParams) => renderFrame({ ...params }, false),
    resize,
    getSize: () => ({ width: canvas.width, height: canvas.height }),
    setMedia,
    getMediaAspect: () => mediaAspect,
    setBgImage: (img) => background.setImage(img),
    setBgBlur: (amount) => background.setBlur(amount),
    setMockupBgImage,
    prepareModel,
    prepareEnvironment: (envId) => lighting.prepareEnvironment(envId || null),
    captureToBlob,
    dispose,
  }
  if (import.meta.env.DEV) {
    // dev-only introspection for debugging
    ;(engine as unknown as Record<string, unknown>).__debug = { scene, camera, modelGroup, models, renderer }
  }
  return engine
}
