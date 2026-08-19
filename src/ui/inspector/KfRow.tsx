import type { ReactNode } from 'react'
import type { AnimatableProp } from '../../state/types'
import { AnimDot, KfDiamond } from '../controls/KfDiamond'
import { kfStateFor, toggleKfAt, useKfContext } from './dialHelpers'

/**
 * Wraps a control whose path(s) are animatable. In video context (timeline
 * visible + mockup shot selected) a keyframe diamond renders beside the row;
 * otherwise an "animated" dot appears when the prop carries keys.
 */
export function KfRow({ prop, children }: { prop: AnimatableProp | AnimatableProp[]; children: ReactNode }) {
  const props = Array.isArray(prop) ? prop : [prop]
  const ctx = useKfContext()

  if (!ctx.shot || ctx.shot.kind) return <>{children}</>

  const state = kfStateFor(ctx.shot, props, ctx.localT)

  if (!ctx.active) {
    if (state === 'none') return <>{children}</>
    return (
      <div className="flex items-center gap-1">
        <AnimDot />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <KfDiamond state={state} onClick={() => toggleKfAt(ctx.shot!, props, ctx.localT)} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
