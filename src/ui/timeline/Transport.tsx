/**
 * Transport row (grid 1fr auto 1fr, min-h 50px):
 *  left  — Presets / Select all / Delete keyframe / Edit easing
 *  center— Record (or Add keyframe in simple mode), timecode, project length,
 *          back-to-start, play/pause, loop
 *  right — Download last export, Add track, center guides, zoom slider, minimize
 * Plus the minimized single-row transport.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BoxSelect,
  ChevronsDown,
  ChevronsUp,
  Clapperboard,
  Crosshair,
  Download,
  Pause,
  Play,
  Plus,
  Repeat,
  SkipBack,
  Spline,
  Timer,
  Trash2,
} from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { totalDuration } from '../../video/timelineOps'
import { toggleRecording } from '../../video/recorder'
import { toast } from '../toast'
import { useTimelineUI } from './context'
import { anchorOf } from './menu'
import { AddTrackMenu } from './AddTrackMenu'
import { PresetsPopover } from './PresetsPopover'
import { fmtBytes, fmtMinSec, fmtTimecode, parseLengthInput, splitLeadingZeros } from './format'
import { KEY_CENTER_GUIDES, KEY_RECORD_GUIDE, readFlag, writeString } from './persist'
import { deleteKfSelection, selectAllShotKfs, selectionSegments, stampChangedProps } from './kfOps'
import { RecordGuideModal } from './RecordModal'

// ---------------------------------------------------------------------------

function TBtn({
  onClick,
  title,
  disabled,
  active,
  children,
  label,
  ariaLabel,
}: {
  onClick?(e: React.MouseEvent<HTMLButtonElement>): void
  title?: string
  disabled?: boolean
  active?: boolean
  children: ReactNode
  label?: string
  ariaLabel?: string
}) {
  return (
    <button
      title={title}
      aria-label={ariaLabel ?? title}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 min-w-7 px-1.5 rounded-md flex items-center justify-center gap-1.5 text-[11px] font-medium transition-colors ${
        active
          ? 'bg-[#FD631F]/[0.12] text-[#FD631F]'
          : 'text-black/55 dark:text-white/55 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black/80 dark:hover:text-white/85'
      } disabled:opacity-35 disabled:pointer-events-none`}
    >
      {children}
      {label && <span>{label}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Time display (dim leading zeros, rAF-smooth while playing)
// ---------------------------------------------------------------------------

function Digits({ code }: { code: string }) {
  const { dim, rest } = splitLeadingZeros(code)
  return (
    <>
      <span className="opacity-40">{dim}</span>
      {rest}
    </>
  )
}

export function TimeDisplay() {
  const ui = useTimelineUI()
  const projectTime = usePlayback((s) => s.projectTime)
  const phase = usePlayback((s) => s.phase)
  const scenes = useProject((s) => s.scenes)
  const curRef = useRef<HTMLSpanElement>(null)
  const total = totalDuration(scenes)

  useEffect(() => {
    if (phase !== 'playing') return
    let raf = 0
    const tick = () => {
      if (curRef.current) curRef.current.textContent = fmtTimecode(ui.engine.getTime())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, ui.engine])

  return (
    <span className="font-mono text-[11px] tabular-nums text-black/75 dark:text-white/80 whitespace-nowrap select-none">
      {phase === 'playing' ? (
        <span ref={curRef}>{fmtTimecode(ui.engine.getTime())}</span>
      ) : (
        <Digits code={fmtTimecode(projectTime)} />
      )}
      <span className="opacity-40"> / </span>
      <Digits code={fmtTimecode(total)} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Project length field
// ---------------------------------------------------------------------------

function ProjectLengthField() {
  const sequenceDuration = useProject((s) => s.sequenceDuration)
  const setSequenceDuration = useProject((s) => s.setSequenceDuration)
  const scenes = useProject((s) => s.scenes)
  const [raw, setRaw] = useState(fmtMinSec(sequenceDuration))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setRaw(fmtMinSec(sequenceDuration))
  }, [sequenceDuration, editing])

  const commit = () => {
    setEditing(false)
    const v = parseLengthInput(raw)
    if (v === null) {
      setRaw(fmtMinSec(sequenceDuration))
      return
    }
    const min = Math.ceil(totalDuration(scenes))
    const rounded = Math.round(v)
    if (rounded < min) toast(`Your video can’t be shorter than its shots (${min}s minimum).`)
    const clamped = Math.min(180, Math.max(min, rounded))
    setSequenceDuration(clamped)
    setRaw(fmtMinSec(clamped))
  }

  return (
    <label
      title="Project length"
      className="h-7 px-1.5 rounded-md flex items-center gap-1 bg-black/[0.04] dark:bg-white/[0.06] focus-within:ring-1 focus-within:ring-[#FD631F]/60"
    >
      <Timer className="size-3.5 text-black/40 dark:text-white/40" />
      <input
        aria-label="Project length (minutes:seconds)"
        className="w-9 bg-transparent outline-none text-[11px] font-mono text-black/75 dark:text-white/80"
        value={raw}
        onFocus={() => setEditing(true)}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setRaw(fmtMinSec(sequenceDuration))
            setEditing(false)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Record button
// ---------------------------------------------------------------------------

export function RecordButton() {
  const ui = useTimelineUI()
  const recording = usePlayback((s) => s.recording)
  const [guide, setGuide] = useState(false)
  const [shaking, setShaking] = useState(false)
  const lastShake = useRef(0)

  // shake on blocked-playback attempts
  const recShake = ui.recShake
  useEffect(() => {
    if (recShake === lastShake.current) return
    lastShake.current = recShake
    if (recShake === 0) return
    setShaking(true)
    const h = setTimeout(() => setShaking(false), 640)
    return () => clearTimeout(h)
  }, [recShake])

  const click = () => {
    if (!recording && !readFlag(KEY_RECORD_GUIDE)) {
      setGuide(true)
      return
    }
    // playback is blocked while recording — pause before arming
    if (!recording && usePlayback.getState().phase === 'playing') ui.engine.pause()
    toggleRecording()
  }

  return (
    <>
      <button
        title={
          recording
            ? 'Recording — camera & blur edits stamp keyframes'
            : 'Auto-keyframe — record camera & blur edits as keyframes'
        }
        aria-label={recording ? 'Recording — click to stop auto-keyframe' : 'Enable auto-keyframe recording'}
        onClick={click}
        className={`h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold transition-colors ${
          recording
            ? 'bg-[#FD631F]/[0.12] text-[#FD631F]'
            : 'text-black/60 dark:text-white/60 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
        } ${shaking ? 'om-rec-attention' : ''}`}
      >
        <span className={`size-2 rounded-full bg-[#FD631F] ${recording ? 'animate-pulse' : ''}`} />
        Record
      </button>
      {guide && <RecordGuideModal onClose={() => setGuide(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Export output listener
// ---------------------------------------------------------------------------

interface ExportOutput {
  url: string
  filename?: string
  byteSize?: number
}

function useExportOutput(): ExportOutput | null {
  const [output, setOutput] = useState<ExportOutput | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ExportOutput | null
      setOutput(detail && detail.url ? detail : null)
    }
    window.addEventListener('openmock:export-output', handler)
    return () => window.removeEventListener('openmock:export-output', handler)
  }, [])
  return output
}

// ---------------------------------------------------------------------------
// Transport row
// ---------------------------------------------------------------------------

export function Transport({ exportSlot }: { exportSlot?: ReactNode }) {
  const ui = useTimelineUI()
  const phase = usePlayback((s) => s.phase)
  const loop = usePlayback((s) => s.loop)
  const setLoop = usePlayback((s) => s.setLoop)
  const recording = usePlayback((s) => s.recording)
  const selectedKfIds = usePlayback((s) => s.selectedKfIds)
  const setMinimized = usePlayback((s) => s.setTimelineMinimized)
  const selectedSceneId = useProject((s) => s.selectedSceneId)
  const scenes = useProject((s) => s.scenes)
  const shot = scenes.find((s) => s.id === selectedSceneId) ?? null

  const [presets, setPresets] = useState<{ x: number; y: number } | null>(null)
  const [addTrack, setAddTrack] = useState<{ x: number; y: number } | null>(null)
  const [guides, setGuides] = useState(() => readFlag(KEY_CENTER_GUIDES))
  const output = useExportOutput()

  const easingState = (() => {
    if (!shot) return { disabled: true, title: 'Select a keyframe to start easing' }
    if (shot.keyframes.length < 2) return { disabled: true, title: 'Add at least 2 keyframes to edit easing' }
    if (selectedKfIds.length === 0) return { disabled: true, title: 'Select a keyframe to start easing' }
    if (selectionSegments(shot, selectedKfIds).length === 0)
      return { disabled: true, title: 'Add one more keyframe to edit easing' }
    return { disabled: false, title: 'Edit easing for selected keyframe' }
  })()

  const playPause = () => {
    if (recording) {
      toast('Can’t play whilst recording keyframes — stop recording first.', 'info', 2600)
      ui.shakeRec()
      return
    }
    ui.engine.toggle()
  }

  const toggleGuides = () => {
    const next = !guides
    setGuides(next)
    writeString(KEY_CENTER_GUIDES, next ? '1' : '0')
    window.dispatchEvent(new CustomEvent('openmock:center-guides', { detail: next }))
  }

  const download = () => {
    if (!output) return
    const a = document.createElement('a')
    a.href = output.url
    a.download = output.filename ?? 'openmock-export.mp4'
    a.click()
  }

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center min-h-[50px] px-2 gap-2 border-b border-black/[0.07] dark:border-white/[0.07]">
      {/* left */}
      <div className="flex items-center gap-1 min-w-0">
        {shot && !shot.kind && (
          <TBtn
            title="Camera animation presets"
            label="Presets"
            onClick={(e) => setPresets(anchorOf(e.currentTarget))}
          >
            <Clapperboard className="size-3.5" />
          </TBtn>
        )}
        <TBtn title="Select all keyframes on the active shot" onClick={() => selectAllShotKfs()} disabled={!shot || shot.keyframes.length === 0}>
          <BoxSelect className="size-3.5" />
        </TBtn>
        <TBtn title="Delete keyframe" disabled={selectedKfIds.length === 0} onClick={() => deleteKfSelection()}>
          <Trash2 className="size-3.5" />
        </TBtn>
        <TBtn
          title={easingState.title}
          disabled={easingState.disabled}
          onClick={(e) => {
            if (!shot) return
            ui.openEasing({ shotId: shot.id, forSelection: true, anchor: anchorOf(e.currentTarget) })
          }}
        >
          <Spline className="size-3.5" />
        </TBtn>
      </div>

      {/* center */}
      <div className="flex items-center gap-2">
        {ui.simple ? (
          <button
            title="Add keyframe (K) — records the properties you changed"
            className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold bg-[#FD631F] hover:bg-[#E5581B] text-white"
            onClick={() => stampChangedProps(ui.engine)}
          >
            <span className="size-[7px] rotate-45 bg-white" />
            Add keyframe
          </button>
        ) : (
          <RecordButton />
        )}
        <TimeDisplay />
        <ProjectLengthField />
        <TBtn title="Back to start" onClick={() => ui.engine.scrubTo(0)}>
          <SkipBack className="size-3.5" />
        </TBtn>
        <button
          title={phase === 'playing' ? 'Pause (Space)' : recording ? 'Stop recording to play' : 'Play (Space)'}
          onClick={playPause}
          className="size-8 rounded-full flex items-center justify-center bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90 transition-opacity shrink-0"
        >
          {phase === 'playing' ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-[1px]" />}
        </button>
        <TBtn title={loop ? 'Disable loop' : 'Enable loop'} active={loop} onClick={() => setLoop(!loop)}>
          <Repeat className="size-3.5" />
        </TBtn>
      </div>

      {/* right */}
      <div className="flex items-center gap-1 justify-end min-w-0">
        {exportSlot}
        {output && (
          <TBtn title="Download last export" onClick={download} label={output.byteSize ? fmtBytes(output.byteSize) : undefined}>
            <Download className="size-3.5" />
          </TBtn>
        )}
        <TBtn title="Add track" label="Add track" onClick={(e) => setAddTrack(anchorOf(e.currentTarget))}>
          <Plus className="size-3.5" />
        </TBtn>
        <TBtn title={guides ? 'Hide center guides' : 'Show center guides'} active={guides} onClick={toggleGuides}>
          <Crosshair className="size-3.5" />
        </TBtn>
        <input
          type="range"
          min={1}
          max={8}
          step={0.25}
          value={ui.zoom}
          title={`Zoom ${ui.zoom.toFixed(2)}× around the playhead — double-click to reset · ⌘+scroll also zooms`}
          className="w-24 accent-[#FD631F]"
          onChange={(e) => ui.setZoomAnchored(parseFloat(e.target.value))}
          onDoubleClick={() => ui.setZoomAnchored(1)}
        />
        <TBtn title="Minimize timeline" ariaLabel="Minimize timeline" onClick={() => setMinimized(true)}>
          <ChevronsDown className="size-3.5" />
        </TBtn>
      </div>

      {presets && shot && <PresetsPopover shotId={shot.id} anchor={presets} onClose={() => setPresets(null)} />}
      {addTrack && <AddTrackMenu anchor={addTrack} onClose={() => setAddTrack(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Minimized transport (single 40px row)
// ---------------------------------------------------------------------------

export function MiniTransport() {
  const ui = useTimelineUI()
  const phase = usePlayback((s) => s.phase)
  const loop = usePlayback((s) => s.loop)
  const setLoop = usePlayback((s) => s.setLoop)
  const recording = usePlayback((s) => s.recording)
  const setMinimized = usePlayback((s) => s.setTimelineMinimized)
  const projectTime = usePlayback((s) => s.projectTime)
  const scenes = useProject((s) => s.scenes)
  const total = Math.max(totalDuration(scenes), 1e-6)
  const barRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)

  // smooth fill while playing
  useEffect(() => {
    const apply = (t: number) => {
      const pct = Math.min(100, Math.max(0, (t / total) * 100))
      if (fillRef.current) fillRef.current.style.width = `${pct}%`
      if (thumbRef.current) thumbRef.current.style.left = `${pct}%`
    }
    apply(ui.engine.getTime())
    if (phase !== 'playing') return
    let raf = 0
    const tick = () => {
      apply(ui.engine.getTime())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, total, ui.engine, projectTime])

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = barRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    const toT = (clientX: number) => {
      const r = el.getBoundingClientRect()
      return Math.min(total, Math.max(0, ((clientX - r.left) / r.width) * total))
    }
    ui.engine.scrubPreview(toT(e.clientX))
    const move = (ev: PointerEvent) => ui.engine.scrubPreview(toT(ev.clientX))
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      ui.engine.scrubTo(toT(ev.clientX))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="h-10 flex items-center gap-2 px-2.5">
      <TimeDisplay />
      <TBtn title="Back to start" onClick={() => ui.engine.scrubTo(0)}>
        <SkipBack className="size-3.5" />
      </TBtn>
      <TBtn
        title={phase === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => {
          if (recording) {
            toast('Can’t play whilst recording keyframes — stop recording first.', 'info', 2600)
            return
          }
          ui.engine.toggle()
        }}
      >
        {phase === 'playing' ? <Pause className="size-4" /> : <Play className="size-4" />}
      </TBtn>
      <TBtn title={loop ? 'Disable loop' : 'Enable loop'} active={loop} onClick={() => setLoop(!loop)}>
        <Repeat className="size-3.5" />
      </TBtn>
      <div ref={barRef} className="relative flex-1 h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] cursor-pointer touch-none" onPointerDown={scrub}>
        <div ref={fillRef} className="absolute left-0 top-0 bottom-0 rounded-full bg-[#FD631F]" style={{ width: 0 }} />
        <div
          ref={thumbRef}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-[10px] rounded-full bg-white border border-black/20 shadow"
          style={{ left: 0 }}
        />
      </div>
      <TBtn title="Maximize timeline" ariaLabel="Maximize timeline" onClick={() => setMinimized(false)}>
        <ChevronsUp className="size-3.5" />
      </TBtn>
    </div>
  )
}
