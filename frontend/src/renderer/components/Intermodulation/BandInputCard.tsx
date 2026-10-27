import { useTranslation } from 'react-i18next'
import { IM3_PRESETS } from '../../utils/intermodulation'

export interface BandState {
  /** 预置频段 id，'custom' 表示自定义 */
  presetId: string
  customName: string
  low: string
  high: string
}

interface BandInputCardProps {
  title: string
  value: BandState
  onChange: (next: BandState) => void
  /** 紧凑模式：不画卡片外壳，供多个频段并排放在同一张卡片内 */
  compact?: boolean
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'

/** 单个频段输入卡片：预置选择 + 名称 + 频率上下限（复用三次） */
export default function BandInputCard({ title, value, onChange, compact = false }: BandInputCardProps) {
  const { t } = useTranslation()
  const preset = IM3_PRESETS.find(item => item.id === value.presetId)
  const isCustom = value.presetId === 'custom'
  const displayName = isCustom ? value.customName : preset ? t(preset.nameKey) : ''

  const handlePresetChange = (id: string) => {
    const next = IM3_PRESETS.find(item => item.id === id)
    if (!next) return
    if (next.id === 'custom') {
      onChange({
        presetId: 'custom',
        customName: isCustom ? value.customName : displayName,
        low: value.low,
        high: value.high,
      })
      return
    }
    onChange({
      presetId: next.id,
      customName: '',
      low: String(next.low ?? ''),
      high: String(next.high ?? ''),
    })
  }

  /** 手动改频率即转为自定义，保留当前名称避免丢失 */
  const handleFreqChange = (patch: Pick<BandState, 'low'> | Pick<BandState, 'high'>) => {
    onChange({
      ...value,
      ...patch,
      presetId: 'custom',
      customName: isCustom ? value.customName : displayName,
    })
  }

  return (
    <div className={compact ? 'space-y-3' : 'p-6 bg-card rounded-lg border border-border space-y-4'}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {!isCustom && preset && (
          <span className="text-xs text-muted-foreground">{t(preset.modeKey)}</span>
        )}
      </div>

      <div className={compact ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('im3Evaluation.preset')}</span>
          <select
            value={value.presetId}
            onChange={event => handlePresetChange(event.target.value)}
            className={inputCls + ' mt-1'}
          >
            {IM3_PRESETS.map(item => (
              <option key={item.id} value={item.id}>
                {t(item.nameKey)}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-muted-foreground">{t('im3Evaluation.bandName')}</span>
          {isCustom ? (
            <input
              value={value.customName}
              onChange={event =>
                onChange({ ...value, presetId: 'custom', customName: event.target.value })
              }
              placeholder={t('im3Evaluation.unnamedBand')}
              className={inputCls + ' mt-1'}
            />
          ) : (
            <div className="mt-1 px-3 py-2 rounded-lg border border-border bg-muted text-sm truncate">
              {displayName}
            </div>
          )}
        </label>
      </div>

      <div className={compact ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('im3Evaluation.freqLow')}</span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={value.low}
            onChange={event => handleFreqChange({ low: event.target.value })}
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">{t('im3Evaluation.freqHigh')}</span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={value.high}
            onChange={event => handleFreqChange({ high: event.target.value })}
            className={inputCls + ' mt-1'}
          />
        </label>
      </div>
    </div>
  )
}
