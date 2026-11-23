"""
导出服务 - 用于导出规划结果
"""

import csv
import logging
import math
import re
import zipfile
from pathlib import Path
import pandas as pd
from datetime import datetime
from typing import Dict, Any
from xml.sax.saxutils import escape

logger = logging.getLogger(__name__)


async def export_tac_result(task_id: str, result: Dict[str, Any], format: str = "xlsx"):
    """
    导出TAC规划结果

    Args:
        task_id: 任务ID
        result: 规划结果
        format: 导出格式 'xlsx' 或 'csv'

    Returns:
        文件内容（FileResponse）
    """
    try:
        logger.info(f"开始导出TAC规划结果: task_id={task_id}, format={format}")

        # 提取结果数据
        results = result.get("results", [])
        if not results:
            raise ValueError("没有可导出的结果数据")

        # 转换为DataFrame
        df = pd.DataFrame(results)

        # 重排列列顺序（第一列为运营商/厂家）
        columns_order = [
            "firstGroup",
            "siteId",
            "siteName",
            "sectorId",
            "sectorName",
            "networkType",
            "longitude",
            "latitude",
            "tac",
            "existingTac",
            "matched",
            "isSingularity",  # TAC是否插花
            "suggestedTac",  # TAC建议值
        ]

        # 确保所有列都存在
        for col in columns_order:
            if col not in df.columns:
                df[col] = None

        df = df[columns_order]

        # 重命名列
        df.columns = [
            "运营商/厂家",
            "站点ID",
            "站点名称",
            "小区ID",
            "小区名称",
            "网络类型",
            "经度",
            "纬度",
            "图层TAC",
            "现网TAC",
            "匹配状态",
            "TAC是否插花",  # 新增
            "TAC建议值",  # 新增：对于插花小区，取图层TAC值
        ]

        # 添加TAC是否一致列（放在最后）
        def check_consistency(row):
            tac = row["图层TAC"]
            existing_tac = row["现网TAC"]
            if pd.isna(tac) or pd.isna(existing_tac):
                return "-"
            # 标准化TAC值
            tac_str = str(tac).strip()
            existing_str = str(existing_tac).strip()
            # 去除前导零（但保留单个0）
            tac_str = tac_str.lstrip("0") or "0"
            existing_str = existing_str.lstrip("0") or "0"
            return "是" if tac_str == existing_str else "否"

        df["TAC是否一致"] = df.apply(check_consistency, axis=1)

        # 转换匹配状态为中文
        df["匹配状态"] = df["匹配状态"].map({True: "已匹配", False: "未匹配"})

        # 转换TAC是否插花为中文
        if "TAC是否插花" in df.columns:
            # 与统计卡片保持一致：直接根据isSingularity字段显示，现网TAC为空也显示"否"
            df["TAC是否插花"] = df["TAC是否插花"].map({True: "是", False: "否"})

        # 转换TAC建议值：插花小区取图层TAC值；TAC不一致但非插花的小区给人工核查提示
        def get_suggested_tac_display(row):
            if row.get("TAC是否插花") == "是":
                tac = row.get("图层TAC")
                return str(tac) if pd.notna(tac) else ""
            if row.get("TAC是否一致") == "否":
                from app.services.tac_planning_service import SUGGEST_RECHECK_TEXT
                return SUGGEST_RECHECK_TEXT
            return ""
        df["TAC建议值"] = df.apply(get_suggested_tac_display, axis=1)

        # 获取网络类型
        network_type = result.get("networkType", "LTE")
        # 使用LTE/NR作为标识
        network_label = network_type  # LTE 或 NR

        # 生成临时文件名（用于服务器端存储）
        temp_filename = f"tac_export_{task_id}.{format}"

        # 保存到临时文件
        from app.core.config import settings

        export_dir = settings.EXPORT_DIR
        export_dir.mkdir(parents=True, exist_ok=True)

        export_path = export_dir / temp_filename

        if format == "xlsx":
            # 导出为Excel
            df.to_excel(export_path, index=False, engine="openpyxl")
            logger.info(f"Excel文件已保存到: {export_path}")
        else:
            # 导出为CSV
            df.to_csv(export_path, index=False, encoding="utf-8-sig")
            logger.info(f"CSV文件已保存到: {export_path}")

        # 读取文件内容并返回
        with open(export_path, "rb") as f:
            content = f.read()

        logger.info(f"TAC规划结果导出成功: {temp_filename}, 大小: {len(content)} bytes")

        # 返回FastAPI的FileResponse
        from fastapi.responses import FileResponse

        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if format == "xlsx"
            else "text/csv"
        )

        # 不设置 filename，让前端控制下载文件名
        return FileResponse(path=export_path, media_type=media_type)

    except Exception as e:
        logger.error(f"导出TAC规划结果失败: {e}")
        raise


