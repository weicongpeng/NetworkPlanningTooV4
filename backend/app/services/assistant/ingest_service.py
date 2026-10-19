"""基站参数/指标文件解析入库

设计：
- 参数文件（无时间列）→ station_param_rows 宽表：非维度列全部进 params_json
- 指标文件（有时间列）→ station_metric_rows 长表：melt 成 小区×时间×指标
- 维度列（小区名/基站ID/小区ID/制式/时间）按关键词自动识别，识别失败显式报错
"""
import json
import math
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from sqlalchemy import delete

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.database import StationParamRow, StationMetricRow, Workbook

PARAM_TYPE = "station_params"
METRIC_TYPE = "station_metrics"
_BATCH = 1000

# 维度列识别关键词（小写包含匹配）
_CELL_NAME_KEYS = ["小区名", "小区名称", "sector name", "cell name", "小区中文名", "小区"]
_SITE_ID_KEYS = ["基站id", "基站编号", "基站标识", "site id", "siteid", "enodeb", "gnodeb", "nodeb", "基站"]
_CELL_ID_KEYS = ["小区id", "小区编号", "小区标识", "cell id", "cellid", "local cell", "本地小区"]
_NETWORK_KEYS = ["网络制式", "网络类型", "制式", "network type", "网别", "网络"]
_TIME_KEYS = ["统计时间", "开始时间", "采集时间", "时间", "日期", "粒度", "time", "date", "时段"]
# 指标列判定关键词（数值列名命中任一即视为指标）
_METRIC_KEYS = ["率", "次数", "数量", "总量", "流量", "时延", "时长", "负荷", "用户数",
                "prb", "吞吐", "速率", "掉线", "接通", "切换", "覆盖", "电平", "质量",
                "rsrp", "sinr", "rrc", "erab", "掉话", "拥塞", "利用率", "话务量"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_col(name: Any) -> str:
    return str(name).strip().replace("\n", "").replace("\r", "")


def _match_col(columns: List[str], keywords: List[str]) -> Optional[str]:
    """返回第一个命中关键词的列名（精确优先，包含次之）"""
    lower = {c: c.lower() for c in columns}
    for kw in keywords:
        for c, lc in lower.items():
            if lc == kw:
                return c
    for kw in keywords:
        for c, lc in lower.items():
            if kw in lc:
                return c
    return None


def _norm_network(v: Any) -> Optional[str]:
    s = str(v).upper()
    if "5G" in s or "NR" in s:
        return "NR"
    if "4G" in s or "LTE" in s or "FDD" in s or "TDD" in s:
        return "LTE"
    return None


def _guess_granularity(time_values: pd.Series, fname: str) -> str:
    """按文件名/时间值特征推断粒度：busy_hour/month/hour/day"""
    hint = f"{fname} {time_values.name}".lower()
    if "忙时" in hint or "busy" in hint:
        return "busy_hour"
    sample = str(time_values.dropna().iloc[0]) if len(time_values.dropna()) else ""
    s = sample.strip()
    # YYYY-MM（月份）
    if len(s) <= 7 and pd.to_datetime(s, format="%Y-%m", errors="coerce") is not pd.NaT:
        try:
            datetime.strptime(s[:7], "%Y-%m")
            return "month"
        except ValueError:
            pass
    ts = pd.to_datetime(s, errors="coerce")
    if pd.isna(ts):
        return "day"
    if ts.hour != 0 or ts.minute != 0:
        return "hour"
    return "day"


def _clean(v: Any) -> Any:
    """NaN/inf → None；数字转原生类型；其余转 str"""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    return s if s and s.lower() != "nan" else None


def _read_table(path: Path) -> pd.DataFrame:
    """读 Excel/CSV 为 DataFrame（Excel 取第一个 sheet）"""
    suffix = path.suffix.lower()
    if suffix == ".csv" or suffix == ".txt":
        return pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig",
                           on_bad_lines="skip")
    if suffix in (".xlsx", ".xls"):
        return pd.read_excel(path, sheet_name=0, dtype=str)
    raise ValueError(f"不支持的文件格式：{suffix}（仅支持 .xlsx/.xls/.csv/.txt）")


