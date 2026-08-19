export function uid(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${uuid}`
}

export const sceneId = () => uid('scene')
export const keyframeId = () => uid('kf')
export const videoId = () => uid('vid')
export const audioId = () => uid('aud')
export const audioClipId = () => uid('aclip')
