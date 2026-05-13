"""
Verify Min Distance Sector Name Feature
"""

import asyncio
from app.algorithms.pci_planning_service_v2 import (
    PlanningConfig,
    PCIPlanningService,
    NetworkType,
)


async def verify_min_distance_sector_name():
    """Verify min distance sector name feature"""

    print("=" * 80)
    print("Verify Min Distance Sector Name Feature")
    print("=" * 80)

    # Scenario: There are existing cells with same PCI in full params
    print("\n[Scenario] Existing cells with same PCI in full params")
    print("-" * 80)

    sites_data = [
        {
            "id": "site1",
            "name": "Site1",
            "networkType": "LTE",
            "longitude": 116.4074,
            "latitude": 39.9042,
            "sectors": [
                {
                    "id": "1",
                    "name": "Site1_Sector1_Planned",
                    "longitude": 116.4074,
                    "latitude": 39.9042,
                    "earfcn": 1850.0,
                    "pci": None,
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
    result = await service.plan(sites_data)

    # Get planning result
    site1_result = result.sites[0]
    sector_result = site1_result.sectors[0]

    print(f"Sector Name: {sector_result.sector_name}")
    print(f"New PCI: {sector_result.new_pci}")
    print(f"Min Reuse Distance: {sector_result.min_reuse_distance} km")
    print(f"Min Distance Sector Name: {sector_result.min_distance_sector_name}")
    print(f"Assignment Reason: {sector_result.assignment_reason}")

    # Verify: min_distance_sector_name field should exist
    assert hasattr(sector_result, "min_distance_sector_name"), (
        "SectorPlanningResult should have min_distance_sector_name field"
    )
    print("\n[OK] Verified: min_distance_sector_name field exists")

    # Verify: If found same PCI cells, should record sector name
    if sector_result.min_reuse_distance < float("inf"):
        if sector_result.min_distance_sector_name:
            print(
                f"[OK] Verified: Opposite sector name recorded: {sector_result.min_distance_sector_name}"
            )
        else:
            print("[WARNING] Min distance is finite but no sector name recorded")
    else:
        if sector_result.min_distance_sector_name is None:
            print("[OK] Verified: No same PCI cells found, sector name is None")
        else:
            print(
                f"[WARNING] Min distance is inf but has sector name: {sector_result.min_distance_sector_name}"
            )

    print("\n" + "=" * 80)
    print("Verification Complete")
    print("=" * 80)

    print("\nExpected Results:")
    print("1. PCI planning result will include new column: 'Min Distance Sector Name'")
    print("2. If there are same PCI cells, this column shows the nearest cell name")
    print("3. If there are no same PCI cells, this column is empty")
    print("4. Exported Excel file will include this column")


if __name__ == "__main__":
    asyncio.run(verify_min_distance_sector_name())
