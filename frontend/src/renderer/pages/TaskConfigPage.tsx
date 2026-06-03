import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../store/authStore'
import { btn } from '../utils/buttonStyles'

const MAX_NEIGHBORS_LIMIT: Record<string, number> = {
  'LTE-LTE': 256,
  'NR-NR': 512,
  'NR-LTE': 512
}

type PageType = 'pci' | 'neighbor' | 'tac' | 'tac-planning'

interface TypeMeta {
  prefix: string
  taskType: string
  backRoute: string
}

const TYPE_META: Record<PageType, TypeMeta> = {
  pci: { prefix: 'PCI规划', taskType: 'pci_planning', backRoute: '/pci' },
  neighbor: { prefix: '邻区规划', taskType: 'neighbor_planning', backRoute: '/neighbor' },
  tac: { prefix: 'TAC核查', taskType: 'tac_check', backRoute: '/tac' },
  'tac-planning': { prefix: 'TAC规划', taskType: 'tac_planning', backRoute: '/tac-planning' },
}

function generateDefaultTaskName(prefix: string): string {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `${prefix}-${ts}`
}

export function TaskConfigPage() {
  const { type } = useParams<{ type: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)

  const meta = TYPE_META[type as PageType]

  // Invalid type guard
  if (!meta) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertCircle size={48} className="mx-auto mb-4 text-red-400" />
          <p className="text-lg font-semibold mb-2">无效的页面类型: {type}</p>
          <button onClick={() => navigate('/')} className={btn.primary}>
            返回首页
          </button>
        </div>
      </div>
    )
  }

  // Shared state
  const [taskName, setTaskName] = useState(generateDefaultTaskName(meta.prefix))
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // PCI-specific state
  const [pciNetworkType, setPciNetworkType] = useState<'LTE' | 'NR'>('LTE')
  const [pciDistanceThreshold, setPciDistanceThreshold] = useState(10.0)
  const [pciRange, setPciRange] = useState('0-503')
  const [pciInheritModulus, setPciInheritModulus] = useState(false)
  const [pciEnableTACPlanning, setPciEnableTACPlanning] = useState(true)

  // Neighbor-specific state
  const [neighborPlanningType, setNeighborPlanningType] = useState('LTE-LTE')
  const [neighborMaxNeighbors, setNeighborMaxNeighbors] = useState(64)
  const [neighborDistanceFactor, setNeighborDistanceFactor] = useState(1.0)
  const [neighborRadiusFactor, setNeighborRadiusFactor] = useState(1.0)

  // TAC-specific state
  const [tacNetworkType, setTacNetworkType] = useState<'LTE' | 'NR'>('LTE')
  const [tacSearchRadius, setTacSearchRadius] = useState(1500)
  const [tacSingularityThreshold, setTacSingularityThreshold] = useState(50)

  // TAC Planning state
  const [tacPlanNetworkType, setTacPlanNetworkType] = useState<'LTE' | 'NR'>('LTE')

  // Validation
  const validatePCI = (): boolean => {
    const maxPCI = pciNetworkType === 'LTE' ? 503 : 1007
    const pciRangeMatch = pciRange.match(/^(\d+)-(\d+)$/)
    if (!pciRangeMatch) {
      setError(`PCI范围格式错误，正确格式为：0-503（当前值：${pciRange}）`)
      return false
    }
    const pciMin = parseInt(pciRangeMatch[1])
    const pciMax = parseInt(pciRangeMatch[2])
    if (pciMin < 0 || pciMin > maxPCI) {
      setError(`PCI最小值必须在0-${maxPCI}之间，当前值为${pciMin}`)
      return false
    }
    if (pciMax < 0 || pciMax > maxPCI) {
      setError(`PCI最大值必须在0-${maxPCI}之间，当前值为${pciMax}`)
      return false
    }
    if (pciMin >= pciMax) {
      setError(`PCI最小值(${pciMin})必须小于最大值(${pciMax})`)
      return false
    }
    if (pciDistanceThreshold < 0.1 || pciDistanceThreshold > 50) {
      setError(`复用距离必须在0.1-50公里之间，当前值为${pciDistanceThreshold}`)
      return false
    }
    return true
  }

  const validateNeighbor = (): boolean => {
    const maxLimit = MAX_NEIGHBORS_LIMIT[neighborPlanningType] || 512
    if (neighborMaxNeighbors < 1) {
      setError('最大邻区数不能小于1')
      return false
    }
    if (neighborMaxNeighbors > maxLimit) {
      setError(`${neighborPlanningType}规划最多配置${maxLimit}条邻区关系，当前值为${neighborMaxNeighbors}`)
      return false
    }
    if (neighborDistanceFactor < 0.1 || neighborDistanceFactor > 2.0) {
      setError(`覆盖圆距离系数必须在0.1-2.0之间，当前值为${neighborDistanceFactor}`)
      return false
    }
    if (neighborRadiusFactor < 0.1 || neighborRadiusFactor > 2.0) {
      setError(`覆盖圆半径系数必须在0.1-2.0之间，当前值为${neighborRadiusFactor}`)
      return false
    }
    return true
  }

  const validateTAC = (): boolean => {
    if (!tacNetworkType) {
      setError('请选择网络类型')
      return false
    }
    return true
  }

  const validateTACPlanning = (): boolean => {
    if (!tacPlanNetworkType) {
      setError('请选择网络类型')
      return false
    }
    return true
  }

  const handleNext = () => {
    setError(null)

    let valid = false
    let config: any = {}

    switch (type) {
      case 'pci':
        valid = validatePCI()
        config = {
          networkType: pciNetworkType,
          distanceThreshold: pciDistanceThreshold,
          pciRange: pciRange,
          inheritModulus: pciInheritModulus,
          useMod3: pciNetworkType === 'LTE',
          useMod30: pciNetworkType === 'NR',
          enableTACPlanning: pciEnableTACPlanning,
        }
        break
      case 'neighbor':
        valid = validateNeighbor()
        config = {
          planningType: neighborPlanningType,
          maxNeighbors: neighborMaxNeighbors,
          coverageDistanceFactor: neighborDistanceFactor,
          coverageRadiusFactor: neighborRadiusFactor,
        }
        break
      case 'tac':
        valid = validateTAC()
        config = {
          networkType: tacNetworkType,
          enableSingularityCheck: true,
          singularityConfig: {
            searchRadius: tacSearchRadius,
            singularityThreshold: tacSingularityThreshold / 100,
          },
        }
        break
      case 'tac-planning':
        valid = validateTACPlanning()
        config = { networkType: tacPlanNetworkType }
        break
    }

    if (!valid) return

    setSubmitting(true)
    navigate(meta.backRoute, {
      state: {
        configured: true,
        config,
        taskName,
        networkType: type === 'neighbor' ? neighborPlanningType.split('-')[0] : (type === 'pci' ? pciNetworkType : (type === 'tac' ? tacNetworkType : tacPlanNetworkType)),
      },
    })
  }

  const handleBack = () => {
    navigate(meta.backRoute)
  }

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors"
        >
          <ArrowLeft size={16} />
          {t('common.backToPlanning')}
        </button>
        <h1 className="text-2xl font-bold">{meta.prefix}{t('common.configPageTitle').replace('{{type}}', '') || '配置'}</h1>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700 shrink-0">
          <AlertCircle size={18} />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-sm underline">关闭</button>
        </div>
      )}

      {/* Form Card */}
      <div className="bg-card border border-border rounded-xl p-6 max-w-2xl mx-auto w-full">
        {/* Task Name */}
        <div className="mb-6">
          <label className="block text-sm font-semibold mb-2">{t('common.taskName')}</label>
          <input
            type="text"
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder={t('common.taskNamePlaceholder')}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Type-specific parameters */}
        {type === 'pci' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <ConfigSelect
                label="网络类型"
                value={pciNetworkType}
                options={['LTE', 'NR']}
                onChange={(v) => {
                  setPciNetworkType(v as 'LTE' | 'NR')
                  setPciRange(v === 'LTE' ? '0-503' : '0-1007')
                }}
              />
              <ConfigInput
                label="复用距离(km)"
                type="number"
                value={pciDistanceThreshold}
                onChange={(v) => setPciDistanceThreshold(parseFloat(v) || 0)}
                min={0.1} max={50} step={0.1}
              />
              <ConfigInput
                label="PCI范围"
                type="text"
                value={pciRange}
                onChange={(v) => setPciRange(v)}
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={pciInheritModulus}
                  onChange={(e) => setPciInheritModulus(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                继承模{pciNetworkType === 'LTE' ? '3' : '30'}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={pciEnableTACPlanning}
                  onChange={(e) => setPciEnableTACPlanning(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                TAC规划
              </label>
            </div>
          </div>
        )}

        {type === 'neighbor' && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <ConfigSelect
              label="规划类型"
              value={neighborPlanningType}
              options={['LTE-LTE', 'NR-NR', 'NR-LTE']}
              onChange={(v) => setNeighborPlanningType(v)}
            />
            <ConfigInput
              label="最大邻区数"
              type="number"
              value={neighborMaxNeighbors}
              onChange={(v) => setNeighborMaxNeighbors(parseInt(v) || 32)}
              min={1} max={MAX_NEIGHBORS_LIMIT[neighborPlanningType] || 512}
            />
            <ConfigInput
              label="覆盖圆距离系数"
              type="number"
              value={neighborDistanceFactor}
              onChange={(v) => setNeighborDistanceFactor(parseFloat(v) || 0.56)}
              min={0.1} max={2.0} step={0.01}
            />
            <ConfigInput
              label="覆盖圆半径系数"
              type="number"
              value={neighborRadiusFactor}
              onChange={(v) => setNeighborRadiusFactor(parseFloat(v) || 0.56)}
              min={0.1} max={2.0} step={0.01}
            />
          </div>
        )}

        {type === 'tac' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-2">网络类型</label>
              <div className="flex gap-2">
                <label className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors flex-1 justify-center">
                  <input type="radio" name="tacNetworkType" value="LTE" checked={tacNetworkType === 'LTE'} onChange={() => setTacNetworkType('LTE')} className="w-3 h-3" />
                  <span className="text-sm font-medium">4G LTE</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors flex-1 justify-center">
                  <input type="radio" name="tacNetworkType" value="NR" checked={tacNetworkType === 'NR'} onChange={() => setTacNetworkType('NR')} className="w-3 h-3" />
                  <span className="text-sm font-medium">5G NR</span>
                </label>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">搜索半径(米)</label>
                <input type="number" value={tacSearchRadius} onChange={(e) => setTacSearchRadius(Number(e.target.value))}
                  className="w-28 px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-center"
                  min={100} max={5000} step={100} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">异TAC阈值(%)</label>
                <input type="number" value={tacSingularityThreshold} onChange={(e) => setTacSingularityThreshold(Number(e.target.value))}
                  className="w-28 px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-center"
                  min={50} max={95} step={5} />
              </div>
            </div>
            <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <p className="text-[10px] leading-relaxed">• 需导入TAC图层(4G_TAC.zip/5G_TAC.zip)</p>
              <p className="text-[10px] leading-relaxed">• 需导入全量工参(ProjectParameter_mongoose)</p>
            </div>
          </div>
        )}

        {type === 'tac-planning' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-2">网络类型</label>
              <div className="flex gap-2">
                <label className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors flex-1 justify-center">
                  <input type="radio" name="tacPlanNetworkType" value="LTE" checked={tacPlanNetworkType === 'LTE'} onChange={() => setTacPlanNetworkType('LTE')} className="w-3 h-3" />
                  <span className="text-sm font-medium">4G LTE</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors flex-1 justify-center">
                  <input type="radio" name="tacPlanNetworkType" value="NR" checked={tacPlanNetworkType === 'NR'} onChange={() => setTacPlanNetworkType('NR')} className="w-3 h-3" />
                  <span className="text-sm font-medium">5G NR</span>
                </label>
              </div>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
              <ul className="space-y-1.5">
                <li className="flex items-start gap-1.5">
                  <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">1</span>
                  <span><b>待规划小区</b>：导入 cell-tree-export 格式的 Excel 文件</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">2</span>
                  <span><b>全量工参</b>：导入对应的 4G 或 5G 全量工参</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">3</span>
                  <span><b>TAC图层</b>：导入 TAC 图层数据</span>
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 mt-8 pt-4 border-t border-border">
          <button onClick={handleBack} className={btn.secondary}>
            {t('common.cancel')}
          </button>
          <button
            onClick={handleNext}
            disabled={submitting}
            className={btn.primary}
          >
            {t('common.nextStep')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </div>
  )
}

function ConfigInput({
  label,
  type,
  value,
  onChange,
  disabled = false,
  min,
  max,
  step = 1,
}: {
  label: string
  type: string
  value: number | string
  onChange: (value: string) => void
  disabled?: boolean
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  )
}
