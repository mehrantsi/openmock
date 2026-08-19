/** Time / size formatting helpers for the timeline UI. */

/** `m:ss.cc` transport timecode. */
export function fmtTimecode(t: number): string {
  const v = Math.max(0, t)
  const m = Math.floor(v / 60)
  const s = Math.floor(v % 60)
  const cc = Math.floor((v * 100) % 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`
}

/** `s.cc` ruler badge (whole seconds + centiseconds). */
export function fmtRulerBadge(t: number): string {
  const v = Math.max(0, t)
  const cc = Math.floor((v * 100) % 100)
  return `${Math.floor(v)}.${String(cc).padStart(2, '0')}`
}

/** `m:ss` for the project length field. */
export function fmtMinSec(t: number): string {
  const v = Math.max(0, Math.round(t))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}

/** Compact seconds label: `4s`, `2.5s`, `0.1s`. */
export function fmtSecondsShort(t: number): string {
  const r = Math.round(t * 10) / 10
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}s`
}

/** Parse `mm:ss(.f)` or plain seconds into seconds; null when unparseable. */
export function parseLengthInput(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const colon = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (colon) {
    const m = parseInt(colon[1], 10)
    const sec = parseFloat(colon[2])
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return null
    return m * 60 + sec
  }
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

/**
 * Split a timecode into a dimmed leading-zero prefix and the significant rest
 * (the vendor dims leading zeros at 40% opacity).
 */
export function splitLeadingZeros(code: string): { dim: string; rest: string } {
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c >= '1' && c <= '9') break
    // stop dimming at the decimal point: "0:00.42" keeps ".42" bright-ish? no —
    // dim only the "0:0"-style prefix; a '.' ends the dim region.
    if (c === '.') break
    i++
  }
  // never dim everything when the value is exactly zero-ish: keep last char bright
  if (i >= code.length) i = code.length - 1
  return { dim: code.slice(0, i), rest: code.slice(i) }
}
