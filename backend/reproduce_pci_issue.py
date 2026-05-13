
import asyncio
import sys
from typing import List, Dict
from app.algorithms.pci_planning_service_v3 import PCIPlanningServiceV3, PlanningConfig
from app.models.schemas import NetworkType

async def run_test():
    # Helper to calculate expected distance
    from app.algorithms.distance_calculator import DistanceCalculator
    dist = DistanceCalculator.calculate_distance(114.0, 23.0, 114.009, 23.0)
    print(f"Calculated distance between points: {dist:.4f} km")

    # Case 1: Both have frequency but no earfcn (or None)
    print("\n--- Case 1: Frequency present, earfcn None ---")
    sites_data_1 = [
        {
            "id": "site1",
            "name": "Site 1",
            "networkType": "NR",
            "sectors": [
                {
                    "id": "sector1", "name": "Sector 1",
                    "longitude": 114.0, "latitude": 23.0,
                    "frequency": 3408.96, "pci": 394 # Pre-assigned or will be assigned first
                }
            ]
        },
        {
            "id": "site2",
            "name": "Site 2",
            "networkType": "NR",
            "sectors": [
                {
                    "id": "sector2", "name": "Sector 2",
                    "longitude": 114.009, "latitude": 23.0,
                    "frequency": 3408.96,
                    # No PCI designated, let it plan
                }
            ]
        }
    ]

    config = PlanningConfig(
        network_type=NetworkType.NR,
        distance_threshold=3.0,
        pci_modulus=30,
        enable_collision_check=True,
        enable_confusion_check=True,
        enable_mod3_check=True,
        enable_mod6_check=False,
        enable_mod30_check=True,
        check_same_frequency_only=True, # Default likely True
        optimization_strategy="greedy",
        pci_range=(0, 1007)
    )

    service = PCIPlanningServiceV3(config)
    
    # We need to manually inject "assigned" status for sector 1 if we want to test Sector 2 assignment specifically,
    # OR we just run plan() which iterates.
    # To strictly test the order and state:
    
    # Let's run full plan().
    # Note: Service iterates sites. Order depends on iteration of dict or list.
    # In V3 plan(), it iterates `sites_data`.
    
    result = await service.plan(sites_data_1)
    
    # Check result for Sector 2
    for site in result.sites:
        if site.site_id == "site2":
            for sector in site.sectors:
                print(f"Sector 2 Assigned PCI: {sector.new_pci}")
                print(f"Sector 2 Min Reuse Distance: {sector.min_reuse_distance}")
                print(f"Sector 2 Assignment Reason: {sector.assignment_reason}")
                
                if sector.new_pci == 394:
                    print(f"FAILURE: Sector 2 reused Site 1 PCI (394) despite distance {dist:.4f} < 3.0")
                else:
                    print("SUCCESS: Sector 2 chose different PCI")

    # Case 2: Force collision to check distance calculation
    print("\n--- Case 2: Force Collision (Single PCI available) ---")
    sites_data_2 = [
        {
            "id": "site1",
            "sectors": [{"id": "s1", "longitude": 114.0, "latitude": 23.0, "earfcn": 100, "frequency": 3408.96, "pci": 50}]
        },
        {
            "id": "site2",
            "sectors": [{"id": "s2", "longitude": 114.009, "latitude": 23.0, "earfcn": 100, "frequency": 3408.96}]
        }
    ]
    
    config.pci_range = (50, 50) # Force PCI 50
    service2 = PCIPlanningServiceV3(config)
    result2 = await service2.plan(sites_data_2)
    
    for site in result2.sites:
        if site.site_id == "site2":
            for sector in site.sectors:
                print(f"Sector 2 Assigned PCI: {sector.new_pci}")
                print(f"Sector 2 Reason: {sector.assignment_reason}")
                print(f"Sector 2 Min Dist: {sector.min_reuse_distance}")
                
                if sector.min_reuse_distance < 1.0:
                     print("SUCCESS: Distance correctly calculated (< 1.0km)")
                else:
                     print(f"FAILURE: Distance is {sector.min_reuse_distance}, expected ~0.9km")


    # Case 3: Different Frequencies (Should IGNORE distance)
    print("\n--- Case 3: Different Frequencies (Should IGNORE 0.9km distance) ---")
    sites_data_3 = [
        {
            "id": "site3_1",
            "sectors": [{"id": "s3_1", "longitude": 114.0, "latitude": 23.0, "frequency": 3400.0, "pci": 200}]
        },
        {
            "id": "site3_2",
            "sectors": [{"id": "s3_2", "longitude": 114.009, "latitude": 23.0, "frequency": 2100.0 }] # Diff Freq
        }
    ]
    service3 = PCIPlanningServiceV3(config)
    result3 = await service3.plan(sites_data_3)

    for site in result3.sites:
        if site.site_id == "site3_2":
            for sector in site.sectors:
                print(f"Sector 3_2 Assigned PCI: {sector.new_pci}")
                print(f"Sector 3_2 Min Dist: {sector.min_reuse_distance}")
                
                if sector.min_reuse_distance > 100.0:
                     print("SUCCESS: Ignored close neighbor with different frequency")
                else:
                     print(f"FAILURE: Calculated distance {sector.min_reuse_distance} against different frequency!")

if __name__ == "__main__":
    asyncio.run(run_test())
