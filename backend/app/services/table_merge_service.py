# backend/app/services/table_merge_service.py
"""表格合并服务：读取多个表格文件（xlsx/xls/xlsm/csv/txt），按相同格式合并，输出单个 Excel。

合并规则
--------
- 每个输入文件按工作表拆成多张「表」（CSV/TXT 视为单表，表名取文件名）。
- 「相同格式」的判定有三种模式：
  - ``structure``（默认）：列名集合相同即视为同一格式 → 归入一组；
  - ``sheet``：工作表名相同即视为同一格式 → 分 sheet 配对合并；
  - ``columns``：所有输入表合并为一张表；按列名对齐（忽略大小写），
    同名列并入一列、不同名列追加为新列。仅支持 CSV 或只含一个工作表的 Excel，
    多 sheet 文件在读取阶段直接报错。
- 分组内列按首次出现顺序取并集，缺失列补空；可选「去除完全重复行」
  与「附加来源文件/来源表列」。
- 每个分组输出为一个工作表，工作表名取组内首个来源的表名并做合法化/去重。

表头识别
--------
- 普通表格：第 1 行为表头，数据从第 2 行开始。
- 厂商工参复杂表头（第 1 行形如「小区名称\\neNodeB Name ...」含换行元数据）：
  列名取首行中文名，数据从第 4 行开始（第 2-3 行为描述行）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import pandas as pd

from app.utils.excel_columns import dedupe_column_names

# 支持的输入格式
ALLOWED_EXTS = {".xlsx", ".xls", ".xlsm", ".csv", ".txt"}
# CSV/TXT 编码探测顺序（覆盖国内常见的 UTF-8 / GBK / GB18030）
CSV_ENCODINGS = ("utf-8", "utf-8-sig", "gbk", "gb18030", "latin-1")

# 合并模式
MODE_STRUCTURE = "structure"
MODE_SHEET = "sheet"
MODE_COLUMNS = "columns"
MERGE_MODES = (MODE_STRUCTURE, MODE_SHEET, MODE_COLUMNS)
# columns 模式下所有表合并为一张表时的工作表名
MERGED_SHEET_NAME = "合并结果"

# 输出工作表名限制（Excel 规则）
INVALID_SHEET_CHARS = r"[\[\]:*?/\\]"
MAX_SHEET_NAME_LEN = 31
# 附加来源信息时的列名
SOURCE_FILE_COLUMN = "来源文件"
SOURCE_SHEET_COLUMN = "来源Sheet"


@dataclass
class SourceTable:
    """一张待合并的表（= 某文件中的某个工作表）"""

    file_name: str
    sheet_name: str
    columns: List[str]
    rows: List[List[Any]]

    @property
    def column_set(self) -> Tuple[str, ...]:
        """列名集合（去重 + 排序，忽略列顺序）"""
        return tuple(sorted(set(self.columns)))


@dataclass
class MergePlan:
    """一个合并分组的输出计划"""

    output_sheet: str
    columns: List[str]
    rows: List[List[Any]]
    sources: List[Dict[str, Any]]


# ===== 读取 =====

def _read_csv_frame(file_path: Path) -> pd.DataFrame:
    """读取 CSV/TXT：自动探测编码与分隔符，返回无表头原始帧（header=None）。"""
    last_err: Optional[Exception] = None
    for enc in CSV_ENCODINGS:
        try:
            return pd.read_csv(
                file_path, encoding=enc, sep=None, engine="python", header=None, dtype=object
            )
        except UnicodeDecodeError as e:
            last_err = e
            continue
        except pd.errors.EmptyDataError:
            return pd.DataFrame()
    raise ValueError(
        f"无法读取 CSV/TXT 文件（尝试编码：{', '.join(CSV_ENCODINGS)}）：{last_err}"
    )


def _read_excel_frames(file_path: Path) -> Dict[str, pd.DataFrame]:
    """读取 Excel 所有工作表为原始帧（header=None）。"""
    try:
        xls = pd.ExcelFile(file_path, engine="calamine")
    except ImportError:
        # calamine 未安装时回退默认引擎（openpyxl，仅支持 .xlsx/.xlsm）
        xls = pd.ExcelFile(file_path)
    except Exception:
        # 部分文件 calamine 解析失败时回退默认引擎（.xls 无 openpyxl 支持会抛错）
        xls = pd.ExcelFile(file_path)
    frames: Dict[str, pd.DataFrame] = {}
    for sheet in xls.sheet_names:
        frames[sheet] = pd.read_excel(xls, sheet_name=sheet, header=None, dtype=object)
    return frames


def _py_value(value: Any) -> Any:
    """把 pandas/NumPy 的缺失值与标量转成 Python 原生类型。"""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # noqa: BLE001
            return value
    return value


def _normalize_columns(names: Sequence[Any]) -> List[str]:
    """列名归一化：去首尾空格、空列名补「列N」、重名加 #2 后缀。"""
    cleaned: List[str] = []
    for idx, raw in enumerate(names):
        text = "" if raw is None else str(raw).strip()
        if not text:
            text = f"列{idx + 1}"
        cleaned.append(text)
    return dedupe_column_names(cleaned)


