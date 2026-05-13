"""
邻区规划案例分析脚本
分析为什么特定的小区没有被添加为邻区
"""

import math
import pandas as pd

# 小区数据
source_cell = {
    "id": "541265_16",
    "name": "待规划小区",
    "lon": 114.681700,
    "lat": 23.765660,
    "azimuth": 60,
    "cell_cover_type": 1  # 假设室外
}

# 目标小区（需要添加的邻区）
target_cells = [
    {"id": "541307_53", "name": "目标小区1"},
    {"id": "103613_131", "name": "目标小区2"},
    {"id": "541163_51", "name": "目标小区3"},
]

# 从全量工参中查找这些小区的详细信息
# 先读取数据文件
import json
import os
from pathlib import Path

data_dir = Path("data")
index_file = data_dir / "index.json"

print("=" * 80)
print("邻区规划案例分析")
print("=" * 80)

# 查找数据文件
if index_file.exists():
    with open(index_file, "r", encoding="utf-8") as f:
        index = json.load(f)

    print(f"\n找到 {len(index)} 个数据文件")

    # 查找全量工参数据
    full_params_data = None
    for data_id, info in index.items():
        if info.get("fileType") == "full_params":
            data_file = data_dir / data_id / "data.json"
            if data_file.exists():
                with open(data_file, "r", encoding="utf-8") as f:
                    full_params_data = json.load(f)
                print(f"已加载全量工参数据: {info['name']}")
                break

    if full_params_data:
        # 查找目标小区的详细信息
        print("\n" + "=" * 80)
        print("查找目标小区信息")
        print("=" * 80)

        found_cells = []

        for network in ["LTE", "NR"]:
            if network not in full_params_data:
                continue

            for site in full_params_data[network]:
                for sector in site.get("sectors", []):
                    sector_id = str(sector.get("id", ""))
                    for target in target_cells:
                        if target["id"] == sector_id:
                            cell_info = {
                                "id": sector_id,
                                "name": sector.get("name", ""),
                                "site_id": site.get("id", ""),
                                "site_name": site.get("name", ""),
                                "lon": sector.get("longitude", site.get("longitude", 0)),
                                "lat": sector.get("latitude", site.get("latitude", 0)),
                                "azimuth": sector.get("azimuth"),
                                "pci": sector.get("pci"),
                                "earfcn": sector.get("earfcn"),
                                "cell_cover_type": sector.get("cell_cover_type", 1),
                                "network": network
                            }
                            found_cells.append(cell_info)
                            print(f"\n找到: {target['id']}")
                            print(f"  站点: {cell_info['site_id']} ({cell_info['site_name']})")
                            print(f"  小区: {cell_info['id']} ({cell_info['name']})")
                            print(f"  经纬度: ({cell_info['lon']}, {cell_info['lat']})")
                            print(f"  方向角: {cell_info['azimuth']}°")
                            print(f"  PCI: {cell_info['pci']}")
                            print(f"  覆盖类型: {cell_info['cell_cover_type']} ({'室分' if cell_info['cell_cover_type'] == 4 else '室外'})")

        # 计算距离和分析
        print("\n" + "=" * 80)
        print("距离计算和筛选分析")
        print("=" * 80)

        # 规划参数
        COVERAGE_DISTANCE_FACTOR = 1.0
        COVERAGE_RADIUS_FACTOR = 1.0
        DEFAULT_COVERAGE_DISTANCE = 1000.0  # 米

        def calculate_distance(lat1, lon1, lat2, lon2):
            """计算两点之间的距离（公里）"""
            lat1_rad = math.radians(lat1)
            lon1_rad = math.radians(lon1)
            lat2_rad = math.radians(lat2)
            lon2_rad = math.radians(lon2)

            dlat = lat2_rad - lat1_rad
            dlon = lon2_rad - lon1_rad
            a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
            c = 2 * math.asin(math.sqrt(a))

            return c * 6371

        def calculate_coverage_circle_center(lat, lon, azimuth, distance_factor, coverage_distance):
            """计算覆盖圆圆心位置"""
            offset_distance = (coverage_distance / 2) * distance_factor / 1000  # 转换为公里

            lat_rad = math.radians(lat)
            lon_rad = math.radians(lon)
            azimuth_rad = math.radians(azimuth)

            angular_distance = offset_distance / 6371

            center_lat = math.asin(
                math.sin(lat_rad) * math.cos(angular_distance) +
                math.cos(lat_rad) * math.sin(angular_distance) * math.cos(azimuth_rad)
            )

            center_lon = lon_rad + math.atan2(
                math.sin(azimuth_rad) * math.sin(angular_distance) * math.cos(lat_rad),
                math.cos(angular_distance) - math.sin(lat_rad) * math.sin(center_lat)
            )

            return math.degrees(center_lat), math.degrees(center_lon)

        def calculate_coverage_radius(coverage_distance, radius_factor):
            """计算覆盖圆半径（公里）"""
            return (coverage_distance * radius_factor) / 1000

        def are_coverage_circles_intersecting(center1_lat, center1_lon, radius1,
                                              center2_lat, center2_lon, radius2):
            """判断两个覆盖圆是否相交"""
            center_distance = calculate_distance(center1_lat, center1_lon, center2_lat, center2_lon)
            return center_distance <= (radius1 + radius2)

        # 计算源小区的覆盖圆
        source_center_lat, source_center_lon = calculate_coverage_circle_center(
            source_cell["lat"], source_cell["lon"], source_cell["azimuth"],
            COVERAGE_DISTANCE_FACTOR, DEFAULT_COVERAGE_DISTANCE
        )
        source_radius = calculate_coverage_radius(DEFAULT_COVERAGE_DISTANCE, COVERAGE_RADIUS_FACTOR)

        print(f"\n源小区: {source_cell['id']}")
        print(f"  位置: ({source_cell['lon']}, {source_cell['lat']})")
        print(f"  方向角: {source_cell['azimuth']}°")
        print(f"  覆盖圆圆心: ({source_center_lon:.6f}, {source_center_lat:.6f})")
        print(f"  覆盖圆半径: {source_radius:.3f} km ({source_radius*1000:.0f} 米)")

        for cell in found_cells:
            print(f"\n{'='*80}")
            print(f"目标小区: {cell['id']}")
            print(f"{'='*80}")

            # 计算距离
            distance = calculate_distance(
                source_cell["lat"], source_cell["lon"],
                cell["lat"], cell["lon"]
            )

            print(f"\n【基本信息】")
            print(f"  站点: {cell['site_id']} ({cell['site_name']})")
            print(f"  位置: ({cell['lon']}, {cell['lat']})")
            print(f"  方向角: {cell['azimuth']}°")
            print(f"  覆盖类型: {'室分' if cell['cell_cover_type'] == 4 else '室外'}")

            print(f"\n【第一步：室分站点距离筛选】")
            is_source_indoor = (source_cell.get("cell_cover_type", 1) == 4)
            is_target_indoor = (cell['cell_cover_type'] == 4)

            print(f"  源小区覆盖类型: {'室分' if is_source_indoor else '室外'}")
            print(f"  目标小区覆盖类型: {'室分' if is_target_indoor else '室外'}")
            print(f"  物理距离: {distance:.3f} km ({distance*1000:.0f} 米)")

            passed_step1 = True
            if is_source_indoor and is_target_indoor:
                if distance > 0.16:
                    passed_step1 = False
                    print(f"  ❌ 筛选失败: 室分到室分距离超过160米")
                else:
                    print(f"  ✅ 通过筛选: 室分到室分距离在160米以内")
            elif is_source_indoor or is_target_indoor:
                if distance > 0.30:
                    passed_step1 = False
                    print(f"  ❌ 筛选失败: 室分到室外距离超过300米")
                else:
                    print(f"  ✅ 通过筛选: 室分到室外距离在300米以内")
            else:
                print(f"  ✅ 通过筛选: 室外到室外无距离限制")

            if not passed_step1:
                print(f"\n  ⚠️  该小区在第一步被过滤，不再继续分析")
                continue

            # 第二步：覆盖圆相交筛选
            print(f"\n【第二步：覆盖圆相交筛选】")

            target_center_lat, target_center_lon = calculate_coverage_circle_center(
                cell["lat"], cell["lon"], cell["azimuth"],
                COVERAGE_DISTANCE_FACTOR, DEFAULT_COVERAGE_DISTANCE
            )
            target_radius = calculate_coverage_radius(DEFAULT_COVERAGE_DISTANCE, COVERAGE_RADIUS_FACTOR)

            print(f"  目标小区覆盖圆圆心: ({target_center_lon:.6f}, {target_center_lat:.6f})")
            print(f"  目标小区覆盖圆半径: {target_radius:.3f} km ({target_radius*1000:.0f} 米)")

            center_distance = calculate_distance(
                source_center_lat, source_center_lon,
                target_center_lat, target_center_lon
            )

            radius_sum = source_radius + target_radius
            is_intersecting = center_distance <= radius_sum

            print(f"  两圆心距离: {center_distance:.3f} km ({center_distance*1000:.0f} 米)")
            print(f"  两半径之和: {radius_sum:.3f} km ({radius_sum*1000:.0f} 米)")
            print(f"  是否相交: {'是' if is_intersecting else '否'}")

            if is_intersecting:
                print(f"  ✅ 通过筛选: 覆盖圆相交")
            else:
                print(f"  ❌ 筛选失败: 覆盖圆不相交")
                print(f"     差距: {(center_distance - radius_sum)*1000:.0f} 米")
                print(f"     这意味着两个小区的覆盖范围没有重叠")

    else:
        print("未找到全量工参数据")
else:
    print("未找到数据索引文件")

print("\n" + "=" * 80)
print("分析完成")
print("=" * 80)
