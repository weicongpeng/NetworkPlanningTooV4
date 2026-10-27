/**
 * FeatureStyleDialog 中心点展示回归测试
 *
 * 覆盖修复：内部几何/命中均为渲染坐标（GCJ02），弹窗“中心点”此前直接展示
 * GCJ02，与用户可见的 WGS84 口径相差 100~700 米。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FeatureStyleDialog from '../FeatureStyleDialog'
import { wgs84ToGcj02 } from '../../../utils/coordinate'
import '../../../i18n'

describe('FeatureStyleDialog 中心点坐标系', () => {
  it('点要素中心点按 WGS84 展示（内部 GCJ02 需逆转换）', () => {
    const wgsLat = 22.5428
    const wgsLng = 114.0596
    const [gcjLat, gcjLng] = wgs84ToGcj02(wgsLat, wgsLng)

    render(
      <FeatureStyleDialog
        open
        data={{
          layerId: '',
          layerName: '测试图层',
          name: '测试点',
          geometry: { type: 'Point', coordinates: [gcjLng, gcjLat] },
          properties: {},
          editable: false,
        }}
        onClose={() => {}}
      />,
    )

    const value = screen.getByText('中心点').nextElementSibling
    expect(value?.textContent).toBe(`${wgsLng.toFixed(6)}, ${wgsLat.toFixed(6)}`)
  })
})
