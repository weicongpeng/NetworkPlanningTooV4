# backend/app/utils/excel_columns.py
"""Excel 表头列名工具。

厂商工参表（ProjectParameter）使用「第一行中文名\\n英文名\\n元数据」的复杂表头，
清理后只保留中文名，可能出现重名列（如 NR 表两列都叫「小区名称」）。
pandas 允许重复列名，但 df[col] 会返回 DataFrame 而不是 Series，
下游 .str / 选列逻辑随即报 'DataFrame' object has no attribute 'str'。
"""
from typing import Dict, Iterable, List


def dedupe_column_names(names: Iterable[str]) -> List[str]:
    """列名去重：重复名保留首个原样，后续追加 #2、#3 后缀。

    内容相同的重复列（NR 表两个「小区名称」）取首个即可；作为列名改名后
    不会与精确匹配冲突（find_column 的精确匹配优先返回首个同名列）。
    """
    seen: Dict[str, int] = {}
    result: List[str] = []
    for name in names:
        count = seen.get(name, 0) + 1
        seen[name] = count
        result.append(name if count == 1 else f"{name}#{count}")
    return result
