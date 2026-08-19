import type { BlurMode, RenderState } from '../../state/types'
import { FolderSection } from '../controls/FolderSection'
import { Select } from '../controls/Select'
import { DialSlider } from '../controls/DialSlider'
import { ToggleRow } from '../controls/ToggleRow'
import { LightPad } from '../controls/LightPad'
import { ActionButton } from '../controls/ActionButton'
import { KfRow } from './KfRow'
import { commitDials, useDials } from './dialHelpers'

/** Blur defaults used by Reset Blur and mode-switch seeding. */
const BLUR_DEFAULTS: Partial<RenderState> = {
  blurMode: 'none',
  blurStrength: 0,
  focusX: 0.37,
  focusY: 0.5,
  focusSize: 0.5,
  blurAngle: 0,
  dirPosition: 0.5,
  blurFalloff: 0,
  blurBokeh: false,
}

export function BlurSection() {
  const dials = useDials()
  const mode = dials.blurMode
  const strengthMax = dials.blurBokeh ? 20 : 60

  const setMode = (next: BlurMode) => {
    const patch: Partial<RenderState> = { blurMode: next }
    // per-mode parameter seeds
    if (next === 'tilt-shift') Object.assign(patch, { focusSize: 0.1, focusY: 0.5, blurAngle: 45 })
    else if (next === 'radial') Object.assign(patch, { focusX: 0.37, focusY: 0.5, focusSize: 0.5 })
    else if (next === 'directional') Object.assign(patch, { dirPosition: 0.5, blurAngle: 0 })
    // give a fresh mode something visible
    if (next !== 'none' && dials.blurStrength === 0) patch.blurStrength = Math.min(30, strengthMax)
    commitDials(patch)
  }

  const setBokeh = (on: boolean) => {
    const patch: Partial<RenderState> = { blurBokeh: on }
    if (on && dials.blurStrength > 20) patch.blurStrength = 20
    commitDials(patch)
  }

  return (
    <FolderSection
      folderKey="blur"
      title="Blur"
      dirty={mode !== 'none'}
      onReset={() => commitDials({ ...BLUR_DEFAULTS })}
    >
      <Select<BlurMode>
        label="Mode"
        value={mode}
        options={[
          { value: 'none', label: 'None' },
          { value: 'radial', label: 'Radial' },
          { value: 'directional', label: 'Directional' },
          { value: 'tilt-shift', label: 'Tilt Shift' },
        ]}
        onChange={setMode}
      />

      {mode !== 'none' && (
        <>
          <KfRow prop="blurStrength">
            <DialSlider
              label="Strength"
              value={Math.min(dials.blurStrength, strengthMax)}
              min={0}
              max={strengthMax}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ blurStrength: v })}
            />
          </KfRow>

          {mode === 'radial' && (
            <KfRow prop="focusSize">
              <DialSlider
                label="Focus Size"
                value={dials.focusSize}
                min={0}
                max={1}
                step={0.01}
                defaultValue={0.5}
                onChange={(v) => commitDials({ focusSize: v })}
              />
            </KfRow>
          )}

          {mode === 'directional' && (
            <>
              <KfRow prop="blurAngle">
                <DialSlider
                  label="Angle"
                  value={dials.blurAngle}
                  min={0}
                  max={360}
                  step={1}
                  defaultValue={0}
                  onChange={(v) => commitDials({ blurAngle: v })}
                />
              </KfRow>
              <KfRow prop="dirPosition">
                <DialSlider
                  label="Position"
                  value={dials.dirPosition}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.5}
                  onChange={(v) => commitDials({ dirPosition: v })}
                />
              </KfRow>
            </>
          )}

          {mode === 'tilt-shift' && (
            <>
              <KfRow prop="blurAngle">
                <DialSlider
                  label="Angle"
                  value={dials.blurAngle}
                  min={0}
                  max={180}
                  step={1}
                  defaultValue={45}
                  onChange={(v) => commitDials({ blurAngle: v })}
                />
              </KfRow>
              <KfRow prop="focusSize">
                <DialSlider
                  label="Focus Size"
                  value={dials.focusSize}
                  min={0}
                  max={0.6}
                  step={0.01}
                  defaultValue={0.1}
                  onChange={(v) => commitDials({ focusSize: v })}
                />
              </KfRow>
              <KfRow prop="focusY">
                <DialSlider
                  label="Scan"
                  value={dials.focusY}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.5}
                  onChange={(v) => commitDials({ focusY: v })}
                />
              </KfRow>
            </>
          )}

          <KfRow prop="blurFalloff">
            <DialSlider
              label="Falloff"
              value={dials.blurFalloff}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => commitDials({ blurFalloff: v })}
            />
          </KfRow>

          <ToggleRow label="Bokeh" checked={dials.blurBokeh} onChange={setBokeh} />

          {mode === 'radial' && (
            <KfRow prop={['focusX', 'focusY']}>
              <LightPad
                label="Focus Position"
                x={dials.focusX}
                y={dials.focusY}
                min={0}
                max={1}
                step={0.01}
                invertY // focus is in UV space: y = 1 is the TOP of the frame
                onChange={(x, y) => commitDials({ focusX: x, focusY: y })}
              />
            </KfRow>
          )}

          <ActionButton label="Reset Blur" onClick={() => commitDials({ ...BLUR_DEFAULTS })} />
        </>
      )}
    </FolderSection>
  )
}
