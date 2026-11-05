import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../CellSelectionTable'
import { StepIndicator } from '../StepIndicator'
import { WizardFooter } from '../WizardFooter'
import { downloadCellTreeTemplate } from '../../utils/cellFileHelper'
import type { RefObject } from 'react'
import type { CellListItem } from '../../services/mapDataService'
import type { PCICheckConfig } from '../../store/pciCheckStore'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'

/** PCI核查专用的步骤标签：第二步叫“算法参数”，与规划类任务的“规划参数”区分 */
const PCI_CHECK_STEPS = [
  { key: 'new_task', labelKey: 'common.newTask', fallback: '新建' },
  { key: 'params', labelKey: 'pciCheck.algorithmParams', fallback: '算法参数' },
  { key: 'cells', labelKey: 'pci.cellSelection', fallback: '选择小区' },
  { key: 'execute', labelKey: 'common.execute', fallback: '执行' },
  { key: 'done', labelKey: 'common.completed', fallback: '完成' },
]

export interface PCICheckWizardProps {
  wizardStep: WizardStep
  /** 0-4，与 StepIndicator/WizardFooter 对齐 */
  stepIndex: number
  /** 执行中进度（0-100） */
  progress: number
  isRunning: boolean
  taskName: string
  taskNameError: string | null
  onTaskNameChange: (value: string) => void
  config: PCICheckConfig
  onConfigChange: (partial: Partial<PCICheckConfig>) => void
  sectors: CellListItem[]
  selectedCellIds: Set<string>
  cellListLoading: boolean
  cellFileUploading: boolean
  cellFileInputRef: RefObject<HTMLInputElement>
  onToggleCell: (cellId: string) => void
  onSelectAll: (filteredIds: string[]) => void
  onClearSelections: () => void
  onCellFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  canProceed: boolean
  onNext: () => void
  onBack: () => void
  onCancel: () => void
}

