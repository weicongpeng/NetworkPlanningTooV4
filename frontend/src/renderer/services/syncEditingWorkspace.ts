/**
 * 编辑态图层与服务器最新数据同步（共享模式 last-write-wins）。
 *
 * 背景：打开图层「编辑」开关后原图层被隐藏，地图上渲染的是编辑会话里的工作集
 * （打开编辑时的快照）。常规刷新路径（loadMapInfoLayers / syncGeoJsonLayers）
 * 只重建"可见"图层，编辑图层被天然跳过，导致同组其他用户保存后：
 *   - 编辑态下地图始终不更新，关闭编辑开关后才看到新内容。
 * 本模块在收到任何数据变更通知后，为当前编辑图层单独回源一次：
 *   - 服务器版本指纹（ETag）与工作集基底相同 → 数据未变（典型：自己保存后的
 *     变更广播回声），不重置，保留撤销历史；
 *   - 版本不同 → 以服务器最新整层数据重置工作集（丢弃未保存修改与撤销历史），
 *     即"最后修改成功的为准"；
 *   - 同时刷新图层缓存，关闭编辑开关恢复原图层时直接命中新数据，不再回源。
 * 装饰图层为本机手绘数据、无共享源文件，不参与同步。
 */
import { layerApi } from './api'
import { useMapDataCacheStore } from '../store/mapDataCacheStore'
import { DECORATION_LAYER_ID, useLayerEditStore } from '../store/layerEditStore'

export interface SyncEditingResult {
  layerId: string
  /** 服务器版本较新，工作集已被服务器数据整体替换 */
  updated: boolean
  /** 替换前工作集存在未保存修改（已被服务器最新内容覆盖） */
  hadUnsavedChanges: boolean
}

let inFlight: Promise<SyncEditingResult | null> | null = null

async function syncOnce(): Promise<SyncEditingResult | null> {
  try {
    const editStore = useLayerEditStore.getState()
    const layerId = editStore.editableLayerId
    if (!layerId || layerId === DECORATION_LAYER_ID) return null
    const ws = editStore.getWorkspace(layerId)
    if (!ws) return null

    const fetched = await layerApi.getLayerDataWithVersion(ws.dataId, layerId)
    const geojson = fetched?.data
    const features = geojson?.features
    if (!Array.isArray(features)) return null
    const etag = fetched.version ?? null

    // 版本相同：自己刚保存后的广播回声 / 数据确实未变。内容相同则重置没有收益，
    // 只会白白清空撤销栈，故跳过（右键「刷新」同理）。
    if (etag && ws.version && etag === ws.version) {
      return { layerId, updated: false, hadUnsavedChanges: false }
    }

    const hadUnsavedChanges = ws.dirty
    editStore.resetWorkspace(layerId, features, etag)
    // 刷新缓存（保留 bounds）：退出编辑恢复原图层时即为最新内容
    useMapDataCacheStore.getState().cacheLayerGeoJSON(layerId, geojson, etag)
    return { layerId, updated: true, hadUnsavedChanges }
  } catch (e) {
    console.warn('[编辑同步] 拉取编辑图层最新数据失败:', e)
    return null
  }
}

/**
 * 拉取当前编辑图层的服务器最新数据并按版本指纹同步工作集。
 * 并发调用（WS 推送 / 修订号轮询 / 桌面同步落地 / 右键「刷新」同时触发）
 * 共享同一次请求；调用之间（await 之后）inFlight 会释放，不影响后续同步。
 */
export function syncEditingWorkspaceFromServer(): Promise<SyncEditingResult | null> {
  // 不能在"被赋值的 IIFE"内用同步 finally 清理 inFlight：早退分支（无 await）
  // 同步跑完 finally 后，外层 inFlight = IIFE() 赋值又会把已完成的 Promise 写回，
  // 导致 inFlight 永久占用、后续所有调用命中第一次的旧结果。
  // 这里挂 Promise.prototype.finally 微任务清理：settle 后才执行，赋值必然已完成。
  if (!inFlight) {
    inFlight = syncOnce()
    inFlight.finally(() => { inFlight = null })
  }
  return inFlight
}
