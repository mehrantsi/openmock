/**
 * License backend (Cloudflare Pages Functions). The license key is
 * `OMP1.<b64url(subscriptionId)>.<b64url(hmac16)>`, so validation needs only
 * the signing secret and a Stripe lookup. KV tracks device activations per
 * subscription (limit 3, throttled deactivations) so a shared key burns out
 * instead of scaling.
 *
 * Routes:
 *   POST /api/license/claim      { session_id, device_id, device_name } -> { key, entitlement, devices }
 *   POST /api/license/validate   { key, device_id, device_name }        -> { entitlement, devices }
 *   POST /api/license/deactivate { key, device_id }                     -> { devices }
 *   POST /api/license/portal     { key }                                -> { url }
 *
 * Secrets: STRIPE_SECRET_KEY, LICENSE_SIGNING_SECRET.
 * Bindings: LICENSES (KV). MOCK_BILLING=1 fakes Stripe for local testing.
 */

interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

interface Env {
  STRIPE_SECRET_KEY?: string
  LICENSE_SIGNING_SECRET?: string
  LICENSES?: KVNamespace
  MOCK_BILLING?: string
}

interface Ctx {
  request: Request
  env: Env
}

const ENTITLEMENT_TTL_MS = 7 * 24 * 3600 * 1000
const KEY_PREFIX = 'OMP1'
const DEVICE_LIMIT = 3
const FREES_PER_WEEK = 5
const WEEK_MS = 7 * 24 * 3600 * 1000

interface DeviceRec {
  id: string
  name: string
  at: number
  seen: number
}

interface SubRec {
  devices: DeviceRec[]
  frees: number[]
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
}

async function sign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return b64url(new Uint8Array(mac).slice(0, 16))
}

async function makeKey(secret: string, subId: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(subId))
  return `${KEY_PREFIX}.${body}.${await sign(secret, subId)}`
}

async function parseKey(secret: string, key: string): Promise<string | null> {
  const parts = key.trim().split('.')
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null
  let subId: string
  try {
    subId = b64urlDecode(parts[1])
  } catch {
    return null
  }
  if (!/^sub_[A-Za-z0-9]+$/.test(subId)) return null
  if ((await sign(secret, subId)) !== parts[2]) return null
  return subId
}

type StripeResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number }

function mockStripe(path: string): StripeResult {
  if (path.startsWith('/checkout/sessions/')) {
    return { ok: true, data: { payment_status: 'paid', subscription: 'sub_MOCKTEST1' } }
  }
  if (path.startsWith('/subscriptions/')) {
    return {
      ok: true,
      data: {
        status: 'active',
        customer: 'cus_MOCK',
        items: { data: [{ price: { recurring: { interval: 'month' } } }] },
      },
    }
  }
  if (path.startsWith('/billing_portal/')) return { ok: true, data: { url: 'https://billing.stripe.com/mock' } }
  return { ok: false, status: 404 }
}

async function stripe(env: Env, method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<StripeResult> {
  if (env.MOCK_BILLING === '1') return mockStripe(path)
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, data: (await res.json()) as Record<string, unknown> }
}

