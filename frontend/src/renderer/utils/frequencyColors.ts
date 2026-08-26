/**
 * 频点颜色映射工具
 * 
 * 为LTE和NR的不同频点分配唯一的颜色
 * - LTE: 蓝紫色系 (Hue: 200-260)
 * - NR: 绿黄色系 (Hue: 100-160)
 * 
 * 使用HSL色彩空间确保颜色区分度和视觉美观
 */

import type { NetworkType } from '../config/sector-config'

interface FrequencyColor {
    frequency: number
    color: string
    strokeColor: string
}

/**
 * 频点颜色映射器
 */
export class FrequencyColorMapper {
    private colorMap: Map<number, FrequencyColor> = new Map()
    private frequenciesByNetwork: Map<NetworkType, Set<number>> = new Map([
        ['LTE', new Set()],
        ['NR', new Set()]
    ])

    // 用户自定义频点配色（key: `${networkType}:${frequency}`），优先于算法色与特定频点映射表
    private customColors: Map<string, { color: string; strokeColor: string }> = new Map()

    private static customKey(frequency: number, networkType: NetworkType): string {
        return `${networkType}:${frequency}`
    }

    /**
     * 设置自定义频点配色（持久化前先写入内存，保证当前会话立即生效）
     */
    setCustomColor(frequency: number, networkType: NetworkType, color: string, strokeColor: string): void {
        this.customColors.set(FrequencyColorMapper.customKey(frequency, networkType), { color, strokeColor })
        // 使该频点已缓存的颜色失效，下次 getColor 重新计算（命中自定义色）
        this.colorMap.delete(frequency)
    }

    /**
     * 删除指定频点的自定义配色（回退到算法/特定频点色）
     */
    removeCustomColor(frequency: number, networkType: NetworkType): void {
        this.customColors.delete(FrequencyColorMapper.customKey(frequency, networkType))
        this.colorMap.delete(frequency)
    }

    /**
     * 获取全部自定义频点配色（用于持久化存储）
     */
    getCustomColors(): Record<string, { color: string; strokeColor: string }> {
        const result: Record<string, { color: string; strokeColor: string }> = {}
        this.customColors.forEach((v, k) => { result[k] = { ...v } })
        return result
    }

    /**
     * 从持久化数据恢复自定义频点配色（应用启动时调用）
     */
    loadCustomColors(colors: Record<string, { color: string; strokeColor: string }> | null | undefined): void {
        this.customColors.clear()
        if (!colors) return
        for (const [key, v] of Object.entries(colors)) {
            if (v && typeof v.color === 'string') {
                this.customColors.set(key, { color: v.color, strokeColor: v.strokeColor || v.color })
                // 解析 key 里的频点以清除缓存（网络类型未知也可通过频点清除，getColor 会重新生成）
                const freq = Number(key.split(':')[1])
                if (Number.isFinite(freq)) this.colorMap.delete(freq)
            }
        }
    }

    // LTE和NR使用不同的起始色调
    private readonly LTE_HUE_BASE = 210 // 蓝色基准
    private readonly NR_HUE_BASE = 120  // 绿色基准

    // 扩大色调范围，覆盖更宽的色相环
    private readonly HUE_RANGE = 240  // 色调变化范围（240度）

    // 基准样式
    private readonly BASE_SATURATION = 75
    private readonly BASE_LIGHTNESS = 55
    private readonly STROKE_LIGHTNESS_OFFSET = -30

