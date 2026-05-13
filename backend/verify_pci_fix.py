"""
PCI规划功能修复验证脚本
演示修复后的效果
"""

import asyncio
from app.algorithms.pci_planning_service_v2 import (
    PlanningConfig,
    PCIPlanningService,
    NetworkType,
)


async def verify_fix():
    """验证修复效果"""

    print("=" * 80)
    print("PCI规划功能修复验证")
    print("=" * 80)

    # 场景1：不同频点的小区
    print("\n【场景1】不同频点的小区（N78 vs N5）")
    print("-" * 80)

    sites_data = [
        {
            "id": "site1",
            "name": "站点1",
            "networkType": "NR",
            "longitude": 116.4074,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "GO_N78_河源龙川_粮仓AAU2",
                    "longitude": 116.4074,
                    "latitude": 39.9042,
                    "earfcn": 620000.0,  # N78频点
                    "pci": None,
                },
            ],
        },
    ]

    # 背景小区：不同频点
    background_sites_data = [
        {
            "id": "site2",
            "name": "站点2",
            "networkType": "NR",
            "longitude": 116.4174,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "GO_N5_河源龙川_第三小学RRU3",
                    "longitude": 116.4174,
                    "latitude": 39.9042,
                    "earfcn": 532000.0,  # N5频点（不同）
                    "pci": 394,  # 已有PCI
                },
            ],
        },
    ]

    config = PlanningConfig(
        network_type=NetworkType.NR,
        distance_threshold=3.0,
        pci_modulus=30,
    )

    service = PCIPlanningService(config)
    result = await service.plan(sites_data, background_sites_data=background_sites_data)

    site_result = result.sites[0]
    sector_result = site_result.sectors[0]

    print(f"小区名称: {sector_result.sector_name}")
    print(f"频点: {sector_result.earfcn}")
    print(f"分配的PCI: {sector_result.new_pci}")
    print(f"最小复用距离: {sector_result.min_reuse_distance:.2f} km")
    print(f"分配原因: {sector_result.assignment_reason}")

    # 验证：应该可以分配PCI=394（因为频点不同）
    if sector_result.min_reuse_distance > 10.0:
        print("✅ 验证通过：不同频点的小区不会相互计算复用距离")
    else:
        print("❌ 验证失败：不同频点的小区应该不计算复用距离")

    # 场景2：同频点的小区
    print("\n【场景2】同频点的小区（都是N78）")
    print("-" * 80)

    sites_data2 = [
        {
            "id": "site3",
            "name": "站点3",
            "networkType": "NR",
            "longitude": 116.4274,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "站点3_扇区1",
                    "longitude": 116.4274,
                    "latitude": 39.9042,
                    "earfcn": 620000.0,  # N78频点
                    "pci": None,
                },
            ],
        },
    ]

    # 背景小区：同频点
    background_sites_data2 = [
        {
            "id": "site4",
            "name": "站点4",
            "networkType": "NR",
            "longitude": 116.4374,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "站点4_扇区1",
                    "longitude": 116.4374,
                    "latitude": 39.9042,
                    "earfcn": 620000.0,  # 相同频点N78
                    "pci": 394,  # 已有PCI
                },
            ],
        },
    ]

    service2 = PCIPlanningService(config)
    result2 = await service2.plan(
        sites_data2, background_sites_data=background_sites_data2
    )

    site_result2 = result2.sites[0]
    sector_result2 = site_result2.sectors[0]

    print(f"小区名称: {sector_result2.sector_name}")
    print(f"频点: {sector_result2.earfcn}")
    print(f"分配的PCI: {sector_result2.new_pci}")
    print(f"最小复用距离: {sector_result2.min_reuse_distance:.2f} km")
    print(f"分配原因: {sector_result2.assignment_reason}")

    # 验证：应该避免分配PCI=394（因为同频且距离近）
    if sector_result2.new_pci != 394:
        print("✅ 验证通过：同频点的小区会正确避免PCI冲突")
    else:
        print("❌ 验证失败：同频点的小区应该避免PCI冲突")

    # 场景3：分配原因验证
    print("\n【场景3】分配原因验证")
    print("-" * 80)

    # 检查分配原因是否包含明确的状态标记
    if (
        "✅" in sector_result.assignment_reason
        or "❌" in sector_result.assignment_reason
    ):
        print("✅ 验证通过：分配原因包含明确的状态标记（✅或❌）")
    else:
        print("❌ 验证失败：分配原因应包含明确的状态标记")

    if (
        "满足" in sector_result.assignment_reason
        or "不满足" in sector_result.assignment_reason
    ):
        print("✅ 验证通过：分配原因包含'满足'或'不满足'关键字")
    else:
        print("❌ 验证失败：分配原因应包含'满足'或'不满足'关键字")

    if (
        "分配时" in sector_result.assignment_reason
        or "最终核查" in sector_result.assignment_reason
    ):
        print("✅ 验证通过：分配原因包含'分配时'或'最终核查'标记")
    else:
        print("❌ 验证失败：分配原因应包含'分配时'或'最终核查'标记")

    print("\n" + "=" * 80)
    print("验证完成")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(verify_fix())
