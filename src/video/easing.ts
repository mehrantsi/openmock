/**
 * Cubic-bezier easing engine for keyframe segments.
 * A segment between keyframes A -> B eases with bezier P1 = A.outEasing ?? [.65,0],
 * P2 = B.inEasing ?? [.35,1] (the "cubic inOut" default).
 */

import type { BezierHandle, Keyframe } from '../state/types'

export interface SegmentBezier {
  p1: BezierHandle
  p2: BezierHandle
}

export const DEFAULT_OUT: BezierHandle = [0.65, 0]
export const DEFAULT_IN: BezierHandle = [0.35, 1]
/** Handles assigned to newly created keyframes (linear). */
export const NEW_KF_OUT: BezierHandle = [0, 0]
export const NEW_KF_IN: BezierHandle = [1, 1]

export const EASING_CURVES: Record<string, { in: number[]; out: number[]; inOut: number[] }> = {
  linear: { in: [0, 0, 1, 1], out: [0, 0, 1, 1], inOut: [0, 0, 1, 1] },
  quadratic: { in: [0.11, 0, 0.5, 0], out: [0.5, 1, 0.89, 1], inOut: [0.45, 0, 0.55, 1] },
  cubic: { in: [0.32, 0, 0.67, 0], out: [0.33, 1, 0.68, 1], inOut: [0.65, 0, 0.35, 1] },
  quartic: { in: [0.5, 0, 0.75, 0], out: [0.25, 1, 0.5, 1], inOut: [0.76, 0, 0.24, 1] },
  quintic: { in: [0.64, 0, 0.78, 0], out: [0.22, 1, 0.36, 1], inOut: [0.83, 0, 0.17, 1] },
  sine: { in: [0.12, 0, 0.39, 0], out: [0.61, 1, 0.88, 1], inOut: [0.37, 0, 0.63, 1] },
  exponential: { in: [0.7, 0, 0.84, 0], out: [0.16, 1, 0.3, 1], inOut: [0.87, 0, 0.13, 1] },
  circ: { in: [0.55, 0, 1, 0.45], out: [0, 0.55, 0.45, 1], inOut: [0.85, 0, 0.15, 1] },
}

export const EASING_PICKER_ORDER = ['linear', 'quadratic', 'cubic', 'quartic', 'quintic', 'sine', 'exponential', 'circ']
export const EASING_PICKER_LABELS: Record<string, string> = {
  linear: 'linear',
  quadratic: 'quad',
  cubic: 'cubic',
  quartic: 'quart',
  quintic: 'quint',
  sine: 'sine',
  exponential: 'expo',
  circ: 'circ',
}

export function segmentBezier(a: Keyframe, b: Keyframe): SegmentBezier {
  return { p1: a.outEasing ?? DEFAULT_OUT, p2: b.inEasing ?? DEFAULT_IN }
}

function bezierAxis(t: number, a: number, b: number): number {
  // cubic bezier with endpoints 0 and 1: 3(1-t)^2 t a + 3(1-t) t^2 b + t^3
  const mt = 1 - t
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t
}

/** Evaluate bezier y for a given x using Newton-Raphson with bisection fallback. */
export function evalBezier(bz: SegmentBezier, x: number): number {
  const [p1x, p1y] = bz.p1
  const [p2x, p2y] = bz.p2
  // identity fast-path (linear handles)
  if (p1x === p1y && p2x === p2y && p1x === 0 && p2x === 1) return x
  if (x <= 0) return 0
  if (x >= 1) return 1

  let u = x
  for (let i = 0; i < 8; i++) {
    const cx = bezierAxis(u, p1x, p2x) - x
    if (Math.abs(cx) < 1e-5) return bezierAxis(u, p1y, p2y)
    // derivative of bezier x wrt u
    const mt = 1 - u
    const d = 3 * mt * mt * p1x + 6 * mt * u * (p2x - p1x) + 3 * u * u * (1 - p2x)
    if (Math.abs(d) < 1e-6) break
    u -= cx / d
    u = Math.min(1, Math.max(0, u))
  }
  // bisection fallback
  let lo = 0
  let hi = 1
  u = x
  for (let i = 0; i < 30; i++) {
    const cx = bezierAxis(u, p1x, p2x)
    if (Math.abs(cx - x) < 1e-5) break
    if (cx < x) lo = u
    else hi = u
    u = (lo + hi) / 2
  }
  return bezierAxis(u, p1y, p2y)
}

