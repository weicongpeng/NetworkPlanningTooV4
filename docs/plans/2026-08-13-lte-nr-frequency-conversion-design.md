# LTE/NR 频点换算功能设计

**日期**: 2026-08-13
**状态**: 已批准
**分支**: layer-tools

## 概述

参考「频点换算方法.pdf」开发 LTE 与 NR 无线网络频点换算功能：LTE EARFCN ↔ 频率、NR-ARFCN ↔ 频率、GSCN ↔ SSB 频率的双向实时换算。在左侧边栏「实用工具」分组「站间距计算」下方添加入口，并在首页添加对应卡片。

## 需求决策

| 决策点 | 选择 |
|--------|------|
| 计算位置 | 纯前端实现（无后端 API） |
| LTE 频段 | 国内常用 9 段（B1/3/5/8/34/38/39/40/41） |
| GSCN | 包含，嵌入 NR 卡片内（不单独卡片） |
| 交互形式 | 输入即实时双向展示（无按钮） |

## 算法层（`frontend/src/renderer/utils/frequencyConversion.ts`）

纯函数模块，可独立单元测试。所有公式基于 3GPP TS 36.101（LTE）、TS 38.104（NR/GSCN）。

### LTE EARFCN

Band 表（数据来自 PDF，PDF 内置测试向量已验证）：

| Band | 类型 | DL 低频率 | DL offset | UL 低频率 | UL offset |
|------|------|-----------|-----------|-----------|-----------|
| 1 | FDD | 2110 | 0 | 1920 | 18000 |
| 3 | FDD | 1805 | 1200 | 1710 | 19200 |
| 5 | FDD | 869 | 2400 | 824 | 20400 |
| 8 | FDD | 925 | 3450 | 880 | 21450 |
| 34 | TDD | 2010 | 36200 | 2010 | 36200 |
| 38 | TDD | 2570 | 37750 | 2570 | 37750 |
| 39 | TDD | 1880 | 38250 | 1880 | 38250 |
| 40 | TDD | 2300 | 38650 | 2300 | 38650 |
| 41 | TDD | 2496 | 39650 | 2496 | 39650 |

公式：
- `EARFCN = N_off + (F - F_low) / 0.1`
- `F = F_low + 0.1 × (EARFCN - N_off)`

输入校验：频率需落在该方向有效带宽内；EARFCN 需为非负整数。

### NR-ARFCN

全局三段公式，不依赖 Band、不分方向：

| 频率范围 | 栅格 | 公式 |
|----------|------|------|
| 0 – 3000 MHz | 5 kHz | `N = F × 200` |
| 3000 – 24250 MHz | 15 kHz | `N = 600000 + (F - 3000) × 1000/15` |
| 24250 – 100000 MHz | 60 kHz | `N = 2016667 + (F - 24250.08) × 1000/60` |

输入频率超 0–100000 MHz 提示越界。

### GSCN（3GPP TS 38.104 Table 5.4.3.1-1）

三段全局同步栅格：

| SSB 频率范围 | 栅格 | 公式 |
|--------------|------|------|
| 0 – 3000 MHz | 1.2 MHz | `GSCN = 3N`，`F = N × 1.2` |
| 3000 – 24250 MHz | 1.44 MHz | `GSCN = 3N + 7498`，`F = 3000 + N × 1.44` |
| 24250 – 100000 MHz | 17.28 MHz | `GSCN = 3N + 22256`，`F = 24250.08 + N × 17.28` |

- GSCN → 频率：`F = 基准 + N×栅格`
- 频率 → GSCN：`N = round((F - 基准)/栅格)`，反算实际频率并显示偏差；GSCN 为离散同步栅格点，仅 SSB 中心频率有效

### 导出函数

```typescript
lteFreqToEarfcn(band: number, freqMhz: number, direction: 'DL'|'UL'): number | null
lteEarfcnToFreq(band: number, earfcn: number, direction: 'DL'|'UL'): number | null
nrFreqToArfcn(freqMhz: number): number | null
nrArfcnToFreq(arfcn: number): number | null
gsnFreqToGscn(freqMhz: number): { gscn: number; actualFreq: number; deviationKHz: number } | null
gsnGscnToFreq(gscn: number): { freqMhz: number } | null
getLteBandTable(): LteBand[]
getNrBandTable(): NrBand[]
```