async def export_tac_planning_result(
    task_id: str, result: Dict[str, Any], format: str = "xlsx"
):
    """
    导出TAC规划任务结果（待规划小区清单的TAC分配）

    Args:
        task_id: 任务ID
        result: 规划结果
        format: 导出格式 'xlsx' 或 'csv'

    Returns:
        文件内容（FileResponse）
    """
    try:
        logger.info(f"开始导出TAC规划结果: task_id={task_id}, format={format}")

        # 提取结果数据
        results = result.get("results", [])
        if not results:
            raise ValueError("没有可导出的结果数据")

        # 转换为DataFrame
        df = pd.DataFrame(results)

        # 重排列列顺序
        columns_order = [
            "siteId",
            "siteName",
            "sectorId",
            "sectorName",
            "networkType",
            "longitude",
            "latitude",
            "tac",
        ]

        # 确保所有列都存在
        for col in columns_order:
            if col not in df.columns:
                df[col] = None

        df = df[columns_order]

        # 重命名列
        df.columns = [
            "站点ID",
            "站点名称",
            "小区ID",
            "小区名称",
            "网络类型",
            "经度",
            "纬度",
            "TAC分配值",
        ]

        # 获取网络类型
        network_type = result.get("networkType", "LTE")
        network_type_label = "4G" if network_type == "LTE" else "5G"

        # 生成临时文件名（用于服务器端存储）
        temp_filename = f"tac_planning_export_{task_id}.{format}"

        # 保存到临时文件
        from app.core.config import settings

        export_dir = settings.EXPORT_DIR
        export_dir.mkdir(parents=True, exist_ok=True)

        export_path = export_dir / temp_filename

        if format == "xlsx":
            # 导出为Excel
            df.to_excel(export_path, index=False, engine="openpyxl")
            logger.info(f"Excel文件已保存到: {export_path}")
        else:
            # 导出为CSV
            df.to_csv(export_path, index=False, encoding="utf-8-sig")
            logger.info(f"CSV文件已保存到: {export_path}")

        # 读取文件内容并返回
        with open(export_path, "rb") as f:
            content_bytes = f.read()

        logger.info(
            f"TAC规划结果导出成功: {temp_filename}, 大小: {len(content_bytes)} bytes"
        )

        # 返回FastAPI的FileResponse
        from fastapi.responses import FileResponse

        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if format == "xlsx"
            else "text/csv"
        )

        # 不设置 filename，让前端控制下载文件名
        return FileResponse(path=export_path, media_type=media_type)

    except Exception as e:
        logger.error(f"导出TAC规划结果失败: {e}")
        raise


# PCI核查导出列（一行一个异常小区对）
# 复用/冲突/混淆：合并 CGI 与 PCI，删除模数、模值、方位角
_PCI_CGI_COLUMNS = [
    ("checkTypeName", "核查类型"),
    ("networkType", "网络类型"),
    ("aCgi", "检查CGI"),
    ("aSiteName", "核查基站名称"),
    ("aSectorName", "核查小区名称"),
    ("aFrequency", "核查小区频点"),
    ("aVendor", "核查小区厂家"),
    ("aCoverageType", "核查小区覆盖类型"),
    ("aLongitude", "核查小区经度"),
    ("aLatitude", "核查小区纬度"),
    ("bCgi", "对照CGI"),
    ("bSiteName", "对照基站名称"),
    ("bSectorName", "对照小区名称"),
    ("bFrequency", "对照小区频点"),
    ("bVendor", "对照小区厂家"),
    ("bCoverageType", "对照小区覆盖类型"),
    ("bLongitude", "对照小区经度"),
    ("bLatitude", "对照小区纬度"),
    ("pci", "目标1-PCI"),
    ("distanceM", "源小区与目标1-小区距离(米)"),
    ("reason", "问题描述"),
]

