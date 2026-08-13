# LTE/NR 频点换算功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 纯前端实现 LTE EARFCN ↔ 频率、NR-ARFCN ↔ 频率、GSCN ↔ SSB 频率双向实时换算工具，并在左侧边栏「实用工具」分组（站间距计算下方）添加入口、首页添加卡片。

**Architecture:** 算法层为纯函数模块 `frontend/src/renderer/utils/frequencyConversion.ts`（可独立单元测试）；UI 为独立页面 `FrequencyConversionPage.tsx`，LTE 卡片 + NR 卡片（内嵌 GSCN 子区），输入即实时双向展示（useMemo 派生，无按钮）。无后端 API，无状态持久化。

**Tech Stack:** TypeScript, React 18, Vite, vitest（已安装 v1.6.1 + jsdom + @testing-library），lucide-react（RadioTower 图标已确认存在）。

**设计文档:** `docs/plans/2026-08-13-lte-nr-frequency-conversion-design.md`（已提交 005f0ff）

---

## 关键环境事实（务必先读）

1. **测试运行器**：vitest 已安装并可运行（`npx vitest run`）。`vite.config.ts` 已有 `test` 配置（globals/jsdom/setup）。
2. **⚠️ 预先存在的问题**：现有 2 个 `.test.ts`（mapDataService/sector-config）使用 `jest` 全局，vitest 下会失败。**这是既有问题，本次不修**。新增测试必须用 vitest 原生 API：`import { describe, it, expect } from 'vitest'`（不要用 `jest.*` 全局）。
3. **建议**：在 `package.json` scripts 添加 `"test": "vitest run"`，方便统一运行。
4. **GSCN 权威性**：GSCN 公式基于 3GPP TS 38.104 Table 5.4.3.1-1。网络受限无法在线验证，用文档内置的标准边界测试向量校验（见 Task 1）。
5. **数据源**：算法数据与测试向量来自项目根目录「频点换算方法.pdf」（PDF 内置测试用例已人工验证）。
6. **算法测试只测纯函数，不要引入 React 渲染测试**（页面 UI 用手工验证，见 Task 7）。

---

### Task 1: 算法模块（LTE EARFCN）

**Files:**
- Create: `frontend/src/renderer/utils/frequencyConversion.ts`

**Step 1: 写失败测试** — 先建 `frontend/src/renderer/utils/__tests__/frequencyConversion.test.ts`（LTE 部分）：

```typescript
import { describe, it, expect } from 'vitest'
import { lteFreqToEarfcn, lteEarfcnToFreq } from '../frequencyConversion'

describe('LTE EARFCN 换算', () => {
  // PDF 已验证向量
  it('B1 下行 2120MHz → EARFCN 100', () => {
    expect(lteFreqToEarfcn(1, 2120, 'DL')).toBe(100)
  })
  it('B3 下行 1870MHz → EARFCN 1850', () => {
    expect(lteFreqToEarfcn(3, 1870, 'DL')).toBe(1850)
  })
  it('B34 下行 2017.5MHz → EARFCN 36275', () => {
    expect(lteFreqToEarfcn(34, 2017.5, 'DL')).toBe(36275)
  })
  // 反向
  it('B1 EARFCN 100 → 下行 2120MHz', () => {
    expect(lteEarfcnToFreq(1, 100, 'DL')).toBe(2120)
  })
  // 上行（FDD UL offset）
  it('B1 上行 1920MHz → EARFCN 18000', () => {
    expect(lteFreqToEarfcn(1, 1920, 'UL')).toBe(18000)
  })
  it('B3 上行 1710MHz → EARFCN 19200', () => {
    expect(lteFreqToEarfcn(3, 1710, 'UL')).toBe(19200)
  })
  // 往返一致性
  it('EARFCN↔频率 往返一致', () => {
    expect(lteEarfcnToFreq(3, lteFreqToEarfcn(3, 1845, 'DL')!, 'DL')).toBe(1845)
  })
  // 非法输入
  it('非法频段返回 null', () => {
    expect(lteFreqToEarfcn(99, 2120, 'DL')).toBeNull()
  })
  it('越界频率返回 null（B1 DL 低于 2110）', () => {
    expect(lteFreqToEarfcn(1, 2000, 'DL')).toBeNull()
  })
  it('负数 EARFCN 返回 null', () => {
    expect(lteEarfcnToFreq(1, -5, 'DL')).toBeNull()
  })
})
```

**Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts`
Expected: FAIL（模块不存在）

**Step 3: 实现模块** — 在 `frequencyConversion.ts` 添加 LTE 部分：

```typescript
/** LTE Band 表（3GPP TS 36.101 Table 5.7.3-1 国内常用 9 段；数据来自频点换算方法.pdf） */
export interface LteBand {
  band: number
  type: 'FDD' | 'TDD'
  dlLow: number
  dlOffset: number
  ulLow: number
  ulOffset: number
}

export const LTE_BANDS: LteBand[] = [
  { band: 1, type: 'FDD', dlLow: 2110, dlOffset: 0, ulLow: 1920, ulOffset: 18000 },
  { band: 3, type: 'FDD', dlLow: 1805, dlOffset: 1200, ulLow: 1710, ulOffset: 19200 },
  { band: 5, type: 'FDD', dlLow: 869, dlOffset: 2400, ulLow: 824, ulOffset: 20400 },
  { band: 8, type: 'FDD', dlLow: 925, dlOffset: 3450, ulLow: 880, ulOffset: 21450 },
  { band: 34, type: 'TDD', dlLow: 2010, dlOffset: 36200, ulLow: 2010, ulOffset: 36200 },
  { band: 38, type: 'TDD', dlLow: 2570, dlOffset: 37750, ulLow: 2570, ulOffset: 37750 },
  { band: 39, type: 'TDD', dlLow: 1880, dlOffset: 38250, ulLow: 1880, ulOffset: 38250 },
  { band: 40, type: 'TDD', dlLow: 2300, dlOffset: 38650, ulLow: 2300, ulOffset: 38650 },
  { band: 41, type: 'TDD', dlLow: 2496, dlOffset: 39650, ulLow: 2496, ulOffset: 39650 },
]

export type LteDirection = 'DL' | 'UL'

function findLteBand(band: number): LteBand | undefined {
  return LTE_BANDS.find(b => b.band === band)
}

/** EARFCN = N_off + (F - F_low) / 0.1；F = F_low + 0.1×(N - N_off) */
export function lteFreqToEarfcn(band: number, freqMhz: number, direction: LteDirection): number | null {
  const b = findLteBand(band)
  if (!b) return null
  const fLow = direction === 'DL' ? b.dlLow : b.ulLow
  const nOff = direction === 'DL' ? b.dlOffset : b.ulOffset
  const earfcn = nOff + (freqMhz - fLow) / 0.1
  if (!Number.isFinite(earfcn) || earfcn < 0) return null
  return Math.round(earfcn)
}

export function lteEarfcnToFreq(band: number, earfcn: number, direction: LteDirection): number | null {
  const b = findLteBand(band)
  if (!b) return null
  if (!Number.isInteger(earfcn) || earfcn < 0) return null
  const fLow = direction === 'DL' ? b.dlLow : b.ulLow
  const nOff = direction === 'DL' ? b.dlOffset : b.ulOffset
  return fLow + 0.1 * (earfcn - nOff)
}

export function getLteBandTable(): LteBand[] {
  return LTE_BANDS
}
```

**Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts`
Expected: PASS（9 项）

**Step 5: 提交**

```bash
git add frontend/src/renderer/utils/frequencyConversion.ts frontend/src/renderer/utils/__tests__/frequencyConversion.test.ts
git commit -m "feat: LTE EARFCN↔频率换算算法 + 单测（PDF 测试向量验证）"
```

---

### Task 2: 算法模块（NR-ARFCN + GSCN）

**Files:**
- Modify: `frontend/src/renderer/utils/frequencyConversion.ts`（追加 NR 与 GSCN）

**Step 1: 追加失败测试** — 在 `frequencyConversion.test.ts` 追加：

