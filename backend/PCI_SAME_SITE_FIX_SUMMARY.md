# PCI 规划同站点冲突修复总结

## 问题描述

在 PCI 规划功能中，出现**同一站点、同一频点**的多个小区被分配了相同 PCI 的问题。

### 业务规则
- ✅ **同一站点、不同频点**的 PCI **可以相同**
- ❌ **同一站点、同一频点**的 PCI **不能相同**

## 根因分析

### 问题特征
**只有NR网络**存在同站同频同PCI问题，LTE网络正常。

### 原因分析

1. **代码路径问题**：
   - `get_available_pcis` 方法已添加PCI直接冲突检查 ✓
   - 但 **"最佳妥协解"代码路径**（约第527行）**绕过了 `get_available_pcis`**！
   - 该代码路径在所有常规策略失败后执行，直接遍历PCI并只检查模值冲突

2. **模值冲突的局限性**：
   - NR网络使用 `mod_value = 30`
   - 同站小区PCI=0和PCI=30的模3都是0，模30分别是0和0
   - 模值检查可以防止同mod冲突，但**不能防止PCI完全相同**（两个PCI=0）

3. **频点判断缺失**：
   - "极端情况"代码路径收集同站PCI时没有区分频点
   - 导致不同频点的PCI被错误地加入冲突集合

### 原始代码逻辑

在 `backend/app/algorithms/pci_planning_service_v2.py` 的 `get_available_pcis` 方法（第300-353行）中：

```python
# 检查每个候选PCI
for pci in candidate_pcis:
    # 检查同站点模值冲突
    if self.check_same_site_mod_conflict(...):
        continue  # 跳过有冲突的PCI
    ...
```

**问题**：代码只检查**模值冲突**（mod3/mod30），但**没有直接检查 PCI 值是否完全相同**。

### 潜在问题场景

1. **数据不一致**：如果某些小区的 `earfcn` 字段缺失或错误，频点判断可能失效
2. **逻辑漏洞**：模值冲突检查可能因边界情况失效
3. **重复保障不足**：缺少 PCI 值的直接冲突检查作为双重保障

## 修复方案

### 核心思路
1. 在所有PCI分配代码路径中，**新增同站点同频点 PCI 直接冲突检查**，作为模值检查的补充保障
2. **修复频点数据传递问题**：确保`earfcn`字段正确获取频点信息
3. **修复频点获取逻辑**：使用显式检查而不是`or`逻辑，正确处理0值

### 关键发现：数据传递问题 ⭐ **根因**

**问题**：在创建`SiteSectorInfo`时，代码获取了`frequency`变量但未使用，而是直接使用`sector_data.get("earfcn")`。

```python
# 原始代码（有BUG）
frequency = (
    sector_data.get("frequency")
    or sector_data.get("earfcn")
    or sector_data.get("ssb_frequency")
)
all_sectors.append(
    SiteSectorInfo(
        ...
        earfcn=sector_data.get("earfcn"),  # ❌ 直接获取earfcn，忽略了frequency变量
    )
)
```

**影响**：
- 如果原始数据中有`frequency`字段但没有`earfcn`字段
- `earfcn`会是None
- 导致频点判断失效，同站小区被视为不同频
- PCI直接冲突检查无法工作

**修复**：
```python
# 修复后的代码
frequency = sector_data.get("frequency")
if frequency is None:
    frequency = sector_data.get("earfcn")
if frequency is None:
    frequency = sector_data.get("ssb_frequency")
all_sectors.append(
    SiteSectorInfo(
        ...
        earfcn=frequency,  # ✓ 使用统一的频点变量
    )
)
```

### 修改内容

### 修改内容

**文件**：`backend/app/algorithms/pci_planning_service_v2.py`

**修改位置1（根因修复）**：创建`SiteSectorInfo`时的频点数据传递（约第669-695行）

**问题**：获取了`frequency`变量但未使用

**修复**：
```python
# 使用显式检查，因为0是有效值但or会跳过0
frequency = sector_data.get("frequency")
if frequency is None:
    frequency = sector_data.get("earfcn")
if frequency is None:
    frequency = sector_data.get("ssb_frequency")
# ...
earfcn=frequency,  # 使用统一的频点变量
```

**修改位置2**：背景工参数据的频点获取（约第743-751行）

**问题**：使用`or`逻辑会跳过0值

**修复**：
```python
# 获取频点（使用显式检查，因为0是有效值）
bg_frequency = sector_data.get("frequency")
if bg_frequency is None:
    bg_frequency = sector_data.get("earfcn")
if bg_frequency is None:
    bg_frequency = sector_data.get("ssb_frequency")
```

**修改位置3**：规划循环中的频点获取（约第794-798行）

**问题**：使用`or`逻辑会跳过0值

**修复**：
```python
# 使用显式检查，因为0是有效值
frequency = sector_data.get("frequency")
if frequency is None:
    frequency = sector_data.get("earfcn")
if frequency is None:
    frequency = sector_data.get("ssb_frequency")
```

