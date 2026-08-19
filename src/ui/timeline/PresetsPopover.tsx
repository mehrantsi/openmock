/**
 * Camera animation preset picker: 360px popover, 2-col grid of animated
 * CSS-3D preview cards. Preview ping-pongs over 8400ms (4200 each way) with a
 * cosine ease, lerping the preset's two keyframe specs through the exact
 * vendor transform math.
 */

import { useEffect, useRef } from 'react'
import { CAMERA_ANIMATION_PRESETS, type AnimKfSpec, type CameraAnimationPreset } from '../../lib/presets/animationPresets'
import { useProject } from '../../state/project'
import { AnchoredPopover } from './menu'

const BASE_TUNING = {
  scaleK: 1.45,
  fovHalfTanMin: 0.27,
  baselineTy: 24,
  factorXNumerator: 85,
  factorYNumerator: 172,
  sizeExponent: 0.52,
}

function lerpSpec(a: AnimKfSpec, b: AnimKfSpec, u: number): AnimKfSpec {
  const l = (x: number, y: number) => x + (y - x) * u
  return {
    t: u,
    tiltX: l(a.tiltX, b.tiltX),
    tiltY: l(a.tiltY, b.tiltY),
    tiltZ: l(a.tiltZ, b.tiltZ),
    flap: l(a.flap, b.flap),
    flapX: l(a.flapX, b.flapX),
    zoom: l(a.zoom, b.zoom),
    fov: l(a.fov, b.fov),
    panX: l(a.panX, b.panX),
    panY: l(a.panY, b.panY),
  }
}

function previewTransform(preset: CameraAnimationPreset, u: number, containerH: number) {
  const tuning = { ...BASE_TUNING, ...preset.previewTuning }
  const s = lerpSpec(preset.kfSpecs[0], preset.kfSpecs[1], u)
  const j = Math.tan((s.fov * Math.PI) / 360)
  const M = Math.pow(s.zoom * Math.max(tuning.fovHalfTanMin, j), tuning.sizeExponent)
  const scale = tuning.scaleK / M
  const perspective = containerH / (2 * j)
  const tx = s.panX * (tuning.factorXNumerator / M)
  const ty = Math.min(120, Math.max(-110, tuning.baselineTy - s.panY * (tuning.factorYNumerator / M)))
  const transform = `translate(${tx}%, ${ty}%) scale(${scale}) rotateY(${s.tiltY}deg) rotateX(${-s.tiltX}deg) rotateZ(${s.tiltZ}deg) rotateY(${s.flap}deg) rotateX(${-s.flapX}deg)`
  return { transform, perspective }
}

export function PresetsPopover({
  shotId,
  anchor,
  onClose,
}: {
  shotId: string
  anchor: { x: number; y: number }
  onClose(): void
}) {
  const applyAnimationPreset = useProject((s) => s.applyAnimationPreset)
  const deviceRefs = useRef(new Map<string, HTMLDivElement>())
  const sceneRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      const cycle = (now % 8400) / 4200 // 0..2
      const p = cycle < 1 ? cycle : 2 - cycle
      const u = 0.5 - 0.5 * Math.cos(Math.PI * p)
      for (const preset of CAMERA_ANIMATION_PRESETS) {
        const device = deviceRefs.current.get(preset.id)
        const scene = sceneRefs.current.get(preset.id)
        if (!device || !scene) continue
        const h = scene.clientHeight || 96
        const { transform, perspective } = previewTransform(preset, u, h)
        scene.style.perspective = `${perspective}px`
        device.style.transform = transform
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <AnchoredPopover anchor={anchor} placement="above" onClose={onClose} width={360} className="p-2">
      <div className="grid grid-cols-2 gap-2 max-h-[420px] overflow-y-auto">
        {CAMERA_ANIMATION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="group rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04] hover:border-[#FD631F]/60 overflow-hidden text-left"
            onClick={() => {
              applyAnimationPreset(shotId, preset.id)
              onClose()
            }}
          >
            <div
              ref={(el) => {
                if (el) sceneRefs.current.set(preset.id, el)
              }}
              className="relative h-[96px] overflow-hidden bg-gradient-to-b from-zinc-100 to-zinc-200 dark:from-zinc-900 dark:to-zinc-950"
              style={{ perspective: 400 }}
            >
              <div
                ref={(el) => {
                  if (el) deviceRefs.current.set(preset.id, el)
                }}
                className="absolute left-1/2 top-1/2 -ml-[22px] -mt-[46px] w-[44px] h-[92px] rounded-[10px] border border-black/25 dark:border-white/25 bg-gradient-to-br from-[#3b3b40] to-[#131316] shadow-lg"
                style={{ transformStyle: 'preserve-3d', willChange: 'transform' }}
              >
                <div className="absolute inset-[3px] rounded-[7px] bg-gradient-to-br from-[#FD631F]/70 via-[#7a4dff]/50 to-[#18c5d8]/60" />
              </div>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[10.5px] font-medium text-black/70 dark:text-white/70">
                {preset.label}
              </span>
              <span className="text-[10px] font-mono text-black/40 dark:text-white/40">
                {preset.defaultDuration ?? 5}s
              </span>
            </div>
          </button>
        ))}
      </div>
    </AnchoredPopover>
  )
}