function entitlementFor(sub: Record<string, unknown>): { pro: boolean; plan: string; status: string; exp: number } {
  const status = sub.status as string
  const items = sub.items as { data?: { price?: { recurring?: { interval?: string } } }[] } | undefined
  const interval = items?.data?.[0]?.price?.recurring?.interval
  return {
    pro: status === 'active' || status === 'trialing' || status === 'past_due',
    plan: interval === 'year' ? 'yearly' : 'monthly',
    status,
    exp: Date.now() + ENTITLEMENT_TTL_MS,
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function readSubRec(kv: KVNamespace, subId: string): Promise<SubRec> {
  try {
    const raw = await kv.get(`sub:${subId}`)
    if (raw) return JSON.parse(raw) as SubRec
  } catch {
    // unreadable record — start fresh
  }
  return { devices: [], frees: [] }
}

function publicDevices(rec: SubRec): { id: string; name: string; at: number }[] {
  return rec.devices.map(({ id, name, at }) => ({ id, name, at }))
}

function deviceIdOf(body: Record<string, unknown>): string | null {
  const id = body.device_id
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null
}

function deviceNameOf(body: Record<string, unknown>): string {
  const name = body.device_name
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'Device'
}

/**
 * Register (or touch) a device slot. Returns the response to send when the
 * activation limit blocks this device, null when the device is in.
 */
async function registerDevice(
  kv: KVNamespace,
  subId: string,
  deviceId: string,
  deviceName: string,
): Promise<{ blocked: Response | null; devices: { id: string; name: string; at: number }[] }> {
  const rec = await readSubRec(kv, subId)
  const existing = rec.devices.find((d) => d.id === deviceId)
  if (existing) {
    existing.seen = Date.now()
    existing.name = deviceName
  } else if (rec.devices.length < DEVICE_LIMIT) {
    rec.devices.push({ id: deviceId, name: deviceName, at: Date.now(), seen: Date.now() })
  } else {
    return {
      blocked: json(
        {
          error: `This license is already active on ${DEVICE_LIMIT} devices. Deactivate one to use it here.`,
          code: 'activation_limit',
          devices: publicDevices(rec),
        },
        409,
      ),
      devices: publicDevices(rec),
    }
  }
  await kv.put(`sub:${subId}`, JSON.stringify(rec))
  return { blocked: null, devices: publicDevices(rec) }
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/')) return json({ error: 'Not found' }, 404)
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const mock = env.MOCK_BILLING === '1'
  if ((!env.STRIPE_SECRET_KEY && !mock) || !env.LICENSE_SIGNING_SECRET) {
    return json({ error: 'License server is not configured yet.' }, 503)
  }
  const secret = env.LICENSE_SIGNING_SECRET
  const kv = env.LICENSES
  const body = await readBody(request)

  if (path === '/api/license/claim') {
    const sessionId = body.session_id
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      return json({ error: 'Invalid checkout session.' }, 400)
    }
    const session = await stripe(env, 'GET', `/checkout/sessions/${sessionId}`)
    if (!session.ok) return json({ error: 'Could not find that checkout session.' }, 404)
    if (session.data.payment_status !== 'paid') return json({ error: 'This checkout was not completed.' }, 400)
    const subId = session.data.subscription
    if (typeof subId !== 'string') return json({ error: 'No subscription on that checkout.' }, 400)
    const sub = await stripe(env, 'GET', `/subscriptions/${subId}`)
    if (!sub.ok) return json({ error: 'Could not load the subscription.' }, 502)
    const ent = entitlementFor(sub.data)
    let devices: { id: string; name: string; at: number }[] | undefined
    if (kv && ent.pro) {
      const deviceId = deviceIdOf(body)
      if (!deviceId) return json({ error: 'Missing device id.' }, 400)
      const reg = await registerDevice(kv, subId, deviceId, deviceNameOf(body))
      if (reg.blocked) return reg.blocked
      devices = reg.devices
    }
    return json({ key: await makeKey(secret, subId), entitlement: ent, devices })
  }

  if (path === '/api/license/validate') {
    const key = body.key
    if (typeof key !== 'string') return json({ error: 'Missing license key.' }, 400)
    const subId = await parseKey(secret, key)
    if (!subId) return json({ error: 'That license key is not valid.' }, 400)
    const sub = await stripe(env, 'GET', `/subscriptions/${subId}`)
    if (!sub.ok) {
      if (sub.status === 404) return json({ error: 'No subscription found for this key.' }, 404)
      return json({ error: 'Could not check the subscription. Try again shortly.' }, 502)
    }
    const ent = entitlementFor(sub.data)
    let devices: { id: string; name: string; at: number }[] | undefined
    if (kv && ent.pro) {
      const deviceId = deviceIdOf(body)
      if (!deviceId) return json({ error: 'Missing device id.' }, 400)
      const reg = await registerDevice(kv, subId, deviceId, deviceNameOf(body))
      if (reg.blocked) return reg.blocked
      devices = reg.devices
    }
    return json({ entitlement: ent, devices })
  }

  if (path === '/api/license/deactivate') {
    const key = body.key
    if (typeof key !== 'string') return json({ error: 'Missing license key.' }, 400)
    const subId = await parseKey(secret, key)
    if (!subId) return json({ error: 'That license key is not valid.' }, 400)
    if (!kv) return json({ error: 'Device tracking is not enabled.' }, 503)
    const target = deviceIdOf(body)
    if (!target) return json({ error: 'Missing device id.' }, 400)
    const rec = await readSubRec(kv, subId)
    const now = Date.now()
    rec.frees = rec.frees.filter((t) => now - t < WEEK_MS)
    if (rec.frees.length >= FREES_PER_WEEK) {
      return json({ error: 'Too many device changes this week. Try again in a few days.' }, 429)
    }
    const before = rec.devices.length
    rec.devices = rec.devices.filter((d) => d.id !== target)
    if (rec.devices.length < before) rec.frees.push(now)
    await kv.put(`sub:${subId}`, JSON.stringify(rec))
    return json({ devices: publicDevices(rec) })
  }

  if (path === '/api/license/portal') {
    const key = body.key
    if (typeof key !== 'string') return json({ error: 'Missing license key.' }, 400)
    const subId = await parseKey(secret, key)
    if (!subId) return json({ error: 'That license key is not valid.' }, 400)
    const sub = await stripe(env, 'GET', `/subscriptions/${subId}`)
    if (!sub.ok) return json({ error: 'Could not load the subscription.' }, 502)
    const customer = sub.data.customer
    if (typeof customer !== 'string') return json({ error: 'No customer on this subscription.' }, 502)
    const portal = await stripe(env, 'POST', '/billing_portal/sessions', {
      customer,
      return_url: 'https://openmock.app',
    })
    if (!portal.ok) return json({ error: 'Could not open the billing portal.' }, 502)
    return json({ url: portal.data.url })
  }

  return json({ error: 'Not found' }, 404)
}
