/** Export size tables. Everything is available — no gating. */

export interface Resolution {
  width: number
  height: number
  label: string
}

export const RESOLUTIONS: Record<string, Resolution> = {
  '720p': { width: 1280, height: 720, label: '16:9 — 1280×720 (720p)' },
  '1080p': { width: 1920, height: 1080, label: '16:9 — 1920×1080 (1080p)' },
  '1440p': { width: 2560, height: 1440, label: '16:9 — 2560×1440 (1440p)' },
  '2160p': { width: 3840, height: 2160, label: '16:9 — 3840×2160 (4K)' },
  '1080p-portrait': { width: 1080, height: 1920, label: '9:16 — 1080×1920 (1080p)' },
  '2160p-portrait': { width: 2160, height: 3840, label: '9:16 — 2160×3840 (4K)' },
  '1080p-square': { width: 1080, height: 1080, label: '1:1 — 1080×1080 (1080p)' },
  '2160p-square': { width: 2160, height: 2160, label: '1:1 — 2160×2160 (4K)' },
  '4by3-1440': { width: 1920, height: 1440, label: '4:3 — 1920×1440 (1440p)' },
  '4by3-1920': { width: 2560, height: 1920, label: '4:3 — 2560×1920' },
  '3by2-1920': { width: 2880, height: 1920, label: '3:2 — 2880×1920' },
  '21by9-1920': { width: 4480, height: 1920, label: '21:9 — 4480×1920' },
  '4by5-1920': { width: 1920, height: 2400, label: '4:5 — 1920×2400' },
  '3by4-1440': { width: 1440, height: 1920, label: '3:4 — 1440×1920 (1440p)' },
  '3by4-1920': { width: 1920, height: 2560, label: '3:4 — 1920×2560' },
  '2by3-1920': { width: 1920, height: 2880, label: '2:3 — 1920×2880' },
  'appstore-iphone': { width: 1290, height: 2796, label: 'App Store · iPhone — 1290×2796' },
  'appstore-ipad': { width: 2064, height: 2752, label: 'App Store · iPad — 2064×2752' },
  'appstore-mac': { width: 2880, height: 1800, label: 'App Store · Mac — 2880×1800' },
  'appstore-video-h': { width: 1920, height: 1080, label: 'App Store Video · Horizontal — 1920×1080' },
  'appstore-video-v': { width: 1080, height: 1920, label: 'App Store Video · Vertical — 1080×1920' },
}

/** Per-kind overrides (video keeps 21:9 modest for encode limits). */
const VIDEO_OVERRIDES: Record<string, Resolution> = {
  '21by9-1920': { width: 2240, height: 960, label: '21:9 — 2240×960' },
}

export function lookupResolution(size: string, kind: 'image' | 'video' = 'image'): Resolution | undefined {
  if (kind === 'video' && VIDEO_OVERRIDES[size]) return VIDEO_OVERRIDES[size]
  return RESOLUTIONS[size]
}

export const RATIO_DEFAULT_SIZE: Record<string, string> = {
  '16:9': '1080p',
  '9:16': '1080p-portrait',
  '1:1': '1080p-square',
  '4:3': '4by3-1440',
  '3:2': '3by2-1920',
  '21:9': '21by9-1920',
  '4:5': '4by5-1920',
  '3:4': '3by4-1440',
  '2:3': '2by3-1920',
  'appstore-iphone': 'appstore-iphone',
  'appstore-ipad': 'appstore-ipad',
  'appstore-mac': 'appstore-mac',
  'appstore-video-h': 'appstore-video-h',
  'appstore-video-v': 'appstore-video-v',
}

export const ORIENTATION_SIZES: Record<'landscape' | 'square' | 'portrait', string[]> = {
  landscape: ['720p', '1080p', '1440p', '2160p', '4by3-1440', '4by3-1920', '3by2-1920', '21by9-1920'],
  square: ['1080p-square', '2160p-square'],
  portrait: ['1080p-portrait', '2160p-portrait', '3by4-1440', '3by4-1920', '4by5-1920', '2by3-1920'],
}
export const ORIENTATION_DEFAULT: Record<'landscape' | 'square' | 'portrait', string> = {
  landscape: '1080p',
  square: '1080p-square',
  portrait: '1080p-portrait',
}
export const APPSTORE_SIZES = {
  image: ['appstore-iphone', 'appstore-ipad', 'appstore-mac'],
  video: ['appstore-video-h', 'appstore-video-v'],
}