/**
 * Split a segment bezier at parameter x (de Casteljau on the found u), returning
 * renormalized left/right halves. Edge guard: near-degenerate splits return the
 * default curve for both halves.
 */
export function splitBezier(bz: SegmentBezier, x: number): { left: SegmentBezier; right: SegmentBezier } {
  const def: SegmentBezier = { p1: DEFAULT_OUT, p2: DEFAULT_IN }
  if (x <= 0.001 || x >= 0.999) return { left: def, right: def }
  const [p1x, p1y] = bz.p1
  const [p2x, p2y] = bz.p2
  // find u such that bezierX(u) = x (bisection, 60 iters)
  let lo = 0
  let hi = 1
  let u = x
  for (let i = 0; i < 60; i++) {
    const cx = bezierAxis(u, p1x, p2x)
    if (cx < x) lo = u
    else hi = u
    u = (lo + hi) / 2
  }
  // de Casteljau subdivision of control points P0(0,0) C1(p1) C2(p2) P3(1,1)
  const P0 = [0, 0]
  const C1 = [p1x, p1y]
  const C2 = [p2x, p2y]
  const P3 = [1, 1]
  const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const A = lerp(P0, C1, u)
  const B = lerp(C1, C2, u)
  const C = lerp(C2, P3, u)
  const D = lerp(A, B, u)
  const E = lerp(B, C, u)
  const F = lerp(D, E, u) // split point
  // renormalize each half into [0,1]x[0,1]
  const fx = F[0]
  const fy = F[1]
  const norm = (p: number[], ox: number, oy: number, sx: number, sy: number): BezierHandle => [
    sx !== 0 ? (p[0] - ox) / sx : 0,
    sy !== 0 ? (p[1] - oy) / sy : 0,
  ]
  const left: SegmentBezier = { p1: norm(A, 0, 0, fx, fy), p2: norm(D, 0, 0, fx, fy) }
  const right: SegmentBezier = { p1: norm(E, fx, fy, 1 - fx, 1 - fy), p2: norm(C, fx, fy, 1 - fx, 1 - fy) }
  const clampH = (h: BezierHandle): BezierHandle => [Math.min(1, Math.max(0, h[0])), h[1]]
  left.p1 = clampH(left.p1)
  left.p2 = clampH(left.p2)
  right.p1 = clampH(right.p1)
  right.p2 = clampH(right.p2)
  return { left, right }
}

/** Reverse-match a bezier to a named curve+variant for the picker UI. */
export function matchNamedEasing(bz: SegmentBezier): { name: string; variant: 'in' | 'inOut' | 'out' } | null {
  const eq = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.005)
  const quad = [bz.p1[0], bz.p1[1], bz.p2[0], bz.p2[1]]
  for (const name of EASING_PICKER_ORDER) {
    const c = EASING_CURVES[name]
    for (const variant of ['in', 'inOut', 'out'] as const) {
      if (eq(quad, c[variant])) return { name, variant }
    }
  }
  return null
}

/** Convert a legacy string easing into a segment bezier. */
export function legacyEasing(name: string): SegmentBezier {
  const map: Record<string, number[]> = {
    linear: [0, 0, 1, 1],
    easeIn: [0.32, 0, 0.67, 0],
    easeOut: [0.33, 1, 0.68, 1],
    easeInOut: [0.65, 0, 0.35, 1],
  }
  const q = map[name] ?? map.easeInOut
  return { p1: [q[0], q[1]], p2: [q[2], q[3]] }
}
