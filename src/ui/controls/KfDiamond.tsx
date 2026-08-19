export type KfDiamondState = 'keyed' | 'animated' | 'none'

const TITLES: Record<KfDiamondState, string> = {
  keyed: 'Keyframed here — click to remove',
  animated: 'Animated — click to add a keyframe at the playhead',
  none: 'Click to keyframe at the playhead',
}

/**
 * Keyframe diamond button beside animatable controls.
 * Filled = a key for this property sits at the playhead (±0.02);
 * dot = the property is animated elsewhere in the shot; empty = no keys.
 */
export function KfDiamond({ state, onClick }: { state: KfDiamondState; onClick: () => void }) {
  return (
    <button
      aria-label={state === 'keyed' ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
      title={TITLES[state]}
      onClick={onClick}
      className="size-4 shrink-0 flex items-center justify-center group"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" className="overflow-visible">
        <path
          d="M6 1 L11 6 L6 11 L1 6 Z"
          className={
            state === 'keyed'
              ? 'fill-[#FD631F] stroke-[#FD631F]'
              : 'fill-transparent stroke-black/35 dark:stroke-white/30 group-hover:stroke-[#FD631F]'
          }
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        {state === 'animated' && <circle cx="6" cy="6" r="1.6" className="fill-[#FD631F]" />}
      </svg>
    </button>
  )
}

/** Small orange dot marking a row animated by keyframes (non-timeline context). */
export function AnimDot() {
  return (
    <span
      title="Animated by keyframes in this scene"
      className="size-4 shrink-0 flex items-center justify-center"
    >
      <span className="size-[5px] rounded-full bg-[#FD631F]" />
    </span>
  )
}
