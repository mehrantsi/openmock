import {
  Aperture,
  Box,
  Droplets,
  FlipVertical2,
  Frame,
  Ghost,
  Grid3x3,
  Grip,
  Rainbow,
  Sun,
  SunDim,
} from 'lucide-react'
import type { RenderState } from '../../state/types'
import { EffectsStack, type StackEffectDef } from './EffectsStack'
import { commitDials, useDials, useMediaAnalysis, useSelectedShot } from './dialHelpers'

function num(dials: RenderState, key: keyof RenderState) {
  return dials[key] as number
}

function slider(
  dials: RenderState,
  key: keyof RenderState,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
) {
  return {
    id: key as string,
    label,
    min,
    max,
    step,
    def,
    value: num(dials, key),
    set: (v: number) => commitDials({ [key]: v } as Partial<RenderState>),
  }
}

/** Viewport-panel effects stack (effects.md §11 table). */
export function EffectsSection() {
  const dials = useDials()
  const shot = useSelectedShot()
  const analysis = useMediaAnalysis(shot?.imageKey)
  const modelActive = !!dials.mockupModel
  const mediaIsDark = analysis?.isDark ?? false

  const effects: StackEffectDef[] = [
    {
      key: 'depth',
      label: 'Depth',
      icon: Box,
      sliders: [slider(dials, 'extrudeDepth', 'Depth', 0, 1, 0.01, 0)],
      disabledReason: modelActive ? 'Turn off 3D model to use' : null,
    },
    {
      key: 'sharpen',
      label: 'Sharpen',
      icon: Aperture,
      sliders: [slider(dials, 'sharpen', 'Sharpen', 0, 1, 0.01, 0)],
    },
    {
      key: 'vignette',
      label: 'Vignette',
      icon: Frame,
      sliders: [slider(dials, 'vignette', 'Vignette', 0, 1, 0.01, 0)],
    },
    {
      key: 'grain',
      label: 'Grain',
      icon: Grip,
      sliders: [slider(dials, 'grain', 'Grain', 0, 1, 0.01, 0)],
    },
    {
      key: 'pixelGrid',
      label: 'Pixel Grid',
      icon: Grid3x3,
      sliders: [slider(dials, 'pixelGrid', 'Pixel Grid', 0, 1, 0.01, 0)],
    },
    {
      key: 'ca',
      label: 'Chromatic Abb.',
      icon: Rainbow,
      sliders: [slider(dials, 'caStrength', 'Chromatic Abb.', 0, 1, 0.01, 0)],
    },
    {
      key: 'bloom',
      label: 'Bloom',
      icon: Sun,
      enabled: { value: dials.bloomEnabled, set: (v) => commitDials({ bloomEnabled: v }) },
      sliders: [
        slider(dials, 'bloomStrength', 'Strength', 0, 2, 0.02, 1),
        slider(dials, 'bloomThreshold', 'Threshold', 0, 1, 0.01, 0.35),
        slider(dials, 'bloomRadius', 'Radius', 0, 1, 0.01, 0.5),
      ],
    },
    {
      key: 'lighting',
      label: 'Screen Fade',
      icon: SunDim,
      enabled: { value: dials.lightingEnabled, set: (v) => commitDials({ lightingEnabled: v }) },
      sliders: [
        slider(dials, 'lightingAngle', 'Fade Angle', 0, 360, 1, 135),
        slider(dials, 'lightingIntensity', 'Fade Intensity', 0, 1, 0.01, 0.45),
        slider(dials, 'lightingSoftness', 'Fade Softness', 0, 1, 0.01, 0.5),
      ],
    },
    {
      key: 'ghost',
      label: 'Ghost',
      icon: Ghost,
      enabled: { value: dials.ghostEnabled, set: (v) => commitDials({ ghostEnabled: v }) },
      sliders: [
        slider(dials, 'ghostOpacity', 'Opacity', 0, 0.2, 0.01, 0.05),
        slider(dials, 'ghostOffsetY', 'Offset Down', 0, 0.02, 0.001, 0),
        slider(dials, 'ghostBlur', 'Blur', 0, 0.3, 0.01, 0.2),
        slider(dials, 'ghostDepth', 'Depth', 0, 0.012, 0.001, 0.01),
      ],
      disabledReason: modelActive
        ? 'Turn off 3D model to use'
        : !mediaIsDark
          ? 'Only works on dark-mode screenshots'
          : null,
    },
    {
      key: 'reflection',
      label: 'Reflection',
      icon: FlipVertical2,
      sliders: [slider(dials, 'reflectionStrength', 'Reflection', 0, 1, 0.01, 0)],
    },
    {
      key: 'screenGlass',
      label: 'Liquid Glass',
      icon: Droplets,
      enabled: { value: dials.screenGlass, set: (v) => commitDials({ screenGlass: v }) },
      select: {
        id: 'screenGlassTarget',
        label: 'Applies to',
        options: [
          {
            value: 'mockup',
            label: 'Mockup',
            disabledReason: modelActive ? 'Mockup not available on 3D devices' : undefined,
          },
          { value: 'frame', label: 'Frame' },
        ],
        def: 'mockup',
        value: dials.screenGlassTarget,
        set: (v) => commitDials({ screenGlassTarget: v as RenderState['screenGlassTarget'] }),
      },
      sliders: [
        slider(dials, 'screenGlassStrength', 'Strength', 0, 1, 0.01, 0.5),
        slider(dials, 'screenGlassShine', 'Shine', 0, 1, 0.01, 0.3),
      ],
    },
  ]

  return <EffectsStack folderKey="effects" title="Effects" effects={effects} />
}
