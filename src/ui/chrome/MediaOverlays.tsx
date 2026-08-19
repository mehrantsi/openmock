/**
 * Full-window drag & drop overlays.
 *
 * - No media in the project yet: one big "Add media" zone spanning the
 *   viewport + timeline.
 * - Media exists: a "Replace media" (or "Add/Replace logo") zone over the
 *   viewport and an "Add new shot" zone over the timeline.
 */

import { useEffect, useState } from 'react'
import { useIngestStore, ingestFiles, projectHasMedia, selectedShot, type IngestTarget } from '../useMediaIngest'
import { useProject } from '../../state/project'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

function measure(selector: string): Rect | null {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function union(a: Rect, b: Rect | null): Rect {
  if (!b) return a
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  const right = Math.max(a.left + a.width, b.left + b.width)
  const bottom = Math.max(a.top + a.height, b.top + b.height)
  return { left, top, width: right - left, height: bottom - top }
}

function DropZone({
  rect,
  title,
  subtitle,
  mode,
}: {
  rect: Rect
  title: string
  subtitle: string
  mode: IngestTarget
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      className="fixed z-[10000]"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setHover(false)
        useIngestStore.getState().setDragActive(false)
        const files = e.dataTransfer?.files ? [...e.dataTransfer.files] : []
        void ingestFiles(files, mode)
      }}
    >
      <div
        className={`absolute inset-2 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-colors backdrop-blur-[2px] ${
          hover
            ? 'border-[#FD631F] bg-[#FD631F]/10'
            : 'border-black/30 dark:border-white/30 bg-white/40 dark:bg-black/40'
        }`}
      >
        <div
          className={`text-[13px] font-semibold uppercase tracking-[0.06em] ${
            hover ? 'text-[#FD631F]' : 'text-black/80 dark:text-white/85'
          }`}
        >
          {title}
        </div>
        <div className="text-[10px] font-medium text-black/50 dark:text-white/45">
          {subtitle}
        </div>
      </div>
    </div>
  )
}

export function MediaOverlays() {
  const dragActive = useIngestStore((s) => s.dragActive)
  // re-render on shot selection so the logo/replace label is current
  useProject((s) => s.selectedSceneId)
  const [rects, setRects] = useState<{ viewport: Rect | null; timeline: Rect | null }>({
    viewport: null,
    timeline: null,
  })

  useEffect(() => {
    if (!dragActive) return
    const update = () =>
      setRects({ viewport: measure('[data-viewport-area]'), timeline: measure('[data-timeline-area]') })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [dragActive])

  if (!dragActive || !rects.viewport) return null

  if (!projectHasMedia()) {
    return (
      <DropZone
        rect={union(rects.viewport, rects.timeline)}
        title="Add media"
        subtitle="Drop media to add to project"
        mode="replace"
      />
    )
  }

  const sel = selectedShot()
  const isLogo = sel?.kind === 'logo'
  const hasLogo = !!(sel?.logo?.imageUrl || sel?.logo?.svgSource)
  const viewportTitle = isLogo ? (hasLogo ? 'Replace logo' : 'Add logo') : 'Replace media'
  const viewportSub = isLogo
    ? hasLogo
      ? "Drop here to replace this shot's logo"
      : "Drop here to add this shot's logo"
    : 'Drop here to replace the media in the selected shot'

  return (
    <>
      <DropZone rect={rects.viewport} title={viewportTitle} subtitle={viewportSub} mode="replace" />
      {rects.timeline && (
        <DropZone
          rect={rects.timeline}
          title="Add new shot"
          subtitle="Drop the media here to add a new shot with this media"
          mode="new-shot"
        />
      )}
    </>
  )
}
