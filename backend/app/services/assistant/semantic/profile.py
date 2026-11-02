"""列级画像（dataset profile）

入库时对每列做一次统计，写进 Workbook.metadata_json["columns"]，
供 catalog 告诉模型「真实有哪些列、覆盖率多少、取值长什么样」——
不猜列名，是智能搜索的召回依据。

为控制入库耗时，超过 _SAMPLE_ROWS 行的文件只统计前 N 行，并标记 sampled=true。
"""
from typing import Any, Dict, List

import pandas as pd

_SAMPLE_ROWS = 5000


def profile_columns(df: pd.DataFrame,
                    metric_cols: List[str],
                    dim_cols: List[str]) -> Dict[str, Dict[str, Any]]:
    """返回 {列名: {role, type, coverage, distinct, samples, min, max}}"""
    sample = df.head(_SAMPLE_ROWS)
    total = max(len(sample), 1)
    out: Dict[str, Dict[str, Any]] = {}
    for col in df.columns:
        series = sample[col]
        non_null = series.replace("", pd.NA).dropna()
        entry: Dict[str, Any] = {
            "role": "metric" if col in metric_cols else ("dimension" if col in dim_cols else "other"),
            "coverage": round(len(non_null) / total, 3),
            "distinct": int(non_null.nunique()),
            "samples": [str(v) for v in non_null.unique()[:3]],
        }
        numeric = pd.to_numeric(non_null, errors="coerce")
        if len(non_null) and numeric.notna().mean() > 0.8:
            entry["type"] = "number"
            entry["min"] = float(numeric.min())
            entry["max"] = float(numeric.max())
        else:
            entry["type"] = "text"
        out[str(col)] = entry
    if len(df) > _SAMPLE_ROWS:
        out["_sampled"] = {"rows": _SAMPLE_ROWS, "total": int(len(df))}
    return out
