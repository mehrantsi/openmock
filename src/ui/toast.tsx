/** Minimal toast system (sonner-style, bottom-center). */

import { create } from 'zustand'
import { useEffect } from 'react'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error' | 'success'
  duration: number
}

interface ToastStore {
  toasts: Toast[]
  push(message: string, kind?: Toast['kind'], duration?: number): number
  dismiss(id: number): void
}

let nextId = 1

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push(message, kind = 'info', duration = 3200) {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, kind, duration }] }))
    return id
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export function toast(message: string, kind: Toast['kind'] = 'info', duration = 3200): number {
  return useToasts.getState().push(message, kind, duration)
}

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss)
  useEffect(() => {
    const h = setTimeout(() => dismiss(t.id), t.duration)
    return () => clearTimeout(h)
  }, [t.id, t.duration, dismiss])
  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-center gap-2 px-3.5 py-2 rounded-lg border text-[12px] shadow-lg backdrop-blur-md max-w-[420px] ${
        t.kind === 'error'
          ? 'bg-red-950/90 border-red-500/30 text-red-100'
          : t.kind === 'success'
            ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-100'
            : 'bg-[rgba(14,14,16,0.9)] border-white/10 text-zinc-50'
      }`}
      onClick={() => dismiss(t.id)}
    >
      {t.message}
    </div>
  )
}

export function ToastViewport() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[10050] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  )
}
