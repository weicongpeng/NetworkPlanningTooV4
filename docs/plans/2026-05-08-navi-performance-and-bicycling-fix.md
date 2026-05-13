# 导航规划效率优化 & 骑行路线失败排查

**日期**: 2026-05-08
**目标**: 分析导航规划慢的瓶颈 + 排查骑行导航无法规划路线的原因

---

## 1. 导航规划效率瓶颈分析

### 1.1 当前流程
```
用户点击目的地
  → NavigationPanel 显示 (resetState)
  → useEffect 触发: getOrigin() + planRoute()
    → getOrigin(): Location.getCurrentPositionAsync({ accuracy: High })
    → planRoute(): 前端请求 → 后端代理 → 高德API → 返回路线
```

### 1.2 瓶颈定位

**GPS定位是主要瓶颈**（室内/室外均慢）:

| 阶段 | 耗时估算 | 问题 |
|------|----------|------|
| `getCurrentPositionAsync` (High精度) | **5-30秒** | 室内无GPS信号时超时极慢，室外冷启动也需数秒 |
| 高德API路线规划 | 1-3秒 | 网络延迟，基本正常 |
| 前端/后端处理 | <1秒 | 正常 |

**根因**:
1. `getCurrentPositionAsync({ accuracy: Accuracy.High })` 在室内无法获取GPS信号，需要等待超时（默认30秒）才返回
2. 每次打开导航面板都会重新获取GPS位置，没有缓存机制
3. 权限检查 `requestLocationPermission()` 在 `getCurrentPosition` 和 `startNavigation` 中被重复调用

### 1.3 优化方案

| 优化项 | 方案 |
|--------|------|
| GPS定位优化 | 先用 `Accuracy.Balanced` 快速获取粗略位置（1-2秒），失败再降级到 `Accuracy.High` |
| 起点缓存 | 缓存最近一次GPS位置（5分钟内有效），避免重复获取 |
| 超时控制 | GPS定位设置 5秒超时，超时后使用缓存位置或提示用户 |
| 权限去重 | 只调用一次权限检查 |

---

## 2. 骑行导航无法规划路线排查

### 2.1 问题定位

**后端代理 `strategy` 参数问题**:

```python
# backend/app/api/v1/endpoints/map.py L341-346
params = {
    "key": settings.AMAP_API_KEY,
    "origin": origin,
    "destination": destination,
    "strategy": "0",  # ← 问题所在！
}
```

高德API文档:
- `driving` 端点: 支持 `strategy` 参数（0=速度优先）
- `walking` 端点: **不支持** `strategy` 参数
- `bicycling` 端点: **不支持** `strategy` 参数

当步行/骑行请求携带了 `strategy` 参数时，高德API可能返回空结果或错误（`infocode=INVALID_USER_DOMAIN`），前端收到 `paths=[]` 显示"未找到可用导航路线"。

### 2.2 修复方案

根据出行方式动态设置参数:
- `driving`: 保留 `strategy=0`
- `walking` / `bicycling`: 移除 `strategy` 参数

### 2.3 额外优化

后端添加日志输出，方便排查未来问题:
- 记录请求参数和响应状态
- 返回更详细的错误信息给前端

---

## 3. 修改文件汇总

| 文件 | 修改内容 |
|------|----------|
| `backend/app/api/v1/endpoints/map.py` | 移除步行/骑行的 `strategy` 参数，添加日志 |
| `mobile-app/src/services/navigationService.ts` | GPS定位优化（降级精度+缓存+超时控制） |
