/**
 * 头像预处理：居中裁剪正方形 → 缩放 → 压缩成后端可存的 base64 data URL。
 *
 * 后端 im_service.normalize_avatar 只接受
 *   ^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$
 * 且解码后不超过 256KB。这里统一输出 image/jpeg，并把结果压到远低于上限的
 * AVATAR_SPEC.maxBytes，保证「选图 / 拍照」两条链路的产物都必然合规、必然可保存。
 */

export const AVATAR_SPEC = {
  size: 128,
  /** 压缩目标（解码后字节），留足余量以避开代理/隧道对大请求体的限制 */
  maxBytes: 96 * 1024,
  mime: 'image/jpeg' as const,
} as const

/** 与后端 normalize_avatar 完全一致的格式校验，保存前可本地预检 */
export const AVATAR_DATA_URL_RE =
  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** data URL 解码后的真实字节数（不依赖 atob，避免超大串再拷贝一份进内存） */
export function avatarDecodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = (b64.match(/=+$/) || [''])[0].length
  return Math.floor((b64.length * 3) / 4) - padding
}

/** 保存前本地预检：格式 + 体积都必须符合后端规范 */
export function validateAvatarDataUrl(dataUrl: string): boolean {
  return AVATAR_DATA_URL_RE.test(dataUrl)
    && avatarDecodedBytes(dataUrl) <= 256 * 1024
}

function readAsDataUrl(source: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      if (result.startsWith('data:')) resolve(result)
      else reject(new Error('IM_AVATAR_READ'))
    }
    reader.onerror = () => reject(new Error('IM_AVATAR_READ'))
    reader.readAsDataURL(source)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('IM_AVATAR_READ'))
    el.src = dataUrl
  })
}

function encode(image: HTMLImageElement, size: number, quality: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('IM_AVATAR_CANVAS')
  // JPEG 无 alpha 通道：先铺白底，避免透明区域被编码成黑块
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  ctx.imageSmoothingQuality = 'high'
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  const sx = (image.naturalWidth - side) / 2
  const sy = (image.naturalHeight - side) / 2
  ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size)
  return canvas.toDataURL('image/jpeg', quality)
}

/** File（选图）或 Blob（相机拍照帧）都可作为来源 */
export async function prepareAvatar(source: Blob): Promise<string> {
  if (source instanceof File && source.type && !source.type.startsWith('image/')) {
    throw new Error('IM_AVATAR_TYPE')
  }
  const image = await loadImage(await readAsDataUrl(source))
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  if (!side) throw new Error('IM_AVATAR_READ')

  // 逐级降尺寸 / 降质量，直到产物远低于后端上限；绝大多数图在 128×128@0.82 即达标
  for (const size of [AVATAR_SPEC.size, 96, 64]) {
    for (const quality of [0.82, 0.7, 0.55]) {
      const output = encode(image, size, quality)
      if (avatarDecodedBytes(output) <= AVATAR_SPEC.maxBytes) {
        if (!validateAvatarDataUrl(output)) throw new Error('IM_AVATAR_CANVAS')
        return output
      }
    }
  }
  throw new Error('IM_AVATAR_TOO_LARGE')
}

/** 从 <video>（相机预览）抓一帧，复用同一套压缩/校验链路 */
export async function prepareAvatarFromVideo(video: HTMLVideoElement): Promise<string> {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) throw new Error('IM_AVATAR_READ')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('IM_AVATAR_CANVAS')
  ctx.drawImage(video, 0, 0, w, h)
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('IM_AVATAR_CANVAS')
  return prepareAvatar(blob)
}
