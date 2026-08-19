import { useProject } from '../../state/project'
import type { Shot, TextAnim, TextBg, TextStyle } from '../../state/types'
import { GRADIENT_PRESETS } from '../../lib/presets/gradients'
import { IMAGE_BACKGROUNDS } from '../../lib/presets/backgrounds'
import { ensureFontLoaded, findFont } from '../../lib/presets/fonts'
import { DEFAULT_TEXT_STYLE } from '../../shots/textCanvas'
import { FolderSection } from '../controls/FolderSection'
import { Select } from '../controls/Select'
import { ColorControl } from '../controls/ColorControl'
import { DialSlider } from '../controls/DialSlider'
import { ImagePickerControl } from '../controls/ImagePickerControl'
import { FontCombobox } from './FontCombobox'
import { ShotPanelHeader } from './ShotPanelHeader'

const TEXT_EFFECT_OPTIONS: { value: TextAnim['effect']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'soft-blur', label: 'Soft Blur' },
  { value: 'fade-up', label: 'Fade Up' },
  { value: 'scale-up', label: 'Scale Up' },
  { value: 'scale-down', label: 'Scale Down' },
  { value: 'blur-scale-up', label: 'Blur Scale Up' },
  { value: 'blur-scale-down', label: 'Blur Scale Down' },
]

const PER_OPTIONS: { value: TextAnim['per']; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'word', label: 'Word' },
  { value: 'character', label: 'Character' },
]

const BG_PRESET_OPTIONS = GRADIENT_PRESETS.map((p) => ({ value: p.id, label: p.name, preview: p.css }))
const BG_IMAGE_PRESETS = IMAGE_BACKGROUNDS.map((b) => ({ value: b.url, label: b.name, preview: b.preview }))

function AnimFolder({
  folderKey,
  title,
  anim,
  onChange,
}: {
  folderKey: string
  title: string
  anim: TextAnim
  onChange: (a: TextAnim) => void
}) {
  return (
    <FolderSection folderKey={folderKey} title={title}>
      <Select
        label="Per"
        value={anim.per}
        options={PER_OPTIONS}
        onChange={(v) => onChange({ ...anim, per: v })}
      />
      <DialSlider
        label="Speed"
        value={anim.speed}
        min={0.1}
        max={4}
        step={0.05}
        defaultValue={0.5}
        onChange={(v) => onChange({ ...anim, speed: v })}
      />
      <Select
        label="Effect"
        value={anim.effect}
        options={TEXT_EFFECT_OPTIONS}
        onChange={(v) => onChange({ ...anim, effect: v })}
      />
    </FolderSection>
  )
}

