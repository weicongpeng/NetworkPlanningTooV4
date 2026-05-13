# 导航规划效率优化 & 骑行路线修复 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 优化导航规划速度（GPS定位降级+缓存），修复骑行/步行导航路线无法规划的问题

**Architecture:** 修改后端高德API代理逻辑（移除步行/骑行的strategy参数），优化前端GPS定位策略（精度降级+缓存+超时控制）

**Tech Stack:** FastAPI (后端代理), React Native + expo-location (前端GPS), 高德方向规划API

---

### Task 1: 修复后端骑行/步行路线规划（移除strategy参数）

**Files:**
- Modify: `backend/app/api/v1/endpoints/map.py:316-365`

**Step 1: 修改 get_direction 端点**

将 `strategy` 参数改为仅在驾车模式时添加：

```python
# 原代码 (L341-346):
params = {
    "key": settings.AMAP_API_KEY,
    "origin": origin,
    "destination": destination,
    "strategy": "0",
}

# 修改为:
params = {
    "key": settings.AMAP_API_KEY,
    "origin": origin,
    "destination": destination,
}
# 仅驾车模式添加 strategy 参数
if api_mode == "driving":
    params["strategy"] = "0"
```

**Step 2: 添加请求日志**

在 try 块开头添加日志：
```python
logger.info(f"[Direction] mode={mode} api_mode={api_mode} origin={origin} dest={destination}")
```

需要确保文件顶部有 logger 导入：
```python
import logging
logger = logging.getLogger(__name__)
```

**Step 3: 验证**

```bash
cd backend
python -c "
from app.api.v1.endpoints.map import MODE_MAP
print('MODE_MAP:', MODE_MAP)
print('drive -> driving')
print('walk -> walking')  
print('bicycling -> bicycling')
"
```

Expected: MODE_MAP 正确映射

**Step 4: Commit**
```bash
git add backend/app/api/v1/endpoints/map.py
git commit -m "fix: 移除步行/骑行导航的strategy参数，修复路线规划失败"
```

---

### Task 2: 优化前端GPS定位速度

**Files:**
- Modify: `mobile-app/src/services/navigationService.ts:146-165` (getCurrentPosition)
- Modify: `mobile-app/src/services/navigationService.ts:59-80` (新增缓存变量)

**Step 1: 添加GPS位置缓存变量**

在文件顶部状态变量区域（~L76）添加：

```typescript
// GPS位置缓存（避免重复获取）
let _cachedPosition: { lat: number; lng: number; timestamp: number } | null = null;
const POSITION_CACHE_TTL = 5 * 60 * 1000; // 5分钟
```

**Step 2: 重写 getCurrentPosition 函数**

替换原有函数（L153-165）：

```typescript
/** 获取当前位置（WGS84），优先缓存，快速降级 */
export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  // 1. 检查缓存（5分钟内有效）
  if (_cachedPosition && Date.now() - _cachedPosition.timestamp < POSITION_CACHE_TTL) {
    console.log('[NaviService] getCurrentPosition: 使用缓存位置');
    return { lat: _cachedPosition.lat, lng: _cachedPosition.lng };
  }

  // 2. 权限检查（只调一次）
  const ok = await requestLocationPermission();
  if (!ok) return null;

  // 3. 先用 Balanced 精度快速尝试（1-2秒，适合室外/有网络定位）
  try {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      timeout: 5000,
    });
    const result = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    _cachedPosition = { ...result, timestamp: Date.now() };
    console.log('[NaviService] getCurrentPosition: Balanced精度成功');
    return result;
  } catch (e) {
    console.log('[NaviService] getCurrentPosition: Balanced失败，尝试High精度');
  }

  // 4. 降级到 High 精度（室内可能需要更久）
  try {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      timeout: 8000,
    });
    const result = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    _cachedPosition = { ...result, timestamp: Date.now() };
    console.log('[NaviService] getCurrentPosition: High精度成功');
    return result;
  } catch (e) {
    console.error('[NaviService] getCurrentPosition: 所有精度均失败', e);
    // 5. 如果缓存可用且较新（1分钟内），返回缓存作为兜底
    if (_cachedPosition && Date.now() - _cachedPosition.timestamp < 60000) {
      console.log('[NaviService] getCurrentPosition: 使用过期缓存兜底');
      return { lat: _cachedPosition.lat, lng: _cachedPosition.lng };
    }
    return null;
  }
}
```

**Step 3: 验证编译**

```bash
cd mobile-app
npx tsc --noEmit
```

Expected: 无类型错误

**Step 4: Commit**
```bash
git add mobile-app/src/services/navigationService.ts
git commit -m "perf: 优化GPS定位速度（精度降级+缓存+超时控制）"
```

---

### Task 3: 清除后端缓存（重启后端服务）

**说明:** 后端代码修改后需要重启 FastAPI 服务使修改生效。

**Step 1: 重启后端**

```bash
# 如果在开发环境：
cd backend
# 停止现有服务 (Ctrl+C)，然后重启
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Step 2: 验证API端点**

```bash
# 测试驾车模式（应该正常）
curl "http://localhost:8000/api/v1/map/direction?origin=113.123,23.456&destination=113.124,23.457&mode=drive"

# 测试步行模式（之前失败，修复后应该正常）
curl "http://localhost:8000/api/v1/map/direction?origin=113.123,23.456&destination=113.124,23.457&mode=walk"

# 测试骑行模式（之前失败，修复后应该正常）
curl "http://localhost:8000/api/v1/map/direction?origin=113.123,23.456&destination=113.124,23.457&mode=bicycling"
```

Expected: 三种模式均返回 `{"success": true, "data": {...}}`

---

### Task 4: 端到端测试

**说明:** 在APP中验证所有功能

**Step 1: 测试导航规划速度**

1. 打开APP → 选择一个目的地 → 点击导航
2. 观察"正在规划路线..."的加载时间
3. Expected: 从原来5-30秒缩短到2-5秒

**Step 2: 测试骑行导航**

1. 选择目的地 → 切换到"骑行"模式
2. 点击"开始导航"
3. Expected: 成功规划路线，显示路线预览

**Step 3: 测试步行导航**

1. 选择目的地 → 切换到"步行"模式  
2. 点击"开始导航"
3. Expected: 成功规划路线，显示路线预览

**Step 4: 测试室内定位**

1. 在室内（无GPS信号环境）打开导航
2. Expected: 使用缓存位置或Balanced网络定位，不卡死等待

---

### Task 5: 回归测试 - 驾车导航

**说明:** 确保修复不影响驾车导航

**Step 1: 测试驾车导航**

1. 选择目的地 → 保持"驾车"模式
2. 点击"开始导航"
3. Expected: 正常规划路线（strategy=0 仍然生效）