```typescript
import { nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq, getNrBandTable } from '../frequencyConversion'

describe('NR-ARFCN 换算（全局三段公式）', () => {
  it('N1 2114.45MHz → 422890 (0-3GHz 5kHz 栅格)', () => {
    expect(nrFreqToArfcn(2114.45)).toBe(422890)
  })
  it('N41 2524.95MHz → 504990', () => {
    expect(nrFreqToArfcn(2524.95)).toBe(504990)
  })
  it('422890 → 2114.45MHz', () => {
    expect(nrArfcnToFreq(422890)).toBeCloseTo(2114.45, 5)
  })
  it('504990 → 2524.95MHz', () => {
    expect(nrArfcnToFreq(504990)).toBeCloseTo(2524.95, 5)
  })
  it('3GHz 边界 → 600000', () => {
    expect(nrFreqToArfcn(3000)).toBe(600000)
  })
  it('>24.25GHz 段（24250.08 → 2016667）', () => {
    expect(nrFreqToArfcn(24250.08)).toBe(2016667)
  })
  it('超范围频率返回 null', () => {
    expect(nrFreqToArfcn(-5)).toBeNull()
    expect(nrFreqToArfcn(100001)).toBeNull()
  })
  it('超范围 ARFCN 返回 null', () => {
    expect(nrArfcnToFreq(9999999)).toBeNull()
  })
  it('往返一致', () => {
    const f = 3450.15
    expect(nrArfcnToFreq(nrFreqToArfcn(f)!)!).toBeCloseTo(f, 5)
  })
})

describe('GSCN 换算（3GPP TS 38.104 全局同步栅格）', () => {
  it('0-3000MHz: 1.2MHz 栅格 3000MHz → GSCN 7500', () => {
    // GSCN = 3N, N = F/1.2 → F=3000 时 N=2500 → 7500
    expect(gsnFreqToGscn(3000)!.gscn).toBe(7500)
  })
  it('3000MHz 边界 GSCN 7500 → 3000MHz', () => {
    expect(gsnGscnToFreq(7500)!.freqMhz).toBe(3000)
  })
  it('3000-24250MHz: 1.44MHz 栅格 3300MHz → 最近栅格', () => {
    // N = round((3300-3000)/1.44) = round(208.33) = 208, GSCN = 3*208+7498 = 8122, F = 3000+208*1.44 = 3299.52
    const r = gsnFreqToGscn(3300)!
    expect(r.gscn).toBe(8122)
    expect(r.actualFreq).toBeCloseTo(3299.52, 5)
  })
  it('24250-100000MHz: 17.28MHz 栅格 30000MHz → 最近栅格', () => {
    // N = round((30000-24250.08)/17.28) = round(332.75) = 333, GSCN = 3*333+22256 = 23255
    const r = gsnFreqToGscn(30000)!
    expect(r.gscn).toBe(23255)
  })
  it('GSCN 22457 → 24250.08MHz 起点（N=67）', () => {
    // GSCN = 3N+22256 → 22457-22256=201 → 3N=201 → N=67 → F=24250.08+67*17.28
    expect(gsnGscnToFreq(22457)!.freqMhz).toBeCloseTo(24250.08 + 67 * 17.28, 5)
  })
  it('非法 GSCN 返回 null', () => {
    expect(gsnGscnToFreq(-1)).toBeNull()
    expect(gsnFreqToGscn(150000)).toBeNull()
  })
})

describe('NR 频段表', () => {
  it('返回常用 NR 频段表（含 n78/n79）', () => {
    const bands = getNrBandTable()
    expect(bands.some(b => b.band === 'n78')).toBe(true)
    expect(bands.some(b => b.band === 'n41')).toBe(true)
  })
})
```

**Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts`
Expected: FAIL（函数未定义）

**Step 3: 实现** — 在 `frequencyConversion.ts` 追加：

```typescript
/** NR-ARFCN 全局三段栅格（3GPP TS 38.104，不依赖 Band 不分方向） */
export function nrFreqToArfcn(freqMhz: number): number | null {
  if (!Number.isFinite(freqMhz) || freqMhz < 0 || freqMhz > 100000) return null
  if (freqMhz <= 3000) return Math.round(freqMhz * 200) // 5kHz 栅格
  if (freqMhz <= 24250) return Math.round(600000 + ((freqMhz - 3000) * 1000) / 15)
  return Math.round(2016667 + ((freqMhz - 24250.08) * 1000) / 60)
}

