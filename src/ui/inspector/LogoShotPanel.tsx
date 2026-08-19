import { useEffect, useMemo, useRef } from 'react'
import { Grid3x3, Grip, Rainbow, Sun, Upload, X } from 'lucide-react'
import { useProject } from '../../state/project'
import type { LogoAnimEffect, LogoStyle, Shot } from '../../state/types'
import { LOGO_PARAM_LABELS, LOGO_SHADERS, LOGO_SHAPES, LOGO_THEMES, type LogoShaderId } from '../../lib/presets/logoThemes'
import { DEFAULT_LOGO_STYLE } from '../../shots/logoRenderer'
import { disposeLogoThumb, renderLogoThumb } from '../../shots/LogoShotView'
import { toast } from '../toast'
import { FolderSection } from '../controls/FolderSection'
import { Select } from '../controls/Select'
import { ColorControl } from '../controls/ColorControl'
import { DialSlider } from '../controls/DialSlider'
import { ToggleRow } from '../controls/ToggleRow'
import { EffectsStack, type StackEffectDef } from './EffectsStack'
import { ShotPanelHeader } from './ShotPanelHeader'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_LOGO_BYTES = 1_048_576
const MAX_LOGO_EDGE = 4096

const LOGO_ANIM_OPTIONS: { value: LogoAnimEffect; label: string }[] = [
  { value: 'fade', label: 'Fade' },
  { value: 'scale-up', label: 'Scale Up' },
  { value: 'scale-down', label: 'Scale Down' },
  { value: 'blur-scale-up', label: 'Blur Scale Up' },
  { value: 'blur-scale-down', label: 'Blur Scale Down' },
  { value: 'none', label: 'None' },
]

/** PNG/SVG logo upload validation per ui.md §6 (≤1 MiB, ≤4096², magic bytes). */
async function handleLogoFile(file: File, apply: (patch: Partial<LogoStyle>) => void): Promise<void> {
  if (file.size > MAX_LOGO_BYTES) {
    toast(`Image is ${(file.size / 1_048_576).toFixed(1)} MB — max 1.0 MB. Compress it or pick a smaller file.`, 'error')
    return
  }
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name)

  if (isSvg) {
    let src: string
    try {
      src = await file.text()
    } catch {
      toast('Couldn’t read that file.', 'error')
      return
    }
    if (!src.includes('<svg')) {
      toast('That file isn’t a valid SVG.', 'error')
      return
    }
    try {
      const doc = new DOMParser().parseFromString(src, 'image/svg+xml')
      if (doc.querySelector('parsererror')) throw new Error('parse')
    } catch {
      toast('Couldn’t process that SVG.', 'error')
      return
    }
    apply({ svgSource: src, imageUrl: null })
    return
  }

  if (!isPng) {
    toast('Logo uploads must be PNG or SVG.', 'error')
    return
  }

  let head: Uint8Array
  try {
    head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  } catch {
    toast('Couldn’t read that file.', 'error')
    return
  }
  if (!PNG_MAGIC.every((b, i) => head[i] === b)) {
    toast('That file isn’t a valid PNG.', 'error')
    return
  }
  let w = 0
  let h = 0
  try {
    const bmp = await createImageBitmap(file)
    w = bmp.width
    h = bmp.height
    bmp.close()
  } catch {
    toast('That PNG couldn’t be decoded.', 'error')
    return
  }
  if (w > MAX_LOGO_EDGE || h > MAX_LOGO_EDGE) {
    toast(`Logo is ${w}×${h} — max 4096×4096 pixels. Resize it and try again.`, 'error')
    return
  }
  const dataUrl = await new Promise<string | null>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
  if (!dataUrl) {
    toast('Couldn’t read that file.', 'error')
    return
  }
  apply({ imageUrl: dataUrl, svgSource: null })
}

