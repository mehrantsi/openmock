/**
 * Patched three.js OutputPass.
 *
 * The stock pass tone-maps + sRGB-encodes the composer buffer. This patch
 * splices three extras into its fragment shader:
 *  - per-pixel tonemap BYPASS keyed on buffer alpha: the in-scene background
 *    quad writes alpha 0 on the composer path, so background pixels skip the
 *    tone-map chain and get a raw sRGB encode (`u_smoothBlend` selects a hard
 *    step vs. using alpha directly for the blend);
 *  - ±0.5/255 screen-space hash dither against 8-bit banding, scaled by the
 *    buffer alpha (`u_ditherStrength`);
 *  - `u_forceOpaqueAlpha`: output alpha is forced to 1 except during the
 *    transparent-PNG capture path, which sets it to 0 and reads the composer
 *    buffer back instead of presenting.
 */

import type * as THREE from 'three'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

const PRELUDE = /* glsl */ `
uniform float u_ditherStrength;
uniform float u_smoothBlend;
uniform float u_forceOpaqueAlpha;
float ditherRand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
`

const CAPTURE_INPUT = /* glsl */ `gl_FragColor = texture2D( tDiffuse, vUv );
			vec3 _outputLinear = gl_FragColor.rgb;
			float _outputAlpha = gl_FragColor.a;`

const EPILOGUE = /* glsl */ `
	vec3 _rawSrgb = _outputLinear;
	#ifdef SRGB_TRANSFER
		_rawSrgb = sRGBTransferOETF(vec4(_outputLinear, 1.0)).rgb;
	#endif
	float _effAlpha = mix(step(0.001, _outputAlpha), _outputAlpha, u_smoothBlend);
	gl_FragColor.rgb = mix(_rawSrgb, gl_FragColor.rgb, _effAlpha);
	float _ditherG = ditherRand(gl_FragCoord.xy) - 0.5;
	gl_FragColor.rgb += vec3(_ditherG / 255.0) * u_ditherStrength * _outputAlpha;
	gl_FragColor.a = mix(_outputAlpha, 1.0, u_forceOpaqueAlpha);
`

export class PatchedOutputPass extends OutputPass {
  private patchedUniforms: Record<string, THREE.IUniform>

  constructor() {
    super()

    const uniforms = this.uniforms as Record<string, THREE.IUniform>
    uniforms.u_ditherStrength = { value: 1 }
    uniforms.u_smoothBlend = { value: 1 }
    uniforms.u_forceOpaqueAlpha = { value: 1 }
    this.patchedUniforms = uniforms

    let src = this.material.fragmentShader
    src = src.replace('void main() {', `${PRELUDE}\nvoid main() {`)
    src = src.replace('gl_FragColor = texture2D( tDiffuse, vUv );', CAPTURE_INPUT)
    const close = src.lastIndexOf('}')
    src = src.slice(0, close) + EPILOGUE + '\n}' + src.slice(close + 1)
    this.material.fragmentShader = src
    this.material.needsUpdate = true
  }

  /** 0 only during transparent-PNG capture readback. */
  setForceOpaqueAlpha(v: number): void {
    this.patchedUniforms.u_forceOpaqueAlpha.value = v
  }

  getForceOpaqueAlpha(): number {
    return this.patchedUniforms.u_forceOpaqueAlpha.value as number
  }
}
