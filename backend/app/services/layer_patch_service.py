"""
图层增量保存：只回传变更要素，后端按行号合并后整层重写

整层保存（save_layer_geojson）在"改一个属性值"场景下仍要上传整层 GeoJSON
（大图层 40MB / gzip 10MB+）并重建全部几何；增量保存只传变更要素 + 删除行号：

- 以现有 TAB（WGS84）为基底，仅对变更要素做 GCJ02→WGS84 逆转换与几何构建
- 用 baseVersion（源文件 mtime 指纹，同图层数据端点 ETag）+ baseCount 校验基底一致性，
  不一致抛 LayerVersionConflict（端点转 409，前端回退整层保存），避免按错行静默覆盖
- 写盘 / 元数据 / 缓存失效复用 layer_edit_service._write_layer_gdf

行号语义：row = 要素在图层读取顺序中的下标（前端工作集数组顺序与之一致）；
删除以基底行号表达，新增 row 为 None（追加到末尾）。
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import geopandas as gpd
import pandas as pd

from app.services.layer_edit_service import (
    _INTERNAL_FIELDS,
    _META_PERSIST_COL,
    _STYLE_INPUT_KEYS,
    _STYLE_PERSIST_COL,
    _coerce_column,
    _geom_kind,
    _read_tab_gdf,
    _resolve_layer_target,
    _resolve_feature_style,
    _scalarize,
    _write_layer_gdf,
    layer_version,
    read_tab_native_styles,
)
from app.utils.geojson_geometry import build_geometries

# 单次增量保存允许的变更要素上限（超出说明前端应走整层保存）
_MAX_CHANGES = 20000
# 新增属性列上限（与整层保存一致，防脏数据撑爆 schema）
_MAX_NEW_COLUMNS = 200


class LayerVersionConflict(Exception):
    """基底版本不一致（文件已被其它会话改写或行数不符），调用方应回退整层保存。"""


def _check_base_version(tab_path: Path, layer_id: str, base: Dict[str, Any]) -> None:
    """校验前端基底指纹：版本（mtime）与行数。缺失 version 时只校验行数。"""
    version = base.get("version")
    if version and str(version).strip() != layer_version(tab_path, layer_id):
        raise LayerVersionConflict("图层文件已被其它会话修改，请刷新后重试（本次按整层保存）")
    if base.get("count") is None:
        raise LayerVersionConflict("增量保存缺少基底要素数，本次按整层保存")


def _is_user_prop(key: str) -> bool:
    """可作为 TAB 属性列的用户属性键（排除内部字段、样式持久化列与绘制样式键）。"""
    if key.startswith("_"):
        return False
    return key not in _INTERNAL_FIELDS and key not in (
        _STYLE_PERSIST_COL, _META_PERSIST_COL) and key not in _STYLE_INPUT_KEYS


def _style_meta_values(props: Dict[str, Any]) -> tuple:
    """要素属性 → (样式持久化 JSON, 圆/椭圆元数据 JSON)，无则空串占位。"""
    es = props.get("_editStyle")
    style = json.dumps(es, ensure_ascii=False) if isinstance(es, dict) else ""
    meta = {k: props[k] for k in ("_shape", "_ellipse") if props.get(k) is not None}
    return style, (json.dumps(meta, ensure_ascii=False) if meta else "")


def _collect_new_columns(upserts: List[Dict[str, Any]], existing: List[str]) -> List[str]:
    """patch 带来的新属性键（旧 schema 之外的列自动追加，与整层保存语义一致）。"""
    seen = set(existing)
    new_cols: List[str] = []
    for item in upserts:
        for key in (item.get("properties") or {}).keys():
            if key in seen or not _is_user_prop(key):
                continue
            if len(new_cols) >= _MAX_NEW_COLUMNS:
                return new_cols
            seen.add(key)
            new_cols.append(key)
    return new_cols


def _resolve_delete_rows(deletes: Any, row_count: int) -> List[int]:
    """校验删除行号（去重、界内），非法行号直接抛 LayerVersionConflict 触发整层回退。"""
    rows: List[int] = []
    seen = set()
    for raw in deletes or []:
        row = int(raw)
        if row < 0 or row >= row_count or row in seen:
            raise LayerVersionConflict(f"删除行号越界或重复: {row}（本次按整层保存）")
        seen.add(row)
        rows.append(row)
    return rows


def _apply_upserts(gdf, upserts: List[Dict[str, Any]], base_dtypes: Dict[str, Any]):
    """按行写入属性 / 几何；row=None 追加新要素。

    返回 (新 gdf, 追加行样式)；行序：基底→追加。追加行的 _style（如从其他图层
    粘贴要素的原生配色）不入 TAB schema，由样式列表带出，避免追加行保存后变黑。
    """
    update_items = [it for it in upserts if it.get("row") is not None]
    append_items = [it for it in upserts if it.get("row") is None]

    # 变更要素的坐标逆转换与几何构建（只处理变更部分；无法解析的要素退回原几何）
    built = build_geometries([it.get("geometry") for it in update_items + append_items],
                             from_wgs84=False)
    update_geoms = built[:len(update_items)]
    append_geoms = built[len(update_items):]

    if update_items:
        rows = [int(it["row"]) for it in update_items]
        for row in rows:
            if row < 0 or row >= len(gdf):
                raise LayerVersionConflict(f"更新行号越界: {row}（本次按整层保存）")
        props_list = [it.get("properties") or {} for it in update_items]
        styles = [_style_meta_values(p) for p in props_list]
        # 基底无样式列但本次写入样式时先建列
        for idx, col in enumerate((_STYLE_PERSIST_COL, _META_PERSIST_COL)):
            if col not in gdf.columns and any(s[idx] for s in styles):
                gdf[col] = ""
        for col in list(gdf.columns):
            if col == "geometry":
                continue
            if col in (_STYLE_PERSIST_COL, _META_PERSIST_COL):
                idx = 0 if col == _STYLE_PERSIST_COL else 1
                gdf.loc[rows, col] = [s[idx] for s in styles]
                continue
            # 只覆盖 props 中实际存在的键，未提供的列保持原值
            subset = [(r, p) for r, p in zip(rows, props_list)
                      if col in p and _is_user_prop(col)]
            if subset:
                gdf.loc[[r for r, _ in subset], col] = [_scalarize(p.get(col)) for _, p in subset]
        valid = [(r, g) for r, g in zip(rows, update_geoms) if g is not None and not g.is_empty]
        if valid:
            gdf.loc[[r for r, _ in valid], "geometry"] = [g for _, g in valid]

    appended_styles: List[Optional[Dict[str, Any]]] = []
    if append_items:
        for col in (_STYLE_PERSIST_COL, _META_PERSIST_COL):
            if col not in gdf.columns:
                gdf[col] = ""
        rows_dict: List[Dict[str, Any]] = []
        for it, geom in zip(append_items, append_geoms):
            if geom is None or geom.is_empty:
                continue
            props = it.get("properties") or {}
            # 追加行样式：_editStyle 优先，粘贴要素携带的 _style 兜底
            appended_styles.append(_resolve_feature_style(
                _geom_kind(geom), es=props.get("_editStyle"), ns=props.get("_style")))
            style, meta = _style_meta_values(props)
            row: Dict[str, Any] = {col: None for col in gdf.columns if col != "geometry"}
            for col in list(row):
                if col in (_STYLE_PERSIST_COL, _META_PERSIST_COL):
                    continue
                if col in props and _is_user_prop(col):
                    row[col] = _scalarize(props.get(col))
            row[_STYLE_PERSIST_COL] = style
            row[_META_PERSIST_COL] = meta
            row["geometry"] = geom
            rows_dict.append(row)
        if rows_dict:
            extra = gpd.GeoDataFrame(
                pd.DataFrame(rows_dict, columns=list(gdf.columns)),
                geometry="geometry", crs="EPSG:4326",
            )
            gdf = pd.concat([gdf, extra], ignore_index=True)

    # 数值列按基底 dtype 收敛（loc 写入会污染 dtype），列序保持不变
    for col in list(gdf.columns):
        if col != "geometry":
            gdf[col] = _coerce_column(gdf[col], base_dtypes.get(col))
    return gdf, appended_styles


def _prune_empty_style_columns(gdf):
    """样式/元数据列全为空时移除：避免给本来没有样式列的图层凭空格出两列。"""
    for col in (_STYLE_PERSIST_COL, _META_PERSIST_COL):
        if col in gdf.columns and not gdf[col].astype(str).str.len().gt(0).any():
            gdf = gdf.drop(columns=[col])
    return gdf


def apply_layer_patch(data_id: str, layer_id: str, patch: Dict[str, Any],
                      user_id: int = 1) -> Dict[str, Any]:
    """按行合并增量变更后整层重写 TAB。

    Args:
        patch: {"base": {"count": N, "version": "<etag>"},
                "upserts": [{"row": i|None, "geometry": {...}, "properties": {...}}],
                "deletes": [row, ...]}

    Returns:
        {"success": True, "feature_count": N, "mode": "patch", ...}

    Raises:
        LayerVersionConflict: 基底不一致（调用方回退整层保存）
    """
    data_dir, entry, tab_path, entry_type = _resolve_layer_target(data_id, layer_id)
    base = patch.get("base") or {}
    _check_base_version(tab_path, layer_id, base)

    # 读取基底（WGS84）：属性列与 dtype 均以文件为准
    raw_gdf = _read_tab_gdf(tab_path)
    # 空 TAB（无要素）读回可能是无 geometry 列的普通 DataFrame：补空几何列
    if "geometry" not in raw_gdf.columns:
        raw_gdf = gpd.GeoDataFrame(
            raw_gdf, geometry=gpd.GeoSeries(), crs="EPSG:4326"
        )
    valid_mask = raw_gdf.geometry.notna() & ~raw_gdf.geometry.is_empty
    gdf = raw_gdf[valid_mask].reset_index(drop=True)
    # 旧 .map 逐要素原生样式（与过滤后的基底行序对齐），未变更要素重写时据此还原配色
    old_native_styles = read_tab_native_styles(tab_path)
    if len(old_native_styles) == len(raw_gdf):
        old_native_styles = [s for s, keep in zip(old_native_styles, valid_mask) if keep]
    if len(gdf) != int(base["count"]):
        raise LayerVersionConflict(
            f"图层要素数已变化（工作集 {base['count']}，文件 {len(gdf)}），本次按整层保存"
        )

    upserts = patch.get("upserts") or []
    if len(upserts) > _MAX_CHANGES:
        raise LayerVersionConflict(f"变更要素过多（{len(upserts)}），本次按整层保存")
    delete_rows = _resolve_delete_rows(patch.get("deletes"), len(gdf))

    attr_cols = [c for c in gdf.columns if c != "geometry"
                 and c not in (_STYLE_PERSIST_COL, _META_PERSIST_COL)]
    base_dtypes = {c: gdf[c].dtype for c in gdf.columns if c != "geometry"}
    new_cols = _collect_new_columns(upserts, attr_cols)
    for col in new_cols:
        gdf[col] = None

    gdf, appended_styles = _apply_upserts(gdf, upserts, base_dtypes)

    # 逐要素样式：
    # - 基底行：变更要素用 NPT_FEATSYM 中的 _editStyle，其余按旧行序用原生样式兜底
    # - 追加行：直接用 _apply_upserts 带出的样式（粘贴要素的 _style 不入库，只能由此带出）
    base_row_count = len(old_native_styles)
    npt_series = gdf[_STYLE_PERSIST_COL] if _STYLE_PERSIST_COL in gdf.columns else None
    feature_styles: List[Optional[Dict[str, Any]]] = []
    for i in range(len(gdf)):
        if i >= base_row_count:
            feature_styles.append(appended_styles[i - base_row_count])
            continue
        es = None
        if npt_series is not None:
            raw = npt_series.iloc[i]
            if isinstance(raw, str) and raw.strip():
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        es = parsed
                except Exception:
                    es = None
        feature_styles.append(_resolve_feature_style(
            _geom_kind(gdf.geometry.iloc[i]), es=es, ns=old_native_styles[i]))

    if delete_rows:
        delete_set = set(delete_rows)
        feature_styles = [s for i, s in enumerate(feature_styles) if i not in delete_set]
        gdf = gdf.drop(index=delete_rows).reset_index(drop=True)

    gdf = _prune_empty_style_columns(gdf)
    if len(gdf.columns) <= 1:  # TAB 至少 1 个属性列
        gdf["name"] = ""

    result = _write_layer_gdf(
        data_id=data_id, data_dir=data_dir, tab_path=tab_path, layer_id=layer_id,
        entry=entry, entry_type=entry_type, gdf=gdf, geoms=list(gdf.geometry),
        user_id=user_id, feature_styles=feature_styles,
    )
    result["mode"] = "patch"
    result["applied"] = {"upserts": len(upserts), "deletes": len(delete_rows)}
    return result
