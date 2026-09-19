// 通用API响应类型
export interface ApiResponse<T = any> {
  success: boolean
  data: T
  message?: string
  code?: number
}

// 许可证相关类型
export interface LicenseStatus {
  valid: boolean
  expiryDate: string
  licensee: string
  licenseKey?: string
  features?: string[]
}

export interface LicenseInfo {
  licenseKey: string
  licensee: string
  expiryDate: string
  features: string[]
  signature: string
}

// 数据管理相关类型
export interface DataItem {
  id: string
  name: string
  type: 'excel' | 'map'
  size: number
  uploadDate: string
  status: 'processing' | 'ready' | 'error'
  metadata?: Record<string, any>
  originalPath?: string
  fileType?: 'full_params' | 'current_params' | 'target_cells' | 'tac_layer' | 'mapinfo_layer' | 'geo_data' | 'default'
  geometryType?: 'point' | 'sector' | 'polygon'
  sourceType?: 'excel' | 'mapinfo'
  subType?: string
  errorMessage?: string  // 处理失败时的错误详情
  excelSynced?: boolean  // 应用PCI/TAC后 Excel 是否已同步
  inplaceUpdated?: boolean  // 是否已原地更新（PCI/TAC应用）
}

export interface UploadResponse {
  id: string
  name: string
  status: string
}

export interface SiteData {
  id: string
  name: string
  longitude: number
  latitude: number
  networkType: 'LTE' | 'NR'
  pci?: number
  earfcn?: number
  arfcn?: number
  sectors: SectorData[]
}

export interface SectorData {
  id: string
  siteId: string
  name: string
  longitude: number
  latitude: number
  azimuth: number
  beamwidth: number
  height: number
  pci?: number
  earfcn?: number
  arfcn?: number
  cell_cover_type?: number  // 小区覆盖类型: 1=室外小区, 4=室内小区
}

// PCI规划相关类型
export interface PCIRange {
  min: number
  max: number
}

export interface PCIConfig {
  taskName?: string
  networkType: 'LTE' | 'NR'
  distanceThreshold: number
  pciModulus: 3 | 30
  inheritModulus: boolean
  pciRange?: PCIRange
  enableTACPlanning?: boolean
  enableCollisionCheck?: boolean
  enableConfusionCheck?: boolean
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
  customRules?: PCIRule[]
}

export interface PCIRule {
  condition: string
  pciRange: [number, number]
  priority: number
}

export interface PCIResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  collisions: number
  confusions: number
  results: SitePCIResult[]
  startTime: string
  endTime?: string
}

export interface SitePCIResult {
  siteId: string
  siteName: string
  sectors: SectorPCIResult[]
  conflicts?: PCIConflict[]
}

export interface SectorPCIResult {
  sectorId: string
  sectorName: string
  originalPCI?: number
  newPCI: number
  originalMod?: number
  newMod?: number
  earfcn?: number
  longitude?: number
  latitude?: number
  assignmentReason?: string
  minReuseDistance?: number
  minDistanceSectorName?: string
  collisionCount?: number
  confusionCount?: number
  tac?: string | null
}

export interface PCIConflict {
  type: 'collision' | 'confusion'
  sector1: string
  sector2: string
  pci: number
}

// 邻区规划相关类型
export interface NeighborConfig {
  planningType: 'LTE-LTE' | 'NR-NR' | 'NR-LTE'
  maxDistance?: number  // 已弃用，改用覆盖圆算法
  maxNeighbors: number
  coverageDistanceFactor: number  // 覆盖圆距离系数
  coverageRadiusFactor: number    // 覆盖圆半径系数
  denseSpacingThreshold?: number   // 密集/稀疏门限（公里），默认1.0
  denseMultiplier?: number         // 密集场景全量半径倍数，默认1.3
  outdoorToIndoorMaxDistance?: number  // 室外→室分最大距离（公里），默认0.6
  indoorToIndoorRadius?: number    // 室分→室分距离（公里），默认0.35
  indoorToOutdoorMultiplier?: number   // 室分→室外全量半径倍数，默认1.5
  outdoorSpacingSiteCount?: number // 室外源站间距取最近N个室外站，默认9
  customRules?: NeighborRule[]
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
}

