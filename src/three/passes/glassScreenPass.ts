/**
 * "Liquid Glass" full-frame refraction pass. Maps each fragment back into the
 * projected mockup quad via inverse bilinear interpolation, evaluates a
 * rounded-box SDF in that space, and near the slab edge refracts the frame
 * with chromatic dispersion and a directional smear, plus a specular sheen,
 * rim light, slight interior darkening and a soft drop shadow outside the
 * slab. Disabled unless the Liquid Glass effect is on.
 *
 * Corner uniforms (u_p00..u_p01, wound BL→BR→TR→TL) are fed engine-side with
 * the projected flat-quad corners for target "mockup"; target "frame" and 3D
 * models fall back to the full frame.
 */

import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { PASS_VERTEX } from './dofPass'

const GLASS_SCREEN_FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_strength;   // 0-1 refraction / dispersion intensity
uniform float u_radius;     // corner radius as fraction of short half-extent
uniform float u_shine;      // 0-1 white edge light (sheen + rim)
uniform int u_isDark;       // rim tuning for dark screen content
uniform vec2 u_p00;
uniform vec2 u_p10;
uniform vec2 u_p11;
uniform vec2 u_p01;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float glCross(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }

// Inverse bilinear: map a point inside quad a,b,c,d (wound around) back to
// its (s,t) in [0,1]², picking the more robust denominator so near-vertical
// or near-horizontal edges do not divide by ~0.
vec2 glInvBilinear(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 e = b - a;
  vec2 f = d - a;
  vec2 g = a - b + c - d;
  vec2 h = p - a;
  float k2 = glCross(g, f);
  float k1 = glCross(e, f) + glCross(h, g);
  float k0 = glCross(h, e);
  float v;
  if (abs(k2) < 1e-6) {
    v = -k0 / k1;
  } else {
    float w = k1 * k1 - 4.0 * k0 * k2;
    w = sqrt(max(w, 0.0));
    v = (-k1 - w) / (2.0 * k2);
    if (v < 0.0 || v > 1.0) v = (-k1 + w) / (2.0 * k2);
  }
  vec2 denom = e + g * v;
  float u = abs(denom.x) > abs(denom.y) ? (h.x - f.x * v) / denom.x
                                        : (h.y - f.y * v) / denom.y;
  return vec2(u, v);
}

void main() {
  vec4 srcS = texture2D(u_texture, v_uv);
  vec2 texel = 1.0 / u_resolution;

  vec2 st = glInvBilinear(v_uv, u_p00, u_p10, u_p11, u_p01);
  float pixW = length((u_p10 - u_p00) * u_resolution);
  float pixH = length((u_p01 - u_p00) * u_resolution);
  float minDim = min(pixW, pixH);
  vec2 pgrid = vec2((st.x - 0.5) * pixW, (st.y - 0.5) * pixH);
  vec2 halfB = vec2(pixW, pixH) * 0.5;
  float minb = min(halfB.x, halfB.y);
  float rad = clamp(u_radius, 0.0, 1.0) * minb;
  float sd = sdRoundedBox(pgrid, halfB, rad);

  float inside = max(-sd, 0.0);
  float band = mix(0.06, 0.20, clamp(u_strength, 0.0, 1.0)) * minDim;
  float edge = 1.0 - smoothstep(0.0, band, inside);
  float edgePow = pow(edge, 1.6); // outer sliver bends hardest

  // crease-free edge normal: blend the two axis directions by proximity
  float penX = halfB.x - abs(pgrid.x);
  float penY = halfB.y - abs(pgrid.y);
  float fx = 1.0 - smoothstep(0.0, band, penX);
  float fy = 1.0 - smoothstep(0.0, band, penY);
  vec2 localDir = vec2(sign(pgrid.x) * fx, sign(pgrid.y) * fy);
  vec2 axX = normalize((u_p10 - u_p00) * u_resolution + vec2(1e-6));
  vec2 axY = normalize((u_p01 - u_p00) * u_resolution + vec2(1e-6));
  vec2 normal = normalize(localDir.x * axX + localDir.y * axY + vec2(1e-6));

  float refractMag = mix(0.02, 0.09, clamp(u_strength, 0.0, 1.0)) * minDim * edgePow;
  vec2 baseUv = v_uv - normal * refractMag * texel;

  float ca = mix(0.004, 0.016, clamp(u_strength, 0.0, 1.0)) * minDim * edgePow;
  vec2 caVec = normal * ca * texel;

  vec3 col;
  col.r = texture2D(u_texture, baseUv - caVec).r;
  col.g = texture2D(u_texture, baseUv).g;
  col.b = texture2D(u_texture, baseUv + caVec).b;

  if (edgePow > 0.001) {
    // directional smear along the normal near the rim
    vec2 smear = normal * (refractMag * 0.6) * texel;
    vec3 blur = texture2D(u_texture, baseUv + smear * 0.5).rgb
              + texture2D(u_texture, baseUv - smear * 0.5).rgb
              + texture2D(u_texture, baseUv + smear).rgb
              + texture2D(u_texture, baseUv - smear).rgb;
    blur *= 0.25;
    col = mix(col, blur, clamp(edgePow * 0.8, 0.0, 1.0));
  }

  vec2 lightDir = normalize(vec2(-0.55, 0.85));
  float NdotL = max(dot(normal, lightDir), 0.0);
  float spec = pow(NdotL, 6.0) * pow(edge, 3.0);
  float rim = (1.0 - smoothstep(0.0, minDim * 0.006, inside)) * edgePow * NdotL;
  float rimTint = (u_isDark == 1) ? 0.5 : 0.4;
  vec3 light = (spec * vec3(1.0, 1.0, 1.02) * (0.6 * u_strength + 0.25)
             + rim * vec3(1.0) * rimTint) * u_shine;

  // only bend actual content — where the refracted sample has no alpha,
  // keep the untouched scene color
  float refA = texture2D(u_texture, baseUv).a;
  col = mix(srcS.rgb, col, refA);

  col *= 1.0 - edgePow * 0.12; // subtle "thick glass" darkening at the rim
  col += light;

  float slabMask = 1.0 - smoothstep(-1.0, 1.0, sd);
  vec3 outc = mix(srcS.rgb, col, slabMask);
  float shadow = (1.0 - smoothstep(0.0, minDim * 0.03, max(sd, 0.0))) * (1.0 - slabMask) * 0.15;
  outc *= 1.0 - shadow;

  gl_FragColor = vec4(outc, srcS.a);
}
`

export function createGlassScreenPass(): ShaderPass {
  const pass = new ShaderPass(
    {
      uniforms: {
        u_texture: { value: null },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_strength: { value: 0.5 },
        u_radius: { value: 0.5 },
        u_shine: { value: 0.3 },
        u_isDark: { value: 0 },
        u_p00: { value: new THREE.Vector2(0, 0) },
        u_p10: { value: new THREE.Vector2(1, 0) },
        u_p11: { value: new THREE.Vector2(1, 1) },
        u_p01: { value: new THREE.Vector2(0, 1) },
      },
      vertexShader: PASS_VERTEX,
      fragmentShader: GLASS_SCREEN_FRAGMENT,
    },
    'u_texture',
  )
  pass.material.blending = THREE.NoBlending
  pass.material.transparent = false
  pass.enabled = false
  return pass
}