_PCI_CONFUSION_COLUMNS = [
    ("cCgi", "第二邻小区CGI"),
    ("cSiteName", "第二邻小区基站名称"),
    ("cSectorName", "第二邻小区名称"),
    ("cPci", "第二邻小区PCI"),
    ("cFrequency", "第二邻小区频点"),
    ("cVendor", "第二邻小区厂家"),
    ("cCoverageType", "第二邻小区覆盖类型"),
    ("aToCDistanceM", "核查小区与第二邻小区距离(米)"),
    ("bToCDistanceM", "两个同PCI邻小区距离(米)"),
]

# 同站模3/对打模3：合并 CGI，删除模数，保留模值与方位角
_PCI_MOD_COLUMNS = [
    ("checkTypeName", "核查类型"),
    ("networkType", "网络类型"),
    ("aCgi", "检查CGI"),
    ("aSiteName", "核查基站名称"),
    ("aSectorName", "核查小区名称"),
    ("aPci", "核查小区PCI"),
    ("aFrequency", "核查小区频点"),
    ("aVendor", "核查小区厂家"),
    ("aCoverageType", "核查小区覆盖类型"),
    ("aMod", "核查小区模值"),
    ("aLongitude", "核查小区经度"),
    ("aLatitude", "核查小区纬度"),
    ("aAzimuth", "核查小区方位角"),
    ("bCgi", "对照CGI"),
    ("bSiteName", "对照基站名称"),
    ("bSectorName", "对照小区名称"),
    ("bPci", "对照小区PCI"),
    ("bFrequency", "对照小区频点"),
    ("bVendor", "对照小区厂家"),
    ("bCoverageType", "对照小区覆盖类型"),
    ("bMod", "对照小区模值"),
    ("bLongitude", "对照小区经度"),
    ("bLatitude", "对照小区纬度"),
    ("bAzimuth", "对照小区方位角"),
    ("distanceM", "源小区与目标1-小区距离(米)"),
    ("reason", "问题描述"),
]

# 其余类别保持既有列口径，仅补充厂家与覆盖类型
_PCI_FULL_COLUMNS = [
    ("checkTypeName", "核查类型"),
    ("networkType", "网络类型"),
    ("aSiteId", "核查基站ID"),
    ("aSiteName", "核查基站名称"),
    ("aSectorId", "核查小区ID"),
    ("aSectorName", "核查小区名称"),
    ("aPci", "核查小区PCI"),
    ("aFrequency", "核查小区频点"),
    ("aVendor", "核查小区厂家"),
    ("aCoverageType", "核查小区覆盖类型"),
    ("modulus", "模数"),
    ("aMod", "核查小区模值"),
    ("aLongitude", "核查小区经度"),
    ("aLatitude", "核查小区纬度"),
    ("aAzimuth", "核查小区方位角"),
    ("bSiteId", "对照基站ID"),
    ("bSiteName", "对照基站名称"),
    ("bSectorId", "对照小区ID"),
    ("bSectorName", "对照小区名称"),
    ("bPci", "对照小区PCI"),
    ("bFrequency", "对照小区频点"),
    ("bVendor", "对照小区厂家"),
    ("bCoverageType", "对照小区覆盖类型"),
    ("bMod", "对照小区模值"),
    ("bLongitude", "对照小区经度"),
    ("bLatitude", "对照小区纬度"),
    ("bAzimuth", "对照小区方位角"),
    ("cSiteId", "第二邻小区基站ID"),
    ("cSiteName", "第二邻小区基站名称"),
    ("cSectorId", "第二邻小区ID"),
    ("cSectorName", "第二邻小区名称"),
    ("cPci", "第二邻小区PCI"),
    ("cFrequency", "第二邻小区频点"),
    ("cVendor", "第二邻小区厂家"),
    ("cCoverageType", "第二邻小区覆盖类型"),
    ("distanceM", "源小区与目标1-小区距离(米)"),
    ("aToCDistanceM", "核查小区与第二邻小区距离(米)"),
    ("bToCDistanceM", "两个同PCI邻小区距离(米)"),
    ("reason", "问题描述"),
]


