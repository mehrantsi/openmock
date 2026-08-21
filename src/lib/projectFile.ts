/**
 * .openmock project files — a whole project in one portable file:
 *
 *   bytes 0–7    ASCII magic "OPENMOCK"
 *   bytes 8–11   u32 LE header byte length
 *   next         UTF-8 JSON header { format, doc, media: [{ key, type, size }] }
 *   then         media blobs concatenated in listed order
 *
 * `doc` is the autosave document. Logo/text/background images already live in
 * it as data URLs; only IndexedDB-backed media (shot screenshots, videos,
 * audio) travels as binary parts. On import every media id is re-minted so an
 * opened file never collides with blobs already in this browser's storage.
 */

import { getMediaBlob, saveMediaBlob } from './media'
import { uid } from './ids'
import { buildProjectDoc, useProject, type ProjectDoc } from '../state/project'
import { useViewportRatio } from '../state/settings'
import { saveBlob } from '../export/download'

export const PROJECT_FILE_EXT = '.openmock'

const MAGIC = 'OPENMOCK'
const FORMAT = 1
const MAX_HEADER_BYTES = 64 * 1024 * 1024

interface MediaEntry {
  key: string
  type: string
  size: number
}

interface FileHeader {
  format: number
  doc: ProjectDoc
  media: MediaEntry[]
}

function collectMediaKeys(doc: ProjectDoc): string[] {
  const keys = new Set<string>()
  for (const sc of doc.timeline.scenes) if (sc.imageKey) keys.add(sc.imageKey)
  for (const v of doc.videos) keys.add(v.mediaKey ?? `media:${v.id}`)
  for (const a of doc.audios) keys.add(a.mediaKey ?? `media:${a.id}`)
  return [...keys]
}

export async function buildProjectFile(): Promise<Blob> {
  const doc = buildProjectDoc()
  const media: MediaEntry[] = []
  const parts: Blob[] = []
  for (const key of collectMediaKeys(doc)) {
    const blob = await getMediaBlob(key)
    if (!blob) continue
    media.push({ key, type: blob.type, size: blob.size })
    parts.push(blob)
  }
  const enc = new TextEncoder()
  const header = enc.encode(JSON.stringify({ format: FORMAT, doc, media } satisfies FileHeader))
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, header.byteLength, true)
  return new Blob([enc.encode(MAGIC), len, header, ...parts], { type: 'application/octet-stream' })
}

export async function saveProjectFile(): Promise<void> {
  const file = await buildProjectFile()
  saveBlob(file, `openmock-${new Date().toISOString().slice(0, 10)}${PROJECT_FILE_EXT}`)
}

export function isProjectFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(PROJECT_FILE_EXT)
}

/** Parse and load a project file. Returns an error message, or null on success. */
export async function openProjectFile(file: Blob): Promise<string | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (head.byteLength < 12 || new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) {
      return 'Not an OpenMock project file.'
    }
    const headerLen = new DataView(head.buffer, 8, 4).getUint32(0, true)
    if (!headerLen || headerLen > MAX_HEADER_BYTES || 12 + headerLen > file.size) {
      return 'This project file is damaged.'
    }
    const header = JSON.parse(
      new TextDecoder().decode(await file.slice(12, 12 + headerLen).arrayBuffer()),
    ) as FileHeader
    if (header.format !== FORMAT || !header.doc || !Array.isArray(header.media)) {
      return 'This project file needs a newer version of OpenMock.'
    }

    // re-mint media ids (ids are uuid-based, so text-level replacement is
    // exact) and rewrite every reference in the doc in one pass
    let json = JSON.stringify(header.doc)
    const keyMap = new Map<string, string>()
    for (const m of header.media) {
      if (typeof m.key !== 'string' || typeof m.size !== 'number' || m.size < 0) {
        return 'This project file is damaged.'
      }
      const oldId = m.key.startsWith('media:') ? m.key.slice(6) : m.key
      const newId = uid(oldId.split('-')[0] || 'med')
      json = json.replaceAll(oldId, newId)
      keyMap.set(m.key, m.key.replaceAll(oldId, newId))
    }
    const doc = JSON.parse(json) as ProjectDoc

    let offset = 12 + headerLen
    for (const m of header.media) {
      if (offset + m.size > file.size) return 'This project file is damaged.'
      await saveMediaBlob(keyMap.get(m.key) ?? m.key, file.slice(offset, offset + m.size, m.type))
      offset += m.size
    }

    if (!useProject.getState().loadProject(doc)) return 'This project file has no shots in it.'
    if (typeof doc.viewportRatio === 'string' && doc.viewportRatio) {
      useViewportRatio.getState().setRatio(doc.viewportRatio)
    }
    return null
  } catch {
    return 'This project file could not be read.'
  }
}
