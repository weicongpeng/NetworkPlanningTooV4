/**
 * 并行分块下载工具
 *
 * 利用 HTTP Range 头将大文件分成多个块同时下载，
 * 突破单连接带宽限制（如 Cloudflare Tunnel 单连接限速）。
 *
 * 原理：
 * - Cloudflare Tunnel（cloudflared）单连接吞吐有限（ARM 软加密瓶颈）
 * - 同时打开 N 个 TCP 连接，每个下载一块，总吞吐 ≈ 单连接 × N
 * - 下载完成后在浏览器端拼接成完整文件
 *
 * 用法：
 *   import { parallelDownload } from '@/utils/parallelDownload'
 *   await parallelDownload(url, { filename: 'app.apk', chunks: 4 })
 */

const DEFAULT_CHUNKS = 4

interface ParallelDownloadOptions {
  filename?: string
  chunks?: number
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

interface ChunkResult {
  data: Blob
  index: number
}

/**
 * 直接触发浏览器/桌面壳下载（不打开新窗口）。
 * window.open 在 pywebview 桌面壳中会弹系统浏览器，这里统一用 a[download]。
 */
function triggerDownload(url: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename || url.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/**
 * 并行分块下载大文件
 * @param url 下载 URL（服务器必须支持 Accept-Ranges: bytes）
 * @param options 配置选项
 */
export async function parallelDownload(
  url: string,
  options: ParallelDownloadOptions = {},
): Promise<void> {
  const chunks = options.chunks || DEFAULT_CHUNKS
  const filename = options.filename || url.split('/').pop() || 'download'
  const onProgress = options.onProgress
  const signal = options.signal

  // 1. 获取文件信息和 Range 支持
  let totalSize: number
  let supportsRanges = true
  let finalFilename = filename

  try {
    const headResp = await fetch(url, {
      method: 'HEAD',
      signal,
    })

    if (!headResp.ok) {
      throw new Error(`服务器返回 ${headResp.status}`)
    }

    // 获取文件大小
    const contentLength = headResp.headers.get('content-length')
    totalSize = contentLength ? parseInt(contentLength, 10) : 0
    if (!totalSize || totalSize <= 0) {
      throw new Error('无法获取文件大小')
    }

    // 检查 Range 支持
    const acceptRanges = headResp.headers.get('accept-ranges')
    if (acceptRanges !== 'bytes') {
      supportsRanges = false
    }

    // 从 Content-Disposition 提取文件名
    const disposition = headResp.headers.get('content-disposition')
    if (disposition) {
      const match = disposition.match(/filename\*?=UTF-8''(.+?)(?:;|$)/i)
        || disposition.match(/filename="?(.+?)"?\s*(?:;|$)/i)
      if (match) {
        finalFilename = decodeURIComponent(match[1])
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') throw err
    console.warn('[parallelDownload] HEAD 请求失败，回退到普通下载', err)
    // 回退：直接触发下载
    triggerDownload(url, finalFilename)
    return
  }

  // 如果不支持 Range 或文件很小，使用普通下载
  if (!supportsRanges || totalSize < 1024 * 1024) {
    triggerDownload(url, finalFilename)
    return
  }

  // 2. 计算每块大小
  // 块数不能超过文件 MB 数（避免碎片太多）
  const safeChunks = Math.min(chunks, Math.max(1, Math.floor(totalSize / (1024 * 1024))))
  const chunkSize = Math.ceil(totalSize / safeChunks)

  // 3. 并行下载每个块
  const chunkPromises: Promise<ChunkResult>[] = []
  let loadedBytes = 0

  for (let i = 0; i < safeChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize - 1, totalSize - 1)

    chunkPromises.push(
      downloadChunk(url, start, end, i, signal)
        .then((result) => {
          loadedBytes += result.data.size
          onProgress?.(loadedBytes, totalSize)
          return result
        }),
    )
  }

  let chunksData: ChunkResult[]
  try {
    chunksData = await Promise.all(chunkPromises)
  } catch (err: any) {
    if (err.name === 'AbortError') throw err
    console.error('[parallelDownload] 分块下载失败，回退到普通下载', err)
    triggerDownload(url, finalFilename)
    return
  }

  // 4. 按顺序拼接
  chunksData.sort((a, b) => a.index - b.index)
  const blobs = chunksData.map(c => c.data)
  const combined = new Blob(blobs, { type: 'application/vnd.android.package-archive' })

  // 5. 触发浏览器下载
  const blobUrl = URL.createObjectURL(combined)
  try {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = finalFilename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    // 延迟释放 Blob URL，确保浏览器开始下载
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  }
}

/**
 * 下载单个块
 */
async function downloadChunk(
  url: string,
  start: number,
  end: number,
  index: number,
  signal?: AbortSignal,
): Promise<ChunkResult> {
  const resp = await fetch(url, {
    headers: {
      'Range': `bytes=${start}-${end}`,
    },
    signal,
  })

  if (!resp.ok && resp.status !== 206) {
    throw new Error(`分块 ${index} 下载失败: HTTP ${resp.status}`)
  }

  const blob = await resp.blob()
  return { data: blob, index }
}
