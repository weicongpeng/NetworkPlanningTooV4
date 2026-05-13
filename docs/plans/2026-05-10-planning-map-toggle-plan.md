# 规划页面地图展示开关 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 PCI 规划、邻区规划、TAC 核查页面添加"地图展示"开关，默认关闭，按需展开地图，解决页面加载卡顿。

**Architecture:** 懒渲染 + CSS 宽度动画。每个页面新增 `showMap` state（默认 false）和 `mapEverLoadedRef`，首次展开时才渲染 OnlineMap，后续切换只做 CSS `transition-[width]` 动画。

**Tech Stack:** React 18 + TypeScript + Tailwind CSS + Zustand

---

### Task 1: 添加 i18n 翻译 keys

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

Add `showMap` translation keys under pci, neighbor, and tac namespaces.

**Step 1: Check existing locale files for relevant sections**

Read the zh.json and en.json files to find the correct insertion points for:
- `pci.showMap` — 地图展示 / Map Display
- `neighbor.showMap` — 地图展示 / Map Display  
- `tac.showMap` — 地图展示 / Map Display

**Step 2: Add keys to zh.json**

Insert after existing `pci.*` entries:
```json
"pci.showMap": "地图展示"
```

Insert after existing `neighbor.*` entries:
```json
"neighbor.showMap": "地图展示"
```

Insert after existing `tac.*` entries:
```json
"tac.showMap": "地图展示"
```

**Step 3: Add keys to en.json**

```json
"pci.showMap": "Map Display"
"neighbor.showMap": "Map Display"
"tac.showMap": "Map Display"
```

**Step 4: Commit**

```bash
git add frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: add showMap i18n keys for planning pages"
```

---

### Task 2: PCIPage — 地图展示开关

**Files:**
- Modify: `frontend/src/renderer/pages/PCIPage.tsx`

**Changes needed:**
1. Add `showMap` state (default `false`)
2. Add `mapEverLoadedRef` (useRef, default `false`)
3. Change layout from `grid-cols-[1fr_0.8fr]` to `flex-row`
   - Left panel: `flex-1 min-w-0`
   - Right panel (map area): collapsible with transition
4. Add toggle button after "应用到工参" button in the result toolbar
5. Conditionally render OnlineMap based on `showMap || mapEverLoadedRef.current`

**Step 1: Add state and ref**

At line ~205 (after existing state declarations), add:
```typescript
const [showMap, setShowMap] = useState(false)
const mapEverLoadedRef = useRef(false)
```

**Step 2: Modify layout structure (~line 1297-1299)**

Change from:
```tsx
<div className="grid grid-cols-1 lg:grid-cols-[1fr_0.8fr] gap-1 min-h-0 flex-1">
  {/* 左列 */}
  <div className="flex flex-col gap-1 min-h-0 overflow-hidden">
```
To:
```tsx
<div className="flex flex-row gap-1 min-h-0 flex-1 overflow-hidden">
  {/* 左列 */}
  <div className="flex flex-col gap-1 min-h-0 overflow-hidden flex-1 min-w-0">
```

**Step 3: Modify right column (map area, ~line 1702-1814)**

Change from:
```tsx
{/* 右列：地理化展示 - 总是显示 */}
<div className="min-h-0">
  <div className="bg-card p-4 rounded-lg border border-border h-full flex flex-col">
    {/* 搜索栏等工具栏 */}
    ...
    {/* OnlineMap */}
    <OnlineMap ... />
  </div>
</div>
```

To a collapsible container:
```tsx
{/* 右列：地理化展示 - 可折叠 */}
<div
  className="overflow-hidden transition-[width] duration-300 flex-shrink-0"
  style={{ width: showMap ? '40%' : '0px' }}
>
  <div className="bg-card p-4 rounded-lg border border-border h-full flex flex-col min-w-[500px]">
    {/* 搜索栏等工具栏 */}
    ...
    {/* Conditional OnlineMap */}
    {(showMap || mapEverLoadedRef.current) && (
      <>
        {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
        <OnlineMap ... />
      </>
    )}
    ...
  </div>
</div>
```

