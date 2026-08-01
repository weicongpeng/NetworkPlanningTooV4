# 新站录入方向角超范围输入拦截 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 方向角输入超范围值(>360)时直接提示且不让输入,避免导入时误报"没有待导入的数据"。

**Architecture:** 新增 `handleAzimuthChange` 处理器,在 `onChange` 中先 `filterDigits`,解析后若 >360 则复用 `batchError` 提示并拒绝写入 state;否则正常更新。方向角 input 的 `onChange` 改用它。

**Tech Stack:** React 18 + TypeScript。

---

## Task 1: 新增 `handleAzimuthChange` 并接入方向角 input

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `updateRow` 定义之后（约 `:1500`）新增 `handleAzimuthChange`
  - `:2028`（方向角 input 的 `onChange`）

**Step 1: 新增 `handleAzimuthChange`**（在 `updateRow` 定义之后插入）

```typescript
  // 方向角输入：过滤数字后若超范围(>360)则提示并拒绝写入,否则正常更新
  const handleAzimuthChange = (rowId: string, value: string) => {
    const cleaned = filterDigits(value)
    if (cleaned === '') { updateRow(rowId, 'azimuth', ''); return } // 允许清空
    const num = parseInt(cleaned, 10)
    if (!isNaN(num) && num > 360) {
      setBatchError(t('newCellEntry.azimuthRangeError') || '方向角必须在 0-360 之间')
      setTimeout(() => setBatchError(null), 3000)
      return // 拒绝输入，保留原值
    }
    updateRow(rowId, 'azimuth', cleaned)
  }
```

**Step 2: 方向角 input 的 `onChange` 改用它**（`:2028`）

当前：
```tsx
                    <input className={curInputCls} data-field="azimuth" type="text" inputMode="numeric" value={row.azimuth} onChange={e => updateRow(row.id, 'azimuth', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="0-360" />
```

改为：
```tsx
                    <input className={curInputCls} data-field="azimuth" type="text" inputMode="numeric" value={row.azimuth} onChange={e => handleAzimuthChange(row.id, e.target.value)} disabled={!hasFullParams || isAddingCell} placeholder="0-360" />
```

**Step 3: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误（397/477/478/581 行），无新增。

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 方向角超范围输入即时拦截提示"
```

---

## Task 2: 最终验证

**Step 1: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 259（与基线一致），DataPage.tsx 仅 4 处既有错误（397/477/478/581）

**Step 2: 手工验证清单**（前端启动后 `npm run dev:web`）

1. 方向角输 `365` → 立即提示"方向角必须在 0-360 之间"，单元格回到原值
2. 方向角输 `360` → 合法，正常保留
3. 方向角输 `36` → 合法
4. 方向角清空 → 允许
5. 超范围被拦截后点"一键导入" → 不再误报"没有待导入的数据"（因为单元格已回到有效值或空）
