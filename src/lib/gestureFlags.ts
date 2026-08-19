/**
 * Cross-module gesture coordination (no reactivity needed).
 * Space serves two roles: tap = play/pause, hold+drag = pan the viewport.
 * The viewport marks when a space-pan actually happened so the timeline's
 * key-up handler can skip the playback toggle.
 */
export const gestureFlags = {
  /** a pointer drag started while Space was held (this hold is a pan) */
  spacePanned: false,
}
