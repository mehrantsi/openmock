/**
 * Depth-of-field blur passes (separable Gaussian, or single-pass bokeh) plus
 * the full effect composite that lives in the vertical pass: ghost add →
 * bloom add → vignette → chromatic aberration → grain → opacity, and an
 * unsharp-mask sharpen applied only to in-focus pixels.
 *
 * Both passes share the same circle-of-confusion function driven by three
 * blur modes: 0 radial (distance from a focus point), 1 directional
 * (projected distance past a threshold line), 2 tilt-shift (distance outside
 * a band).
 */

import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

const PASS_VERTEX = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** Shared CoC: falloff widens the transition band and softens its curve. */
const GET_BLUR_AMOUNT = /* glsl */ `
float getBlurAmount(vec2 uv) {
  float aspect = u_resolution.x / u_resolution.y;
  float widen = 1.0 + u_blurFalloff * 3.0;
  float curve = mix(2.0, 0.7, u_blurFalloff);

  if (u_blurMode == 1) {
    vec2 dir = vec2(cos(u_blurAngle), sin(u_blurAngle));
    vec2 diff = uv - 0.5;
    diff.x *= aspect;
    float projected = dot(diff, dir);
    float reach = aspect * 0.5 + 0.5;
    float threshold = mix(-reach, reach, u_dirPosition);
    float d = max(projected - threshold, 0.0);
    float t = smoothstep(0.0, 0.7 * widen, d);
    return pow(t, curve) * u_blurStrength;
  }

  vec2 diff = uv - u_focusPoint;
  diff.x *= aspect;

  float dist;
  if (u_blurMode == 2) {
    vec2 perp = vec2(sin(u_blurAngle), cos(u_blurAngle));
    float d = abs(dot(diff, perp));
    float band = u_tiltBand * 0.5;
    dist = max(d - band, 0.0);
  } else {
    dist = length(diff);
  }

  float edge = u_focusSize * 0.5;
  float t = smoothstep(0.0, (edge + 0.35) * widen, dist - edge);
  return pow(t, curve) * u_blurStrength;
}
`

const BLUR_UNIFORM_DECLS = /* glsl */ `
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_blurStrength;
uniform vec2 u_focusPoint;
uniform float u_focusSize;
uniform int u_blurMode;
uniform float u_blurAngle;
uniform float u_tiltBand;
uniform float u_dirPosition;
uniform float u_blurFalloff;
uniform int u_v2;
`

const BLUR_H_FRAGMENT = /* glsl */ `
precision highp float;
${BLUR_UNIFORM_DECLS}
${GET_BLUR_AMOUNT}

void main() {
  // bokeh (v2): pass through untouched — the V pass runs the 2D disc sampler
  // and needs the original scene color to read from
  if (u_v2 == 1) {
    gl_FragColor = texture2D(u_texture, v_uv);
    return;
  }

  float blurAmount = getBlurAmount(v_uv);

  if (blurAmount < 0.5) {
    gl_FragColor = texture2D(u_texture, v_uv);
    return;
  }

  // linear-sampled Gaussian: adjacent taps (2k-1, 2k) merge into ONE bilinear
  // fetch at their weight-centroid offset — exactly the same kernel at half
  // the texture fetches (81 -> 41 at full radius)
  float radius = floor(min(blurAmount, 40.0));
  float sigma = blurAmount * 0.5;
  float invSigma2 = 1.0 / (2.0 * sigma * sigma);

  vec2 texelSize = 1.0 / u_resolution;
  vec4 color = texture2D(u_texture, v_uv);
  float totalWeight = 1.0;

  for (int k = 1; k <= 20; k++) {
    float i1 = float(2 * k - 1);
    if (i1 > radius) continue;
    float i2 = i1 + 1.0;
    float w1 = exp(-i1 * i1 * invSigma2);
    float w2 = i2 <= radius ? exp(-i2 * i2 * invSigma2) : 0.0;
    float w = w1 + w2;
    vec2 offset = vec2(1.0, 0.0) * texelSize * ((i1 * w1 + i2 * w2) / w);
    color += texture2D(u_texture, v_uv + offset) * w;
    color += texture2D(u_texture, v_uv - offset) * w;
    totalWeight += 2.0 * w;
  }

  gl_FragColor = color / totalWeight;
}
`

