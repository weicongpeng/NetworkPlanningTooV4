/**
 * TAC核查图例面板组件
 *
 * 显示：
 * 1. 插花小区标识（红色边框）
 * 2. 所有TAC值的颜色图例（动态生成）
 * 3. 网络类型标识
 */

import { useTranslation } from 'react-i18next'
import { tacColorMapper } from '../../utils/tacColors'
import type { NetworkType } from '../../config/sector-config'

interface TACLegendProps {
  className?: string
  /** 图例是否可见 */
  visible?: boolean
  /** 切换图例可见性的回调 */
  onToggleVisible?: () => void
  /** 网络类型（用于显示对应的TAC图例） */
  networkType?: NetworkType
}

export function TACLegend({
  className = '',
  visible = true,
  onToggleVisible,
  networkType = 'LTE'
}: TACLegendProps) {
  const { t } = useTranslation()
  // 获取TAC图例数据
  const tacLegend = tacColorMapper.getTACLegend(networkType)
  const tacCount = tacLegend.length

  // 如果图例不可见，只显示一个小的展开按钮
  if (!visible) {
    return (
      <div style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        zIndex: 1000,
      }}>
        <button
          onClick={onToggleVisible}
          style={{
            padding: '4px 8px',
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            border: '1px solid #ddd',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '10px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          }}
          title={t('tac.legend') || '显示图例'}
        >
          {t('tac.legend') || '图例'}
        </button>
      </div>
    )
  }

  return (
    <div className={`tac-legend ${className}`} style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      bottom: '10px',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      padding: '8px',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      zIndex: 1000,
      width: 'fit-content',
      minWidth: '100px',
      fontSize: '11px',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', flexShrink: 0 }}>
        <div style={{ fontWeight: 600, color: '#333', fontSize: '12px' }}>
          {t('tac.legend') || '图例'}({networkType})
        </div>
        {onToggleVisible && (
          <button
            onClick={onToggleVisible}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '0 4px',
              color: '#666',
            }}
            title={t('tac.hideLegend') || '隐藏图例'}
          >
            ×
          </button>
        )}
      </div>

      {/* TAC列表（可滚动） */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        paddingTop: '4px'
      }}>
        {tacLegend.map(({ tac, color, strokeColor }) => (
          <div
            key={tac}
            style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '2px',
              fontSize: '10px'
            }}
          >
            <div style={{
              width: '14px',
              height: '8px',
              backgroundColor: color,
              border: `1px solid ${strokeColor}`,
              borderRadius: '1px',
              marginRight: '6px',
              flexShrink: 0
            }} />
            <span style={{
              color: '#374151',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}>
              TAC {tac}
            </span>
          </div>
        ))}
      </div>

      {/* 统计信息 */}
      <div style={{
        borderTop: '1px solid #E5E7EB',
        paddingTop: '4px',
        marginTop: '4px',
        fontSize: '9px',
        color: '#6B7280',
        flexShrink: 0
      }}>
        {t('tac.totalTacValues', { count: tacCount }) || `共 ${tacCount} 个不同TAC值`}
      </div>
    </div>
  )
}