export const MIN_EDGE = 8
export const MAX_IMAGE_EDGE = 5120
export const MAX_VIDEO_EDGE = 3840

/** Resolve final export dimensions (custom sizes clamped; video forced even). */
export function resolveExportSize(
  size: string,
  customWidth: number,
  customHeight: number,
  kind: 'image' | 'video' = 'image',
): { width: number; height: number } {
  if (size === 'custom') {
    const maxEdge = kind === 'video' ? MAX_VIDEO_EDGE : MAX_IMAGE_EDGE
    let w = Math.min(maxEdge, Math.max(MIN_EDGE, Math.round(customWidth)))
    let h = Math.min(maxEdge, Math.max(MIN_EDGE, Math.round(customHeight)))
    if (kind === 'video') {
      w -= w % 2
      h -= h % 2
    }
    return { width: w, height: h }
  }
  const r = lookupResolution(size, kind) ?? RESOLUTIONS['1080p']
  return { width: r.width, height: r.height }
}

/** Video bitrate in bps, scaled from a 1080p base per quality tier. */
export function videoBitrate(quality: 'low' | 'medium' | 'high' | 'ultra', w: number, h: number): number {
  const base = { low: 10_000_000, medium: 16_000_000, high: 22_000_000, ultra: 30_000_000 }[quality]
  return Math.round(base * ((w * h) / 2_073_600))
}

/** Pick an H.264 High-profile codec string whose level fits the dimensions/fps. */
export function pickAvcCodec(w: number, h: number, fps: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16)
  const mbps = mbs * fps
  const levels: [string, number, number][] = [
    ['avc1.640028', 8192, 245760],
    ['avc1.64002A', 8704, 522240],
    ['avc1.640032', 22080, 589824],
    ['avc1.640033', 36864, 983040],
    ['avc1.640034', 36864, 2073600],
    ['avc1.640040', 139264, 4177920],
    ['avc1.640042', 139264, 16711680],
  ]
  for (const [codec, maxFS, maxMBPS] of levels) {
    if (mbs <= maxFS && mbps <= maxMBPS) return codec
  }
  return levels[levels.length - 1][0]
}

/** Viewport ratio options (top bar selector). */
export const VIEWPORT_RATIOS = [
  'fill',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  'appstore-iphone',
  'appstore-ipad',
  'appstore-mac',
  'appstore-video-h',
  'appstore-video-v',
] as const

export const VIEWPORT_RATIO_LABELS: Record<string, { label: string; sub?: string }> = {
  fill: { label: 'Fill' },
  '21:9': { label: '21:9' },
  '16:9': { label: '16:9' },
  '3:2': { label: '3:2' },
  '4:3': { label: '4:3' },
  '1:1': { label: '1:1' },
  '4:5': { label: '4:5' },
  '3:4': { label: '3:4' },
  '2:3': { label: '2:3' },
  '9:16': { label: '9:16' },
  'appstore-iphone': { label: 'App Store · iPhone', sub: '1290 × 2796' },
  'appstore-ipad': { label: 'App Store · iPad', sub: '2064 × 2752' },
  'appstore-mac': { label: 'App Store · Mac', sub: '2880 × 1800' },
  'appstore-video-h': { label: 'App Store Video · Horizontal', sub: '1920 × 1080' },
  'appstore-video-v': { label: 'App Store Video · Vertical', sub: '1080 × 1920' },
}

/** Numeric aspect for a viewport ratio key ('fill' = null → use container). */
export function viewportRatioAspect(ratio: string): number | null {
  switch (ratio) {
    case 'fill':
      return null
    case 'appstore-iphone':
      return 1290 / 2796
    case 'appstore-ipad':
      return 0.75
    case 'appstore-mac':
      return 1.6
    case 'appstore-video-h':
      return 1920 / 1080
    case 'appstore-video-v':
      return 0.5625
    default: {
      const m = ratio.split(':')
      if (m.length === 2) {
        const a = parseFloat(m[0])
        const b = parseFloat(m[1])
        if (a > 0 && b > 0) return a / b
      }
      return null
    }
  }
}
