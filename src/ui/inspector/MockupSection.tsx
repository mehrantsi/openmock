import { useState } from 'react'
import { Check } from 'lucide-react'
import { useProject } from '../../state/project'
import { DEFAULT_RENDER_STATE, type RenderState } from '../../state/types'
import {
  DEVICE_CARDS,
  FINISH_OPTIONS,
  MOCKUP_MODELS,
  defaultFinish,
  deviceLightingDefaults,
} from '../../three/devices/registry'
import { IMAGE_BACKGROUNDS } from '../../lib/presets/backgrounds'
import { maybeSwapDefaultMedia } from '../../lib/defaultMedia'
import { toast } from '../toast'
import { FolderSection } from '../controls/FolderSection'
import { Select } from '../controls/Select'
import { ColorControl } from '../controls/ColorControl'
import { DialSlider } from '../controls/DialSlider'
import { ToggleRow } from '../controls/ToggleRow'
import { ImagePickerControl } from '../controls/ImagePickerControl'
import { KfRow } from './KfRow'
import { commitDials, useDials } from './dialHelpers'

const SCREEN_BG_PRESETS = IMAGE_BACKGROUNDS.map((b) => ({ value: b.url, label: b.name, preview: b.preview }))

function DeviceCardButton({
  active,
  label,
  sub,
  thumb,
  onClick,
}: {
  active: boolean
  label: string
  sub: string
  thumb: string
  onClick: () => void
}) {
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1 rounded-lg border p-2 pt-2.5 transition-colors ${
        active
          ? 'border-[#FD631F]/70 bg-[#FD631F]/[0.06]'
          : 'border-black/10 dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      <img src={thumb} alt="" className="h-10 object-contain" draggable={false} />
      <span className="text-[10px] font-medium text-black/70 dark:text-white/65 leading-tight text-center">
        {label}
      </span>
      <span className="text-[8.5px] text-black/35 dark:text-white/30">{sub}</span>
      {active && (
        <span className="absolute top-1 right-1 size-4 rounded-full bg-[#FD631F] flex items-center justify-center">
          <Check className="size-2.5 text-white" strokeWidth={3.5} />
        </span>
      )}
    </button>
  )
}