export function nrArfcnToFreq(arfcn: number): number | null {
  if (!Number.isInteger(arfcn) || arfcn < 0) return null
  if (arfcn <= 599999) return (arfcn * 5) / 1000
  if (arfcn <= 2016666) return 3000 + ((arfcn - 600000) * 15) / 1000
  if (arfcn <= 3279165) return 24250.08 + ((arfcn - 2016667) * 60) / 1000
  return null
}

/** NR 常用频段表（用于 ARFCN 换算结果附注「落在哪个 5G 频段」） */
export interface NrBand { band: string; dlLow: number; dlHigh: number; type: 'FDD' | 'TDD' }
export const NR_BANDS: NrBand[] = [
  { band: 'n1', dlLow: 2110, dlHigh: 2170, type: 'FDD' },
  { band: 'n3', dlLow: 1805, dlHigh: 1880, type: 'FDD' },
  { band: 'n5', dlLow: 869, dlHigh: 894, type: 'FDD' },
  { band: 'n8', dlLow: 925, dlHigh: 960, type: 'FDD' },
  { band: 'n28', dlLow: 758, dlHigh: 803, type: 'FDD' },
  { band: 'n41', dlLow: 2496, dlHigh: 2690, type: 'TDD' },
  { band: 'n77', dlLow: 3300, dlHigh: 4200, type: 'TDD' },
  { band: 'n78', dlLow: 3300, dlHigh: 3800, type: 'TDD' },
  { band: 'n79', dlLow: 4400, dlHigh: 5000, type: 'TDD' },
]

export function getNrBandTable(): NrBand[] { return NR_BANDS }

/** 校验频率落在哪个 NR 频段 */
export function matchNrBand(freqMhz: number): NrBand | null {
  return NR_BANDS.find(b => freqMhz >= b.dlLow && freqMhz <= b.dlHigh) ?? null
}

/** GSCN 三段全局同步栅格（3GPP TS 38.104 Table 5.4.3.1-1） */
export function gsnFreqToGscn(freqMhz: number): { gscn: number; actualFreq: number; deviationKHz: number } | null {
  if (!Number.isFinite(freqMhz) || freqMhz < 0 || freqMhz > 100000) return null
  let n: number, offset: number, base: number, step: number
  if (freqMhz <= 3000) { offset = 0; base = 0; step = 1.2; n = Math.round(freqMhz / 1.2) }
  else if (freqMhz <= 24250) { offset = 7498; base = 3000; step = 1.44; n = Math.round((freqMhz - 3000) / 1.44) }
  else { offset = 22256; base = 24250.08; step = 17.28; n = Math.round((freqMhz - 24250.08) / 17.28) }
  const gscn = 3 * n + offset
  const actualFreq = base + n * step
  return { gscn, actualFreq, deviationKHz: Math.round(Math.abs(actualFreq - freqMhz) * 1000) }
}

export function gsnGscnToFreq(gscn: number): { freqMhz: number } | null {
  if (!Number.isInteger(gscn) || gscn < 0) return null
  let n: number, offset: number, base: number, step: number
  if (gscn <= 7497) { offset = 0; base = 0; step = 1.2; n = gscn / 3 }
  else if (gscn <= 22255) { offset = 7498; base = 3000; step = 1.44; n = (gscn - 7498) / 3 }
  else { offset = 22256; base = 24250.08; step = 17.28; n = (gscn - 22256) / 3 }
  if (!Number.isInteger(n)) return null // GSCN 必须满足 3N+offset
  return { freqMhz: base + n * step }
}
```

**Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts`
Expected: PASS（全部）

**Step 5: 提交**

```bash
git add frontend/src/renderer/utils/frequencyConversion.ts frontend/src/renderer/utils/__tests__/frequencyConversion.test.ts
git commit -m "feat: NR-ARFCN 与 GSCN 换算算法 + 单测（全局三段栅格）"
```

---

### Task 3: i18n 翻译键

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**Step 1: zh.json** — 在 `nav` 中 `siteSpacing` 后添加 `"freqConversion": "频点换算"`；在 `home` 中 `siteSpacingDesc` 后添加 `"freqConversionDesc": "LTE/NR 频点与频率双向换算，含 GSCN"`；在 `home` 下新增对象（或独立 `freqConversion` 命名空间）`freqConversion` 页面文案：

