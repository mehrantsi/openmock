import { useEffect, useRef, useState } from 'react'
import {
  Aperture,
  Check,
  Frame,
  Hexagon,
  Image as ImageIcon,
  Moon,
  RotateCcw,
  Smartphone,
  Sparkles,
  Sun,
  Type,
  Video,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useProject } from '../../state/project'
import { useUI } from '../../state/ui'
import { MasterMenu } from '../chrome/TopBar'
import { SourceBlock } from './SourceBlock'
import { MockupSection } from './MockupSection'
import { CameraSection } from './CameraSection'
import { BlurSection } from './BlurSection'
import { SceneSection } from './SceneSection'
import { BorderSection } from './BorderSection'
import { EffectsSection } from './EffectsSection'
import { TextShotPanel } from './TextShotPanel'
import { LogoShotPanel } from './LogoShotPanel'
import { buildResetAllPatch, loadPanelSettings, rememberBgColor, useSelectedShot } from './dialHelpers'

// ---------------------------------------------------------------------------
// Property tabs
// ---------------------------------------------------------------------------

type TabId = 'mockup' | 'camera' | 'blur' | 'scene' | 'border' | 'effects'

const TABS: { id: TabId; icon: LucideIcon; label: string }[] = [
  { id: 'mockup', icon: Smartphone, label: 'Mockup' },
  { id: 'camera', icon: Video, label: 'Camera' },
  { id: 'blur', icon: Aperture, label: 'Depth' },
  { id: 'scene', icon: ImageIcon, label: 'Scene' },
  { id: 'border', icon: Frame, label: 'Frame' },
  { id: 'effects', icon: Sparkles, label: 'Effects' },
]

const TAB_KEY = 'openmock-props-tab'

function TabContent({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'mockup':
      return <MockupSection />
    case 'camera':
      return <CameraSection />
    case 'blur':
      return <BlurSection />
    case 'scene':
      return <SceneSection />
    case 'border':
      return <BorderSection />
    case 'effects':
      return <EffectsSection />
  }
}

// ---------------------------------------------------------------------------
// Rail widgets
// ---------------------------------------------------------------------------