    // 特定频点颜色映射表
    private readonly specificFrequencyColors: Map<number, Map<NetworkType, { color: string; strokeColor: string }>> = new Map([
        // LTE扇区特定频点颜色
        [874.2, new Map([
            ['LTE', { color: '#87CEEB', strokeColor: '#1E90FF' }] // 亮蓝
        ])],
        [951.5, new Map([
            ['LTE', { color: '#D2B48C', strokeColor: '#A0522D' }] // 棕褐
        ])],
        [954, new Map([
            ['LTE', { color: '#ADD8E6', strokeColor: '#87CEFA' }] // 浅蓝
        ])],
        [1835, new Map([
            ['LTE', { color: '#00FF7F', strokeColor: '#006400' }] // 翠绿
        ])],
        [1850, new Map([
            ['LTE', { color: '#228B22', strokeColor: '#006400' }] // 深绿
        ])],
        [1865, new Map([
            ['LTE', { color: '#00CED1', strokeColor: '#4682B4' }] // 湖水蓝
        ])],
        [1867.5, new Map([
            ['LTE', { color: '#8B4513', strokeColor: '#654321' }] // 咖啡棕
        ])],
        [1870, new Map([
            ['LTE', { color: '#FFA500', strokeColor: '#FF8C00' }] // 橙黄
        ])],
        [2120, new Map([
            ['LTE', { color: '#0000CD', strokeColor: '#00008B' }] // 深蓝色
        ])],
        [2125, new Map([
            ['LTE', { color: '#32CD32', strokeColor: '#228B22' }] // 青柠绿
        ])],
        [2137.5, new Map([
            ['LTE', { color: '#4B0082', strokeColor: '#2E0854' }] // 靛蓝
        ])],
        [2140, new Map([
            ['LTE', { color: '#FF7F50', strokeColor: '#FF6347' }] // 珊瑚橙
        ])],
        // NR扇区特定频点颜色
        [877.35, new Map([
            ['NR', { color: '#DDA0DD', strokeColor: '#9370DB' }] // 粉紫
        ])],
        [880.95, new Map([
            ['NR', { color: '#2F4F4F', strokeColor: '#000000' }] // 墨绿
        ])],
        [954, new Map([
            ['NR', { color: '#00FFFF', strokeColor: '#00CED1' }] // 冰蓝
        ])],
        [2114.55, new Map([
            ['NR', { color: '#800020', strokeColor: '#6B0000' }] // 酒红
        ])],
        [2118.15, new Map([
            ['NR', { color: '#FF8C00', strokeColor: '#FF6347' }] // 亮橙
        ])],
        [2144.55, new Map([
            ['NR', { color: '#800080', strokeColor: '#4B0082' }] // 深紫
        ])],
        [3408.96, new Map([
            ['NR', { color: '#87CEFA', strokeColor: '#1E90FF' }] // 浅蓝色
        ])],
        [3509.76, new Map([
            ['NR', { color: '#B22222', strokeColor: '#8B0000' }] // 砖红
        ])]
    ])

    /**
     * 计算频点对应的颜色属性 (色调, 饱和度, 亮度)
     * 使用更分散的色调分布算法，确保频点间颜色差异更大
     */
    private calculateStyles(frequency: number, networkType: NetworkType): { h: number, s: number, l: number } {
        const frequencies = Array.from(this.frequenciesByNetwork.get(networkType) || []).sort((a, b) => a - b)
        const index = frequencies.indexOf(frequency)

        // 1. 色调分布：使用更大的步进值，覆盖更宽的色相环
        const baseHue = networkType === 'LTE' ? this.LTE_HUE_BASE : this.NR_HUE_BASE
        
        // 使用更大的色调步进值，确保相邻频点颜色差异明显
        // 采用质数步进法，减少颜色重复
        const primeStep = 47  // 质数，产生更分散的分布
        const hue = (baseHue + (index * primeStep)) % this.HUE_RANGE

        // 2. 亮度与饱和度更大幅度的交替变化 (5个一组循环)
        // 增加更多的变化组合，确保颜色区分度
        const lOffsets = [0, -20, 25, -10, 15]  // 更大的亮度变化范围
        const sOffsets = [0, -25, 15, 20, -10]  // 更大的饱和度变化范围

        const lightness = this.BASE_LIGHTNESS + lOffsets[index % 5]
        const saturation = this.BASE_SATURATION + sOffsets[index % 5]

        return { h: hue, s: saturation, l: lightness }
    }