/** Right panel when a Text shot is selected (ui.md §5). */
export function TextShotPanel({ shot }: { shot: Shot }) {
  const text = shot.text ?? DEFAULT_TEXT_STYLE
  const bg = text.bg
  const fontDef = findFont(text.font.family)
  const weights = fontDef.weights
  const minW = Math.min(...weights)
  const maxW = Math.max(...weights)

  const update = (patch: Partial<TextStyle>) =>
    useProject.getState().updateShot(shot.id, { text: { ...text, ...patch } })
  const updateFont = (patch: Partial<TextStyle['font']>) => update({ font: { ...text.font, ...patch } })
  const setBg = (bg: TextBg) => update({ bg })

  return (
    <>
      <ShotPanelHeader wordmark="Text" />
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 [scrollbar-width:none]">
        <FolderSection folderKey="text-content" title="Text">
          <textarea
            rows={3}
            placeholder="Your text here"
            value={text.content}
            onChange={(e) => update({ content: e.target.value })}
            className="w-full min-h-16 rounded-md bg-black/[0.05] dark:bg-white/[0.06] px-2.5 py-2 text-[12px] text-black dark:text-white outline-none resize-y placeholder:text-black/30 dark:placeholder:text-white/25"
          />
        </FolderSection>

        <FolderSection folderKey="text-font" title="Font">
          <FontCombobox
            value={text.font.family}
            onChange={(id) => {
              const f = findFont(id)
              const w = f.weights.reduce(
                (best, cur) => (Math.abs(cur - text.font.weight) < Math.abs(best - text.font.weight) ? cur : best),
                f.weights[0],
              )
              ensureFontLoaded(f, w)
              updateFont({ family: id, weight: w })
            }}
          />
          <DialSlider
            label="Weight"
            value={text.font.weight}
            min={minW}
            max={maxW}
            step={1}
            defaultValue={600}
            disabled={weights.length === 1}
            disabledReason="This font ships a single weight"
            onChange={(v) => {
              ensureFontLoaded(fontDef, v)
              updateFont({ weight: v })
            }}
          />
          <DialSlider
            label="Size"
            value={text.font.size}
            min={2}
            max={40}
            step={0.5}
            defaultValue={6}
            onChange={(v) => updateFont({ size: v })}
          />
          <DialSlider
            label="Spacing"
            value={text.font.letterSpacing}
            min={-5}
            max={20}
            step={1}
            defaultValue={0}
            onChange={(v) => updateFont({ letterSpacing: v })}
          />
          <Select
            label="Align"
            value={text.font.align}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={(v) => updateFont({ align: v })}
          />
        </FolderSection>

        <FolderSection folderKey="text-color" title="Color">
          <ColorControl label="Color" value={text.color} defaultValue="#ffffff" onChange={(v) => update({ color: v })} />
        </FolderSection>

        <FolderSection folderKey="text-bg" title="Background">
          <Select
            label="Background"
            value={bg.kind}
            options={[
              { value: 'color', label: 'Color' },
              { value: 'preset', label: 'Preset' },
              { value: 'image', label: 'Image' },
              { value: 'transparent', label: 'Transparent' },
            ]}
            onChange={(kind) => {
              if (kind === bg.kind) return
              if (kind === 'color') setBg({ kind: 'color', color: '#0a0a0a' })
              else if (kind === 'preset') setBg({ kind: 'preset', presetId: GRADIENT_PRESETS[0].id })
              else if (kind === 'transparent') setBg({ kind: 'transparent' })
              else setBg({ kind: 'image', imageUrl: IMAGE_BACKGROUNDS[0].url, blur: 0 })
            }}
          />
          {bg.kind === 'transparent' && (
            <p className="px-1 text-[10px] leading-relaxed text-black/40 dark:text-white/35">
              This shot overlays whatever plays beneath it on the timeline — drag it over another shot to
              composite.
            </p>
          )}
          {bg.kind === 'color' && (
            <ColorControl
              label="BG Color"
              value={bg.color}
              defaultValue="#0a0a0a"
              onChange={(v) => setBg({ kind: 'color', color: v })}
            />
          )}
          {bg.kind === 'preset' && (
            <Select
              label="BG Preset"
              value={bg.presetId}
              options={BG_PRESET_OPTIONS}
              onChange={(v) => setBg({ kind: 'preset', presetId: v })}
            />
          )}
          {bg.kind === 'image' && (
            <>
              <ImagePickerControl
                label="BG Image"
                value={bg.imageUrl}
                presets={BG_IMAGE_PRESETS}
                onChange={(url) => setBg({ kind: 'image', imageUrl: url, blur: bg.blur })}
              />
              <DialSlider
                label="BG Blur"
                value={bg.blur ?? 0}
                min={0}
                max={1}
                step={0.01}
                defaultValue={0}
                onChange={(v) => setBg({ kind: 'image', imageUrl: bg.imageUrl, blur: v })}
              />
            </>
          )}
        </FolderSection>

        <AnimFolder folderKey="text-enter" title="Enter" anim={text.enter} onChange={(a) => update({ enter: a })} />
        <AnimFolder folderKey="text-exit" title="Exit" anim={text.exit} onChange={(a) => update({ exit: a })} />
      </div>
    </>
  )
}