```json
{
  "freqConversion": {
    "title": "频点换算",
    "subtitle": "LTE/NR 频点与频率双向实时换算，含 GSCN",
    "lteCard": "LTE 频点换算 (EARFCN)",
    "nrCard": "NR 频点换算 (NR-ARFCN / GSCN)",
    "direction": "方向",
    "dl": "下行",
    "ul": "上行",
    "band": "频段",
    "freq": "频率 (MHz)",
    "earfcn": "EARFCN",
    "arfcn": "NR-ARFCN",
    "gsnSub": "GSCN 全局同步信道号换算",
    "gsnFreq": "SSB 频率 (MHz)",
    "gsn": "GSCN",
    "result": "结果",
    "resultEarfcn": "EARFCN",
    "resultFreq": "频率",
    "resultArfcn": "NR-ARFCN",
    "resultGscn": "GSCN",
    "actualFreq": "实际频率",
    "deviation": "偏差",
    "inBand": "频段校验",
    "inBandNone": "未匹配到常用 NR 频段",
    "gsnHint": "GSCN 为离散同步栅格点，仅 SSB 中心频率有效",
    "invalid": "输入无效或超出范围",
    "placeholderFreq": "请输入频率",
    "placeholderEarfcn": "请输入 EARFCN",
    "placeholderArfcn": "请输入 NR-ARFCN",
    "placeholderGscn": "请输入 GSCN",
    "placeholderGsnFreq": "请输入 SSB 频率",
    "clear": "清空"
  }
}
```

**Step 2: en.json** — 同步英文翻译（key 完全一致）：

```json
{
  "freqConversion": {
    "title": "Frequency Conversion",
    "subtitle": "Bidirectional LTE/NR frequency & channel number conversion, incl. GSCN",
    "lteCard": "LTE Conversion (EARFCN)",
    "nrCard": "NR Conversion (NR-ARFCN / GSCN)",
    "direction": "Direction",
    "dl": "DL",
    "ul": "UL",
    "band": "Band",
    "freq": "Frequency (MHz)",
    "earfcn": "EARFCN",
    "arfcn": "NR-ARFCN",
    "gsnSub": "GSCN Global Sync Channel",
    "gsnFreq": "SSB Frequency (MHz)",
    "gsn": "GSCN",
    "result": "Result",
    "resultEarfcn": "EARFCN",
    "resultFreq": "Frequency",
    "resultArfcn": "NR-ARFCN",
    "resultGscn": "GSCN",
    "actualFreq": "Actual Frequency",
    "deviation": "Deviation",
    "inBand": "Band Check",
    "inBandNone": "No common NR band matched",
    "gsnHint": "GSCN is a discrete sync raster; valid only at SSB center frequency",
    "invalid": "Invalid or out of range",
    "placeholderFreq": "Enter frequency",
    "placeholderEarfcn": "Enter EARFCN",
    "placeholderArfcn": "Enter NR-ARFCN",
    "placeholderGscn": "Enter GSCN",
    "placeholderGsnFreq": "Enter SSB frequency",
    "clear": "Clear"
  }
}
```

**Step 3: 校验 JSON 合法 + 双语 key 一致**

Run: `cd frontend && python3 -c "
import json
for l in ['zh','en']:
    json.load(open(f'src/renderer/locales/{l}.json'))
    print(l, 'OK')
"` 再对比两文件 `freqConversion` key 集合完全一致。
Expected: 两文件 OK 且 key 集合相等

**Step 4: 提交**

```bash
git add frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 频点换算 i18n 中英文翻译键"
```

---

### Task 4: 页面组件 `FrequencyConversionPage.tsx`

**Files:**
- Create: `frontend/src/renderer/pages/FrequencyConversionPage.tsx`

**Step 1: 创建页面** — 完整实现（核心结构，双向实时换算用 useMemo）：

