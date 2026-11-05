/**
 * ECharts 按需加载器
 *
 * 用动态 import，ECharts 会被 Vite 切成独立 chunk：不进主包，不影响首屏，
 * 也不用改 manualChunks（项目历史上手工分包导致过跨 chunk TDZ 错误）。
 * 不走 CDN：桌面端「单机/离线」模式必须能画图，CDN 必然失败。
 */

let loadPromise: Promise<any> | null = null

/** 加载 ECharts（幂等，重复调用复用同一 Promise）。 */
export function loadECharts(): Promise<any> {
  if (!loadPromise) {
    loadPromise = import('echarts')
      .then((mod: any) => mod?.default ?? mod)
      .catch((err) => {
        loadPromise = null
        throw err
      })
  }
  return loadPromise
}
