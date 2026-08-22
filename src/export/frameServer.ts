/**
 * WebCodecs frame server: demux MP4/MOV with mp4box and decode with
 * VideoDecoder, serving the exact frame for any source time. Deterministic
 * replacement for seeking a hidden <video> per frame — Safari's media decoder
 * stops presenting new frames under rapid seek-and-capture, which froze
 * exported screens. Callers fall back to the element path when the container
 * or codec can't be served (WebM, unsupported profiles, parse failures).
 */

import * as MP4Box from 'mp4box'

interface SampleRef {
  /** decode-order index */
  idx: number
  /** presentation timestamp, µs (also the decoded VideoFrame timestamp) */
  ctsUs: number
  durUs: number
  keyframe: boolean
  data: Uint8Array
}

/**
 * Samples fed past the target: covers decoder reordering AND keeps the
 * decoder busy ahead of the export playhead so decode overlaps with
 * render + encode instead of serializing with them.
 */
const LOOKAHEAD = 48
/** Decoded frames held for upcoming targets (decoder frame pools are small). */
const CACHE_MAX = 12
/** Cap on cached + in-flight frames so lookahead can never outrun the cache. */
const OUTSTANDING_MAX = 10

function trackDescription(file: MP4Box.MP4File, trackId: number): Uint8Array | null {
  const trak = file.getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // strip the box header
    }
  }
  return null
}

/** 0 | 90 | 180 | 270 from the track's display matrix. */
function trackRotation(matrix?: number[]): number {
  if (!matrix || matrix.length < 9) return 0
  // fixed-point 16.16; matrix = [a b u c d v x y w]
  const a = matrix[0] / 65536
  const b = matrix[1] / 65536
  if (Math.abs(a - 1) < 0.01 && Math.abs(b) < 0.01) return 0
  if (Math.abs(a) < 0.01 && Math.abs(b - 1) < 0.01) return 90
  if (Math.abs(a + 1) < 0.01 && Math.abs(b) < 0.01) return 180
  if (Math.abs(a) < 0.01 && Math.abs(b + 1) < 0.01) return 270
  return 0
}

export class VideoFrameServer {
  /** display dimensions (rotation applied) */
  readonly width: number
  readonly height: number
  readonly durationSec: number

