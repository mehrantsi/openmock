/**
 * Safari presents video frames late (or, for paused seeks, without firing
 * requestVideoFrameCallback at all), so video textures and frame captures
 * need explicit refreshing there. Chromium presents by `seeked` and needs
 * neither.
 */
export const webkitVideoPresentQuirk =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/i.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\/|OPR\//.test(navigator.userAgent)