**Step 4: Add toggle button after "应用到工参" (~line 1547)**

After the "应用到工参" button's closing `</button>`, add:
```tsx
<button
  onClick={() => setShowMap(prev => !prev)}
  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-xs font-medium whitespace-nowrap ${
    showMap
      ? 'bg-blue-400 text-white hover:bg-blue-500'
      : 'bg-card border border-border hover:bg-muted/80'
  }`}
>
  <List size={14} />
  {t('pci.showMap') || '地图展示'}
</button>
```

Note: Import `List` from lucide-react if not already imported (line 2 should already have it).

**Step 5: Commit**

```bash
git add frontend/src/renderer/pages/PCIPage.tsx
git commit -m "feat: add map toggle to PCI planning page"
```

---

### Task 3: NeighborPage — 地图展示开关

**Files:**
- Modify: `frontend/src/renderer/pages/NeighborPage.tsx`

**Changes needed:**
1. Add `showMap` state (default `false`), `mapEverLoadedRef`
2. Left panel: change from `w-1/2` to `flex-1 min-w-0`
3. Right panel (map): collapsible with transition
4. Add toggle button after "导出结果" button in the result toolbar
5. Conditionally render OnlineMap

**Step 1: Add state and ref**

After `const [measureMode, setMeasureMode] = useState(false)` (~line 213), add:
```typescript
const [showMap, setShowMap] = useState(false)
const mapEverLoadedRef = useRef(false)
```

**Step 2: Modify left column width (~line 1092)**

Change from:
```tsx
<div className="flex flex-col gap-4 min-h-0 w-1/2 min-w-0">
```
To:
```tsx
<div className="flex flex-col gap-4 min-h-0 flex-1 min-w-0">
```

**Step 3: Modify right column (~line 1329-1439)**

Change from:
```tsx
{/* 右列：地图窗口 */}
<div className="flex flex-col min-h-0 w-1/2 min-w-0">
  <div className="bg-card rounded-lg border border-border p-3 flex-1 flex flex-col min-h-0">
    {/* toolbar, map, etc */}
```
To:
```tsx
{/* 右列：地图窗口 - 可折叠 */}
<div
  className="overflow-hidden transition-[width] duration-300 flex-shrink-0"
  style={{ width: showMap ? '50%' : '0px' }}
>
  <div className="bg-card rounded-lg border border-border p-3 flex-1 flex flex-col min-h-0 min-w-[500px]">
    {/* toolbar, map, etc */}
