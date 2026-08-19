/**
 * DeviceScreenComposer — composites the screen content (media, screen bg,
 * bezel, padding, sharpen, rounded corners, status bar, pixel grid) into an
 * offscreen render target. That target is the emissiveMap of every 3D device
 * screen material.
 */

import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { LoadedDeviceModel } from '../contracts'
import type { RenderParams } from '../renderParams'
import { MOCKUP_MODELS } from './registry'

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAGMENT = /* glsl */ `
  uniform sampler2D u_tex;
  uniform float u_hasMedia;
  uniform vec2 u_texSize;
  uniform float u_imgAspect;
  uniform float u_faceAspect;
  uniform float u_bezel;
  uniform vec3 u_screenBg;
  uniform sampler2D u_screenBgTex;
  uniform float u_hasScreenBgTex;
  uniform float u_screenBgImgAspect;
  uniform float u_padding;
  uniform float u_screenNudgeY; // + moves the media up inside the face
  uniform float u_fitMode;      // 0 = contain, 1 = cover
  uniform float u_sharpen;
  uniform float u_pixelGrid;
  uniform float u_borderRadius;
  uniform float u_notchEnabled;
  uniform float u_notchHalfWidth;
  uniform float u_notchHalfHeight;
  uniform float u_notchFromTop;
  uniform float u_statusBarEnabled;
  uniform sampler2D u_statusBarTex;
  uniform float u_statusBarYTop;
  uniform float u_statusBarYBottom;
  uniform float u_statusBarZoneLeftMax;
  uniform float u_statusBarZoneRightMin;
  uniform float u_statusBarScrimStrength;
  uniform float u_statusBarScrimYTop;
  uniform float u_statusBarScrimYBottom;
  uniform float u_srgbDecode;
  varying vec2 vUv;

  // Sample the media texture in LINEAR space. Image/canvas textures are
  // sRGB-tagged and hardware-decoded (passthrough); video textures upload
  // raw sRGB bytes, so u_srgbDecode = 1 applies the OETF inverse here.
  vec3 sampleScene(vec2 uv) {
    vec3 c = texture2D(u_tex, uv).rgb;
    vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    return mix(c, lin, u_srgbDecode);
  }

  // Screen background behind/around the media: cover-fit image when bound,
  // otherwise the solid screen bg color.
  vec3 sampleScreenBg(vec2 innerUv) {
    if (u_hasScreenBgTex < 0.5) return u_screenBg;
    vec2 bgUv = innerUv;
    float ia = u_screenBgImgAspect;
    if (ia > u_faceAspect) {
      bgUv.x = (innerUv.x - 0.5) * (u_faceAspect / ia) + 0.5;
    } else {
      bgUv.y = (innerUv.y - 0.5) * (ia / u_faceAspect) + 0.5;
    }
    return texture2D(u_screenBgTex, bgUv).rgb;
  }

  void main() {
    vec2 uv = vUv;

    // Bezel band: thickness given as a fraction of face height; the U side
    // is divided by aspect so the physical thickness matches on all sides.
    float bezelY = u_bezel;
    float bezelX = u_bezel / u_faceAspect;
    if (uv.x < bezelX || uv.x > 1.0 - bezelX ||
        uv.y < bezelY || uv.y > 1.0 - bezelY) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 inner = vec2(
      (uv.x - bezelX) / (1.0 - 2.0 * bezelX),
      (uv.y - bezelY) / (1.0 - 2.0 * bezelY)
    );

    // Fit the media aspect into the inner face.
    float innerAspect = u_faceAspect;
    float sx = 1.0;
    float sy = 1.0;
    if (u_fitMode > 0.5) {
      // cover: fill the face, crop the longer media axis
      if (u_imgAspect > innerAspect) sx = u_imgAspect / innerAspect;
      else sy = innerAspect / u_imgAspect;
    } else {
      // contain: letterbox on the mismatched axis
      if (u_imgAspect > innerAspect) sy = innerAspect / u_imgAspect;
      else sx = u_imgAspect / innerAspect;
    }

    // Overscan the media 0.7% past the face so aspect rounding and the
    // corner-SDF antialiasing can't leave a hairline of screen background
    // around the edges (the media aspect never matches the face exactly).
    float bleed = 1.007;
    sx *= bleed;
    sy *= bleed;
    float shrink = 1.0 - 2.0 * u_padding;
    sx *= shrink;
    sy *= shrink;
    vec2 centered = (inner - 0.5) / vec2(sx, sy) + 0.5;
    centered.y -= u_screenNudgeY;
    if (u_hasMedia < 0.5) centered = vec2(-10.0); // no media -> bg everywhere

    vec3 screenBg = sampleScreenBg(inner);
    vec3 rgb;
    if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
      rgb = screenBg;
    } else {
      rgb = sampleScene(centered);
      // Sharpen at the media's native resolution — the viewport post-pass
      // sharpens the final composite, which is too late for screen detail
      // that has already been downsampled into this target.
      if (u_sharpen > 0.0) {
        vec2 ts = 1.5 / u_texSize;
        vec3 n = sampleScene(centered + vec2( ts.x, 0.0))
               + sampleScene(centered + vec2(-ts.x, 0.0))
               + sampleScene(centered + vec2(0.0,  ts.y))
               + sampleScene(centered + vec2(0.0, -ts.y));
        rgb += (rgb - n * 0.25) * u_sharpen * 2.5;
      }
    }

    // Rounded corners on the media rect only (bg + bezel stay square).
    if (u_borderRadius > 0.0) {
      vec2 p = (centered - 0.5) * 2.0;
      vec2 sz = u_imgAspect >= 1.0 ? vec2(u_imgAspect, 1.0) : vec2(1.0, 1.0 / u_imgAspect);
      p *= sz;
      float halfR = u_borderRadius * min(sz.x, sz.y);
      vec2 d2 = abs(p) - sz + halfR;
      float sdf = length(max(d2, 0.0)) - halfR;
      float edge = fwidth(sdf);
      float rAlpha = 1.0 - smoothstep(-edge, edge, sdf);
      rgb = mix(screenBg, rgb, rAlpha);
    }

    // iOS status bar, part 1+2: sample the average luminance of whatever is
    // behind the left/right icon zones (drives scrim + icon colors), then
    // paint a soft top scrim. Painted before the notch so the island stays
    // pure black where they overlap.
    float leftLum = 0.0;
    float rightLum = 0.0;
    if (u_statusBarEnabled > 0.5 && inner.y >= u_statusBarScrimYBottom) {
      float stripY = (u_statusBarYBottom + u_statusBarYTop) * 0.5;
      for (int i = 0; i < 6; i++) {
        float t = (float(i) + 0.5) / 6.0;
        float lx = mix(0.02, u_statusBarZoneLeftMax - 0.02, t);
        float rx = mix(u_statusBarZoneRightMin + 0.02, 0.98, t);
        vec2 cL = (vec2(lx, stripY) - 0.5) / vec2(sx, sy) + 0.5;
        vec2 cR = (vec2(rx, stripY) - 0.5) / vec2(sx, sy) + 0.5;
        vec3 sL = (u_hasMedia < 0.5 || cL.x < 0.0 || cL.x > 1.0 || cL.y < 0.0 || cL.y > 1.0)
          ? sampleScreenBg(vec2(lx, stripY))
          : sampleScene(cL);
        vec3 sR = (u_hasMedia < 0.5 || cR.x < 0.0 || cR.x > 1.0 || cR.y < 0.0 || cR.y > 1.0)
          ? sampleScreenBg(vec2(rx, stripY))
          : sampleScene(cR);
        leftLum += dot(sL, vec3(0.2126, 0.7152, 0.0722));
        rightLum += dot(sR, vec3(0.2126, 0.7152, 0.0722));
      }
      leftLum /= 6.0;
      rightLum /= 6.0;
      float scrimV = clamp(
        (inner.y - u_statusBarScrimYBottom) / max(0.0001, u_statusBarScrimYTop - u_statusBarScrimYBottom),
        0.0, 1.0
      );
      // Confine the scrim to the icon zones with a soft horizontal feather —
      // a full-width wash reads as a dark/light box over the content and the
      // two halves would meet in a hard seam at x = 0.5.
      float feather = 0.06;
      float wLeft = 1.0 - smoothstep(u_statusBarZoneLeftMax - feather, u_statusBarZoneLeftMax + feather, inner.x);
      float wRight = smoothstep(u_statusBarZoneRightMin - feather, u_statusBarZoneRightMin + feather, inner.x);
      float zoneW = max(wLeft, wRight);
      float zoneLumScrim = (wRight > wLeft) ? rightLum : leftLum;
      // white scrim over light content, black over dark; smoothstep fall-off
      vec3 scrimColor = zoneLumScrim > 0.5 ? vec3(1.0) : vec3(0.0);
      float scrimAlpha = smoothstep(0.0, 1.0, scrimV) * u_statusBarScrimStrength * zoneW;
      rgb = mix(rgb, scrimColor, scrimAlpha);
    }

    // Painted notch / Dynamic Island pill (disabled in production builds —
    // the physical island nodes + fill quad are used instead).
    if (u_notchEnabled > 0.5) {
      vec2 notchCenter = vec2(0.5, 1.0 - u_notchFromTop - u_notchHalfHeight);
      vec2 p = (inner - notchCenter) * vec2(u_faceAspect, 1.0);
      vec2 b = vec2(u_notchHalfWidth * u_faceAspect, u_notchHalfHeight);
      float r = b.y;
      vec2 q = abs(p) - b + r;
      float notchSdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      float aa = fwidth(notchSdf);
      float t = 1.0 - smoothstep(-aa, aa, notchSdf);
      rgb = mix(rgb, vec3(0.0), t);
    }

    // Status bar, part 3: the icon/glyph mask, black on light zones and
    // white on dark ones. Drawn after the notch (icons live outside its X
    // range, so ordering only matters for sub-pixel spill).
    if (u_statusBarEnabled > 0.5 &&
        inner.y >= u_statusBarYBottom && inner.y <= u_statusBarYTop) {
      float barV = (inner.y - u_statusBarYBottom) / (u_statusBarYTop - u_statusBarYBottom);
      float maskA = texture2D(u_statusBarTex, vec2(inner.x, barV)).a;
      if (maskA > 0.001) {
        float zoneLumIcon = (inner.x < 0.5) ? leftLum : rightLum;
        vec3 barColor = zoneLumIcon > 0.5 ? vec3(0.0) : vec3(1.0);
        rgb = mix(rgb, barColor, maskA);
      }
    }

    // Subpixel triad grid over the inner face (1350x759 RGB stripes).
    if (u_pixelGrid > 0.0) {
      float pgColIdx = mod(inner.x * 1350.0, 3.0);
      vec3 pgMask;
      if (pgColIdx < 1.0)      pgMask = vec3(1.4, 0.8, 0.8);
      else if (pgColIdx < 2.0) pgMask = vec3(0.8, 1.4, 0.8);
      else                     pgMask = vec3(0.8, 0.8, 1.4);
      float pgRowIdx = mod(inner.y * 759.0, 3.0);
      float pgGap = pgRowIdx < 2.0 ? 1.0 : (1.0 - 0.5 * u_pixelGrid);
      rgb = mix(rgb, rgb * pgMask * pgGap, u_pixelGrid * 0.7);
    }

    gl_FragColor = vec4(rgb, 1.0);
  }
`

