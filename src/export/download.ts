/**
 * Blob download helpers + export filename builders.
 *
 * Image:  openmock-<ISO timestamp, ':'/'.' -> '-'>.<jpg|png|webp>
 * Video:  openmock-timeline-<ratio|16-9>-<dur>s-<ISO timestamp>.mp4
 *         (duration is an integer, or one decimal with '.' -> '-')
 */

export function isoStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function imageFilename(format: 'jpeg' | 'png' | 'webp'): string {
  const ext = format === 'jpeg' ? 'jpg' : format
  return `openmock-${isoStamp()}.${ext}`
}

/**
 * Video filename. `viewportRatio` is the viewport ratio key ('fill', '16:9',
 * 'appstore-iphone', …); free-aspect modes fall back to '16-9'.
 */
export function videoFilename(viewportRatio: string, durationSec: number): string {
  const d = Number.isInteger(durationSec)
    ? `${durationSec}`
    : durationSec.toFixed(1).replace('.', '-')
  const ratio =
    viewportRatio === 'fill' || viewportRatio === 'flexible' || !viewportRatio
      ? '16-9'
      : viewportRatio.replace(':', '-')
  return `openmock-timeline-${ratio}-${d}s-${isoStamp()}.mp4`
}

/** Trigger a browser download for a blob (object URL revoked after 1s). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
