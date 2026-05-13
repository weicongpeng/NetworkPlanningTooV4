/**
 * PCI规划图例面板组件
 *
 * 显示三种扇区类型的图例：
 * - 红色：选中的扇区
 * - 蓝色：同频同PCI的扇区
 * - 黑边：其他扇区
 */

import { useTranslation } from 'react-i18next'

interface PCILegendProps {
  className?: string
  /** 图例是否可见 */
  visible?: boolean
  /** 切换图例可见性的回调 */
  onToggleVisible?: () => void
}

export function PCILegend({
  className = '',
  visible = true,
  onToggleVisible
}: PCILegendProps) {
  const { t } = useTranslation()

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
          title={t('pci.legend') || '显示图例'}
        >
          {t('pci.legend') || '图例'}
        </button>
      </div>
    )
  }

  return (
    <div className={`pci-legend ${className}`} style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      padding: '6px',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      zIndex: 1000,
      minWidth: 'unset',
      fontSize: '7px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div style={{ fontWeight: 600, color: '#333', fontSize: '7px' }}>
          {t('pci.legend') || 'PCI规划图例'}
        </div>
        {onToggleVisible && (
          <button
            onClick={onToggleVisible}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '10px',
              padding: '0 2px',
              color: '#666',
            }}
            title={t('pci.hideLegend') || '隐藏图例'}
          >
            ×
          </button>
        )}
      </div>

      {/* 选中的扇区 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
        <div style={{
          width: '12px',
          height: '8px',
          backgroundColor: '#ef4444',
          border: '1px solid #dc2626',
          borderRadius: '1px',
          marginRight: '4px'
        }} />
        <span style={{ color: '#333', fontWeight: 500, fontSize: '7px' }}>{t('pci.selectedCell') || '选中的小区'}</span>
      </div>

      {/* 同频同PCI的扇区 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
        <div style={{
          width: '12px',
          height: '8px',
          backgroundColor: '#3b82f6',
          border: '1px solid #2563eb',
          borderRadius: '1px',
          marginRight: '4px'
        }} />
        <span style={{ color: '#333', fontWeight: 500, fontSize: '7px' }}>{t('pci.sameFreqPCI') || '同频同PCI'}</span>
      </div>

      {/* 其他扇区 - 白色填充带黑色边框 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0' }}>
        <div style={{
          width: '12px',
          height: '8px',
          backgroundColor: '#FFFFFF',
          border: '1.5px solid #000000',
          borderRadius: '1px',
          marginRight: '4px'
        }} />
        <span style={{ color: '#333', fontWeight: 500, fontSize: '7px' }}>{t('pci.otherCell') || '其他小区'}</span>
      </div>
    </div>
  )
}