/** Live shader thumbnails for the effect picker. */
function EffectPicker({
  shader,
  colors,
  onPick,
}: {
  shader: LogoStyle['shader']
  colors: [string, string, string, string]
  onPick: (id: LogoStyle['shader']) => void
}) {
  const canvases = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const colorKey = colors.join(',')

  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (const s of LOGO_SHADERS) {
        const canvas = canvases.current.get(s.id)
        if (canvas) renderLogoThumb(canvas, s.id, colors)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // re-key the loop when the palette changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorKey])

  useEffect(() => {
    const map = canvases.current
    return () => {
      for (const canvas of map.values()) disposeLogoThumb(canvas)
      map.clear()
    }
  }, [])

  return (
    <div role="radiogroup" aria-label="Logo effect" className="grid grid-cols-2 gap-1.5">
      {LOGO_SHADERS.map((s) => (
        <button
          key={s.id}
          role="radio"
          aria-checked={shader === s.id}
          onClick={() => onPick(s.id)}
          className={`flex flex-col gap-1 rounded-lg border p-1 transition-colors ${
            shader === s.id
              ? 'border-[#FD631F]/70 bg-[#FD631F]/[0.06]'
              : 'border-black/10 dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
          }`}
        >
          <canvas
            width={240}
            height={135}
            ref={(el) => {
              if (el) canvases.current.set(s.id, el)
            }}
            className="w-full aspect-video rounded-md bg-black"
          />
          <span className="text-[9.5px] font-medium text-black/60 dark:text-white/55 text-center pb-0.5">{s.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Right panel when a Logo shot is selected (ui.md §6). */
export function LogoShotPanel({ shot }: { shot: Shot }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const logo = shot.logo ?? DEFAULT_LOGO_STYLE

  const update = (patch: Partial<LogoStyle>) =>
    useProject.getState().updateShot(shot.id, { logo: { ...logo, ...patch } })
  const updateFx = (patch: Partial<LogoStyle['effects']>) => update({ effects: { ...logo.effects, ...patch } })

  const hasImage = !!logo.imageUrl || !!logo.svgSource
  const isSvg = !!logo.svgSource
  const shaderActive = logo.shader !== 'none'
  const paramLabels = LOGO_PARAM_LABELS[logo.shader] ?? LOGO_PARAM_LABELS.none

  const previewSrc = useMemo(() => {
    if (logo.imageUrl) return logo.imageUrl
    if (logo.svgSource) return `data:image/svg+xml;utf8,${encodeURIComponent(logo.svgSource)}`
    return null
  }, [logo.imageUrl, logo.svgSource])

  const themeNames = shaderActive ? Object.keys(LOGO_THEMES[logo.shader as LogoShaderId] ?? {}) : []
  // stored theme names may differ in case ('gold' vs 'Gold') — resolve leniently
  const themeValue =
    logo.theme === 'custom'
      ? 'custom'
      : (themeNames.find((n) => n.toLowerCase() === logo.theme.toLowerCase()) ?? logo.theme)
  const themeOptions = [
    ...themeNames.map((n) => ({ value: n, label: n })),
    { value: 'custom', label: 'Custom' },
  ]

  const fx = logo.effects
  const fxDefs: StackEffectDef[] = [
    {
      key: 'grain',
      label: 'Grain',
      icon: Grip,
      sliders: [
        { id: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01, def: 0, value: fx.grain, set: (v) => updateFx({ grain: v }) },
      ],
    },
    {
      key: 'ca',
      label: 'Chromatic Abb.',
      icon: Rainbow,
      sliders: [
        {
          id: 'caStrength',
          label: 'Chromatic Abb.',
          min: 0,
          max: 1,
          step: 0.01,
          def: 0,
          value: fx.caStrength,
          set: (v) => updateFx({ caStrength: v }),
        },
      ],
    },
    {
      key: 'pixelGrid',
      label: 'Pixel Grid',
      icon: Grid3x3,
      sliders: [
        {
          id: 'pixelGrid',
          label: 'Pixel Grid',
          min: 0,
          max: 1,
          step: 0.01,
          def: 0,
          value: fx.pixelGrid,
          set: (v) => updateFx({ pixelGrid: v }),
        },
      ],
    },
    {
      key: 'bloom',
      label: 'Bloom',
      icon: Sun,
      enabled: { value: fx.bloom, set: (v) => updateFx({ bloom: v }) },
      sliders: [
        { id: 'bloomStrength', label: 'Strength', min: 0, max: 2, step: 0.02, def: 1, value: fx.bloomStrength, set: (v) => updateFx({ bloomStrength: v }) },
        { id: 'bloomThreshold', label: 'Threshold', min: 0, max: 1, step: 0.01, def: 0.35, value: fx.bloomThreshold, set: (v) => updateFx({ bloomThreshold: v }) },
        { id: 'bloomRadius', label: 'Radius', min: 0, max: 1, step: 0.01, def: 0.5, value: fx.bloomRadius, set: (v) => updateFx({ bloomRadius: v }) },
      ],
    },
  ]

  return (
    <>
      <ShotPanelHeader wordmark="Logo" />
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 [scrollbar-width:none]">
        {/* logo media */}
        <div className="relative group">
          <button
            aria-label={hasImage ? 'Replace logo' : 'Upload logo'}
            onClick={() => fileRef.current?.click()}
            className="w-full h-[84px] rounded-md border border-dashed border-black/20 dark:border-white/20 flex items-center justify-center overflow-hidden bg-[#6b6b6b]/20 hover:border-black/35 dark:hover:border-white/35 transition-colors"
          >
            {previewSrc ? (
              <img src={previewSrc} alt="" className="max-w-full max-h-full object-contain p-3" draggable={false} />
            ) : (
              <span className="flex flex-col items-center gap-1 text-black/45 dark:text-white/40">
                <Upload className="size-4" strokeWidth={2} />
                <span className="text-[10px] font-medium">Upload logo (PNG or SVG)</span>
              </span>
            )}
          </button>
          {hasImage && (
            <button
              aria-label="Remove logo"
              title="Remove logo"
              onClick={() => update({ imageUrl: null, svgSource: null })}
              className="absolute top-1.5 right-1.5 size-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleLogoFile(f, update)
              e.target.value = ''
            }}
          />
        </div>

        {/* effect picker */}
        <EffectPicker
          shader={logo.shader}
          colors={logo.colors}
          onPick={(id) => {
            const patch: Partial<LogoStyle> = { shader: id }
            if (id !== 'none' && logo.theme !== 'custom') {
              const themes = LOGO_THEMES[id as LogoShaderId]
              const name =
                Object.keys(themes).find((n) => n.toLowerCase() === logo.theme.toLowerCase()) ??
                Object.keys(themes)[0]
              patch.theme = name
              patch.colors = themes[name]
            }
            update(patch)
          }}
        />

        <FolderSection folderKey="logo-main" title="Logo">
          <DialSlider
            label="Scale"
            value={logo.scale}
            min={0}
            max={10}
            step={0.1}
            defaultValue={3.5}
            onChange={(v) => update({ scale: v })}
          />
          <DialSlider
            label="Position X"
            value={logo.posX ?? 0}
            min={-1}
            max={1}
            step={0.01}
            defaultValue={0}
            onChange={(v) => update({ posX: v })}
          />
          <DialSlider
            label="Position Y"
            value={logo.posY ?? 0}
            min={-1}
            max={1}
            step={0.01}
            defaultValue={0}
            onChange={(v) => update({ posY: v })}
          />
          <DialSlider
            label="Rotation"
            value={logo.rotation ?? 0}
            min={-180}
            max={180}
            step={1}
            defaultValue={0}
            onChange={(v) => update({ rotation: v })}
          />
          {isSvg && (
            <ColorControl
              label="Logo Color"
              value={logo.svgColor ?? '#000000'}
              defaultValue="#000000"
              onChange={(v) => update({ svgColor: v })}
            />
          )}
          <ToggleRow
            label="Transparent BG"
            checked={!!logo.transparentBg}
            onChange={(v) => update({ transparentBg: v })}
          />
          {!logo.transparentBg && (
            <ColorControl
              label="Background"
              value={logo.bgColor}
              defaultValue="#0a0a0a"
              onChange={(v) => update({ bgColor: v })}
            />
          )}
          {logo.transparentBg && (
            <p className="px-1 text-[10px] leading-relaxed text-black/40 dark:text-white/35">
              This shot overlays whatever plays beneath it on the timeline — drag it over another shot to
              composite.
            </p>
          )}
        </FolderSection>

        {shaderActive && !hasImage && (
          <FolderSection folderKey="logo-shape" title="Shape">
            <Select
              label="Shape"
              value={logo.shape}
              options={LOGO_SHAPES.map((s) => ({ value: s.id, label: s.label }))}
              onChange={(v) => update({ shape: v })}
            />
          </FolderSection>
        )}

        {shaderActive && (
          <FolderSection folderKey="logo-colors" title="Colors">
            <Select
              label="Theme"
              value={themeValue}
              options={themeOptions}
              onChange={(name) => {
                if (name === 'custom') {
                  update({ theme: 'custom' })
                } else {
                  const palette = LOGO_THEMES[logo.shader as LogoShaderId]?.[name]
                  update(palette ? { theme: name, colors: palette } : { theme: name })
                }
              }}
            />
            {logo.theme === 'custom' &&
              ([0, 1, 2, 3] as const).map((i) => (
                <ColorControl
                  key={i}
                  label={`Color ${i + 1}`}
                  value={logo.colors[i]}
                  onChange={(v) => {
                    const colors = [...logo.colors] as [string, string, string, string]
                    colors[i] = v
                    update({ colors, theme: 'custom' })
                  }}
                />
              ))}
          </FolderSection>
        )}

        {shaderActive && (
          <FolderSection folderKey="logo-options" title="Options">
            <DialSlider
              label="Speed"
              value={logo.speed}
              min={0}
              max={4}
              step={0.05}
              defaultValue={1}
              onChange={(v) => update({ speed: v })}
            />
            <DialSlider
              label={paramLabels[0]}
              value={logo.param1}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.8}
              onChange={(v) => update({ param1: v })}
            />
            <DialSlider
              label={paramLabels[1]}
              value={logo.param2}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              onChange={(v) => update({ param2: v })}
            />
          </FolderSection>
        )}

        <EffectsStack folderKey="logo-effects" title="Effects" effects={fxDefs} />

        <FolderSection folderKey="logo-enter" title="Enter">
          <Select
            label="Effect"
            value={logo.enter.effect}
            options={LOGO_ANIM_OPTIONS}
            onChange={(v) => update({ enter: { ...logo.enter, effect: v } })}
          />
          <DialSlider
            label="Duration"
            value={logo.enter.duration}
            min={0}
            max={3}
            step={0.05}
            defaultValue={0.4}
            onChange={(v) => update({ enter: { ...logo.enter, duration: v } })}
          />
        </FolderSection>
        <FolderSection folderKey="logo-exit" title="Exit">
          <Select
            label="Effect"
            value={logo.exit.effect}
            options={LOGO_ANIM_OPTIONS}
            onChange={(v) => update({ exit: { ...logo.exit, effect: v } })}
          />
          <DialSlider
            label="Duration"
            value={logo.exit.duration}
            min={0}
            max={3}
            step={0.05}
            defaultValue={0.4}
            onChange={(v) => update({ exit: { ...logo.exit, duration: v } })}
          />
        </FolderSection>
      </div>
    </>
  )
}
