import { create } from 'zustand'
import type { DrawGeometryType, DrawTool } from '@shared/types'

/** 装饰图层固定标识（无后端文件，数据持久化在 mapStore/localStorage） */
export const DECORATION_LAYER_ID = 'decoration-layer'
export const DECORATION_DATA_ID = '__decoration__'

/** 工作集几何类型：'mixed' = 混合图层（可同时含点/线/面） */
export type WorkspaceGeometryType = DrawGeometryType | 'mixed'

/**
 * 图层编辑工作集要素（GeoJSON Feature）。
 * 内部字段（保存时后端按旧表 schema 对齐、剔除，不写入 TAB）：
 *  - _editId: 编辑期稳定标识
 *  - _isNew: 用户绘制的新要素（样式取 drawStyleMap，而非图层原样式）
 */
export interface EditFeature {
  type: 'Feature'
  properties: Record<string, any>
  geometry: { type: string; coordinates: any }
}

/** 编辑会话中"新建"要素使用的样式（非新建沿用图层原配色）。字段与 drawStyleMap 各几何一致。 */
export interface EditBaseStyle {
  point: Record<string, any>
  line: Record<string, any>
  polygon: Record<string, any>
}

export interface LayerWorkspace {
  layerId: string
  dataId: string
  geometryType: WorkspaceGeometryType
  /** 图层原始渲染样式（非新建要素沿用它，保证配色不变） */
  baseStyle: EditBaseStyle | null
  features: EditFeature[]
  dirty: boolean
  changeCount: number   // 未保存增删改计数（用于角标）
  /** 撤销历史（要素快照栈；栈底为初始基线）。undo 弹栈恢复。 */
  history: EditFeature[][]
  /** 保存基底行号：editId → 要素在图层读取顺序中的下标；新增要素为 null */
  baseRows: Record<string, number | null>
  /** 本次保存前发生变化的要素（editId 集合，用于增量保存只回传变更部分） */
  changedIds: Record<string, true>
  /** 基底版本指纹（图层数据端点 ETag）；null 表示未知，只能整层保存 */
  version: string | null
  /** 基底要素数（服务端校验基底一致性用） */
  baseCount: number
}

/** 保存计划：增量（patch）/ 整层（full）/ 无需保存（none，如新增后又删除），以及对应的请求 payload */
export interface SavePlan {
  mode: 'patch' | 'full' | 'none'
  payload: { patch?: any; geojson?: any }
  /** 本次计划回传的变更数量（诊断/日志用） */
  changes: number
}

/** 单次增量保存允许的变更要素上限（与服务端 _MAX_CHANGES 对齐） */
const MAX_PATCH_CHANGES = 20000

const HISTORY_LIMIT = 100

/**
 * 用户属性字段名校验保留键（与后端 layer_edit/layer_patch 契约对齐）：
 * 绘制样式输入键 + 样式持久化列，这些键由样式通道承载，不能作为普通属性列。
 * 另：'_' 开头一律为内部字段，直接拒绝。
 */
const RESERVED_ATTR_KEYS = new Set([
  'markerColor', 'markerSize', 'markerSymbol', 'markerRadius', 'markerIconPx',
  'borderColor', 'borderWidth', 'borderDash',
  'fillColor', 'fillOpacity',
  'color', 'weight', 'opacity', 'dashArray', 'shape',
  'NPT_FEATSYM', 'NPT_FEATMETA',
  '_editId', '_style', '_nptSelectionId',
])

/** MapInfo TAB 字段名长度上限（传统限制 31 字符） */
const MAX_ATTR_KEY_LEN = 31

/** 单图层属性列上限（与服务端 _MAX_NEW_COLUMNS 对齐） */
const MAX_ATTR_COLUMNS = 200

/** addFeatureAttribute 的错误码（UI 层负责翻译） */
export type AttributeErrorCode =
  | 'noWorkspace' | 'empty' | 'invalidName' | 'internal' | 'reserved'
  | 'exists' | 'tooLong' | 'tooMany' | 'noFeature'

/**
 * MapInfo TAB 合法字段名：字母/下划线/中文开头，后接字母/数字/下划线/中文。
 * 与后端 layer_service._MAPINFO_INVALID + 数字开头规则对齐
 * （真实列名原样写入 TAB，非法名会导致表无法打开）。
 */