    /**
     * 生成HSL颜色字符串
     */
    private generateHSL(hue: number, saturation: number, lightness: number): string {
        return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`
    }

    /**
     * 使颜色变深（用于边框）
     */
    private darkenColor(hue: number, saturation: number, lightness: number, offset: number): string {
        const newLightness = Math.max(0, Math.min(100, lightness + offset))
        return this.generateHSL(hue, saturation, newLightness)
    }

    /**
     * 获取频点对应的颜色
     * @param frequency 频点值
     * @param networkType 网络类型
     * @returns 颜色对象
     */
    getColor(frequency: number, networkType: NetworkType): FrequencyColor {
        if (!this.colorMap.has(frequency)) {
            // 记录频点
            const freqSet = this.frequenciesByNetwork.get(networkType)
            if (freqSet) {
                freqSet.add(frequency)
            }

            let color: string
            let strokeColor: string

            // 0. 优先用户自定义配色（在持久化里配置）
            const custom = this.customColors.get(FrequencyColorMapper.customKey(frequency, networkType))
            if (custom) {
                color = custom.color
                strokeColor = custom.strokeColor
            } else {
                // 1. 优先检查特定频点颜色映射表
                const freqMap = this.specificFrequencyColors.get(frequency)
                if (freqMap && freqMap.has(networkType)) {
                    // 使用特定颜色
                    const specificColor = freqMap.get(networkType)! as { color: string; strokeColor: string }
                    color = specificColor.color
                    strokeColor = specificColor.strokeColor
                } else {
                    // 2. 计算样式属性，使用自动生成的颜色
                    const { h, s, l } = this.calculateStyles(frequency, networkType)
                    color = this.generateHSL(h, s, l)
                    strokeColor = this.darkenColor(h, s, l, this.STROKE_LIGHTNESS_OFFSET)
                }
            }

            const colorObj: FrequencyColor = {
                frequency,
                color,
                strokeColor
            }

            this.colorMap.set(frequency, colorObj)
        }

        return this.colorMap.get(frequency)!
    }

    /**
     * 获取所有已知频点
     * @param networkType 可选，按网络类型过滤
     * @returns 频点数组（已排序）
     */
    getAllFrequencies(networkType?: NetworkType): number[] {
        if (networkType) {
            const freqs = this.frequenciesByNetwork.get(networkType)
            return freqs ? Array.from(freqs).sort((a, b) => a - b) : []
        }

        // 返回所有频点
        const allFreqs = new Set<number>()
        this.frequenciesByNetwork.forEach(freqs => {
            freqs.forEach(f => allFreqs.add(f))
        })
        return Array.from(allFreqs).sort((a, b) => a - b)
    }

    /**
     * 获取频点图例数据
     * @param networkType 网络类型
     * @returns 频点图例数组
     */
    getFrequencyLegend(networkType: NetworkType): Array<{ frequency: number; color: string; strokeColor: string }> {
        const frequencies = this.getAllFrequencies(networkType)
        return frequencies.map(freq => this.getColor(freq, networkType))
    }

    /**
     * 清除缓存（用于数据刷新）
     * 保留用户自定义配色：自定义色属于用户偏好，数据刷新后仍应生效
     */
    clear(): void {
        this.colorMap.clear()
        this.frequenciesByNetwork.set('LTE', new Set())
        this.frequenciesByNetwork.set('NR', new Set())
    }

    /**
     * 预加载频点（优化首次渲染性能）
     */
    preloadFrequencies(frequencies: Array<{ frequency: number; networkType: NetworkType }>): void {
        frequencies.forEach(({ frequency, networkType }) => {
            if (!this.colorMap.has(frequency)) {
                this.getColor(frequency, networkType)
            }
        })
    }
}

// 单例导出
export const frequencyColorMapper = new FrequencyColorMapper()
