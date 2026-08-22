declare module 'mp4box' {
  export interface MP4VideoTrack {
    id: number
    codec: string
    timescale: number
    duration: number
    nb_samples: number
    track_width: number
    track_height: number
    matrix?: number[]
    video?: { width: number; height: number }
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrack[]
  }
  export interface MP4Sample {
    cts: number
    dts: number
    duration: number
    timescale: number
    is_sync: boolean
    data: Uint8Array
  }
  export interface MP4File {
    onReady: ((info: MP4Info) => void) | null
    onError: ((e: string) => void) | null
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): number
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void
    start(): void
    stop(): void
    flush(): void
    getTrackById(id: number): {
      mdia: { minf: { stbl: { stsd: { entries: Record<string, { write(s: DataStream): void } | undefined>[] } } } }
    }
  }
  export class DataStream {
    static BIG_ENDIAN: boolean
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
  }
  export const Log: { setLogLevel(level: unknown): void; error: unknown }
  export function createFile(): MP4File
}
