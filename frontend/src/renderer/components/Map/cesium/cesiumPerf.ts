/**
 * 3D 渲染性能埋点。
 *
 * 只在开发环境输出、且只记录超过一帧（16ms）的操作，用于定位"拖动/缩放卡顿"的
 * 长任务来源（图层重建、标签重排等）。生产构建里 `import.meta.env.DEV` 为 false，
 * 函数直接返回，无运行时开销。
 */
const ENABLED = import.meta.env.DEV

export function perfStart(): number {
  return ENABLED ? performance.now() : 0
}

export function perfEnd(label: string, start: number, detail?: string): void {
  if (!ENABLED) return
  const ms = performance.now() - start
  if (ms < 16) return
  console.debug(`[3D perf] ${label}: ${ms.toFixed(1)}ms${detail ? ` (${detail})` : ''}`)
}
