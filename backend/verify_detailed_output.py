"""
Verify Min Distance Sector Name with Detailed Output
"""

import asyncio
from app.algorithms.pci_planning_service_v2 import (
    PlanningConfig,
    PCIPlanningService,
    NetworkType,
)


async def verify_with_detailed_output():
    """Verify with very detailed output"""

    print("=" * 100)
    print("Verify Min Distance Sector Name - Very Detailed")
    print("=" * 100)

    # Scenario: Plan a cell with explicit background data
    print("\n[Scenario] Planned cell with explicit background data")
    print("-" * 100)

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

    # Background data: Explicit cell with PCI=0
    background_sites_data = [
        {
            "id": "site_background",
            "name": "站点_背景_PCI_0_1km_away",
            "networkType": "LTE",
            "longitude": 116.4174,  # ~1km away
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "站点_背景_PCI_0_1km_away",  # Should be the min distance sector
                    "longitude": 116.4174,
                    "latitude": 39.9042,
                    "earfcn": 1850.0,
                    "pci": 0,  # Same PCI
                },
                {
                    "id": "2",
                    "name": "站点_背景_PCI_3_2km_away",
                    "longitude": 116.4274,  # ~2km away
                    "latitude": 39.9042,
                    "earfcn": 1850.0,
                    "pci": 0,  # Same PCI
                },
            ],
        },
    ]

    config = PlanningConfig(
        network_type=NetworkType.LTE,
        distance_threshold=1.5,
        pci_modulus=3,
    )

    service = PCIPlanningService(config)
    result = await service.plan(sites_data, background_sites_data=background_sites_data)

    # Get planning result
    site_result = result.sites[0]
    sector_result = site_result.sectors[0]

    print("\n[Result Analysis]")
    print("-" * 100)
    print(f"Planned Sector: {sector_result.sector_name}")
    print(f"Planned PCI: {sector_result.new_pci}")
    print(f"Min Reuse Distance: {sector_result.min_reuse_distance:.4f} km")
    print(f"Min Distance Sector Name: {sector_result.min_distance_sector_name}")
    print(f"Assignment Reason: {sector_result.assignment_reason}")

    # Verification
    print("\n[Verification]")
    print("-" * 100)

    # 1. Field exists
    print("1. Checking min_distance_sector_name field exists...")
    assert hasattr(sector_result, "min_distance_sector_name"), (
        "SectorPlanningResult should have min_distance_sector_name field"
    )
    print("   ✓ Field exists")

    # 2. Field is correct type
    print("2. Checking min_distance_sector_name type...")
    assert sector_result.min_distance_sector_name is None or isinstance(
        sector_result.min_distance_sector_name, str
    ), "min_distance_sector_name should be None or str"
    print(f"   ✓ Field type: {type(sector_result.min_distance_sector_name)}")

    # 3. If min distance is finite, sector name should not be None
    print("3. Checking consistency between distance and sector name...")
    if sector_result.min_reuse_distance < float("inf"):
        assert sector_result.min_distance_sector_name is not None, (
            "min_distance_sector_name should not be None when min distance is finite"
        )
        print("   ✓ Sector name is not None when min distance is finite")

        # 4. Verify the sector name is from background data
        print("4. Checking if sector name is from background data...")
        bg_sector_names = [
            sector["name"]
            for site in background_sites_data
            for sector in site.get("sectors", [])
        ]
        if sector_result.min_distance_sector_name in bg_sector_names:
            print(
                f"   ✓ Sector name is from background data: {sector_result.min_distance_sector_name}"
            )
        else:
            print(
                f"   ⚠ Sector name not found in background data: {sector_result.min_distance_sector_name}"
            )
    else:
        print("3. Checking consistency when min distance is infinite...")
        assert sector_result.min_distance_sector_name is None, (
            "min_distance_sector_name should be None when min distance is infinite"
        )
        print("   ✓ Sector name is None when min distance is infinite")

    print("\n[Expected Behavior]")
    print("-" * 100)
    print("1. Planned sector should get PCI=0 (to match background constraints)")
    print(
        "2. Min reuse distance should be ~1.0 km (distance to background PCI=0 sector)"
    )
    print("3. Min distance sector name should be '站点_背景_PCI_0_1km_away'")
    print("4. This is the sector that causes the min reuse distance constraint")

    print("\n" + "=" * 100)
    print("Verification Complete")
    print("=" * 100)


if __name__ == "__main__":
    asyncio.run(verify_with_detailed_output())