def _pci_export_header(header: str, is_confusion: bool) -> str:
    """导出列名的小区侧称呼：核查→源；混淆表区分目标1-/目标2-，其他类别统一为“目标”"""
    if header == "核查类型":
        return header
    header = header.replace("核查", "源")
    if is_confusion:
        return header.replace("对照", "目标1-").replace("第二邻", "目标2-")
    return (
        header.replace("目标1-", "目标")
        .replace("对照", "目标")
        .replace("第二邻", "目标2-")
    )


def _pci_columns_for(check_type: str) -> list:
    from app.algorithms.pci_check_types import CheckType

    category = CheckType(check_type)
    if category in (CheckType.REUSE_DISTANCE, CheckType.COLLISION):
        return _PCI_CGI_COLUMNS
    if category == CheckType.CONFUSION:
        return _PCI_CGI_COLUMNS[:-2] + _PCI_CONFUSION_COLUMNS + _PCI_CGI_COLUMNS[-2:]
    if category in (CheckType.MOD3_SAME_SITE, CheckType.MOD3_FACING):
        return _PCI_MOD_COLUMNS
    return _PCI_FULL_COLUMNS


def _pci_check_dataframe(rows: list, check_type: str) -> pd.DataFrame:
    """按类别固定列顺序构造单类核查结果的 DataFrame"""
    frame = pd.DataFrame(rows)
    if "pci" in frame.columns and "bPci" in frame.columns:
        # PCI 列只展示目标小区 PCI；兼容历史任务里 "源 / 目标" 的旧值
        frame["pci"] = frame["bPci"]
    is_confusion = check_type == "confusion"
    ordered = [
        (field, _pci_export_header(header, is_confusion))
        for field, header in _pci_columns_for(check_type)
        if field in frame.columns
    ]
    frame = frame[[field for field, _ in ordered]]
    frame.columns = [header for _, header in ordered]
    return frame


async def export_pci_check_result(
    task_id: str, result: Dict[str, Any], format: str = "xlsx", check_type: str = None
):
    """
    导出PCI核查结果：每类问题各自成表（xlsx 一类一个 sheet，csv 按 check_type 单类导出）

    Args:
        task_id: 任务ID
        result: 核查结果，results 为 {核查类型: 行列表}
        format: 'xlsx' 或 'csv'
        check_type: csv 时必填，指定导出的核查类型
    """
    try:
        from app.algorithms.pci_check_types import CHECK_TYPE_NAMES, CheckType

        logger.info(
            f"开始导出PCI核查结果: task_id={task_id}, format={format}, check_type={check_type}"
        )

        results_by_type = result.get("results", {}) or {}
        hit_types = [check for check in CheckType if results_by_type.get(check.value)]
        if not hit_types:
            raise ValueError("没有可导出的核查结果")

        if format == "csv":
            valid_values = [check.value for check in CheckType]
            if check_type not in valid_values:
                raise ValueError(f"CSV 导出需指定有效的核查类型，可选值：{valid_values}")
            hit_types = [CheckType(check_type)]

        from app.core.config import settings

        export_dir = Path(settings.EXPORT_DIR)
        export_dir.mkdir(parents=True, exist_ok=True)
        suffix = check_type or "all"
        export_path = export_dir / f"pci_check_export_{task_id}_{suffix}.{format}"

        if format == "xlsx":
            with pd.ExcelWriter(export_path, engine="openpyxl") as writer:
                for check in hit_types:
                    frame = _pci_check_dataframe(results_by_type[check.value], check.value)
                    # sheet 名即中文类别名，Excel 限制 31 字符
                    frame.to_excel(writer, sheet_name=CHECK_TYPE_NAMES[check][:31], index=False)
                    logger.info(f"PCI核查分类 '{CHECK_TYPE_NAMES[check]}' 导出 {len(frame)} 行")
        else:
            frame = _pci_check_dataframe(results_by_type[hit_types[0].value], hit_types[0].value)
            frame.to_csv(export_path, index=False, encoding="utf-8-sig")
            logger.info(f"PCI核查分类 '{check_type}' CSV 导出 {len(frame)} 行")

        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if format == "xlsx"
            else "text/csv"
        )

        from fastapi.responses import FileResponse

        # 不设置 filename，让前端控制下载文件名
        return FileResponse(path=export_path, media_type=media_type)

    except Exception as e:
        logger.error(f"导出PCI核查结果失败: {e}")
        raise