function ThemeToggle() {
  const resolvedDark = useUI((s) => s.resolvedDark)
  const setTheme = useUI((s) => s.setTheme)
  return (
    <button
      aria-label={resolvedDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={resolvedDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}
      className="size-8 flex items-center justify-center rounded-lg text-black/45 dark:text-white/40 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
    >
      {resolvedDark ? <Sun className="size-3.5" strokeWidth={2.2} /> : <Moon className="size-3.5" strokeWidth={2.2} />}
    </button>
  )
}

function ResetAllButton() {
  const [confirming, setConfirming] = useState(false)
  const resolvedDark = useUI((s) => s.resolvedDark)

  const confirm = () => {
    const p = useProject.getState()
    const patch = buildResetAllPatch(p.dials, resolvedDark)
    rememberBgColor(patch.bgColor ?? (resolvedDark ? '#0a0a0a' : '#f2f2f2'), resolvedDark)
    p.setDials(patch, { system: true })
    setConfirming(false)
  }

  return (
    <div className="flex flex-col items-center gap-0.5">
      {confirming && (
        <>
          <button
            aria-label="Confirm reset"
            title="Confirm reset"
            onClick={confirm}
            className="size-8 flex items-center justify-center rounded-lg text-emerald-500 hover:text-emerald-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          >
            <Check className="size-3.5" strokeWidth={2.6} />
          </button>
          <button
            aria-label="Cancel reset"
            title="Cancel"
            onClick={() => setConfirming(false)}
            className="size-8 flex items-center justify-center rounded-lg text-black/45 dark:text-white/40 hover:text-red-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          >
            <X className="size-3.5" strokeWidth={2.4} />
          </button>
        </>
      )}
      <button
        aria-label="Reset all"
        title={confirming ? 'Cancel' : 'Reset all properties'}
        onClick={() => setConfirming((v) => !v)}
        className={`size-8 flex items-center justify-center rounded-lg text-black/45 dark:text-white/40 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-all ${
          confirming ? 'rotate-90 text-accent' : ''
        }`}
      >
        <RotateCcw className="size-3.5" strokeWidth={2.2} />
      </button>
    </div>
  )
}

/** Keeps dials.darkMode + per-theme bgColor in sync with the app theme. */
function useThemeDialSync(): void {
  const resolvedDark = useUI((s) => s.resolvedDark)
  const prev = useRef<boolean | null>(null)
  useEffect(() => {
    const p = useProject.getState()
    if (prev.current === null) {
      // initial mount: align darkMode without touching the color
      prev.current = resolvedDark
      if (p.dials.darkMode !== resolvedDark) p.setDials({ darkMode: resolvedDark }, { system: true })
      return
    }
    if (prev.current === resolvedDark) return
    // theme flipped: remember the outgoing color, restore the incoming one
    rememberBgColor(p.dials.bgColor, prev.current)
    prev.current = resolvedDark
    const settings = loadPanelSettings()
    p.setDials(
      { darkMode: resolvedDark, bgColor: resolvedDark ? settings.bgColorDark : settings.bgColorLight },
      { system: true },
    )
  }, [resolvedDark])
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Left-hand properties area: a slim icon rail (logo, menu, property tabs,
 * reset/theme) plus a 268px panel showing the active tab. Text/logo shots get
 * their dedicated panel with a content tab in the rail.
 */
export function InspectorPanel() {
  useThemeDialSync()
  const shot = useSelectedShot()
  const [tab, setTab] = useState<TabId>(() => {
    try {
      const v = localStorage.getItem(TAB_KEY) as TabId | null
      return v && TABS.some((t) => t.id === v) ? v : 'mockup'
    } catch {
      return 'mockup'
    }
  })

  const pick = (id: TabId) => {
    setTab(id)
    try {
      localStorage.setItem(TAB_KEY, id)
    } catch {
      /* non-fatal */
    }
  }

  const isCard = shot?.kind === 'text' || shot?.kind === 'logo'

  return (
    <div className="flex gap-[10px] shrink-0 h-full min-h-0">
      {/* icon rail */}
      <div className="w-[44px] shrink-0 h-full rounded-2xl border border-black/[0.09] dark:border-white/[0.08] bg-panel dark:bg-panel-dark flex flex-col items-center py-2 gap-1">
        <span className="size-[22px] mt-0.5 mb-1 rounded-[6px] overflow-hidden select-none shrink-0" title="OpenMock">
          <img src="/brand/mark-light.png" alt="OpenMock" className="size-full dark:hidden" draggable={false} />
          <img src="/brand/mark-dark.png" alt="" className="size-full hidden dark:block" draggable={false} />
        </span>
        <MasterMenu />
        <div className="w-5 h-px bg-black/[0.08] dark:bg-white/[0.08] my-1" />

        {isCard ? (
          <button
            aria-label={shot?.kind === 'text' ? 'Text properties' : 'Logo properties'}
            className="size-8 flex items-center justify-center rounded-lg bg-accent/[0.12] text-accent"
          >
            {shot?.kind === 'text' ? <Type className="size-4" strokeWidth={2} /> : <Hexagon className="size-4" strokeWidth={2} />}
          </button>
        ) : (
          TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              aria-label={`${label} properties`}
              title={label}
              onClick={() => pick(id)}
              className={`size-8 flex items-center justify-center rounded-lg transition-colors ${
                tab === id
                  ? 'bg-accent/[0.12] text-accent'
                  : 'text-black/40 dark:text-white/40 hover:text-black/75 dark:hover:text-white/75 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="size-4" strokeWidth={2} />
            </button>
          ))
        )}

        <div className="mt-auto flex flex-col items-center gap-0.5">
          <ResetAllButton />
          <ThemeToggle />
        </div>
      </div>

      {/* panel */}
      <div className="w-[268px] shrink-0 h-full min-h-0">
        <div className="h-full rounded-2xl border border-black/[0.09] dark:border-white/[0.08] bg-panel dark:bg-panel-dark flex flex-col overflow-hidden">
          {isCard && shot ? (
            shot.kind === 'text' ? (
              <TextShotPanel shot={shot} />
            ) : (
              <LogoShotPanel shot={shot} />
            )
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-2 [scrollbar-width:none]">
              {shot && tab === 'mockup' && <SourceBlock shot={shot} />}
              <TabContent tab={tab} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