## UI 布局（`frontend/src/renderer/pages/FrequencyConversionPage.tsx`）

标题 + 简要说明；主体为 2 张功能卡片（LTE / NR 含 GSCN）。

### LTE 卡片

方向选择（DL/UL）→ 频段下拉（9 段，格式 `B1 (FDD) 2110MHz`）→ 频率(MHz) 与 EARFCN 双向实时换算。输入任一即算另一个，改值即刷新。FDD 显示上下行对称信息，TDD 上下行同频同点。越界/非法输入显示内联错误提示。

### NR 卡片（含 GSCN 子区）

- **ARFCN 换算区**：频率(MHz) ↔ NR-ARFCN 双向实时换算；结果附带 NR 频段校验（内置 n1/n3/n5/n8/n28/n41/n77/n78/n79 等常用频段表，频率落在某频段范围时提示）
- **GSCN 子区**（分隔线 + 小标题区分）：SSB 频率(MHz) ↔ GSCN 双向实时换算；频率→GSCN 取最近栅格点，显示实际频率与偏差，并提示「GSCN 仅对 SSB 中心频率有效」

### 交互原则（全卡片通用）

- 输入即算，用 `useMemo` 派生，无需 useEffect
- 双向锁定：以最后修改的输入为基准算另一个；清空两输入恢复初始
- 错误处理：非法/越界 → 内联红色提示 + 结果区"—"；卡片间不连坐
- 样式沿用现有卡片样式，输入框与项目现有 Input 组件一致
- 全部文案走 `t()`，zh/en 同步

无后端、无状态持久化（换算值无跨页保留价值）。

## 集成

### 路由（`App.tsx`）

```tsx
<Route path="/frequency-conversion" element={<ProtectedRoute><FrequencyConversionPage /></ProtectedRoute>} />
```

### 边栏（`MainLayout.tsx`）

「实用工具」分组内 `siteSpacing` 之后添加 `{ type: 'link', name: t('nav.freqConversion'), href: '/frequency-conversion' }`，图标 `RadioTower`。

### 首页卡片（`HomePage.tsx`）

站间距卡片后添加 FeatureCard，`icon={RadioTower}`，`iconColor="text-indigo-600"`。

### i18n

- `nav.freqConversion`：频点换算 / Frequency Conversion
- `home.freqConversionDesc`：LTE/NR 频点与频率双向换算，含 GSCN / LTE/NR frequency & EARFCN/NR-ARFCN conversion incl. GSCN
- 页面内部键约 15-20 个，双语同步

### 文件清单

| 文件 | 操作 |
|------|------|
| `frontend/src/renderer/utils/frequencyConversion.ts` | 新建（算法模块） |
| `frontend/src/renderer/utils/__tests__/frequencyConversion.test.ts` | 新建（单测） |
| `frontend/src/renderer/pages/FrequencyConversionPage.tsx` | 新建（UI） |
| `frontend/src/renderer/App.tsx` | 修改（路由） |
| `frontend/src/renderer/components/Layout/MainLayout.tsx` | 修改（边栏入口） |
| `frontend/src/renderer/pages/HomePage.tsx` | 修改（首页卡片） |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 修改（翻译） |

## 测试与验证

1. **单元测试**（算法层）：
   - PDF 已验向量：B1 2120MHz→100、B3 1870MHz→1850、B34 2017.5MHz→36275、NR 2114.45MHz→422890、NR 2524.95MHz→504990
   - 反向往返一致性（EARFCN→频率→EARFCN 等）
   - GSCN 边界：3000MHz↔7498、24250.08MHz↔22256、三段往返一致性
   - 边界/非法输入：越界频率、负数 EARFCN、超范围 ARFCN → null
2. **前端类型检查**：`npm run type-check` 通过
3. **手工验证**：边栏入口位置（站间距下方）、首页卡片、三种换算实时联动、中英文切换、非法输入提示