def _classify_columns(df: pd.DataFrame) -> Dict[str, Optional[str]]:
    cols = [_norm_col(c) for c in df.columns]
    mapping = {
        "cell_name": _match_col(cols, _CELL_NAME_KEYS),
        "site_id": _match_col(cols, _SITE_ID_KEYS),
        "cell_id": _match_col(cols, _CELL_ID_KEYS),
        "network": _match_col(cols, _NETWORK_KEYS),
        "time": _match_col(cols, _TIME_KEYS),
    }
    if not mapping["cell_name"]:
        raise ValueError("未识别到「小区名」列，请确认表头含“小区名/小区名称/CELL NAME”等列")
    return mapping


def _is_metric_col(col: str, series: pd.Series) -> bool:
    lc = col.lower()
    if any(k in lc for k in _METRIC_KEYS):
        return True
    # 数值占比 > 80% 也视为指标
    numeric = pd.to_numeric(series, errors="coerce")
    return numeric.notna().mean() > 0.8


def ingest_file(file_path: str, original_name: str, user_id: int,
                city: Optional[str] = None, operator: Optional[str] = None) -> Dict[str, Any]:
    """解析并入库。返回 workbook 摘要 dict。失败抛 ValueError（含中文原因）

    city/operator: 数据所属组（地市+运营商）归属快照，取自上传者。
    """
    path = Path(file_path)
    df = _read_table(path)
    df.columns = [_norm_col(c) for c in df.columns]
    if df.empty:
        raise ValueError("文件内容为空")

    col = _classify_columns(df)
    data_type = METRIC_TYPE if col["time"] else PARAM_TYPE

    wb_id = str(uuid.uuid4())
    created = _now()
    saved = settings.UPLOAD_DIR / f"{wb_id}{path.suffix.lower()}"
    shutil.move(str(path), str(saved))

    wb = Workbook(
        id=wb_id, user_id=user_id, city=city, operator=operator,
        name=original_name, file_type=data_type,
        status="processing", size=path.stat().st_size if path.exists() else None,
        original_path=str(saved), created_at=created,
    )
    # 先提交 Workbook，行数据外键才合法
    with SessionLocal() as db:
        db.add(wb)
        db.commit()

    try:
        if data_type == PARAM_TYPE:
            fields, count = _ingest_params(df, col, wb_id, user_id, created, city, operator)
            meta = {"fields": fields, "rowCount": count}
        else:
            fields, count, gran, tmin, tmax = _ingest_metrics(
                df, col, wb_id, user_id, created, original_name, city, operator)
            meta = {"fields": fields, "rowCount": count, "granularity": gran,
                    "timeRange": [tmin, tmax]}
    except Exception:
        # 解析失败：清理半成品 Workbook，避免孤儿元数据
        delete_dataset(wb_id)
        raise

    with SessionLocal() as db:
        obj = db.query(Workbook).filter_by(id=wb_id).first()
        obj.metadata_json = json.dumps(meta, ensure_ascii=False)
        obj.status = "ready"
        db.commit()
        summary = _wb_summary(obj)

    return summary


def _ingest_params(df: pd.DataFrame, col: Dict[str, Optional[str]],
                   wb_id: str, user_id: int, created: str,
                   city: Optional[str] = None, operator: Optional[str] = None) -> Tuple[List[str], int]:
    dims = {v for v in col.values() if v}
    param_cols = [c for c in df.columns if c not in dims]
    if not param_cols:
        raise ValueError("参数文件除小区名等维度列外没有参数列")

    rows: List[Dict[str, Any]] = []
    count = 0
    for _, r in df.iterrows():
        cell = _clean(r[col["cell_name"]])
        if not cell:
            continue
        params = {c: _clean(r[c]) for c in param_cols if _clean(r[c]) is not None}
        rows.append({
            "workbook_id": wb_id, "user_id": user_id, "city": city, "operator": operator,
            "cell_name": str(cell),
            "site_id": _clean(r[col["site_id"]]) if col["site_id"] else None,
            "cell_id": _clean(r[col["cell_id"]]) if col["cell_id"] else None,
            "network_type": _norm_network(r[col["network"]]) if col["network"] else None,
            "params_json": json.dumps(params, ensure_ascii=False, default=str),
            "created_at": created,
        })
        count += 1
        if len(rows) >= _BATCH:
            _bulk_insert(StationParamRow, rows)
            rows = []
    if rows:
        _bulk_insert(StationParamRow, rows)
    return param_cols, count


