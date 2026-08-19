/** Font catalog for text shots. Google fonts load on demand. */

export interface FontDef {
  id: string
  label: string
  /** CSS family stack or Google family name */
  family: string
  google: boolean
  weights: number[]
}

const ALL = [100, 200, 300, 400, 500, 600, 700, 800, 900]

export const FONTS: FontDef[] = [
  { id: 'system', label: 'System', family: 'system-ui, -apple-system, sans-serif', google: false, weights: ALL },
  { id: 'serif', label: 'Serif', family: 'Georgia, serif', google: false, weights: ALL },
  { id: 'display', label: 'Display', family: '"SF Pro Display", system-ui, sans-serif', google: false, weights: ALL },
  { id: 'mono', label: 'Mono', family: 'ui-monospace, monospace', google: false, weights: ALL },
  { id: 'geist', label: 'Geist', family: 'Geist', google: true, weights: ALL },
  { id: 'geist-mono', label: 'Geist Mono', family: 'Geist Mono', google: true, weights: ALL },
  { id: 'inter', label: 'Inter', family: 'Inter', google: true, weights: ALL },
  { id: 'roboto', label: 'Roboto', family: 'Roboto', google: true, weights: [100, 300, 400, 500, 700, 900] },
  { id: 'open-sans', label: 'Open Sans', family: 'Open Sans', google: true, weights: [300, 400, 500, 600, 700, 800] },
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat', google: true, weights: ALL },
  { id: 'poppins', label: 'Poppins', family: 'Poppins', google: true, weights: ALL },
  { id: 'lato', label: 'Lato', family: 'Lato', google: true, weights: [100, 300, 400, 700, 900] },
  { id: 'raleway', label: 'Raleway', family: 'Raleway', google: true, weights: ALL },
  { id: 'playfair', label: 'Playfair Display', family: 'Playfair Display', google: true, weights: [400, 500, 600, 700, 800, 900] },
  { id: 'merriweather', label: 'Merriweather', family: 'Merriweather', google: true, weights: [300, 400, 700, 900] },
  { id: 'oswald', label: 'Oswald', family: 'Oswald', google: true, weights: [200, 300, 400, 500, 600, 700] },
  { id: 'bebas-neue', label: 'Bebas Neue', family: 'Bebas Neue', google: true, weights: [400] },
  { id: 'nunito', label: 'Nunito', family: 'Nunito', google: true, weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { id: 'work-sans', label: 'Work Sans', family: 'Work Sans', google: true, weights: ALL },
  { id: 'dm-sans', label: 'DM Sans', family: 'DM Sans', google: true, weights: [400, 500, 700] },
  { id: 'space-grotesk', label: 'Space Grotesk', family: 'Space Grotesk', google: true, weights: [300, 400, 500, 600, 700] },
  { id: 'sora', label: 'Sora', family: 'Sora', google: true, weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { id: 'manrope', label: 'Manrope', family: 'Manrope', google: true, weights: [200, 300, 400, 500, 600, 700, 800] },
  { id: 'archivo', label: 'Archivo', family: 'Archivo', google: true, weights: ALL },
  { id: 'libre-baskerville', label: 'Libre Baskerville', family: 'Libre Baskerville', google: true, weights: [400, 700] },
  { id: 'lora', label: 'Lora', family: 'Lora', google: true, weights: [400, 500, 600, 700] },
  { id: 'source-serif', label: 'Source Serif 4', family: 'Source Serif 4', google: true, weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { id: 'instrument-serif', label: 'Instrument Serif', family: 'Instrument Serif', google: true, weights: [400] },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: 'JetBrains Mono', google: true, weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: 'IBM Plex Mono', google: true, weights: [100, 200, 300, 400, 500, 600, 700] },
]

export function findFont(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}

const loaded = new Set<string>()

/** Inject a Google Fonts stylesheet for the family+weight (idempotent). */
export function ensureFontLoaded(font: FontDef, weight: number): void {
  if (!font.google) return
  const w = font.weights.reduce((best, cur) => (Math.abs(cur - weight) < Math.abs(best - weight) ? cur : best), font.weights[0])
  const key = `${font.family}:${w}`
  if (loaded.has(key)) return
  loaded.add(key)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family)}:wght@${w}&display=swap`
  document.head.appendChild(link)
}

/** CSS family value for rendering. */
export function fontFamilyCss(font: FontDef): string {
  return font.google ? `"${font.family}", sans-serif` : font.family
}