const VALID_ATTR_KEY = /^[A-Za-z_一-鿿][\w一-鿿]*$/

/** 双击要素后需要查看/配置风格的要素快照（编辑态用 editId，非编辑态直接带 geometry） */
export interface InspectFeature {
  layerId: string
  layerName?: string
  editId?: string
  name?: string
  /** GeoJSON 几何（GeoJSON.Geometry） */
  geometry: any
  properties?: Record<string, any>
  /** 该图层是否处于编辑态（决定风格配置能否写回要素） */
  editable: boolean
}

/** 复制粘贴剪贴板中的要素（圈选后复制；坐标为渲染坐标 GCJ02） */
export interface CopiedFeature {
  geometry: { type: string; coordinates: any }
  properties: Record<string, any>
  /** 来源图层名（粘贴提示用） */
  sourceLayerName?: string
}

interface LayerEditState {
  editableLayerId: string | null
  drawTool: DrawTool
  /** 工具栏"选择"工具激活态（与绘制/圈选/测距/打点/拖拽互斥） */
  selectMode: boolean
  /** 节点自动捕获开关（S 键 / 工具栏"节点捕获"按钮共用；不依赖编辑开关，不与其他工具互斥） */
  snapEnabled: boolean
  /** "节点合并"模式：拖框把可编辑边框对齐到参考图层边框（与绘制/选择互斥） */
  nodeMergeMode: boolean
  /** 双击要素打开的属性/风格配置弹窗数据源 */
  inspectFeature: InspectFeature | null
  workspaces: Record<string, LayerWorkspace>
  /** 跨图层复制粘贴剪贴板 */
  clipboard: CopiedFeature[]

  setEditableLayerId: (id: string | null) => void
  setDrawTool: (tool: DrawTool) => void
  setSelectMode: (on: boolean) => void
  setSnapEnabled: (on: boolean) => void
  toggleSnapEnabled: () => void
  setNodeMergeMode: (on: boolean) => void
  /**
   * 批量提交节点合并结果：多个要素几何一次性写入，只压一条撤销历史
   * （一次框选对齐整体可被 Ctrl+Z 一次回退）。
   */
  applyMergeResult: (
    layerId: string,
    updates: Array<{ editId: string; geometry: EditFeature['geometry'] }>,
  ) => void
  setInspectFeature: (f: InspectFeature | null) => void
  copyToClipboard: (items: CopiedFeature[]) => void
  clearClipboard: () => void
  beginEdit: (
    layerId: string,
    dataId: string,
    geometryType: WorkspaceGeometryType,
    baseFeatures: EditFeature[],
    baseStyle?: EditBaseStyle | null,
    base?: { version?: string | null },
  ) => void
  /**
   * 仅播种工作集（不打开编辑开关）：供无后端来源的图层（装饰图层）从本地持久化恢复要素。
   * 已有工作集时保持不覆盖（与 beginEdit 的 existing 语义一致）。
   */
  seedWorkspace: (
    layerId: string,
    dataId: string,
    geometryType: WorkspaceGeometryType,
    baseFeatures: EditFeature[],
    baseStyle?: EditBaseStyle | null,
  ) => void
  addFeature: (layerId: string, geometry: EditFeature['geometry'], props?: Record<string, any>) => void
  /** 批量追加：一次 set、一次撤销历史（缓冲区结果批量写入用，避免逐个追加多次重渲染） */
  addFeatures: (
    layerId: string,
    items: Array<{ geometry: EditFeature['geometry']; properties?: Record<string, any> }>,
  ) => void
  deleteFeature: (layerId: string, editId: string) => void
  /** 批量删除：一次写入、一份历史快照（边界选择批量删除用，避免逐个删除 O(N²) 重建）。返回实际删除数 */
  deleteFeatures: (layerId: string, editIds: string[]) => number
  updateFeatureGeometry: (layerId: string, editId: string, geometry: EditFeature['geometry']) => void
  /** 写入单个要素的风格（properties._editStyle，与 MapInfo 自带 _style 区分），仅编辑态要素可用 */
  updateFeatureStyle: (layerId: string, editId: string, style: Record<string, any>) => void
  /** 合并写入单个要素的属性（如圆/椭圆 _shape/_ellipse 元数据），仅编辑态要素可用 */
  updateFeatureProperties: (layerId: string, editId: string, patch: Record<string, any>) => void
  /**
   * 图层级新增属性字段：工作集所有要素补齐该字段（目标要素填 value，其余填 null），
   * 仅目标要素标记变更（保存时后端追加表列，未回传要素列值默认空）。一次操作压一条历史。
   * @returns 错误码（见 AttributeErrorCode）；null 表示成功
   */
  addFeatureAttribute: (layerId: string, editId: string, key: string, value: string) => AttributeErrorCode | null

