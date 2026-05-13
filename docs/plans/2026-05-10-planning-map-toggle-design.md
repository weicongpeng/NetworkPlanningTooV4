# 规划页面地图展示开关设计

## 背景

桌面端 PCI 规划、邻区规划、TAC 核查页面在页面加载时始终渲染地图组件（OnlineMap），导致功能页面加载时出现明显卡顿。需要为地图添加展示开关，默认隐藏地图，用户按需展开。

## 方案：懒渲染 + CSS 宽度动画

**核心机制：**
1. `showMap`（useState）控制地图的展开/收起状态，默认 `false`
2. `mapEverLoadedRef`（useRef）：首次打开地图后标记为 `true`，后续切换只控制 CSS 可见性
3. 页面初次加载时**不渲染 OnlineMap**，彻底根除卡顿
4. 首次点击展开时渲染地图（可能有短暂初始化延迟，仅一次）
5. 后续切换：纯 CSS `transition-[width]` 动画，瞬间响应

## 三页布局改造

### PCIPage（`grid-cols-[1fr_0.8fr]` → `flex-row`）
- 改用 `flex-row` 布局，左侧内容区 `flex-1`，右侧地图区 `flex-shrink-0`
- 地图容器：`overflow-hidden transition-[width] duration-300`
- 收起：`width: 0`，展开：`width: 0.8fr` 的对应像素值（约 40%）
- 开关位置：结果面板中"应用到工参"按钮右侧

### NeighborPage（当前 `flex-row w-1/2`）
- 左侧内容从 `w-1/2` 改为 `flex-1`（地图隐藏时占满）
- 右侧地图从 `w-1/2` 改为可折叠容器
- 开关位置：结果面板中"导出结果"按钮右侧

### TACPage（地图在内部两栏布局中）
- 结果面板内的 flex-row 中，左侧表格从 `w-1/2` 改为 `flex-1`
- 右侧地图从 `w-1/2` 改为可折叠容器
- 开关位置：结果面板中"搜索"按钮右侧

## 地图首次渲染优化

- 首次点击"地图展示"开关时才创建 OnlineMap 实例
- OnlineMap props（mode, data, 回调等）在首次渲染时传入
- `mapEverLoadedRef` 确保后续切换只做 CSS 动画，不做 React 渲染/卸载

## 组件改动清单

| 文件 | 改动 |
|------|------|
| `PCIPage.tsx` | 新增 `showMap`/`mapEverLoadedRef`，布局改为 flex，条件渲染 OnlineMap，按钮添加 |
| `NeighborPage.tsx` | 同上模式 |
| `TACPage.tsx` | 同上模式 |

## 性能预期

- 页面初次加载：地图不渲染 → 卡顿消除
- 首次展开地图：约 200-500ms 初始化（仅一次）
- 后续切换：纯 CSS 动画，~300ms 平滑过渡