```

**Step 4: Conditionally render OnlineMap (~line 1420-1432)**

Wrap OnlineMap:
```tsx
{(showMap || mapEverLoadedRef.current) && (
  <>
    {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
    <OnlineMap
      ref={mapRef}
      mode="neighbor-planning"
      neighborData={taskResult?.results || []}
      onSectorClick={handleMapSectorClick}
      onMapReady={() => {
        console.log('[NeighborPage] 地图已就绪')
      }}
      measureMode={measureMode}
      onMeasureModeEnd={handleMeasureModeEnd}
    />
  </>
)}
```

**Step 5: Add toggle button after "导出结果" (~line 1278)**

After the export button `</button>`, inside the `ml-auto` div:
```tsx
<button
  onClick={() => setShowMap(prev => !prev)}
  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-xs font-medium whitespace-nowrap ${
    showMap
      ? 'bg-blue-400 text-white hover:bg-blue-500'
      : 'bg-card border border-border hover:bg-muted/80'
  }`}
>
  <List size={14} />
  {i18n.showMap || '地图展示'}
</button>
```

Need to add `showMap` to the i18n object at the top (~line 131):
```typescript
showMap: t('neighbor.showMap') || '地图展示',
```

**Step 6: Handle empty result state — still show toggle**

The toggle button is currently only visible when `taskResult?.status === 'completed'`. We may want to always show it. But per the user's requirement, they said "在规划结果栏添加" — so the button should be visible whenever the result area has content. Since the button is inside `{taskResult?.status === 'completed' && (...) }`, that's fine for now.

**Step 7: Commit**

```bash
git add frontend/src/renderer/pages/NeighborPage.tsx
git commit -m "feat: add map toggle to neighbor planning page"
```

---

### Task 4: TACPage — 地图展示开关

**Files:**
- Modify: `frontend/src/renderer/pages/TACPage.tsx`

**Changes needed:**
1. Add `showMap` state (default `false`), `mapEverLoadedRef`
2. In the result's two-column layout: left table from `w-1/2` to `flex-1 min-w-0`
3. Right map column: collapsible with transition
4. Add toggle button after "搜索" button in the result toolbar
5. Conditionally render OnlineMap

**Step 1: Add state and ref**

Around line ~93 (after `const [measureMode, setMeasureMode] = useState(false)`), add:
```typescript
const [showMap, setShowMap] = useState(false)
const mapEverLoadedRef = useRef(false)
```

**Step 2: Modify result layout columns (~line 893-895)**

Change left column from:
```tsx
<div className="flex flex-col flex-1 min-w-0 min-h-0 w-1/2">
```
To:
```tsx
<div className="flex flex-col flex-1 min-w-0 min-h-0">
```

Change right column from (~line 1112-1113):
```tsx
{/* 右列：地图窗口 */}
<div className="flex flex-col flex-1 min-w-0 min-h-0 w-1/2">
```
To:
```tsx
{/* 右列：地图窗口 - 可折叠 */}
<div
  className="overflow-hidden transition-[width] duration-300 flex-shrink-0"
  style={{ width: showMap ? '50%' : '0px' }}
>
```

**Step 3: Conditionally render OnlineMap (~line 1134-1140)**

Wrap:
```tsx
{(showMap || mapEverLoadedRef.current) && (
  <>
    {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
    <OnlineMap ... />
  </>
)}
```

**Step 4: Add toggle button after "搜索" (~line 911)**

After the search button `</button>`, add:
```tsx
<button
  onClick={() => setShowMap(prev => !prev)}
  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm ${
    showMap
      ? 'bg-blue-400 text-white hover:bg-blue-500'
      : 'bg-muted hover:bg-muted/80'
  }`}
>
  <List size={16} />
  {t('tac.showMap') || '地图展示'}
</button>
```

Note: `List` is already imported in TACPage.tsx (line 2).

**Step 5: Commit**

```bash
git add frontend/src/renderer/pages/TACPage.tsx
git commit -m "feat: add map toggle to TAC check page"
```

---

### Task 5: TypeScript 编译验证

**Step 1: Run type check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No new errors. Any existing pre-existing errors should be unchanged.

**Step 2: Fix any type errors**

If there are import issues (e.g., `List` not imported), add missing imports.

**Step 3: Commit if fixes needed**

```bash
git add frontend/src/renderer/pages/*.tsx
git commit -m "fix: type check fixes for map toggle feature"
```

---

### 执行顺序

1. Task 1: i18n keys (独立，可先做)
2. Task 2: PCIPage (独立)
3. Task 3: NeighborPage (独立)
4. Task 4: TACPage (独立)
5. Task 5: TypeScript 验证（最后统一检查）

Tasks 1-4 相互独立，可在不同 worktree 中并行执行。

---

### 关键决策点

- **地图容器最小宽度**: 使用 `min-w-[500px]` 确保展开时地图有足够的显示空间
- **地图隐藏时 OnlineMap 卸载问题**: 使用 `mapEverLoadedRef` 确保首次展开后地图永不卸载，后续切换只做 CSS 动画
- **按钮样式**: 展开时高亮（蓝色），收起时默认样式，与其他工具栏按钮保持一致