export function MockupSection() {
  const dials = useDials()
  const [gridOpen, setGridOpen] = useState(false)
  const model = dials.mockupModel
  const def = model ? (MOCKUP_MODELS[model] ?? null) : null
  const card = model ? (DEVICE_CARDS.find((c) => c.id === model) ?? null) : null

  const isWatch = model === 'watchUltra3'
  const isProIphone = model === 'iphone17Pro' || model === 'iphone17ProMax'
  const lighting = deviceLightingDefaults(model)
  const finishOptions = model ? FINISH_OPTIONS[model] : undefined
  const showScreenBg = !model || !def?.hideMockupBg
  const showPadding = !def?.hideMockupPadding

  const select = (id: string) => {
    useProject.getState().selectDevice(id)
    // shots without user media follow the device's stock screen
    maybeSwapDefaultMedia(id)
    setGridOpen(false)
    if (id) {
      const c = DEVICE_CARDS.find((x) => x.id === id)
      if (c) toast(`Ideal media ${c.resolution[0]} × ${c.resolution[1]}`, 'info', 3600)
    }
  }

  const settingsDirty =
    !!model &&
    (dials.deviceFinish !== defaultFinish(model) ||
      dials.hdrYaw !== lighting.hdrYaw ||
      dials.keyLight !== lighting.keyLight ||
      dials.keyLightHeight !== lighting.keyLightHeight ||
      dials.keyLightRotation !== lighting.keyLightRotation ||
      dials.screenGlow !== 0 ||
      dials.contactShadow ||
      Object.keys(dials.deviceFeatures).length > 0)

  const resetDeviceSettings = () => {
    const patch: Partial<RenderState> = {
      deviceFinish: model ? defaultFinish(model) : DEFAULT_RENDER_STATE.deviceFinish,
      bandColor: DEFAULT_RENDER_STATE.bandColor,
      laptopHingeAngle: def?.hinge?.openDeg ?? DEFAULT_RENDER_STATE.laptopHingeAngle,
      mockupBgMode: 'color',
      mockupBg: DEFAULT_RENDER_STATE.mockupBg,
      mockupBgImage: null,
      mockupPadding: DEFAULT_RENDER_STATE.mockupPadding,
      statusBarEnabled: true,
      notchEnabled: true,
      contactShadow: false,
      deviceFeatures: {},
      screenGlow: 0,
      ...lighting,
    }
    commitDials(patch, true)
  }

  return (
    <FolderSection folderKey="mockup" title="Mockup" dirty={settingsDirty} onReset={resetDeviceSettings}>
      {/* current selection card */}
      <button
        aria-label="Change mockup"
        onClick={() => setGridOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 rounded-md border border-black/10 dark:border-white/10 p-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors"
      >
        <img
          src={card ? card.thumb : '/device-thumbs/flat.png'}
          alt=""
          className="size-9 object-contain shrink-0"
          draggable={false}
        />
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-[11px] font-medium text-black/75 dark:text-white/70 truncate">
            {card ? card.label : 'Flat'}
          </span>
          <span className="block text-[9px] text-black/35 dark:text-white/30">
            {card ? `${card.resolution[0]} × ${card.resolution[1]}` : 'Any size'}
          </span>
        </span>
        <span className="text-[10px] font-medium text-black/40 dark:text-white/35">
          Change
        </span>
      </button>

      {gridOpen && (
        <div role="radiogroup" aria-label="Mockup" className="grid grid-cols-2 gap-1.5">
          <DeviceCardButton
            active={!model}
            label="Flat"
            sub="Any size"
            thumb="/device-thumbs/flat.png"
            onClick={() => select('')}
          />
          {DEVICE_CARDS.map((c) => (
            <DeviceCardButton
              key={c.id}
              active={model === c.id}
              label={c.label}
              sub={`${c.resolution[0]} × ${c.resolution[1]}`}
              thumb={c.thumb}
              onClick={() => select(c.id)}
            />
          ))}
        </div>
      )}

      {/* Device Settings */}
      <div className="flex flex-col gap-1 pt-1">
        <span className="px-1 text-[10px] font-medium text-black/35 dark:text-white/30">
          Device Settings
        </span>

        {def?.features?.map((f) => (
          <ToggleRow
            key={f.id}
            label={f.label}
            checked={dials.deviceFeatures[f.id] ?? f.defaultOn}
            onChange={(v) => commitDials({ deviceFeatures: { ...dials.deviceFeatures, [f.id]: v } })}
          />
        ))}

        {model && finishOptions && (
          <Select
            label={isWatch ? 'Case' : 'Finish'}
            value={dials.deviceFinish}
            options={finishOptions.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => commitDials({ deviceFinish: v })}
          />
        )}

        {isWatch && (
          <ColorControl
            label="Band Colour"
            value={dials.bandColor}
            defaultValue="#3b3b3b"
            onChange={(v) => commitDials({ bandColor: v })}
          />
        )}

        {def?.hasLid && (
          <KfRow prop="laptopHingeAngle">
            <DialSlider
              label="Lid Angle"
              value={dials.laptopHingeAngle}
              min={0}
              max={def.hinge?.maxDeg ?? 135}
              step={1}
              defaultValue={def.hinge?.openDeg ?? 110}
              onChange={(v) => commitDials({ laptopHingeAngle: v })}
            />
          </KfRow>
        )}

        {showScreenBg && (
          <>
            <Select
              label="Screen BG"
              value={dials.mockupBgMode}
              options={[
                { value: 'color', label: 'Color' },
                { value: 'image', label: 'Image' },
              ]}
              onChange={(v) => commitDials({ mockupBgMode: v })}
            />
            {dials.mockupBgMode === 'color' ? (
              <ColorControl
                label="Color"
                value={dials.mockupBg}
                defaultValue="#1e1e1e"
                onChange={(v) => commitDials({ mockupBg: v })}
              />
            ) : (
              <ImagePickerControl
                label="Image"
                value={dials.mockupBgImage}
                presets={SCREEN_BG_PRESETS}
                onChange={(url) => commitDials({ mockupBgImage: url })}
              />
            )}
          </>
        )}

        {showPadding && (
          <DialSlider
            label="Screen Padding"
            value={dials.mockupPadding}
            min={0}
            max={0.45}
            step={0.01}
            defaultValue={0.05}
            onChange={(v) => commitDials({ mockupPadding: v })}
          />
        )}

        {isProIphone && (
          <>
            <ToggleRow
              label="Status Bar"
              checked={dials.statusBarEnabled}
              onChange={(v) => commitDials({ statusBarEnabled: v })}
            />
            <ToggleRow label="Notch" checked={dials.notchEnabled} onChange={(v) => commitDials({ notchEnabled: v })} />
          </>
        )}

        {model && (
          <>
            <KfRow prop="hdrYaw">
              <DialSlider
                label="Light Rotation"
                value={dials.hdrYaw}
                min={0}
                max={360}
                step={1}
                defaultValue={lighting.hdrYaw}
                onChange={(v) => commitDials({ hdrYaw: v })}
              />
            </KfRow>
            <DialSlider
              label="Key Light"
              value={dials.keyLight}
              min={0}
              max={4}
              step={0.05}
              defaultValue={lighting.keyLight}
              onChange={(v) => commitDials({ keyLight: v })}
            />
            <DialSlider
              label="Key Light Height"
              value={dials.keyLightHeight}
              min={0}
              max={15}
              step={0.1}
              defaultValue={lighting.keyLightHeight}
              onChange={(v) => commitDials({ keyLightHeight: v })}
            />
            <DialSlider
              label="Key Light Rotation"
              value={dials.keyLightRotation}
              min={-180}
              max={180}
              step={1}
              defaultValue={lighting.keyLightRotation}
              onChange={(v) => commitDials({ keyLightRotation: v })}
            />
            <DialSlider
              label="Screen Glow"
              value={dials.screenGlow}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => commitDials({ screenGlow: v })}
            />
            <ToggleRow
              label="Contact Shadow"
              checked={dials.contactShadow}
              onChange={(v) => commitDials({ contactShadow: v })}
            />
          </>
        )}
      </div>
    </FolderSection>
  )
}
