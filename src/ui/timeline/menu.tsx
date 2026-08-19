/**
 * Lightweight context-menu + anchored-popover primitives used across the
 * timeline. Menus follow the app dropdown style (dark card, 11px Geist rows).
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onSelect?(): void
  disabled?: boolean
  danger?: boolean
  /** render a separator INSTEAD of this row */
  separator?: boolean
  /** disabled-state tooltip */
  title?: string
}

export const menuSeparator: MenuItem = { label: '', separator: true }

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface MenuApi {
  open(x: number, y: number, items: MenuItem[]): void
  close(): void
}

const MenuApiCtx = createContext<MenuApi | null>(null)

export function useMenu(): MenuApi {
  const api = useContext(MenuApiCtx)
  if (!api) throw new Error('useMenu outside MenuHost')
  return api
}

/** Convenience: open a context menu from a mouse event (prevents the native one). */
export function useContextMenu(): (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) => void {
  const api = useMenu()
  return (e, items) => {
    e.preventDefault()
    e.stopPropagation()
    api.open(e.clientX, e.clientY, items)
  }
}

export function MenuHost({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const apiRef = useRef<MenuApi>({
    open: (x, y, items) => setMenu({ x, y, items }),
    close: () => setMenu(null),
  })

  return (
    <MenuApiCtx.Provider value={apiRef.current}>
      {children}
      {menu && <MenuLayer menu={menu} onClose={() => setMenu(null)} />}
    </MenuApiCtx.Provider>
  )
}

function MenuLayer({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = menu.x
    let y = menu.y
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8)
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8)
    setPos({ x, y })
  }, [menu])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[10000]" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="fixed min-w-[168px] py-1 px-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {menu.items.map((it, i) =>
          it.separator ? (
            <div key={i} className="my-1 h-px bg-zinc-800" />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              title={it.title}
              className={`w-full text-left py-[5px] px-2.5 rounded-[5px] text-[11px] font-sans ${
                it.disabled
                  ? 'text-zinc-600 cursor-default'
                  : it.danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
              onClick={() => {
                if (it.disabled) return
                onClose()
                it.onSelect?.()
              }}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Anchored popover
// ---------------------------------------------------------------------------

export interface PopoverProps {
  /** viewport anchor (usually a button rect center-top or a point) */
  anchor: { x: number; y: number }
  /** open above (default) or below the anchor */
  placement?: 'above' | 'below'
  onClose(): void
  children: ReactNode
  className?: string
  width?: number
}

/** Portal card positioned relative to a viewport point; click-away + Esc close. */
export function AnchoredPopover({ anchor, placement = 'above', onClose, children, className = '', width }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = anchor.x - r.width / 2
    x = Math.min(Math.max(8, x), window.innerWidth - r.width - 8)
    let y = placement === 'above' ? anchor.y - r.height - 10 : anchor.y + 10
    if (y < 8) y = anchor.y + 10
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, anchor.y - r.height - 10)
    setPos({ x, y })
  }, [anchor.x, anchor.y, placement])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[9999]" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className={`fixed rounded-xl border shadow-2xl bg-white border-black/10 dark:bg-[#111114] dark:border-white/10 ${className}`}
        style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, width, visibility: pos ? 'visible' : 'hidden' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** Anchor point helper: center-top of an element (for `above` popovers). */
export function anchorOf(el: Element | null, placement: 'above' | 'below' = 'above'): { x: number; y: number } {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: placement === 'above' ? r.top : r.bottom }
}
