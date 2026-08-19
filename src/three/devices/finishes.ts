/**
 * Finish recolor tables for the procedural device library.
 */

/**
 * Classified finish targets (XDR / iPad). Colors are linear floats; PBR
 * fields merge over the material's cached stock values.
 */
export interface ClassTarget {
  color?: [number, number, number]
  metalness?: number
  roughness?: number
  envMapIntensity?: number
  clearcoat?: number
  anisotropy?: number
}
export interface ClassifiedFinish {
  panel: ClassTarget
  logo: ClassTarget
  body: ClassTarget | ((modelId: string) => ClassTarget)
}

export const CLASSIFIED_FINISHES: Record<string, ClassifiedFinish> = {
  matteBlack: {
    panel: { color: [0.125, 0.125, 0.125], metalness: 0.31, roughness: 0.38, envMapIntensity: 0.5, clearcoat: 0, anisotropy: 0 },
    logo: { color: [0.12, 0.12, 0.12], metalness: 0.83, roughness: 0.31, envMapIntensity: 3, clearcoat: 0, anisotropy: 0.5 },
    body: (modelId: string): ClassTarget => {
      // untextured procedural bodies need true space-black values
      if (modelId === 'ipadPro') return { color: [0.028, 0.028, 0.032], metalness: 0.75, roughness: 0.5, envMapIntensity: 1.2 }
      if (modelId === 'proDisplayXdr') return { color: [0.03, 0.03, 0.034], metalness: 0.7, roughness: 0.55, envMapIntensity: 1.1 }
      return { color: [0.162, 0.162, 0.162], metalness: 1, roughness: 0.72, envMapIntensity: 2.5, clearcoat: 0, anisotropy: 0.7 }
    },
  },
  silver: {
    panel: { color: [1, 1, 1], metalness: 0.52, roughness: 1 },
    logo: { color: [1, 1, 1], metalness: 0.06, roughness: 0.58 },
    body: (modelId: string): ClassTarget => {
      if (modelId === 'ipadPro') return { color: [0.62, 0.63, 0.65], metalness: 0.8, roughness: 0.48, envMapIntensity: 0.8 }
      return { color: [0.93, 0.93, 0.93], metalness: 0.42, roughness: 0.44 }
    },
  },
  titanium: {
    panel: {},
    logo: {},
    body: (modelId: string): ClassTarget => {
      if (modelId === 'ipadPro') return { color: [0.74, 0.755, 0.775], metalness: 0.88, roughness: 0.55, envMapIntensity: 0.8 }
      if (modelId === 'proDisplayXdr') return { color: [0.82, 0.825, 0.835], metalness: 0.9, roughness: 0.6, envMapIntensity: 0.8 }
      return { metalness: 0.85, roughness: 0.25, envMapIntensity: 1.1, anisotropy: 0.5 }
    },
  },
}

/** XDR-only panel override under the titanium branch. */
export const XDR_TITANIUM_PANEL: ClassTarget = { color: [0.242, 0.242, 0.242], metalness: 0.69, roughness: 0.97 }

// ---------------------------------------------------------------------------

/** Watch Ultra: band meshes recolored to the user's band colour. */
export const WATCH_BAND_MESHES = new Set(['watch_band_top', 'watch_band_bottom'])

/** Watch Ultra matte black case: mesh-name → color (titanium = stock colors). */
export const WATCH_MATTE_BLACK: Record<string, string> = {
  watch_case_body: '#161616',
  watch_glass_plate: '#000000',
  watch_crown_guard: '#1a1a1a',
  watch_crown_knob: '#323232',
  watch_crown_accent: '#e6682e', // action accent stays orange
  watch_side_btn: '#242424',
  watch_action_btn: '#d96421', // action button stays orange
  watch_back_puck: '#4c4640',
}
