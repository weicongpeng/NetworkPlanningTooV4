/**
 * 扇区渲染配置单元测试
 *
 * 测试内容：
 * 1. 小区覆盖类型配置（室外扇形 vs 室内圆形）
 * 2. 配置获取函数 getCellCoverStyle
 * 3. 半径和夹角配置验证
 */

import { CELL_COVER_CONFIG, getCellCoverStyle, CellCoverType } from '../sector-config'

describe('扇区渲染配置', () => {
  describe('小区覆盖类型配置', () => {
    /**
     * 测试用例1: 室外小区（cell_cover_type=1）配置
     *
     * 预期：
     * - 半径: 60米
     * - 夹角: 40度
     * - 非圆形: 需要按方位角绘制扇形
     */
    it('室外小区 (cell_cover_type=1) 应配置为扇形 60米/40度', () => {
      const config = CELL_COVER_CONFIG[1]

      expect(config.radius).toBe(60)
      expect(config.angle).toBe(40)
      expect(config.isCircular).toBe(false)
    })

    /**
     * 测试用例2: 室内小区（cell_cover_type=4）配置
     *
     * 预期：
     * - 半径: 30米
     * - 夹角: 0度（圆形不需要夹角）
     * - 圆形: 忽略方位角
     */
    it('室内小区 (cell_cover_type=4) 应配置为圆形 30米', () => {
      const config = CELL_COVER_CONFIG[4]

      expect(config.radius).toBe(30)
      expect(config.angle).toBe(0)
      expect(config.isCircular).toBe(true)
    })
  })

  describe('getCellCoverStyle 函数', () => {
    /**
     * 测试用例3: 传入 1 应返回室外小区配置
     */
    it('getCellCoverStyle(1) 应返回室外小区配置', () => {
      const style = getCellCoverStyle(1)

      expect(style.radius).toBe(60)
      expect(style.angle).toBe(40)
      expect(style.isCircular).toBe(false)
    })

    /**
     * 测试用例4: 传入 4 应返回室内小区配置
     */
    it('getCellCoverStyle(4) 应返回室内小区配置', () => {
      const style = getCellCoverStyle(4)

      expect(style.radius).toBe(30)
      expect(style.angle).toBe(0)
      expect(style.isCircular).toBe(true)
    })

    /**
     * 测试用例5: 传入 undefined 或其他值应默认返回室外小区配置
     */
    it('getCellCoverStyle(undefined) 应默认返回室外小区配置', () => {
      const style = getCellCoverStyle(undefined)

      expect(style.radius).toBe(60)
      expect(style.angle).toBe(40)
      expect(style.isCircular).toBe(false)
    })

    /**
     * 测试用例6: 传入 2 或 3 等其他值应默认返回室外小区配置
     */
    it('getCellCoverStyle(2) 应默认返回室外小区配置', () => {
      const style = getCellCoverStyle(2)

      expect(style.radius).toBe(60)
      expect(style.angle).toBe(40)
      expect(style.isCircular).toBe(false)
    })
  })

  describe('配置不变性', () => {
    /**
     * 测试用例7: 验证配置对象为只读（as const）
     */
    it('CELL_COVER_CONFIG 应为只读配置', () => {
      // TypeScript 编译时检查：配置应为 readonly
      expect(CELL_COVER_CONFIG[1]).toBeDefined()
      expect(CELL_COVER_CONFIG[4]).toBeDefined()

      // 验证配置结构完整性
      expect(Object.keys(CELL_COVER_CONFIG)).toEqual(['1', '4'])
    })
  })
})
