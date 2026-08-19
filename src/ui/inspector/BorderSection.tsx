import type { BorderStyle } from '../../state/types'
import { FolderSection } from '../controls/FolderSection'
import { Select } from '../controls/Select'
import { DialSlider } from '../controls/DialSlider'
import { commitDials, useDials } from './dialHelpers'

export function BorderSection() {
  const dials = useDials()
  const modelActive = !!dials.mockupModel

  const dirty = dials.borderRadius !== 0.02 || dials.borderStyle !== 'none' || dials.glassWidth !== 3

  return (
    <FolderSection
      folderKey="border"
      title="Border"
      dirty={dirty}
      onReset={() => commitDials({ borderRadius: 0.02, borderStyle: 'none', glassWidth: 3 })}
    >
      <DialSlider
        label="Border Radius"
        value={dials.borderRadius}
        min={0}
        max={0.08}
        step={0.002}
        precision={3}
        defaultValue={0.02}
        onChange={(v) => commitDials({ borderRadius: v })}
      />
      <Select<BorderStyle>
        label="Style"
        value={dials.borderStyle}
        options={[
          { value: 'none', label: 'None' },
          { value: 'glass', label: 'Glass' },
        ]}
        disabled={modelActive}
        disabledReason="Turn off 3D model to use"
        onChange={(v) => commitDials({ borderStyle: v })}
      />
      {dials.borderStyle === 'glass' && (
        <DialSlider
          label="Glass Width"
          value={dials.glassWidth}
          min={0}
          max={10}
          step={1}
          defaultValue={3}
          onChange={(v) => commitDials({ glassWidth: v })}
        />
      )}
    </FolderSection>
  )
}