// ---------------------------------------------------------------------------
// Status bar mask (canvas-generated, 1320x126)
// ---------------------------------------------------------------------------

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Battery glyph, 25x13 units: 22-wide body, charge fill to 68%, side tip. */
function drawBattery(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = 0.3
  roundedRectPath(ctx, 0, 0, 22, 13, 4)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(23, 6.9, 2.03, -Math.PI / 2, Math.PI / 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.save()
  roundedRectPath(ctx, 0, 0, 22, 13, 4)
  ctx.clip()
  ctx.fillRect(0, 0, 18, 13)
  // knock the charge percentage out of the filled portion
  ctx.globalCompositeOperation = 'destination-out'
  ctx.font = '600 9.5px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('68', 9, 7)
  ctx.restore()
}

/** Wifi glyph, 17x12 units: two stroked arcs + an inner arc + apex dot. */
function drawWifi(ctx: CanvasRenderingContext2D): void {
  const cx = 8.5
  const cy = 11.2
  const half = 0.75
  ctx.lineCap = 'round'
  ctx.lineWidth = 2.2
  ctx.strokeStyle = '#ffffff'
  for (const r of [9.4, 6.1, 2.9]) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, -Math.PI / 2 - half, -Math.PI / 2 + half)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(cx, cy - 0.4, 1.05, 0, Math.PI * 2)
  ctx.fill()
}

