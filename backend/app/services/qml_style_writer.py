"""QGIS .qml 样式写出。

把 app 内部的 _style dict 写成 QGIS 可识别的符号定义，与读侧
`MapInfoParser._qgis_symbol_to_style` 严格互逆，保证「保存 → 重新导入」配色不漂移。

逐要素配色用 RuleRenderer + `$id` 过滤表达：QGIS 的 categorizedSymbol 需要按属性列
分类，而本模块刻意不落属性列（字段名在 DBF 中受限），`$id` 过滤不需要任何属性列，
QGIS 原生支持。

单位换算与读侧互为倒数（读侧 _QGIS_MM_TO_PX = 3.7795）：
  - 线宽/描边宽：app 为 px，QGIS 为 mm
  - 点大小：app markerSize 是半径(px)，QGIS size 是直径(mm)

已知取舍：fillPattern 是 MapInfo 专有的画刷图案编号，QGIS 读侧不表达图案，
写进去也无法往返，故只写出 solid / no 两态。
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional

# 与 mapinfo_service.MapInfoParser._QGIS_MM_TO_PX 互为倒数
MM_TO_PX = 3.7795

# app 点形状 → QGIS SimpleMarker name（_QGIS_MARKER_SHAPES 的逆映射，取最规范的那个）
_SHAPE_TO_QGIS = {
    "circle": "circle",
    "square": "square",
    "diamond": "diamond",
    "triangle": "triangle",
    "star": "star",
}

# 符号级 alpha 缺省（读侧 symbol alpha 缺省为 1）
_DEFAULT_OPACITY = 1.0


def _hex_to_qgis_color(value: Any) -> Optional[str]:
    """'#rrggbb' → 'r,g,b,255'；无色哨兵/非法值返回 None。

    alpha 恒写 255：读侧 _qgis_color 在 alpha==0 时返回 None（视为无色），
    透明度统一由符号级 alpha 表达，避免两处都能表达导致读回语义分叉。
    """
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or v.lower() == "none" or not v.startswith("#") or len(v) != 7:
        return None
    try:
        r = int(v[1:3], 16)
        g = int(v[3:5], 16)
        b = int(v[5:7], 16)
    except ValueError:
        return None
    return f"{r},{g},{b},255"


def _px_to_mm(px: Any, default: float) -> float:
    """px → mm，非法值回退 default。"""
    try:
        return round(float(px) / MM_TO_PX, 3)
    except (TypeError, ValueError):
        return default


def _clamp01(v: Any) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return _DEFAULT_OPACITY


def _is_off(color: Any, off_flag: Any) -> bool:
    """是否「无色」：显式关闭标志，或颜色为空/无色哨兵。"""
    if off_flag:
        return True
    if color is None:
        return True
    return isinstance(color, str) and color.strip().lower() == "none"


def _dash_to_qgis(dash: Any) -> Optional[str]:
    """app 的 dashArray / 虚线描述 → QGIS customdash 串（'5;2' 形式）。"""
    if dash is None:
        return None
    if isinstance(dash, str):
        parts = [p for p in dash.replace(",", ";").split(";") if p.strip()]
        return ";".join(parts) if parts else None
    if isinstance(dash, (list, tuple)) and dash:
        return ";".join(str(x) for x in dash)
    return None


def _marker_symbol(style: Dict[str, Any]) -> ET.Element:
    """点样式 → <symbol type="marker">（SimpleMarker）。"""
    color = style.get("markerColor")
    outline = style.get("color")
    off = _is_off(color, None)
    outline_off = _is_off(outline, None)

    sym = ET.Element("symbol", {
        "name": "0", "type": "marker", "alpha": str(_clamp01(style.get("fillOpacity"))),
        "clip_to_extent": "1",
    })
    layer = ET.SubElement(sym, "layer", {"class": "SimpleMarker"})
    props: List[tuple] = [
        # 读侧 markerSize 为半径 px：size(mm) = markerSize * 2 / MM_TO_PX
        ("size", str(_px_to_mm((style.get("markerSize") or 8) * 2, 2.0))),
        ("name", _SHAPE_TO_QGIS.get(str(style.get("markerSymbol") or "").lower(), "circle")),
        ("style", "no" if off else "solid"),
        ("color", _hex_to_qgis_color(color) or "0,0,0,255"),
        ("outline_style", "no" if outline_off else "solid"),
        ("outline_color", _hex_to_qgis_color(outline) or "0,0,0,255"),
        ("outline_width", "0.26"),
    ]
    for k, v in props:
        ET.SubElement(layer, "prop", {"k": k, "v": v})
    return sym


def _line_symbol(style: Dict[str, Any]) -> ET.Element:
    """线样式 → <symbol type="line">（SimpleLine）。"""
    color = style.get("strokeColor")
    off = _is_off(color, style.get("strokeOff"))
    dash = _dash_to_qgis(style.get("strokeDash"))

    sym = ET.Element("symbol", {
        "name": "0", "type": "line", "alpha": "1", "clip_to_extent": "1",
    })
    layer = ET.SubElement(sym, "layer", {"class": "SimpleLine"})
    props: List[tuple] = [
        ("line_color", _hex_to_qgis_color(color) or "0,0,0,255"),
        # 读侧 line_style == 'no' → strokeColor = 'none'（无色哨兵）
        ("line_style", "no" if off else ("dash" if dash else "solid")),
        ("line_width", str(_px_to_mm(style.get("strokeWidth") or 1, 0.26))),
    ]
    if dash:
        props.append(("customdash", dash))
        props.append(("use_custom_dash", "1"))
    for k, v in props:
        ET.SubElement(layer, "prop", {"k": k, "v": v})
    return sym


def _fill_symbol(style: Dict[str, Any]) -> ET.Element:
    """面样式 → <symbol type="fill">（SimpleFill）。"""
    fill = style.get("fillColor")
    stroke = style.get("strokeColor")
    fill_off = _is_off(fill, style.get("fillOff"))
    stroke_off = _is_off(stroke, style.get("strokeOff"))

    sym = ET.Element("symbol", {
        "name": "0", "type": "fill", "alpha": str(_clamp01(style.get("fillOpacity"))),
        "clip_to_extent": "1",
    })
    layer = ET.SubElement(sym, "layer", {"class": "SimpleFill"})
    props: List[tuple] = [
        # 读侧 style == 'no' → fill = False；图案无往返价值，统一 solid
        ("style", "no" if fill_off else "solid"),
        ("color", _hex_to_qgis_color(fill) or "0,0,0,255"),
        ("outline_style", "no" if stroke_off else "solid"),
        ("outline_color", _hex_to_qgis_color(stroke) or "0,0,0,255"),
        ("outline_width", str(_px_to_mm(style.get("strokeWidth") or 1, 0.26))),
    ]
    for k, v in props:
        ET.SubElement(layer, "prop", {"k": k, "v": v})
    return sym


def _geom_kind(style: Dict[str, Any], fallback: str) -> str:
    """要素几何类型：优先样式自带的 kind（混合图层逐要素可能不同）。"""
    k = str(style.get("kind") or "").lower()
    return k if k in ("point", "line", "polygon") else fallback


def style_to_qgis_symbol(style: Dict[str, Any], kind: str) -> ET.Element:
    """_style dict → QGIS <symbol> 元素。kind: point/line/polygon。"""
    kind = _geom_kind(style, kind)
    if kind == "line":
        return _line_symbol(style)
    if kind == "polygon":
        return _fill_symbol(style)
    return _marker_symbol(style)


def _fingerprint(style: Dict[str, Any]) -> str:
    """样式指纹：用于把相同样式的要素合并到同一条 rule。"""
    return json.dumps(style, sort_keys=True, ensure_ascii=False, default=str)


def _build_qml_root() -> ET.Element:
    return ET.Element("qgis", {"version": "3.34.0", "styleCategories": "Symbology"})


def build_layer_qml(kind: str, feature_styles: List[Optional[Dict[str, Any]]]) -> Optional[str]:
    """按要素样式列表生成 .qml 文本；无任何有效样式时返回 None（不写文件）。

    feature_styles[i] 对应第 i 行要素（None = 该要素无显式样式，走 QGIS 默认渲染）。
    """
    styles = list(feature_styles or [])
    if not any(s for s in styles):
        return None

    root = _build_qml_root()
    # 全部要素同色 → singleSymbol（更贴近 QGIS 习惯，也避免无谓的 rule 列表）
    present = [s for s in styles if s]
    if len(present) == len(styles) and len({_fingerprint(s) for s in present}) == 1:
        renderer = ET.SubElement(root, "renderer-v2", {"type": "singleSymbol"})
        symbols = ET.SubElement(renderer, "symbols")
        symbols.append(style_to_qgis_symbol(present[0], kind))
        return ET.tostring(root, encoding="unicode")

    # 逐要素配色 → RuleRenderer，按样式分组后用 $id 过滤命中该组的要素
    renderer = ET.SubElement(root, "renderer-v2", {
        "type": "RuleRenderer", "forceraster": "0", "symbollevels": "0", "enableorderby": "0",
    })
    rules_el = ET.SubElement(renderer, "rules", {"key": "npt-rules"})
    symbols = ET.SubElement(renderer, "symbols")

    groups: Dict[str, Dict[str, Any]] = {}
    for idx, st in enumerate(styles):
        if not st:
            continue
        groups.setdefault(_fingerprint(st), {"style": st, "ids": []})["ids"].append(idx)

    for sym_idx, (_fp, grp) in enumerate(groups.items()):
        sym = style_to_qgis_symbol(grp["style"], kind)
        sym.set("name", str(sym_idx))
        symbols.append(sym)
        ids = grp["ids"]
        expr = f"$id = {ids[0]}" if len(ids) == 1 else "$id IN ({})".format(",".join(str(i) for i in ids))
        ET.SubElement(rules_el, "rule", {
            "key": f"npt-rule-{sym_idx}", "filter": expr, "symbol": str(sym_idx),
            "label": f"npt-style-{sym_idx}",
        })

    return ET.tostring(root, encoding="unicode")


def write_layer_qml(qml_path: Path, kind: str,
                    feature_styles: List[Optional[Dict[str, Any]]]) -> bool:
    """写出图层样式到 .qml。无有效样式时删除同名旧文件并返回 False。

    删除是必要的：上一次保存有逐要素配色、这次全部清空时，残留的旧 .qml
    会让重新导入又读出已删掉的配色。
    """
    text = build_layer_qml(kind, feature_styles)
    if text is None:
        if qml_path.exists():
            qml_path.unlink()
        return False
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + text + "\n"
    tmp = qml_path.with_suffix(qml_path.suffix + ".tmp")
    tmp.write_text(xml, encoding="utf-8")
    tmp.replace(qml_path)  # 原子替换，读者不会读到半成品
    return True
