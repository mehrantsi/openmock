/** Logo-shot shader theme palettes (4 colors each). */

export type LogoShaderId = 'liquid-metal' | 'gem-smoke' | 'heatmap'

export const LOGO_SHADERS: { id: 'none' | LogoShaderId; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'liquid-metal', label: 'Liquid Metal' },
  { id: 'gem-smoke', label: 'Gem Smoke' },
  { id: 'heatmap', label: 'Heatmap' },
]

export const LOGO_SHAPES = [
  { id: 'circle', label: 'Circle' },
  { id: 'daisy', label: 'Daisy' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'metaballs', label: 'Metaballs' },
] as const

export const LOGO_THEMES: Record<LogoShaderId, Record<string, [string, string, string, string]>> = {
  'liquid-metal': {
    Gold: ['#ffd24a', '#e6b85c', '#fff3a0', '#a87a2e'],
    Bronze: ['#c98a4a', '#7a4517', '#e2b07a', '#3a2510'],
    Silver: ['#e8eaef', '#bcbcc7', '#ffffff', '#7a7a85'],
    Platinum: ['#f5f7fa', '#dde2eb', '#ffffff', '#a7adb8'],
    Chrome: ['#ffffff', '#dddddd', '#aaaaaa', '#666666'],
    Obsidian: ['#33333a', '#1a1a1f', '#000000', '#555560'],
    Copper: ['#d97743', '#8a3a14', '#f4a572', '#5a1f08'],
    Amethyst: ['#a070d0', '#5a2880', '#d6b0f0', '#2a0e44'],
  },
  'gem-smoke': {
    Mono: ['#333333', '#aaaaaa', '#e7e6df', '#fafaf5'],
    Blue: ['#0a4080', '#2a8fff', '#88c8ff', '#e8f4ff'],
    Ice: ['#a8d8ff', '#dceeff', '#ffffff', '#88bbff'],
    Fire: ['#fe5b16', '#f7ff61', '#ffffff', '#1a0500'],
    Fluorescent: ['#2fb64c', '#cdff61', '#ffffff', '#000000'],
    Toxic: ['#3aff00', '#88ff77', '#bbff99', '#00220a'],
    Rose: ['#ff5e8a', '#ffb0c5', '#ffffff', '#3a0010'],
    Noir: ['#1a1a1a', '#555555', '#bbbbbb', '#000000'],
  },
  heatmap: {
    Infrared: ['#000033', '#cc0066', '#ffaa22', '#fff8a0'],
    Thermal: ['#000044', '#3300ff', '#ff0033', '#ffff00'],
    Inferno: ['#000000', '#7a0000', '#ff6600', '#fff066'],
    Plasma: ['#3a0078', '#a020c0', '#ff6b9a', '#ffe066'],
    Aurora: ['#02061a', '#0a4a3a', '#3affb5', '#dffff6'],
    Sepia: ['#1a1208', '#664a22', '#bf8a4a', '#fff2c5'],
    Mono: ['#000000', '#555555', '#bbbbbb', '#ffffff'],
    Viridis: ['#440154', '#3b528b', '#21918c', '#fde725'],
  },
}

/** Per-shader labels for the two tuning params. */
export const LOGO_PARAM_LABELS: Record<string, [string, string]> = {
  'liquid-metal': ['Softness', 'Distortion'],
  'gem-smoke': ['Glow', 'Distortion'],
  heatmap: ['Glow', 'Contour'],
  none: ['Param 1', 'Param 2'],
}