def _rows_from_frame(data: pd.DataFrame) -> List[List[Any]]:
    """从数据区提取行（空行丢弃，缺失值转 None）。"""
    if data is None or data.empty:
        return []
    data = data.reset_index(drop=True)
    rows: List[List[Any]] = []
    for raw_row in data.itertuples(index=False, name=None):
        row = [_py_value(v) for v in raw_row]
        # 全空行（None 或空串）视为空行丢弃
        if all(v is None or (isinstance(v, str) and not v.strip()) for v in row):
            continue
        rows.append(row)
    return rows


def _frame_to_table(file_name: str, sheet_name: str, raw: pd.DataFrame) -> Optional[SourceTable]:
    """原始帧（header=None）→ 带表头的表；空表返回 None。"""
    if raw is None or raw.empty:
        return None
    raw = raw.dropna(axis=0, how="all").dropna(axis=1, how="all")
    if raw.empty:
        return None

    header_row = raw.iloc[0]
    names: List[str] = []
    complex_header = False
    for value in header_row.tolist():
        text = "" if value is None else str(value).strip()
        if "\n" in text:
            complex_header = True
            text = next((line.strip() for line in text.split("\n") if line.strip()), "")
        names.append(text)

    # 复杂表头：第 1 行为「中文名 + \n 元数据」，第 2-3 行为描述，数据从第 4 行起
    data = raw.iloc[3:] if complex_header else raw.iloc[1:]
    columns = _normalize_columns(names)
    rows = _rows_from_frame(data)
    return SourceTable(
        file_name=file_name, sheet_name=sheet_name, columns=columns, rows=rows
    )


def read_tables(
    file_name: str, file_path: Path, require_single_table: bool = False
) -> List[SourceTable]:
    """读取一个文件中的所有表。

    - Excel（.xlsx/.xls/.xlsm）：每个工作表一张表；
    - CSV/TXT：单表，表名取文件名（去扩展名）。
    - require_single_table=True 时，含多个工作表的 Excel 直接报错（CSV 不受限）。
    """
    suffix = Path(file_path).suffix.lower()
    tables: List[SourceTable] = []
    if suffix in (".xlsx", ".xls", ".xlsm"):
        frames = _read_excel_frames(file_path)
        if require_single_table and len(frames) > 1:
            raise ValueError(
                f"按列名合并仅支持 CSV 或只包含一个工作表的 Excel 文件，"
                f"{file_name} 包含 {len(frames)} 个工作表"
            )
        for sheet_name, raw in frames.items():
            table = _frame_to_table(file_name, sheet_name, raw)
            if table is not None:
                tables.append(table)
    else:
        raw = _read_csv_frame(file_path)
        sheet_name = Path(file_name).stem or "Sheet1"
        table = _frame_to_table(file_name, sheet_name, raw)
        if table is not None:
            tables.append(table)
    return tables


# ===== 分组与合并 =====

def group_tables(tables: Sequence[SourceTable], mode: str = MODE_STRUCTURE) -> List[List[SourceTable]]:
    """按合并模式分组。

    - ``structure``：列名集合相同 → 同一组；
    - ``sheet``：工作表名相同（忽略大小写与首尾空格）→ 同一组；
    - ``columns``：所有表归入同一组，合并为一张表（组内按列名忽略大小写对齐）。
    """
    if mode not in MERGE_MODES:
        raise ValueError(f"不支持的合并模式: {mode}")
    if mode == MODE_COLUMNS:
        return [list(tables)] if tables else []
    groups: Dict[Any, List[SourceTable]] = {}
    for table in tables:
        if mode == MODE_STRUCTURE:
            key: Any = table.column_set
        else:
            key = table.sheet_name.strip().casefold()
        groups.setdefault(key, []).append(table)
    return list(groups.values())


def _column_key(name: str) -> str:
    """按列名对齐时的匹配键：忽略大小写与首尾空格。"""
    return name.strip().casefold()