```tsx
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RadioTower } from 'lucide-react'
import {
  getLteBandTable, lteFreqToEarfcn, lteEarfcnToFreq, matchNrBand,
  nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq,
} from '../utils/frequencyConversion'
import type { LteDirection } from '../utils/frequencyConversion'

export default function FrequencyConversionPage() {
  const { t } = useTranslation()

  // ===== LTE 卡片状态 =====
  const [lteDirection, setLteDirection] = useState<LteDirection>('DL')
  const [lteBand, setLteBand] = useState(1)
  const [lteFreqInput, setLteFreqInput] = useState('')
  const [lteEarfcnInput, setLteEarfcnInput] = useState('')

  const lteBands = useMemo(() => getLteBandTable(), [])
  const selectedBand = useMemo(() => lteBands.find(b => b.band === lteBand), [lteBands, lteBand])

  /** 双向锁定：最后编辑的输入为基准算另一个 */
  const lteResult = useMemo(() => {
    const freq = parseFloat(lteFreqInput)
    if (lteFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const earfcn = lteFreqToEarfcn(lteBand, freq, lteDirection)
      return earfcn === null ? { error: t('freqConversion.invalid') } : { earfcn }
    }
    const earfcn = parseInt(lteEarfcnInput, 10)
    if (lteEarfcnInput.trim() !== '' && Number.isInteger(earfcn)) {
      const f = lteEarfcnToFreq(lteBand, earfcn, lteDirection)
      return f === null ? { error: t('freqConversion.invalid') } : { freq: f }
    }
    return {}
  }, [lteFreqInput, lteEarfcnInput, lteBand, lteDirection, t])

  const handleLteFreqChange = (v: string) => { setLteFreqInput(v); setLteEarfcnInput('') }
  const handleLteEarfcnChange = (v: string) => { setLteEarfcnInput(v); setLteFreqInput('') }

  // ===== NR 卡片状态 =====
  const [nrFreqInput, setNrFreqInput] = useState('')
  const [nrArfcnInput, setNrArfcnInput] = useState('')
  const [gsnFreqInput, setGsnFreqInput] = useState('')
  const [gsnInput, setGsnInput] = useState('')

  const nrResult = useMemo(() => {
    const freq = parseFloat(nrFreqInput)
    if (nrFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const arfcn = nrFreqToArfcn(freq)
      return arfcn === null ? { error: t('freqConversion.invalid') } : { arfcn, band: matchNrBand(freq) }
    }
    const arfcn = parseInt(nrArfcnInput, 10)
    if (nrArfcnInput.trim() !== '' && Number.isInteger(arfcn)) {
      const f = nrArfcnToFreq(arfcn)
      return f === null ? { error: t('freqConversion.invalid') } : { freq: f, band: matchNrBand(f) }
    }
    return {}
  }, [nrFreqInput, nrArfcnInput, t])

  const gsnResult = useMemo(() => {
    const freq = parseFloat(gsnFreqInput)
    if (gsnFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const r = gsnFreqToGscn(freq)
      return r === null ? { error: t('freqConversion.invalid') } : r
    }
    const gscn = parseInt(gsnInput, 10)
    if (gsnInput.trim() !== '' && Number.isInteger(gscn)) {
      const r = gsnGscnToFreq(gscn)
      return r === null ? { error: t('freqConversion.invalid') } : { actualFreq: r.freqMhz }
    }
    return {}
  }, [gsnFreqInput, gsnInput, t])

  // ===== 渲染 =====
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-base font-bold flex items-center gap-2">
          <RadioTower size={20} className="text-indigo-500" />
          {t('freqConversion.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('freqConversion.subtitle')}</p>
      </div>

      {/* ===== LTE 卡片 ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('freqConversion.lteCard')}</h2>
        <div className="flex gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('freqConversion.direction')}</span>
            <select
              value={lteDirection}
              onChange={e => setLteDirection(e.target.value as LteDirection)}
              className={inputCls + ' w-auto'}
            >
              <option value="DL">{t('freqConversion.dl')}</option>
              <option value="UL">{t('freqConversion.ul')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('freqConversion.band')}</span>
            <select value={lteBand} onChange={e => setLteBand(Number(e.target.value))} className={inputCls + ' w-auto'}>
              {lteBands.map(b => (
                <option key={b.band} value={b.band}>
                  B{b.band} ({b.type}) {b.dlLow}MHz
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.freq')}</span>
            <input
              type="number"
              value={lteFreqInput}
              onChange={e => handleLteFreqChange(e.target.value)}
              placeholder={t('freqConversion.placeholderFreq')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.earfcn')}</span>
            <input
              type="number"
              value={lteEarfcnInput}
              onChange={e => handleLteEarfcnChange(e.target.value)}
              placeholder={t('freqConversion.placeholderEarfcn')}
              className={inputCls + ' mt-1'}
            />
          </label>
        </div>
        {/* 结果 */}
        <div className="text-sm p-3 rounded-lg bg-muted">
          {'error' in lteResult ? (
            <span className="text-red-500">{lteResult.error}</span>
          ) : lteResult.earfcn !== undefined ? (
            <span>
              {t('freqConversion.resultEarfcn')} = <b className="text-primary">{lteResult.earfcn}</b>
            </span>
          ) : lteResult.freq !== undefined ? (
            <span>
              {t('freqConversion.resultFreq')} = <b className="text-primary">{lteResult.freq}</b> MHz
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* ===== NR 卡片（含 GSCN 子区） ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-6">
        <h2 className="text-sm font-semibold">{t('freqConversion.nrCard')}</h2>
        {/* ARFCN 换算区 */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.freq')}</span>
              <input
                type="number"
                value={nrFreqInput}
                onChange={e => { setNrFreqInput(e.target.value); setNrArfcnInput('') }}
                placeholder={t('freqConversion.placeholderFreq')}
                className={inputCls + ' mt-1'}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.arfcn')}</span>
              <input
                type="number"
                value={nrArfcnInput}
                onChange={e => { setNrArfcnInput(e.target.value); setNrFreqInput('') }}
                placeholder={t('freqConversion.placeholderArfcn')}
                className={inputCls + ' mt-1'}
              />
            </label>
          </div>
          <div className="text-sm p-3 rounded-lg bg-muted">
            {'error' in nrResult ? (
              <span className="text-red-500">{nrResult.error}</span>
            ) : nrResult.arfcn !== undefined ? (
              <span>
                {t('freqConversion.resultArfcn')} = <b className="text-primary">{nrResult.arfcn}</b>
                {nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBand')}: {nrResult.band.band})</span>}
                {!nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBandNone')})</span>}
              </span>
            ) : nrResult.freq !== undefined ? (
              <span>
                {t('freqConversion.resultFreq')} = <b className="text-primary">{nrResult.freq}</b> MHz
                {nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBand')}: {nrResult.band.band})</span>}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>
        {/* GSCN 子区 */}
        <div className="border-t border-border pt-4 space-y-4">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('freqConversion.gsnSub')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.gsnFreq')}</span>
              <input
                type="number"
                value={gsnFreqInput}
                onChange={e => { setGsnFreqInput(e.target.value); setGsnInput('') }}
                placeholder={t('freqConversion.placeholderGsnFreq')}
                className={inputCls + ' mt-1'}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.gsn')}</span>
              <input
                type="number"
                value={gsnInput}
                onChange={e => { setGsnInput(e.target.value); setGsnFreqInput('') }}
                placeholder={t('freqConversion.placeholderGscn')}
                className={inputCls + ' mt-1'}
              />
            </label>
          </div>
          <div className="text-sm p-3 rounded-lg bg-muted space-y-1">
            {'error' in gsnResult ? (
              <span className="text-red-500">{gsnResult.error}</span>
            ) : gsnResult.gscn !== undefined ? (
              <>
                <div>
                  {t('freqConversion.resultGscn')} = <b className="text-primary">{gsnResult.gscn}</b>
                </div>
                <div className="text-muted-foreground">
                  {t('freqConversion.actualFreq')}: {gsnResult.actualFreq} MHz · {t('freqConversion.deviation')}: {gsnResult.deviationKHz} kHz
                </div>
              </>
            ) : gsnResult.actualFreq !== undefined ? (
              <div>
                {t('freqConversion.resultFreq')} = <b className="text-primary">{gsnResult.actualFreq}</b> MHz
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            <p className="text-xs text-muted-foreground">{t('freqConversion.gsnHint')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: 类型检查**

Run: `cd frontend && npm run type-check`
Expected: 通过（无新增错误）

**Step 3: 提交**

```bash
git add frontend/src/renderer/pages/FrequencyConversionPage.tsx
git commit -m "feat: 频点换算页面（LTE + NR 含 GSCN 双向实时换算）"
```

---

### Task 5: 路由接入

**Files:**
- Modify: `frontend/src/renderer/App.tsx`

**Step 1: 添加导入与路由** — 在 `import SiteSpacingPage from './pages/SiteSpacingPage'` 后加 `import FrequencyConversionPage from './pages/FrequencyConversionPage'`；在 `/site-spacing` 路由后加：

```tsx
<Route
  path="/frequency-conversion"
  element={
    <ProtectedRoute>
      <FrequencyConversionPage />
    </ProtectedRoute>
  }
