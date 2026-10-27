"""
PCI核查结果行构造

统一「一行一个异常小区对」的字段口径（a/b/c 三端 + 距离 + 问题描述），
供核查服务的各条规则复用；导出服务按同一批字段名排列。
"""

from typing import Any, Dict, List, Optional

from app.algorithms.pci_check_candidates import meters
from app.algorithms.pci_check_types import CHECK_TYPE_NAMES, CheckType


def cell_columns(cell: Dict, prefix: str, modulus: Optional[int]) -> Dict[str, Any]:
    """单个小区在结果行里的字段，前缀 a=核查小区、b=对照小区、c=混淆的第二个邻小区"""
    return {
        f"{prefix}Cgi": f"{cell['siteId']}-{cell['sectorId']}",
        f"{prefix}SiteId": cell["siteId"],
        f"{prefix}SiteName": cell["siteName"],
        f"{prefix}SectorId": cell["sectorId"],
        f"{prefix}SectorName": cell["sectorName"],
        f"{prefix}Pci": cell["pci"],
        f"{prefix}Frequency": cell["frequency"],
        f"{prefix}Vendor": cell.get("vendor", ""),
        f"{prefix}CoverageType": "室分" if cell.get("isIndoor") else "室外",
        f"{prefix}Mod": None if modulus is None else cell["pci"] % modulus,
        f"{prefix}Longitude": cell["longitude"],
        f"{prefix}Latitude": cell["latitude"],
        f"{prefix}Azimuth": cell["azimuth"],
    }


def build_pair_row(
    check_type: CheckType,
    cells: List[Dict],
    first_idx: int,
    second_idx: int,
    distance: float,
    *,
    modulus: Optional[int],
    reason: str,
    third_idx: Optional[int] = None,
) -> Dict[str, Any]:
    """构造一行核查结果；混淆类别的 third_idx 为第二个同 PCI 邻小区"""
    cell_a, cell_b = cells[first_idx], cells[second_idx]
    row: Dict[str, Any] = {
        "checkType": check_type.value,
        "checkTypeName": CHECK_TYPE_NAMES[check_type],
        "networkType": cell_a["networkType"],
        "modulus": modulus,
    }
    row.update(cell_columns(cell_a, "a", modulus))
    row.update(cell_columns(cell_b, "b", modulus))
    if third_idx is not None:
        row.update(cell_columns(cells[third_idx], "c", modulus))
    row["pci"] = cell_b["pci"]
    row["distanceM"] = meters(distance)
    row["reason"] = reason
    return row


def mod_reason(cell_a: Dict, cell_b: Dict, mod: int, modulus: int, scope: str) -> str:
    """模值冲突描述（同站/同频两种口径共用）"""
    same_pci = "且 PCI 相同" if cell_a["pci"] == cell_b["pci"] else ""
    return (
        f"{scope}小区 PCI 模{modulus} 同为 {mod}{same_pci}"
        f"（{cell_a['sectorName']} PCI={cell_a['pci']} / {cell_b['sectorName']} PCI={cell_b['pci']}）"
    )


def facing_reason(
    cell_a: Dict, cell_b: Dict, same_pci: bool, distance: float, gate_km: float, modulus: int
) -> str:
    """对打描述：PCI 相同与模值相同分开措辞，便于按类别筛读"""
    if same_pci:
        return (
            f"同频对打小区 PCI 同为 {cell_a['pci']}（模{modulus} 同为 {cell_a['pci'] % modulus}），"
            f"间距 {meters(distance)} 米，小于对打门限 {meters(gate_km)} 米"
        )
    return (
        f"同频对打小区 PCI 模{modulus} 同为 {cell_a['pci'] % modulus}，"
        f"间距 {meters(distance)} 米，小于对打门限 {meters(gate_km)} 米"
    )


def reuse_reason(cell_a: Dict, distance: float, min_reuse_km: float) -> str:
    """复用距离过小描述"""
    return (
        f"同频 {cell_a['frequency']} 下 PCI 同为 {cell_a['pci']}，"
        f"间距 {meters(distance)} 米，小于最小复用距离 {min_reuse_km * 1000:.0f} 米"
    )


def collision_distance_reason(
    cell_a: Dict, cell_b: Dict, distance: float, min_reuse_km: float
) -> str:
    """邻区关联关闭时的冲突描述：复用距离内同频同PCI"""
    return (
        f"同频 {cell_a['frequency']} 下 PCI 同为 {cell_a['pci']}，"
        f"间距 {meters(distance)} 米，小于最小复用距离 {min_reuse_km * 1000:.0f} 米"
        f"（{cell_a['sectorName']} PCI={cell_a['pci']} / {cell_b['sectorName']} PCI={cell_b['pci']}）"
    )


def collision_reason(cell_a: Dict, cell_b: Dict, distance: float) -> str:
    return (
        f"预规划同频邻区 PCI 同为 {cell_a['pci']}，"
        f"间距 {meters(distance)} 米（基于预规划邻区对，非现网邻区数据）"
    )


def confusion_reason(
    cell_source: Dict,
    cell_first: Dict,
    cell_second: Dict,
    pci_value: int,
    group_size: int,
    max_group: int,
) -> str:
    """混淆描述：同一服务小区的两个同频邻区取了相同 PCI"""
    reason = (
        f"小区 {cell_source['sectorName']} 的同频邻区 {cell_first['sectorName']} 与 "
        f"{cell_second['sectorName']} 的 PCI 同为 {pci_value}，终端易混淆"
        f"（基于预规划邻区对，非现网邻区数据）"
    )
    if group_size > max_group:
        reason += f"；该同PCI邻区组共 {group_size} 个，仅输出前 {max_group} 个的组合"
    return reason