def _cell_key(value: Any) -> str:
    """行去重用的单元格归一化键。"""
    if value is None:
        return ""
    return str(value).strip()


def merge_group(
    group: Sequence[SourceTable],
    add_source: bool = True,
    dedupe: bool = False,
    match_columns_ignore_case: bool = False,
) -> Tuple[List[str], List[List[Any]]]:
    """合并一个分组：列取并集、行按列对齐拼接。

    match_columns_ignore_case=True 时按列名（忽略大小写）对齐：同名列并入
    同一列（输出列名取首次出现的写法），不同名列追加；同名多列取首个非空值。
    add_source=True 时在首部附加「来源文件 / 来源Sheet」两列；
    dedupe=True 时去除数据列完全相同的重复行（来源列不参与比较）。
    """
    columns: List[str] = []
    column_keys: List[str] = []
    seen: Set[str] = set()
    for table in group:
        for col in table.columns:
            key = _column_key(col) if match_columns_ignore_case else col
            if key not in seen:
                seen.add(key)
                column_keys.append(key)
                columns.append(col)

    rows: List[List[Any]] = []
    dedupe_keys: Set[Tuple[str, ...]] = set()
    for table in group:
        index: Dict[str, List[int]] = {}
        for i, col in enumerate(table.columns):
            index.setdefault(_column_key(col) if match_columns_ignore_case else col, []).append(i)
        for raw_row in table.rows:
            aligned: List[Any] = []
            for key in column_keys:
                value: Any = None
                if match_columns_ignore_case:
                    for pos in index.get(key, ()):
                        candidate = raw_row[pos] if pos < len(raw_row) else None
                        if candidate is not None and (
                            not isinstance(candidate, str) or candidate.strip()
                        ):
                            value = candidate
                            break
                elif key in index:
                    pos = index[key][0]
                    value = raw_row[pos] if pos < len(raw_row) else None
                aligned.append(value)
            if dedupe:
                key = tuple(_cell_key(v) for v in aligned)
                if key in dedupe_keys:
                    continue
                dedupe_keys.add(key)
            if add_source:
                aligned = [table.file_name, table.sheet_name] + aligned
            rows.append(aligned)

    if add_source:
        columns = [SOURCE_FILE_COLUMN, SOURCE_SHEET_COLUMN] + columns
    return columns, rows


def sanitize_sheet_name(name: str, used: Set[str]) -> str:
    """工作表名合法化：去非法字符、限长 31、重名加序号。"""
    cleaned = re.sub(INVALID_SHEET_CHARS, "_", (name or "").strip()).strip("'")
    cleaned = cleaned[:MAX_SHEET_NAME_LEN] or "Sheet1"
    candidate = cleaned
    idx = 2
    while candidate.casefold() in used:
        suffix = f"_{idx}"
        candidate = cleaned[: MAX_SHEET_NAME_LEN - len(suffix)] + suffix
        idx += 1
    used.add(candidate.casefold())
    return candidate


def plan_merge(
    tables: Sequence[SourceTable],
    mode: str = MODE_STRUCTURE,
    add_source: bool = True,
    dedupe: bool = False,
) -> List[MergePlan]:
    """生成合并计划（分组 + 输出表名 + 合并结果）。"""
    groups = group_tables(tables, mode=mode)
    used: Set[str] = set()
    plans: List[MergePlan] = []
    for group in groups:
        columns, rows = merge_group(
            group,
            add_source=add_source,
            dedupe=dedupe,
            match_columns_ignore_case=(mode == MODE_COLUMNS),
        )
        sheet_source = MERGED_SHEET_NAME if mode == MODE_COLUMNS else group[0].sheet_name
        output_sheet = sanitize_sheet_name(sheet_source, used)
        sources = [
            {
                "file_name": t.file_name,
                "sheet_name": t.sheet_name,
                "row_count": len(t.rows),
            }
            for t in group
        ]
        plans.append(
            MergePlan(
                output_sheet=output_sheet,
                columns=columns,
                rows=rows,
                sources=sources,
            )
        )
    return plans


# ===== 输出 =====

def build_output_filename() -> str:
    """输出文件名：表格合并-时间戳.xlsx"""
    return f"表格合并-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"


def write_merged_workbook(out_path: Path, plans: Sequence[MergePlan]) -> None:
    """把合并计划写成单个 Excel（每个分组一个工作表）。"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        for plan in plans:
            df = pd.DataFrame(plan.rows, columns=plan.columns)
            df.to_excel(writer, sheet_name=plan.output_sheet, index=False)
