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
  version?: string
  errorMessage?: string | null
  remainingDays?: number
}

/** 桌面离线版机器码信息（厂商签发绑定本机的授权文件用） */
export interface MachineInfo {
  machineCode: string
  desktopMode: boolean
}

/** 桌面版在线许可信息（本地许可文件解析结果） */
export interface DesktopLicenseInfo {
  valid: boolean
  errorMessage?: string | null
  license_id?: number | null
  subject?: string
  organization?: string
  licensee?: string
  machine_code?: string
  lease_days?: number | null
  renew_count?: number | null
  issued_via?: 'online' | 'offline' | string
  issued_at?: string
  expire_date?: string
  remaining_days?: number
}

/** 桌面版本机在线状态 */
export interface DesktopCloudStatus {
  desktop: boolean
  server_url: string
  machine_code: string
  version: string
  channel: string
  license: DesktopLicenseInfo | null
  cloud: {
    license_id?: number | null
    last_renew_at?: string | null
    request_id?: number | null
  }
}

/** 桌面版安装包版本记录（OTA 管理端） */
export interface DesktopReleaseInfo {
  id: number
  version: string
  channel: string
  filename: string
  file_path: string
  file_size?: number | null
  file_size_display?: string
  sha256?: string | null
  release_notes?: string | null
  is_latest: boolean
  download_count: number
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  /** 安装包文件已不在磁盘上（手工清理/迁移）→ 不可用于 OTA */
  file_missing?: boolean
}

/** 桌面版授权记录（管理端） */
export interface DesktopLicenseRecord {
  id: number
  activation_code?: string | null
  licensee_username: string
  organization?: string | null
  machine_code?: string | null
  /** 运行模式：standalone=单机授权 / shared=共享模式登录自动签发 */
  mode?: 'standalone' | 'shared' | string
  /** 绑定的网页端账号（桌面端与网页端共用同一账号权限） */
  username?: string | null
  user_id?: number | null
  /** 历史登录次数与无操作自动退出登录时长（天） */
  login_count?: number
  last_login_at?: string | null
  idle_logout_days?: number
  city?: string | null
  operator?: string | null
  status: 'pending' | 'issued' | 'active' | 'rejected' | 'disabled' | string
  source: 'precreate' | 'approve' | string
  lease_days: number
  expire_date?: string | null
  /** 「用户管理 → 许可证到期」的值（有值时 expire_date 显示的就是它） */
  user_license_expiry?: string | null
  request_id?: string | null
  applied_note?: string | null
  review_note?: string | null
  note?: string | null
  created_by?: string | null
  approved_by?: string | null
  client_version?: string | null
  hostname?: string | null
  renewal_count: number
  created_at: string
  activated_at?: string | null
  machine_bound_at?: string | null
  last_renewed_at?: string | null
  disabled_at?: string | null
  updated_at?: string | null
}

/** 桌面版本机更新状态 */
export interface DesktopUpdateStatus {
  current: string
  channel: string
  update_available: boolean
  release: {
    id: number
    version: string
    channel: string
    file_size?: number
    file_size_display?: string
    sha256?: string
    release_notes?: string | null
    published_at?: string
    update_available: boolean
    download_url: string
  } | null
  download: {
    phase: 'idle' | 'downloading' | 'ready' | 'failed'
    version?: string | null
    downloaded: number
    total: number
    error?: string | null
    installer?: string | null
    /** 用户选了「后台运行」：关窗后继续下载安装 */
    background?: boolean
  }
  /** 上一次安装的结果（装失败时给出人工安装提示） */
  last_result?: {
    target_version?: string
    current_version?: string
    applied?: boolean
    needs_manual?: boolean
    setup_rc?: string
    setup_retry_rc?: string
    installer?: string
    restarted?: string
    /** 注册表记录的实际安装目录（诊断"装到哪儿了"） */
    install_dir?: string
    /** 重启目标目录里实际读到的版本（安装器写入，核对是否真的换版本） */
    installed_version?: string
    /** 安装日志尾部（安装器初始化失败时定位真实原因） */
    setup_log_tail?: string
    finished_at?: string
  } | null
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
  outdoorSpacingSiteCount?: number // 室外源站间距取最近N个室外站，默认11
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
  skippedCells?: SkippedCellInfo[]
  skippedCount?: number
  results: CellTACResult[]
  startTime: string
  endTime?: string
  error?: string
}

