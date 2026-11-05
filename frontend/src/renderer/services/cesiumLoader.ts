/**
 * CesiumJS CDN 动态加载器。
 *
 * 与 Leaflet 的加载方式保持一致：仅在真正切换到 CesiumJS 地图时才从 CDN
 * 下载引擎，不进入 dist-renderer，桌面安装包不膨胀。3D Tiles / 地形本身
 * 需要联网访问 Cesium ion，CDN 加载不额外引入网络依赖。
 */

/** Cesium 版本（与《3D地图开发.docx》样例一致） */
export const CESIUM_VERSION = '1.146'

/** CDN 上 Cesium 构建目录（workers / assets / Widgets 都以此为基） */
export const CESIUM_CDN_BASE =
  `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`

/**
 * 内置默认 Cesium ion Access Token。
 * 作为出厂默认值写入用户设置；UI 展示一律脱敏，用户可更换为自己的 token。
 */
export const DEFAULT_CESIUM_ION_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJub25jZSI6IjlmdHZEemVySF82Q2hJMkwiLCJqdGkiOiJkOTQ3MjVkYS0xNjRiLTRlM2ItYmM0YS1mYWU1ZjFiMDQxMjQiLCJpZCI6NTIwMDc4LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTE2ODkzNjN9.' +
  'bzkCtf9HYKGdtQM0AjmdCofz_tG1LrgGCJUMO_1KFmU'

let loadPromise: Promise<any> | null = null

/**
 * 加载 Cesium（幂等，重复调用复用同一 Promise）。
 * 返回 window.Cesium 全局对象。
 */
export function loadCesium(): Promise<any> {
  if ((window as any).Cesium) {
    return Promise.resolve((window as any).Cesium)
  }
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    // workers / assets 基地址，必须在加载 Cesium.js 前设置
    const win = window as unknown as Record<string, unknown>
    win.CESIUM_BASE_URL = CESIUM_CDN_BASE

    // Widgets 样式
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${CESIUM_CDN_BASE}Widgets/widgets.css`
    document.head.appendChild(link)

    const script = document.createElement('script')
    script.src = `${CESIUM_CDN_BASE}Cesium.js`
    script.async = true
    script.onload = () => {
      const Cesium = (window as any).Cesium
      if (!Cesium) {
        loadPromise = null
        reject(new Error('Cesium 加载失败'))
        return
      }
      resolve(Cesium)
    }
    script.onerror = () => {
      loadPromise = null
      reject(new Error('加载 Cesium 失败'))
    }
    document.head.appendChild(script)
  })

  return loadPromise
}
