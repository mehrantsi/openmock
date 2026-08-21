/** OpenMock Pro: upgrade, license activation, devices, and billing. */

import { useState } from 'react'
import { Check, Laptop } from 'lucide-react'
import { Modal, ModalSection } from './Modal'
import { useUI } from '../../state/ui'
import { thisDeviceId, useIsPro, useLicense, type DeviceInfo } from '../../state/license'
import { PAYMENT_LINKS, PRO_PRICES } from '../../lib/pro'
import { toast } from '../toast'

const FEATURES = [
  'No watermark on video exports',
  'Video export in 1080p, 4K and 60 fps',
  'Save and open project files',
  'Use on up to 3 devices',
  'Keeps OpenMock maintained and free for everyone else',
]

function PriceCard({ plan, price, per, note }: { plan: 'monthly' | 'yearly'; price: string; per: string; note?: string }) {
  const open = () => {
    const link = PAYMENT_LINKS[plan]
    if (!link) {
      toast('Checkout is not wired up yet. Check back shortly.', 'info')
      return
    }
    window.open(link, '_blank', 'noopener')
  }
  return (
    <button
      onClick={open}
      className="flex-1 flex flex-col items-start gap-0.5 rounded-xl border border-black/10 dark:border-white/10 hover:border-accent/60 dark:hover:border-accent/60 px-3.5 py-3 text-left transition-colors"
    >
      <span className="text-[11px] font-medium text-black/50 dark:text-white/45 capitalize">{plan}</span>
      <span className="text-[17px] font-semibold tracking-tight">
        {price}
        <span className="text-[11px] font-medium text-black/45 dark:text-white/40"> {per}</span>
      </span>
      {note && <span className="text-[10px] font-medium text-accent">{note}</span>}
    </button>
  )
}

function DeviceRow({
  device,
  action,
  onAction,
  busy,
}: {
  device: DeviceInfo
  action: string | null
  onAction?: () => void
  busy: boolean
}) {
  const mine = device.id === thisDeviceId()
  return (
    <div className="flex items-center gap-2.5 h-9 border-b border-black/[0.06] dark:border-white/[0.06] last:border-0">
      <Laptop className="size-3.5 text-black/40 dark:text-white/35 shrink-0" />
      <span className="text-[12px] flex-1 truncate">
        {device.name}
        {mine && <span className="ml-1.5 text-[10px] font-medium text-accent">this device</span>}
      </span>
      <span className="text-[10px] font-mono text-black/35 dark:text-white/30">
        {new Date(device.at).toLocaleDateString()}
      </span>
      {action && onAction && !mine && (
        <button
          onClick={onAction}
          disabled={busy}
          className="text-[10.5px] font-semibold text-accent hover:underline disabled:opacity-50"
        >
          {action}
        </button>
      )}
    </div>
  )
}