export interface NeighborRule {
  condition: string
  action: 'add' | 'remove'
  priority: number
}

export interface NeighborResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  totalNeighbors: number
  avgNeighbors: number
  results: SiteNeighborResult[]
  startTime: string
  endTime?: string
}

export interface SiteNeighborResult {
  siteId: string
  siteName: string
  sectors: SectorNeighborResult[]
  totalNeighbors?: number
}

export interface SectorNeighborResult {
  sectorId: string
  sectorName: string
  neighbors: NeighborRelation[]
  neighborCount?: number
}

export interface NeighborRelation {
  sourceSector: string
  sourceSectorName?: string
  targetSector: string
  targetSectorName?: string
  targetSite: string
  targetSiteName?: string
  distance: number
  bearing?: number
  relationType: 'LTE-LTE' | 'LTE-NR' | 'NR-LTE' | 'NR-NR'
}

// TAC规划相关类型
export interface TACConfig {
  networkType: 'LTE' | 'NR'
  enableSingularityCheck?: boolean
  singularityConfig?: {
    searchRadius: number
    singularityThreshold: number
  }
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
}

export interface TACResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalCells: number
  matchedCells: number
  unmatchedCells: number
  singularityCount?: number
  results: CellTACResult[]
  startTime: string
  endTime?: string
  error?: string
}

export interface CellTACResult {
  sectorId: string
  sectorName: string
  siteId: string
  siteName: string
  networkType: 'LTE' | 'NR'
  longitude: number
  latitude: number
  tac: string | null
  tacAreaName?: string
  existingTac?: string | null
  matched: boolean
  isSingularity?: boolean
  singularityDetails?: TACSingularityDetails
  firstGroup?: string
  suggestedTac?: string | null  // TAC建议值，对于插花小区取图层TAC值
}

export interface TACSingularityDetails {
  sectorId: string
  sectorName: string
  siteId: string
  siteName: string
  cellTAC: string
  dominantTac: string
  validNeighborCount: number
  异TAC占比: number
  dominantTacRatio: number
}

// 地图相关类型
export interface MapData {
  sites: SiteData[]
  bounds: MapBounds
  center: MapCenter
}

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export interface MapCenter {
  latitude: number
  longitude: number
}

export interface OnlineMapConfig {
  provider: 'openstreetmap' | 'gaode' | 'baidu'
  apiKey?: string
  style: string
}

export interface OfflineMapConfig {
  path: string
  format: 'mbtiles' | 'xyz'
  minZoom: number
  maxZoom: number
}

// 任务进度相关类型
export interface TaskProgress {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  message?: string
  error?: string
}

// WebSocket消息类型
export interface WSMessage {
  type: 'task_progress' | 'task_complete' | 'task_error' | 'data_update'
  data: any
}

export interface TaskProgressMessage extends WSMessage {
  type: 'task_progress'
  data: TaskProgress
}

export interface TaskCompleteMessage extends WSMessage {
  type: 'task_complete'
  data: {
    taskId: string
    result: any
  }
}

export interface TaskErrorMessage extends WSMessage {
  type: 'task_error'
  data: {
    taskId: string
    error: string
  }
}

// 图层相关类型
export interface Layer {
  id: string
  name: string
  type: 'sites' | 'sectors' | 'coverage' | 'neighbors' | 'conflicts'
  visible: boolean
  opacity: number
  style?: LayerStyle
}

export interface LayerStyle {
  color: string
  fillColor: string
  strokeWidth: number
  radius?: number
}

// ============== 用户认证相关类型 ==============
export interface UserInfo {
  id: number
  username: string
  is_admin: boolean
  is_active: boolean
  is_online?: boolean
  is_online_pc?: boolean
  is_online_app?: boolean
  must_change_password: boolean
  license_expiry: string | null
  total_usage_seconds: number
  last_login: string | null
  last_login_ip: string | null
  created_at: string | null
  city: string | null
  operator: string | null
  user_type?: 'pc' | 'app'
  can_data_import?: boolean
  can_data_delete?: boolean
  can_data_update?: boolean
  can_cell_entry?: boolean
  can_cell_query_update?: boolean
  can_assistant?: boolean
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user: UserInfo
}