/** 因工参数据不全（缺经纬度/缺ID/缺PCI）或工参中未找到而被跳过核查/规划的小区 */
export interface SkippedCellInfo {
  siteId?: string
  siteName?: string
  sectorId?: string
  sectorName?: string
  reason: 'missing_coordinates' | 'missing_ids' | 'missing_pci' | 'not_in_params'
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
  异TAC占比: number         // 周边TAC与本站不同的加权占比（= 100 − cellTacRatio）
  cellTacRatio?: number     // 本站TAC在周边的加权占比(%)
  dominantTacRatio: number  // 周边主流TAC占比(%)
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
  /** 桌面端（共享模式登录）是否在线 */
  is_online_desktop?: boolean
  must_change_password: boolean
  /** 该用户单独设置的例外授权期限（未设置=跟全局，用户管理页展示用） */
  license_expiry: string | null
  /**
   * 实际适用的授权期限（后端计算）：管理员恒为 null（无限期）；
   * 非管理员为「license_expiry ?? 全局授权期限」。授权门禁一律用这个。
   */
  effective_license_expiry?: string | null
  total_usage_seconds: number
  last_login: string | null
  last_login_ip: string | null
  created_at: string | null
  city: string | null
  operator: string | null
  user_type?: 'pc' | 'app'
  /** 桌面版登录时选择的运行模式（网页端为 null） */
  desktop_run_mode?: 'shared' | 'standalone' | null
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
  /** 在线统计为全量（跨所有页），由后端基于全部用户计算 */
  online_users: number
  online_pc: number
  online_app: number
  online_desktop: number
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
  /** 桌面端共享模式登录在服务器记 'desktop' */
  client_type: 'pc' | 'app' | 'desktop'
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
  /**
   * 图形样式：'line' 直线 / 'curve' 曲线（绘制时按 Catmull-Rom 加密几何）
   */
  shape?: 'line' | 'curve'
  /** 带方向线段的线：沿线渲染方向箭头（本软件渲染，TAB/MIF 内仍为普通线） */
  arrow?: boolean
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

// ===== 条件选择（图层属性空间连接）=====

/** 图层引用：kind 决定来源与取数方式 */
export interface AttributeJoinLayerRef {
  kind: 'sector' | 'mapinfo' | 'geodata'
  /** mapinfo / geodata 的数据集 id */
  dataId?: string
  /** mapinfo 的图层 id */
  layerId?: string
  /** sector: LTE / NR / all */
  networkType?: string
}

export interface AttributeJoinRequest {
  layer1: AttributeJoinLayerRef
  condition: 'within'
  layer2: AttributeJoinLayerRef
}

/** 图层1经纬度缺失被跳过的要素明细 */
export interface AttributeJoinSkippedItem {
  /** 要素标识（扇区/站点 ID） */
  id: string
  /** 要素名称 */
  name: string
  /** 缺失原因 key（展示时翻译） */
  reason: string
}

/** 条件选择结果统计 */
export interface AttributeJoinStats {
  taskId: string
  status: 'completed'
  progress: number
  /** 图层1有效要素总数（不含跳过） */
  total1: number
  /** 图层2面要素总数 */
  total2: number
  /** 匹配（在边界内）数量 */
  matched: number
  /** 图层1未匹配数量 */
  unmatched: number
  /** 图层2零归属边界数量 */
  dangling2: number
  /** 图层1经纬度缺失被跳过的要素数量 */
  skipped1: number
  /** 被跳过要素的明细 */
  skipped1Details: AttributeJoinSkippedItem[]
  /** 结果 xlsx 路径（后端） */
  exportPath: string
}

// ===== 绘制缓冲区 =====

/** 缓冲图形保存目标：装饰图层或已有 MapInfo TAB 图层 */
export type BufferTargetRef =
  | { kind: 'decoration' }
  | { kind: 'mapinfo'; dataId: string; layerId: string }

export interface BufferRequest {
  /** 参考图层（点/线/面任意几何） */
  source: AttributeJoinLayerRef
  target: BufferTargetRef
  /** 缓冲半径（米） */
  radius: number
  /** 平滑度：每圈段数，默认 12 */
  segments: number
  /** each=每要素单独缓冲；dissolve=所有要素合并缓冲 */
  mode: 'each' | 'dissolve'
}

/** 参考图层几何/经纬度缺失被跳过的要素明细 */
export type BufferSkippedItem = AttributeJoinSkippedItem

/** 缓冲区结果统计 */
export interface BufferStats {
  taskId: string
  status: 'completed'
  progress: number
  /** 图形保存去向 */
  savedTo: 'decoration' | 'mapinfo'
  /** 参考图层有效要素数（不含跳过） */
  inputCount: number
  /** 生成的缓冲多边形数 */
  resultCount: number
  /** 参考图层被跳过的要素数 */
  skippedCount: number
  skippedDetails: BufferSkippedItem[]
  /** target=decoration 时携带待写入要素（GCJ02） */
  features?: Array<{ type: 'Feature'; geometry: any; properties: Record<string, any> }>
  /** target=mapinfo 时的目标定位 */
  dataId?: string
  layerId?: string
}
