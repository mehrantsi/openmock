/**
 * Viewport toolbar: a floating glass pill (ratio selector · capture · export)
 * anchored inside the viewport area, plus the master menu used by the side
 * rail.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { Camera, Check, ChevronDown, RectangleHorizontal } from 'lucide-react'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { useUI } from '../../state/ui'
import { useViewportRatio } from '../../state/settings'
import { VIEWPORT_RATIOS, VIEWPORT_RATIO_LABELS } from '../../export/resolutions'
import { useDialogs } from '../dialogs/dialogStore'
import { ExportPopoverContent } from '../dialogs/ExportPopover'
import { IS_MAC } from '../dialogs/ShortcutsModal'
import { quickCapture, useExportApi } from './exportContext'
import { openProjectPicker } from '../useMediaIngest'
import { useIsPro } from '../../state/license'
import { saveProjectFile } from '../../lib/projectFile'

const MOD = IS_MAC ? '⌘' : 'Ctrl'

const menuContentCls =
  'w-[210px] rounded-xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[rgba(14,14,16,0.92)] backdrop-blur-md shadow-xl p-1 z-[9999]'
const menuItemCls =
  'flex items-center justify-between gap-3 px-2.5 py-[5px] rounded-[5px] text-[11px] text-zinc-700 dark:text-zinc-300 outline-none cursor-default data-[highlighted]:bg-black/[0.06] dark:data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-black dark:data-[highlighted]:text-white'
const menuSepCls = 'my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]'
const kbdCls = 'font-mono text-[9.5px] text-black/40 dark:text-white/35'

export function MasterMenu() {
  const timelineVisible = usePlayback((s) => s.timelineVisible)
  const setTimelineVisible = usePlayback((s) => s.setTimelineVisible)
  const setAboutOpen = useUI((s) => s.setAboutOpen)
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  const setProOpen = useUI((s) => s.setProOpen)
  const setPreferencesOpen = useDialogs((s) => s.setPreferencesOpen)
  const pro = useIsPro()

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label="Open menu"
          className="size-7 rounded-lg flex items-center justify-center text-black/60 dark:text-white/60 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black dark:hover:text-white transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={8} className={menuContentCls}>
          <DropdownMenu.Item className={menuItemCls} onSelect={() => useProject.getState().undo()}>
            Undo <span className={kbdCls}>{MOD}Z</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemCls} onSelect={() => useProject.getState().redo()}>
            Redo <span className={kbdCls}>⇧{MOD}Z</span>
          </DropdownMenu.Item>
          <DropdownMenu.CheckboxItem
            className={menuItemCls}
            checked={timelineVisible}
            onCheckedChange={(v) => setTimelineVisible(!!v)}
          >
            <span className="flex items-center gap-1.5">
              {timelineVisible && <Check className="size-3" />}
              Toggle timeline
            </span>
            <span className={kbdCls}>T</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item className={menuItemCls} onSelect={() => setPreferencesOpen(true)}>
            Preferences
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemCls} onSelect={() => setProOpen(true)}>
            OpenMock Pro <span className="text-[9px] font-semibold text-accent">PRO</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={menuSepCls} />
          <DropdownMenu.Item className={menuItemCls} onSelect={() => setAboutOpen(true)}>
            Info
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemCls} onSelect={() => setShortcutsOpen(true)}>
            Keyboard shortcuts <span className={kbdCls}>?</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={menuSepCls} />
          <DropdownMenu.Item
            className={menuItemCls}
            onSelect={() => (pro ? void saveProjectFile() : setProOpen(true))}
          >
            Save project {!pro && <span className="text-[9px] font-semibold text-accent">PRO</span>}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItemCls}
            onSelect={() => (pro ? openProjectPicker() : setProOpen(true))}
          >
            Open project… {!pro && <span className="text-[9px] font-semibold text-accent">PRO</span>}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItemCls}
            onSelect={() => {
              if (window.confirm('Start a new project? The current project will be cleared.')) {
                useProject.getState().resetProject()
              }
            }}
          >
            New project
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItemCls}
            onSelect={() => window.open('https://github.com/mehrantsi/openmock', '_blank', 'noopener')}
          >
            GitHub <span className={kbdCls}>↗</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function RatioSelector() {
  const ratio = useViewportRatio((s) => s.ratio)
  const setRatio = useViewportRatio((s) => s.setRatio)
  const current = VIEWPORT_RATIO_LABELS[ratio] ?? { label: ratio }
  const plain = VIEWPORT_RATIOS.filter((r) => !r.startsWith('appstore'))
  const appstore = VIEWPORT_RATIOS.filter((r) => r.startsWith('appstore'))

  const item = (r: string) => {
    const meta = VIEWPORT_RATIO_LABELS[r] ?? { label: r }
    return (
      <DropdownMenu.Item key={r} className={menuItemCls} onSelect={() => setRatio(r)}>
        <span className="flex flex-col">
          <span>{meta.label}</span>
          {meta.sub && <span className="font-mono text-[9px] text-black/35 dark:text-white/30">{meta.sub}</span>}
        </span>
        {ratio === r && <Check className="size-3 text-[#FD631F]" />}
      </DropdownMenu.Item>
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label="Viewport ratio"
          className="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-black/65 dark:text-white/65 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black dark:hover:text-white transition-colors"
        >
          <RectangleHorizontal className="size-3 opacity-60" />
          {current.label}
          <ChevronDown className="size-[9px] opacity-50" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="center" sideOffset={8} className={`${menuContentCls} max-h-[70vh] overflow-y-auto`}>
          {plain.map(item)}
          <DropdownMenu.Separator className={menuSepCls} />
          <div className="px-2.5 py-1 text-[10px] font-medium text-black/40 dark:text-white/35">
            App Store
          </div>
          {appstore.map(item)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function ViewportToolbar() {
  const ex = useExportApi()
  const exportOpen = useUI((s) => s.exportDialogOpen)
  const setExportOpen = useUI((s) => s.setExportDialogOpen)
  const busy = ex?.phase === 'rendering'

  return (
    <div className="absolute top-3 right-3 z-[600] flex items-center gap-1.5 h-[38px] px-1.5 rounded-full border border-black/[0.09] dark:border-white/[0.09] bg-white/80 dark:bg-[#101013]/80 backdrop-blur-xl shadow-[0_4px_18px_-6px_rgba(0,0,0,0.25)]">
      <RatioSelector />
      <div className="w-px h-4 bg-black/[0.08] dark:bg-white/[0.1]" />
      <button
        aria-label="Capture image"
        title="Capture image"
        disabled={busy}
        onClick={() => void quickCapture(ex)}
        className="size-[28px] rounded-full bg-accent hover:bg-accent-strong disabled:opacity-50 text-white flex items-center justify-center transition-colors"
      >
        <Camera size={14} strokeWidth={2.2} />
      </button>

      <Popover.Root open={exportOpen} onOpenChange={setExportOpen}>
        <Popover.Trigger asChild>
          <button
            className="h-[28px] px-3 rounded-full bg-zinc-900 text-white dark:bg-white dark:text-black flex items-center gap-1 text-[11px] font-semibold hover:opacity-90 transition-opacity"
          >
            Export
            <ChevronDown className="size-[9px] opacity-70" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className="w-[330px] rounded-2xl border border-black/10 dark:border-white/[0.08] bg-white dark:bg-[#161618] p-4 z-[700] shadow-[0_10px_30px_-8px_rgba(0,0,0,0.25)] outline-none"
          >
            <ExportPopoverContent onClose={() => setExportOpen(false)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
