/**
 * Pro license state. The key is validated by the /api/license worker, which
 * returns a time-boxed entitlement cached here so the app works offline until
 * `exp`. Activations are tracked per device (random local id) with a small
 * server-side limit. The gate is client-side by design: OpenMock is fair
 * source, and the paid tier is convenience, not DRM.
 */

import { create } from 'zustand'

export interface Entitlement {
  pro: boolean
  plan?: string
  status?: string
  exp: number
}

export interface DeviceInfo {
  id: string
  name: string
  at: number
}

interface Persisted {
  key: string | null
  entitlement: Entitlement | null
}

const STORE_KEY = 'openmock-license'
const DEVICE_KEY = 'openmock-device-id'
const REFRESH_AHEAD_MS = 3 * 24 * 3600 * 1000

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw) as Persisted
  } catch {
    // corrupt entry — treat as unlicensed
  }
  return { key: null, entitlement: null }
}

function save(p: Persisted): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(p))
}

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

function deviceName(): string {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Mac/i.test(ua)
      ? 'Mac'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Android/i.test(ua)
          ? 'Android'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : /Firefox/.test(ua)
            ? 'Firefox'
            : 'Browser'
  return `${os} · ${browser}`
}

type ApiResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; network?: boolean; data?: Record<string, unknown> }

async function post(path: string, body: object): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/license/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: (data.error as string) ?? `Request failed (${res.status})`, data }
    return { ok: true, data }
  } catch {
    return { ok: false, error: 'Could not reach the license server. Check your connection.', network: true }
  }
}

interface LicenseState extends Persisted {
  busy: boolean
  /** Registered devices, from the last successful server response. */
  devices: DeviceInfo[] | null
  /** Set when activation hit the device limit: the occupied slots. */
  limitDevices: DeviceInfo[] | null
  /** The key that hit the limit, retried after a slot is freed. */
  pendingKey: string | null
  /** Validate and store a key. Returns an error message, or null on success. */
  activate(key: string): Promise<string | null>
  /** Exchange a Stripe checkout session for a key (post-payment redirect). */
  claim(sessionId: string): Promise<string | null>
  /** Free a device slot, then retry the pending or stored key. */
  deactivateDevice(id: string): Promise<string | null>
  /** Re-validate the stored key against the server. */
  refresh(): Promise<void>
  /** Open the Stripe billing portal. Returns an error message, or null. */
  openPortal(): Promise<string | null>
  /** Forget the license here and free this device's slot. */
  deactivate(): void
}

function deviceBody(): Record<string, string> {
  return { device_id: deviceId(), device_name: deviceName() }
}

function applySuccess(
  set: (p: Partial<LicenseState>) => void,
  key: string,
  data: Record<string, unknown>,
): void {
  const p = { key, entitlement: data.entitlement as Entitlement }
  save(p)
  set({
    ...p,
    devices: (data.devices as DeviceInfo[] | undefined) ?? null,
    limitDevices: null,
    pendingKey: null,
  })
}

export const useLicense = create<LicenseState>((set, get) => ({
  ...load(),
  busy: false,
  devices: null,
  limitDevices: null,
  pendingKey: null,

  async activate(key) {
    set({ busy: true })
    const r = await post('validate', { key, ...deviceBody() })
    set({ busy: false })
    if (!r.ok) {
      if (r.data?.code === 'activation_limit') {
        set({ limitDevices: (r.data.devices as DeviceInfo[]) ?? [], pendingKey: key })
      }
      return r.error
    }
    const entitlement = r.data.entitlement as Entitlement | undefined
    if (!entitlement?.pro) return 'This license has no active subscription.'
    applySuccess(set, key, r.data)
    return null
  },

  async claim(sessionId) {
    set({ busy: true })
    const r = await post('claim', { session_id: sessionId, ...deviceBody() })
    set({ busy: false })
    if (!r.ok) {
      if (r.data?.code === 'activation_limit') {
        set({ limitDevices: (r.data.devices as DeviceInfo[]) ?? [] })
      }
      return r.error
    }
    applySuccess(set, r.data.key as string, r.data)
    return null
  },

  async deactivateDevice(id) {
    const key = get().pendingKey ?? get().key
    if (!key) return 'No license on this device.'
    set({ busy: true })
    const r = await post('deactivate', { key, device_id: id })
    if (!r.ok) {
      set({ busy: false })
      return r.error
    }
    set({ busy: false, devices: (r.data.devices as DeviceInfo[] | undefined) ?? null })
    return get().activate(key)
  },

  async refresh() {
    const { key } = get()
    if (!key) return
    const r = await post('validate', { key, ...deviceBody() })
    if (!r.ok) {
      // offline keeps the cached entitlement until exp; a server rejection
      // (invalid key, canceled sub, evicted device) drops it
      if (!r.network) {
        const p = { key, entitlement: null }
        save(p)
        set(p)
      }
      return
    }
    const entitlement = r.data.entitlement as Entitlement | undefined
    if (entitlement?.pro) applySuccess(set, key, r.data)
    else {
      const p = { key, entitlement: null }
      save(p)
      set(p)
    }
  },

  async openPortal() {
    const { key } = get()
    if (!key) return 'No license on this device.'
    const r = await post('portal', { key })
    if (!r.ok) return r.error
    window.open(r.data.url as string, '_blank', 'noopener')
    return null
  },

  deactivate() {
    const { key } = get()
    if (key) void post('deactivate', { key, device_id: deviceId() })
    const p = { key: null, entitlement: null }
    save(p)
    set({ ...p, devices: null, limitDevices: null, pendingKey: null })
  },
}))

export function thisDeviceId(): string {
  return deviceId()
}

export function isProNow(): boolean {
  const e = useLicense.getState().entitlement
  return !!e && e.pro && e.exp > Date.now()
}

export function useIsPro(): boolean {
  return useLicense((s) => !!s.entitlement && s.entitlement.pro && s.entitlement.exp > Date.now())
}

/** Background re-validation when the cached entitlement nears expiry. */
export function maybeRefreshLicense(): void {
  const { key, entitlement } = useLicense.getState()
  if (!key) return
  if (!entitlement || entitlement.exp - REFRESH_AHEAD_MS < Date.now()) void useLicense.getState().refresh()
}