/** PCI核查向导面板：任务名 → 核查参数 → 小区选择 → 执行 → 完成 */
export function PCICheckWizard(props: PCICheckWizardProps) {
  const { t } = useTranslation()
  const {
    wizardStep, stepIndex, progress, isRunning, taskName, taskNameError,
    onTaskNameChange, config, onConfigChange, sectors, selectedCellIds,
    cellListLoading, cellFileUploading, cellFileInputRef,
    onToggleCell, onSelectAll, onClearSelections, onCellFileChange,
    canProceed, onNext, onBack, onCancel
  } = props

  const editable = wizardStep === 'cells_selected' && !isRunning

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StepIndicator currentStep={stepIndex} steps={PCI_CHECK_STEPS} executingProgress={progress} />

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center pt-6">
        {(wizardStep === 'idle' || wizardStep === 'task_created') && (
          <div className="bg-card border border-border rounded-xl p-6 w-full">
            <h3 className="text-sm font-semibold mb-4">{t('pciCheck.taskName') || '任务名称'}</h3>
            <input
              type="text"
              value={taskName}
              onChange={(e) => onTaskNameChange(e.target.value.slice(0, 25))}
              placeholder={t('common.taskNamePlaceholder') || '请输入任务名称'}
              maxLength={25}
              className={`w-full px-3 py-2 text-sm bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary ${taskNameError ? 'border-red-400 focus:ring-red-400' : 'border-border'}`}
            />
            {taskNameError && <p className="mt-1 text-xs text-red-500">{taskNameError}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{taskName.length}/25</p>
          </div>
        )}

        {wizardStep === 'params_set' && (
          <div className="bg-card border border-border rounded-xl p-6 w-full">
            <h3 className="text-sm font-semibold mb-4">{t('pciCheck.checkParams') || '算法参数'}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1">{t('pciCheck.networkType') || '网络类型'}</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="pciCheckNetworkType" value="LTE" checked={config.networkType === 'LTE'} onChange={() => onConfigChange({ networkType: 'LTE' })} className="w-4 h-4" />
                    LTE
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="pciCheckNetworkType" value="NR" checked={config.networkType === 'NR'} onChange={() => onConfigChange({ networkType: 'NR' })} className="w-4 h-4" />
                    NR
                  </label>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold mb-2">{t('pciCheck.checkItems') || '核查项目'}</p>
                <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                  <CheckRow
                    label={t('pciCheck.collisionCheck') || 'PCI冲突核查'}
                    checked={config.collisionCheck}
                    onChange={(value) => onConfigChange({ collisionCheck: value })}
                  />
                  <CheckRow
                    label={t('pciCheck.confusionCheck') || 'PCI混淆核查'}
                    hint={t('pciCheck.confusionHint') || '需开启邻区关联后生效'}
                    checked={config.confusionCheck}
                    onChange={(value) => onConfigChange({ confusionCheck: value })}
                  />
                  <CheckRow
                    label={t('pciCheck.mod3Check') || 'PCI模3核查'}
                    checked={config.mod3Check}
                    onChange={(value) => onConfigChange({ mod3Check: value })}
                  />
                  {config.networkType === 'NR' && (
                    <CheckRow
                      label={t('pciCheck.mod30Check') || 'PCI模30核查'}
                      checked={config.mod30Check}
                      onChange={(value) => onConfigChange({ mod30Check: value })}
                    />
                  )}
                  <CheckRow
                    label={t('pciCheck.reuseCheck') || 'PCI复用距离'}
                    checked={config.reuseCheck}
                    onChange={(value) => onConfigChange({ reuseCheck: value })}
                  />
                  <CheckRow
                    label={t('pciCheck.neighborAssoc') || '邻区关联开关'}
                    hint={t('pciCheck.neighborAssocHint') || '开启后冲突/混淆/模值邻区核查基于预规划同频邻区对'}
                    checked={config.neighborAssoc}
                    onChange={(value) => onConfigChange({ neighborAssoc: value })}
                  />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold mb-2">{t('pciCheck.thresholdParams') || '门限参数'}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <NumberField
                    label={t('pciCheck.macroPairDistance') || '宏站到宏站对打距离(米)'}
                    hint={t('pciCheck.macroPairDistanceHint') || '宏站与宏站互指时的距离门限（默认200米）'}
                    value={config.macroPairDistance}
                    step={50}
                    onChange={(value) => onConfigChange({ macroPairDistance: value })}
                  />
                  <NumberField
                    label={t('pciCheck.mixedPairDistance') || '宏站到室分对打距离(米)'}
                    hint={t('pciCheck.mixedPairDistanceHint') || '宏站与室分互指时的距离门限（默认100米）'}
                    value={config.mixedPairDistance}
                    step={10}
                    onChange={(value) => onConfigChange({ mixedPairDistance: value })}
                  />
                  <NumberField
                    label={t('pciCheck.indoorPairDistance') || '室分到室分对打距离(米)'}
                    hint={t('pciCheck.indoorPairDistanceHint') || '室分与室分互指时的距离门限（默认50米）'}
                    value={config.indoorPairDistance}
                    step={10}
                    onChange={(value) => onConfigChange({ indoorPairDistance: value })}
                  />
                  <NumberField
                    label={t('pciCheck.macroFacingAngle') || '宏站对打小区夹角门限(°)'}
                    hint={t('pciCheck.macroFacingAngleHint') || '宏站对打方位角容差（默认90度）'}
                    value={config.macroFacingAngle}
                    step={5}
                    onChange={(value) => onConfigChange({ macroFacingAngle: value })}
                  />
                  <NumberField
                    label={t('pciCheck.indoorFacingAngle') || '室分对打小区夹角门限(°)'}
                    hint={t('pciCheck.indoorFacingAngleHint') || '室分对打方位角容差（默认60度）'}
                    value={config.indoorFacingAngle}
                    step={5}
                    onChange={(value) => onConfigChange({ indoorFacingAngle: value })}
                  />
                  <NumberField
                    label={t('pciCheck.minReuseDistanceMacro') || '宏站PCI最小复用距离(米)'}
                    hint={t('pciCheck.macroReuseHint') || '该距离内同频同PCI的宏站判为复用距离过小（默认2000米）'}
                    value={config.minReuseDistanceMacro}
                    step={100}
                    onChange={(value) => onConfigChange({ minReuseDistanceMacro: value })}
                  />
                  <NumberField
                    label={t('pciCheck.minReuseDistanceIndoor') || '室分PCI最小复用距离(米)'}
                    hint={t('pciCheck.indoorReuseHint') || '该距离内同频同PCI的室分判为复用距离过小（默认500米）'}
                    value={config.minReuseDistanceIndoor}
                    step={100}
                    onChange={(value) => onConfigChange({ minReuseDistanceIndoor: value })}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {(wizardStep === 'cells_selected' || wizardStep === 'executing' || wizardStep === 'completed') && (
          <div className="bg-card border border-border rounded-xl p-6 w-full h-[70vh] min-h-[420px] flex flex-col">
            <h3 className="text-sm font-semibold mb-4 shrink-0">{t('pci.cellSelection') || '小区选择'}</h3>
            <input type="file" ref={cellFileInputRef} onChange={onCellFileChange} accept=".xlsx,.xls" className="hidden" />
            <div className="flex-1 min-h-0 flex flex-col">
              <CellSelectionTable
                sectors={sectors}
                selectedCellIds={selectedCellIds}
                onToggleCell={editable ? onToggleCell : () => {}}
                onSelectAll={editable ? onSelectAll : () => {}}
                onClearSelections={editable ? onClearSelections : () => {}}
                selectedCountText={(t('pciCheck.selectedCount') || '已选中 {{count}} 个小区').replace('{{count}}', String(selectedCellIds.size))}
                loading={cellListLoading}
                onUploadCellFile={wizardStep === 'cells_selected' ? () => cellFileInputRef.current?.click() : undefined}
                onDownloadCellTemplate={wizardStep === 'cells_selected' ? () => downloadCellTreeTemplate(config.networkType) : undefined}
                uploading={cellFileUploading}
                disabled={wizardStep !== 'cells_selected' || isRunning}
                enableColumnSearch
                columnLabels={{
                  search: t('pciCheck.search') || '搜索',
                  siteId: t('pciCheck.siteId') || '基站ID',
                  cellId: t('pciCheck.cellId') || '小区ID',
                  cellName: t('pciCheck.cellName') || '小区名称',
                  cellFreq: t('pciCheck.cellFreq') || '频点',
                  cellPci: t('pciCheck.cellPci') || 'PCI',
                  cellLng: t('pciCheck.cellLng') || '经度',
                  cellLat: t('pciCheck.cellLat') || '纬度',
                  selectAll: t('pciCheck.selectAll') || '全选',
                  clearSelections: t('pciCheck.clearSelections') || '清空选择',
                  uploadCellFile: t('pciCheck.uploadCellFile') || '上传待核查小区文件',
                  downloadCellTemplate: t('pciCheck.downloadCellTemplate') || '下载小区模板'
                }}
              />
            </div>
          </div>
        )}
      </div>

      <WizardFooter
        currentStep={stepIndex}
        isExecuting={isRunning}
        canProceed={canProceed}
        onNext={onNext}
        onCancel={onCancel}
        onBack={onBack}
        isTaskNameStep={wizardStep === 'task_created'}
      />
    </div>
  )
}

/** 核查参数勾选行 */
function CheckRow({ label, hint, checked, onChange }: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-border"
        />
        {label}
      </label>
      {hint && <p className="mt-0.5 ml-6 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 门限数值输入行 */
function NumberField({ label, hint, value, step, onChange }: {
  label: string
  hint: string
  value: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        step={step}
        className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  )
}