/>
```

**Step 2: 类型检查**

Run: `cd frontend && npm run type-check`
Expected: 通过

**Step 3: 提交**

```bash
git add frontend/src/renderer/App.tsx
git commit -m "feat: 注册 /frequency-conversion 路由"
```

---

### Task 6: 边栏入口 + 首页卡片

**Files:**
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx`
- Modify: `frontend/src/renderer/pages/HomePage.tsx`

**Step 1: 边栏** — MainLayout.tsx：
- import 增加 `RadioTower`（lucide-react）
- 「实用工具」分组 children 中 `siteSpacing` 后添加：
  ```tsx
  { type: 'link', name: t('nav.freqConversion'), href: '/frequency-conversion', icon: RadioTower },
  ```

**Step 2: 首页卡片** — HomePage.tsx：
- import 增加 `RadioTower`（lucide-react）
- 站间距 FeatureCard 后添加：
  ```tsx
  <FeatureCard
    title={t('nav.freqConversion')}
    description={t('home.freqConversionDesc')}
    icon={RadioTower}
    link="/frequency-conversion"
    iconColor="text-indigo-600"
  />
  ```

**Step 3: 类型检查**

Run: `cd frontend && npm run type-check`
Expected: 通过

**Step 4: 提交**

```bash
git add frontend/src/renderer/components/Layout/MainLayout.tsx frontend/src/renderer/pages/HomePage.tsx
git commit -m "feat: 边栏添加频点换算入口 + 首页卡片（RadioTower 图标）"
```