/** Cellular bars, 18x12 units: four bars, the tallest dimmed. */
function drawCellular(ctx: CanvasRenderingContext2D): void {
  const bottom = 11.54
  const bars: Array<{ x: number; top: number; dim?: boolean }> = [
    { x: 0, top: 8.65 },
    { x: 4.81, top: 6.25 },
    { x: 9.62, top: 1.92 },
    { x: 14.42, top: 0, dim: true },
  ]
  for (const bar of bars) {
    ctx.globalAlpha = bar.dim ? 0.3 : 1
    roundedRectPath(ctx, bar.x, bar.top, 2.885, bottom - bar.top, 0.96)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawIconRight(
  ctx: CanvasRenderingContext2D,
  draw: (ctx: CanvasRenderingContext2D) => void,
  vbW: number,
  vbH: number,
  rightEdge: number,
  centerY: number,
  height: number,
): number {
  const s = height / vbH
  const w = vbW * s
  const left = rightEdge - w
  ctx.save()
  ctx.translate(left, centerY - height / 2)
  ctx.scale(s, s)
  ctx.fillStyle = '#ffffff'
  draw(ctx)
  ctx.restore()
  return left
}

function createStatusBarTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 1320
  canvas.height = 126
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.font = '600 63px -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", Arial, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('9:41', Math.round(72.6), Math.round(65.52))
  const iconH = Math.round(55.44)
  const centerY = Math.round(63)
  const gap = Math.round(18.9)
  let right = 1320 - Math.round(59.4)
  right = drawIconRight(ctx, drawBattery, 25, 13, right, centerY, iconH) - gap
  right = drawIconRight(ctx, drawWifi, 17, 12, right, centerY, iconH) - gap
  drawIconRight(ctx, drawCellular, 18, 12, right, centerY, iconH)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.premultiplyAlpha = false
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function textureDims(tex: THREE.Texture): { w: number; h: number } {
  const img = tex.image as
    | { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number }
    | undefined
  const w = img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? 2048
  const h = img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? 1152
  return { w: Math.max(1, w || 0), h: Math.max(1, h || 0) }
}

export class DeviceScreenComposer {
  private renderer: THREE.WebGLRenderer
  private rt: THREE.WebGLRenderTarget
  private fsq: FullScreenQuad
  private material: THREE.ShaderMaterial
  private placeholder: THREE.DataTexture
  private statusBar: THREE.CanvasTexture | null = null
  private statusBarTried = false
  private bgTexture: THREE.Texture | null = null
  /** long-edge base size; follows the media resolution, clamped 2048..4096 */
  private baseSize = 2048

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.rt = new THREE.WebGLRenderTarget(2048, 1152, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
    })
    this.rt.texture.anisotropy = renderer.capabilities.getMaxAnisotropy()

    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    this.placeholder.needsUpdate = true

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_tex: { value: this.placeholder },
        u_hasMedia: { value: 0 },
        u_srgbDecode: { value: 0 },
        u_texSize: { value: new THREE.Vector2(2048, 1152) },
        u_imgAspect: { value: 16 / 9 },
        u_faceAspect: { value: 16 / 9 },
        u_bezel: { value: 0.025 },
        u_screenBg: { value: new THREE.Color(0x1e1e1e) },
        u_screenBgTex: { value: this.placeholder },
        u_hasScreenBgTex: { value: 0 },
        u_screenBgImgAspect: { value: 16 / 9 },
        u_padding: { value: 0 },
        u_screenNudgeY: { value: 0 },
        u_fitMode: { value: 0 },
        u_sharpen: { value: 0 },
        u_pixelGrid: { value: 0 },
        u_borderRadius: { value: 0 },
        u_notchEnabled: { value: 0 },
        u_notchHalfWidth: { value: 0 },
        u_notchHalfHeight: { value: 0 },
        u_notchFromTop: { value: 0 },
        u_statusBarEnabled: { value: 0 },
        u_statusBarTex: { value: this.placeholder },
        u_statusBarYTop: { value: 0.987 },
        u_statusBarYBottom: { value: 0.943 },
        u_statusBarZoneLeftMax: { value: 0.34 },
        u_statusBarZoneRightMin: { value: 0.66 },
        // subtle icon-legibility scrim: tight band under the status strip,
        // gentle strength (a .85-tall .65-alpha wash reads as a corner shade)
        u_statusBarScrimStrength: { value: 0.45 },
        u_statusBarScrimYTop: { value: 1 },
        u_statusBarScrimYBottom: { value: 0.92 },
      },
    })
    this.fsq = new FullScreenQuad(this.material)
  }

  /** The composited screen texture (stable across resizes). */
  get texture(): THREE.Texture {
    return this.rt.texture
  }

  setMedia(tex: THREE.Texture | null, aspect: number, srgbDecode: boolean): void {
    const u = this.material.uniforms
    u.u_tex.value = tex ?? this.placeholder
    u.u_hasMedia.value = tex ? 1 : 0
    u.u_srgbDecode.value = srgbDecode ? 1 : 0
    if (tex) {
      const { w, h } = textureDims(tex)
      u.u_texSize.value.set(w, h)
      const maxDim = Math.max(w, h)
      if (isFinite(maxDim) && maxDim > 0) this.baseSize = Math.min(4096, Math.max(2048, maxDim))
      u.u_imgAspect.value = aspect > 0 && isFinite(aspect) ? aspect : w / Math.max(1, h)
    } else {
      u.u_texSize.value.set(2048, 1152)
      u.u_imgAspect.value = aspect > 0 && isFinite(aspect) ? aspect : 16 / 9
    }
  }

  setBgImage(tex: THREE.Texture | null): void {
    this.bgTexture = tex
    const u = this.material.uniforms
    u.u_screenBgTex.value = tex ?? this.placeholder
    if (tex) {
      const { w, h } = textureDims(tex)
      u.u_screenBgImgAspect.value = w / Math.max(1, h)
    }
  }

  /** Apply model-def-derived uniforms and resize the target to its face. */
  configureFor(model: LoadedDeviceModel): void {
    const def = MOCKUP_MODELS[model.id]
    const u = this.material.uniforms
    u.u_faceAspect.value = model.faceAspect
    u.u_bezel.value = def?.bezel ?? 0
    u.u_screenNudgeY.value = def?.screenNudgeY ?? 0
    u.u_fitMode.value = def?.screenFit === 'cover' ? 1 : 0
    if (def?.notch) {
      u.u_notchHalfWidth.value = def.notch.halfWidth
      u.u_notchHalfHeight.value = def.notch.halfHeight
      u.u_notchFromTop.value = def.notch.fromTop
    }
    const fa = model.faceAspect
    let w: number
    let h: number
    if (fa >= 1) {
      w = this.baseSize
      h = Math.max(64, Math.round(this.baseSize / fa))
    } else {
      h = this.baseSize
      w = Math.max(64, Math.round(this.baseSize * fa))
    }
    if (w !== this.rt.width || h !== this.rt.height) this.rt.setSize(w, h)
  }

  /** Feed per-frame uniforms from RenderParams and render the composite. */
  update(model: LoadedDeviceModel, params: RenderParams): void {
    this.configureFor(model)
    const def = MOCKUP_MODELS[model.id]
    const u = this.material.uniforms

    ;(u.u_screenBg.value as THREE.Color).setRGB(
      params.mockupBg[0],
      params.mockupBg[1],
      params.mockupBg[2],
      THREE.SRGBColorSpace,
    )
    u.u_padding.value = def?.hideMockupPadding
      ? 0
      : Math.max(0, Math.min(0.45, params.mockupPadding))
    u.u_notchEnabled.value = 0 // painted notch disabled; physical nodes/fill quad handle it
    u.u_sharpen.value = params.sharpen
    u.u_pixelGrid.value = params.pixelGrid
    u.u_borderRadius.value = params.borderRadius
    u.u_hasScreenBgTex.value = this.bgTexture && params.mockupBgImageActive ? 1 : 0

    const wantsStatusBar =
      params.statusBarEnabled && (model.id === 'iphone17Pro' || model.id === 'iphone17ProMax')
    if (wantsStatusBar && !this.statusBar && !this.statusBarTried) {
      this.statusBarTried = true
      this.statusBar = createStatusBarTexture()
      if (this.statusBar) u.u_statusBarTex.value = this.statusBar
    }
    u.u_statusBarEnabled.value = wantsStatusBar && this.statusBar ? 1 : 0

    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.rt)
    this.renderer.clear(true, false, false)
    this.fsq.render(this.renderer)
    this.renderer.setRenderTarget(prev)
  }

  dispose(): void {
    this.rt.dispose()
    this.fsq.dispose()
    this.material.dispose()
    this.placeholder.dispose()
    this.statusBar?.dispose()
    this.statusBar = null
  }
}