def _ingest_metrics(df: pd.DataFrame, col: Dict[str, Optional[str]],
                    wb_id: str, user_id: int, created: str,
                    fname: str, city: Optional[str] = None,
                    operator: Optional[str] = None) -> Tuple[List[str], int, str, str, str]:
    time_col = col["time"]
    times = pd.to_datetime(df[time_col], errors="coerce")
    if times.notna().mean() < 0.5:
        raise ValueError(f"时间列「{time_col}」无法解析为日期时间")
    granularity = _guess_granularity(df[time_col], fname)

    dims = {v for v in col.values() if v}
    metric_cols = [c for c in df.columns if c not in dims and _is_metric_col(c, df[c])]
    if not metric_cols:
        raise ValueError("未识别到任何指标列（数值列），请确认指标文件格式")

    rows: List[Dict[str, Any]] = []
    count = 0
    valid_times: List[pd.Timestamp] = []
    for _, r in df.iterrows():
        cell = _clean(r[col["cell_name"]])
        ts = pd.to_datetime(r[time_col], errors="coerce")
        if not cell or pd.isna(ts):
            continue
        valid_times.append(ts)
        base = {
            "workbook_id": wb_id, "user_id": user_id, "city": city, "operator": operator,
            "cell_name": str(cell),
            "site_id": _clean(r[col["site_id"]]) if col["site_id"] else None,
            "cell_id": _clean(r[col["cell_id"]]) if col["cell_id"] else None,
            "granularity": granularity, "metric_time": ts.to_pydatetime(),
            "created_at": created,
        }
        for mc in metric_cols:
            val = pd.to_numeric(r[mc], errors="coerce")
            if pd.isna(val):
                continue
            rows.append({**base, "metric_name": mc, "metric_value": float(val)})
            count += 1
            if len(rows) >= _BATCH:
                _bulk_insert(StationMetricRow, rows)
                rows = []
    if rows:
        _bulk_insert(StationMetricRow, rows)

    tmin = min(valid_times).isoformat() if valid_times else ""
    tmax = max(valid_times).isoformat() if valid_times else ""
    return metric_cols, count, granularity, tmin, tmax


def _bulk_insert(model, rows: List[Dict[str, Any]]) -> None:
    with SessionLocal() as db:
        db.bulk_insert_mappings(model, rows)
        db.commit()


def _wb_summary(wb: Workbook) -> Dict[str, Any]:
    meta = json.loads(wb.metadata_json or "{}")
    return {
        "id": wb.id, "name": wb.name, "fileType": wb.file_type,
        "status": wb.status, "size": wb.size,
        "createdAt": wb.created_at, **meta,
    }


def list_datasets(user=None) -> List[Dict[str, Any]]:
    """列出基站参数/指标数据集（网优助手用），按（地市+运营商）组过滤。

    所有用户（含管理员）仅见同组数据集；组信息缺失用户不可见。
    """
    from app.services.data_group import group_sql_filter
    with SessionLocal() as db:
        q = db.query(Workbook).filter(Workbook.file_type.in_([PARAM_TYPE, METRIC_TYPE]))
        f = group_sql_filter(Workbook.city, Workbook.operator, user)
        if f is not None:
            q = q.filter(f)
        return [_wb_summary(wb) for wb in q.order_by(Workbook.created_at.desc()).all()]


def delete_dataset(workbook_id: str) -> bool:
    """删除助手数据集：行数据 + Workbook 元数据 + 原始文件"""
    with SessionLocal() as db:
        wb = db.query(Workbook).filter_by(id=workbook_id).first()
        if not wb or wb.file_type not in (PARAM_TYPE, METRIC_TYPE):
            return False
        db.execute(delete(StationParamRow).where(StationParamRow.workbook_id == workbook_id))
        db.execute(delete(StationMetricRow).where(StationMetricRow.workbook_id == workbook_id))
        if wb.original_path:
            p = Path(wb.original_path)
            if p.exists():
                p.unlink()
        db.delete(wb)
        db.commit()
        return True
