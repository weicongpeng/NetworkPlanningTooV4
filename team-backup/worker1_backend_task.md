# Backend Worker Task - Geographic Data Field Detection & Parsing

## Task Overview
修复后端地理化数据字段检测和解析问题。

## Project Path
`d:\mycode\NetworkPlanningTooV3`

## Files to Modify

### 1. `backend/app/services/geo_field_detector.py`

#### Issue 1: 方位角验证范围错误
- **当前问题**: `validate_azimuth()` 方法在第257行验证范围是 `0-360`（度数），但要求是**弧度**
- **修复要求**: 方位角数据应该是弧度单位，范围应该是 `0` 到 `2π`（约 0 到 6.283185）
- **修改位置**: 第256-257行

**当前代码**:
```python
# 方位角范围：0-360
valid_mask = azi_values.between(0, 360) & azi_values.notna()
```

**修改为**:
```python
import math  # 确保导入 math 模块

# 方位角范围：0 到 2π（弧度）
valid_mask = azi_values.between(0, 2 * math.pi) & azi_values.notna()
```

#### Issue 2: WKT列检测使用模糊匹配
- **当前问题**: `FIELD_PATTERNS["wkt"]` 使用模糊匹配，可能误匹配其他列
- **修复要求**: WKT列检测应该使用**精确匹配** "WKT"
- **修改位置**: 第124-138行

**当前代码**:
```python
"wkt": [
    "wkt",
    "WKT",
    "geometry",
    ...
]
```

**修改为**:
```python
"wkt": [
    "WKT",  # 精确匹配
]
```

### 2. `backend/app/services/geo_data_service.py`

#### Issue 3: WKT解析正则表达式无法处理嵌套多边形
- **当前问题**: 第291行的正则表达式 `r'POLYGON\s*\(((.*))\)'` 无法正确处理嵌套多边形
- **修复要求**: 重写 `_parse_wkt()` 方法的坐标提取逻辑
- **修改位置**: 第269-342行

**新的 `_parse_wkt` 方法**:
```python
def _parse_wkt(self, wkt_str: str) -> Tuple[bool, str, List[Tuple[float, float]]]:
    """
    解析WKT字符串为坐标点列表

    Args:
        wkt_str: WKT格式字符串，如 'POLYGON ((lng lat, lng lat, ...))'

    Returns:
        (是否成功, 错误信息, 坐标点列表 [(lng, lat), ...])
    """
    if not wkt_str or not isinstance(wkt_str, str):
        return False, "WKT为空", []

    wkt_str = wkt_str.strip()
    wkt_upper = wkt_str.upper()

    # 检查是否为 POLYGON 格式
    if not wkt_upper.startswith('POLYGON'):
        return False, f"不支持的WKT类型: {wkt_str[:50]}...", []

    try:
        # 找到第一个左括号和对应的右括号
        # POLYGON ((lng lat, lng lat, ...))
        start = wkt_str.find('(')
        if start == -1:
            return False, "WKT格式无法解析：未找到左括号", []

        # 找到对应的右括号（从内向外匹配）
        paren_count = 0
        end = start
        for i in range(start, len(wkt_str)):
            if wkt_str[i] == '(':
                paren_count += 1
            elif wkt_str[i] == ')':
                paren_count -= 1
                if paren_count == 0:
                    end = i
                    break

        coords_str = wkt_str[start + 1:end].strip()
        if not coords_str:
            return False, "WKT坐标为空", []

        # 检查是否有外环/内环 (MULTI-RING)
        # 格式: ((lng lat, ...), (lng lat, ...))
        outer_coords = coords_str
        if coords_str.startswith('(') and coords_str.endswith(')'):
            # 提取外环（第一个括号内的内容）
            inner_start = coords_str.find('(')
            inner_end = coords_str.rfind(')')
            if inner_start != -1 and inner_end != -1:
                outer_coords = coords_str[inner_start + 1:inner_end].strip()

        # 分割坐标对
        # 坐标对之间用逗号分隔
        points: List[Tuple[float, float]] = []

        # 先尝试按逗号分割
        coord_pairs = outer_coords.split(',')

        for pair_str in coord_pairs:
            pair_str = pair_str.strip()
            if not pair_str:
                continue

            # 解析坐标对 (lng lat)
            # 支持多种分隔符：空格
            coords = pair_str.split()

            if len(coords) >= 2:
                try:
                    lng = float(coords[0])
                    lat = float(coords[1])
                    points.append((lng, lat))
                except ValueError:
                    continue

        if len(points) < 3:
            return False, f"WKT点数不足（需要至少3个点）: {len(points)}", []

        return True, "", points

    except Exception as e:
        return False, f"WKT解析失败: {str(e)}", []
```

#### Issue 4: 扇形数据方位角应从弧度转换为度数
- **当前问题**: 方位角数据是弧度，但代码直接存储为度数
- **修复要求**: 从弧度转换为度数用于前端渲染
- **修改位置**: 第224-230行

**当前代码**:
```python
if azi_col and pd.notna(row[azi_col]):
    try:
        azimuth_val = float(row[azi_col])
        point["azimuth"] = azimuth_val % 360
    except (ValueError, TypeError):
        pass
```

**修改为**:
```python
import math  # 确保在文件顶部导入

if azi_col and pd.notna(row[azi_col]):
    try:
        azimuth_radians = float(row[azi_col])
        # 弧度转度数: degrees = radians * (180 / π)
        azimuth_degrees = azimuth_radians * (180 / math.pi)
        point["azimuth"] = azimuth_degrees % 360
    except (ValueError, TypeError):
        pass
```

## Verification Checklist

1. [ ] `geo_field_detector.py` 方位角验证范围改为 0 到 2π
2. [ ] `geo_field_detector.py` WKT列检测改为精确匹配 "WKT"
3. [ ] `geo_data_service.py` WKT解析能正确处理 "POLYGON ((lng lat, ...))" 格式
4. [ ] `geo_data_service.py` 方位角从弧度正确转换为度数

## Implementation Notes

1. 保持其他功能不变
2. 确保 GBK 编码兼容性（错误消息处理）
3. 添加必要的 import 语句
4. 测试验证修改后的功能
