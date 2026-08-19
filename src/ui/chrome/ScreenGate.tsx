import { useEffect, useState } from 'react'

const QUERY = '(max-width: 819px), (max-height: 499px)'

/** True when the viewport is too small for the editor layout. */
export function useScreenTooSmall(): boolean {
  const [small, setSmall] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = () => setSmall(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return small
}

/** Full-screen notice shown instead of the app on small screens. */
export function ScreenGate() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#e0e0e0] dark:bg-[#0a0a0c] p-8">
      <div className="flex flex-col items-center text-center max-w-[360px] gap-4">
        <span className="size-14 rounded-2xl overflow-hidden shadow-lg">
          <img src="/brand/mark-light.png" alt="" className="size-full dark:hidden" />
          <img src="/brand/mark-dark.png" alt="" className="size-full hidden dark:block" />
        </span>
        <h1 className="text-[17px] font-semibold tracking-tight text-black/85 dark:text-white/90">
          OpenMock needs a bigger screen
        </h1>
        <p className="text-[13px] leading-relaxed text-black/55 dark:text-white/55">
          The editor is built for desktops, laptops and tablets in landscape. Open{' '}
          <span className="font-medium text-black/75 dark:text-white/75">openmock.app</span> on a larger screen
          and your projects will be waiting.
        </p>
        <a
          href="https://github.com/mehrantsi/openmock"
          target="_blank"
          rel="noreferrer"
          className="text-[12px] font-medium text-accent hover:underline"
        >
          Source on GitHub
        </a>
      </div>
    </div>
  )
}
