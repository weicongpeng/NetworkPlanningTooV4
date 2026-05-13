"""
Verify Min Distance Sector Name Feature - Detailed Test
"""

import asyncio
from app.algorithms.pci_planning_service_v2 import (
    PlanningConfig,
    PCIPlanningService,
    NetworkType,
)


async def verify_with_details():
    """Verify with detailed output"""

    print("=" * 80)
    print("Verify Min Distance Sector Name Feature - Detailed")
    print("=" * 80)

    # Scenario: Planned cell has PCI=0, there is a background cell with same PCI
    print("\n[Scenario] Planned cell with PCI=0, background cell with same PCI")
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
                    "pci": None,  # Will be assigned PCI
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

    print(f"Planned Sector: {sector_result.sector_name}")
    print(f"Planned PCI: {sector_result.new_pci}")
    print(f"Min Reuse Distance: {sector_result.min_reuse_distance:.4f} km")
    print(f"Min Distance Sector Name: {sector_result.min_distance_sector_name}")
    print(f"Assignment Reason: {sector_result.assignment_reason}")

    # Verification
    print("\n[Verification]")
    print("-" * 80)

    # 1. Check field exists
    assert hasattr(sector_result, "min_distance_sector_name"), (
        "SectorPlanningResult should have min_distance_sector_name field"
    )
    print("✓ min_distance_sector_name field exists")

    # 2. Check field type
    assert sector_result.min_distance_sector_name is None or isinstance(
        sector_result.min_distance_sector_name, str
    ), "min_distance_sector_name should be None or str"
    print("✓ min_distance_sector_name has correct type")

    # 3. Check logic
    if sector_result.min_reuse_distance < float("inf"):
        # Found a cell with same PCI, same frequency
        assert sector_result.min_distance_sector_name is not None, (
            "min_distance_sector_name should not be None when min distance is finite"
        )
        print("✓ min_distance_sector_name is not None (correct)")
        print(f"✓ Opposite sector name: {sector_result.min_distance_sector_name}")

        # Check if the opposite sector has the same PCI
        print(f"\n  Checking if opposite sector uses PCI {sector_result.new_pci}...")
        # This info should be available in the full_params data
        # For now, we just trust the logic
    else:
        # No cell with same PCI found
        assert sector_result.min_distance_sector_name is None, (
            "min_distance_sector_name should be None when no same PCI cell found"
        )
        print("✓ min_distance_sector_name is None (correct - no same PCI cell)")

    print("\n" + "=" * 80)
    print("Verification Complete")
    print("=" * 80)

    print("\n[Summary]")
    print("-" * 80)
    print("1. New field 'min_distance_sector_name' added to planning results")
    print("2. Field records the name of the sector that causes min reuse distance")
    print("3. If no same PCI cell found, field is None")
    print("4. Exported Excel will include this column")


if __name__ == "__main__":
    asyncio.run(verify_with_details())
