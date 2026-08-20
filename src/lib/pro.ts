/** Pro tier configuration and free-tier limits. */

import { lookupResolution } from '../export/resolutions'

export const PRO_PRICES = { monthly: '$5', yearly: '$36' }

/**
 * Stripe payment links. Both must redirect to
 * https://openmock.app/activate?session_id={CHECKOUT_SESSION_ID} after payment.
 */
export const PAYMENT_LINKS: Record<'monthly' | 'yearly', string> = {
  monthly: 'https://buy.stripe.com/bJe7sM9JX8N00B1bLn9IQ00',
  yearly: 'https://buy.stripe.com/3cIfZi2hvgfs83t7v79IQ01',
}

export const FREE_MAX_VIDEO_EDGE = 1280
export const FREE_MAX_FPS = 30

/** True when a video export size exceeds the free cap. */
export function videoSizeNeedsPro(size: string, customWidth: number, customHeight: number): boolean {
  if (size === 'custom') return Math.max(customWidth, customHeight) > FREE_MAX_VIDEO_EDGE
  const r = lookupResolution(size, 'video')
  return !!r && Math.max(r.width, r.height) > FREE_MAX_VIDEO_EDGE
}