  undo: (layerId: string) => boolean
  canUndo: (layerId: string | null | undefined) => boolean
  markSaved: (layerId: string, opts?: { remapRows?: boolean; version?: string | null }) => void
  discardWorkspace: (layerId: string) => void
  getWorkspace: (layerId: string | null | undefined) => LayerWorkspace | undefined
  isDirty: (layerId: string) => boolean
}

function genEditId(): string {
  return `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 基底行号表：editId → 要素在图层读取顺序中的下标（与 TAB 行序一致）。 */
function buildBaseRows(features: EditFeature[]): Record<string, number | null> {
  const rows: Record<string, number | null> = {}
  features.forEach((f, i) => {
    const id = f.properties?._editId
    if (id) rows[id] = i
  })
  return rows
}

/** 标记要素为已变更（增量保存只回传这些要素）。 */
function markChanged(ws: LayerWorkspace, editId: string | undefined): Record<string, true> {
  if (!editId || ws.changedIds[editId]) return ws.changedIds
  return { ...ws.changedIds, [editId]: true }
}

/**
 * 生成保存计划：
 * - 能增量则增量（有基底版本指纹 + 存在变更集），只回传变更要素与删除行号
 * - 否则整层保存（新建图层/无版本指纹/变更集缺失时，保证不丢改动）
 *
 * allowPatch=false 时强制整层保存：Shapefile/GeoJSON 的样式落在 .qml，后端增量
 * 保存只支持 TAB，直接走整层避免每次都先吃一次 409 回退。
 */
export function buildSavePlan(ws: LayerWorkspace, opts?: { allowPatch?: boolean }): SavePlan {
  const upserts: any[] = []
  const present = new Set<string>()
  for (const f of ws.features) {
    const id = f.properties?._editId
    if (!id) continue
    present.add(id)
    if (ws.changedIds[id] || ws.baseRows[id] === null || ws.baseRows[id] === undefined) {
      upserts.push({ row: ws.baseRows[id] ?? null, geometry: f.geometry, properties: f.properties })
    }
  }
  const deletes = Object.entries(ws.baseRows)
    .filter(([id, row]) => row !== null && !present.has(id))
    .map(([, row]) => row as number)

  // 无任何有效变更（如绘制后立即删除）：无需写盘，避免为"空改动"整层上传
  if (upserts.length + deletes.length === 0) {
    return { mode: 'none', changes: 0, payload: {} }
  }

  const canPatch = opts?.allowPatch !== false
    && !!ws.version
    && Object.keys(ws.baseRows).length > 0
    && upserts.length + deletes.length > 0
    && upserts.length <= MAX_PATCH_CHANGES
    && deletes.length <= MAX_PATCH_CHANGES

  if (canPatch) {
    return {
      mode: 'patch',
      changes: upserts.length + deletes.length,
      payload: {
        patch: {
          base: { count: ws.baseCount, version: ws.version },
          upserts,
          deletes,
        },
      },
    }
  }
  return {
    mode: 'full',
    changes: ws.changeCount,
    payload: { geojson: { type: 'FeatureCollection', features: ws.features } },
  }
}

/**
 * 图层既有用户属性键（任一要素上的非内部/非保留键，按首次出现顺序去重）。
 * 新要素据此继承字段（null 占位）、属性面板"添加属性"的存在性校验也据此判定，
 * 两处同源：手绘要素的字段集合与既有要素保持一致，不会出现"面板看不到字段却提示已存在"。
 */
function collectUserAttrKeys(features: EditFeature[]): string[] {
  const keys = new Set<string>()
  for (const f of features) {
    for (const k of Object.keys(f.properties || {})) {
      if (!k.startsWith('_') && !RESERVED_ATTR_KEYS.has(k)) keys.add(k)
    }
  }
  return [...keys]
}

/** 为基础要素补齐 _editId（已有的保持不变），不标 _isNew（保留图层原配色）。 */
function withEditIds(features: EditFeature[]): EditFeature[] {
  return features.map((f) => ({
    ...f,
    properties: { ...(f.properties || {}), _editId: f.properties?._editId || genEditId() },
  }))
}

/** 变更前压入当前要素快照（限制栈深）。返回更新后的 history。 */
function pushHistory(ws: LayerWorkspace): EditFeature[][] {
  const h = [...ws.history]
  h.push(ws.features.map((f) => JSON.parse(JSON.stringify(f))))
  if (h.length > HISTORY_LIMIT) h.shift()
  return h
}

export const useLayerEditStore = create<LayerEditState>((set, get) => ({
  editableLayerId: null,
  drawTool: 'none',
  selectMode: false,
  snapEnabled: false,
  nodeMergeMode: false,
  inspectFeature: null,
  workspaces: {},
  clipboard: [],

  copyToClipboard: (items) => set({ clipboard: items }),
  clearClipboard: () => set({ clipboard: [] }),

  setEditableLayerId: (id) =>
    set((s) => ({
      editableLayerId: id,
      // 关闭编辑时仅退出绘制；"选择"工具是工具栏状态，不受控制面板图层开关影响
      drawTool: id ? s.drawTool : 'none',
      selectMode: s.selectMode,
      // 节点合并依赖编辑图层，关闭编辑时一并退出；节点捕获开关独立保留
      nodeMergeMode: id ? s.nodeMergeMode : false,
      inspectFeature: id ? s.inspectFeature : null,
    })),

  // 绘制与"选择"互斥：任一方激活都会关闭另一方
  setDrawTool: (tool) => set({ drawTool: tool, selectMode: false, nodeMergeMode: false }),

  setSelectMode: (on) => set((s) => ({
    selectMode: on,
    drawTool: on ? 'none' : s.drawTool,
    nodeMergeMode: false,
    inspectFeature: on ? s.inspectFeature : null,
  })),

  // 节点捕获：独立开关（S 键/工具栏共用），不与任何工具互斥
  setSnapEnabled: (on) => set({ snapEnabled: on }),
  toggleSnapEnabled: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

  // 节点合并：激活时退出绘制与"选择"，由会话接管左键拖框
  setNodeMergeMode: (on) => set((s) => ({
    nodeMergeMode: on,
    drawTool: on ? 'none' : s.drawTool,
    selectMode: false,
  })),

  applyMergeResult: (layerId, updates) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws || updates.length === 0) return s
      const changedIds = { ...ws.changedIds }
      for (const { editId } of updates) changedIds[editId] = true
      const nextFeatures = ws.features.map((f) => {
        const u = updates.find((x) => x.editId === f.properties?._editId)
        return u ? { ...f, geometry: u.geometry } : f
      })
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: nextFeatures,
            dirty: true,
            // 整次框选对齐只压一条历史：Ctrl+Z 一次回退全部
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
            changedIds,
          },
        },
      }
    }),

  setInspectFeature: (f) => set({ inspectFeature: f }),

  beginEdit: (layerId, dataId, geometryType, baseFeatures, baseStyle, base) =>
    set((s) => {
      const existing = s.workspaces[layerId]
      const features = existing
        ? existing.features // 已有工作集（切走后再切回）保留未保存更改
        : withEditIds(baseFeatures || [])
      return {
        editableLayerId: layerId,
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            layerId,
            dataId,
            geometryType,
            baseStyle: baseStyle ?? existing?.baseStyle ?? null,
            features,
            dirty: existing?.dirty ?? false,
            changeCount: existing?.changeCount ?? 0,
            history: existing?.history ?? [],
            baseRows: existing?.baseRows ?? buildBaseRows(features),
            changedIds: existing?.changedIds ?? {},
            version: existing ? existing.version : (base?.version ?? null),
            baseCount: existing?.baseCount ?? features.length,
          },
        },
      }
    }),

  seedWorkspace: (layerId, dataId, geometryType, baseFeatures, baseStyle) =>
    set((s) => {
      if (s.workspaces[layerId]) return s // 已有工作集（含未保存更改）不覆盖
      const features = withEditIds(baseFeatures || [])
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            layerId,
            dataId,
            geometryType,
            baseStyle: baseStyle ?? null,
            features,
            // 播种即基线：无未保存更改、无撤销历史，首次保存按整层/本地处理
            dirty: false,
            changeCount: 0,
            history: [],
            baseRows: buildBaseRows(features),
            changedIds: {},
            version: null,
            baseCount: features.length,
          },
        },
      }
    }),

  addFeature: (layerId, geometry, props) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      // props 可携带要素属性（如复制粘贴的原属性、圆/椭圆 _shape 元数据）；
      // _keepStyle 为内部标记：粘贴时保留原要素配色（不标 _isNew，避免被绘制样式覆盖）
      const { _keepStyle, ...userProps } = (props || {}) as any
      // 新要素继承图层既有属性字段（同名沿用传入值，其余补 null）：手绘要素的属性面板
      // 与既有要素字段一致，既有字段可直接填值。否则新要素只有内部字段 → 面板"暂无属性信息"，
      // 用户改用"添加属性"补既有字段名时被"字段已存在"拒绝（表现为手绘要素无法添加属性）。
      const inherited: Record<string, any> = {}
      for (const k of collectUserAttrKeys(ws.features)) {
        if (!(k in userProps)) inherited[k] = null
      }
      const properties: Record<string, any> = { ...inherited, ...userProps, _editId: genEditId() }
      if (!_keepStyle) properties._isNew = true
      const feature: EditFeature = { type: 'Feature', properties, geometry }
      const editId = properties._editId as string
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: [...ws.features, feature],
            dirty: true,
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
            // 新增要素：基底无对应行，增量保存时按"新增"回传
            baseRows: { ...ws.baseRows, [editId]: null },
            changedIds: markChanged(ws, editId),
          },
        },
      }
    }),

  addFeatures: (layerId, items) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws || items.length === 0) return s
      // 口径与逐个 addFeature 一致：继承图层既有属性字段、补 _editId/_isNew
      const newFeatures: EditFeature[] = []
      const addedRows: Record<string, null> = {}
      const addedChanges: Record<string, true> = {}
      for (const item of items) {
        const { _keepStyle, ...userProps } = (item.properties || {}) as any
        const inherited: Record<string, any> = {}
        for (const k of collectUserAttrKeys(ws.features)) {
          if (!(k in userProps)) inherited[k] = null
        }
        const properties: Record<string, any> = { ...inherited, ...userProps, _editId: genEditId() }
        if (!_keepStyle) properties._isNew = true
        const editId = properties._editId as string
        newFeatures.push({ type: 'Feature', properties, geometry: item.geometry })
        addedRows[editId] = null
        addedChanges[editId] = true
      }
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: [...ws.features, ...newFeatures],
            dirty: true,
            changeCount: ws.changeCount + items.length,
            history: pushHistory(ws),
            baseRows: { ...ws.baseRows, ...addedRows },
            changedIds: { ...ws.changedIds, ...addedChanges },
          },
        },
      }
    }),

  deleteFeature: (layerId, editId) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: ws.features.filter((f) => f.properties?._editId !== editId),
            dirty: true,
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
          },
        },
      }
    }),

  deleteFeatures: (layerId, editIds) => {
    let removed = 0
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws || editIds.length === 0) return s
      const idSet = new Set(editIds)
      // 一次 filter、一份删除前历史快照（撤销口径与逐个删除一致）
      const features = ws.features.filter((f) => {
        if (idSet.has(f.properties?._editId)) {
          removed += 1
          return false
        }
        return true
      })
      if (removed === 0) return s
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features,
            dirty: true,
            changeCount: ws.changeCount + removed,
            history: pushHistory(ws),
          },
        },
      }
    })
    return removed
  },

  updateFeatureGeometry: (layerId, editId, geometry) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: ws.features.map((f) =>
              f.properties?._editId === editId ? { ...f, geometry } : f,
            ),
            dirty: true,
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
            changedIds: markChanged(ws, editId),
          },
        },
      }
    }),

  updateFeatureStyle: (layerId, editId, style) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: ws.features.map((f) =>
              f.properties?._editId === editId
                ? { ...f, properties: { ...(f.properties || {}), _editStyle: style } }
                : f,
            ),
            dirty: true,
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
            changedIds: markChanged(ws, editId),
          },
        },
      }
    }),

  updateFeatureProperties: (layerId, editId, patch) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            features: ws.features.map((f) =>
              f.properties?._editId === editId
                ? { ...f, properties: { ...(f.properties || {}), ...patch } }
                : f,
            ),
            dirty: true,
            changeCount: ws.changeCount + 1,
            history: pushHistory(ws),
            changedIds: markChanged(ws, editId),
          },
        },
      }
    }),

  addFeatureAttribute: (layerId, editId, key0, value) => {
    const ws = get().workspaces[layerId]
    if (!ws) return 'noWorkspace'
    const key = (key0 || '').trim()
    if (!key) return 'empty'
    if (!VALID_ATTR_KEY.test(key)) return 'invalidName'
    if (key.startsWith('_')) return 'internal'
    if (RESERVED_ATTR_KEYS.has(key)) return 'reserved'
    if (key.length > MAX_ATTR_KEY_LEN) return 'tooLong'

    // 图层现有用户字段（任一要素上的非内部键，与 addFeature 的字段继承同源）
    const existingKeys = collectUserAttrKeys(ws.features)
    if (existingKeys.includes(key)) return 'exists'
    if (existingKeys.length >= MAX_ATTR_COLUMNS) return 'tooMany'
    // editId 必须命中工作集要素（防脏态/竞态产生幽灵变更）
    if (!ws.features.some((f) => f.properties?._editId === editId)) return 'noFeature'

    const features = ws.features.map((f) => {
      const isTarget = f.properties?._editId === editId
      return {
        ...f,
        properties: { ...(f.properties || {}), [key]: isTarget ? value : null },
      }
    })

    set({
      workspaces: {
        ...get().workspaces,
        [layerId]: {
          ...ws,
          features,
          dirty: true,
          changeCount: ws.changeCount + 1,
          history: pushHistory(ws),
          changedIds: markChanged(ws, editId),
        },
      },
    })
    return null
  },

  undo: (layerId) => {
    const ws = get().workspaces[layerId]
    if (!ws || ws.history.length === 0) return false
    const restored = ws.history[ws.history.length - 1]
    const nextHistory = ws.history.slice(0, -1)
    const wasDirty = ws.dirty
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [layerId]: {
          ...ws,
          features: restored,
          // 回到栈底(与初始基线相同)即不再脏
          dirty: nextHistory.length > 0 ? wasDirty : false,
          changeCount: Math.max(0, ws.changeCount - 1),
          history: nextHistory,
        },
      },
    }))
    return true
  },

  canUndo: (layerId) => {
    const ws = get().workspaces[layerId || '']
    return !!ws && ws.history.length > 0
  },

  markSaved: (layerId, opts) =>
    set((s) => {
      const ws = s.workspaces[layerId]
      if (!ws) return s
      // 保存成功后重置历史基线（此后撤销基于已保存态）：
      // - remapRows=false（服务端要素数与工作集不符，如几何不符被跳过）时清空基底，
      //   下一次保存自动回退整层，避免按错行写增量
      const remap = opts?.remapRows !== false
      return {
        workspaces: {
          ...s.workspaces,
          [layerId]: {
            ...ws,
            dirty: false,
            changeCount: 0,
            history: [],
            changedIds: {},
            baseRows: remap ? buildBaseRows(ws.features) : {},
            baseCount: remap ? ws.features.length : 0,
            version: remap ? (opts?.version ?? null) : null,
          },
        },
      }
    }),

  discardWorkspace: (layerId) =>
    set((s) => {
      const next = { ...s.workspaces }
      delete next[layerId]
      return {
        workspaces: next,
        editableLayerId: s.editableLayerId === layerId ? null : s.editableLayerId,
        drawTool: s.editableLayerId === layerId ? 'none' : s.drawTool,
        nodeMergeMode: s.editableLayerId === layerId ? false : s.nodeMergeMode,
      }
    }),

  getWorkspace: (layerId) => (layerId ? get().workspaces[layerId] : undefined),

  isDirty: (layerId) => !!get().workspaces[layerId]?.dirty,
}))

/** 选择器：所有有未保存更改的图层 id。 */
export function selectDirtyLayerIds(workspaces: Record<string, LayerWorkspace>): string[] {
  return Object.values(workspaces)
    .filter((w) => w.dirty)
    .map((w) => w.layerId)
}