---

### Task 7: 验证与收尾

**Step 1: 运行全部算法单测**

Run: `cd frontend && npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts`
Expected: 全部 PASS（约 22 项）

**Step 2: 类型检查 + lint**

Run: `cd frontend && npm run type-check && npm run lint`
Expected: 通过。若 lint 报既有文件的非本次问题，只保证新文件无 error。

**Step 3: 手工验证清单**（启动 `npm run dev:web` + 后端）：

1. 边栏「实用工具」分组展开，确认「频点换算」位于「站间距计算」下方，RadioTower 图标显示
2. 首页新增卡片「频点换算」（indigo 图标），点击跳转 `/frequency-conversion`
3. LTE 卡片：选 B1/DL 输入 2120 → 显示 EARFCN=100；改输入 EARFCN 反向；切 UL 输入 1920 → 18000；TDD 频段（B34）上下行同值
4. NR 卡片：输入 2114.45 → ARFCN=422890 且提示「落在 n1」；输入 2524.95 → 504990 且提示「落在 n41」
5. GSCN 子区：输入 3000 → GSCN=7500；输入 3300 → 8122（实际 3299.52MHz，偏差 480kHz）
6. 非法输入（如 LTE 频率 2000 选 B1）显示红色错误提示
7. 中英文切换，全部文案正确显示
8. 刷新页面后输入清空（无持久化，符合设计）

**Step 4: 提交测试脚本（可选但推荐）** — 在 `package.json` scripts 添加 `"test": "vitest run"`：

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: 添加 vitest 测试脚本"
```

**Step 5: 最终提交**（若 design 文档已含全部）——确认无遗漏文件，检查 `git status` 干净。

---

## 验收标准

- [ ] 算法单测全部通过（LTE 9 项 + NR 9 项 + GSCN 7 项 + 频段表 1 项 ≈ 26 项）
- [ ] `npm run type-check` 通过
- [ ] 边栏入口位置正确（站间距下方）、图标契合语义
- [ ] 首页卡片正确跳转
- [ ] 三种换算实时双向、结果准确、错误提示友好
- [ ] 中英文文案完整