# ---- 大结果流式导出 ----
# 邻区结果可达几十万行：pandas.to_excel(openpyxl) 需要为每个单元格构建 Cell 对象，
# 实测 73 万行 > 277s（超过前端 300s 超时）。这里直接生成 xlsx 的 ZIP/XML 并逐行写，
# 不构建对象树；csv 同理用 csv.writer 逐行写，内存与耗时都只随行数线性增长。

_XLSX_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)
_XLSX_ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)
_XLSX_WORKBOOK = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
)
_XLSX_WORKBOOK_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '</Relationships>'
)
_XML_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _column_letter(index: int) -> str:
    """0-based 列号转 Excel 列标（0 -> A, 26 -> AA）。"""
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _cell_xml(ref: str, value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        value = "TRUE" if value else "FALSE"
    elif isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            value = str(value)
        else:
            return f'<c r="{ref}"><v>{value}</v></c>'
    text = _XML_ILLEGAL.sub("", escape(str(value)))
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'


def _row_xml(row_number: int, values: list) -> str:
    cells = "".join(
        _cell_xml(f"{_column_letter(j)}{row_number}", value)
        for j, value in enumerate(values)
    )
    return f'<row r="{row_number}">{cells}</row>'


def _write_xlsx_stream(path: Path, columns: list, rows: list) -> None:
    last_col = _column_letter(len(columns) - 1) if columns else "A"
    dimension = f"A1:{last_col}{len(rows) + 1}"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        archive.writestr("[Content_Types].xml", _XLSX_CONTENT_TYPES)
        archive.writestr("_rels/.rels", _XLSX_ROOT_RELS)
        archive.writestr("xl/workbook.xml", _XLSX_WORKBOOK)
        archive.writestr("xl/_rels/workbook.xml.rels", _XLSX_WORKBOOK_RELS)
        with archive.open("xl/worksheets/sheet1.xml", "w") as sheet:
            sheet.write(
                (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                    f'<dimension ref="{dimension}"/><sheetData>'
                ).encode("utf-8")
            )
            sheet.write(_row_xml(1, columns).encode("utf-8"))
            buffer = []
            for number, row in enumerate(rows, start=2):
                buffer.append(_row_xml(number, [row.get(c) for c in columns]))
                if len(buffer) >= 2000:
                    sheet.write("".join(buffer).encode("utf-8"))
                    buffer.clear()
            if buffer:
                sheet.write("".join(buffer).encode("utf-8"))
            sheet.write(b"</sheetData></worksheet>")


def _write_csv_stream(path: Path, columns: list, rows: list) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        if columns:
            writer.writerow(columns)
        for row in rows:
            writer.writerow([row.get(c) for c in columns])


def write_result_file(path: Path, rows: list, fmt: str) -> None:
    """流式写导出文件（xlsx / csv），列名取首行键顺序。"""
    columns = list(rows[0].keys()) if rows else []
    if fmt == "xlsx":
        _write_xlsx_stream(path, columns, rows)
    elif fmt == "csv":
        _write_csv_stream(path, columns, rows)
    else:
        raise ValueError(f"不支持的导出格式: {fmt}")