export function ProModal() {
  const open = useUI((s) => s.proOpen)
  const setOpen = useUI((s) => s.setProOpen)
  const pro = useIsPro()
  const license = useLicense()
  const [keyInput, setKeyInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const activate = async () => {
    const key = keyInput.trim()
    if (!key) return
    setError(null)
    const err = await license.activate(key)
    if (err) setError(err)
    else {
      setKeyInput('')
      toast('Pro activated on this device.', 'success')
    }
  }

  const freeSlot = async (id: string) => {
    setError(null)
    const err = await license.deactivateDevice(id)
    if (err) setError(err)
    else toast('Pro activated on this device.', 'success')
  }

  const portal = async () => {
    const err = await license.openPortal()
    if (err) toast(err, 'error')
  }

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="OpenMock Pro" subtitle={pro ? 'Active' : undefined}>
      {pro ? (
        <>
          <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/60">
            Thanks for supporting OpenMock. Video exports are watermark-free with 1080p, 4K and 60 fps
            unlocked on this device.
          </p>
          <ModalSection label="Subscription" />
          <div className="flex flex-col text-[12px]">
            <div className="flex items-center justify-between h-8 border-b border-black/[0.06] dark:border-white/[0.06]">
              <span className="text-black/50 dark:text-white/45">Plan</span>
              <span className="font-mono text-[11px] capitalize">{license.entitlement?.plan ?? 'pro'}</span>
            </div>
            <div className="flex items-center justify-between h-8 border-b border-black/[0.06] dark:border-white/[0.06]">
              <span className="text-black/50 dark:text-white/45">Status</span>
              <span className="font-mono text-[11px] capitalize">{license.entitlement?.status ?? 'active'}</span>
            </div>
            <div className="flex items-center justify-between h-8 gap-3">
              <span className="text-black/50 dark:text-white/45 shrink-0">License key</span>
              <button
                title="Copy license key"
                onClick={() => {
                  if (!license.key) return
                  void navigator.clipboard.writeText(license.key).then(() => toast('License key copied.', 'success'))
                }}
                className="font-mono text-[11px] truncate text-black/75 dark:text-white/75 hover:text-accent"
              >
                {license.key}
              </button>
            </div>
          </div>
          <p className="text-[10px] leading-snug text-black/40 dark:text-white/35 mt-1">
            Click the key to copy it. Paste it in OpenMock on another device to activate Pro there.
          </p>
          {license.devices && license.devices.length > 0 && (
            <>
              <ModalSection label={`Devices (${license.devices.length} of 3)`} />
              <div className="flex flex-col">
                {license.devices.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    action="Deactivate"
                    onAction={() => {
                      void license.deactivateDevice(d.id).then((err) => {
                        if (err) toast(err, 'error')
                      })
                    }}
                    busy={license.busy}
                  />
                ))}
              </div>
            </>
          )}
          <div className="flex gap-2 mt-4">
            <button
              onClick={portal}
              className="flex-1 h-9 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 transition-opacity"
            >
              Manage Billing
            </button>
            <button
              onClick={() => license.deactivate()}
              className="flex-1 h-9 rounded-lg border border-black/15 dark:border-white/15 text-[12px] font-semibold text-black/75 dark:text-white/75 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              Remove From Device
            </button>
          </div>
        </>
      ) : license.limitDevices ? (
        <>
          <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/60">
            This license is already active on 3 devices. Deactivate one to use it here — the freed
            device keeps Pro until its weekly check.
          </p>
          <ModalSection label="Active devices" />
          <div className="flex flex-col">
            {license.limitDevices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                action="Deactivate & use here"
                onAction={() => void freeSlot(d.id)}
                busy={license.busy}
              />
            ))}
          </div>
          {error && <p className="text-[11px] text-red-600 dark:text-red-400 mt-2">{error}</p>}
          <button
            onClick={() => useLicense.setState({ limitDevices: null, pendingKey: null })}
            className="mt-4 h-9 w-full rounded-lg border border-black/15 dark:border-white/15 text-[12px] font-semibold text-black/75 dark:text-white/75 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            Back
          </button>
        </>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/60">
            Images always export free, full quality, no watermark. Pro upgrades the video pipeline:
          </p>
          <div className="flex flex-col gap-2 mt-3">
            {FEATURES.map((f) => (
              <div key={f} className="flex items-center gap-2 text-[12px] text-black/75 dark:text-white/75">
                <Check className="size-3.5 text-accent shrink-0" />
                {f}
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-4">
            <PriceCard plan="monthly" price={PRO_PRICES.monthly} per="/ month" note="cancel anytime" />
            <PriceCard plan="yearly" price={PRO_PRICES.yearly} per="/ year" note="2 months free" />
          </div>
          <p className="text-[10px] text-black/40 dark:text-white/35 mt-1.5">
            Prices include VAT where applicable.
          </p>
          <p className="text-[10.5px] leading-relaxed text-black/45 dark:text-white/40 mt-3">
            OpenMock is fair source. You can also build Pro from the source yourself, and that is
            genuinely fine. Paying is the convenient way that keeps the project alive.
          </p>
          <ModalSection label="Already have a key?" />
          <div className="flex gap-2">
            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="OMP1.…"
              spellCheck={false}
              className="flex-1 h-9 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] text-[12px] font-mono outline-none focus:ring-1 focus:ring-accent/60 placeholder:text-black/30 dark:placeholder:text-white/25"
            />
            <button
              onClick={() => void activate()}
              disabled={license.busy || !keyInput.trim()}
              className="h-9 px-4 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-black text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {license.busy ? 'Checking…' : 'Activate'}
            </button>
          </div>
          {error && <p className="text-[11px] text-red-600 dark:text-red-400 mt-2">{error}</p>}
        </>
      )}
    </Modal>
  )
}
