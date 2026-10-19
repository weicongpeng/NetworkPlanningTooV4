import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { autoMatchFields, LAYER_FIELD_MATCHES, LayerFieldMatch } from '../../config/layer-config'

interface Props {
  columns: string[]
  includeAzimuth: boolean
  selectedFields: Record<string, string>      // 已选属性列名 → 列名
  onSelectedFieldsChange: (f: Record<string, string>) => void
  fieldMappings: Record<string, string>       // type → 列名
  onFieldMappingsChange: (m: Record<string, string>) => void
}

/**
 * 图层属性配置：列勾选 + 关键字匹配下拉
 * 勾选的列进入图层属性；name/lon/lat/azimuth 四类关键字必选映射。
 */
export function LayerAttributeConfig({
  columns, includeAzimuth, selectedFields, onSelectedFieldsChange,
  fieldMappings, onFieldMappingsChange,
}: Props) {
  const { t } = useTranslation()
  const fieldTypes: LayerFieldMatch[] = useMemo(
    () => LAYER_FIELD_MATCHES.filter(m => includeAzimuth || m.type !== 'azimuth'),
    [includeAzimuth],
  )

  // 列变化时自动匹配关键字，并默认全选所有列作为属性
  useEffect(() => {
    if (!columns.length) return
    const matched = autoMatchFields(columns, includeAzimuth)
    onFieldMappingsChange({ ...matched })
    const all: Record<string, string> = {}
    columns.forEach(c => { all[c] = c })
    onSelectedFieldsChange(all)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.join('|'), includeAzimuth])

  const toggleAttribute = (col: string, checked: boolean) => {
    const next = { ...selectedFields }
    if (checked) next[col] = col
    else delete next[col]
    onSelectedFieldsChange(next)
  }

  return (
    <div className="space-y-4">
      {/* 列勾选 */}
      <div>
        <p className="text-xs font-medium mb-2">{t('layer.selectAttributes')}</p>
        <div className="grid grid-cols-2 gap-2 max-h-96 overflow-y-auto border border-border rounded-lg p-3">
          {columns.length > 0 ? columns.map(col => (
            <label key={col} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="layer-standard-checkbox"
                checked={!!selectedFields[col]}
                onChange={e => toggleAttribute(col, e.target.checked)}
              />
              <span className="truncate">{col}</span>
            </label>
          )) : (
            <p className="text-xs text-muted-foreground col-span-2 py-4 text-center">{t('layer.importHint')}</p>
          )}
        </div>
      </div>

      {/* 关键字匹配（标签常驻，值空时禁用） */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t('layer.keywordMatch')}</p>
        {fieldTypes.map(f => (
          <div key={f.type} className="flex items-center gap-2">
            <label htmlFor={`layer-field-${f.type}`} className="text-xs text-muted-foreground w-20">{t(f.labelKey)}</label>
            <select
              id={`layer-field-${f.type}`}
              value={fieldMappings[f.type] || ''}
              onChange={e => onFieldMappingsChange({ ...fieldMappings, [f.type]: e.target.value })}
              disabled={columns.length === 0}
              className="flex-1 h-8 px-2 text-xs border border-border rounded bg-card disabled:opacity-50"
            >
              <option value="">{t('layer.selectColumn')}</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}