**修改位置4**：`get_available_pcis` 方法（约第300行）

**新增代码**：

```python
# 获取同站点已分配的PCI，用于直接冲突检查（同频点）
same_site_sectors = self.get_same_site_sectors(
    target_lat, target_lon, exclude_sector_id, all_sectors
)
same_site_pcis_same_freq = set()
for sector in same_site_sectors:
    # 只检查同频小区的PCI
    if self._is_same_frequency(target_earfcn, sector.earfcn):
        if sector.pci is not None and sector.pci >= 0:
            same_site_pcis_same_freq.add(sector.pci)

# 检查每个候选PCI
for pci in candidate_pcis:
    # 新增：直接检查同站点同频点是否已使用相同PCI
    # 这是硬约束，同站点同频点不能使用完全相同的PCI
    if pci in same_site_pcis_same_freq:
        continue  # 跳过同站点同频点已使用的PCI
    ...
```

**修改位置5**：`assign_pci` 方法中的"最佳妥协解"代码路径（约第527行）

**问题**：这个代码路径绕过了 `get_available_pcis` 方法，直接遍历PCI并只检查模值冲突，导致同站同频同PCI问题。

**新增代码**：

```python
# 获取同站点已分配的PCI，用于直接冲突检查（同频点）
same_site_sectors_fallback = self.get_same_site_sectors(
    sector.latitude, sector.longitude, sector.id, all_sectors
)
same_site_pcis_same_freq_fallback = set()
for s in same_site_sectors_fallback:
    # 只检查同频小区的PCI
    if self._is_same_frequency(sector.earfcn, s.earfcn):
        if s.pci is not None and s.pci >= 0:
            same_site_pcis_same_freq_fallback.add(s.pci)

for pci in self.pci_range:
    # 关键修复：首先检查同站点同频点是否已使用相同PCI（硬约束）
    if pci in same_site_pcis_same_freq_fallback:
        continue  # 跳过同站点同频点已使用的PCI
    ...
```

**修改位置6**：`assign_pci` 方法中的"极端情况"代码路径（约第585行）

**问题**：收集同站小区PCI时没有区分频点，导致可能错误地跳过可用PCI。

**修改前**：
```python
same_site_pcis = {
    s.pci
    for s in self.get_same_site_sectors(...)
    if s.pci is not None
}
```

**修改后**：
```python
same_site_pcis = {
    s.pci
    for s in self.get_same_site_sectors(...)
    if s.pci is not None and self._is_same_frequency(sector.earfcn, s.earfcn)
}
```

### 设计原则

1. **Single Responsibility Principle**：PCI 直接冲突检查是独立的关注点
2. **KISS Principle**：使用简单的 Set 查找，时间复杂度 O(1)
3. **Fail-Safe**：作为模值检查的双重保障

## NR网络特殊性

**为什么只有NR网络有问题？**

1. **模值差异**：
   - LTE：`mod_value = 3`，只检查mod3冲突
   - NR：`mod_value = 30`，**同时检查mod3和mod30冲突**

2. **PCI范围更大**：
   - LTE：0-503
   - NR：0-1007

3. **代码路径触发**：
   - NR网络由于PCI范围大、约束复杂（mod3+mod30），更容易触发"最佳妥协解"路径
   - 一旦触发该路径，如果没有PCI直接冲突检查，就会导致同站同频同PCI问题

## 频点判断逻辑

修复使用了现有的 `_is_same_frequency` 方法（第227-253行），确保逻辑一致性：

```python
def _is_same_frequency(self, earfcn1: Optional[float], earfcn2: Optional[float]) -> bool:
    """判断两个频点是否相同

    规则：
    - 如果两者都有值且差值 <= 0.1，视为同频
    - 如果两者都为None，视为同频（向后兼容）
    - 如果一个有值一个为None，视为不同频
    """
    if earfcn1 is not None and earfcn2 is not None:
        return abs(earfcn1 - earfcn2) <= 0.1
    elif earfcn1 is None and earfcn2 is None:
        return True
    else:
        return False
```

## 验证测试建议

### 测试场景

1. **正常场景**：同站点3个小区，同频点，验证分配不同 PCI
2. **边界场景**：同站点2个小区，频点差值为 0.1，验证被视为同频
3. **混合场景**：同站点多个小区，部分同频部分不同频，验证不同频可相同 PCI

### 预期结果

- 同站点同频点的小区 PCI 互不相同
- 同站点不同频点的小区 PCI 可以相同
- 模值约束仍然生效（mod3/mod30）

## 修改影响范围

**影响文件**：
- `backend/app/algorithms/pci_planning_service_v2.py`

**不影响**：
- API 接口层
- 前端组件
- 数据存储

**向后兼容**：完全兼容，不影响现有功能

## 修改日期

2026-02-25

## 修改人员

Claude Code (AI Assistant)