const BLUR_V_FRAGMENT = /* glsl */ `
precision highp float;
${BLUR_UNIFORM_DECLS}

uniform float u_vignette;
uniform float u_grain;
uniform float u_time;
uniform float u_opacity;
uniform float u_sharpen;
// multiplier on the 1.5-texel sharpen kernel so its footprint stays a fixed
// fraction of the image at export resolutions (captureScale)
uniform float u_sharpenScale;

uniform sampler2D u_bloomTex;
uniform float u_bloomStrength;

// Ghost: GhostPass's blurred mockup-only render, composited at a screen-space
// offset. u_ghostOffset is a ready-made UV delta — the engine authors the
// offset in the mockup's own plane and projects it through the live camera,
// so aspect / tilt / zoom foreshortening are already baked in.
uniform sampler2D u_ghostTex;
// GhostPass's UNBLURRED mockup render; only its alpha is read, as a clip
// mask sampled at the un-offset UV.
uniform sampler2D u_ghostMaskTex;
uniform float u_ghostOpacity;
uniform vec2 u_ghostOffset;

uniform float u_caStrength;

${GET_BLUR_AMOUNT}

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// Bokeh: concentric-ring disc sampler resolved in one pass. Ring i carries
// i*5 taps at radius i*step (aspect-corrected so the kernel stays circular).
// Outer rings get a slight weight bias for a flatter, disc-like kernel, and
// bright pixels (luma > 0.7) get up to +150% gain so highlights bloom into
// discs instead of smearing grey.
vec4 bokehSample(vec2 uv, float coc) {
  const int RINGS = 3;
  const int SAMPLES = 5;
  vec2 texelSize = 1.0 / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  float ringStep = coc / float(RINGS);
  vec4 acc = texture2D(u_texture, uv);
  float wsum = 1.0;
  for (int i = 1; i <= RINGS; i++) {
    int ringSamples = i * SAMPLES;
    float r = float(i) * ringStep;
    float rw = mix(1.0, float(i) / float(RINGS), 0.3);
    for (int j = 0; j < 64; j++) {
      if (j >= ringSamples) break;
      float a = 6.28318530718 * float(j) / float(ringSamples);
      vec2 off = vec2(cos(a), sin(a) * aspect) * r * texelSize;
      vec4 s = texture2D(u_texture, uv + off);
      float luma = dot(s.rgb, vec3(0.299, 0.587, 0.114));
      float gain = 1.0 + smoothstep(0.7, 1.0, luma) * 1.5;
      acc += s * rw * gain;
      wsum += rw * gain;
    }
  }
  return acc / wsum;
}

void main() {
  float blurAmount = getBlurAmount(v_uv);
  vec4 color;

  if (u_v2 == 1) {
    // v2 reads the passthrough H output (= original scene color) and
    // resolves the whole 2D kernel here
    if (blurAmount < 0.5) {
      color = texture2D(u_texture, v_uv);
      if (u_sharpen > 0.0) {
        vec2 ts = (1.5 * u_sharpenScale) / u_resolution;
        vec4 n = texture2D(u_texture, v_uv + vec2( ts.x, 0.0))
               + texture2D(u_texture, v_uv + vec2(-ts.x, 0.0))
               + texture2D(u_texture, v_uv + vec2(0.0,  ts.y))
               + texture2D(u_texture, v_uv + vec2(0.0, -ts.y));
        color += (color - n * 0.25) * u_sharpen * 2.5;
      }
    } else {
      float coc = min(blurAmount, 40.0);
      color = bokehSample(v_uv, coc);
    }
  } else if (blurAmount < 0.5) {
    color = texture2D(u_texture, v_uv);
    if (u_sharpen > 0.0) {
      vec2 ts = (1.5 * u_sharpenScale) / u_resolution;
      vec4 n = texture2D(u_texture, v_uv + vec2( ts.x, 0.0))
             + texture2D(u_texture, v_uv + vec2(-ts.x, 0.0))
             + texture2D(u_texture, v_uv + vec2(0.0,  ts.y))
             + texture2D(u_texture, v_uv + vec2(0.0, -ts.y));
      color += (color - n * 0.25) * u_sharpen * 2.5;
    }
  } else {
    // linear-sampled Gaussian — see the H pass for the pairing math
    float radius = floor(min(blurAmount, 40.0));
    float sigma = blurAmount * 0.5;
    float invSigma2 = 1.0 / (2.0 * sigma * sigma);

    vec2 texelSize = 1.0 / u_resolution;
    color = texture2D(u_texture, v_uv);
    float totalWeight = 1.0;

    for (int k = 1; k <= 20; k++) {
      float i1 = float(2 * k - 1);
      if (i1 > radius) continue;
      float i2 = i1 + 1.0;
      float w1 = exp(-i1 * i1 * invSigma2);
      float w2 = i2 <= radius ? exp(-i2 * i2 * invSigma2) : 0.0;
      float w = w1 + w2;
      vec2 offset = vec2(0.0, 1.0) * texelSize * ((i1 * w1 + i2 * w2) / w);
      color += texture2D(u_texture, v_uv + offset) * w;
      color += texture2D(u_texture, v_uv - offset) * w;
      totalWeight += 2.0 * w;
    }

    color = color / totalWeight;
  }

  // Ghost sits BEFORE bloom: it is part of the base image (a dim additive
  // copy of the mockup), so the bloom glow lands on top of the composite.
  // Plain ADD in linear HDR — invisible where the copy is black, which is
  // why the effect is gated to dark media upstream. The ghost source is
  // premultiplied (transparent-black clear + opaque meshes), so rgb is
  // already zero off the mockup and no alpha multiply is needed.
  if (u_ghostOpacity > 0.0) {
    vec2 ghostUv = v_uv - u_ghostOffset;
    float clipMask = texture2D(u_ghostMaskTex, v_uv).a;
    vec3 ghost = texture2D(u_ghostTex, ghostUv).rgb;
    color.rgb += ghost * u_ghostOpacity * clipMask;
  }

  if (u_bloomStrength > 0.0) {
    vec3 bloom = texture2D(u_bloomTex, v_uv).rgb;
    color.rgb += bloom * u_bloomStrength;
  }

  if (u_vignette > 0.0) {
    vec2 vc = v_uv - 0.5;
    float vd = dot(vc, vc);
    float vf = 1.0 - smoothstep(0.2, 0.7, vd) * u_vignette;
    color.rgb *= vf;
  }

  // CA must run before grain: it resamples R/B from the un-grained pass
  // input, so running it after grain would leave the noise in G only
  if (u_caStrength > 0.0) {
    vec2 off = (v_uv - 0.5) * (0.015 * u_caStrength);
    float r = texture2D(u_texture, v_uv - off).r;
    float b = texture2D(u_texture, v_uv + off).b;
    color.r = mix(color.r, r, u_caStrength);
    color.b = mix(color.b, b, u_caStrength);
  }

  if (u_grain > 0.0) {
    // signed noise centred at 0: zero average exposure shift
    float n = rand(fract(v_uv + u_time)) - 0.5;
    color.rgb *= 1.0 + n * 1.0 * u_grain;
  }

  color.a *= u_opacity;

  gl_FragColor = color;
}
`

