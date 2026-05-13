"""
Debug Min Distance Sector Name Issue
"""

import asyncio
from app.algorithms.pci_planning_service_v2 import (
    PlanningConfig,
    PCIPlanningService,
    NetworkType,
)


async def debug_min_distance_issue():
    """Debug the min distance sector name issue"""

    print("=" * 80)
    print("Debug Min Distance Sector Name Issue")
    print("=" * 80)

    # Simple scenario: Plan a cell with background data
    print("\n[Test 1] Simple scenario")
    print("-" * 80)

    sites_data = [
        {
            "id": "site_planned",
            "name": "站点_待规划",
            "networkType": "LTE",
            "longitude": 116.4074,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "站点_待规划_扇区1",
                    "longitude": 116.4074,
                    "latitude": 39.9042,
                    "earfcn": 1850.0,
                    "pci": None,  # Will be assigned
                },
            ],
        },
    ]

    # Background: A cell with PCI=0 that is very close
    background_sites_data = [
        {
            "id": "site_bg_close",
            "name": "站点_背景_近",
            "networkType": "LTE",
            "longitude": 116.4174,  # ~1 km away
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "站点_背景_近_扇区1",
                    "longitude": 116.4174,
                    "latitude": 39.9042,
                    "earfcn": 1850.0,
                    "pci": 0,  # Same PCI
                },
            ],
        },
    ]

    config = PlanningConfig(
        network_type=NetworkType.LTE,
        distance_threshold=3.0,
        pci_modulus=3,
    )

    service = PCIPlanningService(config)
    result = await service.plan(sites_data, background_sites_data=background_sites_data)

    # Get planning result
    site_result = result.sites[0]
    sector_result = site_result.sectors[0]

    print(f"\n[Result]")
    print(f"Planned Sector: {sector_result.sector_name}")
    print(f"Assigned PCI: {sector_result.new_pci}")
    print(f"Min Reuse Distance: {sector_result.min_reuse_distance:.4f} km")
    print(f"Min Distance Sector Name: {sector_result.min_distance_sector_name}")
    print(f"Assignment Reason: {sector_result.assignment_reason}")

    # Verification
    print("\n[Analysis]")

    if sector_result.new_pci == 0:
        print("✓ PCI=0 was assigned as expected")
        print("  (Background cell with PCI=0 was very close)")
    else:
        print(f"✗ PCI={sector_result.new_pci} was assigned (expected 0)")
        print("  (To avoid conflict with background PCI=0 cell)")

    if sector_result.min_reuse_distance < 3.0:
        print(
            f"✗ Min reuse distance {sector_result.min_reuse_distance:.4f} km < threshold 3.0 km"
        )
        print("  (Should satisfy distance constraint)")
    else:
        print(
            f"✓ Min reuse distance {sector_result.min_reuse_distance:.4f} km >= threshold 3.0 km"
        )
        print("  (Satisfies distance constraint)")

    print("\n[Issue]")
    print(
        "The issue: min_distance_sector_name does not match the sector causing min distance"
    )
    print("Expected: If the min distance is caused by a background cell with PCI=0,")
    print(
        "           then min_distance_sector_name should be that background cell's name"
    )
    print("Current: min_distance_sector_name =", sector_result.min_distance_sector_name)
    print(
        "Problem: The sector_name may not use PCI=0, or may be from a different PCI group"
    )

    print("\n" + "=" * 80)
    print("Debug Complete")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(debug_min_distance_issue())
