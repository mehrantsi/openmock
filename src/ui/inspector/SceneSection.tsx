import { useUI } from '../../state/ui'
import type { BgMode, RenderState } from '../../state/types'
import { GRADIENT_PRESETS } from '../../lib/presets/gradients'
import { IMAGE_BACKGROUNDS } from '../../lib/presets/backgrounds'
import { FolderSection } from '../controls/FolderSection'
import { ImagePickerControl } from '../controls/ImagePickerControl'
import { Select } from '../controls/Select'
import { ColorControl } from '../controls/ColorControl'
import { DialSlider } from '../controls/DialSlider'
import { ToggleRow } from '../controls/ToggleRow'
import { LightPad } from '../controls/LightPad'
import { commitDials, noticeOnce, rememberBgColor, useDials } from './dialHelpers'

const BG_PRESET_OPTIONS = [
  { value: '', label: 'None' },
  ...GRADIENT_PRESETS.map((p) => ({ value: p.id, label: p.name, preview: p.css })),
]

const BG_IMAGE_PRESETS = IMAGE_BACKGROUNDS.map((b) => ({ value: b.url, label: b.name, preview: b.preview }))

function sceneNotice(): void {
  noticeOnce('openmock-scene-notice-dismissed', 'Background & scene settings apply to all shots.')
}

export function SceneSection() {
  const dials = useDials()
  const resolvedDark = useUI((s) => s.resolvedDark)
  const modelActive = !!dials.mockupModel

  const commitScene = (patch: Partial<RenderState>) => {
    commitDials(patch)
    sceneNotice()
  }

  const setBgMode = (mode: BgMode) => {
    const patch: Partial<RenderState> = { bgMode: mode }
    // auto-seed on switch
    if (mode === 'preset' && !dials.bgPreset) patch.bgPreset = GRADIENT_PRESETS[0].id
    if (mode === 'image' && !dials.bgImage) patch.bgImage = IMAGE_BACKGROUNDS[0].url
    if (mode === 'environment' && !dials.envId) patch.envId = 'studio-concrete'
    if (mode !== 'environment' && dials.envId) patch.envId = ''
    commitScene(patch)
  }

  const dirty =
    dials.bgMode !== 'color' ||
    dials.bgColor !== (resolvedDark ? '#0a0a0a' : '#f2f2f2') ||
    dials.transparentBg ||
    !!dials.bgPreset ||
    !!dials.bgImage

  const resetScene = () => {
    const color = resolvedDark ? '#0a0a0a' : '#f2f2f2'
    rememberBgColor(color, resolvedDark)
    commitDials(
      {
        bgMode: 'color',
        bgColor: color,
        bgPreset: '',
        bgImage: null,
        bgBlur: 0,
        envId: '',
        lift: 0,
        envLightHeight: 0,
        envLightX: 0,
        envLightZ: 0,
        transparentBg: false,
      },
      true,
    )
  }

  return (
    <FolderSection folderKey="scene" title="Scene" dirty={dirty} onReset={resetScene}>
      <Select<BgMode>
        label="Background"
        value={dials.bgMode}
        options={[
          { value: 'color', label: 'Color' },
          { value: 'preset', label: 'Preset' },
          { value: 'image', label: 'Image' },
          { value: 'environment', label: 'Environment' },
        ]}
        onChange={setBgMode}
      />

      {dials.bgMode === 'color' && (
        <ColorControl
          label="Color"
          value={dials.bgColor}
          defaultValue={resolvedDark ? '#0a0a0a' : '#f2f2f2'}
          onChange={(v) => {
            rememberBgColor(v, resolvedDark)
            commitScene({ bgColor: v })
          }}
        />
      )}

      {dials.bgMode === 'preset' && (
        <Select
          label="Preset"
          value={dials.bgPreset}
          options={BG_PRESET_OPTIONS}
          onChange={(v) => commitScene({ bgPreset: v })}
        />
      )}

      {dials.bgMode === 'image' && (
        <>
          <ImagePickerControl
            label="Image"
            value={dials.bgImage}
            presets={BG_IMAGE_PRESETS}
            onChange={(url) => commitScene({ bgImage: url })}
          />
          {dials.bgImage && (
            <DialSlider
              label="BG Blur"
              value={dials.bgBlur}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => commitScene({ bgBlur: v })}
            />
          )}
        </>
      )}

      {dials.bgMode === 'environment' && (
        <>
          <Select
            label="Scene"
            value={dials.envId}
            options={[
              { value: 'studio-concrete', label: 'Concrete' },
              { value: 'studio-bright', label: 'Studio' },
            ]}
            onChange={(v) => commitScene({ envId: v })}
          />
          {modelActive && (
            <>
              <DialSlider
                label="Mockup Height"
                value={dials.lift}
                min={-2}
                max={2}
                step={0.01}
                defaultValue={0}
                onChange={(v) => commitScene({ lift: v })}
              />
              <DialSlider
                label="Light Height"
                value={dials.envLightHeight}
                min={-5}
                max={5}
                step={0.1}
                defaultValue={0}
                onChange={(v) => commitScene({ envLightHeight: v })}
              />
              <LightPad
                label="Light Position"
                x={dials.envLightX}
                y={dials.envLightZ}
                min={-6}
                max={6}
                step={0.05}
                onChange={(x, z) => commitScene({ envLightX: x, envLightZ: z })}
              />
            </>
          )}
        </>
      )}

      <ToggleRow
        label="Transparent Background"
        checked={dials.transparentBg}
        onChange={(v) => commitScene({ transparentBg: v })}
      />
    </FolderSection>
  )
}
