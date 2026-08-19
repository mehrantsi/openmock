/** Open/closed state for shell-owned dialogs (the theme/ui store owns the rest). */

import { create } from 'zustand'

interface DialogStore {
  preferencesOpen: boolean
  setPreferencesOpen(v: boolean): void
}

export const useDialogs = create<DialogStore>((set) => ({
  preferencesOpen: false,
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
}))
