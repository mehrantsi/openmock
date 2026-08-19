/**
 * Engine lifecycle + render scheduling for the viewport.
 *
 * - Creates the OpenMock engine on the mounted canvas (onLiftClamp writes
 *   scene.lift back into the dials as a system edit).
 * - Sizes the drawing buffer from CSS size × DPR (DPR 1.5 while interacting,
 *   min(devicePixelRatio, 2) otherwise) via a ResizeObserver.
 * - Renders on demand: any project/theme change schedules one rAF paint; a
 *   self-perpetuating loop runs only while a time-animated effect needs it
 *   (grain > 0, glass border) and playback isn't already driving frames.
 * - Playback path: `renderAt(pt, playing)` samples the timeline
 *   (shotRenderParams) and swaps shot media (image cache / video pool);
 *   text & logo shots publish to the playbackView store instead of drawing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createEngine, type OpenMockEngine } from '../../three/engine'
import type { RenderState, Shot } from '../../state/types'
import { toRenderParams, type RuntimeOverrides } from '../../three/renderParams'
import { frameStackAtTime, shotRenderParams, transitionOpacity } from '../../video/interpolate'
import type { ShotVideoElements } from '../../video/playbackEngine'
import { useProject } from '../../state/project'
import { usePlayback } from '../../state/playback'
import { useUI } from '../../state/ui'
import { toast } from '../toast'
import { getImageAnalysis, getLoadedImage, loadImageForKey, loadImageUrl } from './mediaCache'
import { setViewportEngine } from './engineRef'
import { registerViewportEngine } from '../../export/useExport'
import { usePlaybackView } from './playbackView'

export type WebglError = 'unsupported' | 'lost' | null

export interface ModelLoadingState {
  id: string
  progress: number
}

export interface EngineHost {
  /** attach as the canvas ref */
  setCanvas(el: HTMLCanvasElement | null): void
  /** the mounted canvas element (null before mount) */
  canvasEl: HTMLCanvasElement | null
  engineRef: React.RefObject<OpenMockEngine | null>
  /** schedule one on-demand paint (no-op while playback drives frames) */
  requestRender(): void
  /** playback render callback (wired into usePlaybackEngine.renderFrame) */
  renderAt(pt: number, playing: boolean): void
  /** pointer/wheel interaction flag — degrades DPR to 1.5 */
  setInteracting(v: boolean): void
  webglError: WebglError
  modelLoading: ModelLoadingState | null
}