function cocUniforms(): Record<string, THREE.IUniform> {
  return {
    u_texture: { value: null },
    u_resolution: { value: new THREE.Vector2(1, 1) },
    u_blurStrength: { value: 0 },
    u_focusPoint: { value: new THREE.Vector2(0.5, 0.5) },
    u_focusSize: { value: 0.35 },
    u_blurMode: { value: 0 },
    u_blurAngle: { value: 0 },
    u_tiltBand: { value: 0.1 },
    u_dirPosition: { value: 0.5 },
    u_blurFalloff: { value: 0 },
    u_v2: { value: 0 },
  }
}

export function createBlurHPass(): ShaderPass {
  const pass = new ShaderPass(
    { uniforms: cocUniforms(), vertexShader: PASS_VERTEX, fragmentShader: BLUR_H_FRAGMENT },
    'u_texture',
  )
  pass.material.blending = THREE.NoBlending
  pass.material.transparent = false
  return pass
}

export function createBlurVPass(): ShaderPass {
  const uniforms: Record<string, THREE.IUniform> = {
    ...cocUniforms(),
    u_vignette: { value: 0 },
    u_grain: { value: 0 },
    u_time: { value: 0 },
    u_opacity: { value: 1 },
    u_sharpen: { value: 0 },
    u_sharpenScale: { value: 1 },
    u_bloomTex: { value: null },
    u_bloomStrength: { value: 0 },
    u_ghostTex: { value: null },
    u_ghostMaskTex: { value: null },
    u_ghostOpacity: { value: 0 },
    u_ghostOffset: { value: new THREE.Vector2(0, 0) },
    u_caStrength: { value: 0 },
  }
  const pass = new ShaderPass(
    { uniforms, vertexShader: PASS_VERTEX, fragmentShader: BLUR_V_FRAGMENT },
    'u_texture',
  )
  pass.material.blending = THREE.NoBlending
  pass.material.transparent = false
  return pass
}

export { PASS_VERTEX }
