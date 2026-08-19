import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'system'

interface UIState {
  theme: Theme
  resolvedDark: boolean
  setTheme: (t: Theme) => void
  /** transient flags */
  exportDialogOpen: boolean
  setExportDialogOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  aboutOpen: boolean
  setAboutOpen: (open: boolean) => void
}

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return mq?.matches ?? false
}

function applyDomTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

const storedTheme = (typeof localStorage !== 'undefined' ? localStorage.getItem('openmock:theme') : null) as Theme | null
// light is the default look; dark (or system-follow) only when explicitly chosen
const initialTheme: Theme = storedTheme ?? 'light'

export const useUI = create<UIState>((set) => ({
  theme: initialTheme,
  resolvedDark: resolveDark(initialTheme),
  setTheme: (theme) => {
    localStorage.setItem('openmock:theme', theme)
    const dark = resolveDark(theme)
    applyDomTheme(dark)
    set({ theme, resolvedDark: dark })
  },
  exportDialogOpen: false,
  setExportDialogOpen: (exportDialogOpen) => set({ exportDialogOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  aboutOpen: false,
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
}))

// keep in sync with the OS when in system mode
mq?.addEventListener('change', () => {
  const { theme } = useUI.getState()
  if (theme === 'system') {
    const dark = resolveDark(theme)
    applyDomTheme(dark)
    useUI.setState({ resolvedDark: dark })
  }
})

applyDomTheme(resolveDark(initialTheme))