export interface LoginRequest {
  username: string
  password: string
  client_type?: 'pc' | 'app'
}

export interface RegisterRequest {
  username: string
  password: string
  confirm_password: string
  city: string
  operator: string
}

export interface RegisterOptions {
  cities: string[]
  operators: string[]
}

export interface ChangePasswordRequest {
  old_password: string
  new_password: string
  confirm_password: string
}

export interface UserListResponse {
  total: number
  users: UserInfo[]
}

export interface UserUpdateRequest {
  is_active?: boolean
  is_admin?: boolean
  license_expiry?: string | null
  must_change_password?: boolean
  city?: string | null
  operator?: string | null
  /** 组变更时历史数据迁移范围：user=仅本人 / group=整个旧组 */
  migrate_scope?: 'user' | 'group'
  can_data_import?: boolean
  can_data_delete?: boolean
  can_data_update?: boolean
  can_cell_entry?: boolean
  can_cell_query_update?: boolean
  can_assistant?: boolean
}

export interface ResetPasswordRequest {
  new_password: string
}

export interface UserSessionInfo {
  id: number
  user_id: number
  token_jti: string
  ip_address: string | null
  client_type: 'pc' | 'app'
  login_time: string | null
  logout_time: string | null
  last_activity: string | null
}

export interface UserDetailResponse extends UserInfo {
  sessions: UserSessionInfo[]
}

// 查询/更新：搜索结果项
export interface CellSearchItem {
  rowKey: string
  networkType: string
  siteId: string
  cellId: string
  cellName: string
  siteName?: string
  managedElementId?: string
  mcc?: string
  mnc?: string
  longitude?: number
  latitude?: number
  azimuth?: number
  height?: number
  frequency?: number
  ssbFrequency?: number
  cellCoverType: number
}

// 查询/更新：批量更新结果项
export interface CellBulkUpdateResultItem {
  rowKey: string
  type: 'update' | 'delete'
  success: boolean
  message: string
}

// 小区参数行（新站录入 / 查询更新共用）
export interface CellRow {
  id: string
  managedElementId: string
  siteId: string
  cellId: string
  cellName: string
  mcc: string
  mnc: string
  longitude: string
  latitude: string
  height: string
  azimuth: string
  frequency: string
  ssbFrequency: string
  cellCoverType: number
  rowKey?: string   // 查询/更新：搜索结果定位键（新站录入不填）
}

// ===== 地图图层编辑（新建 TAB / 绘制点线面 / 保存）=====
export type DrawGeometryType = 'point' | 'line' | 'polygon'
export type DrawTool = 'none' | DrawGeometryType

// 绘制样式（点/线/面各一份，持久化到 mapSettings.drawStyleMap）
export interface PointDrawStyle {
  markerShape: 'circle' | 'square' | 'diamond' | 'triangle' | 'pin'
  markerSize: number
  markerColor: string
  borderColor: string
}
export interface LineDrawStyle {
  color: string
  weight: number
  opacity: number
  dashArray: string   // '' 实线，'5,5' 等虚线
}
export interface PolygonDrawStyle {
  fillColor: string   // 'none' = 无色（镂空）
  fillOpacity: number
  borderColor: string
  borderWidth: number
  /** 边框线型：'' 实线，'5,5' 等虚线 */
  borderDash?: string
  /**
   * 图形样式（绘制预设）：
   * - polygon 多边形（默认）：逐点单击加顶点，双击/右键完成
   * - circle/square/triangle：绘制时两次点击（拖框）即生成对应规则图形
   */
  shape?: 'polygon' | 'circle' | 'square' | 'triangle'
}
export type DrawStyleSettings = PointDrawStyle | LineDrawStyle | PolygonDrawStyle

// 新建图层请求/响应（geometryType 缺省为 mixed 混合图层，可绘制点/线/面）
export interface CreateLayerRequest {
  name: string
  geometryType?: DrawGeometryType | 'mixed'
}
export interface CreateLayerResult {
  data_id: string
  layer_id: string
  name: string
}