  private samples: SampleRef[]
  /** presentation order (indices into `samples`) */
  private ptsOrder: SampleRef[]
  private config: VideoDecoderConfig
  private rotation: number
  private decoder: VideoDecoder | null = null
  private nextFeed = 0
  private lastTargetIdx = -1
  private cache = new Map<number, VideoFrame>()
  private current: VideoFrame | null = null
  private wantedUs = -1
  private waiting: { resolve: (f: VideoFrame | null) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private dead = false

  private constructor(
    samples: SampleRef[],
    config: VideoDecoderConfig,
    rotation: number,
    codedW: number,
    codedH: number,
  ) {
    this.samples = samples
    this.ptsOrder = [...samples].sort((x, y) => x.ctsUs - y.ctsUs)
    this.config = config
    this.rotation = rotation
    const rotated = rotation === 90 || rotation === 270
    this.width = rotated ? codedH : codedW
    this.height = rotated ? codedW : codedH
    const last = this.ptsOrder[this.ptsOrder.length - 1]
    this.durationSec = (last.ctsUs + last.durUs) / 1e6
  }

  static async create(blob: Blob): Promise<VideoFrameServer | null> {
    if (typeof VideoDecoder === 'undefined') {
      console.info('[openmock export] frame server: no VideoDecoder')
      return null
    }
    try {
      MP4Box.Log.setLogLevel(MP4Box.Log.error)
      const buf = (await blob.arrayBuffer()) as ArrayBuffer & { fileStart: number }
      buf.fileStart = 0
      const file = MP4Box.createFile()
      let info: MP4Box.MP4Info | null = null
      let mp4Error: string | null = null
      const samples: SampleRef[] = []
      file.onError = (e) => {
        mp4Error = e
      }
      file.onSamples = (_id, _user, batch) => {
        for (const s of batch) {
          samples.push({
            idx: samples.length,
            ctsUs: Math.round((s.cts * 1e6) / s.timescale),
            durUs: Math.round((s.duration * 1e6) / s.timescale),
            keyframe: s.is_sync,
            data: s.data,
          })
        }
      }
      // extraction must be registered inside onReady (mid-append) or samples
      // from moov-at-end files are discarded before start() is ever called
      file.onReady = (i) => {
        info = i
        const track = i.videoTracks?.[0]
        if (track?.nb_samples) {
          file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples })
          file.start()
        }
      }
      file.appendBuffer(buf)
      file.flush()
      if (mp4Error || !info) {
        console.info('[openmock export] frame server: parse failed', mp4Error)
        return null
      }
      const track = (info as MP4Box.MP4Info).videoTracks?.[0]
      if (!track || !track.nb_samples) {
        console.info('[openmock export] frame server: no video track')
        return null
      }
      if (samples.length === 0 || !samples.some((s) => s.keyframe)) {
        console.info('[openmock export] frame server: no samples extracted')
        return null
      }

      const description = trackDescription(file, track.id)
      const codedW = track.video?.width ?? track.track_width
      const codedH = track.video?.height ?? track.track_height
      const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: codedW,
        codedHeight: codedH,
        ...(description ? { description } : {}),
      }
      const support = await VideoDecoder.isConfigSupported(config).catch((e) => {
        console.info('[openmock export] frame server: isConfigSupported threw', String(e))
        return null
      })
      if (!support?.supported) {
        console.info('[openmock export] frame server: config unsupported', config.codec, 'desc:', !!config.description)
        return null
      }
      return new VideoFrameServer(samples, config, trackRotation(track.matrix), codedW, codedH)
    } catch {
      return null
    }
  }

  /**
   * The decoded frame covering source time `tSec`. Owned by the server —
   * valid until the next frameAt call. Null only on decode failure (callers
   * should fall back to their previous frame).
   */
  async frameAt(tSec: number): Promise<VideoFrame | null> {
    if (this.dead) return null
    const tUs = Math.max(0, Math.round(tSec * 1e6))
    // last presented sample with cts <= t (clamped to the first sample)
    let lo = 0
    let hi = this.ptsOrder.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.ptsOrder[mid].ctsUs <= tUs) lo = mid
      else hi = mid - 1
    }
    const target = this.ptsOrder[lo]
    if (this.current && this.current.timestamp === target.ctsUs) {
      this.lastTargetIdx = target.idx
      this.pump(target.idx)
      return this.current
    }

    // stale cache entries (behind the new target) are dead weight
    for (const [ts, f] of this.cache) {
      if (ts < target.ctsUs) {
        f.close()
        this.cache.delete(ts)
      }
    }

    // (re)start from the right keyframe when moving backward (loop wrap) or
    // jumping far ahead of the last served position
    const needsRestart =
      !this.decoder ||
      this.decoder.state === 'closed' ||
      this.lastTargetIdx < 0 ||
      target.idx < this.lastTargetIdx ||
      target.idx > Math.max(this.lastTargetIdx, this.nextFeed) + 240
    if (needsRestart) {
      try {
        this.decoder?.close()
      } catch {
        // already closed
      }
      this.decoder = this.makeDecoder()
      this.clearCache()
      let key = 0
      for (let i = target.idx; i >= 0; i--) {
        if (this.samples[i].keyframe) {
          key = i
          break
        }
      }
      this.nextFeed = key
    }
    this.lastTargetIdx = target.idx

    // pipelined fast path: the frame was decoded ahead of time
    const hit = this.cache.get(target.ctsUs)
    if (hit) {
      this.cache.delete(target.ctsUs)
      this.current?.close()
      this.current = hit
      this.pump(target.idx)
      return hit
    }

    return new Promise<VideoFrame | null>((resolve) => {
      const timer = setTimeout(() => {
        // decoder wedged — give up on the server so callers fall back
        console.info('[openmock export] frame server: decoder wedged at', tSec.toFixed(2), 's — dead')
        this.waiting = null
        this.dead = true
        resolve(null)
      }, 10000)
      this.waiting = { resolve, timer }
      this.wantedUs = target.ctsUs
      this.pump(target.idx)
    })
  }

  private makeDecoder(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: () => {
        this.dead = true
        this.settle(null)
      },
    })
    // keep feeding as the queue drains while a request is outstanding
    decoder.ondequeue = () => {
      if (this.waiting) this.pump(this.lastTargetIdx)
    }
    decoder.configure(this.config)
    return decoder
  }

  private pump(targetIdx: number): void {
    if (!this.decoder || this.decoder.state !== 'configured') return
    const stop = Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD)
    while (this.nextFeed <= stop && this.decoder.decodeQueueSize + this.cache.size < OUTSTANDING_MAX) {
      const s = this.samples[this.nextFeed++]
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.keyframe ? 'key' : 'delta',
          timestamp: s.ctsUs,
          duration: s.durUs,
          data: s.data,
        }),
      )
    }
    // true end of stream: flush so the reorder tail drains
    if (this.nextFeed >= this.samples.length && this.waiting) {
      void this.decoder.flush().catch(() => {})
    }
  }

  private onFrame(frame: VideoFrame): void {
    const end = frame.timestamp + (frame.duration ?? 0)
    const wanted = this.wantedUs
    if (wanted >= 0 && (frame.timestamp === wanted || (frame.timestamp < wanted && end > wanted))) {
      this.current?.close()
      this.current = frame
      this.settle(frame)
    } else if (
      frame.timestamp > (wanted >= 0 ? wanted : this.current?.timestamp ?? -1) &&
      this.cache.size < CACHE_MAX
    ) {
      // decoded ahead — keep for an upcoming target
      this.cache.set(frame.timestamp, frame)
    } else {
      frame.close()
    }
    if (this.waiting) this.pump(this.lastTargetIdx)
  }

  private clearCache(): void {
    for (const f of this.cache.values()) f.close()
    this.cache.clear()
  }

  private settle(frame: VideoFrame | null): void {
    const w = this.waiting
    if (!w) return
    this.waiting = null
    this.wantedUs = -1
    clearTimeout(w.timer)
    w.resolve(frame)
  }

  /** Draw the current frame into a 2D context, honoring container rotation. */
  drawTo(ctx: CanvasRenderingContext2D, frame: VideoFrame, w: number, h: number): void {
    if (this.rotation === 0) {
      ctx.drawImage(frame, 0, 0, w, h)
      return
    }
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate((this.rotation * Math.PI) / 180)
    const swap = this.rotation === 90 || this.rotation === 270
    ctx.drawImage(frame, -(swap ? h : w) / 2, -(swap ? w : h) / 2, swap ? h : w, swap ? w : h)
    ctx.restore()
  }

  dispose(): void {
    this.dead = true
    this.settle(null)
    this.clearCache()
    this.current?.close()
    this.current = null
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
    this.samples = []
    this.ptsOrder = []
  }
}