export function useEngine(videos: ShotVideoElements): EngineHost {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [webglError, setWebglError] = useState<WebglError>(null)
  const [modelLoading, setModelLoading] = useState<ModelLoadingState | null>(null)

  const engineRef = useRef<OpenMockEngine | null>(null)
  const videosRef = useRef(videos)
  videosRef.current = videos

  const stateRef = useRef({
    cssW: 0,
    cssH: 0,
    interacting: false,
    raf: 0,
    lastPt: 0,
    /** user edited dials since the last playback-driven frame — while paused,
     * render live dials instead of the parked sample */
    editedSincePark: false,
    mediaTag: '',
    pendingMediaTag: '',
    bgUrl: null as string | null,
    bgBlur: -1,
    mockupBgUrl: null as string | null,
    modelId: '',
    envId: '',
    preloadedScenes: null as Shot[] | null,
  })

  const api = useMemo<Omit<EngineHost, 'webglError' | 'modelLoading' | 'setCanvas'>>(() => {
    const st = stateRef.current

    const applySize = () => {
      const engine = engineRef.current
      if (!engine || st.cssW <= 0 || st.cssH <= 0) return
      const ratio = st.interacting ? 1.5 : Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(st.cssW * ratio)
      const h = Math.round(st.cssH * ratio)
      const prev = engine.getSize()
      engine.resize(w, h)
      // mutating canvas dimensions CLEARS the drawing buffer — without an
      // immediate repaint the viewport shows nothing until the next paint
      if (prev.width !== w || prev.height !== h) requestRender()
    }

    /** async model/env/bg-image assets, change-driven off the global dials */
    const syncSceneAssets = (d: RenderState) => {
      const engine = engineRef.current
      if (!engine) return

      const bgUrl = d.bgMode === 'image' ? d.bgImage : null
      if (bgUrl !== st.bgUrl) {
        st.bgUrl = bgUrl
        if (!bgUrl) engine.setBgImage(null)
        else {
          void loadImageUrl(bgUrl).then((img) => {
            if (st.bgUrl === bgUrl && engineRef.current && img) {
              engineRef.current.setBgImage(img)
              requestRender()
            }
          })
        }
      }
      if (d.bgBlur !== st.bgBlur) {
        st.bgBlur = d.bgBlur
        engine.setBgBlur(d.bgBlur)
      }

      const mockupBgUrl = d.mockupBgMode === 'image' ? d.mockupBgImage : null
      if (mockupBgUrl !== st.mockupBgUrl) {
        st.mockupBgUrl = mockupBgUrl
        if (!mockupBgUrl) engine.setMockupBgImage(null)
        else {
          void loadImageUrl(mockupBgUrl).then((img) => {
            if (st.mockupBgUrl === mockupBgUrl && engineRef.current && img) {
              engineRef.current.setMockupBgImage(img)
              requestRender()
            }
          })
        }
      }

      if (d.mockupModel !== st.modelId) {
        st.modelId = d.mockupModel
        if (d.mockupModel) {
          engine
            .prepareModel(d.mockupModel)
            .then(() => requestRender())
            .catch(() => toast('Something went wrong loading the 3D model. Please try again.', 'error'))
        }
      }

      const envId = d.bgMode === 'environment' ? d.envId : ''
      if (envId !== st.envId) {
        st.envId = envId
        if (envId) {
          engine
            .prepareEnvironment(envId)
            .then(() => requestRender())
            .catch(() => {})
        }
      }
    }

    /** point the engine's media at this shot's screenshot / video clip */
    const ensureShotMedia = (shot: Shot | null) => {
      const engine = engineRef.current
      if (!engine) return
      const video = shot?.video
      const imageKey = shot?.imageKey
      const tag = video ? `video:${video.videoId}` : imageKey ? `img:${imageKey}` : 'none'
      if (tag === st.mediaTag) return

      if (video) {
        const el = videosRef.current.getVideoElement(video.videoId)
        if (!el) return
        if (el.readyState >= 1 && el.videoWidth > 0) {
          st.mediaTag = tag
          st.pendingMediaTag = ''
          engine.setMedia({ kind: 'video', element: el })
        } else if (st.pendingMediaTag !== tag) {
          st.pendingMediaTag = tag
          el.addEventListener(
            'loadedmetadata',
            () => {
              const e = engineRef.current
              if (!e || st.pendingMediaTag !== tag || st.mediaTag === tag) return
              st.mediaTag = tag
              st.pendingMediaTag = ''
              e.setMedia({ kind: 'video', element: el })
              requestRender()
            },
            { once: true },
          )
        }
        return
      }

      if (imageKey) {
        const img = getLoadedImage(imageKey)
        if (img) {
          st.mediaTag = tag
          st.pendingMediaTag = ''
          engine.setMedia({ kind: 'image', element: img })
        } else if (st.pendingMediaTag !== tag) {
          st.pendingMediaTag = tag
          void loadImageForKey(imageKey).then((loaded) => {
            const e = engineRef.current
            if (!e || !loaded || st.pendingMediaTag !== tag || st.mediaTag === tag) return
            st.mediaTag = tag
            st.pendingMediaTag = ''
            e.setMedia({ kind: 'image', element: loaded })
            requestRender()
          })
        }
        return
      }

      st.mediaTag = tag
      st.pendingMediaTag = ''
      engine.setMedia(null)
    }

    const runtimeFor = (shot: Shot | null): RuntimeOverrides => {
      const a = shot?.imageKey ? getImageAnalysis(shot.imageKey) : null
      return {
        time: performance.now() / 1000,
        mediaIsDark: a?.isDark ?? false,
        extrudeColor: a?.average,
      }
    }

    /**
     * Publish the visible card stack at `pt` to the playbackView store.
     * Returns the frame stack plus whether an opaque card hides the canvas.
     */
    const publishLayers = (pt: number) => {
      const p = useProject.getState()
      const fades = { fadeIn: p.fadeIn, fadeOut: p.fadeOut }
      const stack = frameStackAtTime(p.scenes, pt)
      const layers: { shotId: string; kind: 'text' | 'logo'; localSec: number; fade: number }[] = []
      const coversCanvas = !!stack.floor && !stack.floorIsEngine
      if (coversCanvas && stack.floor) {
        const s = p.scenes[stack.floor.sceneIndex]
        layers.push({
          shotId: s.id,
          kind: s.kind as 'text' | 'logo',
          localSec: stack.floor.localT * s.duration,
          fade: transitionOpacity(p.scenes, stack.floor.sceneIndex, stack.floor.localT, fades),
        })
      }
      for (const ov of stack.overlays) {
        const s = p.scenes[ov.sceneIndex]
        layers.push({
          shotId: s.id,
          kind: s.kind as 'text' | 'logo',
          localSec: ov.localT * s.duration,
          fade: transitionOpacity(p.scenes, ov.sceneIndex, ov.localT, fades),
        })
      }
      if (layers.length > 0) usePlaybackView.getState().set({ active: true, layers, coversCanvas })
      else usePlaybackView.getState().clear()
      return { stack, coversCanvas }
    }

    const renderAt = (pt: number, _playing: boolean) => {
      st.editedSincePark = false // playback owns the frame again
      st.lastPt = pt
      const p = useProject.getState()
      syncSceneAssets(p.dials)
      const fades = { fadeIn: p.fadeIn, fadeOut: p.fadeOut }
      const { stack, coversCanvas } = publishLayers(pt)
      if (coversCanvas) return // an opaque card hides the canvas entirely

      const engine = engineRef.current
      if (!engine) return
      const base = stack.floor && stack.floorIsEngine ? (p.scenes[stack.floor.sceneIndex] ?? null) : null
      ensureShotMedia(base)
      const rt = runtimeFor(base)
      const params =
        base && stack.floor ? shotRenderParams(p.scenes, stack.floor.sceneIndex, stack.floor.localT, fades, rt) : null
      engine.render(params ?? toRenderParams(p.dials, { ...rt, mockupOpacity: 0 }))
    }

    const renderLive = () => {
      const p = useProject.getState()
      syncSceneAssets(p.dials)
      const sel = p.scenes.find((x) => x.id === p.selectedSceneId) ?? null
      const t = usePlayback.getState().projectTime
      if (sel && (sel.kind === 'text' || sel.kind === 'logo')) {
        // cards carry no dials — the playhead frame is always the right view
        // (base + overlay stack; opaque cards cover the canvas)
        renderAt(t, false)
        return
      }
      // live dials drive the base; the card stack under the playhead stays up
      const { coversCanvas } = publishLayers(t)
      const engine = engineRef.current
      if (!engine) return
      ensureShotMedia(sel)
      if (!coversCanvas) engine.render(toRenderParams(p.dials, runtimeFor(sel)))
    }

    const needsLoop = () => {
      if (usePlayback.getState().phase === 'playing') return false
      const d = useProject.getState().dials
      return d.grain > 0 || d.borderStyle === 'glass'
    }

    const paint = () => {
      st.raf = 0
      const phase = usePlayback.getState().phase
      if (phase === 'playing') return // playback engine owns frames
      if (phase === 'paused' && !st.editedSincePark) renderAt(st.lastPt, false)
      else renderLive()
      if (needsLoop()) requestRender()
    }

    const requestRender = () => {
      if (st.raf) return
      st.raf = requestAnimationFrame(paint)
    }

    const setInteracting = (v: boolean) => {
      if (st.interacting === v) return
      st.interacting = v
      applySize()
      requestRender()
    }

    return {
      engineRef,
      requestRender,
      renderAt,
      setInteracting,
      // internal (not on the public type, reached via closure below)
      __applySize: applySize,
    } as Omit<EngineHost, 'webglError' | 'modelLoading' | 'setCanvas'> & { __applySize(): void }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- engine lifecycle ----------------------------------------------------
  useEffect(() => {
    if (!canvas) return
    const st = stateRef.current
    let engine: OpenMockEngine
    try {
      engine = createEngine(canvas, {
        onLiftClamp: (lift) => {
          const p = useProject.getState()
          if (Math.abs(p.dials.lift - lift) > 1e-4) {
            p.setDials({ lift }, { transient: true, system: true })
          }
        },
      })
    } catch {
      setWebglError('unsupported')
      return
    }
    engine.onModelLoad = (ev) => {
      setModelLoading(ev.loading ? { id: ev.id, progress: ev.progress } : null)
      if (!ev.loading) api.requestRender()
    }
    engineRef.current = engine
    setViewportEngine(engine)
    registerViewportEngine(engine)
    setWebglError(null)
    if (import.meta.env.DEV) {
      // dev-only debugging handle
      ;(window as unknown as Record<string, unknown>).__openmockEngine = engine
    }

    const onLost = (ev: Event) => {
      ev.preventDefault()
      setWebglError('lost')
    }
    canvas.addEventListener('webglcontextlost', onLost)

    // reset change-tracking so the new engine gets every asset again
    st.mediaTag = ''
    st.pendingMediaTag = ''
    st.bgUrl = null
    st.bgBlur = -1
    st.mockupBgUrl = null
    st.modelId = ''
    st.envId = ''
    ;(api as unknown as { __applySize(): void }).__applySize()
    api.requestRender()

    // staged post-mount repaints: async assets (HDRI lighting, cached models,
    // fonts reflowing the layout) land without their own render triggers, and
    // frames drawn before the first composite can be dropped by the browser —
    // these kicks guarantee a presented, fully-lit frame after startup
    const kicks = [120, 500, 1200, 2600, 5200].map((ms) => window.setTimeout(() => api.requestRender(), ms))

    return () => {
      for (const k of kicks) window.clearTimeout(k)
      canvas.removeEventListener('webglcontextlost', onLost)
      if (st.raf) {
        cancelAnimationFrame(st.raf)
        st.raf = 0
      }
      setViewportEngine(null)
      registerViewportEngine(null)
      engineRef.current = null
      engine.dispose()
    }
  }, [canvas, api])

  // ---- sizing ---------------------------------------------------------------
  useEffect(() => {
    if (!canvas) return
    const st = stateRef.current
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      st.cssW = rect.width
      st.cssH = rect.height
      ;(api as unknown as { __applySize(): void }).__applySize()
      api.requestRender()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvas, api])

  // ---- render triggers -------------------------------------------------------
  useEffect(() => {
    const st = stateRef.current
    let lastSeq = useProject.getState().dialEditSeq
    const unsubProject = useProject.subscribe((s) => {
      // pre-decode every shot screenshot so playback cuts don't flash
      if (s.scenes !== st.preloadedScenes) {
        st.preloadedScenes = s.scenes
        for (const shot of s.scenes) {
          if (shot.imageKey) void loadImageForKey(shot.imageKey)
        }
      }
      // a user-originated dial edit while parked takes over the frame:
      // render live dials until playback drives time again
      if (s.dialEditSeq !== lastSeq) {
        lastSeq = s.dialEditSeq
        if (s.lastDialEdit && !s.lastDialEdit.system && s.lastDialEdit.changed.length > 0) {
          st.editedSincePark = true
        }
      }
      api.requestRender()
    })
    const unsubUI = useUI.subscribe(() => api.requestRender())
    const unsubPlayback = usePlayback.subscribe((s, prev) => {
      if (s.phase !== prev.phase && s.phase !== 'playing') api.requestRender()
    })
    const onNeeded = () => api.requestRender()
    window.addEventListener('openmock:render-needed', onNeeded)
    return () => {
      unsubProject()
      unsubUI()
      unsubPlayback()
      window.removeEventListener('openmock:render-needed', onNeeded)
    }
  }, [api])

  return {
    setCanvas,
    canvasEl: canvas,
    engineRef,
    requestRender: api.requestRender,
    renderAt: api.renderAt,
    setInteracting: api.setInteracting,
    webglError,
    modelLoading,
  }
}
