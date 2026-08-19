import { useState } from 'react'
import { CAMERA_POSITION_PRESETS, CAMERA_RESET } from '../../lib/presets/cameraPresets'
import { FolderSection } from '../controls/FolderSection'
import { DialSlider } from '../controls/DialSlider'
import { ActionButton } from '../controls/ActionButton'
import { Segmented } from '../controls/Segmented'
import { KfRow } from './KfRow'
import { commitDials, useDials } from './dialHelpers'

type Tab = 'manual' | 'presets'

export function CameraSection() {
  const dials = useDials()
  const [tab, setTab] = useState<Tab>('manual')
  const modelActive = !!dials.mockupModel

  const tiltXRange = modelActive ? 180 : 70
  const tiltYRange = modelActive ? 180 : 60

  const cameraDirty =
    dials.tiltX !== CAMERA_RESET.tiltX ||
    dials.tiltY !== CAMERA_RESET.tiltY ||
    dials.tiltZ !== CAMERA_RESET.tiltZ ||
    dials.flap !== CAMERA_RESET.flap ||
    dials.flapX !== CAMERA_RESET.flapX ||
    dials.fov !== CAMERA_RESET.fov ||
    dials.zoom !== CAMERA_RESET.zoom ||
    dials.panX !== CAMERA_RESET.panX ||
    dials.panY !== CAMERA_RESET.panY

  const resetCamera = () => commitDials({ ...CAMERA_RESET })

  return (
    <FolderSection folderKey="camera" title="Camera" dirty={cameraDirty} onReset={resetCamera}>
      <Segmented<Tab>
        value={tab}
        options={[
          { value: 'manual', label: 'Manual' },
          { value: 'presets', label: 'Presets' },
        ]}
        onChange={setTab}
      />

      {tab === 'manual' ? (
        <>
          <KfRow prop="tiltX">
            <DialSlider
              label="Tilt X"
              hint="Drag"
              value={dials.tiltX}
              min={-tiltXRange}
              max={tiltXRange}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ tiltX: v })}
            />
          </KfRow>
          <KfRow prop="tiltY">
            <DialSlider
              label="Tilt Y"
              hint="Drag"
              value={dials.tiltY}
              min={-tiltYRange}
              max={tiltYRange}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ tiltY: v })}
            />
          </KfRow>
          <KfRow prop="tiltZ">
            <DialSlider
              label="Roll"
              value={dials.tiltZ}
              min={-180}
              max={180}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ tiltZ: v })}
            />
          </KfRow>
          <KfRow prop="fov">
            <DialSlider
              label="FOV"
              value={dials.fov}
              min={10}
              max={100}
              step={1}
              defaultValue={45}
              onChange={(v) => commitDials({ fov: v })}
            />
          </KfRow>
          <KfRow prop="zoom">
            <DialSlider
              label="Zoom"
              hint="Scroll"
              value={dials.zoom}
              min={0.5}
              max={10}
              step={0.05}
              defaultValue={2}
              onChange={(v) => commitDials({ zoom: v })}
            />
          </KfRow>
          <KfRow prop="panX">
            <DialSlider
              label="Pan X"
              hint="Space Drag"
              value={dials.panX}
              min={-3}
              max={3}
              step={0.01}
              defaultValue={0}
              onChange={(v) => commitDials({ panX: v })}
            />
          </KfRow>
          <KfRow prop="panY">
            <DialSlider
              label="Pan Y"
              hint="Space Drag"
              value={dials.panY}
              min={-3}
              max={3}
              step={0.01}
              defaultValue={0}
              onChange={(v) => commitDials({ panY: v })}
            />
          </KfRow>
          <KfRow prop="flap">
            <DialSlider
              label="Rotate Y"
              value={dials.flap}
              min={-50}
              max={50}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ flap: v })}
            />
          </KfRow>
          <KfRow prop="flapX">
            <DialSlider
              label="Rotate X"
              value={dials.flapX}
              min={-90}
              max={90}
              step={1}
              defaultValue={0}
              onChange={(v) => commitDials({ flapX: v })}
            />
          </KfRow>
          <ActionButton label="Reset Camera" onClick={resetCamera} disabled={!cameraDirty} />
        </>
      ) : (
        <div className="grid grid-cols-2 gap-1">
          {CAMERA_POSITION_PRESETS.map((p) => (
            <ActionButton
              key={p.name}
              label={p.name}
              onClick={() =>
                // presets apply tiltX/tiltY/roll/fov/zoom/panX/panY only
                commitDials({
                  tiltX: p.vals.tiltX,
                  tiltY: p.vals.tiltY,
                  tiltZ: p.vals.tiltZ,
                  zoom: p.vals.zoom,
                  panX: p.vals.panX,
                  panY: p.vals.panY,
                  fov: p.vals.fov,
                })
              }
            />
          ))}
        </div>
      )}
    </FolderSection>
  )
}
