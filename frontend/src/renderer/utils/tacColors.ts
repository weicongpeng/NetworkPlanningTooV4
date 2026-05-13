/**
 * TAC颜色映射工具 - 统一色域版本
 *
 * 为LTE和NR的TAC值分配统一的高区分度颜色
 * - 不再区分LTE/NR色系，使用完整360°色域
 * - 每个TAC值根据其字符串hash确定颜色，确保相同TAC始终获得相同颜色
 * - 使用黄金比例分割 + 大幅度饱和度/亮度变化确保视觉区分度
 *
 * 核心算法：
 * 1. 使用TAC字符串的hash值作为种子
 * 2. 黄金比例分割确定色调位置
 * 3. 大周期的饱和度和亮度偏移增加额外区分度
 */

import type { NetworkType } from '../config/sector-config'

interface TACColor {
    tac: string
    color: string
    strokeColor: string
}

/**
 * 简单的字符串hash函数（FNV-1a变种）
 */
function hashString(str: string): number {
    let hash = 2166136261
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

/**
 * TAC颜色映射器 - 统一色域版本
 */
export class TACColorMapper {
    private colorMap: Map<string, TACColor> = new Map()
    private tacsByNetwork: Map<NetworkType, Set<string>> = new Map([
        ['LTE', new Set()],
        ['NR', new Set()]
    ])

    // 黄金比例 (φ ≈ 0.618) - 用于均匀分布色调
    private readonly GOLDEN_RATIO = 0.618033988749895

    /**
     * 计算TAC对应的颜色属性 (色调, 饱和度, 亮度)
     * 使用hash值确保相同TAC始终获得相同颜色
     */
    private calculateStyles(tac: string, networkType: NetworkType): { h: number, s: number, l: number } {
        // 使用TAC字符串的hash作为种子
        const seed = hashString(tac + networkType)

        // 色调：使用hash值在0-360度范围内分布
        // 结合黄金比例确保视觉均匀分布
        const hue = (seed * this.GOLDEN_RATIO * 360) % 360

        // 饱和度：使用hash的不同位，在70-100%范围内
        // 高饱和度确保颜色鲜艳
        const s1 = (seed >> 8) & 0xFF
        const s2 = (seed >> 16) & 0xFF
        const saturationPattern = [0, -20, 20, -15, 15, -25, 10, 25, -10, 18, -18, 12, -12, 8, -8, 22]
        const saturationOffset = saturationPattern[s1 % 16]
        const saturation = Math.max(70, Math.min(100, 90 + saturationOffset))

        // 亮度：使用hash的更多位，在35-65%范围内
        // 亮度变化是区分相似色调颜色的关键
        const l1 = (seed >> 24) & 0xFF
        const lPattern = [0, 18, -18, 12, -12, 22, -22, 8, -8, 15, -15, 25, -25, 10, -10, 20, -20, 5, -5, 28, -28]
        const lightnessOffset = lPattern[l1 % 21]
        const lightness = Math.max(35, Math.min(65, 50 + lightnessOffset))

        return { h: hue, s: saturation, l: lightness }
    }

    /**
     * 生成HSL颜色字符串
     */
    private generateHSL(hue: number, saturation: number, lightness: number): string {
        return `hsl(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`
    }

    /**
     * 使颜色变深（用于边框）
     */
    private darkenColor(hue: number, saturation: number, lightness: number, offset: number): string {
        const newLightness = Math.max(0, Math.min(100, lightness + offset))
        return this.generateHSL(hue, saturation, newLightness)
    }

    /**
     * 获取TAC对应的颜色
     * @param tac TAC值（字符串）
     * @param networkType 网络类型（用于颜色计算以保持一致性）
     * @returns 颜色对象
     */
    getColor(tac: string, networkType: NetworkType): TACColor {
        if (!this.colorMap.has(tac)) {
            // 记录TAC
            const tacSet = this.tacsByNetwork.get(networkType)
            if (tacSet) {
                tacSet.add(tac)
            }

            // 特殊处理：TAC 7906567 使用黄色
            if (tac === '7906567') {
                const colorObj: TACColor = {
                    tac,
                    color: '#FBBF24',  // 黄色
                    strokeColor: '#F59E0B'  // 深黄色边框
                }
                this.colorMap.set(tac, colorObj)
                return colorObj
            }

            // 计算样式属性
            const { h, s, l } = this.calculateStyles(tac, networkType)
            const color = this.generateHSL(h, s, l)
            const strokeColor = this.darkenColor(h, s, l, -25)

            const colorObj: TACColor = {
                tac,
                color,
                strokeColor
            }

            this.colorMap.set(tac, colorObj)
        }

        return this.colorMap.get(tac)!
    }

    /**
     * 获取所有已知TAC
     * @param networkType 可选，按网络类型过滤
     * @returns TAC数组（已排序）
     */
    getAllTACs(networkType?: NetworkType): string[] {
        if (networkType) {
            const tacs = this.tacsByNetwork.get(networkType)
            return tacs ? Array.from(tacs).sort() : []
        }

        // 返回所有TAC
        const allTacs = new Set<string>()
        this.tacsByNetwork.forEach(tacs => {
            tacs.forEach(t => allTacs.add(t))
        })
        return Array.from(allTacs).sort()
    }

    /**
     * 获取TAC图例数据
     * @param networkType 网络类型
     * @returns TAC图例数组
     */
    getTACLegend(networkType: NetworkType): Array<{ tac: string; color: string; strokeColor: string }> {
        const tacs = this.getAllTACs(networkType)
        return tacs.map(tac => this.getColor(tac, networkType))
    }

    /**
     * 清除缓存（用于数据刷新）
     */
    clear(): void {
        this.colorMap.clear()
        this.tacsByNetwork.set('LTE', new Set())
        this.tacsByNetwork.set('NR', new Set())
    }

    /**
     * 预加载TAC（优化首次渲染性能）
     * @param tacs TAC值数组
     */
    preloadTACs(tacs: Array<{ tac: string; networkType: NetworkType }>): void {
        tacs.forEach(({ tac, networkType }) => {
            if (!this.colorMap.has(tac)) {
                this.getColor(tac, networkType)
            }
        })
    }
}

// 单例导出
export const tacColorMapper = new TACColorMapper()
